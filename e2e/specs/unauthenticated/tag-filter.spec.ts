import { Page, Request } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { CustomQuestionSeed } from '../../fixtures/types';
import { answerQuestion, optionLabel, waitForPlayRoute } from '../../support/game';
import { drift } from '../../support/layout';
import { questionsFixture, stubOpenTrivia } from '../../support/open-trivia';
import { configureTopicGame, runTag } from '../../support/topics';

/**
 * `FEAT-021` and `FEAT-052` — the setup screen's topic picker, end to end.
 *
 * Since topics replaced categories it is the game's only topic choice, for
 * every source, and each source takes the selection in the shape it can
 * honour: an Open Trivia game plays one seed tag — one of Open Trivia DB's own
 * twenty-four categories — a Custom game up to ten tags of any kind, and a
 * Mixed game filters its community half on every tag while its Open Trivia
 * half follows the first seed tag among them.
 *
 * **Why a real browser is needed at all.** The unit specs already pin the query
 * the service builds, the request the adapter sends, the chips the picker
 * produces and the config the screen emits. What none of them can see is the
 * whole of that wired together through a played round: a `ControlValueAccessor`
 * that never writes back, a `tags` key dropped between the form and
 * `GameConfig`, a seed tag that never becomes Open Trivia DB's `category` id,
 * or a clause that reaches Firestore in a shape the real query engine refuses
 * would all pass every unit test in the repo and serve nobody a question.
 *
 * **Isolation in a bank this spec does not own is two tags it minted.** Every
 * worker in the run writes to one bank — and on `trivimind-dev` so does
 * everyone else, for good — so an assertion about *which* questions a filter
 * served only means something if this test owns every question that can match
 * it. The topic a test plays is a run tag (`e2e/support/topics.ts`), and so is
 * the **fence** its control questions carry: seeded beside the topic's
 * questions and reachable only through a tag nobody else has, they are what
 * makes the filter observable. Without them a filtered game and an unfiltered
 * one could draw the same documents, and the test would pass against a filter
 * that does nothing. Every document is seeded through the fixture under an id
 * of its own, which is what puts them all on the preview sweep's list.
 *
 * **Which run exercises the composite index is the whole reason this file is in
 * both configs.** The Firestore emulator serves any query without one, so a
 * green emulator run says nothing about `firestore.indexes.json` — see
 * `docs/ci-cd.md` §4.3 and `AUDIT_REMEDIATION.md` `D3`. The preview slice runs
 * the same filtered draws against `trivimind-dev`'s real query engine, which
 * refuses a missing index outright, and that — with `quiz-list.spec.ts`'s
 * newest-first query — is the only place in the repo where a declaration is
 * checked against a Firestore rather than against itself;
 * `firestore-tests/indexes.spec.ts` pins what is declared, and the deploy
 * builds it.
 */

const GAME_SIZE = 5;

/** Open Trivia DB's categories, as the shortcut strip offers them on the setup screen. */
const SEED_TAG_COUNT = 24;

const OPEN_TRIVIA_ONLY_SEED_TAGS =
  'Open Trivia plays only the suggested topics — Custom and Mixed take any.';

interface Seed {
  /** The topic this test plays. Every question carrying it was seeded here. */
  topic: string;
  /** The control questions' tag — this test's too, and never the one it plays. */
  fence: string;
  onTopic: (CustomQuestionSeed & { id: string })[];
  fenced: (CustomQuestionSeed & { id: string })[];
}

function seedFor(): Seed {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const topic = runTag('topic');
  const fence = runTag('fence');

  const question = (kind: string, index: number, tag: string) => ({
    id: `tagfilter-${kind.toLowerCase()}-${index}-${runId}`,
    tags: [tag],
    type: 'multiple' as const,
    difficulty: 'easy' as const,
    question: `${kind} question ${index} (${runId})?`,
    correct_answer: `Right ${kind} ${index}`,
    incorrect_answers: [
      `Wrong ${kind} ${index}a`,
      `Wrong ${kind} ${index}b`,
      `Wrong ${kind} ${index}c`,
    ],
  });

  return {
    topic,
    fence,
    onTopic: Array.from({ length: GAME_SIZE }, (_, index) => question('Topic', index, topic)),
    fenced: Array.from({ length: GAME_SIZE }, (_, index) => question('Fenced', index, fence)),
  };
}

