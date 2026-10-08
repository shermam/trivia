import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { GameConfig } from '../../models/question.model';
import { ConnectivityService } from '../../services/connectivity.service';
import {
  DAILY_FREE_GAME_LIMIT,
  DailyGameLimitService,
} from '../../services/daily-game-limit.service';
import { GameControllerService } from '../../services/game-controller.service';
import { OfflineQuestionsService } from '../../services/offline-questions.service';
import { SubscriptionService } from '../../services/subscription.service';
import { GameSetupComponent } from './game-setup.component';

/**
 * `allowance` is what `DailyGameLimitService` is currently reporting. The
 * default is a fresh day, and the interesting combination is `hasGamesLeft`
 * true with `remaining` at zero — the window in which the count has landed and
 * the entitlement behind it has not.
 */
function setup(
  allowance: { isUnlimited?: boolean; hasGamesLeft?: boolean; remaining?: number } = {},
) {
  const startGame = vi.fn<(config: GameConfig) => Promise<void>>(() => Promise.resolve());
  // Held out of the stub below so a test can seed a short draw and then watch
  // the screen withdraw it (`FEAT-021`).
  const shortDraw = signal<{ found: number; asked: number } | null>(null);
  // Returned so a test can take the browser offline, which leaves the topic
  // picker usable as a preference over the saved pool (`FEAT-052`).
  const isOnline = signal(true);
  const dailyLimit = {
    isUnlimited: signal(allowance.isUnlimited ?? false),
    hasGamesLeft: signal(allowance.hasGamesLeft ?? true),
    remaining: signal(allowance.remaining ?? DAILY_FREE_GAME_LIMIT),
    refresh: vi.fn(() => Promise.resolve()),
    consumeGame: vi.fn(() => Promise.resolve(true)),
  };

  TestBed.configureTestingModule({
    providers: [
      {
        provide: GameControllerService,
        useValue: {
          startGame,
          discardSavedGame: vi.fn(),
          isLoading: signal(false),
          loadError: signal<string | null>(null),
          hasResumableGame: signal(false),
          currentIndex: signal(0),
          totalQuestions: signal(0),
          limitReached: signal(false),
          shortDraw,
          clearShortDrawNotice: () => shortDraw.set(null),
        },
      },
      // Stubbed rather than left real: the real service would open IndexedDB
      // and read the `stripeRole` claim to answer a question these tests hand
      // it the answer to.
      { provide: DailyGameLimitService, useValue: dailyLimit },
      { provide: SubscriptionService, useValue: { isProUser: signal(false) } },
      { provide: ConnectivityService, useValue: { isOnline } },
      { provide: OfflineQuestionsService, useValue: { cachedCount: signal(0) } },
      // The real router, not a stub: this template has a `routerLink`, and
      // RouterLink needs an `ActivatedRoute` and a `Router` that can actually
      // build a UrlTree. Nothing here navigates.
      provideRouter([]),
    ],
  });

  const fixture = TestBed.createComponent(GameSetupComponent);
  fixture.detectChanges();
  return { fixture, startGame, dailyLimit, isOnline, shortDraw };
}

/** Picks an option the way a player does — through the DOM, not through `setValue`. */
function chooseAmount(fixture: ReturnType<typeof setup>['fixture'], label: string): void {
  const select = (fixture.nativeElement as HTMLElement).querySelector(
    '#amount',
  ) as HTMLSelectElement;
  const option = [...select.options].find((candidate) => candidate.textContent?.trim() === label);
  if (!option) {
    throw new Error(`no "${label}" option — the test is asserting against markup that changed`);
  }
  select.value = option.value;
  select.dispatchEvent(new Event('change'));
  fixture.detectChanges();
}

function submit(fixture: ReturnType<typeof setup>['fixture']): void {
  const form = (fixture.nativeElement as HTMLElement).querySelector('form') as HTMLFormElement;
  form.dispatchEvent(new Event('submit'));
  fixture.detectChanges();
}

