import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { signInViaUi } from '../../support/auth';
import { optionLabel, waitForPlayRoute } from '../../support/game';
import { stubExtraCategory, stubOpenTrivia } from '../../support/open-trivia';

/**
 * `FEAT-022`. A contributor can say where an answer comes from and why it is
 * the answer; a reviewer and a player can read both.
 *
 * Three seams, none of which any cheaper layer reaches:
 *
 * - **The rules accept the widened document.** The rules suite proves
 *   `isValidCustomQuestion()` admits `sourceUrl`/`sourceTitle`/`explanation`,
 *   but it builds the payload by hand. Only this proves the payload the *form*
 *   builds is the one the rules were widened for — the two have disagreed
 *   before, and a mismatch surfaces as a bare `permission-denied` with the
 *   contributor's work lost.
 * - **The reviewer's card renders them.** This is where the feature earns its
 *   keep: a reviewer who cannot check the source or read the reasoning is
 *   approving on vibes.
 * - **The recap renders them, and renders nothing without them.** The negative
 *   half matters as much as the positive: the common case is a question with
 *   no attribution at all, and a badge, placeholder or empty row there would
 *   be a regression for every Open Trivia DB question in the app.
 *
 * Under `authenticated/` deliberately, and not because of auth: the third test
 * seeds questions and the first submits one through the UI, which gives it a
 * Firestore auto-id that reaches no sweep list. `playwright.preview.config.ts`
 * takes everything under `unauthenticated/` automatically and only two named
 * specs from `authenticated/`, so the directory is what keeps this file off the
 * real `trivimind-dev` project (`docs/ci-cd.md` §4.3).
 */
