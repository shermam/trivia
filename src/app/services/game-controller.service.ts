import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { GameConfig, TriviaQuestion } from '../models/question.model';
import { giveUpAfter } from '../utils/give-up-after.util';
import { GamePersistenceService } from './game-persistence.service';
import { TriviaService } from './trivia.service';

/**
 * Upper bound on how long bootstrap waits for the saved game to load. Generous
 * for an IndexedDB read of one record (typically single-digit milliseconds),
 * and short enough that a wedged store costs a barely-perceptible pause rather
 * than a blank page.
 */
const RESTORE_TIMEOUT_MS = 2000;

/**
 * Holds all in-progress game state so it survives navigation between the setup,
 * quiz, and game-over screens — and, since B8, a reload as well.
 *
 * The state used to live only in these signals, so a refresh, a tab crash or a
 * PWA relaunch dropped a game mid-way with no way back. That is worst for
 * precisely the players offline support exists for. It is now mirrored into
 * IndexedDB (`GamePersistenceService`) and read back by `restoreSavedGame()`,
 * which an app initializer awaits before the first route activates.
 */
@Injectable({ providedIn: 'root' })
export class GameControllerService {
  private readonly triviaService = inject(TriviaService);
  private readonly persistence = inject(GamePersistenceService);
  private readonly router = inject(Router);

  readonly config = signal<GameConfig | null>(null);
  readonly questions = signal<TriviaQuestion[]>([]);
  readonly currentIndex = signal(0);
  readonly score = signal(0);
  readonly isLoading = signal(false);
  readonly loadError = signal<string | null>(null);
  /** True once the final question has been answered — i.e. the player belongs on `/game-over`. */
  readonly isComplete = signal(false);

  /**
   * Questions the player flagged while playing, to be reported once the game
   * is over. Held here rather than in the quiz component because it has to
   * outlive that component — the whole point is that the flag survives the
   * question auto-advancing and turns up again on `/game-over` — and because
   * it belongs in the persisted snapshot, so a reload mid-game doesn't
   * silently drop it.
   */
  readonly flaggedQuestionIds = signal<ReadonlySet<string>>(new Set());

  /** Tail of the serialized persistence chain — see `enqueueWrite`. */
  private writeQueue: Promise<void> = Promise.resolve();

  readonly totalQuestions = computed(() => this.questions().length);
  readonly currentQuestion = computed<TriviaQuestion | null>(
    () => this.questions()[this.currentIndex()] ?? null,
  );
  readonly isLastQuestion = computed(() => this.currentIndex() >= this.totalQuestions() - 1);
  /** Accuracy: how many were answered correctly. Shown on the game-over screen. */
  readonly percentage = computed(() =>
    this.totalQuestions() === 0 ? 0 : Math.round((this.score() / this.totalQuestions()) * 100),
  );

  /**
   * How far through the quiz the player is — *position*, not accuracy. Drives
   * the bar under the quiz header, and deliberately agrees with the "Question
   * N / M" label beside it: on question 1 of 10 both say 1 of 10, and on the
   * last question the bar is full.
   *
   * `currentIndex` is zero-based, so it counts the questions *behind* you. The
   * bar used it directly and was a question out at every step: 0% while
   * looking at the first question, and 90% on the last of ten — it could never
   * fill, because `advanceQuestion()` navigates away instead of incrementing
   * past the end.
   */
  readonly progressPercentage = computed(() =>
    this.totalQuestions() === 0
      ? 0
      : Math.round(((this.currentIndex() + 1) / this.totalQuestions()) * 100),
  );

  /**
   * A game the player could pick up again: loaded, not finished. Drives the
   * resume banner on the setup screen, which is what covers the case a reload
   * cannot — a PWA relaunch or a tap on the logo opens at `/`, not at `/play`,
   * so without this the saved game would sit in storage unreachable.
   *
   * A *completed* game is deliberately excluded. It is still persisted, so
   * refreshing `/game-over` keeps the score you are about to submit, but
   * offering to "resume" it would send the player back to replay the final
   * question and score it twice.
   */
  readonly hasResumableGame = computed(() => this.totalQuestions() > 0 && !this.isComplete());

