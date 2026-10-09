import { MessageError, msg, type Message } from '../i18n/message';
import { Injectable, inject, signal } from '@angular/core';
import { environment } from '../../environments/environment';
import { AvatarChoice, readAvatarChoice } from '../models/avatar.model';
import { PlayAnswerRecord } from '../utils/play-history.util';
import { AuthService } from './auth.service';
import { FirebaseAppService } from './firebase-app.service';

const FUNCTIONS_EMULATOR_HOST = '127.0.0.1';
const FUNCTIONS_EMULATOR_PORT = 5001;

/**
 * Account deletion spans Stripe, Auth, the leaderboard and the question bank,
 * and touches documents `firestore.rules` deliberately forbids the client from
 * writing — `leaderboard` has no delete rule at all, `custom_questions` is
 * create-only. None of that can be done from here, so this is a thin wrapper
 * around the `deleteAccount` callable, which does the work with the Admin SDK.
 *
 * Deliberately generous: 60s, rather than the 10s the Firestore reads use. The
 * function makes several Stripe round-trips and batched Firestore writes, and
 * a client-side timeout stops neither it nor the request carrying it — the
 * SDK's `timeout` only stops *waiting* (`@firebase/functions` races a timer
 * against a `fetch` it gives no abort signal) — so timing out early would leave
 * the user staring at an error while their account is deleted anyway, which is
 * the worst possible outcome to report.
 */
const DELETE_ACCOUNT_TIMEOUT_MS = 60_000;

/** Read-only and cheaper than deletion, but still several Firestore round-trips. */
const EXPORT_TIMEOUT_MS = 30_000;

/**
 * The stats call is fire-and-forget, so nothing is waiting for it — and the
 * timeout bounds only how long *this* code waits. It does not end the request:
 * the SDK races a timer against a `fetch` it gives no abort signal, so the
 * call runs on until the function answers, and a game "timed out" here may
 * still bank. Short, because this is a background write on a screen the player
 * is already looking at: a game not banked is a lost total, not a broken
 * screen.
 */
const RECORD_GAME_TIMEOUT_MS = 10_000;

/**
 * A player waiting on a button: the same ten seconds the Firestore reads use.
 * The write is one field on one document, so anything slower than this is a
 * cold start or a network problem.
 *
 * **The timeout stops waiting; it does not cancel.** `@firebase/functions`
 * races a timer against a `fetch` it gives no abort signal, so a save that
 * times out runs on and may land after this has given up. That is why
 * `AvatarService.save` reads the stored choice back on `deadline-exceeded`
 * and says "could not be confirmed" rather than "not saved".
 */
const SET_AVATAR_TIMEOUT_MS = 10_000;

type FunctionsModule = typeof import('firebase/functions');

/**
 * What `recordGameResult` answers, read field by field rather than trusted:
 * the server answering may be older or newer than this bundle — a preview
 * channel serves this client against whatever functions `main` last deployed
 * (`docs/ci-cd.md` §4.2a).
 */
interface RecordGameAnswer {
  recorded?: unknown;
  reason?: unknown;
  provider?: unknown;
  xp?: unknown;
  xpGained?: unknown;
}

/**
 * The XP a game banked in this tab came to, and what that game added — the
 * callable's own answer (`FEAT-041`), held for the account it was banked for.
 * `/profile` reads it to say when the last game crossed a level, which nothing
 * on the document can say once it is written.
 */
export interface BankedXp {
  /** The account the game was banked for. */
  uid: string;
  /** `users/{uid}.xp` once the game was banked. */
  xp: number;
  /** What the game added to it. */
  gained: number;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A finished game the server declined to bank for a signed-in account — held
 * for the life of the tab, for the account the call was made as, so
 * `/profile` can say so rather than promising totals that are not coming.
 */
export interface UnbankedGame {
  /** The account the refused call was made as. */
  uid: string;
  /**
   * The server's reason as it gave it: `unsupported-provider`, `invalid`,
   * `rate-limited`, `daily-limit` — the account has banked the most games one
   * UTC day allows, which `/profile` names — or one this build does not know
   * yet.
   */
  reason: string;
}

/**
 * Turns a callable failure into something worth showing a user.
 *
 * `functions/not-found` gets its own message for a specific reason: Cloud
 * Functions are **not** channel-scoped. A Hosting preview channel serves the
 * PR's client code, but the functions in the project are whatever the
 * merge-to-deploy pipeline last shipped — so any PR that adds a new callable
 * shows a broken feature on its own preview until it merges. Telling that user
 * to "please try again" is actively wrong: retrying can never succeed, and
 * nothing about the message hints at the real cause.
 *
 * This is the `CLAUDE.md` §4.4 guardrail — an error message must not narrate a
 * cause it hasn't verified — applied to the one code we *can* verify.
 */
function accountErrorMessage(error: unknown, action: AccountAction): Message {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'functions/not-found') {
    return msg(
      'account.notDeployed',
      "This feature isn't available on this deployment yet. Cloud Functions only go live when a change is merged, so it will work on the live site but not on a preview.",
    );
  }
  if (code === 'functions/unauthenticated') {
    return msg('account.sessionExpired', 'Your session expired. Sign in again and retry.');
  }
  // Raised by the callable's own `timeout` option once it stops waiting — it
  // does not cancel the request, which runs on and may still succeed — so the
  // message deliberately doesn't claim it failed.
  if (code === 'functions/deadline-exceeded') {
    return ACTION_MESSAGES[action].slow;
  }
  return ACTION_MESSAGES[action].failed;
}

