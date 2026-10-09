import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DEFAULT_TIME_LIMIT, GameConfig, TimeLimitOption } from '../../models/question.model';
import { ConnectivityService } from '../../services/connectivity.service';
import {
  DAILY_FREE_GAME_LIMIT,
  DailyGameLimitService,
} from '../../services/daily-game-limit.service';
import { MAX_TAG_FILTER_VALUES } from '../../services/firebase.service';
import { GameControllerService } from '../../services/game-controller.service';
import { OfflineQuestionsService } from '../../services/offline-questions.service';
import { SubscriptionService } from '../../services/subscription.service';
import { SEED_TAGS, firstSeedTag } from '../../utils/category-tags';
import { IconComponent } from '../icon/icon.component';
import { LogoComponent } from '../logo/logo.component';
import { QuizListComponent } from '../quiz-list/quiz-list.component';
import { TagSelectorComponent } from '../tag-selector/tag-selector.component';

/** What `createDonationSession` sends the browser back to `/` carrying. */
type DonationQueryStatus = 'success' | 'cancelled' | null;

/**
 * That value if it is one of the two the redirect can carry, and `null`
 * otherwise.
 *
 * Narrowed rather than cast: the query string is whatever the address bar
 * says, so a cast would let `?donation=anything` through typed as a state the
 * template then has to render — a runtime type only one consumer checks is a
 * type nobody checks (`CLAUDE.md` §4.4).
 */
function donationStatusFrom(value: string | null): DonationQueryStatus {
  return value === 'success' || value === 'cancelled' ? value : null;
}

/**
 * What the topic picker says the selection will do, per source (`FEAT-052`).
 *
 * Constants rather than literals in a `computed` because every one is needed
 * twice over: once as the hint that is showing, and once in the set the picker
 * reserves the line's height against. A Mixed game's hint names the topic its
 * Open Trivia half follows, so that one is a function — and every value it can
 * take is in {@link TOPIC_HINT_VARIANTS}, one per seed tag.
 */
const TOPIC_HINTS = {
  openTrivia: 'Pick one of the suggested topics, or none to play every topic.',
  custom: 'Pick topics to play questions about exactly those subjects.',
  mixedEmpty: 'Pick topics to narrow the community half; a suggested one narrows Open Trivia too.',
  mixedUnseeded:
    'Community questions match any of these; Open Trivia ones cover every topic until you add a suggested one.',
  mixedSeeded: (tag: string) =>
    `Community questions match any of these; Open Trivia ones follow #${tag}.`,
} as const;

/** Every hint the picker can be given, so it reserves the tallest (`CLAUDE.md` §4.4). */
const TOPIC_HINT_VARIANTS: readonly string[] = [
  TOPIC_HINTS.openTrivia,
  TOPIC_HINTS.custom,
  TOPIC_HINTS.mixedEmpty,
  TOPIC_HINTS.mixedUnseeded,
  ...SEED_TAGS.map(TOPIC_HINTS.mixedSeeded),
];

/**
 * What the feedback line says about an Open Trivia game's one rule: it plays a
 * seed tag or nothing. The first refuses a typed tag; the other two say what
 * switching into the source removed.
 */
const OPEN_TRIVIA_TOPIC_MESSAGES = {
  notAllowed: 'Open Trivia plays only the suggested topics — Custom and Mixed take any.',
  keptOne: 'Open Trivia plays one suggested topic, so the others were removed.',
  keptNone: 'Open Trivia plays only the suggested topics, so yours were removed.',
} as const;

/** What the resume banner says about the game it offers. */
interface ResumeOffer {
  /** The question the saved game is on, counted from one. */
  question: number;
  /** How many questions it has. */
  total: number;
}

/** `#a`, `#a and #b`, `#a, #b and #c` — for the live region, which has room for the names. */
function listTags(tags: readonly string[]): string {
  const named = tags.map((tag) => `#${tag}`);
  return named.length <= 1
    ? (named[0] ?? '')
    : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}

