import { Locator, Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { signInViaUi } from '../../support/auth';
import { optionLabel, waitForPlayRoute } from '../../support/game';
import { drift, settledHeight } from '../../support/layout';
import { stubExtraCategory, stubOpenTrivia } from '../../support/open-trivia';

/**
 * `FEAT-019`. A question can be written in Markdown with LaTeX math, and every
 * screen that shows question text renders it through one component.
 *
 * What only this layer can answer, given `markdown-engine.spec.ts` already
 * covers the allowlist payload by payload:
 *
 * - **A real browser lays it out.** The size guarantee in `CLAUDE.md` §4.4 is
 *   about a box, and jsdom has no boxes: a code block or a display formula that
 *   widened the question card would move the answer buttons under it, and
 *   nothing below a browser can see that.
 * - **MathML needs a real MathML implementation.** jsdom parses `<math>` and
 *   lays out nothing; only here does a formula have a width.
 * - **The chunks actually load.** The engines are two dynamic `import()`s, so a
 *   misnamed chunk or a service-worker group that swallowed one would leave the
 *   source text on screen — a failure the unit suite cannot reach, because it
 *   imports the modules statically.
 * - **The form writes the field through the real rules.** The rules suite
 *   proves `isValidQuestionShape()` admits `format`; only this proves the
 *   payload the *form* builds is the one it was widened for.
 *
 * Under `authenticated/` deliberately, and the reason is the last test rather
 * than auth: it submits through the UI, which mints a Firestore auto-id no
 * sweep list can reach. `playwright.preview.config.ts` takes everything under
 * `unauthenticated/` automatically and only two named specs from here, so the
 * directory is what keeps this file off the real `trivimind-dev` project
 * (`docs/ci-cd.md` §4.3).
 */
test.describe('markdown and math rendering', () => {
  const password = 'correct horse battery staple';

  /**
   * Everything this file writes is keyed on a tag unique to the test, and that
   * is the whole of its isolation. Workers share one emulator with no reset, so
   * `custom_questions` holds every other test's rows: a category, an email
   * address and a queue row matched by its question text are all global unless
   * the test makes them its own.
   */
  let tag: string;

  test.beforeEach(async ({ page }) => {
    tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await stubOpenTrivia(page);
  });

  /**
   * The viewport is part of the test. §4.4's own note says a card that is
   * vertically centred stops moving below a certain height, because it is
   * already pinned to the top — so a check at a convenient window size calls a
   * layout bug fixed while it is broken. 1000px tall leaves centring slack to
   * spend, and 1024 wide is where a code block has room to overflow rather than
   * simply wrapping.
   */
  test('plays a markdown question with code and a formula, and never widens the card', async ({
    page,
    firebase,
  }) => {
    await page.setViewportSize({ width: 1024, height: 1000 });

    const category = `Markdown ${tag}`;
    const questionText = `Which expression is quadratic? (${tag})`;

    await stubExtraCategory(page, category);
    await firebase.seedCustomQuestions([
      {
        id: `markdown-${tag}`,
        category,
        type: 'multiple',
        difficulty: 'easy',
        // Both overflowing shapes, and both deliberately **wider than the
        // card**, which is `max-w-xl` — 576px whatever the viewport is. A
        // formula that happens to fit proves nothing about the scroll
        // container: measured, the first version of this seed rendered 437px
        // wide and the assertion below passed for the wrong reason.
        question:
          `**${questionText}**\n\n` +
          '$$\\sum_{i=1}^{n} \\frac{x_i^2 + y_i^2 + z_i^2}{a_i + b_i + c_i} + \\int_0^\\infty e^{-x^2}\\,dx + \\alpha\\beta\\gamma\\delta\\epsilon\\zeta\\eta\\theta\\iota\\kappa\\lambda\\mu\\nu\\xi\\pi\\rho\\sigma\\tau\\upsilon\\phi\\chi\\psi\\omega + \\sqrt{a^2+b^2+c^2+d^2+e^2} + \\frac{\\partial f}{\\partial x} + \\log_2(n)$$\n\n' +
          '```ts\nexport function quadratic(a: number, b: number, c: number): number { return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a); }\n```',
        correct_answer: '`ax^2 + bx + c`',
        incorrect_answers: ['`mx + b`', '`log(x)`', '`e^x`'],
        createdBy: 'someone-else',
        createdAt: Date.now(),
        format: 'markdown',
      },
    ]);

    await startCustomGame(page, category);

    // The rendered branch, not the source-text fallback the component shows
    // while its engine is in flight. Waiting on the marker rather than on the
    // markup is what puts every measurement below *after* the swap rather than
    // across it.
    const prompt = page.getByTestId('question-text').getByTestId('rendered-text');
    await expect(prompt).toHaveAttribute('data-rendered', 'markdown');

    // Markdown became markup, not asterisks.
    await expect(prompt.locator('strong')).toHaveText(questionText);
    await expect(prompt.locator('pre code.language-ts')).toContainText('Math.sqrt');

    // MathML, from KaTeX's `output: 'mathml'` — and no inline style, which is
    // the CSP failure that configuration exists to avoid. A refused `style`
    // attribute stays in the DOM with its declarations silently dropped
    // (`CLAUDE.md` §4.4), so "there is no style attribute at all" is the only
    // assertion that can see it.
    const formula = prompt.locator('math[display="block"]');
    await expect(formula).toBeVisible();
    await expect(formula).not.toHaveAttribute('style', /.*/);

    const card = page.getByTestId('question-card');
    const height = await settledHeight(card, 'the question card');
    const width = await settledWidth(card, 'the question card');

    // Neither overflowing element may set the card's width: the answer buttons
    // are underneath it, and the whole point of the scroll containers is that a
    // long line inside them moves nothing outside them (§4.4). Read after the
    // width has settled, so this is a measurement of a state rather than a race
    // (§4.6).
    expect(await scrollsInsideItself(card, 'pre'), 'the code block scrolls itself').toBe(true);
    expect(
      await scrollsInsideItself(card, 'math[display="block"]'),
      'the display formula scrolls itself',
    ).toBe(true);

    // Answers render too — an answer to a coding question is code.
    const options = page.getByTestId('answer-option');
    await expect(options).toHaveCount(4);
    await expect(options.first().locator('code')).toBeVisible();

    // The reveal is the state change §4.4 is about: the result banner and the
    // answer colours arrive, and the card must neither grow nor move. One poll
    // over all three numbers rather than three: the question auto-advances two
    // seconds after an answer, so the assertions after the click have to be one
    // round trip rather than several.
    await options.first().click();
    await expect(page.getByTestId('result-status')).not.toBeEmpty();
    await expect
      .poll(
        async () => {
          const box = (await card.boundingBox())!;
          return {
            height: drift(box.height, height),
            width: drift(box.width, width),
          };
        },
        { message: 'the answer reveal must not resize the question card' },
      )
      .toEqual({ height: 0, width: 0 });
  });

  test('leaves a plain question exactly as it was written', async ({ page, firebase }) => {
    const category = `Plain ${tag}`;
    const questionText = `Is **this** literally asterisks and $x^2$? (${tag})`;

    await stubExtraCategory(page, category);
    await firebase.seedCustomQuestions([
      {
        id: `plain-${tag}`,
        category,
        type: 'boolean',
        difficulty: 'easy',
        question: questionText,
        correct_answer: 'True',
        incorrect_answers: ['False'],
        createdBy: 'someone-else',
        createdAt: Date.now(),
      },
    ]);

    await startCustomGame(page, category);

    // No `format` field at all, which is every question in the bank today: the
    // text is shown as typed, and neither engine is ever fetched.
    const prompt = page.getByTestId('question-text').getByTestId('rendered-text');
    await expect(prompt).toHaveAttribute('data-rendered', 'plain');
    await expect(prompt).toHaveText(questionText);
    await expect(prompt.locator('strong')).toHaveCount(0);
    await expect(prompt.locator('math')).toHaveCount(0);
  });

  /**
   * The payload suite lives in `markdown-engine.spec.ts`, and this is the one
   * question it cannot answer: **what a browser does with the string.**
   *
   * jsdom parses markup and runs nothing — no `onerror`, no `<script>`, no
   * navigation. So a `not.toContain('onerror')` there is an assertion about a
   * DOM tree, while the thing anybody actually cares about is whether a
   * contributed question can execute in a player's tab. That needs a real
   * engine and a sentinel every payload tries to set.
   *
   * **Not a CSP test**, and worth saying so: the dev server this runs against
   * serves no `Content-Security-Policy` at all, so nothing here is standing on
   * one. That is the point — the sanitiser has to hold with the CSP removed,
   * because the CSP is the second line and `firebase.json` is the only place
   * the first one could be tested against.
   */
  test('cannot execute anything, on a question that is nothing but payloads', async ({
    page,
    firebase,
  }) => {
    // Every payload below writes here. It stays `false` if the pipeline holds
    // — and unlike a dialog handler, it also catches the payloads that would
    // run without opening one.
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>)['__xssFired'] = false;
    });

    const category = `Injection ${tag}`;
    const marker = `payload-${tag}`;
    const fire = 'window.__xssFired = true';

    await stubExtraCategory(page, category);
    await firebase.seedCustomQuestions([
      {
        id: `injection-${tag}`,
        category,
        type: 'multiple',
        difficulty: 'easy',
        question:
          `${marker}\n\n` +
          `<script>${fire}</script>\n` +
          `<img src=x onerror="${fire}">\n` +
          `<svg onload="${fire}"></svg>\n` +
          `<iframe src="data:text/html,<script>${fire}</script>"></iframe>\n` +
          `<form action="https://evil.example"><input name="p"><button>go</button></form>\n` +
          `<p style="position:fixed;inset:0;z-index:99">covering everything</p>\n` +
          `<math><mi href="//evil.example">m</mi><annotation-xml encoding="text/html"><img src=x onerror="${fire}"></annotation-xml></math>\n` +
          `<a href="javascript:${fire}">raw anchor</a>\n` +
          `[markdown link](javascript:${fire})\n\n` +
          `$\\href{javascript:${fire}}{x}$ and $\\htmlStyle{position:fixed}{y}$`,
        correct_answer: `ok <img src=x onerror="${fire}">`,
        incorrect_answers: [
          `no <script>${fire}</script>`,
          `nope [x](javascript:${fire})`,
          `nah <b onmouseover="${fire}">b</b>`,
        ],
        createdBy: 'someone-else',
        createdAt: Date.now(),
        format: 'markdown',
      },
    ]);

    await startCustomGame(page, category);

    const card = page.getByTestId('question-card');
    await expect(page.getByTestId('question-text').getByTestId('rendered-text')).toHaveAttribute(
      'data-rendered',
      'markdown',
    );
    // The prose around the payloads survived, so this is a rendered question
    // rather than an empty box that would pass every assertion below.
    await expect(card).toContainText(marker);

    // One poll over the whole census rather than an assertion per property:
    // these are several reads of one DOM state, and reading them separately is
    // how a group of measurements becomes a race (`CLAUDE.md` §4.6).
    await expect
      .poll(async () => census(card), { message: 'nothing executable survived sanitisation' })
      .toEqual({
        executed: false,
        forbiddenTags: [],
        eventHandlers: [],
        styleAttributes: 0,
        activeSchemes: [],
        hrefOutsideAnchor: [],
      });
  });

  /**
   * The engine is a dynamic `import()`, so "the chunk did not arrive" is a
   * state a real reader reaches — a deploy mid-session, a dropped connection —
   * and the component's answer to it is the source text rather than a blank.
   *
   * Only here, because the unit suite imports both engines statically: mocking
   * the import would test the mock. `page.route` reaches this fetch because the
   * emulator run installs no service worker; with one in front of it the
   * request would be re-issued from the worker's own context and never
   * intercepted at all (`CLAUDE.md` §4.6).
   */
  test('shows the source text, still playable, when the markdown chunk never arrives', async ({
    page,
    firebase,
  }) => {
    await page.route(
      (url) => url.pathname.includes('markdown-engine'),
      (route) => route.abort(),
    );

    const category = `Chunkless ${tag}`;
    const source = `**Bold** and $x^2$ (${tag})`;

    await stubExtraCategory(page, category);
    await firebase.seedCustomQuestions([
      {
        id: `chunkless-${tag}`,
        category,
        type: 'boolean',
        difficulty: 'easy',
        question: source,
        correct_answer: 'True',
        incorrect_answers: ['False'],
        createdBy: 'someone-else',
        createdAt: Date.now(),
        format: 'markdown',
      },
    ]);

    await startCustomGame(page, category);

    const prompt = page.getByTestId('question-text').getByTestId('rendered-text');
    // `loading` rather than `plain`: the document did ask for Markdown, and the
    // two markers exist so a test can tell "this is final" from "this is what
    // is left when the engine never came" (`rendered-text.component.ts`).
    await expect(prompt).toHaveAttribute('data-rendered', 'loading');
    await expect(prompt).toHaveText(source);
    await expect(prompt.locator('strong')).toHaveCount(0);

    // And the round still plays, which is the whole reason the fallback is text
    // rather than an error.
    await page.getByTestId('answer-option').first().click();
    await expect(page.getByTestId('result-status')).not.toBeEmpty();
  });

  test('writes the format field through the real rules, and shows the reviewer the rendered question', async ({
    page,
    firebase,
  }) => {
    const email = `markdown-reviewer-${tag}@example.com`;
    const questionText = `Which snippet compiles? (${tag})`;

    const { uid } = await firebase.createVerifiedUser({ email, password });
    await firebase.seedReviewer({ uid, reviewer: true });
    await firebase.setProSubscription({ uid });
    await page.goto('/');
    await signInViaUi(page, email, password);

    await page.goto('/add-question');
    await page.locator('#category').fill('Programming');
    await page.locator('#question').fill(`**${questionText}** with $x^2$`);
    await page.locator('#correctAnswer').fill('`let a = 1;`');
    await page.getByPlaceholder('Incorrect answer 1', { exact: true }).fill('`let 1 = a;`');
    await page.getByPlaceholder('Incorrect answer 2', { exact: true }).fill('`let a = 2;`');
    await page.getByPlaceholder('Incorrect answer 3', { exact: true }).fill('`let a = 3;`');

    // The toggle defaults to plain, so nothing below happens by accident — and
    // the preview does not exist until somebody asks for Markdown.
    const preview = page.getByTestId('markdown-preview');
    await expect(preview).toHaveCount(0);
    await optionLabel(
      page,
      page.getByRole('radio', { name: 'Markdown & math', exact: true }),
    ).click();

    // The live preview goes through the very component the quiz loop uses, so a
    // contributor is not writing syntax blind.
    const previewBody = preview.getByTestId('rendered-text');
    await expect(previewBody).toHaveAttribute('data-rendered', 'markdown');
    await expect(previewBody.locator('strong')).toHaveText(questionText);
    await expect(previewBody.locator('math')).toBeVisible();

    await page.getByRole('button', { name: 'Add Question', exact: true }).click();

    // The assertion that matters first: the widened `hasOnly()` allowlist
    // accepted the payload the form built. A rule that had not been widened
    // lands here as the form's generic failure message instead.
    await expect(
      page.getByText('Thanks! Your question has been submitted for review.'),
    ).toBeVisible();

    // And the other end of the same document, rendered from what Firestore
    // actually stored rather than from anything this test held onto.
    await page.goto('/review');
    const card = page.getByTestId('review-question').filter({ hasText: tag });
    await expect(card).toHaveCount(1);
    const rendered = card.getByTestId('rendered-text').first();
    await expect(rendered).toHaveAttribute('data-rendered', 'markdown');
    await expect(rendered.locator('strong')).toHaveText(questionText);
    await expect(rendered.locator('math')).toBeVisible();
  });
});

