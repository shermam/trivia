import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
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
  Difficulty,
  LeaderboardEntry,
  NewQuestionReportDoc,
  QuestionReportReason,
  RegionalLeaderboardEntry,
  TriviaQuestion,
  boardKey,
} from '../../models/question.model';
import { VoteValue } from '../../models/question-vote';
import { regionName, regionOptions } from '../../models/regions';
import { AudioService } from '../../services/audio.service';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AccountService } from '../../services/account.service';
import { AuthService } from '../../services/auth.service';
import { EmbedModeService } from '../../services/embed-mode.service';
import { FirebaseService, QuestionReportRejectedError } from '../../services/firebase.service';
import { isFirestorePermissionDenied } from '../../services/firestore-rest/firestore-rest.client';
import { GameControllerService } from '../../services/game-controller.service';
import { QuestionVoteService, describeVoteOutcome } from '../../services/question-vote.service';
import { RegionService } from '../../services/region.service';
import { topicTagsOf } from '../../utils/category-tags';
import { difficultyBand, difficultyScore } from '../../utils/difficulty-score.util';
import { keepTabInside } from '../../utils/focus-trap.util';
import { buildPlayAnswers } from '../../utils/play-history.util';
import { isMachineGenerated } from '../../utils/question-provenance.util';
import { IconComponent } from '../icon/icon.component';
import { QuestionJustificationComponent } from '../question-justification/question-justification.component';
import { QuestionTagsComponent } from '../question-tags/question-tags.component';
import { QuestionVoteComponent } from '../question-vote/question-vote.component';
import { RenderedTextComponent } from '../rendered-text/rendered-text.component';
import { SourceLinkComponent } from '../source-link/source-link.component';
import { messageOf, msg, type Message } from '../../i18n/message';
import { TPipe } from '../../i18n/t.pipe';
import { difficultyLabel } from '../../utils/difficulty-label.util';

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
  /**
   * What the question is about, through the derivation every reader shares
   * (`FEAT-052`): its tags, or the tag a pre-topics question's category
   * derives. The first is the row's label; the whole list is rendered as
   * chips only when there is more than that one, so a single-topic question
   * — every Open Trivia question, and most contributions — does not show the
   * same tag twice in one row.
   */
  topics: string[];
  /**
   * The word the row's difficulty pill shows. For a community question it is
   * the band its players have measured (`FEAT-023`) — the label shrunk towards
   * how often it was answered right, named in the label's own three words; for
   * an Open Trivia question it is the label it arrived with, since there is no
   * document behind it to count against and a measured band would only ever
   * be that label in disguise. One field and one pill either way, so every row
   * holds the same box (`CLAUDE.md` §4.4).
   *
   * Derived from the counters the question carried when this game drew it —
   * the document the draw already read — so it costs no read, and it is the
   * difficulty the player was dealt rather than one this game's own answer has
   * since moved.
   */
  difficulty: Difficulty;
  /**
   * Whether the generation pipeline wrote the question (`FEAT-020`), which
   * makes the row's source line read "Machine-generated from …". Read off the
   * one fact `TriviaService` carries from the stored `provenance`, so it is
   * the same answer after a reload of this screen as before it.
   */
  machineGenerated: boolean;
}

/**
 * The six faces of the card between the score summary and the leaderboard.
 *
 * They are enumerated rather than derived in the template because all six are
 * laid out together in one grid cell — see the template — so "which one is
 * showing" and "which ones reserve the height" are separate questions, and only
 * the first is a decision.
 *
 * `quiz` is the curated quiz's (`FEAT-024`): a quiz game makes no leaderboard
 * entry, so its face says so in place of every other.
 */
type ScoreAction = 'saved' | 'saveFailed' | 'signIn' | 'verify' | 'save' | 'quiz';

/** Which of the two boards the reader is looking at (`FEAT-028`). */
type BoardScope = 'global' | 'regional';

/** A report that did not go, for a cause nobody verified. */
const REPORT_FAILED = msg('over.reportFailed', 'Could not send the report. Please try again.');