/**
 * The text of every question a game served, in the order it served them,
 * answering each one correctly.
 *
 * The right answer comes from the **seed**, looked up by the question on
 * screen, rather than from reading the options: an answer button renders its
 * A/B/C/D badge inside itself, so its `textContent` is the label glued to the
 * answer and matching on the answer's own text finds nothing. Looking it up
 * also fails loudly on a question this spec did not seed, which is the failure
 * worth having on a shared emulator.
 */
async function playAndCollect(
  page: Page,
  seeded: readonly CustomQuestionSeed[],
  count: number,
): Promise<string[]> {
  return playThrough(page, count, async (text) => {
    const question = seeded.find((candidate) => candidate.question === text);
    if (!question) {
      throw new Error(`Served question "${text}" is not one of the seeded ones`);
    }
    await answerQuestion(page, question.correct_answer);
  });
}

/**
 * Plays `count` questions, handing each one's text to `answer`, and returns
 * the texts in the order they were served. Without an `answer`, the first
 * option is taken — for a game whose questions this test cannot know in
 * advance, where what is asserted is where they came from rather than how
 * they were answered.
 *
 * The wait is for the heading to have *moved on*: the quiz holds an answered
 * question on screen for two seconds, so reading it straight after a click
 * can return the one just answered.
 */
async function playThrough(
  page: Page,
  count: number,
  answer: (text: string) => Promise<void> = () => page.getByTestId('answer-option').first().click(),
): Promise<string[]> {
  const served: string[] = [];
  const heading = page.getByTestId('question-text');

  for (let index = 0; index < count; index++) {
    await expect
      .poll(async () => served.includes((await heading.textContent())?.trim() ?? ''), {
        message: 'a question other than the ones already answered is on screen',
      })
      .toBe(false);

    const text = (await heading.textContent())?.trim() ?? '';
    served.push(text);
    await answer(text);
  }

  await expect(page).toHaveURL(/\/game-over$/);
  return served;
}

/** Every `fieldFilter` in a Firestore REST `runQuery` body, however the `where` is nested. */
interface WireFieldFilter {
  field: { fieldPath: string };
  op: string;
  value: { arrayValue?: { values?: { stringValue?: string }[] } };
}

function fieldFiltersIn(value: unknown): WireFieldFilter[] {
  if (Array.isArray(value)) {
    return value.flatMap(fieldFiltersIn);
  }
  if (value === null || typeof value !== 'object') {
    return [];
  }
  const record = value as Record<string, unknown>;
  return [
    ...(record['fieldFilter'] ? [record['fieldFilter'] as WireFieldFilter] : []),
    ...Object.values(record).flatMap(fieldFiltersIn),
  ];
}

/** Whether a request is the community draw: a `runQuery` over `custom_questions`. */
function isCommunityDraw(request: Request): boolean {
  if (request.method() !== 'POST' || !request.url().includes(':runQuery')) {
    return false;
  }
  return JSON.stringify(request.postDataJSON() ?? {}).includes('"custom_questions"');
}

