import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  CustomQuestionDoc,
  QuestionReport,
  QuestionReportReason,
  QuestionStatus,
} from '../../models/question.model';
import {
  FirebaseService,
  MAX_REJECTION_REASON_LENGTH,
  REVIEW_PAGE_SIZE,
} from '../../services/firebase.service';
import { ReportCursor, ReviewerService } from '../../services/reviewer.service';
import { IconComponent } from '../icon/icon.component';
import { QuestionJustificationComponent } from '../question-justification/question-justification.component';
import { SourceLinkComponent } from '../source-link/source-link.component';

type ReviewQuestion = CustomQuestionDoc & { id: string };

/** What the queue shows: one of the three moderation statuses, or the reports. */
export type ReviewView = QuestionStatus | 'reports';

/** One filed report, with the question it is about — or `null` if it is gone. */
export interface ReportRow {
  report: QuestionReport;
  question: ReviewQuestion | null;
}

/** The views, in the order the picker offers them. */
export const REVIEW_TABS: readonly { view: ReviewView; label: string }[] = [
  { view: 'pending', label: 'Pending' },
  { view: 'approved', label: 'Approved' },
  { view: 'rejected', label: 'Rejected' },
  { view: 'reports', label: 'Reports' },
];

/** What a reader chose, in words a reviewer reads rather than a stored enum. */
const REASON_LABELS: Record<QuestionReportReason, string> = {
  incorrect: 'The answer is wrong',
  inappropriate: 'Inappropriate or offensive',
  spam: 'Spam or nonsense',
  other: 'Something else',
};

/**
 * The moderation queue (`BACKLOG.md` item 4b-ii), and the reports players file
 * against community questions (`FEAT-026`).
 *
 * **The two halves are one screen on purpose.** A report is only worth reading
 * next to the question it is about, and acting on one is the ordinary `status`
 * write the other three tabs already make — so a reporter's complaint and the
 * decision it asks for are one click apart rather than a console away.
 *
 * Reviewer-gated in the UI only. `ReviewerService` decides whether to render
 * the page; `firestore.rules` decides whether any of its buttons do anything,
 * and whether the reports read returns anything at all. A non-reviewer who
 * navigates here directly gets the "not a reviewer" state, and would be refused
 * by the server even if they did not.
 */
