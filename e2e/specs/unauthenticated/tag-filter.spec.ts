import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { CustomQuestionSeed } from '../../fixtures/types';
import { answerQuestion, optionLabel, waitForPlayRoute } from '../../support/game';
import { stubExtraCategory, stubOpenTrivia } from '../../support/open-trivia';

/**
 * `FEAT-021` — the setup screen's topic filter, end to end.
 *
 * **Why a real browser is needed at all.** The unit specs already pin the query
 * the service builds, the chips the picker produces and the config the screen
 * emits. What none of them can see is the three of those wired together
 * through a played round: a `ControlValueAccessor` that never writes back, a
 * `tags` key dropped between the form and `GameConfig`, or a clause that
 * reaches Firestore in a shape the real query engine refuses would all pass
 * every unit test in the repo and serve nobody a question.
 *
 * **Isolation in a bank this spec does not own is the invented tag**, exactly as
 * `question-dedup.spec.ts` uses an invented category. Every worker in the run
 * writes to one bank — and on `trivimind-dev` so does everyone else, for good —
 * so an assertion about *which* questions a filter served only means something
 * if this test owns every question that can match it. A tag carrying the run id
 * does that on its own, and it is a stronger fence than the category, because a
 * tag filter also has to exclude the untagged questions this spec seeds beside
 * the tagged ones. Every document it writes is seeded through the fixture under
 * an id of its own, which is what puts them all on the preview sweep's list.
 *
 * **Which run exercises the composite index is the whole reason this file is in
 * both configs.** The Firestore emulator serves any query without one, so a
 * green emulator run says nothing about `firestore.indexes.json` — see
 * `docs/ci-cd.md` §4.3 and `AUDIT_REMEDIATION.md` `D3`. The preview slice runs
 * the same three filtered draws against `trivimind-dev`'s real query engine,
 * which refuses a missing index outright, and that is the only place in the
 * repo where the declaration is checked against a Firestore rather than against
 * itself; `firestore-tests/indexes.spec.ts` pins what is declared, and the
 * deploy builds it.
 */

const GAME_SIZE = 5;

interface Seed {
  category: string;
  /** The tag this run owns. Every question carrying it was seeded here. */
  tag: string;
  tagged: (CustomQuestionSeed & { id: string })[];
  untagged: (CustomQuestionSeed & { id: string })[];
}

function seedFor(): Seed {
  // Lower-case and hyphenated, because a tag is compared as stored: the filter
  // sends exactly what the normaliser produced, and a run id with an upper-case
  // letter in it would be a tag no question could ever carry.
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
  const tag = `e2e-topic-${runId}`;
  const category = `Tags ${runId}`;

  const question = (kind: string, index: number, tags?: string[]) => ({
    id: `tagfilter-${kind}-${index}-${runId}`,
    category,
    type: 'multiple' as const,
    difficulty: 'easy' as const,
    question: `${kind} question ${index} (${runId})?`,
    correct_answer: `Right ${kind} ${index}`,
    incorrect_answers: [
      `Wrong ${kind} ${index}a`,
      `Wrong ${kind} ${index}b`,
      `Wrong ${kind} ${index}c`,
    ],
    ...(tags ? { tags } : {}),
  });

  return {
    category,
    tag,
    tagged: Array.from({ length: GAME_SIZE }, (_, index) => question('Tagged', index, [tag])),
    // Seeded and never expected: these are what makes the filter observable.
    // Without them a filtered game and an unfiltered one would draw the same
    // documents, and the test would pass against a filter that does nothing.
    untagged: Array.from({ length: GAME_SIZE }, (_, index) => question('Untagged', index)),
  };
}

/**
 * Configures a Custom-source game over this run's own category, optionally
 * narrowed to its own tag, and presses Start.
 *
 * The topic picker is only offered for a source that has tags, so the source
 * radio is chosen **before** the topic — the reverse order would find a
 * disabled button.
 */
