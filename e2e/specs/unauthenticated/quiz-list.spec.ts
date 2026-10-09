import { ConsoleMessage, Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { CustomQuestionSeed } from '../../fixtures/types';
import { waitForAnonymousSession } from '../../support/auth';
import {
  expectBoxUnmoved,
  expectSameHeight,
  expectUnmoved,
  settledBox,
  settledHeight,
} from '../../support/layout';
import { stubOpenTrivia } from '../../support/open-trivia';
import { runTag } from '../../support/topics';

/**
 * The curated quizzes on `/` (`FEAT-024`), in a real browser.
 *
 * **What only a browser can show here is where the list is and when it reads.**
 * The list is a sibling *after* the setup screen's `min-h-screen` block, so it
 * starts below the first screen and cannot move the card; and it reads nothing
 * until it is scrolled to, through an `IntersectionObserver` whose threshold is
 * there for one geometric case — an embed, where the section touches the
 * bottom edge of the first screen exactly. jsdom has no layout and no
 * observer, so `quiz-list.component.spec.ts` drives a fake; this drives the
 * real thing.
 *
 * **The list is collection-wide, and the emulator is shared.** Every worker's
 * quizzes are in it, so the tests assert about the quizzes they seeded — the
 * newest by construction where order matters — and about boxes, which do not
 * depend on what is listed: every state of the strip is one fixed height.
 *
 * Emulator-only for now, for the reason `curated-quiz.spec.ts` gives: a preview
 * channel runs `main`'s deployed rules, which until this feature merges have no
 * `quizzes` block (`playwright.preview.config.ts`).
 */

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** An hour ahead: newer than anything else the run seeds, so first in a newest-first list. */
const NEWEST = () => Date.now() + 60 * 60 * 1000;

/**
 * Counts the queries the list sends — POSTs to `:runQuery` over `quizzes`.
 * POST only, because the browser may send a CORS preflight to the same URL
 * first, and counting it would count the read twice.
 */
function countListReads(page: Page): { count: number } {
  const reads = { count: 0 };
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /:runQuery(\?|$)/.test(request.url()) &&
      (request.postData() ?? '').includes('"collectionId":"quizzes"')
    ) {
      reads.count += 1;
    }
  });
  return reads;
}

/**
 * How far the setup card sits below the top of the space it is centred in,
 * beyond that space's padding — `tag-filter.spec.ts`'s measure, for the trap
 * `CLAUDE.md` §4.4 records: zero means the card is taller than the window and
 * pinned to the top, where nothing can move it however wrong the layout is.
 */
function centringSlack(page: Page): Promise<number> {
  return page.evaluate(() => {
    const card = document.querySelector('[data-cy="setup-card"]')!;
    const space = card.parentElement!;
    const offset = card.getBoundingClientRect().top - space.getBoundingClientRect().top;
    return offset - parseFloat(getComputedStyle(space).paddingTop);
  });
}

/** The setup screen at rest: the card on screen, the allowance resolved, the fonts in. */
async function setupAtRest(page: Page): Promise<void> {
  await expect(page.getByTestId('setup-card')).toBeVisible();
  await expect(page.getByTestId('daily-allowance')).toContainText('free games left today');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/**
 * Waits until this visit's anonymous session is persisted, embed or not.
 *
 * `waitForAnonymousSession` anchors on the account chip, which an embed does
 * not render, so an embedded page waits on the stored record alone — the half
 * of that helper that does not need the top bar.
 */
async function waitForStoredSession(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Object.keys(window.localStorage).some((key) => key.startsWith('firebase:authUser:')),
        ),
      { message: 'Firebase has persisted an anonymous session', timeout: 60_000 },
    )
    .toBe(true);
}

/**
 * The viewports the list is measured at.
 *
 * The first two are the ones the feature was asked to be measured at — and at
 * both of them the setup card is taller than the window, so it is pinned to the
 * top and could not move whatever the list did (`centringSlack` is 0, which
 * each test records). The last two are tall enough to leave the card room to
 * move, which is where "it did not move" means something (`tag-filter.spec.ts`
 * found the same pair). `embed` is the case the observer's threshold exists
 * for: no top bar, so the section starts exactly at the bottom edge of the
 * first screen.
 */
