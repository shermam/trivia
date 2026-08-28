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
  viewChildren,
} from '@angular/core';
import { NgClass, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import {
  Answer,
  PickedAnswer,
  DEFAULT_TIME_LIMIT,
  LeaderboardEntry,
  NewQuestionReportDoc,
  QuestionReportReason,
  TriviaQuestion,
  boardKey,
} from '../../models/question.model';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AccountService } from '../../services/account.service';
import { AuthService } from '../../services/auth.service';
import { EmbedModeService } from '../../services/embed-mode.service';
import { FirebaseService, QuestionReportRejectedError } from '../../services/firebase.service';
import { isFirestorePermissionDenied } from '../../services/firestore-rest/firestore-rest.client';
import { GameControllerService } from '../../services/game-controller.service';
import { IconComponent } from '../icon/icon.component';

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

/** One question, as the recap shows it. */
interface RecapRow {
  number: number;
  question: TriviaQuestion;
  /** The option the player picked; `null` when they never picked one. */
  picked: Answer | null;
  correct: Answer | null;
  /**
   * The three outcomes rendered as one value rather than a pair of booleans.
   * `timedOut` and `skipped` were briefly both flags, which admits a fourth
   * state that means nothing — the template would then have to decide which of
   * two contradicting `true`s wins.
   */
  outcome: PickedAnswer['kind'];
  wasRight: boolean;
}

/**
 * The five faces of the card between the score summary and the leaderboard.
 *
 * They are enumerated rather than derived in the template because all five are
 * laid out together in one grid cell — see the template — so "which one is
 * showing" and "which ones reserve the height" are separate questions, and only
 * the first is a decision.
 */
type ScoreAction = 'saved' | 'saveFailed' | 'signIn' | 'verify' | 'save';