test.describe('question source attribution', () => {
  const password = 'correct horse battery staple';

  /**
   * Everything this file writes is keyed on a tag unique to the test, and that
   * is the whole of its isolation. Workers share one emulator with no
   * `resetBackend()`, so `custom_questions` holds every other test's rows: an
   * email address, a queue row matched by its question text and a
   * custom-source game are all global unless the test makes them its own.
   */
  let tag: string;

  test.beforeEach(async ({ page }) => {
    tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await stubOpenTrivia(page);
  });

  /**
   * One account that is both Pro and a reviewer, which is how
   * `review-queue.spec.ts` already does the author-to-reviewer handoff — and
   * the reason is worth knowing rather than copying. Signing in as a second
   * account inside one test does not work: `signInViaUi` opens the auth menu
   * and waits for "Already have an account? Sign in", which is not there while
   * somebody is still signed in, so it times out naming a button rather than
   * the sign-out that never happened. Signing out first is possible but races
   * the async re-anonymous-sign-in that `sign-up-verify` already had to work
   * around. Reviewing your own submission is not the production flow, but the
   * claim under test is that the card renders what Firestore stored, and the
   * account that stored it is immaterial to that.
   */
  test('accepts a cited question through the real rules, and shows the reviewer both', async ({
    page,
    firebase,
  }) => {
    const email = `source-reviewer-${tag}@example.com`;
    const questionText = `What is the chemical symbol for water? (${tag})`;
    const justification = 'CO2, O2 and NaCl are all real molecules, which is what makes it tricky.';

    const { uid } = await firebase.createVerifiedUser({ email, password });
    await firebase.seedReviewer({ uid, reviewer: true });
    await firebase.setProSubscription({ uid });
    await page.goto('/');
    await signInViaUi(page, email, password);

    await page.goto('/add-question');
    await page.locator('#category').fill('Science');
    await page.locator('#question').fill(questionText);
    await page.locator('#correctAnswer').fill('H2O');
    await page.getByPlaceholder('Incorrect answer 1', { exact: true }).fill('CO2');
    await page.getByPlaceholder('Incorrect answer 2', { exact: true }).fill('O2');
    await page.getByPlaceholder('Incorrect answer 3', { exact: true }).fill('NaCl');
    await page.getByTestId('source-url').fill('https://example.org/water');
    await page.getByTestId('source-title').fill('Example Journal');
    await page.getByTestId('justification').fill(justification);
    await page.getByRole('button', { name: 'Add Question', exact: true }).click();

    // The assertion that matters first: the write was accepted. A `hasOnly()`
    // allowlist that had not been widened would land here as the form's
    // generic failure message instead.
    await expect(
      page.getByText('Thanks! Your question has been submitted for review.'),
    ).toBeVisible();

    // Now the other end of the same document, rendered from what Firestore
    // actually stored rather than from anything this test held onto.
    await page.goto('/review');
    const card = page.getByTestId('review-question').filter({ hasText: tag });
    await expect(card).toHaveCount(1);

    // Each attribute through its own retrying matcher rather than one
    // `evaluate` reading them all: a one-shot read is not an assertion
    // (`CLAUDE.md` §4.6), and the card renders after a Firestore round trip.
    const link = card.getByTestId('question-source-link');
    await expect(link).toHaveAttribute('href', 'https://example.org/water');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toContainText('Example Journal');

    await expect(card.getByTestId('question-justification')).toContainText(justification);
  });

  test('refuses a malformed source link in the form, naming the field', async ({
    page,
    firebase,
  }) => {
    const email = `source-bad-${tag}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password });
    await firebase.setProSubscription({ uid });
    await page.goto('/');
    await signInViaUi(page, email, password);

    await page.goto('/add-question');
    await page.locator('#category').fill('Science');
    await page.locator('#question').fill(`What planet is known as the Red Planet? (${tag})`);
    await page.locator('#correctAnswer').fill('Mars');
    await page.getByPlaceholder('Incorrect answer 1', { exact: true }).fill('Venus');
    await page.getByPlaceholder('Incorrect answer 2', { exact: true }).fill('Jupiter');
    await page.getByPlaceholder('Incorrect answer 3', { exact: true }).fill('Saturn');
    await page.getByTestId('source-url').fill('example.org/mars');
    await page.getByRole('button', { name: 'Add Question', exact: true }).click();

    // Named and focused, not a silent no-op: the whole reason the source
    // controls are in `fieldLabels`.
    await expect(page.getByTestId('source-url-error')).toBeVisible();
    await expect(page.locator('#sourceUrl')).toBeFocused();
    await expect(
      page.getByText('Thanks! Your question has been submitted for review.'),
    ).toHaveCount(0);
  });

  test('offers the source and the justification in the recap, and nothing without them', async ({
    page,
    firebase,
  }) => {
    const category = `Sourced ${tag}`;
    const sourcedText = `What is the chemical symbol for water? (${tag})`;
    const plainText = `What planet is known as the Red Planet? (${tag})`;
    const justification = 'Water is two hydrogens bonded to one oxygen.';

    await stubExtraCategory(page, category);
    await firebase.seedCustomQuestions([
      {
        id: `sourced-${tag}`,
        category,
        type: 'multiple',
        difficulty: 'easy',
        question: sourcedText,
        correct_answer: 'H2O',
        incorrect_answers: ['CO2', 'O2', 'NaCl'],
        createdBy: 'someone-else',
        createdAt: Date.now(),
        sourceUrl: 'https://example.org/water',
        sourceTitle: 'Example Journal',
        explanation: justification,
      },
      {
        id: `plain-${tag}`,
        category,
        type: 'multiple',
        difficulty: 'easy',
        question: plainText,
        correct_answer: 'Mars',
        incorrect_answers: ['Venus', 'Jupiter', 'Saturn'],
        createdBy: 'someone-else',
        createdAt: Date.now(),
      },
    ]);

    await startCustomGame(page, category);
    await playToGameOver(page);

    await page.getByTestId('recap-toggle').click();
    const rows = page.getByTestId('recap-row');
    await expect(rows).toHaveCount(2);

    const sourced = rows.filter({ hasText: 'chemical symbol for water' });
    const link = sourced.getByTestId('question-source-link');
    await expect(link).toHaveAttribute('href', 'https://example.org/water');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toContainText('Example Journal');
    await expect(sourced.getByTestId('question-justification')).toContainText(justification);

    // The common case, and the one a placeholder would quietly ruin. Anchored
    // on a positive assertion first: a "does not exist" check placed alone
    // after a navigation is satisfied by a screen that has not rendered yet.
    const plain = rows.filter({ hasText: 'Red Planet' });
    await expect(plain).toContainText('Red Planet');
    await expect(plain.getByTestId('question-source')).toHaveCount(0);
    await expect(plain.getByTestId('question-justification')).toHaveCount(0);
  });
});

/**
 * Starts a **Custom** game in this test's own category.
 *
 * Not `startGame`, which uses the Open Trivia source and never reads
 * `custom_questions` at all — the recap assertions after that would hold no
 * matter what this feature did, because an Open Trivia question carries no
 * source and never will. The category is what makes the draw deterministic:
 * `getCustomQuestions` filters on it server-side, so a category only this test
 * has written to holds only this test's two questions however busy the shared
 * bank is.
 */
async function startCustomGame(page: Page, category: string): Promise<void> {
  await page.goto('/');
  await page.locator('#amount').selectOption({ label: '5' });
  // Retries until the stubbed category list has actually populated the picker.
  await page.locator('#category').selectOption(category);
  await optionLabel(page, page.getByRole('radio', { name: 'Custom', exact: true })).click();
  await page.getByRole('button', { name: 'Start Game', exact: true }).click();
  await waitForPlayRoute(page);
}

/**
 * Answers whatever is on screen until the game ends — two questions, because
 * that is all this test's category holds however many were asked for.
 *
 * The answer is taken by position rather than by text, which is safe for a
 * reason worth naming: answering disables **every** option
 * (`[disabled]="isAnswered() || …"`) until the next question renders, and
 * Playwright's click waits for an enabled element. So the second call cannot
 * land on the question the first one just answered while the result banner is
 * still up — the wait is the app's own disabled state rather than a sleep.
 * Which option is correct is immaterial: the recap renders a source and a
 * justification on a row whether the player got it right or wrong.
 */
async function playToGameOver(page: Page): Promise<void> {
  await page.getByTestId('answer-option').first().click();
  await page.getByTestId('answer-option').first().click();
  await expect(page).toHaveURL(/\/game-over$/);
}
