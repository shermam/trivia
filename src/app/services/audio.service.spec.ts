import { TestBed } from '@angular/core/testing';
import { ALL_CUES, AudioService, MAX_CUE_GAIN } from './audio.service';
import { EmbedModeService } from './embed-mode.service';

/**
 * `FEAT-003`.
 *
 * Two things here can be checked nowhere else. **jsdom has no `AudioContext`
 * at all**, which makes it the exact environment the service's "no Web Audio"
 * path exists for — so the tests that matter most are the ones asserting that
 * a cue there is a no-op rather than an exception. And **nothing else in the
 * suite listens**: an over-loud tone, a cue that fires while muted, or a
 * context built at bootstrap are all invisible to a Playwright run, to
 * Lighthouse and to a reviewer reading the diff.
 */

/** One scheduled tone, as the fake context records it. */
interface RecordedTone {
  peakGain: number;
  start: number;
  stop: number;
  /** Whether the frequency was ramped rather than held — a sweep rather than a note. */
  glided: boolean;
  disconnected: boolean;
}

/**
 * An `AudioParam` that remembers the loudest thing it was ramped to.
 *
 * The service approaches silence with an exponential ramp rather than arriving
 * at it (a ramp cannot reach zero), so "the peak" is the largest target it was
 * given, not its final value.
 */
class FakeParam {
  peak = 0;
  setValueAtTime(): void {
    // The floor is a constant; only the ramp targets say anything.
  }
  exponentialRampToValueAtTime(value: number): void {
    this.peak = Math.max(this.peak, value);
  }
}

interface FakeGain {
  gain: FakeParam;
  connect(): void;
  disconnect(): void;
}

/**
 * The smallest `AudioContext` the service's graph actually exercises.
 *
 * Deliberately not a blanket `vi.fn()`: the point is to record *what* was
 * scheduled — how loud, in what order, and whether the nodes were released —
 * which a spy on a constructor says nothing about. The one simplification is
 * that `stop()` fires `onended` synchronously, where a real engine fires it
 * when the tone finishes; that is what lets the teardown be asserted at all
 * without waiting out the cue.
 */
function installFakeAudioContext() {
  const tones: RecordedTone[] = [];
  const contexts: FakeContext[] = [];
  let constructorThrows = false;
  let startsSuspended = false;
  let resumeRejects = false;
  let resumeLeavesSuspended = false;

  class FakeContext {
    /**
     * Starts `running`, as a real context built after a user activation does.
     * A test that wants the suspended path sets `startsSuspended` before the
     * cue that builds it, rather than reaching in afterwards — the whole point
     * is what happens on the way *in*.
     */
    state: AudioContextState = startsSuspended ? 'suspended' : 'running';
    currentTime = 0;
    destination = {} as AudioDestinationNode;
    resumeCalls = 0;
    closed = false;

    createGain(): FakeGain {
      return { gain: new FakeParam(), connect: () => undefined, disconnect: () => undefined };
    }

    createOscillator() {
      const record: RecordedTone = {
        peakGain: 0,
        start: -1,
        stop: -1,
        glided: false,
        disconnected: false,
      };
      const frequency = new FakeParam();
      const node = {
        type: 'sine' as OscillatorType,
        frequency,
        onended: null as (() => void) | null,
        connect(target: FakeGain) {
          // The oscillator's only outgoing edge is its gain node, and by the
          // time it is connected the envelope has already been scheduled on it.
          record.peakGain = target.gain.peak;
        },
        disconnect() {
          record.disconnected = true;
        },
        start(when: number) {
          record.start = when;
        },
        stop(when: number) {
          record.stop = when;
          // A ramp is the only thing that moves this param's peak off zero;
          // `setValueAtTime` leaves it alone. So a non-zero peak is a glide.
          record.glided = frequency.peak > 0;
          tones.push(record);
          node.onended?.();
        },
      };
      return node as unknown as OscillatorNode;
    }

    resume(): Promise<void> {
      this.resumeCalls += 1;
      if (resumeRejects) {
        return Promise.reject(new DOMException('not allowed', 'NotAllowedError'));
      }
      if (!resumeLeavesSuspended) {
        this.state = 'running';
      }
      return Promise.resolve();
    }

    close(): Promise<void> {
      this.closed = true;
      return Promise.resolve();
    }
  }

  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const ctor = function FakeAudioContextCtor() {
    if (constructorThrows) {
      throw new DOMException('refused', 'NotAllowedError');
    }
    const context = new FakeContext();
    contexts.push(context);
    return context;
  } as unknown as typeof AudioContext;

  Object.defineProperty(globalThis, 'AudioContext', {
    value: ctor,
    configurable: true,
    writable: true,
  });

  return {
    tones,
    contexts,
    refuse: () => {
      constructorThrows = true;
    },
    /** Every context built from here on starts suspended, as one built without activation does. */
    buildSuspended: () => {
      startsSuspended = true;
    },
    /** `resume()` settles, and the state does not move — a browser still refusing audio. */
    resumeWithoutRunning: () => {
      startsSuspended = true;
      resumeLeavesSuspended = true;
    },
    /** `resume()` rejects outright, which it does with no activation behind it. */
    refuseResume: () => {
      startsSuspended = true;
      resumeRejects = true;
    },
    restore: () => {
      if (original) {
        Object.defineProperty(globalThis, 'AudioContext', original);
      } else {
        Reflect.deleteProperty(globalThis, 'AudioContext');
      }
    },
  };
}

