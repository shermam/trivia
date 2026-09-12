import { ConsoleMessage, Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { answerQuestion, startGame } from '../../support/game';
import { expectSameHeight, settledHeight } from '../../support/layout';
import { CORRECT_ANSWERS, questionsFixture } from '../../support/open-trivia';

/**
 * Sound effects and the mute that turns them off (`FEAT-003`).
 *
 * **Nothing here listens, and nothing can.** Playwright's Chromium runs muted
 * and has no output device, so there is no assertion available about what was
 * heard. What a real browser *can* say — and jsdom cannot — is the two things
 * that would actually break a player's game: whether the preference survives a
 * reload (it is `localStorage`, which jsdom's `TestBed` fakes rather than
 * persists), and whether a round played end to end with Web Audio genuinely
 * present throws anything. The second is the one worth having: every cue path
 * in `audio.service.spec.ts` runs against an environment with **no**
 * `AudioContext` at all, so the code that actually builds an oscillator graph
 * is only ever exercised here.
 *
 * **Safe in the preview slice** (`playwright.preview.config.ts` includes every
 * unauthenticated spec unless it is named): this file seeds nothing, writes to
 * no collection, and plays the same stubbed Open Trivia game `game-flow.spec.ts`
 * already plays against the real project. Its only side effect is a
 * `localStorage` key in a context Playwright throws away.
 */

const MOBILE = { width: 390, height: 780 };

/** The drawer's mute button, which exists only below the `sm` breakpoint. */
function soundToggle(page: Page) {
  return page.getByTestId('nav-menu-sound-toggle');
}

async function openDrawer(page: Page): Promise<void> {
  await page.getByTestId('nav-menu-trigger').click();
  await expect(page.getByTestId('nav-menu-panel')).toBeVisible();
}

test.describe('the mute toggle in the nav drawer', () => {
  // The drawer is the only surface the toggle lives on, and it is `sm:hidden`
  // — a desktop viewport renders it inert and unclickable.
  test.use({ viewport: MOBILE });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('offers to mute, unpressed, beside the theme toggle', async ({ page }) => {
    await openDrawer(page);

    await expect(soundToggle(page)).toBeVisible();
    await expect(soundToggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(soundToggle(page)).toHaveText('Mute sounds');
    await expect(page.getByTestId('nav-menu-theme-toggle')).toBeVisible();
  });

  /**
   * The whole point of putting it here: a player who wants silence wants it
   * *now*, usually mid-question, and the drawer is the one control surface a
   * phone has. Closing it on a tap would hide the button they would use to
   * change their mind, exactly as it would for the theme toggle beside it.
   */
  test('mutes without closing the drawer', async ({ page }) => {
    await openDrawer(page);

    await soundToggle(page).click();

    await expect(soundToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(soundToggle(page)).toHaveText('Unmute sounds');
    await expect(page.getByTestId('nav-menu-panel')).toBeVisible();
  });

  /**
   * `localStorage`, and therefore the assertion jsdom cannot make: the unit
   * spec builds a second service against a store the test itself wrote, while
   * this reloads a real browser.
   */
  test('remembers the mute across a reload, and the unmute too', async ({ page }) => {
    await openDrawer(page);
    await soundToggle(page).click();
    await expect(soundToggle(page)).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    await openDrawer(page);
    await expect(soundToggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(soundToggle(page)).toHaveText('Unmute sounds');

    await soundToggle(page).click();
    await page.reload();
    await openDrawer(page);
    await expect(soundToggle(page)).toHaveAttribute('aria-pressed', 'false');
  });

  /**
   * §4.4: a control must not change size as its state changes, and a drawer
   * row that grew when its label did would move every row beneath it. jsdom
   * has no layout, so this is the only place the box can actually be measured
   * — the unit spec checks the property that makes it come out right (one
   * class list for both states).
   *
   * Height rather than width, because width cannot move: the button is a flex
   * item in a fixed-width panel and stretches to it whatever the label says.
   * Both measurements go through `e2e/support/layout.ts` rather than a bare
   * `boundingBox()`, and the *first* one is the reason — it is a one-shot read
   * with no matcher to be read through (`CLAUDE.md` §4.6), and it is taken
   * while the drawer is still sliding in and the self-hosted font may still be
   * swapping. Read once, it failed one run in six under four workers.
   */
  test('is the same box in both states', async ({ page }) => {
    await openDrawer(page);
    const before = await settledHeight(soundToggle(page), 'the sound toggle');

    await soundToggle(page).click();
    await expect(soundToggle(page)).toHaveAttribute('aria-pressed', 'true');

    await expectSameHeight(soundToggle(page), before, 'the sound toggle after muting');
  });
});

/**
 * Collects everything the page reports as **JavaScript** going wrong, for the
 * length of the test.
 *
 * Two kinds are deliberately not collected, and both would otherwise make this
 * a test about something else.
 *
 * **Warnings.** A browser that has not yet seen a user gesture warns about a
 * suspended `AudioContext`; that is the autoplay policy working as designed.
 *
 * **`Failed to load resource`.** Chromium logs a console *error* for every
 * non-2xx response, and this app deliberately asks for documents that may not
 * exist: `ReviewerService` reads `user_roles/{uid}`, which is absent for
 * everybody who is not a reviewer, so a 404 there is the expected answer rather
 * than a fault. That message names no resource either, which is why the URL is
 * recorded for the ones that do count — without it a network failure reads as
 * an application error and gets diagnosed as one.
 *
 * What is left is what a bad audio graph actually produces: an uncaught
 * exception, or a `console.error` raised by script. Scheduling a node in the
 * past, ramping a gain to zero and stopping an oscillator that never started
 * all surface that way.
 */
function watchForProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error' || message.text().startsWith('Failed to load resource')) {
      return;
    }
    problems.push(`console.error: ${message.text()} (${message.location().url})`);
  });
  return problems;
}