test.describe('the setup screen topic picker', () => {
  test('plays only the questions carrying the chosen topic', async ({ page, firebase }) => {
    const seed = seedFor();
    await firebase.seedCustomQuestions([...seed.onTopic, ...seed.fenced]);
    await stubOpenTrivia(page);
    await page.goto('/');

    // No countdown, for the reason `question-dedup.spec.ts` gives: this spec
    // walks several questions and a fifteen-second clock underneath them makes
    // the deadline the subject of a test about something else.
    await configureTopicGame(page, { topics: [seed.topic], amount: GAME_SIZE, noTimeLimit: true });
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();
    await waitForPlayRoute(page);

    const served = await playAndCollect(page, [...seed.onTopic, ...seed.fenced], GAME_SIZE);

    // Every one on the topic, and none of the five fenced questions seeded
    // beside them — which is what an `array-contains-any` clause buys and a
    // client-side filter over the same read would not.
    expect(served.every((text) => text.startsWith('Topic question'))).toBe(true);
    expect(new Set(served).size).toBe(GAME_SIZE);
  });

  /**
   * Two topics are a request for questions about either. Both tags are this
   * test's, so the ten questions they reach are exactly the ten it seeded — and
   * a ten-question game has to play every one of them, from both sides of the
   * fence.
   */
  test('plays the questions carrying any of the chosen topics', async ({ page, firebase }) => {
    const seed = seedFor();
    const all = [...seed.onTopic, ...seed.fenced];
    await firebase.seedCustomQuestions(all);
    await stubOpenTrivia(page);
    await page.goto('/');

    await configureTopicGame(page, {
      topics: [seed.topic, seed.fence],
      amount: 10,
      noTimeLimit: true,
    });
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();
    await waitForPlayRoute(page);

    const served = await playAndCollect(page, all, all.length);

    expect([...served].sort()).toEqual(all.map((question) => question.question).sort());
  });

  /**
   * Asking for more than the topic has says how many were found and waits. A
   * narrow topic holding fewer questions than a game asks for is the
   * *expected* outcome rather than an unlucky one, so a player who is not told
   * has been misled by omission.
   */
  test('says how many were found when the topic has fewer than were asked for', async ({
    page,
    firebase,
  }) => {
    const seed = seedFor();
    await firebase.seedCustomQuestions([...seed.onTopic, ...seed.fenced]);
    await stubOpenTrivia(page);
    await page.goto('/');

    await configureTopicGame(page, { topics: [seed.topic], amount: 10, noTimeLimit: true });
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();

    const notice = page.getByTestId('short-draw-notice');
    await expect(notice).toContainText(`Only ${GAME_SIZE} of the ${2 * GAME_SIZE} questions`);
    // Still on the setup screen: the game has not started behind the notice.
    await expect(page).toHaveURL(/\/$/);

    // ...and the second press plays what was found, without drawing again.
    await page.getByRole('button', { name: `Play ${GAME_SIZE} Questions`, exact: true }).click();
    await waitForPlayRoute(page);

    const served = await playAndCollect(page, [...seed.onTopic, ...seed.fenced], GAME_SIZE);
    expect(served.every((text) => text.startsWith('Topic question'))).toBe(true);
  });

  /**
   * An Open Trivia game plays one seed tag, because Open Trivia DB's API takes
   * one `category` per request: the picker is a single choice there, the way
   * the category `<select>` it replaced was, and it refuses a typed topic the
   * API cannot be asked for — out loud, on screen and from the live region,
   * rather than accepting it and quietly ignoring it. The request carries the
   * table's id for the tag chosen, and the questions that come back wear their
   * own seed tag.
   */
  test('asks Open Trivia DB for one seed tag, by its id', async ({ page }) => {
    await stubOpenTrivia(page);
    await page.goto('/');

    const chosen = page.getByTestId('filter-tag-selector').getByTestId('selected-tag');
    const status = page.getByTestId('filter-tag-status');

    await page.getByTestId('suggest-tag-history').click();
    await expect(chosen).toHaveText(['#history']);
    await page.getByTestId('suggest-tag-sports').click();
    await expect(chosen).toHaveText(['#sports']);
    await expect(page.getByTestId('suggest-tag-history')).toHaveAttribute('aria-pressed', 'false');
    await expect(status).toHaveText('Replaced history with sports.');

    const input = page.getByTestId('filter-tag-input');
    await input.fill('quantum-physics');
    await input.press('Enter');
    await expect(page.getByTestId('filter-tag-feedback')).toHaveText(OPEN_TRIVIA_ONLY_SEED_TAGS);
    await expect(status).toHaveText(
      `#quantum-physics was not added. ${OPEN_TRIVIA_ONLY_SEED_TAGS}`,
    );
    await expect(chosen).toHaveText(['#sports']);
    await input.fill('');

    await page.locator('#amount').selectOption({ label: String(GAME_SIZE) });
    const request = page.waitForRequest((r) => r.url().startsWith('https://opentdb.com/api.php'));
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();

    // `sports` is id 21 in the table — the request's only source of an id,
    // since nothing fetches Open Trivia DB's category list any more.
    const params = new URL((await request).url()).searchParams;
    expect(params.get('category')).toBe('21');
    expect(params.get('amount')).toBe(String(GAME_SIZE));

    // Every fixture question is `General Knowledge`, which the adapter turns
    // into its seed tag on the way in.
    await waitForPlayRoute(page);
    await expect(page.getByTestId('question-topic')).toHaveText('#general-knowledge');
  });

  /**
   * A Mixed game asks each source for the topic in the shape that source can
   * honour: the community half filters on every chosen tag, and the Open
   * Trivia half follows the first seed tag among them, which the hint names
   * before Start. Checked on the wire for both halves — the Open Trivia
   * request's `category`, and the community query's clause — and then in what
   * was played: five questions from each.
   *
   * **`vehicles`, and the assertions are written so that its being shared is
   * fine.** A seed tag is everybody's: on `trivimind-dev` the bank's own
   * Vehicles questions carry it once the backfill has run, and a concurrent
   * run may have seeded some. So this test seeds five of its own, which is the
   * floor that keeps the community half full, and asserts what holds whichever
   * five answer — that they came from the bank rather than from Open Trivia
   * DB — not which documents they were. No other spec seeds the tag, so on the
   * emulator they are exactly these.
   */
  test('plays a seed tag from both sources in a Mixed game', async ({ page, firebase }) => {
    const seed = seedFor();
    await firebase.seedCustomQuestions(
      seed.onTopic.map((question) => ({ ...question, tags: ['vehicles', seed.topic] })),
    );
    await stubOpenTrivia(page);

    const communityDraws: Request[] = [];
    page.on('request', (request) => {
      if (isCommunityDraw(request)) {
        communityDraws.push(request);
      }
    });
    await page.goto('/');

    await page.locator('#amount').selectOption({ label: String(2 * GAME_SIZE) });
    await optionLabel(page, page.getByRole('radio', { name: 'Mixed', exact: true })).click();
    await page.getByTestId('suggest-tag-vehicles').click();
    await expect(page.getByTestId('filter-tag-selector').getByTestId('selected-tag')).toHaveText([
      '#vehicles',
    ]);
    await expect(page.getByTestId('filter-tag-hint')).toHaveText(
      'Community questions match any of these; Open Trivia ones follow #vehicles.',
    );
    await optionLabel(page, page.getByRole('radio', { name: 'No limit', exact: true })).click();

    const openTrivia = page.waitForRequest((r) =>
      r.url().startsWith('https://opentdb.com/api.php'),
    );
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();

    // The Open Trivia half: half the game, under `vehicles`' id from the table.
    const params = new URL((await openTrivia).url()).searchParams;
    expect(params.get('category')).toBe('28');
    expect(params.get('amount')).toBe(String(GAME_SIZE));

    await waitForPlayRoute(page);

    // The community half: the chosen tag as an `array-contains-any`, and no
    // `category` clause — there is nothing left to send one.
    expect(communityDraws.length).toBeGreaterThan(0);
    const filters = fieldFiltersIn(communityDraws[0].postDataJSON());
    const tagFilter = filters.find((filter) => filter.field.fieldPath === 'tags');
    expect(tagFilter?.op).toBe('ARRAY_CONTAINS_ANY');
    expect(tagFilter?.value.arrayValue?.values?.map((value) => value.stringValue)).toEqual([
      'vehicles',
    ]);
    expect(filters.some((filter) => filter.field.fieldPath === 'category')).toBe(false);

    const served = await playThrough(page, 2 * GAME_SIZE);
    const fixtureTexts = questionsFixture.results.map((question) => question.question);

    expect(new Set(served).size).toBe(2 * GAME_SIZE);
    expect(served.filter((text) => fixtureTexts.includes(text))).toHaveLength(GAME_SIZE);
    expect(served.filter((text) => !fixtureTexts.includes(text))).toHaveLength(GAME_SIZE);
  });
});