@Component({
  selector: 'app-game-over',
  standalone: true,
  imports: [
    FormsModule,
    IconComponent,
    NgClass,
    NgTemplateOutlet,
    SourceLinkComponent,
    QuestionJustificationComponent,
    QuestionTagsComponent,
    QuestionVoteComponent,
    RenderedTextComponent,
    TPipe,
  ],
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
  private readonly audio = inject(AudioService);
  private readonly regionService = inject(RegionService);
  private readonly questionVotes = inject(QuestionVoteService);

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
  /**
   * The board's name is inside every sentence that mentions it — the save
   * heading, the board's title, the rank — so each is a sentence per board
   * rather than a frame around a name, and the seconds are the placeholder.
   */
  protected readonly saveHeading = computed(() =>
    this.board() === 'unlimited'
      ? msg('over.saveToUnlimited', 'Save your score to the no-limit leaderboard')
      : msg('over.saveToTimed', 'Save your score to the {seconds}-second leaderboard', {
          seconds: this.board(),
        }),
  );

  protected readonly boardHeading = computed(() =>
    this.board() === 'unlimited'
      ? msg('over.topUnlimited', 'Top 10 — no-limit games')
      : msg('over.topTimed', 'Top 10 — {seconds}-second games', { seconds: this.board() }),
  );

  /**
   * Whether this was a curated quiz rather than a drawn game (`FEAT-024`) —
   * and therefore a game with **no leaderboard entry**.
   *
   * A quiz is the same questions in the same order for everybody, so its score
   * is a different kind of number from a draw's: a player who has played it
   * once knows every answer the second time. It is not ranked, and no board of
   * its own exists either (`FEAT-024` §0.2). Everything else about the screen
   * is the same game's — the four tiles, the recap and its votes, the reports,
   * and `recordGameResult`, so a quiz still counts towards the player's totals
   * and play history.
   *
   * Known from the first frame: the quiz context is restored with the rest of
   * the game before this route activates, so the card never shows a save form
   * and then takes it away.
   */
  protected readonly isQuizGame = computed(() => this.gameController.quiz() !== null);

  protected playerName = '';
  protected readonly isSaving = signal(false);
  protected readonly hasSaved = signal(false);
  protected readonly saveError = signal<Message | null>(null);
  protected readonly leaderboard = signal<LeaderboardEntry[]>([]);
  protected readonly isLoadingLeaderboard = signal(true);
  protected readonly leaderboardError = signal<Message | null>(null);

  /** Every country the picker offers, named in the reader's own language. */
  protected readonly regionOptions = regionOptions();

  /**
   * The country the save form is currently set to publish under, or `''` for
   * "prefer not to say" (`FEAT-028`).
   *
   * Seeded from the player's stored declaration and, when there is none,
   * preselected from `RegionService.inferredRegion()` once that resolves.
   * **The two are not the same thing**, which is why the inference lands here
   * and never in storage: a preselection the reader can change before pressing
   * Save is a suggestion, and a preselection written to their device is a
   * record of where the app thinks they are.
   *
   * A late arrival only moves a radio and a `<select>`'s selected option —
   * neither resizes anything — and it is suppressed once the reader has
   * touched the control, so an answer that arrives two seconds in can never
   * overwrite a choice already made.
   */
  protected readonly selectedRegion = signal<string>(this.regionService.declaredRegion() ?? '');

  /** Whether the reader has used the picker this visit, which the inference must not override. */
  private regionChosenByReader = false;

  /** The country's own name, for a board heading and the toggle's label. */
  protected readonly selectedRegionName = computed(() => {
    const region = this.selectedRegion();
    return region ? regionName(region) : null;
  });

  /**
   * Which board the reader is looking at. Global by default, always.
   *
   * The regional option stays selectable with no country set — it explains how
   * to get one instead of ranking anybody — because a control that disables
   * itself is a control that has told the reader nothing about why.
   */
  protected readonly boardScope = signal<BoardScope>('global');

  /**
   * The toggle's two options, as data.
   *
   * Enumerated rather than written out twice in the template, so the two
   * labels cannot drift into different markup — the property that keeps the
   * pair the same size in both states is that they are one box repeated.
   */
  protected readonly BOARD_SCOPES: readonly { scope: BoardScope; label: Message }[] = [
    { scope: 'global', label: msg('over.scopeGlobal', 'Global') },
    { scope: 'regional', label: msg('over.scopeRegional', 'Regional') },
  ];

  /**
   * Which population the board is ranking, in words (`FEAT-028`).
   *
   * Its own line under the heading rather than folded into it, so the header
   * keeps one height across the toggle: the combined string is long enough to
   * wrap at 390px and short enough not to at 1024px, which is exactly the
   * viewport-dependent shift `CLAUDE.md` §4.4 describes.
   */
  protected readonly boardScopeLabel = computed(() => {
    if (this.boardScope() === 'global') {
      return msg('over.worldwide', 'Worldwide');
    }
    const country = this.selectedRegionName();
    return country
      ? msg('over.inCountry', 'In {country}', { country })
      : msg('over.yourCountry', 'Your country');
  });

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
  protected readonly leaderboardMessage = computed<Message | null>(() => {
    // The regional tab with no country set. Not an error and not an empty
    // board — there is no board to be empty — so it says how to get one
    // instead of ranking nobody, and never asks for a location (`FEAT-028`).
    if (this.boardScope() === 'regional' && !this.selectedRegion()) {
      return this.showsRealAccount()
        ? msg(
            'over.chooseCountry',
            'Choose your country in the save form above to see how you rank there.',
          )
        : msg(
            'over.signInForCountry',
            'Sign in and choose your country to see how you rank there.',
          );
    }
    if (this.isLoadingLeaderboard()) {
      return null;
    }
    if (this.leaderboardError()) {
      return this.leaderboardError();
    }
    if (this.leaderboard().length === 0) {
      // A board of one is the normal state of a country nobody has played in
      // yet, and there is deliberately no minimum participant count — an empty
      // national board is an invitation, not a defect.
      return this.boardScope() === 'regional'
        ? msg('over.noScoresIn', 'No scores in {country} yet. Be the first!', {
            country: this.selectedRegionName(),
          })
        : msg('over.noScores', 'No scores yet. Be the first!');
    }
    return null;
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
      return msg('over.loadingBoard', 'Loading leaderboard…');
    }
    return this.leaderboardMessage();
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
  protected readonly reportError = signal<Message | null>(null);
  /** Text of the permanent `role="status"` region — set on every report outcome (G3 pattern). */
  protected readonly reportStatus = signal<Message | null>(null);
  protected reportReason: QuestionReportReason | '' = '';
  protected reportDetail = '';

  protected readonly reportReasonOptions: { value: QuestionReportReason; label: Message }[] = [
    { value: 'incorrect', label: msg('over.reasonIncorrect', 'The answer is wrong') },
    {
      value: 'inappropriate',
      label: msg('over.reasonInappropriate', 'Inappropriate or offensive'),
    },
    { value: 'spam', label: msg('over.reasonSpam', 'Spam or nonsense') },
    { value: 'other', label: msg('over.reasonOther', 'Something else') },
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

    // The player's own votes on the round's community questions, for the
    // recap's buttons (`FEAT-027`). Usually free: `/play` has already read
    // them and the service asks only about questions it does not know. It
    // pays for one query after a reload of this screen, and again after a
    // guest signs in here — the moment the buttons can first show a vote.
    effect(() => {
      const user = this.authService.user();
      const canVote = this.authService.isFullyAuthenticated();
      const questionIds = this.voteableQuestionIds();
      if (!user || !canVote || questionIds.length === 0) {
        return;
      }
      untracked(() => void this.questionVotes.load(questionIds));
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
    // The trap itself lives in `utils/focus-trap.util.ts`, shared with
    // `/my-questions`' two dialogs: the three ways of getting it wrong are
    // subtle enough that a second hand-written copy is a second chance to
    // reintroduce one.
    keepTabInside(event, this.reportDialog()?.nativeElement);
  }

  protected readonly performanceLabel = computed(() => {
    const percentage = this.gameController.percentage();
    if (percentage >= 90) return msg('over.outstanding', 'Outstanding!');
    if (percentage >= 70) return msg('over.greatJob', 'Great job!');
    if (percentage >= 50) return msg('over.goodEffort', 'Good effort!');
    return msg('over.keepPracticing', 'Keep practicing!');
  });

  /**
   * The accuracy tile's colour, which its 12px label wears as well as its
   * 36px figure — so every tier has to reach 4.5:1 against the tile, not just
   * the large-text 3:1 the figure alone would owe. That is why "Great job!"
   * shares emerald-700 with "Outstanding!": the brand emerald-600 it would
   * otherwise take is 3.5:1 on the light tile. In the dark theme the two
   * already shared emerald-400. The words carry the tier; the colour only
   * reinforces it (WCAG 1.4.1). `color-contrast.spec.ts` plays a round in that
   * tier and measures both themes, since Lighthouse never loads this screen.
   */
  protected readonly performanceColorClass = computed(() => {
    const percentage = this.gameController.percentage();
    if (percentage >= 70) return 'text-emerald-700 dark:text-emerald-400';
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
   * Which ranking the rank claim is about — the world, or one country.
   *
   * `playerRank` is read off whichever board is on screen, so the sentence has
   * to name it: "#3 on the 15-second leaderboard" would be a false claim about
   * the world for a player sitting third in Portugal.
   */
  protected readonly rankMessage = computed<Message | null>(() => {
    const rank = this.playerRank();
    if (rank === null) {
      return null;
    }
    const country = this.boardScope() === 'regional' ? this.selectedRegionName() : null;
    const unlimited = this.board() === 'unlimited';
    const seconds = this.board();
    if (country) {
      return unlimited
        ? msg(
            'over.rankUnlimitedIn',
            "You're ranked #{rank} on the no-limit leaderboard in {country}.",
            { rank, country },
          )
        : msg(
            'over.rankTimedIn',
            "You're ranked #{rank} on the {seconds}-second leaderboard in {country}.",
            { rank, seconds, country },
          );
    }
    return unlimited
      ? msg('over.rankUnlimited', "You're ranked #{rank} on the no-limit leaderboard.", { rank })
      : msg('over.rankTimed', "You're ranked #{rank} on the {seconds}-second leaderboard.", {
          rank,
          seconds,
        });
  });

  protected readonly difficultyLabel = difficultyLabel;

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
   * Which of the card's six faces to show, as one pure decision rather than a
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
    // First, and ahead of every auth state: a quiz is never saved, so there is
    // no account it could be shown to that would make a save form honest.
    if (this.isQuizGame()) {
      return 'quiz';
    }
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
        topics: topicTagsOf(question),
        difficulty:
          question.source === 'custom'
            ? difficultyBand(difficultyScore(question))
            : question.difficulty,
        machineGenerated: isMachineGenerated(question.provenance),
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
   * Whether a recap row offers the like and dislike buttons (`FEAT-027`) — the
   * same gate as the quiz's: a community question, outside an embed.
   *
   * **This is the vote with no clock on it.** During the round the buttons
   * last the two seconds the result is on screen; a player who needs longer
   * than that to reach them — a screen-reader user above all — has the same
   * buttons here, for every community question of the round, for as long as
   * they like (WCAG 2.2.1, `CLAUDE.md` §4.5).
   */
  protected showsVote(question: TriviaQuestion): boolean {
    return question.source === 'custom' && !this.embedMode.isEmbedded();
  }

  /**
   * What a screen reader is told about a vote cast from the recap. A region of
   * its own, permanent and outside the recap card, so it exists before it has
   * anything to say (G3).
   */
  protected readonly voteAnnouncement = signal<Message | null>(null);

  /** The recap's community questions — the ones its rows can be voted on. */
  private readonly voteableQuestionIds = computed(() =>
    this.recap()
      .filter((row) => this.showsVote(row.question))
      .map((row) => row.question.id),
  );

  /**
   * A press of like or dislike on one recap row. Same contract as the quiz's:
   * the buttons move at once, the write follows, and a tap without a real
   * account opens the account menu instead of writing (`FEAT-027` Decision 1).
   */
  protected async vote(questionId: string, position: number, value: VoteValue): Promise<void> {
    const outcome = await this.questionVotes.toggle(questionId, value);
    if (outcome.kind === 'needs-account') {
      this.authMenuState.open();
    }
    const message = describeVoteOutcome(outcome, position);
    if (message !== null) {
      this.voteAnnouncement.set(message);
    }
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
   * Anonymous sessions, and any sign-in provider the app does not offer, are
   * refused server-side by the shared caller gate
   * (`functions/src/caller-gate.ts`) rather than here, so this deliberately
   * does not duplicate that predicate — a client mirror of a server gate is a
   * thing that drifts (H6). A password account whose address is not verified
   * yet is banked like any other: the gate's email clause is for writes such
   * as the leaderboard save, which this screen's "verify" face is about.
   *
   * **Both numbers come from the game's own counters, and neither is the
   * score.** `correctAnswers` used to be `score()`, correct only while the two
   * were the same quantity; a multiplied score sent as a correct-answer count
   * is above `totalQuestions` and `isValidSubmission` refuses the whole
   * submission. The longest run is likewise the counter the quiz kept rather
   * than a walk over the recap: a recap-derived run reads a skip as a break,
   * and `FEAT-004` says a skip does neither.
   *
   * A game restored from a save written before those counters existed reports
   * a streak of 0 while its score is genuinely non-zero. That is a knowing
   * under-report rather than a rejection — the server accepts it (see
   * `game-stats.test.ts`), and refusing to bank the game would lose more.
   */
  private recordGameResult(): void {
    const gameId = this.gameController.gameId();
    if (!gameId) {
      return;
    }
    // The round itself (`FEAT-049`), or nothing when the two positional arrays
    // behind it do not cover the whole game — a save written before they
    // existed, or one whose recap was discarded on restore. Those games still
    // bank their totals, and the key is **omitted** rather than sent as
    // `undefined` so that what goes on the wire says so: the callable SDK
    // encodes a present-but-`undefined` key as `null` (`@firebase/functions`,
    // `encode()`), which would put a value in the payload for a field that has
    // none. `recordGameResult` reads the two alike — a submission's totals must
    // not depend on how its object literal was spelled — so this is the near
    // half of a bound held at both ends, not the only thing holding it.
    //
    // Sent for every account, including an anonymous one. The gate is the
    // callable's — the shared caller gate — and nothing here duplicates it, for
    // the reason the doc comment gives: a client mirror of a server gate is a
    // thing that drifts (H6). An anonymous submission is refused before any
    // write, so nothing is stored for a guest; what a refusal of a signed-in
    // account means is `AccountService.recordGameResult`'s to report.
    const answers = buildPlayAnswers(
      this.gameController.questions(),
      this.gameController.answerHistory(),
      this.gameController.answerDurations(),
    );
    void this.accountService.recordGameResult({
      gameId,
      totalQuestions: this.gameController.totalQuestions(),
      correctAnswers: this.gameController.correctAnswers(),
      bestStreak: this.gameController.maxStreak(),
      ...(answers ? { answers } : {}),
    });
  }

  /**
   * Whether every question of the round was answered correctly, which is the
   * celebration this screen is able to make honestly (`FEAT-003`).
   *
   * **Not "was this a personal best".** `FEAT-003` asks for a cue chosen by the
   * final score, and the obvious reading of that is a high-score fanfare — but
   * nothing in this app knows whether a player has ever done better. The
   * leaderboard keeps one best entry per account and enforces it inside
   * `firestore.rules`, so the only signal a client gets is a bare
   * `permission-denied` that could equally be a dozen other things
   * (`CLAUDE.md` §4.4). A fanfare fed by a guess is a claim the app cannot
   * check, so the split is made on the one thing the round itself settles.
   *
   * Accuracy, not points: a multiplied score is not a fraction of the question
   * count, and `correctAnswers` is the counter that can equal it (§1.1).
   */
  private readonly isPerfectRound = computed(() => {
    const total = this.gameController.totalQuestions();
    return total > 0 && this.gameController.correctAnswers() === total;
  });

  ngOnInit(): void {
    // Reaching here means hasCompletedGameGuard passed — a finished game is in
    // memory (finding F4; the completeness check lives on the route, not here).
    this.playerName = this.authService.user()?.displayName ?? '';
    // A quiz game shows no board — it has none, and is on nobody else's — so it
    // reads none: neither the top ten nor the country lookup that only the
    // save form and the regional tab use.
    if (!this.isQuizGame()) {
      void this.loadLeaderboard();
      void this.preselectRegion();
    }
    this.recordGameResult();
    // Once per arrival at the screen, a reload included — and the reload is
    // the case worth knowing about, because the obvious guess about it is
    // wrong. A reloaded document is not un-activated: measured in Chromium,
    // `navigator.userActivation.hasBeenActive` still reads `true` after a
    // reload and a context built there starts `running`, so this genuinely
    // plays rather than being skipped. What makes that safe is `AudioService`
    // scheduling only onto a running context: were it suspended, the tones
    // would be *queued* on a frozen clock and would arrive over the first
    // answer of the next game rather than being dropped.
    this.audio.playGameOver(this.isPerfectRound());
  }

  /**
   * Opens the picker on the app's best guess, when the player has not already
   * told it (`FEAT-028`).
   *
   * Three properties are load-bearing and each is one line. It **never
   * overrides a declaration** — a stored country, or one the reader has
   * touched the control for this visit — so an answer that arrives two seconds
   * into the page cannot undo a choice made in the first two. It **stores
   * nothing**: the guess lives in component state until the reader either
   * changes it or saves a score under it. And it **cannot fail loudly**:
   * `inferredRegion()` resolves to `null` for every failure there is, which is
   * also what it resolves to locally and on a preview channel, where
   * `/api/geo` does not exist at all.
   *
   * **It reloads the board when one is showing**, because until it lands the
   * regional tab has a country and no read: `leaderboardMessage` would fall
   * through to its empty-board branch and tell the reader "no scores in Brazil
   * yet" about a board nothing had asked for (`CLAUDE.md` §4.4 — the least
   * alarming default is the one that has not guessed). `loadLeaderboard` sets
   * the loading flag synchronously, before its first `await`, so the skeleton
   * is showing by the time this returns and the empty message never appears.
   */
  private async preselectRegion(): Promise<void> {
    if (this.regionService.declaredRegion()) {
      return;
    }
    const inferred = await this.regionService.inferredRegion();
    if (inferred && !this.regionChosenByReader && !this.regionService.declaredRegion()) {
      this.selectedRegion.set(inferred);
      if (this.boardScope() === 'regional') {
        void this.loadLeaderboard();
      }
    }
  }

  /**
   * The picker changed, which is the only event that turns a guess into a
   * declaration.
   *
   * `''` is "prefer not to say" and clears the stored value rather than
   * writing an empty one, so a reader who opts out is in the same state as one
   * who has never chosen — no regional entry is written, and nothing about
   * them is kept.
   */
  protected onRegionChange(region: string): void {
    this.regionChosenByReader = true;
    this.selectedRegion.set(region);
    this.regionService.declareRegion(region || null);
    if (this.boardScope() === 'regional') {
      void this.loadLeaderboard();
    }
  }

  /** The Global/Regional toggle. Re-reads the board, because it is a different collection. */
  protected onBoardScopeChange(scope: BoardScope): void {
    if (this.boardScope() === scope) {
      return;
    }
    this.boardScope.set(scope);
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
      this.saveError.set(
        msg('over.verificationFailed', 'Could not send the verification email. Please try again.'),
      );
    }
  }

  /**
   * Publishes the score — to the global board, and to the player's own
   * country board when they have named one (`FEAT-028`).
   *
   * **Two independent writes, attempted together rather than in sequence.**
   * They are separate documents under separate improving-score floors, so
   * either can be refused while the other succeeds, and the interesting case
   * is the common one: a player whose global best already stands can still be
   * first in a country they have only just declared. Gating the regional write
   * on the global one succeeding would silently deny them that, and gating it
   * the other way round would deny the reverse.
   *
   * So the save has succeeded if *either* document was written, and only a
   * round where both were refused reaches `reportSaveFailure`. That keeps the
   * one narrated failure — "your best score is already higher" — pinned to the
   * case it can actually verify, rather than being claimed for a round that
   * did publish something (`CLAUDE.md` §4.4).
   */
  async saveScore(): Promise<void> {
    const user = this.authService.user();
    const name = this.playerName.trim();
    // A quiz game's form is never shown (`scoreAction`), and this refuses it
    // as well, so no route to the write survives a template change — a quiz is
    // not ranked (`FEAT-024`).
    if (
      this.isQuizGame() ||
      !name ||
      this.hasSaved() ||
      !user ||
      !this.authService.isFullyAuthenticated()
    ) {
      return;
    }

    this.isSaving.set(true);
    this.saveError.set(null);

    const entry = {
      uid: user.uid,
      name,
      score: this.gameController.score(),
      totalQuestions: this.gameController.totalQuestions(),
      percentage: this.gameController.percentage(),
      createdAt: Date.now(),
      timeLimit: this.board(),
    };
    const region = this.selectedRegion();
    const regionalEntry: RegionalLeaderboardEntry | null = region ? { ...entry, region } : null;

    try {
      const writes = [
        this.firebaseService.saveHighScore(entry),
        ...(regionalEntry ? [this.firebaseService.saveRegionalHighScore(regionalEntry)] : []),
      ];
      const outcomes = await Promise.allSettled(writes);

      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      if (rejected.length === outcomes.length) {
        await this.reportSaveFailure(rejected[0].reason, entry.score);
        return;
      }
      this.hasSaved.set(true);
      await this.loadLeaderboard();
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
      this.setReportFailure(REPORT_FAILED);
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
    this.reportStatus.set(null);

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
      this.reportStatus.set(
        msg(
          'over.reportSent',
          'Report sent. Thank you for helping keep the question bank in shape.',
        ),
      );
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
          ? messageOf(error, REPORT_FAILED)
          : REPORT_FAILED,
      );
    } finally {
      this.isSubmittingReport.set(false);
    }
  }

  /** Failure shows inline *and* announces via the status region (G3). */
  private setReportFailure(message: Message): void {
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
          msg(
            'over.bestHigher',
            'Your best score is already higher ({score} points) — nice consistency! We kept your existing best.',
            { score: existing.score },
          ),
        );
        return;
      }
    }
    this.saveError.set(msg('over.saveFailed', 'Could not save your score. Please try again.'));
  }

  protected playAgain(): void {
    this.gameController.resetGame();
  }

  /**
   * Fetches whichever board is showing.
   *
   * The regional tab with no country set reads nothing at all rather than
   * reading an empty one: there is no path to query, and a skeleton that
   * resolves to "no scores yet" would be narrating an outcome no request
   * produced (`CLAUDE.md` §4.4). `leaderboardMessage` says how to get a board
   * instead.
   *
   * **Every call takes a sequence number and a late one throws its answer
   * away.** Two boards are one click apart now, so Global → Regional → Global
   * puts two reads in flight and the network decides which returns last —
   * which is how the world's top ten ends up rendered under "In Brazil". The
   * counter is the whole guard: only the most recent call may still write, and
   * a superseded one returns without touching a signal, including the loading
   * flag its successor is relying on. An `AbortSignal` would be tidier and is
   * not available — the read goes through `FirestoreRestClient`, whose
   * timeout is its own — so the request still completes and is simply not
   * read, which is a discarded response rather than the abandoned one
   * `CLAUDE.md` §4.4 warns about paying for.
   */
  private loadSequence = 0;

  private async loadLeaderboard(): Promise<void> {
    const sequence = ++this.loadSequence;
    const region = this.selectedRegion();
    const regional = this.boardScope() === 'regional';
    if (regional && !region) {
      this.leaderboard.set([]);
      this.leaderboardError.set(null);
      this.isLoadingLeaderboard.set(false);
      return;
    }

    this.isLoadingLeaderboard.set(true);
    this.leaderboardError.set(null);
    try {
      const topScores = await firstValueFrom(
        regional
          ? this.firebaseService.getRegionalTopScores(this.board(), region, 10)
          : this.firebaseService.getTopScores(this.board(), 10),
      );
      if (sequence !== this.loadSequence) {
        return;
      }
      this.leaderboard.set(topScores);
    } catch {
      if (sequence !== this.loadSequence) {
        return;
      }
      this.leaderboard.set([]);
      this.leaderboardError.set(
        msg('over.boardFailed', 'Could not load the leaderboard. Please try again later.'),
      );
    } finally {
      // Only the live call may clear the flag: a superseded one resolving
      // second would otherwise report its successor's read as finished.
      if (sequence === this.loadSequence) {
        this.isLoadingLeaderboard.set(false);
      }
    }
  }
}
