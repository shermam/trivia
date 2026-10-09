import { ConsoleMessage, Locator } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { CustomQuestionSeed } from '../../fixtures/types';
import { answerOption, answerQuestion, startGame } from '../../support/game';
import { DocumentBox, expectSameHeight, largestShift, settledHeight } from '../../support/layout';
import { seedOfflineQuestions } from '../../support/offline-storage';
import { CORRECT_ANSWERS, stubOpenTrivia } from '../../support/open-trivia';
import { runTag } from '../../support/topics';

/**
 * A player whose connection drops mid-session can still finish a round: the
 * question fetch fails, `TriviaService.getQuestions()` falls back to the
 * IndexedDB pool, and the quiz says so rather than pretending (`app.md` §1.8).
 *
 * **Why a first round online, before the network is cut.** `/play` and
 * `/game-over` are lazy routes, so their chunks arrive over the network the
 * first time each is reached. On a deployed build the service worker has
 * already precached them (`service-worker-precache.spec.ts`); under
 * `ng serve --configuration=e2e` there is no worker at all, so the only way to
 * have them is to have loaded them. Playing one full round first puts both in
 * the module registry, which is also exactly the state the user this test is
 * about is in — somebody who was already playing when the signal went.
 *
 * **The Open Trivia stub has to be revoked, not just ignored.** `page.route`
 * fulfils without touching the network, so a stub registered for the first
 * round would go on answering the second one perfectly while the test believed
 * it had cut the connection. Playwright matches handlers in reverse
 * registration order, so a later aborting handler is what actually takes the
 * network away from the app.
 */
test.describe('Playing with the network gone', () => {
  const ROUND = 5;

  test('falls back to the offline pool, says so, and finishes the round', async ({
    page,
    context,
  }) => {
    // Round one, online: loads the `/play` and `/game-over` chunks, and leaves
    // the app back on `/` ready to start again.
    await startGame(page, ROUND);
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);
    await page.getByRole('button', { name: 'Play Again', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);

    await seedOfflineQuestions(page, ROUND);

    // Both halves of taking the network away: the app's own requests fail, and
    // so would anything else the page tried.
    await page.route('https://opentdb.com/**', (route) => route.abort('internetdisconnected'));
    await context.setOffline(true);

    await page.getByRole('button', { name: 'Start Game', exact: true }).click();
    await expect(page).toHaveURL(/\/play$/);
    await expect(page.getByTestId('question-text')).toBeVisible();

    // The banner is raised only when the fetch actually threw and the pool
    // answered — so it is the assertion that distinguishes a round served from
    // storage from one that quietly succeeded over the network.
    await expect(
      page.getByText("You're offline — these questions are from your saved offline pool."),
    ).toBeVisible();

    for (let i = 0; i < ROUND; i++) {
      // Every seeded question labels its correct option `Right`, so the round
      // is answerable without knowing the order the pool shuffled into. The
      // click waits out the result pause on its own: the previous question's
      // button is disabled while the banner shows, and Playwright re-resolves
      // the locator until an enabled one is there.
      await answerOption(page, 'Right').click();
    }

    await expect(page).toHaveURL(/\/game-over$/);
    // The correct-answer count rather than the points tile: points are a
    // function of `FEAT-004`'s multipliers, which this spec has no business
    // asserting. Whitespace-tolerant because the `<span>` holding the total
    // sits on its own line, and `toHaveText` does not normalize a pattern
    // (`CLAUDE.md` §4.6).
    await expect(page.getByTestId('correct-answers')).toHaveText(
      new RegExp(`^\\s*${ROUND}\\s*/\\s*${ROUND}\\s*$`),
    );
  });
});

/**
 * A quiz card's box within the strip that holds it — in the strip's own
 * scrolled content, so a tap that scrolls the strip sideways is not read as
 * the card moving — which is everything the card's own state can move.
 *
 * Not document coordinates, unlike `layout.ts`'s helpers: when the network
 * goes, the setup card above the list grows an offline banner of its own and
 * pushes the whole section down with it — the setup screen's state, and not
 * a change in the card. One read, so never an assertion on its own
 * (`CLAUDE.md` §4.6): it is only ever polled.
 */
function boxInStrip(card: Locator): Promise<DocumentBox> {
  return card.evaluate((node) => {
    const strip = node.closest('ul')!;
    const origin = strip.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return {
      top: box.top - origin.top + strip.scrollTop,
      left: box.left - origin.left + strip.scrollLeft,
      width: box.width,
      height: box.height,
    };
  });
}

/** {@link boxInStrip} once two consecutive readings agree, as `layout.ts`'s `settledBox` reads. */
async function settledBoxInStrip(card: Locator, what: string): Promise<DocumentBox> {
  let previous: DocumentBox | null = null;
  let settled: DocumentBox | null = null;
  await expect
    .poll(
      async () => {
        const box = await boxInStrip(card);
        const agrees = previous !== null && box.height > 0 && largestShift(previous, box) === 0;
        previous = box;
        if (agrees) {
          settled = box;
        }
        return agrees;
      },
      { message: `${what} settling to a stable box` },
    )
    .toBe(true);
  return settled!;
}

