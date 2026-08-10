import { signal } from '@angular/core';
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
}

function runGuard(guard: typeof hasActiveGameGuard, state: GameState) {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: GameControllerService,
        useValue: {
          currentQuestion: signal(state.currentQuestion ?? null),
          totalQuestions: signal(state.totalQuestions ?? 0),
          isComplete: signal(state.isComplete ?? false),
        },
      },
    ],
  });
  return TestBed.runInInjectionContext(() => guard(null as never, null as never)) as true | UrlTree;
}

function expectRedirectHome(result: true | UrlTree) {
  expect(result).toBeInstanceOf(UrlTree);
  expect(result.toString()).toBe(TestBed.inject(Router).createUrlTree(['/']).toString());
}

describe('hasActiveGameGuard (/play)', () => {
  it('lets a game with a current question through — a restored game counts', () => {
    expect(runGuard(hasActiveGameGuard, { currentQuestion: { id: 'q1' } })).toBe(true);
  });

  it('redirects to / as a UrlTree when nothing is in memory', () => {
    expectRedirectHome(runGuard(hasActiveGameGuard, {}));
  });
});

describe('hasCompletedGameGuard (/game-over)', () => {
  it('lets a finished game through', () => {
    expect(runGuard(hasCompletedGameGuard, { totalQuestions: 5, isComplete: true })).toBe(true);
  });

  it('redirects a half-played game — restorable is not finished', () => {
    expectRedirectHome(runGuard(hasCompletedGameGuard, { totalQuestions: 5, isComplete: false }));
  });

  it('redirects when no game is loaded at all, whatever the completion flag says', () => {
    expectRedirectHome(runGuard(hasCompletedGameGuard, { totalQuestions: 0, isComplete: true }));
  });
});
