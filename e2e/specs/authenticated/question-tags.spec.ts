import { expect, test } from '../../fixtures/test';
import { signInViaUi } from '../../support/auth';
import { stubOpenTrivia } from '../../support/open-trivia';

/**
 * `FEAT-021`, the write half: a contributor tags their own question, a reviewer
 * sees the tags, and an author editing that question keeps them.
 *
 * Three seams, and each has already been the shape of a real bug in this
 * repository:
 *
 * - **The rules accept the widened document.** The rules suite proves
 *   `isValidQuestionShape()` admits a `tags` list, but it builds the payload by
 *   hand. Only this proves the payload the **form** builds is the one the rules
 *   were widened for — a mismatch surfaces as a bare `permission-denied` with
 *   the contributor's work lost.
 * - **The chips reach the reviewer's card**, rendered from what Firestore
 *   stored rather than from anything the test held onto.
 * - **An edit keeps them.** An owner update rewrites the whole document, so a
 *   field the edit dialog does not carry is a field the edit silently deletes —
 *   which is exactly how a Markdown question came back rendering its own
 *   asterisks (`FEAT-019`). A retagged-to-nothing question would be invisible to
 *   every tag-filtered game with nothing on screen to say so.
 *
 * Under `authenticated/` deliberately, and not only because of auth: this
 * submits a question through the UI, which gives it a Firestore auto-id that
 * reaches no sweep list. `playwright.preview.config.ts` takes everything under
 * `unauthenticated/` automatically and only two named specs from here, so the
 * directory is what keeps this file off the real `trivimind-dev` project
 * (`docs/ci-cd.md` §4.3).
 */
test.describe('topic tags on a contributed question', () => {
  const password = 'correct horse battery staple';

  /**
   * Everything this file writes is keyed on a tag unique to the test, which is
   * the whole of its isolation: workers share one emulator with no
   * `resetBackend()`, so `custom_questions` holds every other test's rows.
   */
  let runTag: string;

  test.beforeEach(async ({ page }) => {
    runTag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await stubOpenTrivia(page);
  });

  /**
   * One account that is both Pro and a reviewer, the same author-to-reviewer
   * handoff `review-queue.spec.ts` uses: signing in as a second account inside
   * one test races the anonymous re-sign-in, and the claim under test is that
   * the card renders what Firestore stored, which the account is immaterial to.
   */
  test('accepts tags through the real rules and shows them to the reviewer', async ({
    page,
    firebase,
  }) => {
    const email = `tags-reviewer-${runTag}@example.com`;
    const questionText = `Which treaty ended the First World War? (${runTag})`;

    const { uid } = await firebase.createVerifiedUser({ email, password });
    await firebase.seedReviewer({ uid, reviewer: true });
    await firebase.setProSubscription({ uid });
    await page.goto('/');
    await signInViaUi(page, email, password);

    await page.goto('/add-question');
    await page.locator('#category').fill('History');
    await page.locator('#question').fill(questionText);
    await page.locator('#correctAnswer').fill('Versailles');
    await page.getByPlaceholder('Incorrect answer 1', { exact: true }).fill('Trianon');
    await page.getByPlaceholder('Incorrect answer 2', { exact: true }).fill('Utrecht');
    await page.getByPlaceholder('Incorrect answer 3', { exact: true }).fill('Ghent');

    // Typed the way a contributor types, not already normalised — the chip that
    // appears is the promise that nobody is surprised by what lands.
    const input = page.getByTestId('tag-input');
    await input.fill('World War 1');
    await input.press('Enter');
    // Addressed as a *chosen chip*, not by its text: `world-war-1` is also a
    // suggestion, so a text query would match the pressed suggestion button
    // too and Playwright would refuse to guess (`CLAUDE.md` §4.6).
    await expect(page.getByTestId('tag-selector').getByTestId('selected-tag')).toHaveText([
      '#world-war-1',
    ]);
    // ...and a suggestion, which is the other route in.
    await page.getByTestId('suggest-tag-cold-war').click();

    await page.getByRole('button', { name: 'Add Question', exact: true }).click();

    // The assertion that matters first: the write was accepted. A `hasOnly()`
    // allowlist that had not been widened lands here as the form's generic
    // failure message instead.
    await expect(
      page.getByText('Thanks! Your question has been submitted for review.'),
    ).toBeVisible();

    await page.goto('/review');
    const card = page.getByTestId('review-question').filter({ hasText: runTag });
    await expect(card).toHaveCount(1);

    const chips = card.getByTestId('review-question-tags');
    await expect(chips).toHaveAttribute('aria-label', 'Topics');
    await expect(chips.getByTestId('question-tag')).toHaveText(['#world-war-1', '#cold-war']);
  });

  test('keeps the tags when the author edits the question, and lets them change', async ({
    page,
    firebase,
  }) => {
    const email = `tags-author-${runTag}@example.com`;
    const questionId = `tags-edit-${runTag}`;
    const questionText = `Which treaty ended the Thirty Years' War? (${runTag})`;

    const { uid } = await firebase.createVerifiedUser({ email, password });
    await firebase.setProSubscription({ uid });
    await firebase.seedCustomQuestions([
      {
        id: questionId,
        category: 'History',
        type: 'multiple',
        difficulty: 'easy',
        question: questionText,
        correct_answer: 'Westphalia',
        incorrect_answers: ['Versailles', 'Utrecht', 'Ghent'],
        createdBy: uid,
        createdAt: Date.now(),
        status: 'approved',
        tags: ['treaties', 'early-modern'],
      },
    ]);

    await page.goto('/');
    await signInViaUi(page, email, password);
    await page.goto('/my-questions');

    const row = page.getByTestId('my-question').filter({ hasText: runTag });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('my-question-tags').getByTestId('question-tag')).toHaveText([
      '#treaties',
      '#early-modern',
    ]);

    await row.getByTestId('edit-question').click();
    const dialog = page.getByTestId('edit-question-dialog');
    // The dialog opens carrying them, which is the half an owner update would
    // otherwise delete without saying so.
    await expect(dialog.getByTestId('edit-tag-selector').getByTestId('selected-tag')).toHaveText([
      '#treaties',
      '#early-modern',
    ]);

    await dialog.getByRole('button', { name: 'Remove tag early-modern', exact: true }).click();
    const editInput = dialog.getByTestId('edit-tag-input');
    await editInput.fill('Peace of Westphalia');
    await editInput.press('Enter');
    await dialog.getByTestId('save-question').click();

    // Back on the list, rendered from the document Firestore now holds.
    await expect(dialog).toHaveCount(0);
    await expect(row.getByTestId('my-question-tags').getByTestId('question-tag')).toHaveText([
      '#treaties',
      '#peace-of-westphalia',
    ]);
  });
});
