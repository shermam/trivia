import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
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
import { TriviaCategory, TriviaService } from '../../services/trivia.service';
import { TAG_SUGGESTIONS } from '../../utils/tag-suggestions';
import { IconComponent } from '../icon/icon.component';
import { LogoComponent } from '../logo/logo.component';
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

@Component({
  selector: 'app-game-setup',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, IconComponent, LogoComponent, TagSelectorComponent],
  templateUrl: './game-setup.component.html',
  styleUrl: './game-setup.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameSetupComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly triviaService = inject(TriviaService);
  protected readonly gameController = inject(GameControllerService);
  protected readonly subscriptionService = inject(SubscriptionService);
  protected readonly connectivity = inject(ConnectivityService);
  protected readonly offlineQuestions = inject(OfflineQuestionsService);
  protected readonly dailyLimit = inject(DailyGameLimitService);

  protected readonly dailyGameLimit = DAILY_FREE_GAME_LIMIT;

  protected readonly categories = signal<TriviaCategory[]>([]);
  protected readonly categoriesError = signal<string | null>(null);

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

  protected readonly form = this.fb.nonNullable.group({
    // Max 25, matching the options actually offered below. It was 50, which
    // no UI path could produce — and `firestore.rules` now caps a leaderboard
    // entry's totalQuestions at 25, so the two must agree or a tampered form
    // would produce a game whose score can never be saved.
    amount: [10, [Validators.required, Validators.min(5), Validators.max(25)]],
    category: [''],
    difficulty: [''],
    source: ['open_trivia' as GameConfig['source'], Validators.required],
    timeLimit: [DEFAULT_TIME_LIMIT as TimeLimitOption, Validators.required],
    // The topic filter (`FEAT-021`). A form control like every other setting,
    // so `form.getRawValue()` is still the whole of what the player chose.
    tags: this.fb.nonNullable.control<string[]>([]),
  });

  /**
   * How many topics one game may filter on.
   *
   * Firestore refuses an `array-contains-any` past 30 values outright, and the
   * query builder clamps at ten — so this number and
   * `MAX_TAG_FILTER_VALUES` have to agree, or the picker would offer a
   * selection the draw silently trims. The service is the authority; this is
   * the picker being told.
   */
  protected readonly maxFilterTags = MAX_TAG_FILTER_VALUES;

  protected readonly tagSuggestions = TAG_SUGGESTIONS;

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

  /** Mirrors the source control, for the two computed values below. */
  private readonly source = signal<GameConfig['source']>('open_trivia');

  /**
   * Why the topic filter is unavailable right now, or `null`.
   *
   * Two states, and both are the reader's to change, which is why each says so
   * rather than leaving a greyed-out box to be interpreted:
   *
   * - **Offline.** The offline pool is whatever was cached; it stores no tags
   *   and cannot be queried by one, so a selection would be silently ignored.
   * - **Open Trivia DB.** Only the community bank carries tags. Accepting a
   *   selection here and drawing an unfiltered game anyway is the worse
   *   failure, because nothing on screen would contradict it.
   */
  protected readonly tagFilterDisabledReason = computed(() => {
    if (!this.connectivity.isOnline()) {
      return 'Offline games play from the saved pool, which cannot be filtered by topic.';
    }
    if (this.source() === 'open_trivia') {
      return 'Only community questions carry topics. Switch to Custom or Mixed to filter by one.';
    }
    return null;
  });

  /** Says what a topic filter will and will not narrow, for the source in play. */
  protected readonly tagFilterHint = computed(() =>
    this.source() === 'mixed'
      ? 'Narrows the community half of the game; Open Trivia questions carry no topics.'
      : 'Pick topics to play questions about exactly those subjects.',
  );

  // Synchronous on purpose — see the note on AddQuestionComponent.ngOnInit.
  ngOnInit(): void {
    void this.loadCategories();
    void this.dailyLimit.refresh();
    this.form.controls.timeLimit.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((value) => this.timeLimit.set(value));
    this.form.controls.source.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((value) => this.source.set(value));
    // Any edit at all withdraws the short-draw message, because it and the
    // Start button's "Play {n} Questions" label describe the draw made for the
    // *previous* selection. `startGame` would already redraw rather than apply
    // a held draw to a changed selection — this is so the button stops
    // promising the old number in the meantime. `valueChanges` and not the
    // individual controls: the count, the category, the difficulty and the
    // topics all change what a draw would return.
    this.form.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.gameController.clearShortDrawNotice());
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

  private async loadCategories(): Promise<void> {
    try {
      const categories = await this.triviaService.getCategories();
      this.categories.set(categories);
    } catch {
      this.categoriesError.set(
        'Could not load categories from Open Trivia DB. You can still start with "Any Category".',
      );
    }
  }

  onSubmit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const raw = this.form.getRawValue();
    const config: GameConfig = {
      amount: raw.amount,
      category: raw.category,
      difficulty: raw.difficulty as GameConfig['difficulty'],
      source: raw.source,
      timeLimit: raw.timeLimit,
      // Dropped entirely when the filter is unavailable, rather than sent and
      // ignored: an offline draw and an Open Trivia draw both have nothing to
      // match it against, and a config carrying a filter that did not apply is
      // a config that says something untrue about the game it produced —
      // including in the saved snapshot a resume reads back.
      ...(this.tagFilterDisabledReason() || raw.tags.length === 0 ? {} : { tags: raw.tags }),
    };

    void this.gameController.startGame(config);
  }
}