/** Where the setup card and its Start button are — see {@link setupGeometry}. */
interface SetupGeometry {
  cardTop: number;
  cardHeight: number;
  startTop: number;
}

/**
 * Where the setup card and its Start button are, in document coordinates, read
 * in one call: two measurements a frame apart disagree for reasons that have
 * nothing to do with the invariant, and a lone `boundingBox()` is a race rather
 * than an assertion (`CLAUDE.md` §4.6). Document rather than viewport
 * coordinates, so a click that scrolls a control into view is not mistaken for
 * the layout moving.
 */
function setupGeometry(page: Page): Promise<SetupGeometry> {
  return page.evaluate(() => {
    const card = document.querySelector('[data-cy="setup-card"]')!.getBoundingClientRect();
    const start = document
      .querySelector('[data-cy="setup-card"] form button[type="submit"]')!
      .getBoundingClientRect();
    return {
      cardTop: card.top + window.scrollY,
      cardHeight: card.height,
      startTop: start.top + window.scrollY,
    };
  });
}

/**
 * {@link setupGeometry} once two consecutive readings agree — the baseline the
 * geometry test compares against, read the way `settledHeight` in
 * `support/layout.ts` reads one: a single read lands on whatever frame the
 * page happened to be in (`CLAUDE.md` §4.6), and a baseline taken mid-layout
 * would fail every comparison after it for a move nobody made.
 */
