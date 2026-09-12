import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { EmbedModeService } from './embed-mode.service';

/**
 * The game's sound effects (`FEAT-003`), and the mute preference that turns
 * them off.
 *
 * **Everything is synthesised** — a couple of oscillators and a gain envelope
 * per cue — rather than played from a file. That is not a purity preference:
 * `firebase.json` sends `default-src 'self'` and allowlists no CDN, so a clip
 * fetched from anywhere else is refused at runtime, and a self-hosted one would
 * be bytes in the bundle, a cache entry in `ngsw-config.json` and a request on
 * the critical path of the first correct answer. A handful of short tones cost
 * none of that, and they start on the audio clock rather than after a fetch.
 *
 * **The `AudioContext` is created on the first cue, never at bootstrap.** A
 * context constructed before any user gesture starts `suspended` under every
 * browser's autoplay policy and logs a warning saying so; one constructed on
 * the first cue is already past the click that started the game. Where it
 * cannot be had at all — jsdom has no `AudioContext`, a Safari private window
 * may refuse one, a headless runner may have no output device — every method
 * here is a silent no-op. Silent in both senses: no sound and no console
 * error, because a game that logs an exception per answer is worse than a
 * game with no sound.
 *
 * **Embed mode plays nothing.** `?embed=1` renders no top bar and therefore no
 * nav drawer, which is where the mute toggle lives — so an embedded game with
 * audio is a game a reader cannot silence (`docs/app.md`).
 */

/**
 * The mute preference, as `'true'` / `'false'`.
 *
 * Underscored rather than hyphenated like `trivia-theme`, because the key is
 * named in the published Privacy Policy's device-storage list and in
 * `FEAT-003`; the two have to agree, and the policy is the copy nobody may
 * silently edit (`CLAUDE.md` §4.0).
 */
const STORAGE_KEY = 'trivia_sound_muted';

/**
 * The ceiling every cue's peak gain sits under.
 *
 * Feedback on an answer should be audible over a room, not over the room's
 * conversation, and there is no volume control — the toggle is all or nothing.
 * Pinned by a unit test rather than left as a comment, because a louder tone is
 * a one-character edit and nothing else in the suite listens.
 */
export const MAX_CUE_GAIN = 0.2;

/**
 * How far ahead of `currentTime` a cue is scheduled.
 *
 * Web Audio parameter changes have to be scheduled in the future to be
 * honoured; scheduling at exactly `currentTime` races the audio thread and can
 * drop the attack, which is what makes a tone click. Five milliseconds is below
 * the threshold at which a sound reads as delayed from the click that caused
 * it.
 */
const SCHEDULE_LEAD_SECONDS = 0.005;

/** How long each tone takes to reach its peak. Short, but never zero — zero clicks. */
const ATTACK_SECONDS = 0.012;

/**
 * The floor of every gain ramp.
 *
 * `exponentialRampToValueAtTime` cannot reach or cross zero, so silence is
 * approached rather than arrived at. Small enough to be inaudible, large enough
 * that the ramp is legal.
 */
const SILENCE = 0.0001;

/** One oscillator's worth of a cue. */
interface Tone {
  readonly type: OscillatorType;
  /** Frequency in Hz at the start of the tone. */
  readonly from: number;
  /** Frequency in Hz at the end, for a tone that glides. Defaults to `from`. */
  readonly to?: number;
  /** When the tone starts, in seconds after the cue does. */
  readonly at: number;
  /** How long the tone lasts, envelope included. */
  readonly seconds: number;
  /** Peak gain — see {@link MAX_CUE_GAIN}. */
  readonly gain: number;
}

/**
 * The five cues, as data.
 *
 * Written out rather than generated because the shape of each one is the
 * design: two rising notes read as success, a single falling saw reads as a
 * mistake, a sweep reads as a tool being used rather than an outcome, and the
 * two game-over cues differ in direction rather than in length, so a perfect
 * round is celebrated without the screen taking longer to arrive.
 */
