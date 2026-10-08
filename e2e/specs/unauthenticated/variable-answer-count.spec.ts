import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { CustomQuestionSeed } from '../../fixtures/types';
import { answerOption } from '../../support/game';
import { drift } from '../../support/layout';
import { stubOpenTrivia } from '../../support/open-trivia';
import { runTag, startTopicGame } from '../../support/topics';

/**
 * `FEAT-051` in a real browser: a question carries two to six options and a
 * statement of up to 2,000 characters, and the quiz card has to play every one
 * of those shapes cleanly.
 *
 * **This is the only layer that can see any of it.** jsdom has no layout, so
 * the unit spec can say which class the grid carries and what 50/50 removes,
 * and nothing about whether six options actually stack in one column, whether
 * an eliminated option kept its cell, or whether a 2,000-character statement
 * grew the card instead of scrolling inside it.
 *
 * **Every box is measured in document coordinates.** A long statement pushes
 * the options below the fold, and clicking one scrolls the page — so a
 * viewport-relative `boundingBox()` would report the scroll as a layout shift.
 * Reading `getBoundingClientRect()` plus the scroll offset in the page makes
 * the measurement about the layout alone.
 *
 * **Isolation is a topic each test mints** (`e2e/support/topics.ts`): the bank
 * is shared by every worker, and a custom-source game filtered on a run tag
 * draws exactly the questions the test seeded. Played with no time limit,
 * because these tests stop between reads to measure, and a countdown running
 * underneath would make the deadline the subject of a test about layout.
 *
 * Under `unauthenticated/`, so the preview slice runs it too: it seeds through
 * the `firebase` fixture, whose sweep deletes every seeded question by id, and
 * plays anonymously — the footprint every spec in this directory has.
 */

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Five distinct wrong answers — the most a question may carry. */
const FIVE_WRONG = ['Venus', 'Mercury', 'Saturn', 'Neptune', 'Uranus'];

/**
 * A statement of exactly 2,000 characters, the most `firestore.rules` accepts:
 * words and single spaces, as an exam question would be, rather than one
 * unbroken run — and no trailing space, so the text the card renders is the
 * text that was stored.
 */
