import { expect, test } from '../../fixtures/test';
import { CustomQuestionSeed } from '../../fixtures/types';
import { signInViaUi } from '../../support/auth';
import { answerQuestion, optionLabel, waitForPlayRoute } from '../../support/game';
import { waitForGameplayStats } from '../../support/gameplay-stats';
import { stubOpenTrivia } from '../../support/open-trivia';
import { runTag } from '../../support/topics';

const password = 'Str0ngPassw0rd!';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * What a curated quiz banks for a signed-in player (`FEAT-024`): everything a
 * drawn game does, and no leaderboard entry.
 *
 * **A quiz is a game** (`FEAT-049` §0): `recordGameResult` runs exactly as it
 * does for a draw, so the play history, the lifetime totals and the questions'
 * difficulty counters all move. **A quiz is not ranked** (administrator
 * decision, 8 October 2026): the results screen shows the quiz face in place of
 * the save form a verified account is otherwise offered, and nothing writes to
 * any board. The save form is the only thing in the app that writes a
 * leaderboard entry, so the absence is asserted after everything the screen
 * does has visibly landed — the totals — rather than after nothing.
 *
 * Emulator-only, like every `authenticated/` spec the preview config does not
 * list: it drives the real project's `recordGameResult`, which a preview
 * channel shares rather than owns (`docs/ci-cd.md` §4.2a).
 */
test.describe('a curated quiz’s results, signed in', () => {
  test('bank the game like any other and put nothing on a leaderboard', async ({
    page,
    firebase,
  }) => {
    const email = `quiz-${unique()}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password });

    const runId = unique();
    const tag = runTag('quiz-results');
    const questions: (CustomQuestionSeed & { id: string })[] = ['b', 'c', 'a'].map((label) => ({
      id: `quiz-results-${runId}-${label}`,
      tags: [tag],
      type: 'multiple',
      difficulty: 'medium',
      question: `Quiz results question ${label} (${runId})?`,
      correct_answer: `Right ${label}`,
      incorrect_answers: [`Wrong ${label} 1`, `Wrong ${label} 2`, `Wrong ${label} 3`],
    }));
    await firebase.seedCustomQuestions(questions);
    const quizId = `e2e-results-${runId}`;
    await firebase.seedQuiz({
      id: quizId,
      title: `Banked ${runId}`,
      questionIds: questions.map((question) => question.id),
    });

    await stubOpenTrivia(page);
    await page.goto(`/quiz/${quizId}`);
    await signInViaUi(page, email, password);
    await expect(page.getByTestId('quiz-question-count')).toContainText('3 questions');

    // No countdown, so a slow runner cannot time a question out and turn the
    // totals below into a measure of the runner.
    await optionLabel(page, page.getByTestId('quiz-time-limit-unlimited')).click();
    await page.getByTestId('start-quiz').click();
    await waitForPlayRoute(page);

    for (const question of questions) {
      await expect(page.getByTestId('question-text')).toHaveText(question.question);
      await answerQuestion(page, question.correct_answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);

    // The face a verified account would otherwise get is the save form.
    await expect(page.getByTestId('score-quiz')).toBeVisible();
    await expect(page.getByTestId('score-save')).toBeHidden();
    await expect(page.getByTestId('leaderboard-card')).toHaveCount(0);

    // Banked like any game: one play, in the quiz's order, every answer kept…
    await expect
      .poll(async () => (await firebase.getPlayHistory(uid)).length, {
        message: 'the quiz never reached the play history — was recordGameResult called?',
      })
      .toBe(1);
    const [play] = await firebase.getPlayHistory(uid);
    expect(play.answers.map((answer) => answer.questionId)).toEqual(
      questions.map((question) => question.id),
    );
    expect(play.answers.every((answer) => answer.correct)).toBe(true);
    expect(play.answers.map((answer) => answer.tags)).toEqual(questions.map(() => [tag]));

    // …the lifetime totals…
    expect(await waitForGameplayStats(firebase, uid)).toMatchObject({
      gamesPlayed: 1,
      questionsAnswered: 3,
      correctAnswers: 3,
    });

    // …and each question's difficulty counters (`FEAT-023`).
    await expect
      .poll(() => firebase.getQuestionCounters(questions.map((question) => question.id)), {
        message: 'the counters never moved for the quiz’s questions',
      })
      .toEqual(
        Object.fromEntries(questions.map((question) => [question.id, { answered: 1, correct: 1 }])),
      );

    // Read after all of that has landed, so "no entry" cannot mean "not yet".
    const state = await firebase.inspectAccountState({ uid });
    expect(state.leaderboardExists, 'a leaderboard entry on any board').toBe(false);
  });
});
