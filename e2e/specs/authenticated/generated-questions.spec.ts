import { Locator, Page } from '@playwright/test';
import { FirebaseBackend } from '../../fixtures/firebase-backend';
import { expect, test } from '../../fixtures/test';
import { signInViaUi } from '../../support/auth';
import { installAuthUidTracker } from '../../support/auth-uid-tracker';
import { answerQuestion } from '../../support/game';
import { expectSameHeight, expectUnclipped, settledHeight } from '../../support/layout';
import { stubOpenTrivia } from '../../support/open-trivia';
import { runTag, startTopicGame } from '../../support/topics';

/**
 * A question the generation pipeline promoted (`FEAT-020`), from the review
 * queue to the end of a game that served it.
 *
 * The pipeline writes on the Admin SDK, which is what the `firebase` fixture
 * is, so the seed below *is* a promotion as far as the app can tell:
 * `createdBy: '[generated]'`, a `provenance` map, tags and no `category`,
 * `pending`. The rules suite proves a reviewer may decide that shape and no
 * client can write it; the unit specs prove each reader words it. What only a
 * browser against the real rules shows is the seam between them — that the
 * card a reviewer approves from reads as the pipeline's, that the approval is
 * accepted for a document no client could have written, and that the round
 * which then serves it tells the player a machine wrote it, after a reload as
 * well as before.
 *
 * **The card's author and run lines are measured**, because what they promise
 * cannot be seen any other way. The author is "Question pipeline" and the run
 * has a line of its own, cut to 32 characters, and at 320 and 390px both must
 * be readable whole: content no wider than its box (`expectUnclipped`), since
 * `toHaveText` reads the DOM, which holds the whole string whether or not the
 * box shows it — the first version of this card clipped the run to "…· run 20"
 * at 390 and passed every text assertion here. Both lines also hold the one
 * line a uid's does. jsdom has no layout, so a browser at a phone's width is
 * the only place either would show. So is the reason box's label on a rejected
 * generated question, which says the note stays on the record — the words a
 * decision made from a report swaps in place, so they have to hold the line
 * the other label held.
 *
 * Isolated by a per-test topic and tag, like every spec that seeds the bank.
 * One more thing it shares with `review-queue.spec.ts`: the Pending and
 * Rejected tabs are pages of fifty in document-id order, so this relies on the
 * suite holding fewer than fifty questions in either status whose ids sort
 * before these.
 *
 * Under `authenticated/`, which keeps it off the real `trivimind-dev` project:
 * it writes a reviewer's role and three questions that are not worth carrying
 * into the preview sweep (`docs/ci-cd.md` §4.3).
 */