function statementOf(runId: string): string {
  let text = `(${runId}) Read the case below, then choose the option that follows from it.`;
  while (text.length < 2000) {
    text += ' The figures are given once, in this statement, and are not repeated in the options.';
  }
  text = text.slice(0, 2000);
  return text.endsWith(' ') ? `${text.slice(0, -1)}.` : text;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Every option's box, in document coordinates. One read; poll it. */
function optionBoxes(page: Page): Promise<Box[]> {
  return page.getByTestId('answer-option').evaluateAll((options) =>
    options.map((option) => {
      const rect = option.getBoundingClientRect();
      return {
        top: rect.top + window.scrollY,
        left: rect.left + window.scrollX,
        width: rect.width,
        height: rect.height,
      };
    }),
  );
}

/** The question card's box, in document coordinates. One read; poll it. */
function cardBox(page: Page): Promise<Box> {
  return page.getByTestId('question-card').evaluate((card) => {
    const rect = card.getBoundingClientRect();
    return {
      top: rect.top + window.scrollY,
      left: rect.left + window.scrollX,
      width: rect.width,
      height: rect.height,
    };
  });
}

/** The furthest any edge of any box moved, after `drift()`'s sub-pixel tolerance. */
function largestShift(before: Box[], after: Box[]): number {
  if (before.length !== after.length) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(
    0,
    ...before.flatMap((box, index) =>
      (['top', 'left', 'width', 'height'] as const).map((edge) =>
        Math.abs(drift(after[index][edge], box[edge])),
      ),
    ),
  );
}

/**
 * A reading taken once two consecutive ones agree, so the "before" of a
 * before/after pair cannot be a frame caught mid-layout (`CLAUDE.md` §4.6).
 */
async function settled<T>(read: () => Promise<T>, same: (a: T, b: T) => boolean): Promise<T> {
  let previous: T | undefined;
  let result: T | undefined;
  await expect
    .poll(async () => {
      const current = await read();
      const agrees = previous !== undefined && same(previous, current);
      previous = current;
      if (agrees) {
        result = current;
      }
      return agrees;
    })
    .toBe(true);
  return result!;
}

/**
 * How the options are laid out: how many distinct columns their left edges
 * form, and whether each one sits wholly below the one before it.
 */
async function layoutOf(page: Page): Promise<{ columns: number; stacked: boolean }> {
  const boxes = await optionBoxes(page);
  const columns = new Set(boxes.map((box) => Math.round(box.left))).size;
  const stacked = boxes.every(
    (box, index) => index === 0 || box.top >= boxes[index - 1].top + boxes[index - 1].height - 0.5,
  );
  return { columns, stacked };
}

/** The seeded question on screen, once it is one not yet answered. */
async function questionOnScreen(
  page: Page,
  seeds: (CustomQuestionSeed & { id: string })[],
  answered: Set<string>,
): Promise<CustomQuestionSeed & { id: string }> {
  let found: (CustomQuestionSeed & { id: string }) | undefined;
  await expect
    .poll(
      async () => {
        const text = ((await page.getByTestId('question-text').textContent()) ?? '').trim();
        found = seeds.find((seed) => seed.question === text && !answered.has(seed.id));
        return found !== undefined;
      },
      { message: 'a seeded question not yet answered is on screen' },
    )
    .toBe(true);
  answered.add(found!.id);
  return found!;
}

test.describe('two to six options on the quiz card (FEAT-051)', () => {
  // `sm` and up, where four options sit two to a row — so one column is a
  // decision the page made, not the phone layout every count shares.
  test.use({ viewport: { width: 1024, height: 900 } });

  test('a six-option question plays in one column, lettered A to F, and 50/50 leaves two', async ({
    page,
    firebase,
  }) => {
    const runId = unique();
    const topic = runTag('six-options');
    await firebase.seedCustomQuestions([
      {
        id: `six-options-${runId}`,
        tags: [topic],
        type: 'multiple',
        difficulty: 'easy',
        question: `Which planet is fourth from the Sun? (${runId})`,
        correct_answer: 'Mars',
        incorrect_answers: FIVE_WRONG,
      },
    ]);
    await stubOpenTrivia(page);
    await page.goto('/');
    await startTopicGame(page, { topics: [topic], found: 1, noTimeLimit: true });

    const options = page.getByTestId('answer-option');
    await expect(options).toHaveCount(6);
    // Letters from the index, so they run as far as the options do.
    await expect(page.locator('[data-cy="answer-option"] > span:first-child')).toHaveText([
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
    ]);
    await expect
      .poll(() => layoutOf(page), { message: 'six options stack in one column at 1024px' })
      .toEqual({ columns: 1, stacked: true });

    const fiftyFifty = page.getByTestId('lifeline-fiftyFifty');
    await expect(fiftyFifty).toBeEnabled();
    await expect(fiftyFifty).toHaveAttribute(
      'aria-label',
      'Fifty-fifty: remove every wrong answer but one. One use per game.',
    );

    const before = await settled(
      () => optionBoxes(page),
      (a, b) => largestShift(a, b) === 0,
    );
    await fiftyFifty.click();

    // Four of the five wrong answers go, whatever the count: the correct one
    // and exactly one other are left — a fifty-fifty, not a three-in-six.
    await expect(page.locator('[data-cy="answer-option"][data-eliminated]')).toHaveCount(4);
    const standing = page.locator('[data-cy="answer-option"]:not([data-eliminated])');
    await expect(standing).toHaveCount(2);
    await expect(standing.filter({ has: page.getByText('Mars', { exact: true }) })).toHaveCount(1);
    await expect(page.getByTestId('lifeline-status')).toHaveText(
      'Question 1: Fifty-fifty used. 2 options remain.',
    );
    // Every option keeps its cell: none left the grid, and none moved.
    await expect(options).toHaveCount(6);
    await expect
      .poll(async () => largestShift(before, await optionBoxes(page)), {
        message: 'spending 50/50 must not move or resize any option',
      })
      .toBe(0);

    await answerOption(page, 'Mars').click();
    await expect(page.getByTestId('result-status')).toContainText('Correct');
  });

  /**
   * The control for the test above, and the spec's edge case: up to four
   * options keep today's two columns — so "one column" is decided by the count
   * rather than applied to every question — and a two-option multiple-choice
   * question plays like a true-or-false one, 50/50 unavailable and saying why.
   */
  test('two and four options keep two columns, and 50/50 is unavailable on two', async ({
    page,
    firebase,
  }) => {
    const runId = unique();
    const topic = runTag('two-four');
    const seeds: (CustomQuestionSeed & { id: string })[] = [
      {
        id: `four-options-${runId}`,
        tags: [topic],
        type: 'multiple',
        difficulty: 'easy',
        question: `Which planet has the Great Red Spot? (${runId})`,
        correct_answer: 'Jupiter',
        incorrect_answers: ['Venus', 'Mercury', 'Saturn'],
      },
      {
        id: `two-options-${runId}`,
        tags: [topic],
        type: 'multiple',
        difficulty: 'easy',
        question: `Which of these two planets has rings you can see from Earth? (${runId})`,
        correct_answer: 'Saturn',
        incorrect_answers: ['Mars'],
      },
    ];
    await firebase.seedCustomQuestions(seeds);
    await stubOpenTrivia(page);
    await page.goto('/');
    await startTopicGame(page, { topics: [topic], found: 2, noTimeLimit: true });

    // One pass per question, in whatever order the bank served them — the
    // seeds name the questions, the screen says which came first.
    const answered = new Set<string>();
    for (const _round of seeds) {
      const question = await questionOnScreen(page, seeds, answered);
      const count = question.incorrect_answers.length + 1;
      await expect(page.getByTestId('answer-option')).toHaveCount(count);
      await expect
        .poll(() => layoutOf(page), { message: `${count} options sit two to a row at 1024px` })
        .toMatchObject({ columns: 2 });

      const fiftyFifty = page.getByTestId('lifeline-fiftyFifty');
      if (count === 2) {
        await expect(fiftyFifty).toBeDisabled();
        await expect(fiftyFifty).toHaveAttribute(
          'aria-label',
          'Fifty-fifty is unavailable on a question with two options.',
        );
      } else {
        await expect(fiftyFifty).toBeEnabled();
      }

      await answerOption(page, question.correct_answer).click();
      await expect(page.getByTestId('result-status')).toContainText('Correct');
    }
    await expect(page).toHaveURL(/\/game-over$/);
  });
});

/**
 * A 2,000-character statement grows the card and the page scrolls — there is
 * no scroll region inside the card (decided 8 October 2026) — and the card
 * keeps its size through the reveal, with `FEAT-027`'s vote row reserved from
 * the moment the question appears (`CLAUDE.md` §4.4).
 *
 * At two viewports, the spec's own: a phone tall enough that a short card
 * would be centred with slack to spend, and a desktop width where the grid
 * rule has a second column to give up. A long card overflows both and is
 * pinned to the top, so it is the **height** that carries the assertion — a
 * row arriving on the reveal would make the card taller, and that is what is
 * measured.
 */
for (const viewport of [
  { width: 390, height: 1000 },
  { width: 1024, height: 900 },
]) {
  test.describe(`a 2,000-character statement at ${viewport.width}x${viewport.height} (FEAT-051)`, () => {
    test.use({ viewport });

    test('grows the card rather than scrolling inside it, and the reveal moves nothing', async ({
      page,
      firebase,
    }) => {
      const runId = unique();
      const topic = runTag('long-statement');
      const statement = statementOf(runId);
      expect(statement).toHaveLength(2000);
      await firebase.seedCustomQuestions([
        {
          id: `long-statement-${runId}`,
          tags: [topic],
          type: 'multiple',
          difficulty: 'hard',
          question: statement,
          correct_answer: 'Mars',
          incorrect_answers: FIVE_WRONG,
        },
      ]);
      await stubOpenTrivia(page);
      await page.goto('/');
      await startTopicGame(page, { topics: [topic], found: 1, noTimeLimit: true });

      // All of it, with the six options under it.
      await expect(page.getByTestId('question-text')).toHaveText(statement);
      await expect(page.getByTestId('answer-option')).toHaveCount(6);
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const heading = document.querySelector<HTMLElement>('[data-cy="question-text"]')!;
              const card = document.querySelector<HTMLElement>('[data-cy="question-card"]')!;
              const firstOption = document.querySelector<HTMLElement>('[data-cy="answer-option"]')!;
              // Anything between the statement and the card — the statement
              // itself and what it renders included — that scrolls on its own.
              const scrollRegions: string[] = [];
              const inside = [heading, ...heading.querySelectorAll<HTMLElement>('*')];
              for (let element = heading.parentElement; element; element = element.parentElement) {
                inside.push(element);
                if (element === card) {
                  break;
                }
              }
              for (const element of inside) {
                const { overflowY } = getComputedStyle(element);
                if (overflowY === 'auto' || overflowY === 'scroll') {
                  scrollRegions.push(element.getAttribute('data-cy') ?? element.tagName);
                }
              }
              return {
                scrollRegions,
                statementClipped: heading.scrollHeight > heading.clientHeight + 1,
                cardClipped: card.scrollHeight > card.clientHeight + 1,
                cardTallerThanViewport: card.getBoundingClientRect().height > window.innerHeight,
                pageScrolls: document.documentElement.scrollHeight > window.innerHeight,
                optionsBelowStatement:
                  firstOption.getBoundingClientRect().top >= heading.getBoundingClientRect().bottom,
              };
            }),
          { message: 'the statement grows the card and the page, and scrolls inside nothing' },
        )
        .toEqual({
          scrollRegions: [],
          statementClipped: false,
          cardClipped: false,
          cardTallerThanViewport: true,
          pageScrolls: true,
          optionsBelowStatement: true,
        });

      // The vote row is in the card before the reveal, and invisible.
      const voteRow = page.getByTestId('quiz-vote');
      await expect(voteRow).toHaveCount(1);
      await expect(voteRow).toHaveClass(/\binvisible\b/);

      const before = await settled(
        () => cardBox(page),
        (a, b) => largestShift([a], [b]) === 0,
      );

      await answerOption(page, 'Mars').click();
      await expect(page.getByTestId('result-status')).toContainText('Correct');
      await expect(voteRow).not.toHaveClass(/\binvisible\b/);

      // Polled, not read once: the reveal is a render the runner does not
      // synchronise with. A change a reader would see is not forgiven — the
      // only value this can settle to is the box it started as.
      await expect
        .poll(async () => largestShift([before], [await cardBox(page)]), {
          message: 'the reveal must not resize or move the question card',
        })
        .toBe(0);
    });
  });
}
