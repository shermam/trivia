import { expect, test } from '../../fixtures/test';
import { startGame } from '../../support/game';
import { readSavedGame } from '../../support/offline-storage';
import { stubOpenTrivia } from '../../support/open-trivia';

/**
 * The suite's own test isolation.
 *
 * **There is no hook here to test, which is why the tests are shaped as they
 * are.** Playwright gives every test a fresh `BrowserContext`: fresh cookies,
 * fresh `localStorage`, fresh IndexedDB, and therefore a fresh anonymous uid,
 * because the Firebase session is persisted in that same storage. Nothing in
 * this repository clears any of it — a runner without that guarantee would need
 * `OfflineDbService`'s database deleted by hand from a `beforeEach` timed
 * against the app's own open connection, and that hand-written version is what
 * used to be worth pinning. What is left worth pinning is the *consequence* the
 * whole suite leans on, which is what these two tests assert.
 *
 * **They are ordered, and deliberately so.** That is normally the thing to
 * avoid, which is the point: the first leaves state behind on purpose so the
 * second has something to be clean *of*. `mode: 'serial'` is what buys both
 * halves of that — the order, and the guarantee that they run in the **same
 * worker**, so the second really is following the first rather than starting a
 * browser the first never touched. It does not share a context between them:
 * `page` is test-scoped, so the second test gets a new one, which is exactly
 * the thing under test.
 *
 * **Mutation-verified by removing the context boundary**: run the two bodies
 * back to back inside *one* test and it fails, on `localStorage` already
 * holding `firebase:authUser:…` before a line of app code has run — and with
 * that assertion moved out of the way, on the resume banner being present
 * (count 1). Those are two separate runs, because an assertion that fails ends
 * the test: only the first one reached is ever observed, which is also why the
 * storage read is asserted **last** below. It trips soonest when state leaks,
 * so leaving it first would report one symptom out of four.
 */
test.describe.configure({ mode: 'serial' });

test.describe('browser state does not leak between tests', () => {
  /**
   * The first test's anonymous uid, read by the second.
   *
   * Module state rather than a fixture: a fixture is rebuilt per test, which is
   * the property being measured, so it cannot be the thing carrying the
   * measurement across. Serial mode keeps both tests in one worker, and one
   * worker is one module instance.
   */
  let firstUid: string | undefined;

  test('leaves a saved game and a signed-in session behind on purpose', async ({
    page,
    authUids,
  }) => {
    await startGame(page, 5);
    await expect(page.getByText('Question 1 / 5')).toBeVisible();

    // The persisting effect queues an async write with no observable "landed"
    // signal, so asserting the record exists is what makes this test's whole
    // premise honest — otherwise the next test could pass against a game that
    // was never saved in the first place.
    await expect
      .poll(() => readSavedGame(page), {
        message: 'a game is in IndexedDB when this test ends',
      })
      .not.toBeNull();

    // Polled, like its counterpart in the next test, because anonymous sign-in
    // is a round trip and nothing here waits on it: the questions are stubbed,
    // so the game can be on screen before Auth has answered. Against the
    // emulator that gap is a millisecond and a one-shot read never lost the
    // race; against the real project behind a preview channel it does.
    await expect
      .poll(() => authUids.uids().length, { message: 'an anonymous session was persisted' })
      .toBeGreaterThanOrEqual(1);
    const uids = authUids.uids();
    firstUid = uids[uids.length - 1];

    await expect
      .poll(() => page.evaluate(() => Object.keys(window.localStorage).length), {
        message: 'localStorage holds this session when the test ends',
      })
      .toBeGreaterThan(0);
  });

  test('starts clean: empty storage, no saved game, a different anonymous uid', async ({
    page,
    authUids,
  }) => {
    expect(firstUid, 'the previous test ran and recorded its uid').toBeTruthy();

    // Captured before a single line of application code runs, which is the
    // only moment at which "empty" means the previous test left nothing rather
    // than "this page has not written anything yet". An init script runs at
    // document start on every navigation in this context.
    await page.addInitScript(() => {
      const win = window as unknown as { __storageAtStart?: string[] };
      win.__storageAtStart ??= Object.keys(window.localStorage);
    });

    await stubOpenTrivia(page);
    await page.goto('/');

    const storageAtStart = await page.evaluate(
      () => (window as unknown as { __storageAtStart?: string[] }).__storageAtStart ?? null,
    );

    // A positive anchor before the negative assertions: an empty page satisfies
    // "no resume banner" and would pass against the very regression this
    // guards (`docs/ci-cd.md` §4.3).
    await expect(page.locator('#amount')).toBeVisible();
    await expect(page.getByTestId('resume-banner')).toHaveCount(0);
    expect(await readSavedGame(page), 'the previous test’s saved game').toBeNull();

    // The uid is the half a storage check cannot cover: a context that somehow
    // shared its Firebase session would restore the same account rather than
    // signing in afresh, and every backend assertion in the suite that assumes
    // "this test's uid" would be about the previous test's player.
    await expect
      .poll(() => authUids.uids().length, { message: 'this test signed in anonymously' })
      .toBeGreaterThanOrEqual(1);
    expect(authUids.uids(), 'a uid inherited from the previous test').not.toContain(firstUid);

    // Asserted last, though it is read first: it is the assertion that trips
    // soonest when state leaks, so putting it up here would mask the three
    // above it and report one symptom instead of four.
    expect(storageAtStart, 'localStorage before the app booted').toEqual([]);
  });
});