const VIEWPORTS = [
  { width: 390, height: 1000, embed: false },
  { width: 1024, height: 900, embed: false },
  { width: 390, height: 1400, embed: false },
  { width: 1280, height: 1400, embed: false },
  { width: 1280, height: 1400, embed: true },
] as const;

for (const { width, height, embed } of VIEWPORTS) {
  test.describe(`the quiz list on / at ${width}×${height}${embed ? ', embedded' : ''}`, () => {
    test.use({ viewport: { width, height } });

    test('starts below the first screen, reads only when scrolled to, and never moves the card', async ({
      page,
      firebase,
    }) => {
      // Something to list, so the strip reaches its filled state whatever the
      // shared emulator holds.
      await firebase.seedQuiz({
        id: `e2e-list-${unique()}`,
        title: 'A quiz to fill the strip',
        questionIds: ['e2e-list-question'],
      });

      const reads = countListReads(page);
      await stubOpenTrivia(page);
      await page.goto(embed ? '/?embed=1' : '/');
      await setupAtRest(page);

      const list = page.getByTestId('quiz-list');
      const listTop = (await settledBox(list, 'the quiz list section')).top;
      const slack = await centringSlack(page);
      test.info().annotations.push({
        type: 'measured',
        description: `list top ${listTop}px in a ${height}px window; card centring slack ${slack}px`,
      });

      if (embed) {
        // The edge case itself: no top bar, the block above is exactly one
        // screen, so the section touches the bottom edge. An observer at a
        // threshold of 0 reports that as intersecting, which is the read this
        // test exists to catch.
        expectUnmoved(listTop, height, 'the list’s top against the bottom of the first screen');
      } else {
        expect(listTop, 'the list starts below the first screen').toBeGreaterThan(height);
      }

      const card = page.getByTestId('setup-card');
      const cardAtRest = await settledBox(card, 'the setup card at rest');

      // A read started on arrival waits on the same auth bootstrap this does,
      // and is sent the moment that bootstrap knows its first state — before
      // the anonymous sign-in round trip it then makes has finished. So once
      // the session is stored, an eager read would already have been counted.
      if (embed) {
        await waitForStoredSession(page);
      } else {
        await waitForAnonymousSession(page);
      }
      expect(reads.count, 'quiz reads before the list was scrolled to').toBe(0);

      const body = page.getByTestId('quiz-list-body');
      await expect(page.getByTestId('quiz-list-placeholders')).toBeVisible();
      const placeholderHeight = await settledHeight(body, 'the strip before the read');

      await list.scrollIntoViewIfNeeded();
      await expect(page.getByTestId('quiz-list-strip')).toBeVisible();
      await expect(page.getByTestId('quiz-link').first()).toBeVisible();
      // Once, by the time the quizzes are on screen — a read that has landed
      // was sent, and nothing reads a second time.
      expect(reads.count, 'quiz reads once the list was scrolled to').toBe(1);
      await expectSameHeight(body, placeholderHeight, 'the strip once the quizzes are in');

      // In document coordinates, so the scroll that brought the list into view
      // is not mistaken for the card moving.
      await expectBoxUnmoved(card, cardAtRest, 'the setup card after the list filled in');
    });
  });
}

