import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { answerQuestion, optionLabel, waitForPlayRoute } from '../../support/game';
import { expectSameHeight, settledHeight } from '../../support/layout';
import { CORRECT_ANSWERS, questionsFixture, stubOpenTrivia } from '../../support/open-trivia';

/**
 * `FEAT-004` — the streak badge and what a multiplied round adds up to.
 *
 * The arithmetic is covered by `scoring.spec.ts` and the bookkeeping by
 * `game-controller.service.spec.ts`; what only a real browser can show is that
 * the badge appears without moving anything around it, and that the numbers a
 * player watches climb during the round are the numbers the results screen then
 * reports. jsdom has no layout, so the first of those is invisible to every
 * other layer (`CLAUDE.md` §4.4).
 *
 * **Played with no time limit, deliberately.** These tests stop between
 * questions to read a badge, and a 15-second countdown running underneath would
 * make the deadline the subject of a test about something else — the failure
 * mode `ci-cd.md` §4.3 records as the one that hides a real defect behind a
 * timeout. The board a game ranks on is irrelevant here: nothing is saved.
 * `streak-leaderboard.spec.ts` covers the timed board and the save.
 *
 * Nothing here writes to Firestore, so the spec is safe in the preview slice
 * alongside the rest of `unauthenticated/`.
 */
test.describe('streak bonuses and score multipliers', () => {
  /** Starts an unlimited game of five, so no countdown runs while a test reads. */
  async function startUntimedGame(page: Page): Promise<void> {
    await stubOpenTrivia(page);
    await page.goto('/');
    await page.locator('#amount').selectOption({ label: '5' });
    await optionLabel(page, page.getByTestId('time-limit-unlimited')).click();
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();
    await waitForPlayRoute(page);
  }

  const badge = (page: Page) => page.getByTestId('streak-indicator');

  test('shows the run and its multiplier as the streak builds', async ({ page }) => {
    await startUntimedGame(page);

    // In the DOM from the first question — only `visibility` moves, which is
    // what stops the badge row re-wrapping mid-round.
    await expect(badge(page)).toHaveCount(1);
    await expect(badge(page)).toBeHidden();

    await answerQuestion(page, CORRECT_ANSWERS[0]);
    await expect(page.getByText('Question 2 / 5')).toBeVisible();
    await expect(badge(page)).toBeHidden();

    await answerQuestion(page, CORRECT_ANSWERS[1]);
    await expect(page.getByText('Question 3 / 5')).toBeVisible();
    await expect(badge(page)).toBeVisible();
    await expect(page.getByTestId('streak-count')).toHaveText('2');
    // Two in a row is a streak worth showing and not yet worth a bonus.
    await expect(page.getByTestId('streak-multiplier')).toHaveText('×1.0');
    await expect(page.getByText('Score: 2')).toBeVisible();

    // The third consecutive correct answer is the first to earn 1.5×, so the
    // score moves by more than the one point the answer is nominally worth.
    await answerQuestion(page, CORRECT_ANSWERS[2]);
    await expect(page.getByText('Question 4 / 5')).toBeVisible();
    await expect(page.getByTestId('streak-count')).toHaveText('3');
    await expect(page.getByTestId('streak-multiplier')).toHaveText('×1.5');
    await expect(page.getByText('Score: 4')).toBeVisible();
  });

  test('resets the run on a wrong answer and starts it again', async ({ page }) => {
    await startUntimedGame(page);

    await answerQuestion(page, CORRECT_ANSWERS[0]);
    await answerQuestion(page, CORRECT_ANSWERS[1]);
    await expect(badge(page)).toBeVisible();

    await answerQuestion(page, questionsFixture.results[2].incorrect_answers[0]);
    await expect(page.getByText('Question 4 / 5')).toBeVisible();
    await expect(badge(page)).toBeHidden();
    // The two points already banked are not taken back — only the run is.
    await expect(page.getByText('Score: 2')).toBeVisible();

    await answerQuestion(page, CORRECT_ANSWERS[3]);
    await answerQuestion(page, CORRECT_ANSWERS[4]);
    await expect(page).toHaveURL(/\/game-over$/);
    await expect(page.getByTestId('max-streak')).toHaveText('2');
  });

  /**
   * A skip neither breaks nor extends the run (`FEAT-004`), which is the rule
   * that cannot be recovered from the answer history afterwards — the recap
   * records a skip as a question nobody got right.
   */
  test('carries the run across a skipped question', async ({ page }) => {
    await startUntimedGame(page);

    await answerQuestion(page, CORRECT_ANSWERS[0]);
    await answerQuestion(page, CORRECT_ANSWERS[1]);
    await page.getByTestId('lifeline-skip').click();
    await expect(page.getByText('Question 4 / 5')).toBeVisible();

    // Still two, not reset and not advanced: the skip did neither.
    await expect(page.getByTestId('streak-count')).toHaveText('2');

    await answerQuestion(page, CORRECT_ANSWERS[3]);
    await expect(page.getByTestId('streak-count')).toHaveText('3');
    await expect(page.getByTestId('streak-multiplier')).toHaveText('×1.5');
  });

  /**
   * The badge sits in the wrapping row beside the category and difficulty
   * pills, so what would break is that row growing a line the moment a streak
   * starts — pushing the question and every answer below it down the screen,
   * under the reader's eye, mid-round.
   *
   * **The row's own height, not a document position.** The quiz card is
   * vertically centred, so every box in it moves by half of any change in the
   * card's total height — and the fixture's questions differ in how many
   * options they have and how many lines they wrap to. A document-relative
   * reading therefore shows an 81px move between question 1 and question 3
   * whatever the badge does, which is a measurement of the fixture rather than
   * of the feature. The row is the thing the badge is inside; its height is the
   * thing the badge can change.
   *
   * **320px is the width that makes this a test rather than a formality.** The
   * three pills fit on one line on a larger phone, so a conditionally-rendered
   * badge would measure no change there and the check would call the bug fixed
   * while it was broken — the viewport trap `CLAUDE.md` §4.4 records. At 320px
   * the row wraps, and it wraps the same way on every question precisely
   * because the badge is rendered on every question. Mutation-checked by
   * wrapping the badge in an `@if`, which fails this and nothing else.
   */
  test('does not resize the badge row when the streak appears', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await startUntimedGame(page);

    const row = page.getByTestId('question-badges');
    const before = await settledHeight(row, 'the question badge row');

    await answerQuestion(page, CORRECT_ANSWERS[0]);
    await answerQuestion(page, CORRECT_ANSWERS[1]);
    await expect(page.getByText('Question 3 / 5')).toBeVisible();
    await expect(badge(page)).toBeVisible();

    await expectSameHeight(row, before, 'the question badge row with a streak showing');
  });

  test('reports the multiplied score, raw accuracy and the best run at game over', async ({
    page,
  }) => {
    await startUntimedGame(page);

    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);

    // 1 + 1 + 1.5 + 1.5 + 2 — a perfect five-question round is worth seven
    // points, which is the whole point of the feature and the reason
    // `firestore.rules` had to widen to accept it.
    await expect(page.getByTestId('final-score')).toHaveText('7');
    await expect(page.getByTestId('correct-answers')).toHaveText('5 / 5');
    await expect(page.getByTestId('max-streak')).toHaveText('5');
    // Accuracy is never multiplied: five of five is 100%, not 140%.
    await expect(page.getByText('100%', { exact: true })).toBeVisible();
  });
});