@Component({
  selector: 'app-review-queue',
  standalone: true,
  imports: [
    NgTemplateOutlet,
    RouterLink,
    IconComponent,
    SourceLinkComponent,
    QuestionJustificationComponent,
  ],
  templateUrl: './review-queue.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewQueueComponent implements OnInit {
  private readonly firebaseService = inject(FirebaseService);
  protected readonly reviewerService = inject(ReviewerService);

  protected readonly tabs = REVIEW_TABS;
  protected readonly pageSize = REVIEW_PAGE_SIZE;

  protected readonly activeView = signal<ReviewView>('pending');
  protected readonly questions = signal<ReviewQuestion[]>([]);
  protected readonly isLoading = signal(false);
  protected readonly loadError = signal<string | null>(null);

  /**
   * The rows on screen, and where the next page starts.
   *
   * **This tab pages on a cursor rather than by growing a limit**, and the
   * reason is cost: a growing limit re-reads every page already on screen on
   * every click (25, then 50, then 75…), and Firestore bills per document read.
   * `showMoreReports` asks for the page *after* the last row instead and
   * appends it, so each click costs one page. The cursor is `ReviewerService`'s
   * to shape — the component only holds it and hands it back.
   */
  protected readonly reports = signal<ReportRow[]>([]);
  protected readonly reportsCursor = signal<ReportCursor | null>(null);
  protected readonly hasMoreReports = computed(() => this.reportsCursor() !== null);

  /**
   * Which of the reports tab's four messages is showing.
   *
   * **A failed read outranks an empty one.** "No reports have been filed" is a
   * claim about the collection, and a read that was refused or timed out is not
   * evidence for it — telling a reviewer their queue is clear when it is merely
   * unreadable is the false narration `CLAUDE.md` §4.4 forbids, and the one
   * this screen could most easily produce.
   */
  protected readonly reportsView = computed<'loading' | 'failed' | 'empty' | 'loaded'>(() => {
    if (this.isLoading()) {
      return 'loading';
    }
    if (this.loadError()) {
      return 'failed';
    }
    return this.reports().length === 0 ? 'empty' : 'loaded';
  });

  /** The block of stacked messages, focused when a retry starts — see `retryReports()`. */
  private readonly reportsStatus = viewChild<ElementRef<HTMLElement>>('reportsStatus');

  /**
   * The question currently being acted on, so its two buttons can disable
   * without freezing the whole list. Holding the id rather than a boolean is
   * what makes that per-row instead of per-page — and on the reports tab it
   * also covers the case the question tabs cannot produce: several reports
   * about one question, whose buttons are all the same write.
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

  /**
   * What the reviewer has typed into each row's reason box, keyed by question
   * id (`FEAT-007`).
   *
   * Keyed rather than a single value because the card is rendered once per row
   * from one `ng-template`, and a reviewer who starts typing about one question
   * and then decides on another must not send the first one's words with the
   * second one's rejection. Cleared for a question once its decision lands, so
   * reopening the tab does not restore words already sent.
   */
  private readonly reasonDrafts = signal<Readonly<Record<string, string>>>({});

  /**
   * The box starts as whatever reason the question already carries, so
   * rejecting a second time — to correct a status, say — does not silently wipe
   * a note the author has already been shown. Once the reviewer types, the
   * draft exists even when it is empty, which is what lets them clear it
   * deliberately.
   */
  protected reasonFor(question: ReviewQuestion): string {
    return this.reasonDrafts()[question.id] ?? question.rejectionReason ?? '';
  }

  protected setReason(questionId: string, value: string): void {
    this.reasonDrafts.update((drafts) => ({ ...drafts, [questionId]: value }));
  }

  /**
   * Whether the reason typed for a question is longer than `firestore.rules`
   * accepts. Checked here so an over-long note is a named error rather than a
   * bare `permission-denied` on the Reject click — the same reasoning as the
   * contribution form's bounds, and the number has to agree with
   * `maxRejectionReasonLength()` in the rules.
   */
  protected readonly maxReasonLength = MAX_REJECTION_REASON_LENGTH;

  protected isReasonTooLong(question: ReviewQuestion): boolean {
    return this.reasonFor(question).trim().length > MAX_REJECTION_REASON_LENGTH;
  }

  ngOnInit(): void {
    void this.load();
  }

  protected async select(view: ReviewView): Promise<void> {
    if (view === this.activeView()) {
      return;
    }
    this.activeView.set(view);
    this.actionResult.set(null);
    this.actionError.set(null);
    await this.load();
  }

  protected async load(): Promise<void> {
    const view = this.activeView();
    this.isLoading.set(true);
    this.loadError.set(null);
    try {
      if (view === 'reports') {
        const page = await this.loadReports();
        // The tab may have changed while this was in flight; the late answer
        // for the previous tab must not overwrite the current one.
        if (this.activeView() === view) {
          this.reports.set(page.rows);
          this.reportsCursor.set(page.next);
        }
      } else {
        const questions = await firstValueFrom(this.firebaseService.getQuestionsByStatus(view));
        if (this.activeView() === view) {
          this.questions.set(questions);
        }
      }
    } catch {
      // Deliberately generic. A failure here is a refused read, a timeout or a
      // network fault and the client cannot tell which — narrating a cause it
      // did not verify is exactly what `CLAUDE.md` §4.4 forbids. What it must
      // never do is fall through to the empty state: "no reports have been
      // filed" is a claim, and a read that failed is not evidence for it.
      //
      // Guarded by the same check as the success path, and for a sharper
      // reason: an error message is about a tab, so a reports read failing
      // after the reviewer moved on would put "Could not load the reports" over
      // a perfectly good list of pending questions.
      if (this.activeView() === view) {
        this.loadError.set(
          view === 'reports'
            ? 'Could not load the reports. Please try again.'
            : 'Could not load the queue. Please try again.',
        );
      }
    } finally {
      if (this.activeView() === view) {
        this.isLoading.set(false);
      }
    }
  }

  /**
   * Appends the page after the last row on screen.
   *
   * Nothing already read is read again. Like `load()` it drops its answer if
   * the reviewer has left the tab, and it checks that the cursor it started
   * from is still the one on screen — two clicks in flight at once, or a
   * reload landing in between, would otherwise append the same page twice.
   */
  protected async showMoreReports(): Promise<void> {
    const cursor = this.reportsCursor();
    if (cursor === null || this.isLoading()) {
      return;
    }

    this.isLoading.set(true);
    this.loadError.set(null);
    try {
      const page = await this.loadReports(cursor);
      if (this.activeView() === 'reports' && this.reportsCursor() === cursor) {
        this.reports.update((rows) => [...rows, ...page.rows]);
        this.reportsCursor.set(page.next);
      }
    } catch {
      if (this.activeView() === 'reports') {
        this.loadError.set('Could not load more reports. Please try again.');
      }
    } finally {
      if (this.activeView() === 'reports') {
        this.isLoading.set(false);
      }
    }
  }

  /**
   * Re-runs a reports read that failed.
   *
   * **It moves focus before starting the read**, because starting the read is
   * what takes the focused element away: the block goes back to its loading
   * face, "Try again" turns `visibility: hidden`, and focus on a hidden element
   * silently drops to `<body>` (`CLAUDE.md` §4.4), sending a keyboard user back
   * to the top of the page to reach a second "Try again". The block itself is
   * the target: it is present in every state and carries the sentence that
   * answers the retry.
   */
  protected retryReports(): void {
    this.reportsStatus()?.nativeElement.focus();
    void this.load();
  }

  /**
   * The reports, each paired with the question it names.
   *
   * Two bounded reads, not one per report: the page of reports, then one
   * batched lookup of the distinct questions it mentions
   * (`FirebaseService.getQuestionsByIds`). A question the lookup does not
   * return is one that has been deleted from the bank since the report was
   * filed — or one whose stored `questionId` cannot address a document at all —
   * and the row says so rather than disappearing or taking the page with it.
   */
  private async loadReports(
    after?: ReportCursor,
  ): Promise<{ rows: ReportRow[]; next: ReportCursor | null }> {
    const page = await this.reviewerService.getQuestionReports(after);
    const questions = await firstValueFrom(
      this.firebaseService.getQuestionsByIds(page.reports.map((report) => report.questionId)),
    );
    const byId = new Map(questions.map((question) => [question.id, question]));

    return {
      rows: page.reports.map((report) => ({
        report,
        question: byId.get(report.questionId) ?? null,
      })),
      next: page.next,
    };
  }

  protected async decide(question: ReviewQuestion, status: QuestionStatus): Promise<void> {
    // Refused before the round trip so the reviewer gets a named error rather
    // than the bare `permission-denied` the rules would answer with.
    if (status === 'rejected' && this.isReasonTooLong(question)) {
      this.actionError.set(
        `A rejection reason has to be ${MAX_REJECTION_REASON_LENGTH} characters or fewer.`,
      );
      return;
    }

    // Captured before the round trip: the reviewer may switch tabs while the
    // write is in flight, and where the decided row lives is a property of
    // where it was made, not of where they are when it lands.
    const view = this.activeView();
    const reason = status === 'rejected' ? this.reasonFor(question).trim() : '';
    this.pendingActionId.set(question.id);
    this.actionError.set(null);
    this.actionResult.set(null);
    try {
      await this.firebaseService.setQuestionStatus(question.id, status, reason);
      // The words have been sent; keeping them would put them back in the box
      // if the reviewer reopens the tab, next to a question already decided.
      this.reasonDrafts.update((drafts) => {
        const remaining = { ...drafts };
        delete remaining[question.id];
        return remaining;
      });
      if (view === 'reports') {
        // The report stays — it is the record that somebody complained, not a
        // task to tick off — so the row's copy of the question is updated in
        // place instead. Every row naming the same question is updated, because
        // several reports about one question is the normal case and one write
        // settles all of them.
        this.reports.update((rows) =>
          rows.map((row) =>
            row.question?.id === question.id
              ? {
                  ...row,
                  question: {
                    ...row.question,
                    status,
                    // Mirrors what the write did: the rules refuse a reason on
                    // anything but a rejected question, so the service clears
                    // it and so must the row.
                    ...(reason ? { rejectionReason: reason } : { rejectionReason: undefined }),
                  },
                }
              : row,
          ),
        );
      } else if (status === view) {
        // The decision did not move the question out of the tab it is being
        // read in, so the row stays and is updated in place. Only one write
        // does this — "Update reason" on the Rejected tab, which exists
        // because the rules deliberately allow a reason to be attached to a
        // question already rejected — but filtering unconditionally would make
        // the row vanish from the list it still belongs to.
        this.questions.update((all) =>
          all.map((q) =>
            q.id === question.id
              ? { ...q, status, ...(reason ? { rejectionReason: reason } : {}) }
              : q,
          ),
        );
      } else {
        // Drop the row locally rather than refetching: the reviewer's next
        // decision should not wait on a round trip, and the row no longer
        // belongs in the tab they are looking at.
        this.questions.update((all) => all.filter((q) => q.id !== question.id));
      }
      // Announced, so the reviewer is told what happened rather than inferring
      // it from a row that moved. A write that leaves the status where it was
      // is a reason update, and saying "marked rejected" about a question that
      // was already rejected narrates something that did not happen.
      this.actionResult.set(
        question.status === status && status === 'rejected'
          ? reason
            ? 'Reason updated.'
            : 'Reason cleared.'
          : `Question marked ${status}.`,
      );
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

  protected reportedAt(report: QuestionReport): string {
    return report.createdAt ? new Date(report.createdAt).toLocaleString() : 'Unknown';
  }

  protected reasonLabel(report: QuestionReport): string {
    return REASON_LABELS[report.reason];
  }
}