  constructor() {
    // Mirrors the game into storage on every change. An effect rather than a
    // write at each mutation site: there are five of them across three
    // screens, and the one that gets forgotten is the one that loses the game.
    effect(() => {
      const questions = this.questions();
      const config = this.config();

      if (questions.length === 0 || !config) {
        return;
      }

      const snapshot = {
        config,
        questions,
        currentIndex: this.currentIndex(),
        score: this.score(),
        isComplete: this.isComplete(),
        flaggedQuestionIds: [...this.flaggedQuestionIds()],
      };
      this.enqueueWrite(() => this.persistence.save(snapshot));
    });
  }

  /**
   * Reads a saved game back into the signals.
   *
   * Awaited by an app initializer (`app.config.ts`) rather than called from the
   * constructor, because the store is asynchronous while the thing that depends
   * on it is not: `/play` and `/game-over` both redirect to `/` the moment they
   * find no question in memory, so a restore that resolved after the route
   * activated would bounce the player off the screen they were returning to.
   * Blocking bootstrap makes the guards correct without them having to know
   * anything about storage.
   *
   * Never rejects, and never waits indefinitely. Bootstrap is the one place
   * where a hung read would cost the whole app rather than one feature, and a
   * browser that cannot open IndexedDB at all (Safari private mode) must still
   * get a working game — just one that won't survive a reload.
   */
  async restoreSavedGame(): Promise<void> {
    const saved = await giveUpAfter(this.persistence.load(), RESTORE_TIMEOUT_MS).catch(() => null);
    if (!saved) {
      return;
    }

    this.config.set(saved.config);
    this.questions.set(saved.questions);
    this.currentIndex.set(saved.currentIndex);
    this.score.set(saved.score);
    this.isComplete.set(saved.isComplete);
    this.flaggedQuestionIds.set(new Set(saved.flaggedQuestionIds));
  }

  /**
   * Flags or unflags a question mid-game. A toggle, not a one-way action:
   * this is a single click next to the answers while a countdown runs, so
   * undoing a misclick has to be as cheap as making it.
   */
  toggleQuestionFlag(questionId: string): void {
    this.flaggedQuestionIds.update((flagged) => {
      const next = new Set(flagged);
      if (!next.delete(questionId)) {
        next.add(questionId);
      }
      return next;
    });
  }

  /** Throws away a saved game the player has said they don't want to resume. */
  discardSavedGame(): void {
    this.clearGameState();
    this.enqueueWrite(() => this.persistence.clear());
  }

  /**
   * Serializes writes. Each one persists a whole snapshot rather than a delta,
   * so ordering is the only thing that matters — and unordered async writes
   * could land a stale snapshot on top of a fresh one, leaving a resumed game a
   * question behind. Chaining also means a failure never rejects into an
   * effect, where nothing is listening.
   */
  private enqueueWrite(write: () => Promise<void>): void {
    this.writeQueue = this.writeQueue.then(write).catch(() => undefined);
  }

  /**
   * Resolves once every queued write has been applied.
   *
   * Nothing in the app awaits this — persistence is deliberately fire-and-forget
   * so playing never waits on a disk write. It exists so tests can assert on
   * what actually reached the store rather than on what was asked for, which is
   * the difference between testing the persistence and testing the queue.
   */
  flushPendingWrites(): Promise<void> {
    return this.writeQueue;
  }

  async startGame(config: GameConfig): Promise<void> {
    this.isLoading.set(true);
    this.loadError.set(null);

    try {
      const questions = await this.triviaService.getQuestions(config);

      if (questions.length === 0) {
        this.loadError.set(
          'No questions were found for the selected options. Try a different category, difficulty, or source.',
        );
        return;
      }

      this.config.set(config);
      this.questions.set(questions);
      this.currentIndex.set(0);
      this.score.set(0);
      this.isComplete.set(false);
      await this.router.navigateByUrl('/play');
    } catch {
      this.loadError.set('Failed to load questions. Please check your connection and try again.');
    } finally {
      this.isLoading.set(false);
    }
  }

  registerAnswer(isCorrect: boolean): void {
    if (isCorrect) {
      this.score.update((value) => value + 1);
    }
  }

  advanceQuestion(): void {
    if (this.isLastQuestion()) {
      this.isComplete.set(true);
      void this.router.navigateByUrl('/game-over');
      return;
    }
    this.currentIndex.update((value) => value + 1);
  }

  resetGame(): void {
    this.discardSavedGame();
    void this.router.navigateByUrl('/');
  }

  private clearGameState(): void {
    this.config.set(null);
    this.questions.set([]);
    this.currentIndex.set(0);
    this.score.set(0);
    this.isComplete.set(false);
    this.loadError.set(null);
    this.flaggedQuestionIds.set(new Set());
  }
}