test.describe('the quizzes the list shows (FEAT-024)', () => {
  /**
   * A list that could not load says so, offers a retry, and puts **no error**
   * in the console of `/` — which Lighthouse asserts `errors-in-console` on,
   * and where `sound-effects.spec.ts` fails a round on any script error. It
   * matters more than it looks: on a short window the click on Start Game
   * scrolls the list into view, so the list reads during an ordinary round.
   *
   * The refusal is a 403 fulfilled at the network, the answer every project
   * gives while its deployed rules have no `quizzes` block. One handler with a
   * flag rather than an unroute, for the reason `profile-stats.spec.ts` gives.
   */
  test('a refused read shows the failed state and a retry, and logs no error', async ({
    page,
    firebase,
  }) => {
    await firebase.seedQuiz({
      id: `e2e-refused-${unique()}`,
      title: 'Read on the second try',
      questionIds: ['e2e-list-question'],
    });

    const errors: string[] = [];
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
        errors.push(message.text());
      }
    });
    let refusing = true;
    let refused = 0;
    await page.route(/:runQuery(\?|$)/, async (route) => {
      const request = route.request();
      if (
        refusing &&
        request.method() === 'POST' &&
        (request.postData() ?? '').includes('"collectionId":"quizzes"')
      ) {
        refused += 1;
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify([
            { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Missing permissions.' } },
          ]),
        });
        return;
      }
      await route.fallback();
    });

    await stubOpenTrivia(page);
    await page.goto('/');
    await page.getByTestId('quiz-list').scrollIntoViewIfNeeded();

    await expect(page.getByTestId('quiz-list-failed')).toContainText(
      'The quizzes could not be loaded.',
    );
    await expect(page.getByTestId('quiz-list-status')).toHaveText(
      'The quizzes could not be loaded.',
    );
    expect(refused, 'the refusal is what produced the failed state').toBe(1);

    refusing = false;
    await page.getByTestId('quiz-list-retry').click();
    // The button goes away with the state it belongs to; focus went to the
    // heading first rather than dropping to <body> (`CLAUDE.md` §4.4).
    await expect(page.locator('#quiz-list-heading')).toBeFocused();
    await expect(page.getByTestId('quiz-list-strip')).toBeVisible();

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('lists published quizzes newest first, leaves drafts out, and links each to its page', async ({
    page,
    firebase,
  }) => {
    const runId = unique();
    const question: CustomQuestionSeed & { id: string } = {
      id: `quiz-list-${runId}-only`,
      tags: [runTag('quiz-list')],
      type: 'multiple',
      difficulty: 'easy',
      question: `A listed quiz’s question (${runId})?`,
      correct_answer: 'Right',
      incorrect_answers: ['Wrong 1', 'Wrong 2', 'Wrong 3'],
    };
    await firebase.seedCustomQuestions([question]);

    const newest = NEWEST();
    const older = { id: `e2e-older-${runId}`, title: `Older ${runId}`, createdAt: newest };
    const newer = { id: `e2e-newer-${runId}`, title: `Newer ${runId}`, createdAt: newest + 1_000 };
    const draft = { id: `e2e-draft-${runId}`, title: `Draft ${runId}`, createdAt: newest + 2_000 };
    await firebase.seedQuiz({ ...older, questionIds: [question.id] });
    await firebase.seedQuiz({ ...newer, questionIds: [question.id] });
    // The newest of the three, and unpublished: the query's own
    // `isPublished == true` is what keeps it off the list — and what lets the
    // read rule allow the query at all.
    await firebase.seedQuiz({ ...draft, questionIds: [question.id], isPublished: false });

    await stubOpenTrivia(page);
    await page.goto('/');
    await page.getByTestId('quiz-list').scrollIntoViewIfNeeded();

    const titles = page.getByTestId('quiz-link-title');
    await expect(titles.nth(0)).toHaveText(newer.title);
    await expect(titles.nth(1)).toHaveText(older.title);
    await expect(titles.filter({ hasText: draft.title })).toHaveCount(0);
    await expect(page.getByTestId('quiz-list-status')).toHaveText(/^\s*(1 quiz|\d+ quizzes)\.\s*$/);

    const link = page.getByTestId('quiz-link').filter({ hasText: newer.title });
    await expect(link).toHaveAttribute('href', `/quiz/${newer.id}`);
    await expect(link).toContainText('1 question');

    await link.click();
    await expect(page).toHaveURL(new RegExp(`/quiz/${newer.id}$`));
    await expect(page.getByTestId('quiz-title')).toHaveText(newer.title);
    await expect(page.getByTestId('start-quiz')).toBeVisible();
  });
});
