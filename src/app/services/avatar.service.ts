import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AvatarChoice, providerPhotoUrl, readAvatarChoice } from '../models/avatar.model';
import { AccountService } from './account.service';
import { AuthService } from './auth.service';
import { FirestoreRestClient } from './firestore-rest/firestore-rest.client';

const USERS_COLLECTION = 'users';
const AVATAR_READ_TIMEOUT_MS = 10_000;

/**
 * Where this device keeps a copy of the last choice it read, with whose it
 * was. One entry, not one per account: the next account to sign in here
 * replaces it, and signing out removes it.
 */
const CACHE_KEY = 'trivia-avatar';

/** Where an account's stored choice stands, as the chip and the picker need to know it. */
export type AvatarStatus = 'none' | 'loading' | 'ready' | 'failed';

/**
 * How a save ended, in the four ways the picker says differently.
 * `unconfirmed` is a save whose answer never came: it may have landed, or may
 * yet — see {@link AvatarService.save}.
 */
export type AvatarSaveOutcome = 'saved' | 'unavailable' | 'failed' | 'unconfirmed';

interface CachedChoice {
  uid: string;
  choice: AvatarChoice;
}

/**
 * The copy on this device, read leniently — it sits somewhere the reader can
 * edit, so it goes through the same reader as the server's document and an
 * entry with no uid is no entry at all.
 *
 * The accessor is inside the `try`: Safari's private mode and blocked site
 * data throw on `window.localStorage` itself, as `PricingCacheService` notes.
 */
function readCachedChoice(): CachedChoice | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { uid?: unknown; choice?: unknown } | null;
    return typeof parsed?.uid === 'string' && parsed.uid.length > 0
      ? { uid: parsed.uid, choice: readAvatarChoice(parsed.choice) }
      : null;
  } catch {
    return null;
  }
}

function writeCachedChoice(entry: CachedChoice | null): void {
  try {
    if (entry === null) {
      window.localStorage.removeItem(CACHE_KEY);
      return;
    }
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Unavailable storage or a quota refusal. The copy is a convenience: the
    // chip draws initials until the server answers, as it would without one.
  }
}

/** Whether two choices say the same thing, field by field. */
function sameChoice(a: AvatarChoice, b: AvatarChoice): boolean {
  return a.kind === b.kind && a.seed === b.seed && a.showPublicly === b.showPublicly;
}

/**
 * The signed-in player's avatar choice (`FEAT-038`): read once, shared by
 * every surface that draws it, and saved through the `setAvatar` callable.
 *
 * **Off the critical path by construction.** The chip renders initials on its
 * first paint and this answers later: the read waits for auth, which is itself
 * deferred to the first idle moment after paint (`docs/app.md` §1.5), and it
 * happens only for a signed-in, non-anonymous account. A guest is answered
 * without a request — there is no `users/{uid}` for an anonymous session and
 * never will be.
 *
 * **Once per account per session, and no listener.** The choice changes only
 * when this player saves one, and the save hands back what was stored, so
 * there is nothing a subscription would hear that this does not already know.
 *
 * **A copy on the device, drawn until the server answers.** The last choice
 * read is kept in `localStorage` with its uid, so a built avatar is drawn from
 * the bundled generator offline and on every load before the read lands,
 * rather than initials until a round trip that may never come. It is UX and
 * never authority: it is shown only for the account it names, the server's
 * answer replaces it the moment one arrives, the picker will not open on it,
 * and signing out removes it.
 *
 * Read through `documents:batchGet` rather than a `GET`, for the reason
 * `ReviewerService` gives: most accounts have no `users/{uid}` yet, and a `GET`
 * answers that with a `404` that Chromium logs to the console as an error on
 * every page load. The rule is the same `get` either way.
 */
@Injectable({ providedIn: 'root' })
export class AvatarService {
  private readonly auth = inject(AuthService);
  private readonly rest = inject(FirestoreRestClient);
  private readonly accounts = inject(AccountService);

  /** The last answer and whose it was; `choice: null` is a read that failed. */
  private readonly answer = signal<{ uid: string; choice: AvatarChoice | null } | null>(null);

  /** This device's copy of the last choice read, read once at start. */
  private readonly cached = signal<CachedChoice | null>(readCachedChoice());

  /**
   * The uid a read was last started for. A plain field so the effect below
   * does not depend on it — the pattern `ProfileStatsComponent` uses.
   */
  private startedForUid: string | null = null;

  /**
   * The account a choice can belong to, or `null` for nobody — anonymous
   * included. A string, so the effect below re-runs on a change of account
   * rather than on every emission of `user()` (which notifies on every set).
   */
  private readonly accountUid = computed(() => {
    const user = this.auth.user();
    return user !== null && !user.isAnonymous ? user.uid : null;
  });

  /**
   * The server's answer, not the device's copy: `loading` until it arrives,
   * whatever the chip is drawing meanwhile. The picker opens on `ready` only,
   * so it never offers to change a choice from one the server may not hold.
   */
  readonly status = computed<AvatarStatus>(() => {
    const uid = this.accountUid();
    if (uid === null) {
      return 'none';
    }
    const answer = this.answer();
    if (answer === null || answer.uid !== uid) {
      return 'loading';
    }
    return answer.choice === null ? 'failed' : 'ready';
  });

