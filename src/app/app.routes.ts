import { Routes } from '@angular/router';
import { hasActiveGameGuard, hasCompletedGameGuard } from './guards/game-state.guards';

/**
 * Every route carries a `title`. It sets the browser tab, and `AppTitleStrategy`
 * also reads it out to assistive tech on navigation — client-side routing is
 * otherwise completely silent (finding G5). A route added without one is a
 * screen that announces nothing, which `app.spec.ts` fails on.
 */

export const routes: Routes = [
  {
    path: '',
    title: 'Start a game',
    loadComponent: () =>
      import('./components/game-setup/game-setup.component').then((m) => m.GameSetupComponent),
  },
  {
    path: 'play',
    title: 'Play',
    canActivate: [hasActiveGameGuard],
    loadComponent: () =>
      import('./components/quiz-loop/quiz-loop.component').then((m) => m.QuizLoopComponent),
  },
  {
    path: 'game-over',
    title: 'Game over',
    canActivate: [hasCompletedGameGuard],
    loadComponent: () =>
      import('./components/game-over/game-over.component').then((m) => m.GameOverComponent),
  },
  {
    path: 'add-question',
    title: 'Add a question',
    loadComponent: () =>
      import('./components/add-question/add-question.component').then(
        (m) => m.AddQuestionComponent,
      ),
  },
  {
    path: 'review',
    title: 'Review queue',
    loadComponent: () =>
      import('./components/review-queue/review-queue.component').then(
        (m) => m.ReviewQueueComponent,
      ),
  },
  {
    path: 'pricing',
    title: 'Pricing',
    loadComponent: () =>
      import('./components/pricing/pricing.component').then((m) => m.PricingComponent),
  },
  {
    path: 'privacy',
    title: 'Privacy Policy',
    loadComponent: () =>
      import('./components/legal/privacy-policy.component').then((m) => m.PrivacyPolicyComponent),
  },
  {
    path: 'terms',
    title: 'Terms of Service',
    loadComponent: () =>
      import('./components/legal/terms-of-service.component').then(
        (m) => m.TermsOfServiceComponent,
      ),
  },
  { path: '**', redirectTo: '' },
];