/** The three things a callable is asked to do here. */
type AccountAction = 'export' | 'delete' | 'avatar';

/**
 * What each action's failure says — a sentence per action rather than one
 * frame around a verb phrase, because the phrase is the sentence's grammar.
 */
const ACTION_MESSAGES: Record<AccountAction, { slow: Message; failed: Message }> = {
  export: {
    slow: msg(
      'account.slowExport',
      'This is taking longer than expected. Check back in a moment before trying to prepare your data again.',
    ),
    failed: msg('account.exportFailed', 'Could not prepare your data. Please try again.'),
  },
  delete: {
    slow: msg(
      'account.slowDelete',
      'This is taking longer than expected. Check back in a moment before trying to delete your account again.',
    ),
    failed: msg('account.deleteFailed', 'Could not delete your account. Please try again.'),
  },
  avatar: {
    slow: msg(
      'account.slowAvatar',
      'This is taking longer than expected. Check back in a moment before trying to save your avatar again.',
    ),
    failed: msg('account.avatarFailed', 'Could not save your avatar. Please try again.'),
  },
};

/**
 * The XP a banked game's answer carries, read field by field: both whole,
 * non-negative counts and the game's share no larger than the total, or
 * `null`. The server answering may be older than this bundle, or newer.
 */
function bankedXpFrom(uid: string, answer: RecordGameAnswer): BankedXp | null {
  const { xp, xpGained } = answer;
  return isCount(xp) && isCount(xpGained) && xpGained <= xp ? { uid, xp, gained: xpGained } : null;
}

@Injectable({ providedIn: 'root' })
export class AccountService {
  private readonly firebaseAppService = inject(FirebaseAppService);
  private readonly authService = inject(AuthService);

  private functionsPromise: Promise<{
    functions: import('firebase/functions').Functions;
    functionsModule: FunctionsModule;
  }> | null = null;

  private readonly unbankedGameSignal = signal<UnbankedGame | null>(null);
  private readonly bankedXpSignal = signal<BankedXp | null>(null);

  /**
   * The last game a signed-in account finished in this tab that the server
   * declined to bank, or `null` — cleared when that account's next game banks.
   * `/profile` shows it for the account it belongs to and nobody else.
   */
  readonly unbankedGame = this.unbankedGameSignal.asReadonly();

  /**
   * The XP of the last game a signed-in account banked in this tab, or `null`
   * — for none, for a refused game, or for an answer from a server too old to
   * say. Like {@link unbankedGame} it lives as long as the tab, and `/profile`
   * reads it only for the account it belongs to.
   */
  readonly bankedXp = this.bankedXpSignal.asReadonly();

  /**
   * The `firebase/functions` bootstrap, memoized — **and cleared on
   * rejection**, which it was not.
   *
   * `CLAUDE.md` §4.4: never cache a rejected promise. Both halves of this can
   * fail transiently — a dynamic chunk fetch and the runtime-config fetch
   * behind `getApp()` — and without the `.catch` one failed chunk was replayed
   * for the life of the tab, so a single network blip permanently disabled
   * Export and Delete account. That is the third instance of this exact
   * pattern in this repo (`SubscriptionService.getProPrices` has the correct
   * one; `AuthService.getAuth` was the second), which is why §4.4 names it.
   *
   * Nothing downstream is left stuck by the clear: every caller awaits this
   * promise directly and surfaces its own error, so a retry genuinely retries.
   */
  private getFunctions() {
    if (!this.functionsPromise) {
      this.functionsPromise = Promise.all([
        import('firebase/functions'),
        this.firebaseAppService.getApp(),
      ]).then(([functionsModule, app]) => {
        const functions = functionsModule.getFunctions(app);
        if (environment.useEmulators) {
          functionsModule.connectFunctionsEmulator(
            functions,
            FUNCTIONS_EMULATOR_HOST,
            FUNCTIONS_EMULATOR_PORT,
          );
        }
        return { functions, functionsModule };
      });
      this.functionsPromise.catch(() => {
        this.functionsPromise = null;
      });
    }
    return this.functionsPromise;
  }