/**
 * A whole round, with Web Audio actually present.
 *
 * Every cue path in `audio.service.spec.ts` runs against an environment with
 * **no** `AudioContext`, so the code that actually builds an oscillator graph
 * is exercised nowhere but here.
 */
test.describe('a round played with the sound on', () => {
  /**
   * One round covering three of the four cues, including the two a click
   * cannot reach.
   *
   * The first question is left to expire, which is the only way to run the
   * countdown tick and the timeout cue — and it is waited out in real time on
   * purpose: `page.clock` replaces every timer in the page including the one
   * under test, and this countdown reads the wall clock deliberately
   * (`CLAUDE.md` §4.4, §4.6). That costs about seventeen seconds, which is why
   * the rest of the round is folded into the same test rather than paying it
   * twice.
   */
  test('times out, ticks, answers and finishes with nothing thrown', async ({ page }) => {
    const problems = watchForProblems(page);

    await startGame(page, 5);

    // Nothing clicked: fifteen seconds of countdown, five of them ticking, then
    // the timeout cue and the two-second result pause.
    await expect(page.getByText('Question 2 / 5')).toBeVisible({ timeout: 30_000 });

    // A wrong answer and then the rest right, so both answer cues run and
    // game-over takes its ordinary variant rather than the perfect-round one.
    await answerQuestion(page, questionsFixture.results[1].incorrect_answers[0]);
    for (const answer of CORRECT_ANSWERS.slice(2)) {
      await answerQuestion(page, answer);
    }

    await expect(page).toHaveURL(/\/game-over$/);
    await expect(page.getByRole('heading', { name: 'Game Over!', exact: true })).toBeVisible();
    expect(problems, problems.join('\n')).toEqual([]);
  });

  /**
   * The perfect round takes the other game-over cue — a different tone table
   * and therefore a different set of scheduled nodes. The only variant the test
   * above cannot reach, and cheap, since nothing here waits on a clock.
   */
  test('finishes a perfect round cleanly too', async ({ page }) => {
    const problems = watchForProblems(page);

    await startGame(page, 5);
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }

    await expect(page).toHaveURL(/\/game-over$/);
    await expect(page.getByTestId('final-score')).toHaveText('7');
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
