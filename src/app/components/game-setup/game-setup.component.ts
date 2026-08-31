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
import { Router, RouterLink } from '@angular/router';
import { DEFAULT_TIME_LIMIT, GameConfig, TimeLimitOption } from '../../models/question.model';
import { ConnectivityService } from '../../services/connectivity.service';
import {
  DAILY_FREE_GAME_LIMIT,
  DailyGameLimitService,
} from '../../services/daily-game-limit.service';
import { GameControllerService } from '../../services/game-controller.service';
import { OfflineQuestionsService } from '../../services/offline-questions.service';
import { SubscriptionService } from '../../services/subscription.service';
import { TriviaCategory, TriviaService } from '../../services/trivia.service';
import { IconComponent } from '../icon/icon.component';
import { LogoComponent } from '../logo/logo.component';

@Component({
  selector: 'app-game-setup',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, IconComponent, LogoComponent],
  templateUrl: './game-setup.component.html',
  styleUrl: './game-setup.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameSetupComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly triviaService = inject(TriviaService);
  protected readonly gameController = inject(GameControllerService);
  protected readonly subscriptionService = inject(SubscriptionService);
  protected readonly connectivity = inject(ConnectivityService);
  protected readonly offlineQuestions = inject(OfflineQuestionsService);
  protected readonly dailyLimit = inject(DailyGameLimitService);

  protected readonly dailyGameLimit = DAILY_FREE_GAME_LIMIT;

  protected readonly categories = signal<TriviaCategory[]>([]);
  protected readonly categoriesError = signal<string | null>(null);

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
  });

  /**
   * The picker's options. Labelled in words rather than as raw values —
   * "No limit" is what the player is choosing; `'unlimited'` is what the
   * leaderboard path calls it.
   */
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

  // Synchronous on purpose — see the note on AddQuestionComponent.ngOnInit.
  ngOnInit(): void {
    void this.loadCategories();
    void this.dailyLimit.refresh();
    this.form.controls.timeLimit.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((value) => this.timeLimit.set(value));
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
    };

    void this.gameController.startGame(config);
  }
}
