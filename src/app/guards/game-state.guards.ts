import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { GameControllerService } from '../services/game-controller.service';

/**
 * Finding F4. `/play` and `/game-over` used to enforce these conditions from
 * `ngOnInit` with `router.navigateByUrl('/')`, which is redirect-after-the-fact:
 * the lazy chunk downloads, the component constructs and starts rendering, the
 * guarded URL commits to history — so Back returns to it and bounces again —
 * and the route announcer (G5) reads out a page the user never actually
 * reaches. Returning a `UrlTree` from a guard cancels the navigation *before*
 * activation: no chunk flash, no history entry, one announcement.
 *
 * Both guards read `GameControllerService` synchronously. That is only correct
 * because the B8 app initializer awaits `restoreSavedGame()` before the first
 * route activates (`app.config.ts`) — a reload of `/play` mid-game sees the
 * restored question, not an empty store. If that initializer ever stops
 * blocking bootstrap, these guards start bouncing every deep-linked reload.
 */

/** `/play` needs a question in memory — a restored game counts (B8). */
export const hasActiveGameGuard: CanActivateFn = () => {
  return inject(GameControllerService).currentQuestion()
    ? true
    : inject(Router).createUrlTree(['/']);
};

/**
 * `/game-over` needs a *finished* game, not merely a loaded one: game state
 * survives reloads, so a half-played game is restorable at any time — and this
 * screen offers to publish its score to the leaderboard, which a game still in
 * progress has no business doing.
 */
export const hasCompletedGameGuard: CanActivateFn = () => {
  const gameController = inject(GameControllerService);
  return gameController.totalQuestions() > 0 && gameController.isComplete()
    ? true
    : inject(Router).createUrlTree(['/']);
};
