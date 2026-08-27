import { Injectable, inject } from '@angular/core';
import { environment } from '../../environments/environment';
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
 * a client-side timeout does not cancel it — so timing out early would leave
 * the user staring at an error while their account is deleted anyway, which is
 * the worst possible outcome to report.
 */
const DELETE_ACCOUNT_TIMEOUT_MS = 60_000;

/** Read-only and cheaper than deletion, but still several Firestore round-trips. */
const EXPORT_TIMEOUT_MS = 30_000;

/**
 * The stats call is fire-and-forget, so nothing is waiting for it — which
 * makes a timeout *more* necessary rather than less. Without one an abandoned
 * request holds a connection open indefinitely for a result nobody will read.
 * Short, because this is a background write on a screen the player is already
 * looking at: a game not banked is a lost total, not a broken screen.
 */
const RECORD_GAME_TIMEOUT_MS = 10_000;

type FunctionsModule = typeof import('firebase/functions');

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
function accountErrorMessage(error: unknown, action: string): string {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'functions/not-found') {
    return `This feature isn't available on this deployment yet. Cloud Functions only go live when a change is merged, so it will work on the live site but not on a preview.`;
  }
  if (code === 'functions/unauthenticated') {
    return 'Your session expired. Sign in again and retry.';
  }
  // Raised by the callable's own `timeout` option once it gives up and cancels
  // the request. The work may still have completed server-side, so the message
  // deliberately doesn't claim it failed.
  if (code === 'functions/deadline-exceeded') {
    return `This is taking longer than expected. Check back in a moment before trying to ${action} again.`;
  }
  return `Could not ${action}. Please try again.`;
}

@Injectable({ providedIn: 'root' })
export class AccountService {
  private readonly firebaseAppService = inject(FirebaseAppService);
  private readonly authService = inject(AuthService);

  private functionsPromise: Promise<{
    functions: import('firebase/functions').Functions;
    functionsModule: FunctionsModule;
  }> | null = null;

  /**
   * The `firebase/functions` bootstrap, memoized — **and cleared on
   * rejection**, which it was not.
   *
   * `CLAUDE.md` §4.4: never cache a rejected promise. Both halves of this can
   * fail transiently — a dynamic chunk fetch and the runtime-config fetch
   * behind `getApp()` — and without the `.catch` one failed chunk was replayed
   * for the life of the tab, so a single network blip permanently disabled
   * Export and Delete account. That is the third instance of this exact
   * pattern in this repo (`SubscriptionService.getProPriceId` has the correct
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
    // The SDK's own timeout, which cancels the request rather than merely
    // abandoning it — see HttpsCallableOptions.timeout.
    const callable = functionsModule.httpsCallable<unknown, unknown>(
      functions,
      'exportAccountData',
      { timeout: EXPORT_TIMEOUT_MS },
    );

    let result: { data: unknown };
    try {
      result = await callable();
    } catch (error) {
      throw new Error(accountErrorMessage(error, 'prepare your data'), { cause: error });
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
      throw new Error(accountErrorMessage(error, 'delete your account'), { cause: error });
    }
    await this.authService.signOut();
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
  }): Promise<void> {
    try {
      // **Before the call, not after.** The Functions SDK attaches whatever ID
      // token exists at invocation time, and `auth.currentUser` is `null` for
      // a moment after bootstrap even for an already-signed-in user — so a
      // callable fired inside that window arrives unauthenticated and is
      // refused with nothing to show for it. `/game-over` runs this from
      // `ngOnInit`, and reloading `/game-over` is a supported flow, so without
      // this a returning player's game is silently dropped from their totals.
      await this.authService.whenAuthStateReady();
      const { functions, functionsModule } = await this.getFunctions();
      const callable = functionsModule.httpsCallable(functions, 'recordGameResult', {
        timeout: RECORD_GAME_TIMEOUT_MS,
      });
      await callable(result);
    } catch {
      // Deliberately silent. There is no user-facing action to offer — the
      // player cannot re-bank a game — and a toast about a background write
      // would be noise on the screen where they are reading their score.
    }
  }
}
