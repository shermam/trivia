import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { signInViaUi } from '../../support/auth';
import { addQuestionTopic, runTag } from '../../support/topics';

/**
 * `FEAT-051` on the contribute form and the edit dialog: answer rows from two
 * options to six, a statement of up to 2,000 characters — written through the
 * real form and refused or accepted by the real rules.
 *
 * Two seams nothing cheaper reaches. **Focus**: adding a row has to put the
 * cursor in it and removing one has to leave it on what took the row's place,
 * never on the body (`CLAUDE.md` §4.5) — a promise about a real browser's
 * focus, where the unit spec can only check jsdom's. **The write**: the rules
 * suite proves the rules admit six options and 2,000 characters, but it
 * hand-builds the payload, and the form and the rules have disagreed before
 * (`question-source-attribution.spec.ts` exists for the same reason). Here the
 * form builds it, for a create and for the owner's edit.
 *
 * Emulator-only, as everything under `authenticated/` is unless
 * `playwright.preview.config.ts` lists it: a question submitted through the UI
 * gets a Firestore auto-id no sweep list holds.
 */

const password = 'Password123!';

/** A statement of exactly 2,000 characters — words and single spaces, no trailing one. */
function statementOf(tag: string): string {
  let text = `(${tag}) Read the case below, then choose the option that follows from it.`;
  while (text.length < 2000) {
    text += ' The figures are given once, in this statement, and are not repeated in the options.';
  }
  text = text.slice(0, 2000);
  return text.endsWith(' ') ? `${text.slice(0, -1)}.` : text;
}

function row(page: Page, index: number, idPrefix = '') {
  return page.locator(`#${idPrefix}incorrect-answer-${index}`);
}

test.describe('answer rows on the contribute form and the edit dialog (FEAT-051)', () => {
  test('a contributor adds and removes rows, focus follows them, and six options save', async ({
    page,
    firebase,
  }) => {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const topic = runTag('answer-rows');
    const email = `rows-${tag}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password, displayName: 'Ada' });
    await firebase.setProSubscription({ uid });
    await page.goto('/');
    await signInViaUi(page, email, password);

    await page.goto('/add-question');
    await addQuestionTopic(page, topic);
    const statement = statementOf(tag);
    await page.locator('#question').fill(statement);
    await expect(page.getByTestId('question-count')).toHaveText('2000 of 2000 characters');
    await page.locator('#correctAnswer').fill('Mars');

    // Four options to start with: the correct answer and three rows.
    await expect(page.locator('input[id^="incorrect-answer-"]')).toHaveCount(3);
    await row(page, 0).fill('Venus');
    await row(page, 1).fill('Mercury');
    await row(page, 2).fill('Saturn');

    // Adding a row puts the cursor in it — typed into without another click,
    // which is the proof that focus really landed there.
    const add = page.getByTestId('add-answer');
    await add.click();
    await expect(row(page, 3)).toBeFocused();
    await page.keyboard.type('Neptune');
    await expect(page.getByTestId('answer-rows-status')).toHaveText(
      'Incorrect answer 4 added. The question now has 5 answers.',
    );

    await add.click();
    await expect(row(page, 4)).toBeFocused();
    await page.keyboard.type('Uranus');
    await expect(page.getByTestId('answer-rows-status')).toHaveText(
      'Incorrect answer 5 added. The question now has 6 answers. That is the most a question can have.',
    );
    // Six options is the ceiling: the button stays where it was, and does nothing.
    await expect(add).toBeDisabled();

    // Removing a middle row leaves focus on the row that took its place.
    await page.getByTestId('remove-incorrect-answer-1').click();
    await expect(row(page, 1)).toBeFocused();
    await expect(row(page, 1)).toHaveValue('Saturn');
    await expect(page.getByTestId('answer-rows-status')).toHaveText(
      'Incorrect answer 2 removed. The question now has 5 answers.',
    );
    await expect(page.locator('input[id^="incorrect-answer-"]')).toHaveCount(4);

    // Removing the last row leaves it on "Add an answer", the next thing down.
    await page.getByTestId('remove-incorrect-answer-3').click();
    await expect(add).toBeFocused();
    await expect(add).toBeEnabled();

    // Back up to six, and submit — through the real rules. Each focus is
    // asserted before typing: the cursor moves on the render after the click,
    // not with it, and keystrokes sent in between would go to the button.
    await add.click();
    await expect(row(page, 3)).toBeFocused();
    await page.keyboard.type('Jupiter');
    await add.click();
    await expect(row(page, 4)).toBeFocused();
    await page.keyboard.type('Pluto');
    await page.getByRole('button', { name: 'Add Question', exact: true }).click();
    await expect(
      page.getByText('Thanks! Your question has been submitted for review.'),
    ).toBeVisible();

    await expect
      .poll(async () => {
        const [stored] = await firebase.getContributedQuestions(uid);
        return stored
          ? {
              length: (stored['question'] as string).length,
              correct: stored['correct_answer'],
              wrong: stored['incorrect_answers'],
            }
          : null;
      })
      .toEqual({
        length: 2000,
        correct: 'Mars',
        wrong: ['Venus', 'Saturn', 'Neptune', 'Jupiter', 'Pluto'],
      });

    // "Add another" starts the next question on four options again.
    await page.getByRole('button', { name: 'Add another', exact: true }).click();
    await expect(page.locator('input[id^="incorrect-answer-"]')).toHaveCount(3);
  });

  test('the edit dialog opens on the stored rows and saves a changed count', async ({
    page,
    firebase,
  }) => {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `rows-edit-${tag}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password, displayName: 'Ada' });
    const id = `rows-edit-${tag}`;
    await firebase.seedCustomQuestions([
      {
        id,
        createdBy: uid,
        createdAt: Date.now() - 60_000,
        status: 'pending',
        tags: ['astronomy'],
        type: 'multiple',
        difficulty: 'medium',
        question: `Which planet is fourth from the Sun? (${tag})`,
        correct_answer: 'Mars',
        incorrect_answers: ['Venus', 'Mercury', 'Saturn', 'Neptune'],
      },
    ]);
    await page.goto('/');
    await signInViaUi(page, email, password);
    await page.goto('/my-questions');

    const mine = page.getByTestId('my-question').filter({ hasText: tag });
    await expect(mine).toHaveCount(1);
    await mine.getByTestId('edit-question').click();
    const dialog = page.getByTestId('edit-question-dialog');
    await expect(dialog).toBeVisible();

    // The stored four, not three padded or cut.
    await expect(dialog.locator('input[id^="edit-incorrect-answer-"]')).toHaveCount(4);
    for (const [index, value] of ['Venus', 'Mercury', 'Saturn', 'Neptune'].entries()) {
      await expect(row(page, index, 'edit-')).toHaveValue(value);
    }

    // Down to two options: the floor, where the remove buttons go.
    for (const index of [3, 2, 1]) {
      await dialog.getByTestId(`edit-remove-incorrect-answer-${index}`).click();
    }
    await expect(dialog.locator('input[id^="edit-incorrect-answer-"]')).toHaveCount(1);
    await expect(dialog.locator('[data-cy^="edit-remove-incorrect-answer-"]')).toHaveCount(0);
    await expect(page.getByTestId('edit-add-answer')).toBeFocused();

    await dialog.getByTestId('save-question').click();
    await expect(dialog).toHaveCount(0);

    // The owner's edit, through the real rules: a two-option question.
    await expect
      .poll(async () => {
        const [stored] = await firebase.getContributedQuestions(uid);
        return stored ? stored['incorrect_answers'] : null;
      })
      .toEqual(['Venus']);
  });
});
