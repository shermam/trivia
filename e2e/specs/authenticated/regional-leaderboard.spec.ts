import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { expectRadiosAreGrouped } from '../../support/a11y';
import { signInFromGameOver } from '../../support/auth';
import { answerQuestion, startGame } from '../../support/game';
import { settledHeight } from '../../support/layout';
import { CORRECT_ANSWERS, questionsFixture } from '../../support/open-trivia';

/**
 * `FEAT-028` end to end: a player names a country, saves a score, and the
 * score lands on that country's board **and** the global one — and on nobody
 * else's.
 *
 * **Asserted through the Admin SDK rather than off the screen**, for the
 * reason `sign-in-save-score.spec.ts` gives at length and one more that only
 * applies here: half of what this spec claims is a *negative* — the score is
 * not on Portugal's board — and a screen that only ever renders one board
 * cannot show that. `firebase.getRegionalLeaderboardEntry` reads the document
 * at each path, which is exactly the claim.
 *
 * **Emulator-only, and deliberately.** `authenticated/` specs are opt-in to
 * the preview slice (`playwright.preview.config.ts`) and this one is not
 * listed: its subject is a `firestore.rules` block a PR may be in the middle
 * of adding, and a preview channel runs whatever rules `main` last deployed,
 * because rules are per project and a channel is Hosting only
 * (`docs/ci-cd.md` §4.2a). It would fail against the real project on exactly
 * the PR that introduces it, which is how a real signal becomes a red nobody
 * reads.
 *
 * **The country is set by hand in every test here**, never left to the
 * preselection. `GeoService`'s chain has no `/api/geo` locally (functions
 * deploy only on merge) and falls through to the browser's time zone, which is
 * whatever the runner is set to — so a spec that relied on the preselected
 * value would be asserting about the machine. `test.use({ timezoneId })` below
 * covers the preselection itself, which is a separate claim.
 */
