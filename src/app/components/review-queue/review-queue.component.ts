import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { CustomQuestionDoc, QuestionStatus } from '../../models/question.model';
import { FirebaseService, REVIEW_PAGE_SIZE } from '../../services/firebase.service';
import { ReviewerService } from '../../services/reviewer.service';
import { IconComponent } from '../icon/icon.component';
import { SourceLinkComponent } from '../source-link/source-link.component';

type ReviewQuestion = CustomQuestionDoc & { id: string };

/** The three statuses, in the order the picker offers them. */
export const REVIEW_TABS: readonly { status: QuestionStatus; label: string }[] = [
  { status: 'pending', label: 'Pending' },
  { status: 'approved', label: 'Approved' },
  { status: 'rejected', label: 'Rejected' },
];

/**
 * The moderation queue (`BACKLOG.md` item 4b-ii).
 *
 * **The Pending tab is empty until item 4c**, which is when submissions start
 * arriving there instead of going straight into the bank. That does not make
 * this page inert in the meantime, and the reason is worth stating: rejecting
 * an *approved* question takes it out of what players are served, so this is
 * the first in-app way to act on an abuse report at all. Until now the only
 * route was a manual console deletion.
 *
 * Reviewer-gated in the UI only. `ReviewerService` decides whether to render
 * the page; `firestore.rules` decides whether any of its buttons do anything.
 * A non-reviewer who navigates here directly gets the "not a reviewer" state,
 * and would be refused by the server even if they did not.
 */
@Component({
  selector: 'app-review-queue',
  standalone: true,
  imports: [RouterLink, IconComponent, SourceLinkComponent],
  templateUrl: './review-queue.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewQueueComponent implements OnInit {
  private readonly firebaseService = inject(FirebaseService);
  protected readonly reviewerService = inject(ReviewerService);

  protected readonly tabs = REVIEW_TABS;
  protected readonly pageSize = REVIEW_PAGE_SIZE;

  protected readonly activeStatus = signal<QuestionStatus>('pending');
  protected readonly questions = signal<ReviewQuestion[]>([]);
  protected readonly isLoading = signal(false);
  protected readonly loadError = signal<string | null>(null);

  /**
   * The question currently being acted on, so its two buttons can disable
   * without freezing the whole list. Holding the id rather than a boolean is
   * what makes that per-row instead of per-page.
   */
  protected readonly pendingActionId = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);

  /**
   * Announced, not just rendered. The list mutates under the reviewer as a
   * decision removes a row, and a screen reader user would otherwise be told
   * nothing at all about what just happened (`CLAUDE.md` §4.5).
   */
  protected readonly actionResult = signal<string | null>(null);

  protected readonly isFull = computed(() => this.questions().length >= this.pageSize);

  ngOnInit(): void {
    void this.load();
  }

  protected async select(status: QuestionStatus): Promise<void> {
    if (status === this.activeStatus()) {
      return;
    }
    this.activeStatus.set(status);
    this.actionResult.set(null);
    this.actionError.set(null);
    await this.load();
  }

  protected async load(): Promise<void> {
    const status = this.activeStatus();
    this.isLoading.set(true);
    this.loadError.set(null);
    try {
      const questions = await firstValueFrom(this.firebaseService.getQuestionsByStatus(status));
      // The tab may have changed while this was in flight; the late answer for
      // the previous tab must not overwrite the current one.
      if (this.activeStatus() === status) {
        this.questions.set(questions);
      }
    } catch {
      // Deliberately generic. A failure here is a refused read, a timeout or a
      // network fault and the client cannot tell which — narrating a cause it
      // did not verify is exactly what `CLAUDE.md` §4.4 forbids.
      this.loadError.set('Could not load the queue. Please try again.');
    } finally {
      if (this.activeStatus() === status) {
        this.isLoading.set(false);
      }
    }
  }

  protected async decide(question: ReviewQuestion, status: QuestionStatus): Promise<void> {
    this.pendingActionId.set(question.id);
    this.actionError.set(null);
    this.actionResult.set(null);
    try {
      await this.firebaseService.setQuestionStatus(question.id, status);
      // Drop the row locally rather than refetching: the reviewer's next
      // decision should not wait on a round trip, and the row no longer
      // belongs in the tab they are looking at.
      this.questions.update((all) => all.filter((q) => q.id !== question.id));
      this.actionResult.set(`Question marked ${status}.`);
    } catch {
      this.actionError.set('Could not save that decision. Please try again.');
    } finally {
      this.pendingActionId.set(null);
    }
  }

  protected answersFor(question: ReviewQuestion): string[] {
    return [question.correct_answer, ...question.incorrect_answers];
  }

  protected submittedAt(question: ReviewQuestion): string {
    return question.createdAt ? new Date(question.createdAt).toLocaleString() : 'Unknown';
  }
}
