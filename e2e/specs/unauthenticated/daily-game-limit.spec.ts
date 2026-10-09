import { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { waitForAnonymousSession } from '../../support/auth';
import { optionLabel, waitForPlayRoute } from '../../support/game';
import { expectBoxUnmoved, settledBox } from '../../support/layout';
import { stubOpenTrivia } from '../../support/open-trivia';
import { holdRequests, isPlayChunk } from '../../support/requests';

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
    // Waiting for the allowance to render its resolved sentence is proof the
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

  /**
   * The day's last free game. Start spends it once the questions are in hand
   * and only then navigates, so the allowance reads zero while Start still says
   * "Loading Questions…" and `/play`'s chunk downloads — and the Pro offer, a
   * far taller box, took Start's place under the pointer for as long as that
   * took (`CLAUDE.md` §4.4). The chunk is held, so the window is measured
   * rather than caught; `curated-quiz.spec.ts` holds the same line on the quiz
   * page.
   */
  test('keeps Start in place while it spends the day’s last free game', async ({ page }) => {
    await seedDailyLimit(page, { date: todayStamp(), count: 4 });
    await page.goto('/');
    await expect(page.getByTestId('daily-allowance')).toHaveText('1 of 5 free games left today.');
    // The offer is optimistic until the entitlement is known, so wait for it:
    // the zero below is then the free tier's answer, not the window before it.
    await waitForAnonymousSession(page);

    const start = page.getByTestId('setup-card').locator('form button[type="submit"]');
    await expect(start).toHaveText('Start Game');
    const startBox = await settledBox(start, 'Start, with one free game left');

    const playChunk = await holdRequests(page, isPlayChunk);
    await page.getByRole('button', { name: 'Start Game', exact: true }).click();
    await playChunk.seen;

    // Spent, and saying so — the moment the offer used to arrive.
    await expect(page.getByTestId('daily-allowance')).toHaveText('No free games left today.');
    await expect(page.getByTestId('daily-limit-reached')).toHaveCount(0);
    await expect(start).toHaveText('Loading Questions…');
    await expectBoxUnmoved(start, startBox, 'Start while it spends the last free game');

    playChunk.release();
    await waitForPlayRoute(page);
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
   *
   * **Sampled every frame from first paint rather than measured before and
   * after**, and that is the whole design. A pair of measurements only says
   * anything if the first one is genuinely on the far side of the event — and
   * nothing here can establish that it is. The IndexedDB read resolves on its
   * own schedule, and the row says *the same sentence* either side of it (the
   * counter starts at 0 in the signal and reads back 0 from an empty database),
   * so there is no DOM state to wait for the absence of.
   *
   * Watching every frame removes the ordering requirement instead of trying to
   * satisfy it: the first sample is the first frame in which the button exists,
   * which is by construction at or before any later shift, and a row that
   * appeared only once the count resolved would move the button between two
   * samples. The sampler is installed as an init script so it is running before
   * a line of application code is.
   */
  test('does not move the Start button when the allowance resolves', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1000 });

    await page.addInitScript(() => {
      const tops: number[] = [];
      (window as unknown as { __startButtonTops: number[] }).__startButtonTops = tops;
      const sample = (): void => {
        // The setup form's own submit control, scoped to the setup component's
        // host rather than to "a form on this page". The Start button has no
        // `data-cy`, and `form button[type="submit"]` would also match the auth
        // menu's submit the moment that menu is open — which is a different
        // element in a different part of the bar, so the sampler would silently
        // start measuring its top instead.
        const button = document.querySelector('app-game-setup form button[type="submit"]');
        if (button) {
          tops.push(button.getBoundingClientRect().top);
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });

    await page.goto('/');

    const start = page.getByRole('button', { name: 'Start Game', exact: true });
    await expect(start).toBeVisible();
    await expect(page.getByTestId('daily-allowance')).toContainText('free games left today');

    // Polled so that a late layout frame cannot decide the measurement, and so
    // the window keeps growing while the assertion retries. A shift that never
    // settles still fails: the only value this can settle to is one where every
    // sampled frame agrees.
    //
    // **It does not establish that the window extends past the allowance
    // resolving, and nothing here can.** That is the same hole the block
    // comment above describes from the other side: the row renders the
    // identical sentence before and after the IndexedDB read, so there is no
    // DOM state whose arrival marks the moment. What the shape does buy is that
    // the window starts before any application code and ends no earlier than
    // the first frame in which every sample agrees — so a shift inside it is
    // caught, and the only escape left is a shift that lands after the poll has
    // already settled.
    await expect
      .poll(
        async () => {
          const tops = await page.evaluate(
            () => (window as unknown as { __startButtonTops: number[] }).__startButtonTops,
          );
          return { frames: tops.length > 1, spread: Math.max(...tops) - Math.min(...tops) <= 1 };
        },
        { message: 'the allowance resolving must not move the Start button' },
      )
      .toEqual({ frames: true, spread: true });
  });
});