/**
 * Finding B11. The question-count `<select>` bound its options with `[value]`,
 * which sets the option's *DOM* value — so `SelectControlValueAccessor` wrote
 * the string `"5"` into a control declared `FormControl<number>`, and
 * `GameConfig.amount` was a string the moment a player touched the picker.
 *
 * Nothing complained. Every consumer coerced it silently — the Open Trivia
 * query string, Firestore's `limit()`, `Math.min`, `Array.slice` — except the
 * one place that actually type-checks: `parseSavedGame` requires
 * `typeof amount === 'number'`, so it rejected the record, cleared it, and the
 * player's game vanished on reload while the guard bounced them home.
 *
 * These drive the real `<select>` rather than calling `setValue`, because
 * `setValue(5)` stores a number regardless of how the options are bound and
 * would pass against the bug. The default is checked too: it was *not* broken
 * (the control keeps its initial `10` until the accessor writes over it), which
 * is exactly why this only ever bit players who changed the setting — and why
 * a test that never touches the picker proves nothing.
 */
describe('GameSetupComponent — the config it emits (B11)', () => {
  it('emits a numeric amount when the player picks one', () => {
    const { fixture, startGame } = setup();

    chooseAmount(fixture, '5');
    submit(fixture);

    expect(startGame).toHaveBeenCalledTimes(1);
    const config = startGame.mock.calls[0][0];
    expect(typeof config.amount, 'amount is the number the model declares').toBe('number');
    expect(config.amount).toBe(5);
    fixture.destroy();
  });

  it('emits a numeric amount when the player leaves the default alone', () => {
    const { fixture, startGame } = setup();

    submit(fixture);

    const config = startGame.mock.calls[0][0];
    expect(typeof config.amount).toBe('number');
    expect(config.amount).toBe(10);
    fixture.destroy();
  });

  it('emits a config the persistence layer will accept back', () => {
    const { fixture, startGame } = setup();

    chooseAmount(fixture, '25');
    submit(fixture);

    // The exact predicate `parseSavedGame` applies to a restored config. Stated
    // here as well as there so this fails at the source that produced the bad
    // value, not only in the reader that noticed it.
    const config = startGame.mock.calls[0][0];
    expect(typeof config.amount).toBe('number');
    // No category any more (`FEAT-052`): the topic picker is the only topic
    // choice, and an untouched one sends no topic at all.
    expect('category' in config).toBe(false);
    expect(typeof config.difficulty).toBe('string');
    expect(config.source).toBe('open_trivia');
    expect(config.timeLimit).toBe(15);
    fixture.destroy();
  });
});

/**
 * Which of the two controls the screen ends on, and what decides it.
 *
 * Since `FEAT-017` §3.2 the `stripeRole` claim can be up to two seconds behind
 * the IndexedDB count, so `hasGamesLeft()` is deliberately optimistic until the
 * entitlement is known and the template has to key the control on **that**
 * rather than on the count beside it. Keying it on the count instead — which
 * reads identically for a free player — would show the free tier's upsell to a
 * subscriber and then swap a ~120px card for a ~50px button underneath their
 * cursor (`CLAUDE.md` §4.4).
 */
describe('GameSetupComponent — the daily allowance', () => {
  const card = (fixture: ReturnType<typeof setup>['fixture']) =>
    (fixture.nativeElement as HTMLElement).querySelector('[data-cy="daily-limit-reached"]');
  const startButton = (fixture: ReturnType<typeof setup>['fixture']) =>
    (fixture.nativeElement as HTMLElement).querySelector('button[type="submit"]');

  it('offers Start while the entitlement is unknown, with the count already spent', () => {
    const { fixture } = setup({ hasGamesLeft: true, remaining: 0 });

    expect(card(fixture), 'no upsell before we know whether this player has paid').toBeNull();
    expect(startButton(fixture)).not.toBeNull();
    fixture.destroy();
  });

  it('shows the upsell once the entitlement is known and the count is spent', () => {
    const { fixture } = setup({ hasGamesLeft: false, remaining: 0 });

    expect(card(fixture)).not.toBeNull();
    expect(startButton(fixture)).toBeNull();
    fixture.destroy();
  });
});

