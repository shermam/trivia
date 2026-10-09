import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { DEFAULT_TIME_LIMIT, TimeLimitOption, TriviaQuestion } from '../../models/question.model';
import { Quiz } from '../../models/quiz.model';
import { ConnectivityService } from '../../services/connectivity.service';
import {
  DAILY_FREE_GAME_LIMIT,
  DailyGameLimitService,
} from '../../services/daily-game-limit.service';
import { GameControllerService } from '../../services/game-controller.service';
import { QuizLoad, QuizService } from '../../services/quiz.service';
import { SubscriptionService } from '../../services/subscription.service';
import { IconComponent } from '../icon/icon.component';

/**
 * Which of the screen's five states is showing.
 *
 * One computed rather than a template chain, for the reason game-over's
 * `scoreAction` is one (`docs/app.md` §1.1): the order of the branches is
 * itself a decision, and a template test cannot reach it.
 */
type QuizView = 'loading' | 'notFound' | 'empty' | 'failed' | 'ready';

/** The picker's options, labelled in words — "No limit" is what is being chosen. */
const TIME_LIMIT_CHOICES: readonly { value: TimeLimitOption; label: string }[] = [
  { value: 15, label: '15 seconds' },
  { value: 30, label: '30 seconds' },
  { value: 'unlimited', label: 'No limit' },
];

/**
 * What the line under the picker says for each limit — every one of them, so
 * the line reserves the tallest and switching the limit moves nothing below it
 * (`CLAUDE.md` §4.4).
 *
 * It says what the setup screen's line says about a board, turned round: a
 * quiz has none, so the limit changes the pace and nothing else. A player who
 * learned that only at the results screen would have been misled by omission.
 */
const TIME_LIMIT_NOTES: Readonly<Record<string, string>> = {
  '15': '15 seconds a question. Quizzes are not ranked, so pick the pace that suits you.',
  '30': '30 seconds a question. Quizzes are not ranked, so pick the pace that suits you.',
  unlimited: 'No countdown. Quizzes are not ranked, so take all the time you need.',
};

/**
 * One curated quiz, ready to start (`FEAT-024`) — `/quiz/:quizId`.
 *
 * It shows what the quiz is, how many of its questions it can play, the time
 * limit to play them under, and Start, which hands the questions it already
 * holds to `GameControllerService.startQuiz` and the existing loop.
 *
 * **Bounded reads on arrival, none on Start** (`QuizService.load`): the quiz
 * by its id, then its questions — one query, or one get each when one of them
 * can no longer be read. Reading the questions here rather than on the press
 * is what lets the page say *before* Start how many it will play — a question
 * deleted, withdrawn or no longer approved is skipped, and a ten-question quiz
 * that plays eight says so first.
 *
 * **Never a blank page.** An address naming no published quiz renders a
 * not-found state inside the app shell, a quiz with nothing playable says so
 * instead of starting, and a failed read offers a retry — offline included,
 * where a quiz cannot be loaded at all and the page says that rather than
 * failing quietly.
 */
