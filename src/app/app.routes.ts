import { Routes } from '@angular/router';
import { hasActiveGameGuard, hasCompletedGameGuard } from './guards/game-state.guards';
import { routeTitle } from './i18n/route-title';

/**
 * Every route carries a `title`. It sets the browser tab, and `AppTitleStrategy`
 * also reads it out to assistive tech on navigation — client-side routing is
 * otherwise completely silent (finding G5). A route added without one is a
 * screen that announces nothing, which `app.spec.ts` fails on.
 *
 * The title is a message key, written through `routeTitle()` with its English
 * beside it: the strategy renders it in the reader's language and tells a new
 * screen from the same one by its key.
 */

export const routes: Routes = [
  {
    path: '',
    title: routeTitle('route.setup', 'Start a game'),
    loadComponent: () =>
      import('./components/game-setup/game-setup.component').then((m) => m.GameSetupComponent),
  },
  {
    path: 'play',
    title: routeTitle('route.play', 'Play'),
    canActivate: [hasActiveGameGuard],
    loadComponent: () =>
      import('./components/quiz-loop/quiz-loop.component').then((m) => m.QuizLoopComponent),
  },
  {
    path: 'game-over',
    title: routeTitle('route.gameOver', 'Game over'),
    canActivate: [hasCompletedGameGuard],
    loadComponent: () =>
      import('./components/game-over/game-over.component').then((m) => m.GameOverComponent),
  },
  {
    // A curated quiz (`FEAT-024`), addressed by its document id. Lazy and
    // outside the precache like every route a game does not need offline: a
    // quiz is read from Firestore before it can start, so its screen has
    // nothing to show without a connection (`ngsw-config.json`).
    path: 'quiz/:quizId',
    title: routeTitle('route.quiz', 'Curated quiz'),
    loadComponent: () =>
      import('./components/quiz-detail/quiz-detail.component').then((m) => m.QuizDetailComponent),
  },
  {
    path: 'add-question',
    title: routeTitle('route.addQuestion', 'Add a question'),
    loadComponent: () =>
      import('./components/add-question/add-question.component').then(
        (m) => m.AddQuestionComponent,
      ),
  },
  {
    path: 'my-questions',
    title: routeTitle('route.myQuestions', 'Your questions'),
    loadComponent: () =>
      import('./components/my-questions/my-questions.component').then(
        (m) => m.MyQuestionsComponent,
      ),
  },
  {
    path: 'review',
    title: routeTitle('route.review', 'Review queue'),
    loadComponent: () =>
      import('./components/review-queue/review-queue.component').then(
        (m) => m.ReviewQueueComponent,
      ),
  },
  {
    path: 'profile',
    title: routeTitle('route.profile', 'Your stats'),
    loadComponent: () =>
      import('./components/profile-stats/profile-stats.component').then(
        (m) => m.ProfileStatsComponent,
      ),
  },
  {
    path: 'pricing',
    title: routeTitle('route.pricing', 'Pricing'),
    loadComponent: () =>
      import('./components/pricing/pricing.component').then((m) => m.PricingComponent),
  },
  {
    path: 'privacy',
    title: routeTitle('route.privacy', 'Privacy Policy'),
    loadComponent: () =>
      import('./components/legal/privacy-policy.component').then((m) => m.PrivacyPolicyComponent),
  },
  {
    path: 'terms',
    title: routeTitle('route.terms', 'Terms of Service'),
    loadComponent: () =>
      import('./components/legal/terms-of-service.component').then(
        (m) => m.TermsOfServiceComponent,
      ),
  },
  { path: '**', redirectTo: '' },
];
