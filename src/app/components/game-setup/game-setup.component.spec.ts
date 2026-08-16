import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { GameConfig } from '../../models/question.model';
import { ConnectivityService } from '../../services/connectivity.service';
import { GameControllerService } from '../../services/game-controller.service';
import { OfflineQuestionsService } from '../../services/offline-questions.service';
import { SubscriptionService } from '../../services/subscription.service';
import { TriviaService } from '../../services/trivia.service';
import { GameSetupComponent } from './game-setup.component';

function setup() {
  const startGame = vi.fn<(config: GameConfig) => Promise<void>>(() => Promise.resolve());

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
        },
      },
      { provide: TriviaService, useValue: { getCategories: () => Promise.resolve([]) } },
      { provide: SubscriptionService, useValue: { isProUser: signal(false) } },
      { provide: ConnectivityService, useValue: { isOnline: signal(true) } },
      { provide: OfflineQuestionsService, useValue: { cachedCount: signal(0) } },
      // The real router, not a stub: this template has a `routerLink`, and
      // RouterLink needs an `ActivatedRoute` and a `Router` that can actually
      // build a UrlTree. Nothing here navigates.
      provideRouter([]),
    ],
  });

  const fixture = TestBed.createComponent(GameSetupComponent);
  fixture.detectChanges();
  return { fixture, startGame };
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
    expect(typeof config.category).toBe('string');
    expect(typeof config.difficulty).toBe('string');
    expect(config.source).toBe('open_trivia');
    expect(config.timeLimit).toBe(15);
    fixture.destroy();
  });
});
