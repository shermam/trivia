import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { authMenu, openAuthMenu, signInViaUi } from '../../support/auth';
import { answerQuestion, startNewGame } from '../../support/game';
import { waitForGameplayStats } from '../../support/gameplay-stats';
import { expectSameHeight, settledHeight } from '../../support/layout';
import { CORRECT_ANSWERS, stubOpenTrivia } from '../../support/open-trivia';

const password = 'Str0ngPassw0rd!';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const uniqueEmail = () => `profile-stats-${unique()}@example.com`;

/**
 * The document `/profile` reads — `users/{uid}`, over the Firestore REST API.
 *
 * A RegExp rather than a glob: the emulator serves it at
 * `http://127.0.0.1:8080/v1/projects/…/documents/users/{uid}`, and a `**\/`
 * glob has to match across the `//` in the protocol, which is where minimatch
 * is fussy. Not anchored at the end, because the client appends its API key.
 */
const STATS_READ = /\/documents\/users\//;

/**
 * The viewport the layout guard measures at.
 *
 * Below `sm` the card is its own box in its own row, which is where a change
 * inside it is visible as a change to the card. The height is generous for the
 * reason `CLAUDE.md` §4.4 gives: a cramped viewport pins a layout and hides
 * the very shift the test is looking for.
 */
const MEASURING_VIEWPORT = { width: 390, height: 1000 };

/**
 * `/profile` — a player's lifetime totals, read back and shown only to them
 * (`FEAT-005`, reduced to the five fields `users/{uid}` already stores).
 *
 * The screen is read-only and the numbers come from a callable this suite
 * covers elsewhere (`lifetime-stats.spec.ts`), so what is worth driving here
 * is everything the unit specs cannot see: that the page a real browser loads
 * actually reaches Firestore under the rules as deployed, that its states are
 * reachable from the nav, and that the card does not change size when the read
 * lands — which jsdom has no layout to notice and Lighthouse never visits.
 *
 * **Outside the preview slice, deliberately.** One test here drives the real
 * `recordGameResult`, and Cloud Functions are not channel-scoped
 * (`docs/ci-cd.md` §4.2a) — the same reason `lifetime-stats.spec.ts` stays on
 * the emulator. `playwright.preview.config.ts` includes authenticated specs by
 * name, so this file reaches the real project only if somebody adds it.
 */