const CUES = {
  /** A rising two-note chime: E5 into B5. */
  correct: [
    { type: 'triangle', from: 659.25, at: 0, seconds: 0.1, gain: 0.16 },
    { type: 'triangle', from: 987.77, at: 0.085, seconds: 0.17, gain: 0.16 },
  ],
  /** A short low buzz that sags. Sawtooth, because a sine at this pitch is a hum. */
  incorrect: [{ type: 'sawtooth', from: 190, to: 120, at: 0, seconds: 0.26, gain: 0.1 }],
  /** The countdown's last five seconds. Deliberately the quietest thing here. */
  tick: [{ type: 'sine', from: 1320, at: 0, seconds: 0.045, gain: 0.05 }],
  /**
   * A lifeline being spent: a short upward sweep, the whoosh `FEAT-003` asks
   * for. A glide rather than discrete notes, so it cannot be mistaken for the
   * correct answer's two-note chime — the two fire on adjacent gestures.
   */
  lifeline: [
    { type: 'sine', from: 320, to: 1180, at: 0, seconds: 0.22, gain: 0.12 },
    { type: 'triangle', from: 640, to: 2360, at: 0.02, seconds: 0.18, gain: 0.05 },
  ],
  /** A perfect round: C5–E5–G5–C6. */
  gameOverPerfect: [
    { type: 'triangle', from: 523.25, at: 0, seconds: 0.14, gain: 0.15 },
    { type: 'triangle', from: 659.25, at: 0.125, seconds: 0.14, gain: 0.15 },
    { type: 'triangle', from: 783.99, at: 0.25, seconds: 0.14, gain: 0.15 },
    { type: 'triangle', from: 1046.5, at: 0.375, seconds: 0.36, gain: 0.17 },
  ],
  /** Any other round: two notes, falling, and over quickly. */
  gameOver: [
    { type: 'triangle', from: 440, at: 0, seconds: 0.18, gain: 0.13 },
    { type: 'triangle', from: 329.63, at: 0.16, seconds: 0.3, gain: 0.13 },
  ],
} as const satisfies Record<string, readonly Tone[]>;

/** Every cue, for the test that holds them all under {@link MAX_CUE_GAIN}. */
export const ALL_CUES: readonly (readonly Tone[])[] = Object.values(CUES);

/**
 * The stored preference, or "not muted" when storage cannot be read.
 *
 * The accessor is inside the `try` deliberately, as `PricingCacheService`
 * explains: Safari's private mode and blocked site data both throw on
 * `window.localStorage` itself rather than on the `getItem` that follows, so a
 * guard wrapped around only the call is wrapped around the wrong statement.
 */
function readStoredMute(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeStoredMute(muted: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, muted ? 'true' : 'false');
  } catch {
    // Unavailable storage or a quota refusal. The preference still holds for
    // this tab — losing it costs the reader a second tap next visit, which is
    // a much smaller price than an exception thrown out of a toggle.
  }
}

@Injectable({ providedIn: 'root' })
export class AudioService {
  private readonly embedMode = inject(EmbedModeService);

  private readonly muted = signal(readStoredMute());

  /** Whether cues are silenced. Default off, remembered on. */
  readonly isMuted = this.muted.asReadonly();

  /**
   * Created on the first cue that actually plays, and only then.
   *
   * `null` means "not built yet"; {@link unavailable} is what distinguishes
   * that from "cannot be built", so a browser without Web Audio is asked once
   * rather than on every answer.
   */
  private context: AudioContext | null = null;
  private unavailable = false;

  constructor() {
    // A root service outlives every route, so this only runs when the whole
    // injector goes — a unit test tearing down its `TestBed`, or the page
    // going away. Closing releases the audio device rather than leaving a
    // context running for a component that no longer exists (`CLAUDE.md`
    // §4.4).
    inject(DestroyRef).onDestroy(() => {
      const context = this.context;
      this.context = null;
      try {
        void context?.close().catch(() => undefined);
      } catch {
        // An already-closed context throws synchronously in some engines.
      }
    });
  }

  toggleMute(): void {
    const muted = !this.muted();
    this.muted.set(muted);
    writeStoredMute(muted);
  }

  /** A correct answer. */
  playCorrect(): void {
    this.play(CUES.correct);
  }

  /** A wrong answer, and a question the clock took — the same event to a player. */
  playIncorrect(): void {
    this.play(CUES.incorrect);
  }

  /**
   * One beat of the countdown's final seconds.
   *
   * Rate-limited by its caller rather than here: `QuizLoopComponent` derives
   * "one tick per remaining second" from the wall-clock deadline it already
   * reads, so there is no second interval to schedule and nothing extra to tear
   * down (`CLAUDE.md` §4.4).
   */
  playTimerTick(): void {
    this.play(CUES.tick);
  }