/** Fails unless the card is exactly where it was in its strip, and exactly as big. */
async function expectCardUnmoved(card: Locator, box: DocumentBox, what: string): Promise<void> {
  await expect
    .poll(async () => largestShift(box, await boxInStrip(card)), {
      message: `${what} (expected to stay at ${JSON.stringify(box)} in the strip)`,
    })
    .toBe(0);
}

/**
 * The curated quizzes on `/` with the network gone (`FEAT-024`).
 *
 * A quiz cannot be opened offline: its page is a lazy chunk outside the
 * precache, and the quiz is a Firestore read. So while the browser says it is
 * offline the cards say they need a connection and a tap goes nowhere. A plain
 * link would start a navigation whose chunk cannot load — nothing on screen,
 * the address unchanged, and `Failed to fetch dynamically imported module` in
 * the console — and Chromium keeps that failed import in its module map, so
 * the same link would go on failing after the connection came back. Measured
 * by letting the tap navigate: the run fails at the final open, with the
 * failed import logged twice for the error check behind it to refuse too.
 *
 * In this file rather than `quiz-list.spec.ts` for the reason the file is
 * emulator-only: `context.setOffline(true)` cuts the page's network and not a
 * service worker's (`CLAUDE.md` §4.6). Nothing here asks where a response came
 * from — the subject is the page: what the card shows, where a tap goes, and
 * what the console says.
 */
test.describe('The curated quizzes with the network gone (FEAT-024)', () => {
  test('a card says it needs a connection, a tap goes nowhere, and the connection brings it back', async ({
    page,
    context,
    firebase,
  }) => {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const question: CustomQuestionSeed & { id: string } = {
      id: `quiz-offline-${runId}`,
      tags: [runTag('quiz-offline')],
      type: 'multiple',
      difficulty: 'easy',
      question: `A question behind an offline card (${runId})?`,
      correct_answer: 'Right',
      incorrect_answers: ['Wrong 1', 'Wrong 2', 'Wrong 3'],
    };
    await firebase.seedCustomQuestions([question]);
    const quizId = `e2e-offline-${runId}`;
    const title = `An offline card ${runId}`;
    // An hour ahead, so it is among the list's newest ten whatever the shared
    // emulator holds. `quiz-list.spec.ts` orders only its own quizzes against
    // each other, so a newer one from here cannot displace them.
    await firebase.seedQuiz({
      id: quizId,
      title,
      questionIds: [question.id],
      createdAt: Date.now() + 60 * 60 * 1000,
    });

    // Every console error but the browser's own "Failed to load resource"
    // line, which a request refused offline prints whatever the app does with
    // it, and every uncaught exception. A tap that started a navigation would
    // put the failed chunk import here.
    const errors: string[] = [];
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
        errors.push(message.text());
      }
    });
    page.on('pageerror', (error) => errors.push(error.message));
    // A reload would hand the test a freshly rendered list, and "the cards
    // re-enable" would then be true of cards that were never disabled.
    let loads = 0;
    page.on('load', () => {
      loads += 1;
    });

    await stubOpenTrivia(page);
    await page.goto('/');
    await page.getByTestId('quiz-list').scrollIntoViewIfNeeded();

    const card = page.getByTestId('quiz-link').filter({ hasText: title });
    const reason = card.getByTestId('quiz-link-offline');
    await expect(card).toHaveAttribute('href', `/quiz/${quizId}`);
    await expect(reason).toBeHidden();
    const body = page.getByTestId('quiz-list-body');
    const bodyHeight = await settledHeight(body, 'the strip online');
    const online = await settledBoxInStrip(card, 'the card online');

    await context.setOffline(true);
    await expect(reason).toBeVisible();
    await expect(reason).toHaveText('Needs a connection');
    await expect(card).toBeDisabled();
    await expect(card).not.toHaveAttribute('href');
    await expectCardUnmoved(card, online, 'the card offline');
    await expectSameHeight(body, bodyHeight, 'the strip offline');

    // Forced, because Playwright will not click what it reads as disabled —
    // and a person taps it anyway.
    await card.click({ force: true });

    await context.setOffline(false);
    await expect(card).toBeEnabled();
    await expect(card).toHaveAttribute('href', `/quiz/${quizId}`);
    await expect(reason).toBeHidden();
    await expectCardUnmoved(card, online, 'the card back online');

    // The same card, with no reload in between, now opens its quiz — which a
    // tap that had tried to navigate offline would have made impossible: the
    // failed chunk import stays failed for the life of the page.
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/quiz/${quizId}$`));
    await expect(page.getByTestId('quiz-title')).toHaveText(title);
    await expect(page.getByTestId('start-quiz')).toBeVisible();

    expect(loads, 'full page loads — the first, and no reload since').toBe(1);
    // Read last: the offline tap is long settled by now, so a navigation it
    // had started would already have failed into the console.
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