test.describe('profile — lifetime stats', () => {
  async function playFullGame(page: Page): Promise<void> {
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);
  }

  /**
   * The whole arc for a new account, in one test, because the interesting part
   * is the transition: the same screen has to say "nothing yet" before the
   * first game and show real numbers after it. Two tests could each pass while
   * the page was stuck in the state the other one expected.
   *
   * It goes through the auth menu's link rather than `page.goto('/profile')`
   * so the entry point is covered by the gesture that uses it.
   */
  test('says nothing is banked yet, then shows what a finished game banked', async ({
    page,
    firebase,
  }) => {
    const email = uniqueEmail();
    const { uid } = await firebase.createVerifiedUser({ email, password });

    await stubOpenTrivia(page);
    await page.goto('/');
    await signInViaUi(page, email, password);

    await openAuthMenu(page);
    await authMenu(page).getByTestId('auth-menu-stats-link').click();
    await expect(page).toHaveURL(/\/profile$/);

    // No document exists for an account that has never finished a game, and
    // that is a different thing from a read that failed — the screen has to
    // say so rather than show zeroes it did not read.
    await expect(page.getByTestId('stats-empty')).toBeVisible();
    await expect(page.getByTestId('stat-games-played')).toHaveText('—');

    await page.goto('/');
    await startNewGame(page, 5);
    await playFullGame(page);

    // `recordGameResult` is fire-and-forget, so nothing in the DOM changes
    // when it lands. Waiting on the document itself is what makes the visit
    // below a read of a banked game rather than a race with one.
    await waitForGameplayStats(firebase, uid);

    await page.goto('/profile');
    await expect(page.getByTestId('stats-since')).toBeVisible();
    await expect(page.getByTestId('stat-games-played')).toHaveText('1');
    await expect(page.getByTestId('stat-questions-answered')).toHaveText('5');
    await expect(page.getByTestId('stat-correct-answers')).toHaveText('5');
    await expect(page.getByTestId('stat-best-streak')).toHaveText('5');
    // A pattern rather than a string, because `Intl.NumberFormat` puts a
    // non-breaking space before the sign in some locales and none in others,
    // and which one the runner is in is not this test's subject.
    //
    // **The leading and trailing `\s*` are load-bearing, not defensive**, for
    // the reason `CLAUDE.md` §4.6 now records: a pattern is matched against
    // the element's raw text, template indentation included, where a string
    // expectation would have been normalized first.
    await expect(page.getByTestId('stat-accuracy')).toHaveText(/^\s*100\s*%\s*$/);
  });

  /**
   * The card is exactly as tall before the read answers as after
   * (`CLAUDE.md` §4.4).
   *
   * Every box that a number lands in is rendered from first paint holding an
   * em-dash, and the five sentences the card can show are stacked in one grid
   * cell so the space reserved is the tallest of them. The failure this stops
   * is the whole card growing under a reader at the moment they look at it.
   *
   * The totals are seeded rather than played, because the subject is the
   * layout and not the callable: a game would take fifteen seconds to produce
   * numbers this test does not read.
   */
  test('does not resize the card when the totals arrive', async ({ page, firebase }) => {
    const email = uniqueEmail();
    const { uid } = await firebase.createVerifiedUser({ email, password });
    await firebase.seedGameplayStats({
      uid,
      gamesPlayed: 12,
      questionsAnswered: 140,
      correctAnswers: 109,
      bestStreak: 17,
      statsSince: Date.UTC(2026, 0, 15),
    });

    await page.goto('/');
    await signInViaUi(page, email, password);

    // Resized after signing in, not before: the measurement needs `/profile`
    // at this width, and the auth menu has no business being driven at one it
    // is not otherwise tested at.
    await page.setViewportSize(MEASURING_VIEWPORT);
    const stats = await holdStatsRead(page);
    await page.goto('/profile');

    // Measured in the loading state, which lasts exactly as long as this test
    // needs it to.
    const card = page.getByTestId('stats-card');
    await expect(page.getByTestId('stats-loading')).toBeVisible();
    const whileLoading = await settledHeight(card, 'the stats card while the read is in flight');

    stats.release();
    await expect(page.getByTestId('stat-games-played')).toHaveText('12');

    // The intercept is load-bearing: one that silently stopped matching would
    // leave this measuring the loaded state twice and passing by luck
    // (`CLAUDE.md` §4.6).
    expect(stats.held.reads, 'stats reads held open by the intercept').toBeGreaterThan(0);
    await expectSameHeight(card, whileLoading, 'the stats card when the totals arrive');
  });

  /**
   * An anonymous visitor has no document and never will — the callable refuses
   * to create one, because nothing would ever delete it (`docs/data-model.md`)
   * — so the screen explains that rather than showing zeroes, and offers the
   * one action that changes it.
   */
  test('explains itself to an anonymous visitor, and offers the way out', async ({ page }) => {
    await page.goto('/profile');

    await expect(page.getByTestId('stats-signed-out')).toBeVisible();
    await expect(page.getByTestId('stat-games-played')).toHaveText('—');
    await expect(page.getByTestId('stat-accuracy')).toHaveText('—');

    // The states are stacked in one grid cell, so every message is in the
    // document at all times and only `visibility` separates them — an
    // existence check would pass against any of them (`CLAUDE.md` §4.6).
    await expect(page.getByTestId('stats-empty')).toBeHidden();
    await expect(page.getByTestId('stats-failed')).toBeHidden();

    await page.getByTestId('stats-sign-in').click();
    await expect(authMenu(page)).toBeVisible();
  });

  /**
   * The drawer is the only entry point below `sm`, where the top bar has no
   * room for links at all (`docs/app.md` §1.5).
   */
  test('is reachable from the mobile nav drawer', async ({ page }) => {
    await page.setViewportSize(MEASURING_VIEWPORT);
    await page.goto('/');

    await page.getByTestId('nav-menu-trigger').click();
    await page.getByTestId('nav-menu-stats-link').click();

    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByRole('heading', { name: 'Your stats', exact: true })).toBeVisible();
  });
});

/**
 * Holds the `users/{uid}` read open, so the loading state can be measured
 * rather than raced.
 *
 * The response is fetched immediately and only its *delivery* is held, so the
 * released page is one round trip from rendering numbers rather than starting
 * one.
 */
async function holdStatsRead(page: Page) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = { reads: 0 };

  await page.route(STATS_READ, async (route) => {
    const response = await route.fetch();
    held.reads += 1;
    await released;
    await route.fulfill({ response });
  });

  return { release: () => release(), held };
}