async function settledSetupGeometry(page: Page): Promise<SetupGeometry> {
  let previous: SetupGeometry | null = null;
  let settled: SetupGeometry | null = null;
  await expect
    .poll(
      async () => {
        const now = await setupGeometry(page);
        const agrees =
          previous !== null &&
          drift(now.cardTop, previous.cardTop) === 0 &&
          drift(now.cardHeight, previous.cardHeight) === 0 &&
          drift(now.startTop, previous.startTop) === 0;
        previous = now;
        if (agrees) {
          settled = now;
        }
        return agrees;
      },
      { message: 'the setup card settling at rest' },
    )
    .toBe(true);
  return settled!;
}

/**
 * Fails unless the card and its Start button are exactly where they were at
 * rest, once whatever just changed has finished rendering. Polled, because the
 * render is not something the runner synchronises with; a move that reaches
 * the screen is not forgiven by polling, because the only value this can settle
 * to is the one it started at.
 */
async function expectUnmovedSince(page: Page, atRest: SetupGeometry, after: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const now = await setupGeometry(page);
        return {
          cardTop: drift(now.cardTop, atRest.cardTop),
          cardHeight: drift(now.cardHeight, atRest.cardHeight),
          startTop: drift(now.startTop, atRest.startTop),
        };
      },
      { message: `the setup card moved after ${after}` },
    )
    .toEqual({ cardTop: 0, cardHeight: 0, startTop: 0 });
}

/**
 * How far the card sits below the top of the space it is centred in, beyond
 * that space's own padding. Zero means the card is taller than the window and
 * pinned to the top, where a change in its height moves nothing above its own
 * bottom edge — the trap `CLAUDE.md` §4.4 records, a shift that measured 0px at
 * 390×700 while it was 43px at 390×1000. Asserted before any measurement, so a
 * viewport that has stopped being tall enough fails here, saying so, instead of
 * passing for the wrong reason.
 */
function centringSlack(page: Page): Promise<number> {
  return page.evaluate(() => {
    const card = document.querySelector('[data-cy="setup-card"]')!;
    const space = card.parentElement!;
    const offset = card.getBoundingClientRect().top - space.getBoundingClientRect().top;
    return offset - parseFloat(getComputedStyle(space).paddingTop);
  });
}