/**
 * Stands in for `navigator.userActivation`, which jsdom does not implement.
 *
 * Its absence is why every other test here reaches the scheduling path at all:
 * the service treats a missing API as "assume activation", so jsdom behaves
 * like an activated document by default. This is how a test says otherwise —
 * a freshly reloaded page, which is exactly the case a queued cue comes from.
 */
function stubUserActivation(hasBeenActive: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, 'userActivation');
  Object.defineProperty(navigator, 'userActivation', {
    configurable: true,
    get: () => ({ hasBeenActive, isActive: hasBeenActive }),
  });
  return () => {
    if (original) {
      Object.defineProperty(navigator, 'userActivation', original);
    } else {
      Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'userActivation');
    }
  };
}

/**
 * A fresh service, as a page load would build one.
 *
 * Resets first so a single test can build the service twice — reading the
 * stored preference back is the whole point of the persistence tests, and
 * `configureTestingModule` throws once the module has been instantiated.
 */
function setup(options: { embedded?: boolean } = {}): AudioService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: EmbedModeService, useValue: { isEmbedded: () => options.embedded ?? false } },
    ],
  });
  return TestBed.inject(AudioService);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  TestBed.resetTestingModule();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('AudioService — the mute preference', () => {
  it('starts unmuted, because sound is opt-out rather than opt-in', () => {
    expect(setup().isMuted()).toBe(false);
  });

  it('remembers a mute across a reload, and remembers unmuting too', () => {
    const service = setup();

    service.toggleMute();
    expect(service.isMuted()).toBe(true);
    expect(localStorage.getItem('trivia_sound_muted')).toBe('true');

    // A second service, as the next page load would build it.
    const reloaded = setup();
    expect(reloaded.isMuted()).toBe(true);

    reloaded.toggleMute();
    expect(reloaded.isMuted()).toBe(false);
    // Written rather than removed. "Nothing stored" and `'false'` mean the same
    // thing to this service, but only one of them matches the key the Privacy
    // Policy describes.
    expect(localStorage.getItem('trivia_sound_muted')).toBe('false');
    expect(setup().isMuted()).toBe(false);
  });

  /**
   * Safari's private mode throws on `window.localStorage` itself rather than on
   * the call that follows, so both directions are exercised against a throwing
   * *accessor* — a guard wrapped around only `getItem` would be wrapped around
   * the wrong statement.
   */
  it('survives storage that throws, in both directions', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });

    try {
      const service = setup();
      expect(service.isMuted()).toBe(false);
      expect(() => service.toggleMute()).not.toThrow();
      // The preference still holds for this tab; only its persistence is lost.
      expect(service.isMuted()).toBe(true);
    } finally {
      if (descriptor) {
        Object.defineProperty(window, 'localStorage', descriptor);
      }
    }
  });
});

describe('AudioService — cues without Web Audio', () => {
  /**
   * The environment this path exists for. jsdom defines no `AudioContext`,
   * exactly as a Safari private window or a headless runner with no output
   * device may not — and every cue has to be a no-op there, *including* the
   * absence of a console error: a game that logs an exception on every answer
   * is worse than a game with no sound.
   */
  it('plays nothing and throws nothing when there is no AudioContext', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = setup();

    expect(() => {
      service.playCorrect();
      service.playIncorrect();
      service.playTimerTick();
      service.playLifeline();
      service.playGameOver(true);
      service.playGameOver(false);
    }).not.toThrow();

    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
  });

  it('gives up quietly when the browser refuses to construct a context', () => {
    const audio = installFakeAudioContext();
    audio.refuse();
    try {
      const service = setup();
      expect(() => service.playCorrect()).not.toThrow();
      expect(audio.tones).toHaveLength(0);
    } finally {
      audio.restore();
    }
  });
});

