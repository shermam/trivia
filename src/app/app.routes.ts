import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./components/game-setup/game-setup.component').then((m) => m.GameSetupComponent),
  },
  {
    path: 'play',
    loadComponent: () =>
      import('./components/quiz-loop/quiz-loop.component').then((m) => m.QuizLoopComponent),
  },
  {
    path: 'game-over',
    loadComponent: () =>
      import('./components/game-over/game-over.component').then((m) => m.GameOverComponent),
  },
  {
    path: 'add-question',
    loadComponent: () =>
      import('./components/add-question/add-question.component').then(
        (m) => m.AddQuestionComponent,
      ),
  },
  { path: '**', redirectTo: '' },
];