  /**
   * Fetches everything the app holds about the signed-in user and saves it as
   * a JSON file.
   *
   * The uid is never sent — the callable reads it from the verified token, so
   * a caller can only ever export themselves.
   *
   * The object URL is revoked in a `finally`: it pins the whole payload in
   * memory until released, and this one contains the user's personal data, so
   * leaving it reachable for the lifetime of the tab is exactly the wrong
   * thing to be careless about.
   */
  async downloadMyData(): Promise<void> {
    const { functions, functionsModule } = await this.getFunctions();
    // The SDK's own timeout, which bounds the wait and nothing more: the
    // request is not aborted, so a slow export still completes server-side.
    const callable = functionsModule.httpsCallable<unknown, unknown>(
      functions,
      'exportAccountData',
      { timeout: EXPORT_TIMEOUT_MS },
    );

    let result: { data: unknown };
    try {
      result = await callable();
    } catch (error) {
      throw new MessageError(accountErrorMessage(error, 'export'), { cause: error });
    }

    const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = 'trivimind-my-data.json';
      link.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Permanently deletes the signed-in account.
   *
   * The uid is never sent — the callable reads it from the verified token, so
   * a caller can only ever delete themselves. Passing it would create a
   * parameter that looks authoritative and isn't.
   *
   * On success the server-side Auth user is gone, which invalidates this
   * browser's token; `signOut()` clears the dead session and mints a fresh
   * anonymous one so the app is immediately usable rather than stuck holding
   * credentials for a user that no longer exists.
   */
  async deleteAccount(): Promise<void> {
    const { functions, functionsModule } = await this.getFunctions();
    const callable = functionsModule.httpsCallable(functions, 'deleteAccount', {
      timeout: DELETE_ACCOUNT_TIMEOUT_MS,
    });
    try {
      await callable();
    } catch (error) {
      throw new MessageError(accountErrorMessage(error, 'delete'), { cause: error });
    }
    await this.authService.signOut();
  }

  /**
   * Stores the signed-in player's avatar choice on `users/{uid}` through the
   * `setAvatar` callable (`FEAT-038`), and returns the choice as the server
   * stored it.
   *
   * Lives here for the reason `recordGameResult` below does: this file owns
   * the `firebase/functions` bootstrap, so the callable SDK stays out of the
   * initial bundle and its cached-rejection fix covers this call too.
   *
   * **`seed` is sent only for a built avatar, and omitted otherwise** — the
   * callable SDK encodes a present-but-`undefined` key as `null`, and the
   * server refuses a seed on any other kind. It reads `null` as absent too,
   * so this is the near half of a bound held at both ends.
   *
   * Throws an `Error` whose message is fit to show and whose `cause` is the
   * SDK's error, so a caller can tell `functions/not-found` — the preview
   * channel case, where the callable does not exist yet — from a failure a
   * retry might fix.
   */
  async setAvatar(choice: AvatarChoice): Promise<AvatarChoice> {
    const { functions, functionsModule } = await this.getFunctions();
    const callable = functionsModule.httpsCallable<AvatarChoice, { avatar?: unknown }>(
      functions,
      'setAvatar',
      { timeout: SET_AVATAR_TIMEOUT_MS },
    );
    const payload: AvatarChoice =
      choice.kind === 'built'
        ? { kind: 'built', seed: choice.seed, showPublicly: choice.showPublicly }
        : { kind: choice.kind, showPublicly: choice.showPublicly };
    try {
      const result = await callable(payload);
      return readAvatarChoice(result.data?.avatar);
    } catch (error) {
      throw new MessageError(accountErrorMessage(error, 'avatar'), { cause: error });
    }
  }

  /**
   * Banks one completed game into the caller's lifetime totals at
   * `users/{uid}`.
   *
   * **Fire-and-forget, and never throws.** `/game-over` renders entirely from
   * local state and must not wait on a cold start to show a score the player
   * has already earned — so this resolves whatever happens, and a failure
   * costs one game's worth of totals rather than a broken screen. These are
   * gameplay statistics, not a ledger.
   *
   * **But a refusal is read, not swallowed.** The callable answers with whether
   * it banked the game and, when it did not, why. For a guest that is the
   * design — nothing is kept for anonymous play — and for a reloaded
   * `/game-over` it is a game already banked. Anything else, for a signed-in
   * account, is a game the player believes counted and the server dropped:
   * that is how five of the eight sign-in providers banked nothing, with not a
   * line anywhere saying so. So it is logged with the server's reason, and
   * held in {@link unbankedGame} for `/profile` to tell the player — in words
   * of its own for `daily-limit`, the server's ceiling on games a UTC day,
   * since that one says when games count again.
   *
   * **And a banked game's XP is kept for the tab** (`FEAT-041`): the answer
   * says what the player's XP came to and what this game added, held in
   * {@link bankedXp} so `/profile` can say when the last game crossed a level
   * — which nothing on the document can say once the game is written.
   *
   * The uid is never sent: the callable reads it from the verified token, so a
   * caller can only ever record against themselves. The numbers *are* sent,
   * and are bounded server-side rather than attested — see
   * `functions/src/game-stats.ts` and audit decision A1.
   *
   * Lives here rather than on `FirebaseService` because this is the file that
   * already owns the `firebase/functions` bootstrap, and duplicating that
   * bootstrap would have duplicated the cached-rejection bug fixed above.
   */
  async recordGameResult(result: {
    gameId: string;
    totalQuestions: number;
    correctAnswers: number;
    bestStreak: number;
    /**
     * The round itself (`FEAT-049`) — one record per question, in order.
     * Omitted for a game whose per-answer arrays could not be lined up with its
     * questions, in which case the totals are still banked and no history is
     * written.
     */
    answers?: PlayAnswerRecord[];
  }): Promise<void> {
    try {
      // **Before the call, not after.** The Functions SDK attaches whatever ID
      // token exists at invocation time, and `auth.currentUser` is `null` for
      // a moment after bootstrap even for an already-signed-in user — so a
      // callable fired inside that window arrives unauthenticated and is
      // refused with nothing to show for it. `/game-over` runs this from
      // `ngOnInit`, and reloading `/game-over` is a supported flow, so without
      // this a returning player's game is silently dropped from their totals.
      //
      // It also says who the call is about, read at the moment it is made: the
      // answer can land after a sign-out, and a refusal belongs to the account
      // that played, not to whoever is signed in by then.
      const account = await this.authService.currentAccount();
      const { functions, functionsModule } = await this.getFunctions();
      const callable = functionsModule.httpsCallable<typeof result, RecordGameAnswer | null>(
        functions,
        'recordGameResult',
        { timeout: RECORD_GAME_TIMEOUT_MS },
      );
      const answer = await callable(result);
      this.noteBankingAnswer(account, answer.data);
    } catch {
      // Deliberately silent: this is a failure to *get* an answer — offline, a
      // cold start past the timeout, a server error — not a refusal. There is
      // no user-facing action to offer, the player cannot re-bank a game, and
      // a timed-out call may well have landed (the SDK's timeout cancels
      // nothing), so a toast about a background write would be noise on the
      // screen where they are reading their score, and could be false.
    }
  }

  /**
   * What the callable's answer means for the account that played.
   *
   * **Nothing, for a guest, whatever the reason says.** A guest is refused on
   * every game by design, and which reason that refusal carries depends on
   * which server answered — this one says `anonymous`, an older one said
   * `unsupported-provider`, and a preview channel talks to whichever functions
   * `main` last deployed. Deciding from the account rather than from the reason
   * is what keeps a guest's game from ever reading as a gap.
   */
  private noteBankingAnswer(
    account: { uid: string; isAnonymous: boolean } | null,
    answer: RecordGameAnswer | null,
  ): void {
    if (account === null || account.isAnonymous) {
      return;
    }
    // Banked now, or banked by an earlier call this one repeats — a reload of
    // `/game-over` re-sends the same game id. Either way it counted.
    if (answer?.recorded === true || answer?.reason === 'duplicate') {
      if (this.unbankedGameSignal()?.uid === account.uid) {
        this.unbankedGameSignal.set(null);
      }
      // A duplicate repeats a game already noted, so only a fresh bank moves
      // the XP — and one whose XP this build cannot read leaves nothing to
      // say about the last game rather than something about the one before.
      if (answer?.recorded === true) {
        this.bankedXpSignal.set(bankedXpFrom(account.uid, answer));
      }
      return;
    }
    // An answer this build cannot read says nothing either way, so it is not
    // reported as a refusal.
    if (answer?.recorded !== false) {
      return;
    }
    const reason = typeof answer.reason === 'string' ? answer.reason : 'unknown';
    const provider =
      typeof answer.provider === 'string' ? `, sign-in provider ${answer.provider}` : '';
    console.error(`[stats] the server did not add this game to your totals (${reason}${provider})`);
    this.unbankedGameSignal.set({ uid: account.uid, reason });
    // The last game earned nothing, so no level it crossed is left to report.
    this.bankedXpSignal.set(null);
  }
}