/**
 * Starts a **Custom** game in this test's own category.
 *
 * Not `startGame`, which uses the Open Trivia source and never reads
 * `custom_questions` at all — no Open Trivia question can carry a `format`, so
 * the assertions after that would hold whatever this feature did. The category
 * is what makes the draw deterministic: `getCustomQuestions` filters on it
 * server-side, so a category only this test has written to holds only this
 * test's question however busy the shared bank is.
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
 * The width of a box, once two consecutive readings agree on it — the
 * horizontal twin of `settledHeight` in `e2e/support/layout.ts`.
 *
 * Local to this spec because it is the only one that needs it: every §4.4
 * regression the suite has caught so far has been vertical, and this feature is
 * the first that can push a card out sideways. It moves into the shared module
 * the day a second spec wants it.
 */
async function settledWidth(box: Locator, what: string): Promise<number> {
  let previous = Number.NaN;
  let settled = Number.NaN;

  await expect
    .poll(
      async () => {
        const width = (await box.boundingBox())?.width ?? Number.NaN;
        const agrees = width > 0 && drift(width, previous) === 0;
        previous = width;
        if (agrees) {
          settled = width;
        }
        return agrees;
      },
      { message: `${what} settling to a stable width` },
    )
    .toBe(true);

  return settled;
}