/**
 * The topic picker (`FEAT-021`, `FEAT-052`) — the game's only topic choice.
 *
 * What the picker does with a keystroke is `tag-selector.component.spec.ts`'
 * subject. What this screen has to get right is narrower and easier to get
 * wrong: **what reaches `GameConfig`** for each source, and what the picker is
 * told the source can take.
 */
describe('GameSetupComponent — the topic picker (FEAT-052)', () => {
  const el = (fixture: ReturnType<typeof setup>['fixture']) => fixture.nativeElement as HTMLElement;

  /**
   * Picks a suggestion the way a player does, through the real button. The
   * shortcut strip is filled on the first focus inside the picker (or the
   * first idle moment), so the focus comes first — which is also the order a
   * player's gesture produces.
   */
  function chooseTopic(fixture: ReturnType<typeof setup>['fixture'], tag: string): void {
    el(fixture)
      .querySelector('[data-cy="filter-tag-input"]')!
      .dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    fixture.detectChanges();
    const button = el(fixture).querySelector<HTMLButtonElement>(`[data-cy="suggest-tag-${tag}"]`);
    if (!button) {
      throw new Error(`no "${tag}" suggestion — the test is asserting against markup that changed`);
    }
    button.click();
    fixture.detectChanges();
  }

  /** Types a topic and presses Enter, for one that is not among the suggestions. */
  function typeTopic(fixture: ReturnType<typeof setup>['fixture'], text: string): void {
    const input = el(fixture).querySelector<HTMLInputElement>('[data-cy="filter-tag-input"]')!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    fixture.detectChanges();
  }

  function chooseSource(fixture: ReturnType<typeof setup>['fixture'], value: string): void {
    const radio = el(fixture).querySelector<HTMLInputElement>(
      `input[type="radio"][value="${value}"]`,
    )!;
    radio.click();
    fixture.detectChanges();
  }

  /** What the submit button currently offers to do. */
  function startButtonLabel(fixture: ReturnType<typeof setup>['fixture']): string {
    return (
      el(fixture).querySelector<HTMLElement>('button[type="submit"]')?.textContent?.trim() ?? ''
    );
  }

  const textOf = (fixture: ReturnType<typeof setup>['fixture'], testId: string): string =>
    el(fixture).querySelector<HTMLElement>(`[data-cy="${testId}"]`)?.textContent?.trim() ?? '';

  const chips = (fixture: ReturnType<typeof setup>['fixture']): string[] =>
    [...el(fixture).querySelectorAll<HTMLElement>('[data-cy="selected-tag"]')].map(
      (chip) => chip.textContent?.trim().split(/\s+/)[0] ?? '',
    );

  /**
   * "Any topic", for every source: a player who never touches the picker emits
   * a config with **no** `tags` key, so nothing downstream can add a clause —
   * the draw is the one "Any Category" always made. An empty array here would
   * be harmless today and one `length` check away from emptying every game.
   */
  it('emits no tags key when the player chooses no topic, whatever the source', () => {
    const { fixture, startGame } = setup();

    for (const source of ['open_trivia', 'custom', 'mixed']) {
      chooseSource(fixture, source);
      submit(fixture);
    }

    expect(startGame).toHaveBeenCalledTimes(3);
    for (const [config] of startGame.mock.calls) {
      expect('tags' in config).toBe(false);
    }
    fixture.destroy();
  });

  it('offers the seed tags — Open Trivia’s former categories — as its suggestions', () => {
    const { fixture } = setup();

    chooseTopic(fixture, 'general-knowledge');

    const offered = [
      ...el(fixture).querySelectorAll<HTMLElement>('[data-cy="filter-tag-suggestions"] button'),
    ].map((button) => button.textContent?.trim());
    expect(offered).toHaveLength(24);
    expect(offered[0]).toBe('#general-knowledge');
    expect(offered).toContain('#video-games');
    fixture.destroy();
  });

  describe('for an Open Trivia game', () => {
    it('emits the one seed tag chosen', () => {
      const { fixture, startGame } = setup();

      chooseTopic(fixture, 'history');
      submit(fixture);

      expect(startGame.mock.calls[0][0].tags).toEqual(['history']);
      fixture.destroy();
    });

    /** A single choice, as the category `<select>` was: picking another swaps it in. */
    it('swaps a second seed tag in for the first', () => {
      const { fixture, startGame } = setup();

      chooseTopic(fixture, 'history');
      chooseTopic(fixture, 'sports');
      submit(fixture);

      expect(chips(fixture)).toEqual(['#sports']);
      expect(startGame.mock.calls[0][0].tags).toEqual(['sports']);
      fixture.destroy();
    });

    /** Refused out loud: a topic the API cannot be asked for would be ignored by the draw. */
    it('refuses a typed topic that is not a seed tag, and says why', () => {
      const { fixture, startGame } = setup();

      typeTopic(fixture, 'World War 2');
      submit(fixture);

      expect(textOf(fixture, 'filter-tag-feedback')).toContain(
        'Open Trivia plays only the suggested topics',
      );
      expect(textOf(fixture, 'filter-tag-status')).toContain('#world-war-2 was not added');
      expect('tags' in startGame.mock.calls[0][0]).toBe(false);
      fixture.destroy();
    });
  });

  describe('switching into Open Trivia', () => {
    /**
     * The selection keeps its first seed tag and loses the rest, and says so in
     * the feedback line and from the live region — the state that would
     * otherwise be silent, with topics on screen the game was never going to
     * play.
     */
    it('keeps the first seed tag, removes the rest and says what went', () => {
      const { fixture, startGame } = setup();

      chooseSource(fixture, 'custom');
      typeTopic(fixture, 'world war 2');
      chooseTopic(fixture, 'history');
      chooseTopic(fixture, 'sports');
      chooseSource(fixture, 'open_trivia');

      expect(chips(fixture)).toEqual(['#history']);
      expect(textOf(fixture, 'filter-tag-feedback')).toBe(
        'Open Trivia plays one suggested topic, so the others were removed.',
      );
      expect(textOf(fixture, 'filter-tag-status')).toBe(
        'Open Trivia plays one suggested topic. Kept #history; removed #world-war-2 and #sports.',
      );

      submit(fixture);
      expect(startGame.mock.calls[0][0].tags).toEqual(['history']);
      fixture.destroy();
    });

    it('empties a selection with no seed tag in it, and says so', () => {
      const { fixture, startGame } = setup();

      chooseSource(fixture, 'custom');
      typeTopic(fixture, 'cold war');
      chooseSource(fixture, 'open_trivia');

      expect(chips(fixture)).toEqual([]);
      expect(textOf(fixture, 'filter-tag-feedback')).toBe(
        'Open Trivia plays only the suggested topics, so yours were removed.',
      );
      expect(textOf(fixture, 'filter-tag-status')).toBe(
        'Open Trivia plays only the suggested topics. Removed #cold-war.',
      );

      submit(fixture);
      expect('tags' in startGame.mock.calls[0][0]).toBe(false);
      fixture.destroy();
    });

    it('withdraws that notice on leaving Open Trivia again', () => {
      const { fixture } = setup();

      chooseSource(fixture, 'custom');
      typeTopic(fixture, 'cold war');
      chooseSource(fixture, 'open_trivia');
      chooseSource(fixture, 'mixed');

      expect(textOf(fixture, 'filter-tag-feedback')).toBe('0 of 10 chosen.');
      fixture.destroy();
    });
  });

  describe('for a Mixed game', () => {
    /** Every topic reaches the config: the community half filters on all of them. */
    it('emits every topic chosen', () => {
      const { fixture, startGame } = setup();

      chooseSource(fixture, 'mixed');
      typeTopic(fixture, 'world war 2');
      chooseTopic(fixture, 'history');
      submit(fixture);

      expect(startGame.mock.calls[0][0].tags).toEqual(['world-war-2', 'history']);
      fixture.destroy();
    });

    /** The Open Trivia half follows the first seed tag, and the hint names it before Start. */
    it('names the topic the Open Trivia half follows, or says it covers every topic', () => {
      const { fixture } = setup();

      chooseSource(fixture, 'mixed');
      typeTopic(fixture, 'world war 2');
      expect(textOf(fixture, 'filter-tag-hint')).toContain('cover every topic');

      chooseTopic(fixture, 'sports');
      chooseTopic(fixture, 'history');
      expect(textOf(fixture, 'filter-tag-hint')).toContain('Open Trivia ones follow #sports');
      fixture.destroy();
    });
  });

  it('emits any topic for a Custom game, typed or suggested', () => {
    const { fixture, startGame } = setup();

    chooseSource(fixture, 'custom');
    typeTopic(fixture, 'world war 2');
    chooseTopic(fixture, 'history');
    submit(fixture);

    expect(startGame.mock.calls[0][0].tags).toEqual(['world-war-2', 'history']);
    fixture.destroy();
  });

  /**
   * Offline the picker stays usable — the selection narrows the saved pool as a
   * preference, as the category did — so it is neither disabled nor dropped.
   */
  it('stays usable offline, and sends what was chosen', () => {
    const { fixture, startGame, isOnline } = setup();

    isOnline.set(false);
    fixture.detectChanges();
    chooseTopic(fixture, 'history');
    submit(fixture);

    expect(
      el(fixture).querySelector<HTMLInputElement>('[data-cy="filter-tag-input"]')?.disabled,
    ).toBe(false);
    expect(startGame.mock.calls[0][0].tags).toEqual(['history']);
    fixture.destroy();
  });

  /**
   * The hint that is showing has to be one of the strings the picker was given
   * to reserve the line's height against, or the line is sized for messages it
   * may not carry and rewraps under the reader when another arrives. Every
   * source and every Mixed state is walked, because the reserve is only as good
   * as its *worst* member.
   *
   * jsdom has no layout, so what this can assert is the pairing; what it is
   * worth is measured in `tag-filter.spec.ts`.
   */
  it('shows only hints it also reserves space for', () => {
    const { fixture } = setup();
    const reserved = () =>
      [...el(fixture).querySelectorAll('[data-cy="filter-tag-hint-reserve"]')].map((twin) =>
        twin.textContent?.trim(),
      );
    const showing = () => textOf(fixture, 'filter-tag-hint');
    const seen = new Set<string>();
    const check = () => {
      expect(showing()).toBeTruthy();
      expect(reserved()).toContain(showing());
      seen.add(showing());
    };

    check();
    chooseSource(fixture, 'custom');
    check();
    chooseSource(fixture, 'mixed');
    check();
    typeTopic(fixture, 'cold war');
    check();
    chooseTopic(fixture, 'japanese-anime-manga');
    check();

    expect(seen.size).toBe(5);
    fixture.destroy();
  });

  /** The notices about Open Trivia's rule are reserved too, so arriving moves nothing below. */
  it('reserves the feedback line for every Open Trivia notice', () => {
    const { fixture } = setup();
    const reserved = [
      ...el(fixture).querySelectorAll('[data-cy="filter-tag-feedback-reserve"]'),
    ].map((twin) => twin.textContent?.trim());

    expect(reserved).toEqual([
      'Open Trivia plays only the suggested topics — Custom and Mixed take any.',
      'Open Trivia plays one suggested topic, so the others were removed.',
      'Open Trivia plays only the suggested topics, so yours were removed.',
    ]);
    fixture.destroy();
  });

  /**
   * The short-draw notice and the Start button's "Play {n} Questions" label are
   * both an answer to the press that produced them. `startGame` already refuses
   * to apply a held draw to a selection that has since changed, so the button
   * would draw twenty while still offering three — a control describing an
   * outcome it will not produce (`CLAUDE.md` §4.4). Any edit withdraws it.
   */
  it('withdraws the short-draw notice as soon as the selection changes', () => {
    const { fixture, shortDraw } = setup();

    chooseSource(fixture, 'custom');
    chooseTopic(fixture, 'history');
    shortDraw.set({ found: 3, asked: 20 });
    fixture.detectChanges();

    const notice = () => el(fixture).querySelector('[data-cy="short-draw-notice"]');
    expect(notice()).not.toBeNull();
    expect(startButtonLabel(fixture)).toContain('Play 3 Questions');

    chooseTopic(fixture, 'sports');

    expect(shortDraw()).toBeNull();
    expect(notice()).toBeNull();
    expect(startButtonLabel(fixture)).toContain('Start Game');
    fixture.destroy();
  });
});
