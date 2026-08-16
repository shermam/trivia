import { WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { GameControllerService } from '../services/game-controller.service';
import { hasActiveGameGuard, hasCompletedGameGuard } from './game-state.guards';

/**
 * Finding F4. The e2e suite (route-guards.cy.ts) pins the user-visible
 * behaviour — deep-linking `/play` or `/game-over` with no game lands on `/`
 * — in a real browser. This spec pins the mechanism at unit level: each guard
 * returns a `UrlTree` to `/` (a cancelled navigation, no history entry)
 * rather than `false` or a side-effecting navigate, and the completed-game
 * guard genuinely requires *both* conditions, because a half-played game is
 * restorable at any time (B8) and must never reach the score-publishing
 * screen.
 */

interface GameState {
  currentQuestion?: unknown;
  totalQuestions?: number;
  isComplete?: boolean;
  /** Resolves when the B8 restore has settled; the guards await it (B11). */
  restore?: Promise<void>;
}

async function runGuard(guard: typeof hasActiveGameGuard, state: GameState) {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: GameControllerService,
        useValue: {
          currentQuestion: signal(state.currentQuestion ?? null),
          totalQuestions: signal(state.totalQuestions ?? 0),
          isComplete: signal(state.isComplete ?? false),
          whenRestoreSettled: () => state.restore ?? Promise.resolve(),
        },
      },
    ],
  });
  return (await TestBed.runInInjectionContext(() => guard(null as never, null as never))) as
    true | UrlTree;
}

function expectRedirectHome(result: true | UrlTree) {
  expect(result).toBeInstanceOf(UrlTree);
  expect(result.toString()).toBe(TestBed.inject(Router).createUrlTree(['/']).toString());
}

describe('hasActiveGameGuard (/play)', () => {
  it('lets a game with a current question through — a restored game counts', async () => {
    expect(await runGuard(hasActiveGameGuard, { currentQuestion: { id: 'q1' } })).toBe(true);
  });

  it('redirects to / as a UrlTree when nothing is in memory', async () => {
    expectRedirectHome(await runGuard(hasActiveGameGuard, {}));
  });
});

describe('hasCompletedGameGuard (/game-over)', () => {
  it('lets a finished game through', async () => {
    expect(await runGuard(hasCompletedGameGuard, { totalQuestions: 5, isComplete: true })).toBe(
      true,
    );
  });

  it('redirects a half-played game — restorable is not finished', async () => {
    expectRedirectHome(
      await runGuard(hasCompletedGameGuard, { totalQuestions: 5, isComplete: false }),
    );
  });

  it('redirects when no game is loaded at all, whatever the completion flag says', async () => {
    expectRedirectHome(
      await runGuard(hasCompletedGameGuard, { totalQuestions: 0, isComplete: true }),
    );
  });
});

/**
 * Finding B11. The guards used to read the controller synchronously, which was
 * correct only while the app initializer was guaranteed to have finished
 * restoring first — and it was not. That wait is bounded, and its expiry is
 * indistinguishable from "there is no saved game", so on a slow device a
 * reload mid-game bounced the player to `/` while the game sat intact in
 * IndexedDB. Reproduced live on a throttled connection: intermittent, which is
 * what marked it a race rather than a rejected record.
 *
 * These model the restore landing *after* the guard has been entered. A
 * synchronous guard cannot pass them.
 */
describe('the guards await the restore (B11)', () => {
  /**
   * The fake registered by `runGuard`, typed by what it actually is: writable
   * signals. `TestBed.inject(GameControllerService)` returns it typed as the
   * real service, whose signals are readonly, so the test cannot drive them.
   */
  function fakeController() {
    return TestBed.inject(GameControllerService) as unknown as {
      currentQuestion: WritableSignal<unknown>;
      totalQuestions: WritableSignal<number>;
      isComplete: WritableSignal<boolean>;
    };
  }

  /** A restore that only settles once the test says so. */
  function deferred() {
    let settle!: () => void;
    const promise = new Promise<void>((resolve) => (settle = resolve));
    return { promise, settle };
  }

  it('/play waits for a slow restore instead of bouncing the player home', async () => {
    const restore = deferred();
    const state: GameState = { restore: restore.promise };
    const verdict = runGuard(hasActiveGameGuard, state);

    // The game only appears after the guard is already suspended — the exact
    // ordering that used to produce a redirect.
    fakeController().currentQuestion.set({ id: 'q1' });
    restore.settle();

    expect(await verdict).toBe(true);
  });

  it('/game-over waits too, rather than calling a restored game missing', async () => {
    const restore = deferred();
    const verdict = runGuard(hasCompletedGameGuard, { restore: restore.promise });

    const controller = fakeController();
    controller.totalQuestions.set(5);
    controller.isComplete.set(true);
    restore.settle();

    expect(await verdict).toBe(true);
  });

  it('still redirects once the restore settles with nothing to restore', async () => {
    expectRedirectHome(await runGuard(hasActiveGameGuard, { restore: Promise.resolve() }));
  });
});
