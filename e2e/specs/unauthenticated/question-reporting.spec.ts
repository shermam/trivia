import { Page } from '@playwright/test';
import { FirebaseBackend } from '../../fixtures/firebase-backend';
import { expect, test } from '../../fixtures/test';
import { CustomQuestionSeed } from '../../fixtures/types';
import { expectRadiosAreGrouped } from '../../support/a11y';
import { answerQuestion, optionLabel, startGame, waitForPlayRoute } from '../../support/game';
import { questionsFixture, stubExtraCategory, stubOpenTrivia } from '../../support/open-trivia';

/**
 * Finding H4 — the reporting path for community questions, driven as an
 * anonymous player on purpose: most players never sign in, and the whole
 * design decision was that reporting works for them. The written document is
 * asserted through the Admin SDK (`firebase.getQuestionReports`), because
 * clients are forbidden from reading `question_reports` back — the UI saying
 * "Reported" proves nothing about the write on its own.
 *
 * Reporting starts *during* the game: a flag on the question the player is
 * looking at, and game-over then leads with what they flagged. The dialog is
 * the escape hatch for "I noticed but didn't flag it", so it lists everything.
 *
 * **Every test seeds its own two questions under a category it invented**, and
 * that is what replaces Cypress's `resetBackend()`. These tests assert on
 * *exactly* the questions they seeded — that the dialog offers both, that a
 * report was filed for one and none for the other — and the emulator is shared
 * by every worker in the run, so the game has to be served from a slice of the
 * bank that is this test's alone. The Category dropdown is built from the
 * stubbed Open Trivia response and its value goes straight into the
 * `custom_questions` query, so inventing a category and picking it is the whole
 * mechanism (see `stubExtraCategory`). The ids are unique per test for the same
 * reason, which is also what lets `getQuestionReports` be scoped rather than a
 * read of the whole collection.
 */

/** This test's own slice of the question bank: two questions, one category, nobody else's. */
function seedFor(): { category: string; questions: (CustomQuestionSeed & { id: string })[] } {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const category = `Reporting ${runId}`;
  return {
    category,
    questions: [
      {
        id: `report-q1-${runId}`,
        category,
        type: 'multiple',
        difficulty: 'easy',
        question: 'What planet do we live on?',
        correct_answer: 'Earth',
        incorrect_answers: ['Mars', 'Venus', 'Jupiter'],
      },
      {
        id: `report-q2-${runId}`,
        category,
        type: 'boolean',
        difficulty: 'easy',
        question: 'Water boils at 100°C at sea level.',
        correct_answer: 'True',
        incorrect_answers: ['False'],
      },
    ],
  };
}

async function startCustomGame(
  page: Page,
  firebase: FirebaseBackend,
  seed: ReturnType<typeof seedFor>,
): Promise<void> {
  await firebase.seedCustomQuestions(seed.questions);
  await stubOpenTrivia(page);
  await stubExtraCategory(page, seed.category);
  await page.goto('/');
  // Stands in for Cypress's `cy.wait('@categories')`, and does more: the
  // invented category has to be in the dropdown before it can be selected.
  await expect(page.locator('#category')).toContainText(seed.category);
  await page.locator('#amount').selectOption({ label: '5' });
  await page.locator('#category').selectOption(seed.category);
  await optionLabel(page, page.getByRole('radio', { name: 'Custom', exact: true })).click();
  await page.getByRole('button', { name: 'Start Game', exact: true }).click();
  await waitForPlayRoute(page);
}

/**
 * Plays the rest of the game from whatever question is on screen, flagging
 * the ones whose ids are in `flagIds`.
 *
 * The bank is served in an order this test does not control, so each question
 * is identified from the DOM rather than by position — flagging by index would
 * flag whichever question happened to come up, and pass anyway.
 *
 * Two things here are load-bearing:
 *
 * - The heading is read through `[data-cy=question-text]`, not `h2`. That is
 *   what makes an overrun legible: if a question auto-answers on timeout, the
 *   loop runs one iteration more than there are questions left, and this
 *   selector simply does not exist on `/game-over` — so it fails saying so.
 *   `h2` matches three elements there (the leaderboard, the flagged card, the
 *   dialog), and a text read across a multi-element match is not about any one
 *   of them.
 * - The wait is for the heading to have *moved on* from the question just
 *   answered. The quiz holds an answered question on screen for two seconds
 *   before advancing, so reading the heading straight after a click can return
 *   it again and then sit waiting for options that are already disabled.
 *   Asserting is retriable; reading is not.
 */
