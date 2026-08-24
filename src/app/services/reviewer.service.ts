import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { FirestoreRestClient } from './firestore-rest/firestore-rest.client';

const USER_ROLES_COLLECTION = 'user_roles';
const ROLE_READ_TIMEOUT_MS = 10_000;

/**
 * Whether the signed-in account holds the moderation role.
 *
 * **This is UX, never authority** (`CLAUDE.md` §4.2). Nothing here gates a
 * privileged operation; it decides whether to render a link and a page. The
 * thing that actually stops a non-reviewer changing a question's status is the
 * `isReviewer()` check in `firestore.rules`, which reads the same document
 * server-side on every write.
 *
 * What keeps it out of H6's trap — a client signal drifting *broader* than the
 * server's gate, so the UI unlocks a form the server is bound to refuse — is
 * that it is not a mirror of the server predicate at all. It reads **the same
 * document and the same field** the rule reads. There is no second expression
 * to keep in step, which is a stronger guarantee than remembering to.
 *
 * A document rather than a custom claim, so revoking the role takes effect on
 * the next request rather than whenever the user's existing ID token expires
 * — reasoning in `docs/data-model.md` § `user_roles`.
 */
@Injectable({ providedIn: 'root' })
export class ReviewerService {
  private readonly auth = inject(AuthService);
  private readonly rest = inject(FirestoreRestClient);

  private readonly isReviewerSignal = signal(false);
  private readonly checkedUidSignal = signal<string | null>(null);

  /** True only once the register has actually been read and said so. */
  readonly isReviewer = this.isReviewerSignal.asReadonly();

  /**
   * Whether the answer for the current user is known yet. Distinguishes "not a
   * reviewer" from "we have not looked", so the nav can stay quiet rather than
   * flashing a link off on every page load.
   */
  readonly isResolved = computed(() => this.checkedUidSignal() === (this.auth.user()?.uid ?? null));

  constructor() {
    // Re-reads whenever the account changes, including sign-out — which must
    // clear the flag rather than leave the previous user's answer behind. That
    // matters most for the case this whole design exists for: a revoked
    // reviewer, whose next read of their own document returns nothing.
    effect(() => {
      const uid = this.auth.user()?.uid ?? null;
      if (!uid) {
        this.isReviewerSignal.set(false);
        this.checkedUidSignal.set(null);
        return;
      }
      void this.refresh(uid);
    });
  }

  private async refresh(uid: string): Promise<void> {
    let isReviewer = false;
    try {
      const document = await this.rest.getDocument(`${USER_ROLES_COLLECTION}/${uid}`, {
        timeoutMs: ROLE_READ_TIMEOUT_MS,
      });
      isReviewer = document?.data?.['reviewer'] === true;
    } catch (error) {
      // Absence is not an error here — `getDocument` already returns `null` for
      // a document that does not exist, which is the answer for almost every
      // account. Reaching this branch means the read genuinely failed, so it is
      // reported and treated as "not a reviewer". That is the safe direction:
      // the worst case is a reviewer who has to reload, never a non-reviewer
      // shown a page the server would refuse them anyway.
      console.error('[reviewer] could not read the role register', error);
    }

    // The account may have changed while the read was in flight. Writing a
    // stale answer would be exactly the bug the uid check exists to prevent:
    // signing out of a reviewer account and into another must not leave the
    // link showing.
    if ((this.auth.user()?.uid ?? null) !== uid) {
      return;
    }
    this.isReviewerSignal.set(isReviewer);
    this.checkedUidSignal.set(uid);
  }
}