  /**
   * A lifeline being spent — 50/50, Extra Time or Skip.
   *
   * One cue for all three, because what it reports is "that worked", and the
   * three do visibly different things that need no telling apart by ear. It
   * plays only when a lifeline is genuinely consumed: a button pressed while
   * unavailable must be silent, or the sound becomes a lie about what happened.
   *
   * Skip therefore gets **this** cue and never the answer cues: it ends the
   * question without producing an outcome to react to.
   */
  playLifeline(): void {
    this.play(CUES.lifeline);
  }

  /**
   * The end of a round.
   *
   * **`isPerfectRound`, not "is this a high score".** The screen that calls
   * this knows how many answers were right and how many questions there were;
   * it does not know whether the player has ever done better, and nothing in
   * the app does — the leaderboard keeps one best entry per account and the
   * refusal that enforces it arrives as a bare `permission-denied`
   * (`CLAUDE.md` §4.4). Inventing a personal-best signal to feed a fanfare
   * would be a claim the app cannot check.
   */
  playGameOver(isPerfectRound: boolean): void {
    this.play(isPerfectRound ? CUES.gameOverPerfect : CUES.gameOver);
  }

  private play(tones: readonly Tone[]): void {
    if (this.muted() || this.embedMode.isEmbedded()) {
      return;
    }
    const context = this.audioContext();
    if (!context) {
      return;
    }
    try {
      const startAt = context.currentTime + SCHEDULE_LEAD_SECONDS;
      for (const tone of tones) {
        this.schedule(context, tone, startAt);
      }
    } catch {
      // A context that was closed or interrupted underneath us (a backgrounded
      // iOS tab does exactly that). Nothing to say to the player about it.
    }
  }

  /**
   * The context, built on demand.
   *
   * `resume()` on every call rather than once at creation: a context is
   * suspended by the browser whenever the page loses the audio focus — an iOS
   * call, another tab taking over — and stays suspended until something asks.
   * It rejects if the page has never had a user gesture, which is why the
   * rejection is swallowed rather than reported: the cue is simply not heard.
   */
  private audioContext(): AudioContext | null {
    if (this.context) {
      this.resumeIfSuspended(this.context);
      return this.context;
    }
    if (this.unavailable) {
      return null;
    }
    try {
      if (typeof AudioContext !== 'function') {
        this.unavailable = true;
        return null;
      }
      this.context = new AudioContext();
      this.resumeIfSuspended(this.context);
      return this.context;
    } catch {
      // No Web Audio, or the engine refused to give us a context. Asked once.
      this.unavailable = true;
      return null;
    }
  }

  private resumeIfSuspended(context: AudioContext): void {
    if (context.state !== 'suspended') {
      return;
    }
    try {
      void context.resume().catch(() => undefined);
    } catch {
      // Some engines throw synchronously on a closed context.
    }
  }

  /**
   * One tone: a fresh oscillator and gain pair, an envelope, and a teardown.
   *
   * **Fresh nodes per tone rather than a pooled oscillator**, because an
   * oscillator cannot be restarted once stopped and because two cues that
   * overlap — a tick landing on the answer that ends the question — have to
   * sound together rather than cut each other off.
   *
   * The `onended` disconnect is the teardown §4.4 asks for. A stopped node is
   * collectable on its own in every current engine, but only once it is no
   * longer referenced by the graph it is connected to; disconnecting says so
   * immediately rather than relying on that.
   */
  private schedule(context: AudioContext, tone: Tone, cueStart: number): void {
    const start = cueStart + tone.at;
    const end = start + tone.seconds;
    const peak = Math.min(tone.gain, MAX_CUE_GAIN);

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = tone.type;
    oscillator.frequency.setValueAtTime(tone.from, start);
    if (tone.to !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(tone.to, end);
    }

    gain.gain.setValueAtTime(SILENCE, start);
    gain.gain.exponentialRampToValueAtTime(
      peak,
      start + Math.min(ATTACK_SECONDS, tone.seconds / 2),
    );
    gain.gain.exponentialRampToValueAtTime(SILENCE, end);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(start);
    oscillator.stop(end);
  }
}
