import {
  ApplicationConfig,
  inject,
  isDevMode,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';

import { routes } from './app.routes';
import { GameControllerService } from './services/game-controller.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Restores an in-progress game (B8) *before* the first route activates.
    // `/play` and `/game-over` redirect to `/` the moment they find no question
    // in memory, and the store is asynchronous, so a restore racing route
    // activation would bounce the player off the very screen they reloaded.
    // Bootstrap therefore waits — bounded, and non-throwing, so a browser with
    // no usable IndexedDB still starts normally (see `restoreSavedGame`).
    provideAppInitializer(() => inject(GameControllerService).restoreSavedGame()),
    provideRouter(routes),
    provideHttpClient(),
    provideServiceWorker('ngsw-worker.js', {
      // Also off under navigator.webdriver (true for Cypress/Selenium/Playwright, never for a
      // real user's browser — see TriviaService.initOfflinePrefetch for the fuller rationale on
      // this same check): registering the service worker measurably slowed down real-preview
      // e2e's Firebase Auth-dependent specs even after the offline-prefetch task itself was
      // gated off the same way (profile.cy.ts's two tests went from ~7s combined to 46s+ with a
      // timeout, sign-in-save-score.cy.ts from ~55s to 1m+ with a timeout, confirmed against a
      // clean baseline run with no PWA changes at all) — installing/activating the worker and
      // its integrity-checking the precached app shell is real, uninteresting-to-these-specs
      // work competing for the same main thread and network as Firebase's own calls.
      enabled: !isDevMode() && !navigator.webdriver,
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
