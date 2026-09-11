import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { expectRadiosAreGrouped } from '../../support/a11y';
import { answerQuestion, optionLabel, waitForPlayRoute } from '../../support/game';
import { CORRECT_ANSWERS, stubOpenTrivia } from '../../support/open-trivia';

/**
 * Finding G7. A 15-second limit that cannot be adjusted, extended or turned
 * off fails WCAG 2.2.1. The unit tests cover the countdown arithmetic; what
 * only a browser can show is that the choice actually reaches the quiz, that
 * an unlimited game really has no deadline, and that game-over then names the
 * board the score belongs to.
 */
test.describe('choosing a time limit', () => {
  /**
   * Picks a limit and starts a game on it.
   *
   * The radios are `sr-only`, so the label is both the real gesture and the
   * one that needs no `force` — see `optionLabel` for why that distinction is
   * worth keeping.
   */
  async function startWith(page: Page, limit: '15' | '30' | 'unlimited'): Promise<void> {
    await stubOpenTrivia(page);
    await page.goto('/');
    await page.locator('#amount').selectOption({ label: '5' });
    await optionLabel(page, page.getByTestId(`time-limit-${limit}`)).click();
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();
    await waitForPlayRoute(page);
  }

  test('defaults to 15 seconds and says which board that ranks on', async ({ page }) => {
    await stubOpenTrivia(page);
    await page.goto('/');

    await expect(page.getByTestId('time-limit-15')).toBeChecked();
    await expect(page.getByTestId('time-limit-note')).toContainText('15-second leaderboard');

    // The picker is a labelled radiogroup, same contract as Question Source
    // (G4) — swept generically so a fourth option would be covered too.
    await expectRadiosAreGrouped(page);
  });

  test('says the no-limit choice ranks separately, before the game starts', async ({ page }) => {
    await stubOpenTrivia(page);
    await page.goto('/');

    await optionLabel(page, page.getByTestId('time-limit-unlimited')).click();
    await expect(page.getByTestId('time-limit-note')).toContainText('no-limit leaderboard');
  });

  test('counts down from 30 when 30 is chosen', async ({ page }) => {
    await startWith(page, '30');
    // The ring renders the chosen limit, not a hard-coded 15.
    await expect(page.getByTestId('question-timer')).toContainText('30s');
  });

  /*
   * The criterion itself, in a real browser: no countdown element at all, and
   * the question still unanswered after longer than any timed game would have
   * allowed.
   *
   * Real time, deliberately. `page.clock` could fast-forward this and save
   * eighteen seconds, at the price of replacing `Date` and every timer
   * function for the whole page — Firebase Auth's own token machinery
   * included — in a test whose entire point is that no deadline exists. A
   * wall clock states that directly, and the app's countdown reads the wall
   * clock too (`CLAUDE.md` §4.4), so a faked one would not be testing the same
   * mechanism.
   */
  test('never runs a countdown, or auto-answers, without a limit', async ({ page }) => {
    await startWith(page, 'unlimited');

    await expect(page.getByTestId('question-timer')).toHaveCount(0);
    await expect(page.getByTestId('no-time-limit')).toContainText('No time limit');

    const servedQuestion = normalize(await page.getByTestId('question-text').textContent());

    // Longer than the 15s default and its 2s auto-advance combined.
    await page.waitForTimeout(18_000);

    // Same question, still unanswered: nothing expired underneath us.
    await expect(page.getByTestId('question-text')).toHaveText(servedQuestion);
    await expect(page.getByTestId('result-status')).not.toContainText("Time's up");
    await expect(page.getByText('Question 1 / 5')).toBeVisible();
  });

  test('carries the choice through to the board named at game over', async ({ page }) => {
    await startWith(page, 'unlimited');
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }

    await expect(page).toHaveURL(/\/game-over$/);
    await expect(page.getByRole('heading', { name: 'Game Over!', exact: true })).toBeVisible();
    await expect(page.getByTestId('leaderboard-title')).toContainText('no-limit');
  });

  /*
   * A reload test belongs here — the limit is part of the persisted game (B8),
   * so a refresh must not silently move the player onto a different board —
   * and it is deliberately NOT here. It lives in `game-resume.cy.ts` instead,
   * which owns the whole of B8's persistence; the limit's own round trip
   * through save and restore is covered directly in
   * `game-controller.service.spec.ts` ("carries an unlimited time limit
   * through a reload").
   */
});

/**
 * Collapses the whitespace an Angular interpolation leaves around its text.
 *
 * `toHaveText(string)` normalizes the element's text and compares it to the
 * expected string **as given**, so a raw `textContent()` — newline, indent,
 * value, newline, indent — never matches the element it was just read from.
 */
function normalize(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}