test.describe('a score reaches the country board its player named', () => {
  const password = 'correct horse battery staple';

  /**
   * Four of five right, so the run never reaches a third consecutive correct
   * answer and the score is the plain correct-answer count — the same reason
   * `sign-in-save-score.spec.ts` misses one, kept here so the numbers below
   * stay readable next to a multiplier that is somebody else's subject.
   */
  const MISSED = 2;
  const expected = { score: 4, totalQuestions: 5, percentage: 80 } as const;

  async function playMissingOne(page: Page): Promise<void> {
    for (const [index, correct] of CORRECT_ANSWERS.entries()) {
      await answerQuestion(
        page,
        index === MISSED ? questionsFixture.results[index].incorrect_answers[0] : correct,
      );
    }
    await expect(page).toHaveURL(/\/game-over$/);
  }

  test('publishes to the declared country and the global board, and nowhere else', async ({
    page,
    firebase,
  }) => {
    const tag = Math.random().toString(36).slice(2, 8);
    const email = `region-${Date.now()}-${tag}@example.com`;
    const player = `Region Player ${tag}`;
    const { uid } = await firebase.createVerifiedUser({ email, password });

    await startGame(page, 5);
    await playMissingOne(page);
    await signInFromGameOver(page, email, password);

    await page.getByTestId('save-score-region').selectOption('BR');
    await page.locator('input[name=playerName]').fill(player);
    await page.getByRole('button', { name: 'Save Score', exact: true }).click();

    // The confirmation appears once the writes resolve, so it is the gate on
    // reading the documents rather than a claim of its own.
    await expect(page.getByTestId('score-saved')).toBeVisible();

    await expect
      .poll(() => firebase.getRegionalLeaderboardEntry({ uid, region: 'BR' }))
      .toMatchObject({ ...expected, name: player, timeLimit: '15', region: 'BR' });
    await expect
      .poll(() => firebase.getLeaderboardEntry({ uid }))
      .toMatchObject({ ...expected, name: player, timeLimit: '15' });
    // The negative half. A regional write that ignored the declaration — or a
    // rules block that accepted any region for any document — would put this
    // player on a board they never chose.
    await expect.poll(() => firebase.getRegionalLeaderboardEntry({ uid, region: 'PT' })).toBeNull();
    // And the global entry carries no country: `firestore.rules` refuses a
    // `region` key there, so a payload shared wholesale between the two writes
    // would have been rejected outright.
    await expect
      .poll(async () => (await firebase.getLeaderboardEntry({ uid }))?.region ?? null)
      .toBeNull();
  });

  test('publishes only globally when the player prefers not to say', async ({ page, firebase }) => {
    const tag = Math.random().toString(36).slice(2, 8);
    const email = `region-none-${Date.now()}-${tag}@example.com`;
    const player = `No Region ${tag}`;
    const { uid } = await firebase.createVerifiedUser({ email, password });

    await startGame(page, 5);
    await playMissingOne(page);
    await signInFromGameOver(page, email, password);

    // Explicit rather than relying on the control's initial value: what the
    // preselection resolves to here depends on the runner, and "unset" is the
    // state under test.
    await page.getByTestId('save-score-region').selectOption('');
    await page.locator('input[name=playerName]').fill(player);
    await page.getByRole('button', { name: 'Save Score', exact: true }).click();

    await expect(page.getByTestId('score-saved')).toBeVisible();

    await expect.poll(() => firebase.getLeaderboardEntry({ uid })).toMatchObject({ name: player });
    await expect.poll(() => firebase.getRegionalLeaderboardEntry({ uid, region: 'BR' })).toBeNull();
  });

  /**
   * The board the player is looking at, as opposed to the board they wrote to.
   *
   * Scoped to the player's own row by a run-unique name: the emulator's boards
   * are shared with every other worker, so an unscoped text match would be
   * asserting about somebody else's round.
   */
  test('shows the country board behind the Regional toggle, and the world behind Global', async ({
    page,
    firebase,
  }) => {
    const tag = Math.random().toString(36).slice(2, 8);
    const email = `region-view-${Date.now()}-${tag}@example.com`;
    const player = `Viewer ${tag}`;
    await firebase.createVerifiedUser({ email, password });

    await startGame(page, 5);
    await playMissingOne(page);
    await signInFromGameOver(page, email, password);

    await page.getByTestId('save-score-region').selectOption('BR');
    await page.locator('input[name=playerName]').fill(player);
    await page.getByRole('button', { name: 'Save Score', exact: true }).click();
    await expect(page.getByTestId('score-saved')).toBeVisible();

    // The G4 sweep, on the screen that just grew a segmented picker. It is the
    // check the helper's own comment says it exists for — "the segmented
    // picker nobody has added yet" — so running it here is what makes that
    // true rather than aspirational.
    await expectRadiosAreGrouped(page);

    // Global first, which is the default and says so.
    await expect(page.getByTestId('board-scope-global')).toBeChecked();
    await expect(page.getByTestId('leaderboard-scope')).toHaveText('Worldwide');

    // The radios are `sr-only`, so the visible target is the label around
    // them — clicking the input itself is how a real reader never does it.
    await page.getByRole('radio', { name: 'Regional', exact: true }).check();

    await expect(page.getByTestId('board-scope-regional')).toBeChecked();
    await expect(page.getByTestId('leaderboard-scope')).toHaveText('In Brazil');
    await expect(
      page.getByTestId('leaderboard-body').getByRole('listitem').filter({ hasText: player }),
    ).toContainText('4 pts');
    // The heading is unchanged by the toggle: the country is a second line
    // rendered in both states, so the header cannot change height (§4.4).
    await expect(page.getByTestId('leaderboard-title')).toHaveText('Top 10 — 15-second games');
  });

  /**
   * `CLAUDE.md` §4.4: the board must not resize when the reader switches
   * boards, and the header must not resize when the country name lands in it.
   *
   * Measured in a real browser because nothing else can see it — jsdom has no
   * layout and Lighthouse only loads `/`. The viewport is tall enough to leave
   * the card's centring some slack, which is the condition under which the
   * result banner's 43px shift was visible at all.
   */
  test.describe('the board holds its size across the toggle', () => {
    test.use({ viewport: { width: 390, height: 1000 } });

    test('switching boards moves nothing', async ({ page, firebase }) => {
      const tag = Math.random().toString(36).slice(2, 8);
      const email = `region-size-${Date.now()}-${tag}@example.com`;
      await firebase.createVerifiedUser({ email, password });

      await startGame(page, 5);
      await playMissingOne(page);
      await signInFromGameOver(page, email, password);
      await page.getByTestId('save-score-region').selectOption('BR');

      const body = page.getByTestId('leaderboard-body');
      const header = page.getByTestId('leaderboard-title');
      await expect(page.getByTestId('leaderboard-scope')).toHaveText('Worldwide');

      // Settled, not read once: the arrival of a board is a render the runner
      // does not synchronise with (`CLAUDE.md` §4.6).
      const before = await settledHeight(body, 'the leaderboard body');
      const headerBefore = await settledHeight(header, 'the leaderboard heading');

      await page.getByRole('radio', { name: 'Regional', exact: true }).check();
      await expect(page.getByTestId('leaderboard-scope')).toHaveText('In Brazil');

      await expect.poll(async () => (await body.boundingBox())?.height).toBe(before);
      await expect.poll(async () => (await header.boundingBox())?.height).toBe(headerBefore);
    });
  });

  /**
   * The preselection, and the one machine-dependent thing that can be pinned:
   * with no `/api/geo` to answer, `GeoService` falls through to the browser's
   * IANA time zone, and its table maps Brazil's zones and nothing else.
   *
   * So a Brazilian time zone opens the picker on Brazil and every other zone
   * opens it unset — which is what the spec says the local path does, and the
   * reason a test here must set the zone rather than read whatever the runner
   * has.
   */
  test.describe('the picker opens on the app’s guess', () => {
    test.describe('in a Brazilian time zone', () => {
      test.use({ timezoneId: 'America/Sao_Paulo' });

      test('preselects Brazil', async ({ page, firebase }) => {
        const tag = Math.random().toString(36).slice(2, 8);
        const email = `region-tz-br-${Date.now()}-${tag}@example.com`;
        await firebase.createVerifiedUser({ email, password });

        await startGame(page, 5);
        await playMissingOne(page);
        await signInFromGameOver(page, email, password);

        await expect(page.getByTestId('save-score-region')).toHaveValue('BR');
      });
    });

    test.describe('anywhere the app does not price differently', () => {
      test.use({ timezoneId: 'America/New_York' });

      test('leaves the picker unset rather than guessing', async ({ page, firebase }) => {
        const tag = Math.random().toString(36).slice(2, 8);
        const email = `region-tz-us-${Date.now()}-${tag}@example.com`;
        await firebase.createVerifiedUser({ email, password });

        await startGame(page, 5);
        await playMissingOne(page);
        await signInFromGameOver(page, email, password);

        await expect(page.getByTestId('save-score-region')).toHaveValue('');
        // And the Regional tab offers a way in rather than a dead end or a
        // location prompt.
        await page.getByRole('radio', { name: 'Regional', exact: true }).check();
        await expect(page.getByTestId('leaderboard-message')).toContainText('Choose your country');
      });
    });
  });
});
