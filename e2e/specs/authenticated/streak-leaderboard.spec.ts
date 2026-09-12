import { expect, test } from '../../fixtures/test';
import { signInFromGameOver } from '../../support/auth';
import { answerQuestion, startGame } from '../../support/game';
import { drift } from '../../support/layout';
import { CORRECT_ANSWERS } from '../../support/open-trivia';

/**
 * `FEAT-004` end to end: a score a streak multiplier pushed past its own
 * question count reaches the leaderboard, and the board shows it as points
 * rather than as a fraction of a denominator it no longer divides.
 *
 * **The client and the rules are the two ends of one bound** (`CLAUDE.md`
 * §4.1): `firestore.rules` caps `score` at `totalQuestions * 3` and the client
 * must never produce a score above it, because the refusal arrives as a bare
 * `permission-denied` that `/game-over` cannot honestly explain. The rules
 * tests prove the ceiling from the outside; this proves the app stays under it
 * with the real rules loaded, which is the half neither a unit test nor a
 * rules test can see.
 *
 * **Emulator-only, and not by omission.** It is not listed in
 * `playwright.preview.config.ts`, where `authenticated/` specs are opt-in, for
 * a reason that outlives this feature: a preview channel runs whatever
 * `firestore.rules` `main` last deployed, because rules are per project and a
 * channel is Hosting only (`docs/ci-cd.md` §4.2a). A spec whose whole subject
 * is a bound that a PR may be in the middle of moving would fail against the
 * real project on exactly the PRs where the mismatch is expected — turning a
 * signal into a red that reviewers learn to ignore. `sign-in-save-score.spec.ts`
 * already covers signing in and saving against the real project, with a score
 * no multiplier touches.
 */
test.describe('a multiplied score reaches the leaderboard', () => {
  const password = 'correct horse battery staple';

  test('saves a perfect round for more points than there were questions', async ({
    page,
    firebase,
  }) => {
    const tag = Math.random().toString(36).slice(2, 8);
    const player = `Streak Player ${tag}`;
    const email = `streak-${Date.now()}-${tag}@example.com`;
    await firebase.createVerifiedUser({ email, password });

    await startGame(page, 5);
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);

    // Seven points for five questions — 1 + 1 + 1.5 + 1.5 + 2, rounded once.
    // The pre-FEAT-004 rules refused exactly this, twice over: `score` above
    // `totalQuestions`, and a `percentage` no longer derived from the score.
    await expect(page.getByTestId('final-score')).toHaveText('7');
    await expect(page.getByTestId('correct-answers')).toHaveText('5 / 5');
    await expect(page.getByTestId('max-streak')).toHaveText('5');

    await signInFromGameOver(page, email, password);
    await page.locator('input[name=playerName]').fill(player);
    await page.getByRole('button', { name: 'Save Score', exact: true }).click();

    // The confirmation only appears once `saveHighScore` resolves, so it is the
    // assertion that the rules accepted the write rather than that the UI is
    // optimistic about it.
    await expect(page.getByTestId('score-saved')).toBeVisible();

    // Scoped to the player's own row by its run-unique name: the board is
    // shared with every other worker, so an unscoped text match would be
    // asserting about somebody else's round. Only ten rows render, and seven
    // points is comfortably inside them — nothing else in the suite saves or
    // seeds a score between seven and the twenty-five the test below plants.
    const row = page
      .getByTestId('leaderboard-body')
      .getByRole('listitem')
      .filter({ hasText: player });
    await expect(row).toContainText('7 pts');
    await expect(row).toContainText('100%');
  });

  /**
   * A multiplied entry must not be a taller or differently-shaped row than an
   * unmultiplied one (`CLAUDE.md` §4.4). The board mixes both indefinitely —
   * every entry saved before this feature is unmultiplied and stays on the
   * board — so this is not a transient state, it is the board's permanent
   * composition.
   *
   * Heights rather than widths: the score column is `shrink-0`, so a longer
   * score narrows the name beside it rather than widening the row, and the row
   * is the container's width in every case. What could genuinely move is the
   * height, if a longer score wrapped to a second line at a phone width — which
   * is why this measures at 320px, the narrowest the app is built for.
   */
  test('renders a multiplied and an unmultiplied entry at the same height', async ({
    page,
    firebase,
  }) => {
    await page.setViewportSize({ width: 320, height: 900 });

    const tag = Math.random().toString(36).slice(2, 8);
    const plain = `Plain ${tag}`;
    const multiplied = `Streaked ${tag}`;
    // Both scores are high enough to hold a top-ten slot whatever else is on
    // the shared emulator's board — the screen only renders ten rows, and a
    // seeded entry nobody can see would make this pass by not looking.
    // 25/25 is precisely what an entry saved before multipliers looks like at
    // its best; 65/25 is what a perfect round of the same length earns now.
    await firebase.seedLeaderboardEntry({
      uid: `plain-${tag}`,
      name: plain,
      score: 25,
      totalQuestions: 25,
      percentage: 100,
    });
    await firebase.seedLeaderboardEntry({
      uid: `multiplied-${tag}`,
      name: multiplied,
      score: 65,
      totalQuestions: 25,
      percentage: 100,
    });

    await startGame(page, 5);
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);
    await expect(page.getByTestId('leaderboard-skeleton')).toHaveCount(0);

    const rows = page.getByTestId('leaderboard-body').getByRole('listitem');
    const plainRow = rows.filter({ hasText: plain });
    const multipliedRow = rows.filter({ hasText: multiplied });
    await expect(plainRow).toHaveCount(1);
    await expect(multipliedRow).toHaveCount(1);

    // Polled together rather than measured one at a time, so a late layout
    // frame cannot make two readings taken a tick apart disagree
    // (`CLAUDE.md` §4.6).
    await expect
      .poll(
        async () => {
          const [one, two] = await Promise.all([
            plainRow.boundingBox(),
            multipliedRow.boundingBox(),
          ]);
          return drift(one?.height ?? Number.NaN, two?.height ?? Number.NaN);
        },
        { message: 'a multiplied entry is the same height as an unmultiplied one' },
      )
      .toBe(0);
  });
});