describe('AudioService — cues with Web Audio', () => {
  let audio: ReturnType<typeof installFakeAudioContext>;

  beforeEach(() => {
    audio = installFakeAudioContext();
  });

  afterEach(() => {
    audio.restore();
  });

  /**
   * **The autoplay-policy rule, and the one a refactor breaks silently.** A
   * context built in the constructor starts suspended and logs a warning
   * saying so; one built on the first cue is already past the click that
   * started the game.
   */
  it('builds no AudioContext until a cue actually plays', () => {
    const service = setup();
    expect(audio.contexts).toHaveLength(0);

    service.playCorrect();
    expect(audio.contexts).toHaveLength(1);
  });

  it('reuses the one context across cues, and resumes it when it is suspended', async () => {
    const service = setup();
    service.playCorrect();
    service.playIncorrect();

    expect(audio.contexts).toHaveLength(1);
    expect(audio.contexts[0].resumeCalls).toBe(0);

    // What a backgrounded tab, or an incoming call on iOS, leaves behind.
    audio.contexts[0].state = 'suspended';
    audio.tones.length = 0;
    service.playTimerTick();
    expect(audio.contexts[0].resumeCalls).toBe(1);

    // Scheduled in the continuation, on the clock as it reads once the context
    // is genuinely running — not before it, which is what queues a cue.
    await Promise.resolve();
    expect(audio.tones.length).toBeGreaterThan(0);
  });

  /**
   * **The bug this guard exists for, and the reason it is not obvious.** A
   * suspended context does not *refuse* work: its clock is frozen, so a tone
   * scheduled on it is queued and fires whenever something else resumes it —
   * over whatever screen the reader is on by then. Nothing about that is
   * visible at the call site, and it shipped as a real sequence: reload
   * `/game-over`, hear nothing, start a new game, and the fanfare plays over
   * the first answer's chime.
   */
  it('schedules nothing onto a context that is still suspended', async () => {
    // `resume()` settles and the state does not move, which is what a browser
    // that has not decided to allow audio actually does.
    audio.resumeWithoutRunning();
    const service = setup();

    service.playGameOver(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(audio.contexts).toHaveLength(1);
    expect(audio.contexts[0].resumeCalls).toBe(1);
    expect(audio.tones).toHaveLength(0);
  });

  it('drops the cue rather than throwing when resuming is refused', async () => {
    audio.refuseResume();
    const service = setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => service.playCorrect()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(audio.tones).toHaveLength(0);
    expect(errors).not.toHaveBeenCalled();
  });

  it('schedules nothing onto a closed context', () => {
    const service = setup();
    service.playCorrect();
    audio.tones.length = 0;
    audio.contexts[0].state = 'closed';

    service.playCorrect();

    expect(audio.contexts[0].resumeCalls).toBe(0);
    expect(audio.tones).toHaveLength(0);
  });

  /**
   * The **first** cue of a session must still be scheduled. A naive
   * `state !== 'running'` early return eats it, because a context can be built
   * suspended even with an activation behind it; the resume continuation is
   * what makes that case work rather than fail silently. `sound-effects.spec.ts`
   * holds the same claim down in a real browser.
   */
  it('still plays the first cue when the new context needs resuming first', async () => {
    audio.buildSuspended();
    const service = setup();

    service.playCorrect();
    expect(audio.tones).toHaveLength(0);

    await Promise.resolve();
    expect(audio.tones).toHaveLength(2);
  });

  /**
   * A document nobody has touched at all — opened from a bookmark and left
   * alone, or a page reached only by script — has had no user activation, so
   * the service asks the browser for nothing: building a context there is what
   * creates something to queue onto. This is not the reload case: measured in
   * Chromium, `navigator.userActivation.hasBeenActive` survives a reload and a
   * fresh context starts `running`, so a reloaded `/game-over` plays its cue.
   * What covers *every* path is the `running` check before scheduling, pinned
   * by the cases above; this gate only spares the browser a pointless context.
   */
  it('builds no context at all before the document has been activated', () => {
    const restore = stubUserActivation(false);
    try {
      const service = setup();
      service.playGameOver(true);
      service.playCorrect();

      expect(audio.contexts).toHaveLength(0);
      expect(audio.tones).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('plays again once the document has been activated', () => {
    const restore = stubUserActivation(true);
    try {
      const service = setup();
      service.playCorrect();

      expect(audio.tones.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it('plays a correct answer as a rising pair and a wrong one as a single low tone', () => {
    const service = setup();

    service.playCorrect();
    expect(audio.tones).toHaveLength(2);
    expect(audio.tones[1].start).toBeGreaterThan(audio.tones[0].start);
    expect(audio.tones[0].stop).toBeGreaterThan(audio.tones[0].start);
    // Held notes, not a sweep — the distinction the lifeline cue relies on.
    expect(audio.tones.some((tone) => tone.glided)).toBe(false);

    audio.tones.length = 0;
    service.playIncorrect();
    expect(audio.tones).toHaveLength(1);
    expect(audio.tones[0].glided).toBe(true);
  });

  it('plays the lifeline sweep as a glide rather than as discrete notes', () => {
    const service = setup();

    service.playLifeline();

    // Two overlapping tones, both gliding: the whole point is that it cannot
    // be mistaken for the correct answer's two-note chime, which fires on an
    // adjacent gesture.
    expect(audio.tones).toHaveLength(2);
    expect(audio.tones.every((tone) => tone.glided)).toBe(true);
  });

  it('plays a different game-over cue for a perfect round', () => {
    const service = setup();

    service.playGameOver(true);
    const perfect = audio.tones.length;
    audio.tones.length = 0;

    service.playGameOver(false);
    expect(perfect).toBeGreaterThan(0);
    expect(audio.tones.length).not.toBe(perfect);
  });

  /**
   * Fresh nodes per play is what lets two cues overlap — a countdown tick
   * landing on the answer that ends the question — instead of one cutting the
   * other off. The price is a node pair per tone, and this is the matching
   * teardown (`CLAUDE.md` §4.4).
   */
  it('releases every node it created once the tone has finished', () => {
    const service = setup();
    service.playGameOver(true);

    expect(audio.tones.length).toBeGreaterThan(0);
    expect(audio.tones.every((tone) => tone.disconnected)).toBe(true);
  });

  it('plays nothing while muted, and does not even build a context', () => {
    const service = setup();
    service.toggleMute();

    service.playCorrect();
    service.playTimerTick();
    service.playGameOver(true);

    expect(audio.contexts).toHaveLength(0);
    expect(audio.tones).toHaveLength(0);
  });

  it('resumes playing when unmuted again', () => {
    const service = setup();
    service.toggleMute();
    service.playCorrect();
    expect(audio.tones).toHaveLength(0);

    service.toggleMute();
    service.playCorrect();
    expect(audio.tones.length).toBeGreaterThan(0);
  });

  /**
   * An embedded game renders no top bar, so it renders no nav drawer, so there
   * is no mute toggle in it — audio there would be a noise the reader cannot
   * switch off (`docs/app.md`).
   */
  it('plays nothing in embed mode, where there is no toggle to silence it', () => {
    const service = setup({ embedded: true });

    service.playCorrect();
    service.playGameOver(true);

    expect(audio.contexts).toHaveLength(0);
    expect(audio.tones).toHaveLength(0);
  });

  it('closes the context when the injector goes', () => {
    const service = setup();
    service.playCorrect();
    const context = audio.contexts[0];

    TestBed.resetTestingModule();
    expect(context.closed).toBe(true);
  });
});

/**
 * Nothing in this repository listens, so the only thing between a cue and a
 * startling one is a number nobody re-reads. This reads it.
 */
describe('AudioService — loudness', () => {
  it('keeps every tone of every cue under the cue-gain ceiling', () => {
    for (const cue of ALL_CUES) {
      for (const tone of cue) {
        expect(tone.gain).toBeLessThanOrEqual(MAX_CUE_GAIN);
      }
    }
  });

  it('keeps the ceiling itself well under a third of full scale', () => {
    expect(MAX_CUE_GAIN).toBeLessThan(0.3);
  });

  /**
   * The table above is the declaration; this is what is actually scheduled on
   * the graph, clamp included. The two are separate assertions because a
   * quieter table and a louder envelope are different mistakes.
   */
  it('schedules an envelope that rises to a real peak and stays under the ceiling', () => {
    const audio = installFakeAudioContext();
    try {
      const service = setup();
      service.playCorrect();
      service.playIncorrect();
      service.playTimerTick();
      service.playLifeline();
      service.playGameOver(true);
      service.playGameOver(false);

      expect(audio.tones.length).toBeGreaterThan(0);
      for (const tone of audio.tones) {
        expect(tone.peakGain).toBeGreaterThan(0);
        expect(tone.peakGain).toBeLessThanOrEqual(MAX_CUE_GAIN);
      }
    } finally {
      audio.restore();
    }
  });
});