  /**
   * The choice to draw for the account signed in now: the server's, once it
   * has answered; until then — or when it could not — this device's copy, if
   * it is this account's; otherwise `null`, and every surface draws initials,
   * the least alarming answer while the real one is on its way
   * (`CLAUDE.md` §4.4).
   */
  readonly choice = computed(() => {
    const uid = this.accountUid();
    if (uid === null) {
      return null;
    }
    const answer = this.answer();
    if (answer !== null && answer.uid === uid && answer.choice !== null) {
      return answer.choice;
    }
    const cached = this.cached();
    return cached !== null && cached.uid === uid ? cached.choice : null;
  });

  /**
   * The provider photo this account can show, or `null`. Read from the
   * Firebase user at render time and **never stored** — the stored choice
   * says only `photo`. Narrowed to the one host the CSP admits.
   */
  readonly photoUrl = computed(() => providerPhotoUrl(this.auth.user()?.photoURL));

  constructor() {
    effect(() => {
      const uid = this.accountUid();
      if (uid === null) {
        // A real account going away is a sign-out (or a deletion): its
        // choice is forgotten here and on the device, so the next person at
        // this browser is never drawn as the last one. Nobody yet — the
        // frames before auth has restored a session — forgets nothing.
        if (this.startedForUid !== null) {
          this.cached.set(null);
          writeCachedChoice(null);
        }
        this.startedForUid = null;
        this.answer.set(null);
        return;
      }
      if (uid === this.startedForUid) {
        return;
      }
      this.startedForUid = uid;
      void this.read(uid);
    });
  }

  /** Reads the choice again after a failure. The picker's "Try again". */
  retry(): void {
    const uid = this.accountUid();
    if (uid === null) {
      return;
    }
    this.answer.set(null);
    void this.read(uid);
  }

  /**
   * Stores a choice through the callable and, once it is stored, shows it
   * everywhere at once — the chip, the header, the picker — without a re-read,
   * because the callable answers with what it kept.
   *
   * Never throws: the picker has four things to say and this decides which.
   *
   * - `unavailable` is the preview-channel case (`functions/not-found`) — Cloud
   *   Functions are not channel-scoped, so a retry there can never succeed and
   *   telling the reader to try again would be a cause nobody verified
   *   (`CLAUDE.md` §4.4).
   * - **`unconfirmed` is a timeout, and a timeout is not a failure.** The
   *   callable SDK's `timeout` stops *waiting*; it does not cancel —
   *   `@firebase/functions` races a timer against a `fetch` it gives no abort
   *   signal, so the request runs to completion and the write may have landed
   *   or may still. So the stored choice is read back before anything is said:
   *   if it is the one just sent, the save is reported as made; if not, it is
   *   reported as unconfirmed, never as "not saved".
   */
  async save(choice: AvatarChoice): Promise<AvatarSaveOutcome> {
    const uid = this.accountUid();
    if (uid === null) {
      return 'failed';
    }
    try {
      const stored = await this.accounts.setAvatar(choice);
      this.settle(uid, stored);
      return 'saved';
    } catch (error) {
      const cause = (error as { cause?: unknown } | null)?.cause;
      const code = (cause as { code?: unknown } | null | undefined)?.code;
      if (code === 'functions/not-found') {
        return 'unavailable';
      }
      if (code === 'functions/deadline-exceeded') {
        return (await this.confirm(uid, choice)) ? 'saved' : 'unconfirmed';
      }
      console.error('[avatar] could not save the avatar choice', error);
      return 'failed';
    }
  }

  /**
   * Whether the server now holds `attempted`, after a save whose answer never
   * came. Shows it everywhere if so; leaves what is shown alone if not, so the
   * picker keeps the reader's choice for another try.
   */
  private async confirm(uid: string, attempted: AvatarChoice): Promise<boolean> {
    try {
      const document = await this.rest.batchGetDocument(`${USERS_COLLECTION}/${uid}`, {
        timeoutMs: AVATAR_READ_TIMEOUT_MS,
      });
      const stored = readAvatarChoice(document?.data['avatar']);
      if (!sameChoice(stored, attempted)) {
        return false;
      }
      this.settle(uid, stored);
      return true;
    } catch (error) {
      console.error('[avatar] could not confirm a save that timed out', error);
      return false;
    }
  }

  /**
   * The server's answer for `uid`, kept as the answer and as this device's
   * copy — if that account is still the one signed in. An answer that lands
   * after the account changed is dropped, so it can never be drawn as the
   * next one's.
   */
  private settle(uid: string, choice: AvatarChoice): void {
    if (this.accountUid() !== uid) {
      return;
    }
    this.answer.set({ uid, choice });
    this.cached.set({ uid, choice });
    writeCachedChoice({ uid, choice });
  }

  private async read(uid: string): Promise<void> {
    let choice: AvatarChoice | null = null;
    try {
      const document = await this.rest.batchGetDocument(`${USERS_COLLECTION}/${uid}`, {
        timeoutMs: AVATAR_READ_TIMEOUT_MS,
      });
      // No document is the ordinary answer — an account that has neither
      // finished a game nor chosen an avatar — and it means the default.
      choice = readAvatarChoice(document?.data['avatar']);
    } catch (error) {
      // A refused or failed read is not "initials": the chip draws the
      // device's copy, or initials, either way — but the picker must not
      // present a default or a copy as the stored choice and invite the
      // player to "change" it from something it is not.
      console.error('[avatar] could not read the stored avatar choice', error);
    }
    if (choice === null) {
      // The account may have changed while the read was in flight; an answer
      // for the previous one must not land on the next.
      if (this.accountUid() === uid) {
        this.answer.set({ uid, choice: null });
      }
      return;
    }
    this.settle(uid, choice);
  }
}
