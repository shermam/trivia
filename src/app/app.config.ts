import { ApplicationConfig, isDevMode, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
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
