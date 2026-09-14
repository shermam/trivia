import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  ALL_LIFELINES_AVAILABLE,
  Answer,
  GameConfig,
  LifelineId,
  LifelineState,
  PickedAnswer,
  SKIPPED,
  TIMED_OUT,
  TriviaQuestion,
  answeredWith,
} from '../models/question.model';
import { displayScore, multiplierForStreak, pointsForStreak } from '../models/scoring';
import { giveUpAfter } from '../utils/give-up-after.util';
import { MAX_ANSWER_MS } from '../utils/play-history.util';
import { shuffleArray } from '../utils/shuffle.util';
import { DailyGameLimitService } from './daily-game-limit.service';
import { GamePersistenceService } from './game-persistence.service';
import { SeenQuestionsService } from './seen-questions.service';
import { TriviaService } from './trivia.service';

/**
 * Upper bound on how long bootstrap waits for the saved game to load. Generous
 * for an IndexedDB read of one record (typically single-digit milliseconds),
 * and short enough that a wedged store costs a barely-perceptible pause rather
 * than a blank page.
 */
const RESTORE_TIMEOUT_MS = 2000;

/**
 * How long a *route guard* waits for the restore, as opposed to how long
 * bootstrap does.
 *
 * Longer than the bootstrap bound on purpose. `giveUpAfter` stops waiting
 * without stopping the work, so when bootstrap gives up the read is still in
 * flight — and by the time a guard asks, it has almost always landed. This
 * bound exists only so a browser that can never open IndexedDB (Safari private
 * mode) cannot wedge navigation entirely.
 */
