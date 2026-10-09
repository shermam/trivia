import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AvatarChoice, providerPhotoUrl, readAvatarChoice } from '../models/avatar.model';
import { AccountService } from './account.service';
import { AuthService } from './auth.service';
import { FirestoreRestClient } from './firestore-rest/firestore-rest.client';

const USERS_COLLECTION = 'users';
const AVATAR_READ_TIMEOUT_MS = 10_000;

/** Where an account's stored choice stands, as the chip and the picker need to know it. */
export type AvatarStatus = 'none' | 'loading' | 'ready' | 'failed';

/** How a save ended, in the three ways the picker says differently. */
export type AvatarSaveOutcome = 'saved' | 'unavailable' | 'failed';

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
   * The stored choice for the account signed in now, or `null` while it is
   * not known — not read yet, failed, or nobody signed in. Every surface draws
   * initials for `null`, which is the least alarming answer while the real one
   * is on its way (`CLAUDE.md` §4.4).
   */
  readonly choice = computed(() => {
    const answer = this.answer();
    return answer !== null && answer.uid === this.accountUid() ? answer.choice : null;
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
        // Signing out forgets the previous account's choice, so the next
        // account to sign in on this tab never sees it.
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
   * Never throws: the picker has three things to say and this decides which.
   * `unavailable` is the preview-channel case (`functions/not-found`) — Cloud
   * Functions are not channel-scoped, so a retry there can never succeed and
   * telling the reader to try again would be a cause nobody verified
   * (`CLAUDE.md` §4.4).
   */
  async save(choice: AvatarChoice): Promise<AvatarSaveOutcome> {
    const uid = this.accountUid();
    if (uid === null) {
      return 'failed';
    }
    try {
      const stored = await this.accounts.setAvatar(choice);
      if (this.accountUid() === uid) {
        this.answer.set({ uid, choice: stored });
      }
      return 'saved';
    } catch (error) {
      console.error('[avatar] could not save the avatar choice', error);
      const cause = (error as { cause?: unknown } | null)?.cause;
      const code = (cause as { code?: unknown } | null | undefined)?.code;
      return code === 'functions/not-found' ? 'unavailable' : 'failed';
    }
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
      // A refused or failed read is not "initials": the chip shows initials
      // anyway, but the picker must not present the default as the stored
      // choice and invite the player to "change" it from something it is not.
      console.error('[avatar] could not read the stored avatar choice', error);
    }
    // The account may have changed while the read was in flight; an answer
    // for the previous one must not land on the next.
    if (this.accountUid() !== uid) {
      return;
    }
    this.answer.set({ uid, choice });
  }
}