test.describe('a machine-generated question', () => {
  const password = 'Password123!';

  let tag: string;
  let topic: string;
  let runId: string;
  let shownRun: string;
  let generatedText: string;
  let rejectedText: string;
  let contributedText: string;
  let personUid: string;

  test.beforeEach(async ({ page, firebase }) => {
    tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    topic = runTag('generated');
    // The pipeline's shape — a timestamp, then the topic's slug — and longer
    // than the 32 characters the card shows, so the run line it measures is the
    // cut one: the widest a run line can be.
    runId = `20261009T120000Z-the-good-place-e2e-${Math.random().toString(36).slice(2, 10)}`;
    shownRun = `${runId.slice(0, 31)}…`;
    generatedText = `Which element has the chemical symbol O? (${tag})`;
    rejectedText = `Which element has the chemical symbol Og? (${tag})`;
    contributedText = `Which element has the chemical symbol N? (${tag})`;
    // Shaped like a real Firebase uid — 28 letters and digits, no hyphen — so
    // the uid line the generated lines are measured against is one a real card
    // shows. A hyphenated stand-in wraps at 320px, where a real uid cannot.
    personUid = `e2eAuthor${tag.replace(/[^A-Za-z0-9]/g, '')}xxxxxxxxxxxxxxxxxxxx`.slice(0, 28);

    await stubOpenTrivia(page);
    await seedQuestions(firebase);
  });

  test('a reviewer approves it as the pipeline’s, and the player it is served to is told a machine wrote it', async ({
    page,
    browser,
    baseURL,
    firebase,
  }) => {
    const email = `reviewer-${tag}@example.com`;
    const { uid } = await firebase.createVerifiedUser({ email, password, displayName: 'Rev' });
    await firebase.seedReviewer({ uid, reviewer: true });
    await page.goto('/');
    await signInViaUi(page, email, password);
    await page.goto('/review');

    const generated = card(page, generatedText);
    const contributed = card(page, contributedText);
    await expect(generated).toHaveCount(1);
    await expect(contributed).toHaveCount(1);

    // The pipeline as the author and the run on a line of its own, cut to 32
    // characters, read from the stored provenance — and a uid on the card a
    // person wrote, which has no run line at all.
    await expect(generated.getByTestId('question-author')).toHaveText('Question pipeline');
    await expect(generated.getByTestId('question-run')).toHaveText(shownRun);
    await expect(contributed.getByTestId('question-author')).toHaveText(personUid);
    await expect(contributed.getByTestId('question-run')).toHaveCount(0);

    // No way into "everything this account contributed": every run's every
    // question shares the sentinel. Anchored on the card that does offer it,
    // so the absence is about the author and not about a view that never
    // rendered the button at all.
    await expect(contributed.getByTestId('open-author-view')).toHaveCount(1);
    await expect(generated.getByTestId('open-author-view')).toHaveCount(0);

    // The line a player will read, shown to the reviewer first — and not on a
    // question a person cited.
    await expect(generated.getByTestId('question-source-generated')).toHaveText(
      'Machine-generated from',
    );
    await expect(generated.getByTestId('question-source')).toContainText(
      'Machine-generated from Oxygen',
    );
    await expect(contributed.getByTestId('question-source')).toContainText('Example Encyclopedia');
    await expect(contributed.getByTestId('question-source-generated')).toHaveCount(0);

    // Readable whole at the narrowest phones (`CLAUDE.md` §4.4): neither line
    // cut off at 320 or 390. The author line is also the height of the uid's
    // line beside it at every width. The run line is one line from 390 up; at
    // 320 — a 305px page once this runner's scrollbar takes its share — its 32
    // characters wrap, by `break-all`, rather than lose the end of the id.
    for (const viewport of [
      { width: 320, height: 640 },
      { width: 390, height: 844 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      if (viewport.width < 1000) {
        await expectUnclipped(
          generated.getByTestId('question-author'),
          `the generated author line at ${viewport.width}px`,
        );
        await expectUnclipped(
          generated.getByTestId('question-run'),
          `the run line at ${viewport.width}px`,
        );
      }
      const uidLine = await settledHeight(
        contributed.getByTestId('question-author'),
        `the uid author line at ${viewport.width}px`,
      );
      await expectSameHeight(
        generated.getByTestId('question-author'),
        uidLine,
        `the generated author line at ${viewport.width}px`,
      );
      if (viewport.width >= 390) {
        await expectSameHeight(
          generated.getByTestId('question-run'),
          uidLine,
          `the run line at ${viewport.width}px`,
        );
      }
    }

    // Approved under the real rules: a document carrying a key no client
    // could write, decided by the reviewer's rule, which asks only what the
    // write changes.
    await generated.getByTestId('approve-question').click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Question marked approved.' }),
    ).toHaveCount(1);
    await expect(generated).toHaveCount(0);
    await expect(contributed).toHaveCount(1);

    // A generated question already rejected: its note stays on the record,
    // because there is no author to show it to — and the label saying so holds
    // the one line any label does, at a phone's width.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-cy="review-tab"][data-status="rejected"]').click();
    const rejected = card(page, rejectedText);
    await expect(rejected).toHaveCount(1);
    await expect(rejected.getByTestId('question-author')).toHaveText('Question pipeline');
    await expect(rejected.getByTestId('question-run')).toHaveText(shownRun);
    await expect(rejected.getByTestId('rejection-reason')).toHaveValue(
      'The source does not name this element.',
    );
    const reasonLabel = rejected.locator(`label[for="rejection-reason-rejected-${tag}"]`);
    await expect(reasonLabel).toHaveText('Reason kept on the record (optional)');
    await expectSameHeight(
      reasonLabel,
      await settledHeight(rejected.getByTestId('question-author'), 'a one-line row at 390px'),
      'the rejected generated question’s reason label at 390px',
    );
    await expect(rejected.getByTestId('open-author-view')).toHaveCount(0);

    // A player — a fresh anonymous visitor, in a context of its own — plays
    // the topic. The question a person wrote is still pending and the other
    // generated one rejected, so the round is the approved one alone, which is
    // the proof the approval landed: the draw serves nothing else.
    const context = await browser.newContext({ baseURL });
    const tracker = await installAuthUidTracker(context);
    try {
      const player = await context.newPage();
      await stubOpenTrivia(player);
      await player.goto('/');
      await startTopicGame(player, { topics: [topic], found: 1 });
      await expect(player.getByText(generatedText)).toBeVisible();
      await answerQuestion(player, 'Oxygen');
      await expect(player).toHaveURL(/\/game-over$/);

      await expectLabelledInRecap(player);

      // The flag rides the saved game, so the screen a reload restores says
      // the same thing rather than quietly dropping the label.
      await player.reload();
      await expect(player).toHaveURL(/\/game-over$/);
      await expectLabelledInRecap(player);
    } finally {
      firebase.trackAuthUids(tracker.take());
      await context.close();
    }
  });

  /** This test's card for a question, in whichever tab is showing. */
  function card(page: Page, text: string): Locator {
    return page.getByTestId('review-question').filter({ hasText: text });
  }

  /**
   * The recap row for the generated question, opened, with its source line
   * reading as machine-generated — the words outside the link, so the anchor
   * is still named by the page it opens.
   */
  async function expectLabelledInRecap(player: Page): Promise<void> {
    await player.getByTestId('recap-toggle').click();
    const row = player.getByTestId('recap-row').filter({ hasText: generatedText });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('question-source-generated')).toHaveText('Machine-generated from');
    await expect(row.getByTestId('question-source')).toContainText('Machine-generated from Oxygen');
    const link = row.getByTestId('question-source-link');
    await expect(link).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Oxygen');
    await expect(link).toContainText('Oxygen');
    await expect(link).not.toContainText('Machine-generated');
  }

  /**
   * Three questions under this test's topic: two the pipeline promoted, shaped
   * as `promote.ts` writes them — one pending, one a reviewer has already
   * rejected — and one a person contributed, pending, with a source of its own:
   * the card the generated ones are compared against.
   *
   * The provenance names no real provider or model: nothing in the app reads
   * either, and the run id is the one value a reader shows.
   */
  function seedQuestions(firebase: FirebaseBackend): Promise<void> {
    const now = Date.now();
    const provenance = {
      source: 'ai' as const,
      provider: 'example-provider',
      model: 'example-model',
      modelVersion: 'example-model-2026-10-01',
      generatedAt: now - 60_000,
      runId,
    };
    return firebase.seedCustomQuestions([
      {
        id: `generated-${tag}`,
        tags: [topic, 'chemistry'],
        type: 'multiple',
        difficulty: 'easy',
        question: generatedText,
        correct_answer: 'Oxygen',
        incorrect_answers: ['Osmium', 'Oganesson', 'Gold'],
        explanation: 'O is oxygen; osmium is Os, oganesson is Og and gold is Au.',
        format: 'plain',
        sourceUrl: 'https://en.wikipedia.org/wiki/Oxygen',
        sourceTitle: 'Oxygen',
        createdBy: '[generated]',
        createdAt: now,
        status: 'pending',
        provenance,
      },
      {
        id: `rejected-${tag}`,
        tags: [topic, 'chemistry'],
        type: 'multiple',
        difficulty: 'hard',
        question: rejectedText,
        correct_answer: 'Oganesson',
        incorrect_answers: ['Osmium', 'Oxygen', 'Gold'],
        explanation: 'Og is oganesson, element 118.',
        format: 'plain',
        sourceUrl: 'https://en.wikipedia.org/wiki/Oganesson',
        sourceTitle: 'Oganesson',
        createdBy: '[generated]',
        createdAt: now,
        status: 'rejected',
        rejectionReason: 'The source does not name this element.',
        provenance,
      },
      {
        id: `contributed-${tag}`,
        tags: [topic],
        type: 'multiple',
        difficulty: 'easy',
        question: contributedText,
        correct_answer: 'Nitrogen',
        incorrect_answers: ['Neon', 'Nickel', 'Sodium'],
        sourceUrl: 'https://example.org/nitrogen',
        sourceTitle: 'Example Encyclopedia',
        createdBy: personUid,
        createdAt: now,
        status: 'pending',
      },
    ]);
  }
});
