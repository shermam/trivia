import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import {
  LeaderboardEntry,
  NewQuestionReportDoc,
  QuestionReportReason,
  TriviaQuestion,
} from '../../models/question.model';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { EmbedModeService } from '../../services/embed-mode.service';
import { FirebaseService, QuestionReportRejectedError } from '../../services/firebase.service';
import { GameControllerService } from '../../services/game-controller.service';
import { IconComponent } from '../icon/icon.component';

function isPermissionDeniedError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'permission-denied';
}

/** Derives initials for a leaderboard avatar, e.g. "Jane Doe" -> "JD". */
function initialsFor(name: string): string {
  const initials = name
    .trim()
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
  return initials || '?';
}

@Component({
  selector: 'app-game-over',
  standalone: true,
  imports: [FormsModule, IconComponent, NgClass],
  templateUrl: './game-over.component.html',
  styleUrl: './game-over.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameOverComponent implements OnInit {
  protected readonly gameController = inject(GameControllerService);
  protected readonly authService = inject(AuthService);
  protected readonly authMenuState = inject(AuthMenuStateService);
  protected readonly embedMode = inject(EmbedModeService);
  private readonly firebaseService = inject(FirebaseService);

  protected readonly initialsFor = initialsFor;

  protected playerName = '';
  protected readonly isSaving = signal(false);
  protected readonly hasSaved = signal(false);
  protected readonly saveError = signal<string | null>(null);
  protected readonly leaderboard = signal<LeaderboardEntry[]>([]);
  protected readonly isLoadingLeaderboard = signal(true);
  protected readonly leaderboardError = signal<string | null>(null);

  /**
   * The community questions this game actually served — the only ones a
   * player can report (finding H4). Open Trivia DB questions aren't ours to
   * moderate, so they get no report affordance and the whole section
   * disappears for a game without custom questions.
   */
  protected readonly reportableQuestions = computed(() =>
    this.gameController.questions().filter((question) => question.source === 'custom'),
  );

  protected readonly openReportQuestionId = signal<string | null>(null);
  protected readonly reportedQuestionIds = signal<ReadonlySet<string>>(new Set());
  protected readonly isSubmittingReport = signal(false);
  protected readonly reportError = signal<string | null>(null);
  /** Text of the permanent `role="status"` region — set on every report outcome (G3 pattern). */
  protected readonly reportStatus = signal('');
  protected reportReason: QuestionReportReason | '' = '';
  protected reportDetail = '';

  protected readonly reportReasonOptions: { value: QuestionReportReason; label: string }[] = [
    { value: 'incorrect', label: 'The answer is wrong' },
    { value: 'inappropriate', label: 'Inappropriate or offensive' },
    { value: 'spam', label: 'Spam or nonsense' },
    { value: 'other', label: 'Something else' },
  ];

  /**
   * Only the open panel is rendered (`@if` in the template), so this resolves
   * to at most one element even though the trigger list is a loop.
   */
  private readonly reportPanel = viewChild<ElementRef<HTMLElement>>('reportPanel');
  private previouslyFocusedBeforeReport: HTMLElement | null = null;
  private wasReportOpen = false;

  constructor() {
    // Focus follows the report form: into the panel when it opens, back to
    // whatever opened it when it closes — same contract as the auth menu
    // (G2), for the same reason: without it a keyboard user tabs through the
    // whole page to reach a form that is already on screen, and closing it
    // drops them at <body>.
    effect(() => {
      const openId = this.openReportQuestionId();
      const panel = this.reportPanel();
      const isOpen = openId !== null;

      if (isOpen && !this.wasReportOpen) {
        this.previouslyFocusedBeforeReport = document.activeElement as HTMLElement | null;
      }

      if (isOpen && panel) {
        panel.nativeElement.focus();
      }

      if (!isOpen && this.wasReportOpen) {
        const restoreTo = this.previouslyFocusedBeforeReport;
        this.previouslyFocusedBeforeReport = null;
        // Only if still in the document: submitting swaps the trigger for a
        // "Reported" badge, and focusing a detached node silently drops
        // focus to <body>.
        if (restoreTo?.isConnected) {
          restoreTo.focus();
        }
      }

      this.wasReportOpen = isOpen;
    });
  }

  protected readonly performanceLabel = computed(() => {
    const percentage = this.gameController.percentage();
    if (percentage >= 90) return 'Outstanding!';
    if (percentage >= 70) return 'Great job!';
    if (percentage >= 50) return 'Good effort!';
    return 'Keep practicing!';
  });

  protected readonly performanceColorClass = computed(() => {
    const percentage = this.gameController.percentage();
    if (percentage >= 90) return 'text-emerald-700 dark:text-emerald-400';
    if (percentage >= 70) return 'text-emerald-600 dark:text-emerald-400';
    if (percentage >= 50) return 'text-amber-700 dark:text-amber-400';
    return 'text-red-700 dark:text-red-400';
  });

  /**
   * Rank among the fetched top 10 only — there's no cheap way to know a
   * player's exact rank if their score didn't make the top 10 without a
   * dedicated Firestore count query, so this stays `null` in that case
   * rather than guessing.
   */
  protected readonly playerRank = computed(() => {
    const uid = this.authService.user()?.uid;
    if (!uid) {
      return null;
    }
    const index = this.leaderboard().findIndex((entry) => entry.uid === uid);
    return index === -1 ? null : index + 1;
  });

  ngOnInit(): void {
    // Reaching here means hasCompletedGameGuard passed — a finished game is in
    // memory (finding F4; the completeness check lives on the route, not here).
    this.playerName = this.authService.user()?.displayName ?? '';
    void this.loadLeaderboard();
  }

  protected openSignIn(): void {
    this.authMenuState.open();
  }

  protected async resendVerification(): Promise<void> {
    this.saveError.set(null);
    try {
      await this.authService.resendVerificationEmail();
    } catch {
      this.saveError.set('Could not send the verification email. Please try again.');
    }
  }

  async saveScore(): Promise<void> {
    const user = this.authService.user();
    const name = this.playerName.trim();
    if (!name || this.hasSaved() || !user || !this.authService.isFullyAuthenticated()) {
      return;
    }

    this.isSaving.set(true);
    this.saveError.set(null);

    try {
      await this.firebaseService.saveHighScore({
        uid: user.uid,
        name,
        score: this.gameController.score(),
        totalQuestions: this.gameController.totalQuestions(),
        percentage: this.gameController.percentage(),
        createdAt: Date.now(),
      });
      this.hasSaved.set(true);
      await this.loadLeaderboard();
    } catch (error) {
      await this.reportSaveFailure(error, this.gameController.score());
    } finally {
      this.isSaving.set(false);
    }
  }

  protected toggleReportForm(question: TriviaQuestion): void {
    if (this.openReportQuestionId() === question.id) {
      this.closeReportForm();
      return;
    }
    this.reportReason = '';
    this.reportDetail = '';
    this.reportError.set(null);
    this.openReportQuestionId.set(question.id);
  }

  protected closeReportForm(): void {
    this.openReportQuestionId.set(null);
  }

  protected async submitReport(question: TriviaQuestion): Promise<void> {
    const reason = this.reportReason;
    if (!reason || this.isSubmittingReport()) {
      return;
    }
    const uid = this.authService.user()?.uid;
    if (!uid) {
      // Every visitor gets an anonymous session on load, so this only happens
      // if that bootstrap failed — nothing to do but say so generically.
      this.setReportFailure('Could not send the report. Please try again.');
      return;
    }

    this.isSubmittingReport.set(true);
    this.reportError.set(null);

    const detail = this.reportDetail.trim();
    const report: NewQuestionReportDoc = {
      questionId: question.id,
      reason,
      // Omitted rather than undefined when blank — Firestore rejects
      // `undefined` values, and the rules only allow `detail` with content.
      ...(detail ? { detail } : {}),
      reportedBy: uid,
      createdAt: Date.now(),
    };

    try {
      await this.firebaseService.reportQuestion(report);
      this.reportedQuestionIds.update((ids) => new Set(ids).add(question.id));
      this.closeReportForm();
      this.reportStatus.set('Report sent. Thank you for helping keep the question bank in shape.');
    } catch (error) {
      // The rejection message deliberately doesn't pick a cause: exhausting
      // every ID slot usually means the volume cap, but an invalid payload is
      // refused identically (`permission-denied` either way), and clients
      // can't read reports back to tell the two apart. Claiming "too many
      // reports" when the real cause was, say, a skewed clock would be the
      // exact mistake B4 was (CLAUDE.md §4.4) — so both messages stay causal
      // only about what to *do*.
      this.setReportFailure(
        error instanceof QuestionReportRejectedError
          ? error.message
          : 'Could not send the report. Please try again.',
      );
    } finally {
      this.isSubmittingReport.set(false);
    }
  }

  /** Failure shows inline *and* announces via the status region (G3). */
  private setReportFailure(message: string): void {
    this.reportError.set(message);
    this.reportStatus.set(message);
  }

  /**
   * Explains a failed save, without inventing a reason for it.
   *
   * `permission-denied` used to be reported as "your best score is already
   * higher" unconditionally. Since the leaderboard rules were tightened that
   * is one of several reasons a write is refused — a clock outside the
   * accepted window, a name over 30 characters, an account that isn't
   * verified, a score inconsistent with the question count — so the message
   * was false whenever the cause was any of the others. It also set
   * `hasSaved`, which replaces the form with the saved panel and leaves no way
   * to retry something that might well have succeeded on a second attempt.
   *
   * So the claim is now checked before it is made: the leaderboard is publicly
   * readable, and the caller's own row says whether their existing best really
   * does beat this game. Only then is the friendly message true — and only
   * then is suppressing retry right, because the rules will refuse the same
   * write every time. Anything else, including a lookup that itself fails,
   * gets the generic message and keeps the form open.
   */
  private async reportSaveFailure(error: unknown, attemptedScore: number): Promise<void> {
    if (isPermissionDeniedError(error)) {
      const existing = await this.firebaseService
        .getLeaderboardEntry(this.authService.user()?.uid ?? '')
        .catch(() => null);

      if (existing && existing.score >= attemptedScore) {
        this.hasSaved.set(true);
        this.saveError.set(
          `Your best score is already higher (${existing.score}/${existing.totalQuestions}) — ` +
            'nice consistency! We kept your existing best.',
        );
        return;
      }
    }
    this.saveError.set('Could not save your score. Please try again.');
  }

  protected playAgain(): void {
    this.gameController.resetGame();
  }

  private async loadLeaderboard(): Promise<void> {
    this.isLoadingLeaderboard.set(true);
    this.leaderboardError.set(null);
    try {
      const topScores = await firstValueFrom(this.firebaseService.getTopScores(10));
      this.leaderboard.set(topScores);
    } catch {
      this.leaderboard.set([]);
      this.leaderboardError.set('Could not load the leaderboard. Please try again later.');
    } finally {
      this.isLoadingLeaderboard.set(false);
    }
  }
}