@Component({
  selector: 'app-game-over',
  standalone: true,
  imports: [FormsModule, IconComponent, NgClass, NgTemplateOutlet],
  templateUrl: './game-over.component.html',
  styleUrl: './game-over.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameOverComponent implements OnInit {
  protected readonly gameController = inject(GameControllerService);
  protected readonly authService = inject(AuthService);
  private readonly accountService = inject(AccountService);
  protected readonly authMenuState = inject(AuthMenuStateService);
  protected readonly embedMode = inject(EmbedModeService);
  private readonly firebaseService = inject(FirebaseService);

  protected readonly initialsFor = initialsFor;

  /**
   * The board this game's score belongs on (finding G7) — derived from the
   * config the game was actually played under, never from a separate piece of
   * component state, so the screen cannot show one board and write to another.
   *
   * Falls back to the default for a game restored from a save written before
   * the timer was adjustable; those were all played at 15 seconds.
   */
  protected readonly board = computed(() =>
    boardKey(this.gameController.config()?.timeLimit ?? DEFAULT_TIME_LIMIT),
  );

  /** How the board is named in prose — "15-second", "30-second", "no-limit". */
  protected readonly boardLabel = computed(() =>
    this.board() === 'unlimited' ? 'no-limit' : `${this.board()}-second`,
  );

  protected playerName = '';
  protected readonly isSaving = signal(false);
  protected readonly hasSaved = signal(false);
  protected readonly saveError = signal<string | null>(null);
  protected readonly leaderboard = signal<LeaderboardEntry[]>([]);
  protected readonly isLoadingLeaderboard = signal(true);
  protected readonly leaderboardError = signal<string | null>(null);

  /**
   * How many rows the board is, in every state.
   *
   * The same number is the `limit` passed to `getTopScores`, and that is the
   * point: the board's height is known before its contents are, so there is
   * no reason for it to be one line while loading and ten rows afterwards.
   * Filling the gap with placeholder rows keeps the card the same size from
   * first paint, and a game-over screen resolving under the reader's eyes is
   * the worst possible moment to move the page.
   */
  protected readonly LEADERBOARD_SIZE = 10;

  /**
   * The rows that exist only to hold space open — one per slot the board has
   * not filled, and all ten while it is still loading.
   *
   * An array rather than a count because `@for` needs something to iterate;
   * its contents are never read.
   */
  protected readonly fillerRows = computed(() =>
    Array.from(
      {
        length: this.isLoadingLeaderboard()
          ? 0
          : Math.max(0, this.LEADERBOARD_SIZE - this.leaderboard().length),
      },
      (_, index) => index,
    ),
  );

  /** All ten rows, pulsing, while the fetch is in flight. */
  protected readonly skeletonRows = Array.from({ length: 10 }, (_, index) => index);

  /**
   * The one-line message that replaces the board's contents, or null when the
   * board has rows to show.
   *
   * It is laid *over* the reserved rows rather than instead of them, so an
   * empty board and a full one are the same height.
   */
  protected readonly leaderboardMessage = computed(() => {
    if (this.isLoadingLeaderboard()) {
      return null;
    }
    if (this.leaderboardError()) {
      return this.leaderboardError();
    }
    return this.leaderboard().length === 0 ? 'No scores yet. Be the first!' : null;
  });

  /**
   * What a screen reader is told about the board's state, since the skeleton
   * and filler rows are `aria-hidden` decoration.
   *
   * Rendered always so the region exists before its text changes (G3), the
   * same contract as the quiz's result announcement.
   */
  protected readonly leaderboardStatus = computed(() => {
    if (this.isLoadingLeaderboard()) {
      return 'Loading leaderboard\u2026';
    }
    return this.leaderboardMessage() ?? '';
  });

  /**
   * The community questions this game actually served — the only ones a
   * player can report (finding H4). Open Trivia DB questions aren't ours to
   * moderate, so they get no report affordance and the whole section
   * disappears for a game without custom questions.
   */
  protected readonly reportableQuestions = computed(() =>
    this.gameController.questions().filter((question) => question.source === 'custom'),
  );

  /**
   * The questions the player flagged mid-game — the ones this screen leads
   * with, because they are the ones the player has already said something is
   * wrong with. Everything else is behind the dialog.
   */
  protected readonly flaggedQuestions = computed(() => {
    const flagged = this.gameController.flaggedQuestionIds();
    return this.reportableQuestions().filter((question) => flagged.has(question.id));
  });

  protected readonly isReportDialogOpen = signal(false);
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
  /**
   * The "Reported" badges — the focus target after a successful submit
   * removes the trigger. Queried rather than looked up by id so the read
   * cannot pick up a stale node from a previous render.
   */
  private readonly reportBadges = viewChildren<ElementRef<HTMLElement>>('reportBadge');
  private readonly reportDialog = viewChild<ElementRef<HTMLElement>>('reportDialog');
  private readonly reportDialogTrigger = viewChild<ElementRef<HTMLElement>>('reportDialogTrigger');
  private wasDialogOpen = false;
  private previouslyFocusedBeforeReport: HTMLElement | null = null;
  private wasReportOpen = false;
  private lastOpenReportId: string | null = null;

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

      // Re-captured on every change of panel, not just closed→open:
      // switching straight from question A's form to question B's must
      // record B's trigger, or closing B would send focus back to A's —
      // the disclosure the user wasn't interacting with.
      if (isOpen && (!this.wasReportOpen || openId !== this.lastOpenReportId)) {
        this.previouslyFocusedBeforeReport = document.activeElement as HTMLElement | null;
      }

      if (isOpen && panel) {
        panel.nativeElement.focus();
      }

      if (!isOpen && this.wasReportOpen) {
        const restoreTo = this.previouslyFocusedBeforeReport;
        const badgeId = `report-badge-${this.lastOpenReportId}`;
        this.previouslyFocusedBeforeReport = null;

        // The whole decision is deferred by a microtask, not just the badge
        // half, because this effect runs *inside* the change-detection pass
        // that rearranges the list — and at that instant the DOM still shows
        // the previous arrangement. Deciding here reads a stale document
        // twice over: after a successful submit the trigger is still
        // connected (so it gets focused, and is then destroyed by the very
        // same pass, dropping focus to `<body>`), while the badge that
        // replaces it is not yet attached (so focusing it is a silent
        // no-op). Both were observed; both look correct in any test that
        // does not render. One microtask later the pass has committed and
        // `isConnected` finally means what it says. No teardown needed — a
        // microtask cannot outlive the frame (cf. §4.4).
        queueMicrotask(() => {
          if (restoreTo?.isConnected) {
            restoreTo.focus();
            return;
          }
          const badge = this.reportBadges().find((ref) => ref.nativeElement.id === badgeId);
          if (badge?.nativeElement.isConnected) {
            badge.nativeElement.focus();
          }
        });
      }

      this.wasReportOpen = isOpen;
      if (openId !== null) {
        this.lastOpenReportId = openId;
      }
    });

    // The dialog's own focus contract. Same microtask deferral as above and
    // for the same reason: the dialog element does not exist yet on the pass
    // that opens it, and still exists on the pass that closes it.
    effect(() => {
      const isOpen = this.isReportDialogOpen();
      const dialog = this.reportDialog();

      if (isOpen && dialog) {
        // The dialog itself, not its first control — so it is announced with
        // its title, and Tab then reaches the close button first.
        dialog.nativeElement.focus();
      }

      if (!isOpen && this.wasDialogOpen) {
        // Restored to the trigger element itself, unlike the disclosure above
        // and unlike the auth menu — deliberately, because this dialog has
        // exactly one opener, so there is no ambiguity to resolve. Reading
        // `document.activeElement` at open time would actually be *worse*
        // here: a click does not focus a `<button>` on Safari/macOS, so the
        // capture reads `<body>`, which is connected, so the restore
        // "succeeds" into nothing and the keyboard user loses their place.
        // Deferred for the same reason as the disclosure's restore: the
        // trigger is re-rendered by the pass this effect runs inside.
        const trigger = this.reportDialogTrigger();
        queueMicrotask(() => {
          if (trigger?.nativeElement.isConnected) {
            trigger.nativeElement.focus();
          }
        });
      }

      this.wasDialogOpen = isOpen;
    });
  }

  protected openReportDialog(): void {
    this.isReportDialogOpen.set(true);
  }

  protected closeReportDialog(): void {
    // Close any form open inside it too: leaving one open would reopen the
    // dialog mid-form with a reason the user chose minutes ago.
    this.closeReportForm();
    this.isReportDialogOpen.set(false);
  }

  /**
   * Keeps Tab inside the dialog while it is open (`aria-modal="true"` is a
   * promise to assistive tech, not an implementation) — without this, Tab
   * walks straight out into the page behind, which is still fully rendered.
   *
   * Handled on a plain `keydown` rather than Angular's `keydown.tab`, because
   * that binding does not fire for Shift+Tab — the half that matters most,
   * since it is the direction that escapes backwards past the dialog's first
   * control.
   */
  protected keepFocusInDialog(event: KeyboardEvent): void {
    if (event.key !== 'Tab') {
      return;
    }
    const dialog = this.reportDialog()?.nativeElement;
    if (!dialog) {
      return;
    }

    // No visibility filter on top of the selector. The obvious one —
    // `offsetParent !== null` — is wrong twice over: it reports null for any
    // `position: fixed` element (which this dialog is), and jsdom does not
    // implement it at all, so it silently empties the list and the trap
    // degrades to "always bounce back to the dialog". Nothing here needs it
    // anyway: the template removes controls with `@if` rather than hiding
    // them, and `:not([disabled])` covers the rest.
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );

    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
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

  /**
   * Whether there is a real, settled account behind this game — as opposed to
   * an anonymous session, or auth that has not answered yet.
   *
   * **`user() !== null` is the load-bearing half, and its absence was the
   * bug.** `isAnonymous()` is `user()?.isAnonymous ?? false`, so it reads
   * `false` when there is no user *at all* — which is true for every frame
   * before `onAuthStateChanged` fires, and again in the window after it fires
   * with `null` and before `signInAnonymously()` delivers a session. The old
   * `@else if (isAnonymous())` chain therefore fell straight through to its
   * "signed in but unverified" arm and told a signed-out visitor to verify an
   * email they had never given us. Same defect, same shape, as the account
   * chip's `?` avatar flash (`docs/app.md` §1).
   *
   * The fix is not another condition; it is asserting a positive fact instead
   * of the absence of a negative (`CLAUDE.md` §4.4).
   */
  protected readonly showsRealAccount = computed(
    () => this.authService.user() !== null && !this.authService.isAnonymous(),
  );

  /**
   * Which of the card's five faces to show, as one pure decision rather than a
   * template `@if`/`@else if` chain.
   *
   * Written this way for two reasons. It is unit-testable in isolation, which
   * a chain of template conditions is not — and the flash above was a defect
   * *in the ordering of that chain*, which is precisely the thing a test could
   * not reach. And it makes the default explicit: everything that is not
   * positively known to be a real signed-in account resolves to `'signIn'`,
   * including "auth has not answered yet", which is the least alarming of the
   * three and the one a first-time visitor almost always ends up in anyway.
   */
  protected readonly scoreAction = computed<ScoreAction>(() => {
    if (this.hasSaved()) {
      return this.saveError() ? 'saveFailed' : 'saved';
    }
    if (!this.showsRealAccount()) {
      return 'signIn';
    }
    return this.authService.isFullyAuthenticated() ? 'save' : 'verify';
  });

  /**
   * One row per question: what was asked, what the player picked, and what was
   * right. Everything is derived from the recorded outcome — see
   * `PickedAnswer` for why nothing else is stored.
   *
   * **Empty unless the history covers the whole game**, which is the honest
   * failure mode rather than a defensive one. A restored save written before
   * this feature existed has no history, and a recap built from it would say
   * "Review answers (0/10 correct)" underneath a score card reading 8/10 —
   * confidently wrong, which is worse than absent. The template renders
   * nothing at all in that case.
   */
  protected readonly recap = computed<RecapRow[]>(() => {
    const questions = this.gameController.questions();
    const history = this.gameController.answerHistory();
    if (questions.length === 0 || history.length !== questions.length) {
      return [];
    }

    const rows: RecapRow[] = [];
    for (const [index, question] of questions.entries()) {
      const outcome = history[index];
      // `find` by id, never by text: two options can carry the same string,
      // and letting text stand in for identity is what made a wrong answer
      // score as correct once already (`CLAUDE.md` §4.4).
      const picked =
        outcome.kind === 'answered'
          ? (question.all_answers.find((a) => a.id === outcome.id) ?? null)
          : null;
      // An id that names no option on its own question. Unreachable from a
      // live game and rejected on restore (`isUsableAnswerHistory`), so this
      // is the third guard on the same thing — and it drops the *whole* recap
      // rather than the row, for the same reason the restore does: the rows
      // are positional, and a recap missing one silently renumbers the rest.
      if (outcome.kind === 'answered' && picked === null) {
        return [];
      }
      rows.push({
        number: index + 1,
        question,
        picked,
        correct: question.all_answers.find((a) => a.isCorrect) ?? null,
        outcome: outcome.kind,
        wasRight: picked?.isCorrect === true,
      });
    }
    return rows;
  });

  protected readonly recapCorrectCount = computed(
    () => this.recap().filter((row) => row.wasRight).length,
  );

  private readonly isRecapOpenSignal = signal(false);
  protected readonly isRecapOpen = this.isRecapOpenSignal.asReadonly();
  protected readonly recapPanelId = 'game-recap-panel';

  protected toggleRecap(): void {
    this.isRecapOpenSignal.update((open) => !open);
  }

  /**
   * The longest run of consecutive correct answers in this game.
   *
   * Derived from the recap rather than tracked during play — the data is
   * already there, and a second counter maintained in the quiz loop would be a
   * second thing that can disagree with the score.
   *
   * A game restored from a save written before the recap shipped has no
   * history, so this is 0 while `score` is genuinely non-zero. That is a
   * knowing under-report rather than a rejection: the server accepts it (see
   * `game-stats.test.ts`), and the alternative — refusing to bank the game —
   * would lose more.
   */
  private bestStreak(): number {
    let best = 0;
    let run = 0;
    for (const row of this.recap()) {
      run = row.wasRight ? run + 1 : 0;
      best = Math.max(best, run);
    }
    return best;
  }

  /**
   * Banks this game into the player's lifetime totals.
   *
   * Fire-and-forget on purpose — the screen is already rendered from local
   * state and must not wait on a cold start. Skipped entirely for a game with
   * no `gameId`, which means a save written before that field existed: minting
   * one here would produce a fresh id on every reload of this screen and
   * inflate the totals on each one, which is precisely what the id exists to
   * prevent.
   *
   * Anonymous and unverified sessions are refused server-side rather than
   * here, so this deliberately does not duplicate that predicate — a client
   * mirror of a server gate is a thing that drifts (H6).
   */
  private recordGameResult(): void {
    const gameId = this.gameController.gameId();
    if (!gameId) {
      return;
    }
    void this.accountService.recordGameResult({
      gameId,
      totalQuestions: this.gameController.totalQuestions(),
      correctAnswers: this.gameController.score(),
      bestStreak: this.bestStreak(),
    });
  }

  ngOnInit(): void {
    // Reaching here means hasCompletedGameGuard passed — a finished game is in
    // memory (finding F4; the completeness check lives on the route, not here).
    this.playerName = this.authService.user()?.displayName ?? '';
    void this.loadLeaderboard();
    this.recordGameResult();
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
        timeLimit: this.board(),
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
    // Cleared before the round trip, not as decoration: signals compare with
    // Object.is, so setting the same outcome text twice ("Report sent…" for
    // a second question, or the same failure on a retry) would never mutate
    // the DOM — and a live region only announces on mutation. Passing
    // through '' while the write is in flight guarantees the next outcome
    // is a fresh mutation, the same reason the quiz result region empties
    // between questions (G3).
    this.reportStatus.set('');

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
    if (isFirestorePermissionDenied(error)) {
      const existing = await this.firebaseService
        .getLeaderboardEntry(this.authService.user()?.uid ?? '', this.board())
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
      const topScores = await firstValueFrom(this.firebaseService.getTopScores(this.board(), 10));
      this.leaderboard.set(topScores);
    } catch {
      this.leaderboard.set([]);
      this.leaderboardError.set('Could not load the leaderboard. Please try again later.');
    } finally {
      this.isLoadingLeaderboard.set(false);
    }
  }
}