async function playRemainingQuestions(
  page: Page,
  seed: ReturnType<typeof seedFor>,
  flagIds: string[] = [],
): Promise<void> {
  const flagged = new Set(flagIds);
  const answered = new Set<string>();
  const heading = page.getByTestId('question-text');

  // One pass per seeded question, ignoring which one this is: the loop reads
  // what is on screen rather than indexing into the list, because the bank is
  // served in an order this test does not control.
  for (const _ of seed.questions) {
    await expect
      .poll(async () => answered.has((await heading.textContent())?.trim() ?? ''), {
        message: `a question other than the ${answered.size} already answered is on screen`,
      })
      .toBe(false);

    const served = (await heading.textContent())?.trim() ?? '';
    const onScreen = seed.questions.find((q) => q.question === served);
    if (!onScreen) {
      throw new Error(`Served question "${served}" is not one of the seeded ones`);
    }
    answered.add(served);
    if (flagged.has(onScreen.id)) {
      await page.getByTestId('flag-question').click();
    }
    await answerQuestion(page, onScreen.correct_answer);
  }

  await expect(page).toHaveURL(/\/game-over$/);
  // Anchored on something that only exists once the component has rendered.
  // Every later "does not exist" assertion would otherwise be free to pass
  // against the empty `<app-game-over>` that exists between the router
  // committing the URL and the next change-detection tick — this app is
  // zoneless, so that tick is a scheduled callback, not a synchronous one.
  await expect(page.getByText('Game Over!').first()).toBeVisible();
}

async function finishCustomGame(
  page: Page,
  firebase: FirebaseBackend,
  seed: ReturnType<typeof seedFor>,
  flagIds: string[] = [],
): Promise<void> {
  await startCustomGame(page, firebase, seed);
  await playRemainingQuestions(page, seed, flagIds);
}

/**
 * Dispatches a Tab (or Shift+Tab) keydown from whatever currently has focus,
 * and asserts the dialog's handler cancelled it.
 *
 * Fired from the focused element rather than from the dialog, because the
 * handler branches on `document.activeElement` — and asserting
 * `defaultPrevented` is the half that a focus assertion cannot cover, since a
 * synthetic key event performs no native focus move of its own.
 */
async function pressTabInDialog(page: Page, { shift }: { shift: boolean }): Promise<void> {
  const prevented = await page.evaluate((shiftKey) => {
    const active = document.activeElement;
    if (!active) {
      return null;
    }
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    active.dispatchEvent(event);
    return event.defaultPrevented;
  }, shift);

  expect(prevented, `${shift ? 'Shift+' : ''}Tab was cancelled by the trap`).toBe(true);
}