async function configureGame(
  page: Page,
  seed: Seed,
  options: { amount: number; withTag: boolean },
): Promise<void> {
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('#category')).toContainText(seed.category);
  await page.locator('#amount').selectOption({ label: String(options.amount) });
  await page.locator('#category').selectOption(seed.category);
  await optionLabel(page, page.getByRole('radio', { name: 'Custom', exact: true })).click();
  // No countdown, for the reason `question-dedup.spec.ts` gives: this spec
  // walks several questions and a fifteen-second clock underneath them makes
  // the deadline the subject of a test about something else.
  await optionLabel(page, page.getByRole('radio', { name: 'No limit', exact: true })).click();

  if (options.withTag) {
    const input = page.getByTestId('filter-tag-input');
    await input.fill(seed.tag);
    await input.press('Enter');
    await expect(page.getByTestId('filter-tag-selector').getByTestId('selected-tag')).toHaveText([
      `#${seed.tag}`,
    ]);
  }
}

/**
 * The text of every question a game served, in the order it served them.
 *
 * The right answer comes from the **seed**, looked up by the question on
 * screen, rather than from reading the options: an answer button renders its
 * A/B/C/D badge inside itself, so its `textContent` is the label glued to the
 * answer and matching on the answer's own text finds nothing. Looking it up
 * also fails loudly on a question this spec did not seed, which is the failure
 * worth having on a shared emulator.
 */
async function playAndCollect(page: Page, seed: Seed, count: number): Promise<string[]> {
  const served: string[] = [];
  const all = [...seed.tagged, ...seed.untagged];
  const heading = page.getByTestId('question-text');

  for (let index = 0; index < count; index++) {
    await expect
      .poll(async () => served.includes((await heading.textContent())?.trim() ?? ''), {
        message: 'a question other than the ones already answered is on screen',
      })
      .toBe(false);

    const text = (await heading.textContent())?.trim() ?? '';
    const question = all.find((candidate) => candidate.question === text);
    if (!question) {
      throw new Error(`Served question "${text}" is not one of the seeded ones`);
    }
    served.push(text);
    await answerQuestion(page, question.correct_answer);
  }

  await expect(page).toHaveURL(/\/game-over$/);
  return served;
}

/**
 * Resolves once the shortcut row's reveal has finished moving.
 *
 * The predicate is derived from the content rather than from a pixel count or a
 * wall-clock wait: the shortcut group is the last thing inside the animating
 * container, so the two share a bottom edge exactly when the container has
 * reached the group's full height. Mid-transition the container is shorter and
 * the group is clipped, which reads as a negative number. Nothing here needs
 * re-measuring when the row's contents change.
 */
async function waitForShortcutRowRevealed(page: Page): Promise<void> {
  await expect(page.getByTestId('filter-tag-suggestions')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const box = (selector: string) =>
          document.querySelector(selector)!.getBoundingClientRect().bottom;
        return Math.round(
          box('[data-cy="filter-tag-suggestions-reveal"]') -
            box('[data-cy="filter-tag-suggestions"]'),
        );
      }),
    )
    .toBe(0);
}