@Component({
  selector: 'app-quiz-detail',
  standalone: true,
  imports: [RouterLink, IconComponent],
  templateUrl: './quiz-detail.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuizDetailComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly quizService = inject(QuizService);
  protected readonly gameController = inject(GameControllerService);
  protected readonly dailyLimit = inject(DailyGameLimitService);
  protected readonly subscriptionService = inject(SubscriptionService);
  protected readonly connectivity = inject(ConnectivityService);

  protected readonly dailyGameLimit = DAILY_FREE_GAME_LIMIT;
  protected readonly timeLimitChoices = TIME_LIMIT_CHOICES;
  protected readonly timeLimitNotes = TIME_LIMIT_CHOICES.map((choice) => ({
    value: choice.value,
    text: TIME_LIMIT_NOTES[String(choice.value)],
  }));

  /**
   * The heading, focused when a retry starts — see `retry()`. Rendered in
   * every state, which is what makes a plain `focus()` in the click handler
   * correct: nothing about it depends on the binding that is changing.
   */
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  private readonly loadSignal = signal<QuizLoad | null>(null);
  private readonly failedSignal = signal(false);

  /**
   * Which read is current. A second address can be opened before the first
   * answers — the component is reused between two quizzes' links — and the
   * slower answer must not overwrite the newer one.
   */
  private readSequence = 0;

  /** The id the screen was last asked for, for `retry()`. */
  private quizId = '';

  /** The time limit Start will use: the quiz's suggestion until the player picks one. */
  protected readonly timeLimit = signal<TimeLimitOption>(DEFAULT_TIME_LIMIT);

  /** Set when Start was pressed and the game did not begin for a reason other than the allowance. */
  protected readonly startError = signal('');

  /**
   * Whether a game was already in progress when the quiz was read — captured
   * then, not read live. Start commits the quiz's own game before the play
   * screen has loaded, so a live `hasResumableGame()` turns true while Start
   * says "Starting…", and the warning arriving at that moment moved Start a
   * line down under the pointer (`CLAUDE.md` §4.4): 24px at 1024 wide and
   * 44px at 390, measured by `curated-quiz.spec.ts`.
   */
  protected readonly replacesGame = signal(false);

  protected readonly view = computed<QuizView>(() => {
    if (this.failedSignal()) {
      return 'failed';
    }
    const load = this.loadSignal();
    if (load === null) {
      return 'loading';
    }
    switch (load.kind) {
      case 'notFound':
        return 'notFound';
      case 'empty':
        return 'empty';
      case 'ready':
        return 'ready';
    }
  });

  /** The quiz the screen is about, once one has been found. */
  protected readonly quiz = computed<Quiz | null>(() => {
    const load = this.loadSignal();
    return load && load.kind !== 'notFound' ? load.quiz : null;
  });

  private readonly questions = computed<TriviaQuestion[]>(() => {
    const load = this.loadSignal();
    return load?.kind === 'ready' ? load.questions : [];
  });

  protected readonly playableCount = computed(() => this.questions().length);

  /** How many of the quiz's questions will be left out, and the quiz's own length. */
  protected readonly unavailable = computed(() => {
    const load = this.loadSignal();
    return load?.kind === 'ready' && load.unavailable > 0
      ? { count: load.unavailable, total: load.quiz.questionIds.length }
      : null;
  });

  /** The page heading, in every state — the quiz's own title once there is one. */
  protected readonly title = computed(() => {
    switch (this.view()) {
      case 'loading':
        return 'Loading quiz…';
      case 'notFound':
        return 'Quiz not found';
      case 'failed':
        return 'This quiz could not be loaded';
      default:
        return this.quiz()?.title ?? '';
    }
  });

  /** The curator's suggested limit, in words, when the quiz carries one. */
  protected readonly suggestion = computed(() => {
    const suggested = this.quiz()?.suggestedTimeLimit;
    if (suggested === undefined || suggested === null) {
      return null;
    }
    return TIME_LIMIT_CHOICES.find((choice) => choice.value === suggested)?.label ?? null;
  });

  /**
   * What the live region says when the read lands — short, and not the
   * sentence on screen, so a screen reader is not read the same paragraph
   * twice (`CLAUDE.md` §4.5). Empty while loading: "loading" is not an outcome.
   */
  protected readonly announcement = computed(() => {
    switch (this.view()) {
      case 'ready':
        return `Quiz ready: ${this.countLabel(this.playableCount())}.`;
      case 'empty':
        return "None of this quiz's questions can be played right now.";
      case 'notFound':
        return 'Quiz not found.';
      case 'failed':
        return 'The quiz could not be loaded.';
      default:
        return '';
    }
  });

  ngOnInit(): void {
    void this.dailyLimit.refresh();
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      this.quizId = params.get('quizId') ?? '';
      void this.read();
    });
  }

  protected countLabel(count: number): string {
    return count === 1 ? '1 question' : `${count} questions`;
  }

  protected chooseTimeLimit(value: TimeLimitOption): void {
    this.timeLimit.set(value);
  }

  /**
   * Re-runs a read that failed — the only action the failed state offers.
   *
   * **Focus moves before the read starts**, because starting it is what hides
   * the button that was pressed: focus left on an element that goes away drops
   * silently to `<body>` (`CLAUDE.md` §4.4). The heading is on screen in every
   * state and is what answers the retry.
   */
  protected retry(): void {
    this.heading()?.nativeElement.focus();
    void this.read();
  }

  /**
   * Starts the quiz with the questions this screen already read, under the
   * limit the player picked.
   *
   * A refusal because the day's allowance is spent is the controller's
   * `limitReached`, which swaps Start for the offer; anything else is said
   * here, generically, since nothing has established its cause.
   */
  protected async start(): Promise<void> {
    const quiz = this.quiz();
    const questions = this.questions();
    if (!quiz || questions.length === 0 || this.gameController.isLoading()) {
      return;
    }
    this.startError.set('');
    const started = await this.gameController.startQuiz(
      { id: quiz.id, title: quiz.title },
      questions,
      this.timeLimit(),
    );
    if (!started && !this.gameController.limitReached()) {
      this.startError.set('The quiz could not start. Please try again.');
    }
  }

  private async read(): Promise<void> {
    const sequence = ++this.readSequence;
    this.loadSignal.set(null);
    this.failedSignal.set(false);
    this.startError.set('');

    let load: QuizLoad | null = null;
    let failed = false;
    try {
      load = await this.quizService.load(this.quizId);
    } catch (error) {
      // A failed read is not "no such quiz": telling somebody a quiz does not
      // exist on the strength of a read that never answered is the false
      // narration `CLAUDE.md` §4.4 forbids. The console keeps the cause.
      failed = true;
      console.error('[quiz] could not load the quiz', error);
    }

    if (sequence !== this.readSequence) {
      return;
    }
    if (load?.kind === 'ready') {
      // The suggestion pre-selects; it never locks. The picker below stays
      // free to change, `unlimited` included (WCAG 2.2.1, `CLAUDE.md` §4.5).
      this.timeLimit.set(load.quiz.suggestedTimeLimit ?? DEFAULT_TIME_LIMIT);
    }
    this.replacesGame.set(this.gameController.hasResumableGame());
    this.loadSignal.set(load);
    this.failedSignal.set(failed);
  }
}