@Component({
  selector: 'app-game-setup',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    IconComponent,
    LogoComponent,
    QuizListComponent,
    TagSelectorComponent,
  ],
  templateUrl: './game-setup.component.html',
  styleUrl: './game-setup.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameSetupComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly gameController = inject(GameControllerService);
  protected readonly subscriptionService = inject(SubscriptionService);
  protected readonly connectivity = inject(ConnectivityService);
  protected readonly offlineQuestions = inject(OfflineQuestionsService);
  protected readonly dailyLimit = inject(DailyGameLimitService);

  protected readonly dailyGameLimit = DAILY_FREE_GAME_LIMIT;

  /**
   * Where Stripe sent the reader back from a donation, if that is why they are
   * here — `/?donation=success` or `/?donation=cancelled`, the same shape
   * `/pricing` already uses for a subscription.
   *
   * Read once from the snapshot, at construction, for two reasons. It is only
   * ever meaningful on the initial landing rather than on later in-app
   * navigation; and reading it before the first paint is what makes the banner
   * part of the first frame instead of something that appears a beat later and
   * pushes the card down (`CLAUDE.md` §4.4). Dismissing it is a deliberate act
   * by the reader, which is the one case a resize is theirs to expect.
   */
  protected readonly donationStatus = signal<DonationQueryStatus>(
    donationStatusFrom(this.route.snapshot.queryParamMap.get('donation')),
  );

  /**
   * The game the resume banner offers, or `null` — read live, except while a
   * start is in flight, when it holds whatever it said as Start was pressed.
   *
   * **A start commits its game before the screen changes.** `startGame` calls
   * `beginGame` and then navigates, and `/play` is a lazy route, so for as long
   * as its chunk takes to download this screen is still up with a game in
   * memory that is loaded and unfinished — exactly what `hasResumableGame()`
   * means. Read live, the banner would arrive for the very game being
   * started, growing the card 122px and lifting its top 61px under the pointer
   * that had just pressed Start, at 390 and 1280 wide alike (`CLAUDE.md` §4.4).
   *
   * **Hidden while loading would be the same shift the other way round.** A
   * player starting a new game over a saved one is looking at the banner when
   * they press Start, and it vanishing would pull the card up by as much. So it
   * holds instead, sentence and all — still naming the game that was in
   * progress, which is the last thing it was true about — until the start ends:
   * the route changes and takes the screen with it, or the start fails or is
   * refused and the banner says whatever is then true. `game-resume.spec.ts`
   * measures both with `/play`'s chunk held.
   */
  protected readonly resumeOffer = linkedSignal<
    { starting: boolean; offer: ResumeOffer | null },
    ResumeOffer | null
  >({
    source: () => ({
      starting: this.gameController.isLoading(),
      offer: this.gameController.hasResumableGame()
        ? {
            question: this.gameController.currentIndex() + 1,
            total: this.gameController.totalQuestions(),
          }
        : null,
    }),
    computation: (source, previous) =>
      source.starting && previous ? previous.value : source.offer,
  });

  protected readonly form = this.fb.nonNullable.group({
    // Max 25, matching the options actually offered below. It was 50, which
    // no UI path could produce — and `firestore.rules` now caps a leaderboard
    // entry's totalQuestions at 25, so the two must agree or a tampered form
    // would produce a game whose score can never be saved.
    amount: [10, [Validators.required, Validators.min(5), Validators.max(25)]],
    difficulty: [''],
    source: ['open_trivia' as GameConfig['source'], Validators.required],
    timeLimit: [DEFAULT_TIME_LIMIT as TimeLimitOption, Validators.required],
    // The topic picker (`FEAT-021`, `FEAT-052`) — the game's only topic choice
    // since the category picker went. A form control like every other setting,
    // so `form.getRawValue()` is still the whole of what the player chose.
    tags: this.fb.nonNullable.control<string[]>([]),
  });

  /** The picker, for the one change it cannot see coming: a source that takes fewer topics. */
  private readonly topicPicker = viewChild(TagSelectorComponent);

  /**
   * What the picker suggests: the seed tags, Open Trivia DB's former
   * categories, because they are the only tags that narrow **both** sources —
   * which makes them the only ones every source can be offered. Any other tag
   * can still be typed for a Custom or Mixed game.
   */
  protected readonly seedTags = SEED_TAGS;

  protected readonly topicHintVariants = TOPIC_HINT_VARIANTS;
  protected readonly topicNotAllowedMessage = OPEN_TRIVIA_TOPIC_MESSAGES.notAllowed;
  protected readonly topicFeedbackVariants = Object.values(OPEN_TRIVIA_TOPIC_MESSAGES);

  /**
   * The picker's options. Labelled in words rather than as raw values —
   * "No limit" is what the player is choosing; `'unlimited'` is what the
   * leaderboard path calls it.
   */
  protected dismissDonationStatus(): void {
    this.donationStatus.set(null);
    void this.router.navigate([], { queryParams: {}, replaceUrl: true });
  }

  protected readonly timeLimitOptions: { value: TimeLimitOption; label: string }[] = [
    { value: 15, label: '15 seconds' },
    { value: 30, label: '30 seconds' },
    { value: 'unlimited', label: 'No limit' },
  ];

  /**
   * Names the leaderboard the chosen limit ranks on, before the game starts.
   *
   * Each timing constraint has its own board, because a score won with no
   * clock is not comparable to one won in 15 seconds. A player who only finds
   * that out at game over has been misled by omission, which is why this sits
   * under the picker rather than on the results screen.
   */
  protected readonly timeLimitNote = computed(() => {
    const chosen = this.timeLimit();
    return chosen === 'unlimited'
      ? 'No countdown. Ranks on the separate no-limit leaderboard.'
      : `Ranks on the ${chosen}-second leaderboard — each time limit has its own.`;
  });

  /** Mirrors the form control into a signal so `timeLimitNote` recomputes. */
  private readonly timeLimit = signal<TimeLimitOption>(DEFAULT_TIME_LIMIT);

  /** Mirrors the source control, for the computed values below. */
  private readonly source = signal<GameConfig['source']>('open_trivia');

  /** Mirrors the topic selection, for the hint that names what Open Trivia follows. */
  private readonly selectedTopics = signal<readonly string[]>([]);

  /**
   * How many topics this source can be asked for (`FEAT-052` §0).
   *
   * **One for Open Trivia alone**, because its API takes one `category` per
   * request and refuses a second request inside five seconds — so the picker
   * offers exactly the choice the category `<select>` it replaced did, and at
   * one it is a single choice: picking another seed tag swaps it in. **Ten
   * otherwise**, which is `MAX_TAG_FILTER_VALUES`: Firestore refuses an
   * `array-contains-any` past thirty values outright and the query builder
   * clamps at ten, so the two have to agree or the picker would offer a
   * selection the draw silently trims. The service is the authority; this is
   * the picker being told.
   */
  protected readonly topicLimit = computed(() =>
    this.source() === 'open_trivia' ? 1 : MAX_TAG_FILTER_VALUES,
  );

  /**
   * The only topics this source can play, or `null` for any. An Open Trivia
   * game can be asked for a seed tag and nothing else, so a typed topic outside
   * the set is refused with the reason rather than accepted and ignored.
   */
  protected readonly allowedTopics = computed(() =>
    this.source() === 'open_trivia' ? SEED_TAGS : null,
  );

  /**
   * What the selection will do, for the source in play. A Mixed game's says
   * which topic its Open Trivia half follows — the first seed tag selected — or
   * that it covers every topic until there is one, which is the draw a player
   * would otherwise only discover after Start.
   */
  protected readonly topicHint = computed(() => {
    switch (this.source()) {
      case 'open_trivia':
        return TOPIC_HINTS.openTrivia;
      case 'custom':
        return TOPIC_HINTS.custom;
      case 'mixed': {
        const topics = this.selectedTopics();
        if (topics.length === 0) {
          return TOPIC_HINTS.mixedEmpty;
        }
        const followed = firstSeedTag(topics);
        return followed === null ? TOPIC_HINTS.mixedUnseeded : TOPIC_HINTS.mixedSeeded(followed);
      }
    }
  });

  // Angular calls `ngOnInit` and discards whatever it returns, so an `async`
  // one would let a rejection escape unhandled rather than be reported. Kept
  // synchronous, with the async work started explicitly.
  ngOnInit(): void {
    void this.dailyLimit.refresh();
    this.form.controls.timeLimit.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((value) => this.timeLimit.set(value));
    this.form.controls.source.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((value) => {
        this.source.set(value);
        this.fitTopicsTo(value);
      });
    this.form.controls.tags.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((value) => this.selectedTopics.set(value));
    // Any edit at all withdraws the short-draw message, because it and the
    // Start button's "Play {n} Questions" label describe the draw made for the
    // *previous* selection. `startGame` would already redraw rather than apply
    // a held draw to a changed selection — this is so the button stops
    // promising the old number in the meantime. `valueChanges` and not the
    // individual controls: the count, the source, the difficulty and the
    // topics all change what a draw would return.
    this.form.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.gameController.clearShortDrawNotice());
  }

  /**
   * Fits the selection to the source just chosen, and says what that removed.
   *
   * **Switching into Open Trivia keeps the selection's first seed tag and
   * removes the rest** (`FEAT-052` §0): it is the one topic the API could be
   * asked for, and the first is the reader's own order. The feedback line says
   * what happened and the live region names what went, through the picker,
   * which says it the way it says every other change. With no seed tag
   * selected the selection empties, and says so.
   *
   * Leaving Open Trivia widens the choice and removes nothing, so all it does
   * is withdraw a notice about a rule that no longer applies.
   */
  private fitTopicsTo(source: GameConfig['source']): void {
    const picker = this.topicPicker();
    picker?.clearNotice();
    if (source !== 'open_trivia') {
      return;
    }
    const selected = this.form.controls.tags.value;
    const kept = firstSeedTag(selected);
    const removed = selected.filter((tag) => tag !== kept);
    if (removed.length === 0) {
      return;
    }
    const keptTags = kept === null ? [] : [kept];
    if (!picker) {
      this.form.controls.tags.setValue(keptTags);
      return;
    }
    picker.replaceSelection(
      keptTags,
      kept === null ? OPEN_TRIVIA_TOPIC_MESSAGES.keptNone : OPEN_TRIVIA_TOPIC_MESSAGES.keptOne,
      kept === null
        ? `Open Trivia plays only the suggested topics. Removed ${listTags(removed)}.`
        : `Open Trivia plays one suggested topic. Kept #${kept}; removed ${listTags(removed)}.`,
    );
  }

  /**
   * Returns to a game restored from storage. `GameControllerService` has
   * already rehydrated it, so this only has to navigate — the player lands back
   * on the question they were on, with a fresh timer (B8).
   */
  protected resumeGame(): void {
    void this.router.navigateByUrl('/play');
  }

  protected discardGame(): void {
    this.gameController.discardSavedGame();
  }

  onSubmit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const raw = this.form.getRawValue();
    const topics = this.topicsTheDrawUses(raw.source, raw.tags);
    const config: GameConfig = {
      amount: raw.amount,
      difficulty: raw.difficulty as GameConfig['difficulty'],
      source: raw.source,
      timeLimit: raw.timeLimit,
      // Absent when there are none, which is "any topic" — Start works with
      // nothing selected for every source, as it did on "Any Category".
      ...(topics.length === 0 ? {} : { tags: topics }),
    };

    void this.gameController.startGame(config);
  }

  /**
   * The topics the draw will actually use, which is all a config may record:
   * a config carrying a filter that did not apply says something untrue about
   * the game it produced — including in the saved snapshot a resume reads back.
   *
   * An Open Trivia game uses at most one seed tag, so that is all it records,
   * even if something left more in the control; a Custom or Mixed game uses
   * every topic, the community half filtering on all of them.
   */
  private topicsTheDrawUses(source: GameConfig['source'], tags: readonly string[]): string[] {
    if (source !== 'open_trivia') {
      return [...tags];
    }
    const followed = firstSeedTag(tags);
    return followed === null ? [] : [followed];
  }
}