test.describe('the setup screen topic filter', () => {
  test('plays only the questions carrying the chosen topic', async ({ page, firebase }) => {
    const seed = seedFor();
    await firebase.seedCustomQuestions([...seed.tagged, ...seed.untagged]);
    await stubOpenTrivia(page);
    await stubExtraCategory(page, seed.category);
    await page.goto('/');

    await configureGame(page, seed, { amount: GAME_SIZE, withTag: true });
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();
    await waitForPlayRoute(page);

    const served = await playAndCollect(page, seed, GAME_SIZE);

    // Every one tagged, and none of the five untagged questions sitting in the
    // same category — which is what an `array-contains-any` clause buys and a
    // client-side filter over the same read would not.
    expect(served.every((text) => text.startsWith('Tagged question'))).toBe(true);
    expect(new Set(served).size).toBe(GAME_SIZE);
  });

  /**
   * The additive half, and the one whose regression would be catastrophic
   * rather than annoying: the bank is almost entirely untagged, so a clause
   * that leaked into the default draw would empty every custom game in the app
   * rather than narrowing it.
   */
  test('serves untagged questions when no topic is chosen', async ({ page, firebase }) => {
    const seed = seedFor();
    await firebase.seedCustomQuestions([...seed.tagged, ...seed.untagged]);
    await stubOpenTrivia(page);
    await stubExtraCategory(page, seed.category);
    await page.goto('/');

    await configureGame(page, seed, { amount: 2 * GAME_SIZE, withTag: false });
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();
    await waitForPlayRoute(page);

    const served = await playAndCollect(page, seed, 2 * GAME_SIZE);

    expect(served.some((text) => text.startsWith('Untagged question'))).toBe(true);
    expect(served).toHaveLength(2 * GAME_SIZE);
  });

  /**
   * Asking for more than the topic has says how many were found and waits. The
   * bank being mostly untagged makes this the *expected* outcome of a narrow
   * filter rather than an unlucky one, so a player who is not told has been
   * misled by omission.
   */
  test('says how many were found when the topic has fewer than were asked for', async ({
    page,
    firebase,
  }) => {
    const seed = seedFor();
    await firebase.seedCustomQuestions([...seed.tagged, ...seed.untagged]);
    await stubOpenTrivia(page);
    await stubExtraCategory(page, seed.category);
    await page.goto('/');

    await configureGame(page, seed, { amount: 2 * GAME_SIZE, withTag: true });
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();

    const notice = page.getByTestId('short-draw-notice');
    await expect(notice).toContainText(`Only ${GAME_SIZE} of the ${2 * GAME_SIZE} questions`);
    // Still on the setup screen: the game has not started behind the notice.
    await expect(page).toHaveURL(/\/$/);

    // ...and the second press plays what was found, without drawing again.
    await page.getByRole('button', { name: `Play ${GAME_SIZE} Questions`, exact: true }).click();
    await waitForPlayRoute(page);

    const served = await playAndCollect(page, seed, GAME_SIZE);
    expect(served.every((text) => text.startsWith('Tagged question'))).toBe(true);
  });

  /**
   * Only the community bank carries tags, so the picker is put out of reach for
   * an Open Trivia DB game rather than accepted and quietly ignored. Asserted
   * on the real disabled attribute and the real sentence, because "greyed out"
   * with no reason is a dead end for the reader.
   */
  test('is unavailable for an Open Trivia game, and says why', async ({ page }) => {
    await stubOpenTrivia(page);
    await page.goto('/');

    await expect(page.getByTestId('filter-tag-input')).toBeDisabled();
    await expect(page.getByTestId('filter-tag-feedback')).toContainText(
      'Only community questions carry topics',
    );

    await optionLabel(page, page.getByRole('radio', { name: 'Custom', exact: true })).click();

    await expect(page.getByTestId('filter-tag-input')).toBeEnabled();
  });

  /**
   * The picker keeps the same height as chips are added — which nothing below a
   * real browser can see (`CLAUDE.md` §4.4: jsdom has no layout). Measured
   * around the *whole* control rather than the chip row, because the failure
   * this prevents is the Start button moving down the screen while the reader
   * is choosing topics.
   */
  test('does not resize as topics are added', async ({ page }) => {
    await stubOpenTrivia(page);
    await page.goto('/');
    await optionLabel(page, page.getByRole('radio', { name: 'Custom', exact: true })).click();

    const selector = page.getByTestId('filter-tag-selector');
    // Switching source animates the shortcut row in (see below), and that is
    // this test's *setup* rather than its subject: a "before" taken while the
    // reveal is still running is a height the control is only passing through,
    // and every later comparison is then against a number that never existed at
    // rest. Waiting for the row to land is what makes the measurement mean
    // "the control, ready to be used".
    await waitForShortcutRowRevealed(page);
    const before = await selector.boundingBox();

    const input = page.getByTestId('filter-tag-input');
    for (const topic of ['alpha-topic', 'beta-topic', 'gamma-topic', 'delta-topic']) {
      await input.fill(topic);
      await input.press('Enter');
    }
    await expect(selector.getByTestId('selected-tag')).toHaveCount(4);

    // Polled rather than read once: a layout frame can land after the last
    // chip renders, and a single `boundingBox()` is a race rather than an
    // assertion (`CLAUDE.md` §4.6).
    await expect
      .poll(async () => Math.round((await selector.boundingBox())!.height))
      .toBe(Math.round(before!.height));
  });

  /**
   * Switching between the two sources that *have* topics swaps the hint under
   * the label — and the two hints do not wrap to the same number of lines at
   * every width, so the line was growing by one under the reader at the exact
   * moment they changed a setting, moving the Start button with no animation
   * (`CLAUDE.md` §4.4). The picker is handed both hints and reserves the taller.
   *
   * **Wide on purpose, which is the mirror image of the trap in the sibling
   * describe below.** That one needs a *tall* window, because a short one pins
   * the card to the top and measures 0px of a real shift. This one needs a
   * *wide* one: at 390 the card is narrow enough that both hints wrap to two
   * lines regardless, so the identical test passes there against an unreserved
   * line and proves nothing. Measured before the reserve: the hint 16px against
   * 32px and the Start button at y=1129 against y=1145 at 1280×1000, and not
   * one pixel of either at 390×1000.
   */
  test.describe('switching between the two sources that carry topics', () => {
    test.use({ viewport: { width: 1280, height: 1000 } });

    test('swaps the hint without moving the Start button', async ({ page }) => {
      await stubOpenTrivia(page);
      await page.goto('/');

      const hint = page.getByTestId('filter-tag-hint');
      const selector = page.getByTestId('filter-tag-selector');
      const start = page.getByRole('button', { name: 'Start Game', exact: true });

      /**
       * The Start button's top and the whole control's height, read together in
       * one call: two measurements taken a frame apart disagree for reasons that
       * have nothing to do with the invariant, and a lone `boundingBox()` is a
       * race rather than an assertion (`CLAUDE.md` §4.6). The height is in there
       * so "the button did not move because nothing rendered" cannot pass.
       */
      const geometry = async () => {
        const [button, control] = await Promise.all([start.boundingBox(), selector.boundingBox()]);
        return { startY: Math.round(button!.y), controlHeight: Math.round(control!.height) };
      };

      await optionLabel(page, page.getByRole('radio', { name: 'Custom', exact: true })).click();
      // Reaching Custom reveals the shortcut row, which animates for 300ms —
      // this test's setup rather than its subject, so the baseline waits for it
      // to land (the describe below is where that reveal is the subject).
      await waitForShortcutRowRevealed(page);
      const atRest = await geometry();

      await optionLabel(page, page.getByRole('radio', { name: 'Mixed', exact: true })).click();

      // The hint really did change. Without this the test would pass against a
      // control that ignores the source altogether, which is the vacuous
      // version of it.
      await expect(hint).toHaveText(
        'Narrows the community half of the game; Open Trivia questions carry no topics.',
      );
      await expect.poll(geometry).toEqual(atRest);

      await optionLabel(page, page.getByRole('radio', { name: 'Custom', exact: true })).click();
      await expect(hint).toHaveText('Pick topics to play questions about exactly those subjects.');
      await expect.poll(geometry).toEqual(atRest);
    });
  });

  /**
   * The one state change the filter cannot make at a constant size, and
   * therefore the one that animates (`CLAUDE.md` §4.4).
   *
   * Switching to a source that has topics reveals the shortcut row, which is
   * 108px the control did not have before — and reserving that from first paint
   * would put an empty box on the home route for the majority who never leave
   * Open Trivia, at a measured cost to the largest contentful paint (the
   * numbers are on the selector's template). So the row's *height* is what
   * appears, over 300ms, and everything below it glides.
   *
   * **What is asserted is the mechanism, not a distance.** The Start button's
   * displacement has to equal the height the container gained — which says the
   * animated box accounts for *all* of the movement, and would fail on a second
   * un-animated resize elsewhere in the control however the copy or the layout
   * changes later. Measured at the time of writing: 216px of control before,
   * 324px after, the Start button 108px lower.
   *
   * **A tall viewport on purpose.** Below a certain height the centred card
   * already overflows its container and is pinned to the top, and §4.4 records
   * a shift measuring exactly 0px at 390×700 while it was 43px at 390×1000. A
   * check at a convenient window size calls this fixed while it is broken.
   */
  test.describe('revealing the shortcut row', () => {
    test.use({ viewport: { width: 390, height: 1000 } });

    /** How far the Start button has moved, less the height the reveal gained. */
    const overshoot = async (page: Page, from: number) => {
      const [button, revealed] = await Promise.all([
        page.getByRole('button', { name: 'Start Game', exact: true }).boundingBox(),
        page
          .getByTestId('filter-tag-suggestions-reveal')
          .evaluate((el) => el.getBoundingClientRect().height),
      ]);
      return Math.round(button!.y - from - revealed);
    };

    test('animates it, so nothing below it jumps', async ({ page }) => {
      await stubOpenTrivia(page);
      await page.goto('/');

      const reveal = page.getByTestId('filter-tag-suggestions-reveal');
      const start = page.getByRole('button', { name: 'Start Game', exact: true });
      const rows = () => reveal.evaluate((el) => getComputedStyle(el).gridTemplateRows);

      // Collapsed to nothing before the switch. Asserting that first is also
      // what settles the layout the "before" measurement is taken against.
      await expect(page.getByTestId('filter-tag-input')).toBeDisabled();
      await expect.poll(rows).toBe('0px');

      // Declared on the container itself, which is what makes the row's own
      // height the thing that animates — no pixel count is written down
      // anywhere, so the copy can grow without anybody re-measuring it.
      expect(await reveal.evaluate((el) => getComputedStyle(el).transitionProperty)).toBe(
        'grid-template-rows',
      );
      expect(await reveal.evaluate((el) => getComputedStyle(el).transitionDuration)).not.toBe('0s');

      const before = (await start.boundingBox())!.y;

      await optionLabel(page, page.getByRole('radio', { name: 'Custom', exact: true })).click();
      await waitForShortcutRowRevealed(page);

      // The two boxes are read together in one poll rather than one at a time:
      // measurements a frame apart during a 300ms transition disagree for
      // reasons that have nothing to do with the invariant (§4.6). The height
      // is asserted as well, so "nothing grew and nothing moved" cannot pass.
      await expect.poll(() => overshoot(page, before)).toBe(0);
      await expect
        .poll(() => reveal.evaluate((el) => Math.round(el.getBoundingClientRect().height)))
        .toBeGreaterThan(100);

      // ...and back again. The row stays in the DOM so the collapse has a
      // height to collapse — removed in the same frame it would leave an empty
      // box and the Start button would snap back up — with the whole region
      // `inert`, so a row nobody can see is a row nobody can Tab into.
      await optionLabel(
        page,
        page.getByRole('radio', { name: 'Open Trivia', exact: true }),
      ).click();
      await expect(page.getByTestId('filter-tag-suggestions')).toBeAttached();
      await expect(reveal).toHaveAttribute('inert', '');
      await expect.poll(rows).toBe('0px');
      await expect
        .poll(async () => Math.round((await start.boundingBox())!.y))
        .toBe(Math.round(before));
    });

    /**
     * Motion is opt-out by default (`CLAUDE.md` §4.5), so the whole thing is
     * behind `motion-safe:` — which emits no declaration at all under the
     * preference rather than a faster one. The reader gets the change in the
     * frame they asked for it, at the same destination.
     *
     * **The preference is set with `page.emulateMedia`, and the obvious way of
     * writing it does not work here.** `test.use({ reducedMotion: 'reduce' })`
     * is silently ignored in this setup — measured at file level, at describe
     * level, and against a plain `@playwright/test` `test` as well as this
     * suite's extended one: `matchMedia('(prefers-reduced-motion: reduce)')`
     * stayed `false` in every one, while `emulateMedia` flipped it and took the
     * transition's computed duration from `0.3s` to `0s`. A test written the
     * ignored way passes against an *ungated* animation, which is the whole of
     * what it exists to catch.
     */
    test.describe('for a reader who asked for less of it', () => {
      test('changes at once instead', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await stubOpenTrivia(page);
        await page.goto('/');

        const reveal = page.getByTestId('filter-tag-suggestions-reveal');
        const start = page.getByRole('button', { name: 'Start Game', exact: true });

        await expect(page.getByTestId('filter-tag-input')).toBeDisabled();
        // Not "a short transition": there is none to run. `motion-safe:` emits
        // nothing under the preference, so the duration is back to its initial
        // `0s` and the property to its initial `all`.
        expect(await reveal.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');

        const before = (await start.boundingBox())!.y;

        await optionLabel(page, page.getByRole('radio', { name: 'Custom', exact: true })).click();
        await waitForShortcutRowRevealed(page);

        // The same destination as the animated path, reached without one.
        await expect.poll(() => overshoot(page, before)).toBe(0);
        await expect
          .poll(() => reveal.evaluate((el) => Math.round(el.getBoundingClientRect().height)))
          .toBeGreaterThan(100);
      });
    });
  });
});