test.describe('reporting a community question', () => {
  test('flags a question mid-game and files the report the emulator holds', async ({
    page,
    firebase,
  }) => {
    const seed = seedFor();
    await finishCustomGame(page, firebase, seed, [seed.questions[0].id]);

    // Game-over leads with the flagged question — and only that one. The
    // second community question is behind the dialog, not on the page.
    await expect(page.getByText('Questions you flagged').first()).toBeVisible();
    await expect(page.getByText(seed.questions[0].question).first()).toBeVisible();
    await expect(page.getByTestId(`report-question-${seed.questions[1].id}`)).toHaveCount(0);

    // The trigger is a disclosure and says so (CLAUDE.md §4.5).
    const trigger = page.getByTestId(`report-question-${seed.questions[0].id}`);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    // Focus moved into the panel on open (G2 contract).
    await expect(page.locator(`#report-panel-${seed.questions[0].id}`)).toBeFocused();

    // The reason picker is a labelled radiogroup (G4 contract) — swept
    // generically, so a reason option added later is covered too.
    await expectRadiosAreGrouped(page);

    await page.getByRole('radio', { name: 'The answer is wrong', exact: true }).check();
    await page.locator('textarea[name="report-detail"]').fill('We live on Earth, not Mars.');
    await page.getByTestId(`send-report-${seed.questions[0].id}`).click();

    // The form is replaced by the badge, and the outcome is announced.
    const badge = page.getByTestId(`reported-badge-${seed.questions[0].id}`);
    await expect(badge).toHaveText('Reported');
    await expect(trigger).toHaveCount(0);
    await expect(page.getByTestId('report-status')).toContainText('Report sent');
    // The trigger focus would normally be restored to is gone (the badge
    // replaced it), so the badge itself must catch focus — otherwise the happy
    // path strands a keyboard user at <body> (G2 contract; found by review, not
    // by the original suite).
    await expect(badge).toBeFocused();

    const ids = seed.questions.map((q) => q.id);
    await expect.poll(() => firebase.getQuestionReports(ids)).toHaveLength(1);
    const [report] = await firebase.getQuestionReports(ids);
    expect(report.questionId).toBe(seed.questions[0].id);
    expect(report.reason).toBe('incorrect');
    expect(report.detail).toBe('We live on Earth, not Mars.');
    // The uid is the anonymous session's — unknown in advance, but the document
    // ID must carry the volume cap and end in that same uid.
    expect(typeof report.reportedBy).toBe('string');
    expect(report.reportedBy.length).toBeGreaterThan(0);
    expect(report.id).toMatch(new RegExp(`^\\d+-\\d-${report.reportedBy}$`));
    expect(Math.abs(report.createdAt - Date.now())).toBeLessThan(60_000);
  });

  // The flag is the entire promise that reporting is coming, so the state it
  // shows has to survive the rest of the game — and be conveyed by more than
  // colour (WCAG 1.4.1), which is why `aria-pressed` and the notice are
  // asserted rather than the red fill.
  test('announces the flag and lets the player take it back', async ({ page, firebase }) => {
    const seed = seedFor();
    await startCustomGame(page, firebase, seed);

    const flag = page.getByTestId('flag-question');
    await expect(flag).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('flag-notice')).toHaveCount(0);

    await flag.click();
    await expect(flag).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('flag-notice')).toContainText('end of the game');
    // The announcement names the question's position, and that is the point of
    // it: two flags in one game must produce two *different* strings, or the
    // second is a no-op set on a signal and the live region never announces
    // it. Asserted verbatim rather than by keyword for the same reason.
    await expect(page.getByTestId('flag-status')).toContainText('Question 1 flagged');

    // Un-flagging is the same control, and clears the promise with it —
    // including the announcement, which must empty rather than linger.
    await flag.click();
    await expect(flag).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('flag-notice')).toHaveCount(0);
    // Matched against whitespace rather than compared to '': the region is a
    // permanent element (G3) whose interpolation sits on its own line, so its
    // textContent is never the empty string even when it says nothing.
    await expect
      .poll(() => page.getByTestId('flag-status').textContent(), {
        message: 'the flag announcement empties when the flag is taken back',
      })
      .toMatch(/^\s*$/);

    // ...and game-over honours that: nothing flagged, nothing led with.
    await playRemainingQuestions(page, seed);
    await expect(page.getByText('Questions you flagged')).toHaveCount(0);
  });

  test('offers every community question through the dialog, trapped and dismissible', async ({
    page,
    firebase,
  }) => {
    const seed = seedFor();
    await finishCustomGame(page, firebase, seed);

    await expect(page.getByText('Questions you flagged')).toHaveCount(0);
    const opener = page.getByTestId('open-report-dialog');
    await expect(opener).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(opener).toHaveAttribute('aria-expanded', 'false');
    await opener.click();

    // Everything from the game is offered here, flagged or not.
    const dialog = page.getByTestId('report-dialog');
    for (const question of seed.questions) {
      await expect(dialog.getByText(question.question)).toBeVisible();
    }

    // Focus lands on the dialog itself, so it is announced with its title
    // before Tab reaches the close button (G2 contract).
    await expect(dialog).toBeFocused();

    // `aria-modal="true"` is a promise; the trap is what keeps it true for
    // sighted keyboard users, who are not covered by that attribute at all.
    //
    // Driven with hand-built keydowns rather than `page.keyboard.press('Tab')`,
    // and for the reason that outlives the runner: a real Tab performs a native
    // focus move of its own, so a handler that called `.focus()` but dropped
    // `preventDefault()` would land focus in exactly the right place here while
    // the browser moved it somewhere else on top. Dispatching the event
    // ourselves is the only way to read `defaultPrevented` afterwards, and
    // asserting where focus went is not enough on its own.
    //
    // The last control is read from the DOM rather than assumed to be
    // `questions[1]`: the bank is served in an order this test does not
    // control. It is the last focusable only because no report form is open and
    // nothing is reported yet — opening a form would append its radios,
    // textarea and buttons after it.
    const lastTrigger = await dialog
      .locator('[data-cy^="report-question-"]')
      .last()
      .getAttribute('data-cy');
    expect(lastTrigger, 'the dialog lists at least one question').toBeTruthy();

    await pressTabInDialog(page, { shift: true });
    await expect(page.getByTestId(lastTrigger!)).toBeFocused();

    await pressTabInDialog(page, { shift: false });
    await expect(page.getByTestId('close-report-dialog')).toBeFocused();

    // ...and Shift+Tab again, this time from the dialog's *first* control
    // rather than from the dialog element. That is the branch real use hits on
    // every keystroke after the first, and it is a different arm of the same
    // condition.
    await pressTabInDialog(page, { shift: true });
    await expect(page.getByTestId(lastTrigger!)).toBeFocused();

    // Pressed with focus where the trap left it, not aimed at the dialog
    // element — Escape has to reach the handler by bubbling, which is how a
    // real user produces it.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // Closing returns focus to the button that opened it.
    await expect(opener).toBeFocused();

    expect(await firebase.getQuestionReports(seed.questions.map((q) => q.id))).toHaveLength(0);
  });

  test('closes the report form on Escape with focus restored, and writes nothing on cancel', async ({
    page,
    firebase,
  }) => {
    const seed = seedFor();
    await finishCustomGame(page, firebase, seed, [seed.questions[0].id]);

    const trigger = page.getByTestId(`report-question-${seed.questions[0].id}`);
    const panel = page.locator(`#report-panel-${seed.questions[0].id}`);

    await trigger.click();
    // Wait for the focus-move effect before pressing a key: right after the
    // click, focus is still on the trigger (which has no Escape handler), and
    // Angular's effect only moves it into the panel after render. Pressing
    // Escape without this retrying assertion races that effect.
    await expect(panel).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // Focus returns to what opened the panel (G2) — losing it to <body> would
    // strand a keyboard user at the top of the page.
    await expect(trigger).toBeFocused();

    await trigger.click();
    await page.getByRole('radio', { name: 'Spam or nonsense', exact: true }).check();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    expect(await firebase.getQuestionReports(seed.questions.map((q) => q.id))).toHaveLength(0);
  });

  test('offers no reporting at all for a game without community questions', async ({ page }) => {
    // `startGame` waits for the quiz loop to be *rendered*, not merely for the
    // questions response. That matters here more than anywhere else in the
    // suite: this test's assertions are all negative, and before that change a
    // "does not exist" assertion passed on its first poll against the setup
    // screen — staying green even with the `source === 'custom'` guard deleted
    // and a flag rendered on every question.
    await startGame(page, 5);

    // An Open Trivia DB question is not ours to moderate, so it gets no flag
    // either — the affordance is absent from the quiz loop, not just disabled.
    await expect(page.getByTestId('flag-question')).toHaveCount(0);
    for (const question of questionsFixture.results) {
      await answerQuestion(page, question.correct_answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);
    await expect(page.getByText('Game Over!').first()).toBeVisible();
    await expect(page.getByText('Questions you flagged')).toHaveCount(0);
    await expect(page.getByTestId('open-report-dialog')).toHaveCount(0);
  });
});