/** The setup screen, at rest: the shortcut chips landed, the allowance resolved, the fonts in. */
async function setupAtRest(page: Page): Promise<void> {
  await expect(page.getByTestId('filter-tag-suggestions').getByRole('button')).toHaveCount(
    SEED_TAG_COUNT,
  );
  await expect(page.getByTestId('daily-allowance')).toContainText('free games left today');
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/**
 * The picker keeps the setup card the same size whatever the source and the
 * selection do (`CLAUDE.md` §4.4), and nothing below a real browser can see
 * that: jsdom has no layout. Each source has its own hint, a Mixed game's names
 * the seed tag its Open Trivia half follows, switching into Open Trivia trims
 * the selection and says so, and a refused topic says why — every one of them
 * a line that could wrap differently, under the reader, at the moment they
 * change a setting. The picker reserves each line at the tallest thing it can
 * carry, and the chip box scrolls rather than grows.
 *
 * **At two widths, and tall at both.** A narrow card wraps every hint to more
 * lines than a wide one, so a line that holds still at one width can move at
 * the other — an unreserved hint measured 16px against 32px, with the Start
 * button 16px lower, at 1280, and not a pixel of either at 390. And below a
 * certain height the card overflows the window and is pinned to the top, where
 * nothing moves however wrong the layout is: the card is 1,164px tall at 390
 * and 1,100px at 1280, so 1,400 is what leaves it room to move (78px and
 * 110px). `centringSlack` is asserted first, so a card that grows past that
 * fails here, saying so, rather than passing for the wrong reason.
 */
for (const viewport of [
  { width: 390, height: 1400 },
  { width: 1280, height: 1400 },
]) {
  test.describe(`the setup card at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test('stays put while the source and the topics change', async ({ page }) => {
      await stubOpenTrivia(page);
      await page.goto('/');
      await setupAtRest(page);

      await expect
        .poll(() => centringSlack(page), { message: 'the card has room to move' })
        .toBeGreaterThan(8);
      const atRest = await settledSetupGeometry(page);

      const hint = page.getByTestId('filter-tag-hint');
      const feedback = page.getByTestId('filter-tag-feedback');
      const status = page.getByTestId('filter-tag-status');
      const chosen = page.getByTestId('filter-tag-selector').getByTestId('selected-tag');
      const input = page.getByTestId('filter-tag-input');
      const source = (name: string) =>
        optionLabel(page, page.getByRole('radio', { name, exact: true })).click();

      await source('Custom');
      await expect(hint).toHaveText('Pick topics to play questions about exactly those subjects.');
      await expectUnmovedSince(page, atRest, 'switching to Custom');

      // Enough topics, of both kinds, to wrap the chip box past its two rows.
      await page.getByTestId('suggest-tag-history').click();
      for (const typed of ['my-own-topic', 'another-typed-topic', 'a-third-one-of-mine']) {
        await input.fill(typed);
        await input.press('Enter');
      }
      await page.getByTestId('suggest-tag-sports').click();
      await expect(chosen).toHaveText([
        '#history',
        '#my-own-topic',
        '#another-typed-topic',
        '#a-third-one-of-mine',
        '#sports',
      ]);
      await expectUnmovedSince(page, atRest, 'choosing five topics');

      await source('Mixed');
      await expect(hint).toHaveText(
        'Community questions match any of these; Open Trivia ones follow #history.',
      );
      await expectUnmovedSince(page, atRest, 'switching to Mixed');

      // Switching into Open Trivia keeps the first seed tag and says what went,
      // on screen and from the live region.
      await source('Open Trivia');
      await expect(chosen).toHaveText(['#history']);
      await expect(feedback).toHaveText(
        'Open Trivia plays one suggested topic, so the others were removed.',
      );
      await expect(status).toHaveText(
        'Open Trivia plays one suggested topic. Kept #history; removed #my-own-topic, ' +
          '#another-typed-topic, #a-third-one-of-mine and #sports.',
      );
      await expectUnmovedSince(page, atRest, 'switching to Open Trivia');

      await input.fill('quantum-physics');
      await input.press('Enter');
      await expect(feedback).toHaveText(OPEN_TRIVIA_ONLY_SEED_TAGS);
      await expectUnmovedSince(page, atRest, 'refusing a typed topic');
    });
  });
}

/** What the strip sampler records on every frame: where the Start button is, and the strip. */
interface SampledFrame {
  startTop: number;
  stripHeight: number;
  chips: number;
}

/**
 * The shortcut strip is the one part of the picker that arrives by itself: its
 * chips render on the first idle moment, or the first focus inside the picker,
 * because rendering them with the first frame cost the home route a measured
 * 0.3s of largest contentful paint. What keeps that deferral free is that the
 * strip is a **fixed-height box from first paint** that the chips land in
 * (`CLAUDE.md` §4.4's first technique) — so this asserts it the way a reader
 * would notice it failing: on every frame, from the empty strip to the full
 * one.
 *
 * **The idle moment is taken from the browser rather than waited for.** Idle
 * is the browser's to choose, and it can come before the runner has measured
 * anything — which would leave the "before" this test exists to compare
 * against unmeasured. So the page's `requestIdleCallback` holds the callbacks
 * registered once the picker exists until the test lets them go, and a
 * `requestAnimationFrame` loop records the Start button and the strip on every
 * frame in between. Holding a callback only delays it; it is the real callback
 * that runs.
 */
test.describe('the shortcut strip', () => {
  test.use({ viewport: { width: 390, height: 1400 } });

  test('fills its reserved box without moving anything', async ({ page }) => {
    await page.addInitScript(() => {
      const scope = window as unknown as Record<string, unknown>;
      const nativeRequest = window.requestIdleCallback.bind(window);
      const nativeCancel = window.cancelIdleCallback.bind(window);
      const held = new Map<number, IdleRequestCallback>();
      let nextHandle = -1;
      let holding = true;

      window.requestIdleCallback = (callback, options) => {
        if (holding && document.querySelector('[data-cy="filter-tag-selector"]')) {
          const handle = nextHandle--;
          held.set(handle, callback);
          return handle;
        }
        return nativeRequest(callback, options);
      };
      window.cancelIdleCallback = (handle) => {
        if (!held.delete(handle)) {
          nativeCancel(handle);
        }
      };
      scope['releaseIdle'] = () => {
        holding = false;
        for (const callback of held.values()) {
          nativeRequest(callback);
        }
        held.clear();
      };

      const frames: SampledFrame[] = [];
      let sampling = false;
      const sample = () => {
        if (!sampling) {
          return;
        }
        const start = document.querySelector('[data-cy="setup-card"] form button[type="submit"]');
        const strip = document.querySelector('[data-cy="filter-tag-suggestions"]');
        if (start && strip) {
          frames.push({
            startTop: start.getBoundingClientRect().top + window.scrollY,
            stripHeight: strip.getBoundingClientRect().height,
            chips: strip.querySelectorAll('button').length,
          });
        }
        requestAnimationFrame(sample);
      };
      scope['startSampling'] = () => {
        sampling = true;
        requestAnimationFrame(sample);
      };
      scope['sampledFrames'] = () => frames;
      scope['stopSampling'] = () => {
        sampling = false;
        return frames;
      };
    });
    await stubOpenTrivia(page);
    await page.goto('/');

    const chips = page.getByTestId('filter-tag-suggestions').getByRole('button');
    await expect(page.getByRole('button', { name: 'Start Game', exact: true })).toBeVisible();
    await expect(page.getByTestId('daily-allowance')).toContainText('free games left today');
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await expect
      .poll(() => centringSlack(page), { message: 'the card has room to move' })
      .toBeGreaterThan(8);

    // Empty, and already its full height: the box is there before the chips are.
    await expect(chips).toHaveCount(0);
    await expect
      .poll(async () => (await page.getByTestId('filter-tag-suggestions').boundingBox())?.height, {
        message: 'the empty strip already at its full height',
      })
      .toBeGreaterThan(60);

    const call = <T>(name: string) =>
      page.evaluate((fn) => (window as unknown as Record<string, () => T>)[fn](), name);

    await call('startSampling');
    await expect
      .poll(async () => (await call<SampledFrame[]>('sampledFrames')).length)
      .toBeGreaterThan(3);
    await call('releaseIdle');

    await expect(chips).toHaveCount(SEED_TAG_COUNT);
    await expect
      .poll(
        async () => (await call<SampledFrame[]>('sampledFrames')).filter((f) => f.chips > 0).length,
      )
      .toBeGreaterThan(5);
    const frames = await call<SampledFrame[]>('stopSampling');

    // The comparison spans the change, rather than starting after it.
    expect(frames.some((frame) => frame.chips === 0)).toBe(true);
    expect(frames.some((frame) => frame.chips === SEED_TAG_COUNT)).toBe(true);

    const [first] = frames;
    const moved = frames.filter(
      (frame) =>
        drift(frame.startTop, first.startTop) !== 0 ||
        drift(frame.stripHeight, first.stripHeight) !== 0,
    );
    expect(moved, 'frames where the Start button or the strip moved').toEqual([]);
  });
});
