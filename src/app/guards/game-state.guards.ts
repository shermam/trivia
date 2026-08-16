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
 * Both guards **await** the B8 restore before deciding (finding B11). They
 * used to read `GameControllerService` synchronously, which was correct only
 * while the app initializer was guaranteed to have finished first — and it
 * wasn't. That initializer gives up after a bounded wait, and on a slow device
 * the expiry is indistinguishable from "there is no saved game", so a reload
 * mid-game bounced the player to `/` while the game sat intact in IndexedDB.
 * Reproduced on a throttled connection: intermittent, which is what marked it
 * a race rather than a rejected record.
 *
 * `giveUpAfter` stops waiting without stopping the work, so the read is still
 * in flight when bootstrap moves on — awaiting it here costs nothing in the
 * common case and is the whole fix in the slow one.
 *
 * Note both services are injected *before* the first `await`. A guard runs in
 * an injection context that does not survive suspension, so moving either
 * `inject()` below the await throws at runtime rather than at compile time.
 */

/** `/play` needs a question in memory — a restored game counts (B8). */
export const hasActiveGameGuard: CanActivateFn = async () => {
  const gameController = inject(GameControllerService);
  const router = inject(Router);

  await gameController.whenRestoreSettled();

  return gameController.currentQuestion() ? true : router.createUrlTree(['/']);
};

/**
 * `/game-over` needs a *finished* game, not merely a loaded one: game state
 * survives reloads, so a half-played game is restorable at any time — and this
 * screen offers to publish its score to the leaderboard, which a game still in
 * progress has no business doing.
 */
export const hasCompletedGameGuard: CanActivateFn = async () => {
  const gameController = inject(GameControllerService);
  const router = inject(Router);

  await gameController.whenRestoreSettled();

  return gameController.totalQuestions() > 0 && gameController.isComplete()
    ? true
    : router.createUrlTree(['/']);
};