interface Census {
  executed: boolean;
  forbiddenTags: string[];
  eventHandlers: string[];
  styleAttributes: number;
  activeSchemes: string[];
  hrefOutsideAnchor: string[];
}

/**
 * Everything dangerous a payload could have left behind, read from the live
 * DOM of one card in a single pass.
 *
 * **One object rather than six assertions**, because they are six reads of the
 * same state and `expect.poll` can only retry them together — separately, each
 * would sample a different instant and the group would be a race
 * (`CLAUDE.md` §4.6). It also names *what* got through when it fails, which a
 * chain of `toHaveCount(0)` does not.
 *
 * `hrefOutsideAnchor` is the entry worth explaining. DOMPurify's `ALLOWED_ATTR`
 * is a per-document list, so `href` added for `<a>` is legal on every other
 * allowed tag — and MathML has an `href` of its own that Firefox turns into a
 * link. An assertion that merely counts `href`s cannot see that; the element it
 * sits on is the whole question.
 */
async function census(card: Locator): Promise<Census> {
  return card.evaluate((root): Census => {
    const forbidden = new Set([
      'script',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'img',
      'svg',
      'style',
      'link',
      'annotation-xml',
      'base',
      'meta',
    ]);
    const census: Census = {
      executed: (window as unknown as Record<string, unknown>)['__xssFired'] === true,
      forbiddenTags: [],
      eventHandlers: [],
      styleAttributes: 0,
      activeSchemes: [],
      hrefOutsideAnchor: [],
    };

    for (const rendered of root.querySelectorAll('[data-cy="rendered-text"]')) {
      for (const element of [rendered, ...rendered.querySelectorAll('*')]) {
        const tag = element.tagName.toLowerCase();
        if (forbidden.has(tag)) {
          census.forbiddenTags.push(tag);
        }
        for (const attribute of element.attributes) {
          const name = attribute.name.toLowerCase();
          // `getAttribute` rather than the property, because a CSP-refused
          // `style` stays in the DOM with its declarations dropped — the
          // attribute is the evidence, the computed style is not
          // (`CLAUDE.md` §4.4).
          if (name.startsWith('on')) {
            census.eventHandlers.push(`${tag}[${name}]`);
          }
          if (name === 'style') {
            census.styleAttributes += 1;
          }
          if (/^\s*(?:javascript|data|vbscript)\s*:/i.test(attribute.value)) {
            census.activeSchemes.push(`${tag}[${name}]`);
          }
          if ((name === 'href' || name === 'xlink:href') && tag !== 'a') {
            census.hrefOutsideAnchor.push(`${tag}[${name}]=${attribute.value}`);
          }
        }
      }
    }
    return census;
  });
}

/**
 * Whether an element that overflows does so **inside itself** rather than by
 * stretching the box it is in.
 *
 * One `evaluate` rather than a matcher, because the question is a relationship
 * between two boxes and a scroll extent and no matcher expresses it. It is read
 * only after `settledWidth` has established that the layout has stopped moving,
 * which is what keeps a one-shot read from being a race (`CLAUDE.md` §4.6).
 */
async function scrollsInsideItself(card: Locator, selector: string): Promise<boolean> {
  return card.evaluate((cardElement, inner) => {
    const element = cardElement.querySelector(inner);
    if (!element) {
      return false;
    }
    // It holds more than fits, and it fits inside the card anyway.
    return (
      element.scrollWidth > element.clientWidth &&
      element.getBoundingClientRect().width <= cardElement.getBoundingClientRect().width
    );
  }, selector);
}
