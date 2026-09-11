import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { optionLabel, waitForPlayRoute } from '../../support/game';
import { stubOpenTrivia } from '../../support/open-trivia';

/**
 * `FEAT-014`. Five free games a day, counted on this device.
 *
 * The counter is not a security boundary — `FEAT-014` §0 says so, and these
 * tests do not pretend otherwise. What they hold down is that it counts, that
 * it stops the sixth game, that Pro is unaffected, and that **the row it
 * renders does not move the page**, which is the failure `CLAUDE.md` §4.4
 * exists for and the one nothing else here would catch.
 *
 * Nothing resets the counter between tests and nothing needs to: it lives in
 * IndexedDB, and every test gets a fresh `BrowserContext`, which is a fresh
 * database. The counter is per-device rather than per-account, so this is also
 * the one spec here whose isolation would be impossible to arrange on the
 * backend.
 */

/** Writes the counter straight into IndexedDB, so a test does not have to play five games. */
async function seedDailyLimit(page: Page, record: { date: string; count: number }): Promise<void> {
  await page.evaluate(
    ({ date, count }) =>
      new Promise<void>((resolve, reject) => {
        // Deliberately version-less: the app has already opened the database
        // at its current version by the time this runs (the `beforeEach` waits
        // for the allowance to resolve, which is that read), so this attaches
        // to the schema that exists rather than declaring one of its own.
        const open = window.indexedDB.open('trivia-offline');
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('daily-limit', 'readwrite');
          tx.objectStore('daily-limit').put({ id: 'today', date, count });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error as Error);
          };
        };
        open.onerror = () => reject(open.error as Error);
      }),
    record,
  );
}

/** The local calendar day the service keys the counter on (`localDateKey`). */
function todayStamp(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

test.describe('daily free game limit', () => {
  test.beforeEach(async ({ page }) => {
    await stubOpenTrivia(page);
    await page.goto('/');
    // Waiting for the allowance to render its resolved sentence is this
    // suite's stand-in for waiting on the categories request: it is proof the
    // app has booted *and* that it has opened its IndexedDB database, which is
    // what `seedDailyLimit` above attaches to.
    await expect(page.getByTestId('daily-allowance')).toContainText('free games left today');
  });

  test('shows the allowance before the first game', async ({ page }) => {
    await expect(page.getByTestId('daily-allowance')).toContainText('5 of 5 free games left today');
  });

  test('counts a played game against the allowance', async ({ page }) => {
    await page.locator('#amount').selectOption({ label: '5' });
    const unlimited = page.getByTestId('time-limit-unlimited');
    await optionLabel(page, unlimited).click();
    await expect(unlimited).toBeChecked();
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();
    await waitForPlayRoute(page);

    // Back to the setup screen without playing it out — the game was served,
    // which is the moment the allowance is spent.
    await page.goto('/');
    await expect(page.getByTestId('daily-allowance')).toContainText('4 of 5 free games left today');
  });

  test('offers Pro instead of a sixth game', async ({ page }) => {
    await seedDailyLimit(page, { date: todayStamp(), count: 5 });
    await page.goto('/');

    await expect(page.getByTestId('daily-allowance')).toContainText('No free games left today');
    await expect(page.getByTestId('daily-limit-reached')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start Game', exact: true })).toHaveCount(0);

    await page.getByTestId('daily-limit-upgrade').click();
    await expect(page).toHaveURL(/\/pricing$/);
  });

  test('starts again the next day', async ({ page }) => {
    // A record from another day is not today's count, so it reads as unspent.
    await seedDailyLimit(page, { date: '2020-01-01', count: 5 });
    await page.goto('/');

    await expect(page.getByTestId('daily-allowance')).toContainText('5 of 5 free games left today');
    await expect(page.getByRole('button', { name: 'Start Game', exact: true })).toBeVisible();
  });

  /**
   * `CLAUDE.md` §4.4. The allowance row renders for everyone from first paint
   * precisely so it cannot push the Start button down the screen when the count
   * resolves — a shift at the exact moment the reader is looking at the control
   * they are reaching for.
   *
   * Measured on the button's own position rather than on the row's presence,
   * because the row existing is not the property that matters; the page not
   * moving is. At a viewport tall enough to leave the card some slack, per the
   * §4.4 note that the same class of shift measures 0px at one height and 43px
   * at another.
   */
  test('does not move the Start button when the allowance resolves', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto('/');

    const start = page.getByRole('button', { name: 'Start Game', exact: true });

    // Before the count has been read back from IndexedDB.
    const before = (await start.boundingBox())!.y;

    await expect(page.getByTestId('daily-allowance')).toContainText('free games left today');

    // Polled rather than read once: a late layout frame must not decide the
    // measurement, and a shift that never settles still fails, because the
    // poll has nothing to settle *to* except the original position.
    await expect
      .poll(async () => Math.abs((await start.boundingBox())!.y - before), {
        message: 'the allowance resolving must not move the Start button',
      })
      .toBeLessThanOrEqual(1);
  });
});