const GUARD_RESTORE_TIMEOUT_MS = 10_000;

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
  private readonly dailyLimit = inject(DailyGameLimitService);
  private readonly persistence = inject(GamePersistenceService);
  private readonly seenQuestions = inject(SeenQuestionsService);
  private readonly router = inject(Router);

  readonly config = signal<GameConfig | null>(null);
  readonly questions = signal<TriviaQuestion[]>([]);
  readonly currentIndex = signal(0);

  /**
   * The exact point total, multipliers included — the source of truth for the
   * score, and the only place a half point is ever allowed to exist.
   *
   * Half points are not a design choice, they are arithmetic: the 1.5× tier
   * applied to a one-point base produces one. They are kept exactly here and
   * rounded once, at {@link score}, so a reload cannot change a total by
   * restoring 4.5 as 5 and then earning another 1.5 on top of it.
   */
  readonly points = signal(0);

  /**
   * How many questions were answered correctly. What `percentage` is built
   * from, and what is banked as `correctAnswers` in the player's lifetime
   * totals.
   *
   * A separate count rather than something derived from `points`, because the
   * multiplier makes that derivation impossible: 3 points is three plain
   * answers or two at 1.5×. It used to *be* the score, which is exactly why
   * every consumer of "how many did I get right" had to be revisited when the
   * score stopped meaning that.
   */
  readonly correctAnswers = signal(0);

  /**
   * The run of consecutive correct answers, and the longest one this game
   * reached (`FEAT-004`).
   *
   * A wrong answer or a timeout resets the run; **a skip neither breaks nor
   * extends it**, which is the one rule here that cannot be derived from the
   * answer history afterwards — hence a tracked counter rather than a
   * recomputation on the results screen.
   */
  readonly currentStreak = signal(0);
  readonly maxStreak = signal(0);

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

  /**
   * What the player picked, per question, in order — an answer id, or `null`
   * for a timeout. Drives the game-over recap.
   *
   * Here rather than in the quiz component for the reasons `flaggedQuestionIds`
   * is: it has to outlive the component that produces it, since the whole
   * point is reading it on a different screen, and it belongs in the persisted
   * snapshot because refreshing `/game-over` is a supported thing to do — the
   * completed game is deliberately kept so the score survives, and a recap
   * that vanished on reload while the score stayed would be the same defect
   * one screen along.
   *
   * Positional, not keyed by question id: entry `i` answers question `i`. A map
   * would be robust to reordering that cannot happen inside a round, and would
   * lose the one property worth having — that a short history means an
   * unfinished game rather than a question nobody answered.
   */
  readonly answerHistory = signal<readonly PickedAnswer[]>([]);

  /**
   * How long each answered question took, in milliseconds, positionally beside
   * {@link answerHistory} — entry `i` is how long question `i` was on screen
   * before the player resolved it (`FEAT-049`).
   *
   * **A second array rather than a field on `PickedAnswer`**, because the two
   * have different shelf lives. `PickedAnswer` is restored from a save written
   * by an older build and validated against the questions it belongs to; a
   * duration has nothing to validate against and no meaning to an older build.
   * Keeping them apart means a save that predates this field restores its recap
   * intact and simply records no history for that game.
   *
   * Persisted for the reason the history is: refreshing mid-game is supported,
   * and a round whose durations were lost would be banked without any play
   * history at all (`buildPlayAnswers` requires one per question).
   */
  readonly answerDurations = signal<readonly number[]>([]);

  /**
   * Which lifelines this round still has (`FEAT-002`). Single-use each, so a
   * `true` becomes `false` and never comes back until the next game.
   *
   * On the service rather than in `QuizLoopComponent` for the same reason the
   * flags and the answer history are: it has to survive a reload. A lifeline
   * refunded by refreshing the page is not a lifeline, and the component is
   * destroyed and rebuilt on every navigation.
   */
  readonly lifelines = signal<LifelineState>(ALL_LIFELINES_AVAILABLE);

  /**
   * Answer ids 50/50 has removed from the question on screen, and **only** that
   * question — cleared by `advanceQuestion()` and by a skip.
   *
   * Persisted alongside the availability flags, because the pair has to move
   * together: restoring "50/50 is spent" while restoring four visible options
   * would take the lifeline and give nothing back.
   */
  readonly eliminatedAnswerIds = signal<readonly string[]>([]);

  /**
   * A per-game identity, minted when the game starts and carried in the
   * persisted snapshot.
   *
   * **The idempotency key for `recordGameResult`.** `/game-over` survives a
   * reload by design — the completed game is deliberately kept so the score
   * about to be submitted is not lost — and a callable that times out gets
   * retried. Both would otherwise bank the same game twice into the player's
   * lifetime totals, which a best-score `setDoc` tolerates and an increment
   * does not.
   *
   * Minted at game *start*, not at game over, and that is the whole point: an
   * id created on the results screen would be fresh on every reload, which is
   * exactly the duplicate it exists to prevent.
   *
   * `null` for a game restored from a save written before this field existed.
   * Those games are simply not banked — one lost game's totals, against the
   * alternative of minting an id lazily and inflating them on every refresh.
   */
  readonly gameId = signal<string | null>(null);

  /**
   * When the question on screen appeared, as the wall clock reads it.
   *
   * `null` until `markQuestionShown()` is called, which is the quiz screen's
   * job — it is the only thing that knows when a question is actually in front
   * of the player, and a timestamp taken in `advanceQuestion()` instead would
   * start counting during the answer-reveal delay and, for the first question,
   * during a route transition. While it is `null` a resolved question records a
   * duration of zero rather than a guess (`CLAUDE.md` §4.4: a value that is not
   * known defaults to the least alarming answer, not the most specific one).
   *
   * Not persisted: a reload restarts the countdown for the question on screen,
   * so restarting its clock is the same answer given consistently.
   */
  private questionShownAt: number | null = null;

  /** The single in-flight restore, so bootstrap and the guards await the same read. */
  private restorePromise: Promise<void> | null = null;

  /** Tail of the serialized persistence chain — see `enqueueWrite`. */
  private writeQueue: Promise<void> = Promise.resolve();

  readonly totalQuestions = computed(() => this.questions().length);
  readonly currentQuestion = computed<TriviaQuestion | null>(
    () => this.questions()[this.currentIndex()] ?? null,
  );
  readonly isLastQuestion = computed(() => this.currentIndex() >= this.totalQuestions() - 1);

  /**
   * The score as everything outside this service sees it: the point total,
   * rounded to the integer `firestore.rules` requires of a leaderboard entry.
   *
   * Rounded here rather than at the leaderboard write, so the number the
   * player watches climb during the game is the number that ends up on the
   * board. See `displayScore` for why that trade is the right way round.
   */
  readonly score = computed(() => displayScore(this.points()));

  /**
   * What the answer just scored is worth, as a multiple of the base — the
   * figure the in-game streak badge shows.
   */
  readonly scoreMultiplier = computed(() => multiplierForStreak(this.currentStreak()));

  /**
   * Accuracy: the share of questions answered correctly, never multiplied.
   *
   * Built from `correctAnswers` rather than from `score`, which is the whole
   * point of keeping the two apart — deriving it from a multiplied score would
   * publish figures above 100% onto a public board.
   */
  readonly percentage = computed(() =>
    this.totalQuestions() === 0
      ? 0
      : Math.round((this.correctAnswers() / this.totalQuestions()) * 100),
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
        points: this.points(),
        correctAnswers: this.correctAnswers(),
        currentStreak: this.currentStreak(),
        maxStreak: this.maxStreak(),
        isComplete: this.isComplete(),
        flaggedQuestionIds: [...this.flaggedQuestionIds()],
        answerHistory: [...this.answerHistory()],
        answerDurations: [...this.answerDurations()],
        lifelines: { ...this.lifelines() },
        eliminatedAnswerIds: [...this.eliminatedAnswerIds()],
        gameId: this.gameId(),
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
  restoreSavedGame(): Promise<void> {
    this.restorePromise ??= this.readAndApplySavedGame();
    // Bootstrap stops *waiting* here, but the read carries on — which is what
    // makes `whenRestoreSettled()` below worth awaiting rather than a second
    // chance at the same coin flip.
    return giveUpAfter(this.restorePromise, RESTORE_TIMEOUT_MS).catch(() => undefined);
  }

  /**
   * Resolves once the restore has actually settled — what the route guards
   * await before deciding whether a game exists.
   *
   * They used to read `currentQuestion()` synchronously, correct only while
   * the app initializer is guaranteed to have finished first. It isn't: the
   * initializer gives up after {@link RESTORE_TIMEOUT_MS}, and that expiry is
   * indistinguishable from "there is no saved game", so a read slower than the
   * bound would bounce the player home with their game intact in IndexedDB.
   *
   * Written while chasing finding B11, which turned out to be something else
   * (a string reaching `GameConfig.amount`, declared `number` — see
   * `game-setup.component.html`). This window was never the observed failure
   * and has not been seen in the wild; it is closed anyway because awaiting a
   * promise that has almost always already settled costs nothing, and the
   * alternative costs a game.
   */
  whenRestoreSettled(): Promise<void> {
    return giveUpAfter(this.restorePromise ?? Promise.resolve(), GUARD_RESTORE_TIMEOUT_MS).catch(
      () => undefined,
    );
  }

  private async readAndApplySavedGame(): Promise<void> {
    const saved = await this.persistence.load().catch(() => null);
    if (!saved) {
      return;
    }

    // A late restore must not clobber a game the player has since started.
    // Bootstrap may have given up waiting and let them reach the setup screen
    // and press Start before this landed; replacing that with the old game
    // would be a worse bug than the one this fixes.
    if (this.questions().length > 0) {
      return;
    }

    this.config.set(saved.config);
    this.questions.set(saved.questions);
    this.currentIndex.set(saved.currentIndex);
    this.points.set(saved.points);
    this.correctAnswers.set(saved.correctAnswers);
    this.currentStreak.set(saved.currentStreak);
    this.maxStreak.set(saved.maxStreak);
    this.isComplete.set(saved.isComplete);
    this.flaggedQuestionIds.set(new Set(saved.flaggedQuestionIds));
    this.answerHistory.set(saved.answerHistory);
    this.answerDurations.set(saved.answerDurations);
    this.lifelines.set(saved.lifelines);
    this.eliminatedAnswerIds.set(saved.eliminatedAnswerIds);
    this.gameId.set(saved.gameId);
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

  /**
   * Set when a game is refused because the day's free allowance is spent.
   * Cleared by starting a game that is allowed, so the setup screen never shows
   * a stale refusal after midnight or after an upgrade.
   */
  readonly limitReached = signal(false);

  /**
   * A tag-filtered draw that came back with fewer questions than were asked for
   * (`FEAT-021`), or `null`.
   *
   * The setup screen says how many were found and waits, rather than starting a
   * shorter round without mentioning it — a player who asked for twenty
   * questions about one topic and silently got three has been misled by
   * omission, which is the same failure the time-limit note exists for. The
   * second press plays what was found; nothing is drawn again, so saying so
   * costs no extra read.
   *
   * **Scoped to a tag-filtered draw on purpose.** A short draw has always been
   * possible — a rare category, a narrow difficulty, a small bank — and
   * interrupting those would change behaviour this feature has no business
   * changing. A tag filter is different in kind: the bank is mostly untagged,
   * so "fewer than you asked for" is the *expected* result rather than an
   * unlucky one, and a player has no way to know that unless they are told.
   */
  readonly shortDraw = signal<{ found: number; asked: number } | null>(null);

  /**
   * The questions behind {@link shortDraw}, held so confirming plays the very
   * draw that was described rather than a fresh one — which could come back a
   * different size and make the message that prompted the confirmation false.
   */
  private pendingDraw: { config: GameConfig; questions: TriviaQuestion[] } | null = null;

  /**
   * Withdraws the short-draw message because the reader has changed the
   * selection it described.
   *
   * The notice and the Start button's "Play 3 Questions" label are both an
   * answer to the *previous* press, and {@link takeAcceptedDraw} already
   * refuses to apply a held draw to a selection that has moved — so without
   * this the button would go on offering three questions right up until the
   * press that draws twenty (`CLAUDE.md` §4.4: a control must not describe an
   * outcome it will not produce). The held draw itself is kept: reverting the
   * form to what it was makes it valid again, and re-checking it is free.
   */
  clearShortDrawNotice(): void {
    this.shortDraw.set(null);
  }

  async startGame(config: GameConfig): Promise<void> {
    this.isLoading.set(true);
    this.loadError.set(null);
    this.limitReached.set(false);

    try {
      // Pressing Start again on an unchanged selection accepts the short draw
      // that was just described. Any edit to the form — one tag more, a
      // different category, a different count — makes this comparison fail and
      // draws again, so a stale confirmation cannot be applied to a selection
      // the player has since changed.
      const accepted = this.takeAcceptedDraw(config);
      const questions = accepted ?? (await this.triviaService.getQuestions(config));

      if (questions.length === 0) {
        this.loadError.set(
          'No questions were found for the selected options. Try a different category, difficulty, or source.',
        );
        return;
      }

      if (!accepted && this.isShortFilteredDraw(config, questions.length)) {
        this.pendingDraw = { config, questions };
        this.shortDraw.set({ found: questions.length, asked: config.amount });
        return;
      }

      // Spent here, after the questions are in hand and before any state is
      // committed — so a fetch that fails or comes back empty costs the player
      // nothing. Charging at submit would bill a bad connection, which is the
      // one moment a free player is least inclined to forgive a paywall.
      if (!(await this.dailyLimit.consumeGame())) {
        this.limitReached.set(true);
        return;
      }

      this.config.set(config);
      this.questions.set(questions);
      this.gameId.set(crypto.randomUUID());
      this.currentIndex.set(0);
      this.points.set(0);
      this.correctAnswers.set(0);
      // Same two places as the flags and the history below, and the same
      // reason: not every route into a new game goes through `clearGameState`.
      // A leaked streak is the one that pays out, too — a player who abandoned
      // a game eight correct answers in would start the next one at 3×.
      this.currentStreak.set(0);
      this.maxStreak.set(0);
      this.isComplete.set(false);
      // Cleared here as well as in `clearGameState()`, because not every route
      // into a new game goes through one. "Play Again" does (`resetGame`), and
      // so does the resume banner's Discard — but the top bar's logo is a plain
      // `routerLink="/"`, so a player can abandon a game and start another
      // without either, and `restoreSavedGame()` puts the old flags back into
      // the signal on the way. Custom question ids are stable Firestore
      // document ids, so a leaked flag is not a harmless stale byte: draw the
      // same question again and it renders pre-flagged, and game-over leads
      // with "Questions you flagged" for a question the player never flagged
      // in this game.
      this.flaggedQuestionIds.set(new Set());
      // Same reasoning, and the same two places: a leaked history is worse
      // than a leaked flag, because the recap would show the previous game's
      // answers underneath this game's score.
      this.answerHistory.set([]);
      this.answerDurations.set([]);
      // ...and the same for lifelines, which leak in the most rewarding
      // direction: a player who abandoned a game having spent all three would
      // start the next one with none.
      this.lifelines.set(ALL_LIFELINES_AVAILABLE);
      this.eliminatedAnswerIds.set([]);
      await this.router.navigateByUrl('/play');
    } catch {
      this.loadError.set('Failed to load questions. Please check your connection and try again.');
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Whether this draw is the one the player has to be told about: they filtered
   * by topic, and the bank had less of it than they asked for.
   */
  private isShortFilteredDraw(config: GameConfig, found: number): boolean {
    return (config.tags?.length ?? 0) > 0 && found < config.amount;
  }

  /**
   * The held draw when `config` is the selection it was made for, consuming it;
   * `null` otherwise, which also discards whatever was held.
   *
   * Compared field by field rather than by reference, because the setup screen
   * builds a fresh `GameConfig` object on every submit — a reference check would
   * never match and the confirmation would loop forever.
   */
  private takeAcceptedDraw(config: GameConfig): TriviaQuestion[] | null {
    const pending = this.pendingDraw;
    this.pendingDraw = null;
    this.shortDraw.set(null);

    if (!pending) {
      return null;
    }
    const before = pending.config;
    const same =
      before.amount === config.amount &&
      before.category === config.category &&
      before.difficulty === config.difficulty &&
      before.source === config.source &&
      before.timeLimit === config.timeLimit &&
      (before.tags ?? []).join(' ') === (config.tags ?? []).join(' ');

    return same ? pending.questions : null;
  }

  /**
   * Records what the player picked — the whole answer, not just whether it was
   * right.
   *
   * It took a `boolean` and threw the rest away, which made a timeout and a
   * wrong answer indistinguishable the moment they left the quiz component.
   * The recap has to tell them apart, and only the caller knows.
   */
  registerAnswer(answer: Answer | null): void {
    if (answer?.isCorrect === true) {
      // Extend the run first, then score against it: the tier table is written
      // in terms of how many have been answered correctly *including this one*,
      // so the third consecutive correct answer is the first to earn 1.5×.
      const streak = this.currentStreak() + 1;
      this.currentStreak.set(streak);
      this.maxStreak.update((best) => Math.max(best, streak));
      this.correctAnswers.update((value) => value + 1);
      this.points.update((value) => value + pointsForStreak(streak));
    } else {
      // A wrong answer and a timeout both end the run. They are different
      // outcomes for the recap and identical for the streak.
      this.currentStreak.set(0);
    }
    this.record(answer === null ? TIMED_OUT : answeredWith(answer.id));
  }

  /**
   * Skip: the question is over, scores nothing, and still counts.
   *
   * **"Advances without penalty" is not the same as "does not count", and the
   * difference is a leaderboard exploit.** Every bound `firestore.rules` puts
   * on an entry is relative to `totalQuestions` — the score ceiling and the
   * accuracy it will accept both scale with it — so a skip that shrank the
   * denominator would let a player skip nine of ten, answer one, and post a
   * perfectly well-formed 100%. `totalQuestions` is `questions().length` and
   * nothing here touches it, so the denominator holds by construction rather
   * than by a check — but that is the property being relied on, which is why it
   * is written down and pinned by a test. Decided explicitly with the owner,
   * 28 August 2026.
   *
   * What the lifeline actually buys is the clock and the wrong-answer sting,
   * not a free point.
   *
   * **The streak is deliberately untouched** (`FEAT-004`): a skip neither
   * breaks nor extends it. That is the one thing about the run that cannot be
   * recovered from the answer history afterwards — a recap-derived longest run
   * would read a skip as a break — which is why `currentStreak` is tracked
   * here rather than recomputed on the results screen.
   */
  registerSkippedQuestion(): void {
    this.record(SKIPPED);
  }

  /**
   * The one place a question's outcome is written down — and therefore the one
   * place it is marked as seen (`FEAT-034`).
   *
   * All four outcomes come through here: a correct answer, a wrong one, a
   * timeout and a skip. That is exactly the set the seen-set wants, because
   * all four mean the player read the question — and it is why the mark lives
   * at this funnel rather than at the two public methods above, which would be
   * two call sites to keep in step and a third to forget when a fifth outcome
   * arrives. Drawing a question and abandoning the game reaches nothing here,
   * so a closed tab never burns questions the player was never shown.
   *
   * Fire-and-forget, and `markSeen` never rejects: a storage failure costs
   * deduplication, never the answer being recorded.
   */
  private record(outcome: PickedAnswer): void {
    const question = this.currentQuestion();
    if (question) {
      void this.seenQuestions.markSeen(question);
    }
    this.answerHistory.update((history) => [...history, outcome]);
    this.answerDurations.update((durations) => [...durations, this.elapsedOnThisQuestion()]);
  }

  /**
   * Notes that the question on screen has just appeared, which starts its clock
   * (`FEAT-049`).
   *
   * Called by `QuizLoopComponent` at the two moments a question is rendered —
   * arriving at `/play`, and moving on after the answer-reveal delay — because
   * that component is the only thing that knows when either happens. The
   * controller cannot: `advanceQuestion()` runs while the previous question's
   * result is still on screen, and `startGame()` runs before the route has even
   * changed.
   */
  markQuestionShown(): void {
    this.questionShownAt = Date.now();
  }

  /**
   * How long the question on screen has been there, bounded.
   *
   * The wall clock rather than an accumulated tick count, for the reason the
   * countdown reads it (`CLAUDE.md` §4.4): a backgrounded tab throttles timers,
   * and an `unlimited` game has no timer at all. The bound is what makes the
   * number storable — a game left open overnight is not evidence of how long a
   * question took, and `recordGameResult` refuses anything past it outright, so
   * clamping here is the difference between a capped duration and a rejected
   * game.
   */
  private elapsedOnThisQuestion(): number {
    if (this.questionShownAt === null) {
      return 0;
    }
    const elapsed = Date.now() - this.questionShownAt;
    // A clock that has gone backwards yields a negative elapsed time, which is
    // the one value below the floor.
    return Math.min(Math.max(0, Math.round(elapsed)), MAX_ANSWER_MS);
  }

  /**
   * Spends a lifeline, reporting whether there was one to spend.
   *
   * The guard and the mutation are one call on purpose. Split into
   * `canUse()` + `use()` they are two reads of a signal that a caller can
   * forget to pair, and the failure is silent — a second click spends nothing
   * and still performs the effect.
   */
  consumeLifeline(id: LifelineId): boolean {
    if (!this.lifelines()[id]) {
      return false;
    }
    this.lifelines.update((state) => ({ ...state, [id]: false }));
    return true;
  }

  /**
   * Removes wrong options from the current question, and returns whether it
   * did anything.
   *
   * **It never reduces the question to one option**, which is a deliberate
   * departure from the spec's "fewer than 4 choices → remove 1 instead of 2".
   * Taken literally on a true/false question that removes the only wrong
   * answer and hands over the correct one — not a 50/50, a free point. The
   * rule here is `min(2, wrongAnswers - 1)`: two removals on a four-option
   * question, one on a three-option, and **none** on true/false, where the
   * button is disabled rather than hidden (see the template for why disabled
   * and not hidden).
   */
  useFiftyFifty(): boolean {
    const question = this.currentQuestion();
    if (!question) {
      return false;
    }
    const wrong = question.all_answers.filter((answer) => !answer.isCorrect);
    const removals = Math.min(2, wrong.length - 1);
    if (removals <= 0) {
      return false;
    }
    // `consumeLifeline` is the only thing standing between a first use and a
    // second — there is deliberately no separate "already eliminated something
    // on this question" check. One existed and mutation testing showed it was
    // unreachable: the lifeline is spent on first use, so the flag refuses the
    // second call before any such check could. A guard that cannot fire reads
    // as protection and provides none.
    if (!this.consumeLifeline('fiftyFifty')) {
      return false;
    }
    // Shuffled then sliced, so which two go is not always the first two —
    // otherwise the surviving wrong answer is always the last option, which is
    // a pattern a player learns in about three questions.
    const eliminated = shuffleArray([...wrong])
      .slice(0, removals)
      .map((answer) => answer.id);
    this.eliminatedAnswerIds.set(eliminated);
    return true;
  }

  advanceQuestion(): void {
    // Before the early return as well as after it: the eliminated ids belong to
    // the question being left, and `/game-over` renders the recap from the same
    // persisted snapshot. Leaving them set would carry one question's 50/50
    // into whatever the next game draws.
    this.eliminatedAnswerIds.set([]);
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
    this.points.set(0);
    this.correctAnswers.set(0);
    this.currentStreak.set(0);
    this.maxStreak.set(0);
    this.isComplete.set(false);
    this.loadError.set(null);
    this.flaggedQuestionIds.set(new Set());
    this.answerHistory.set([]);
    this.answerDurations.set([]);
    this.questionShownAt = null;
    this.lifelines.set(ALL_LIFELINES_AVAILABLE);
    this.eliminatedAnswerIds.set([]);
    this.gameId.set(null);
  }
}
