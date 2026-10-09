import { Browser, BrowserContext, Page, Request } from '@playwright/test';
import { FirebaseBackend } from '../../fixtures/firebase-backend';
import { expect, test } from '../../fixtures/test';
import { AvatarSeed } from '../../fixtures/types';
import { expectRadiosAreGrouped } from '../../support/a11y';
import { authMenu, signInViaUi } from '../../support/auth';
import { installAuthUidTracker } from '../../support/auth-uid-tracker';
import { answerQuestion, optionLabel, startNewGame } from '../../support/game';
import {
  DocumentBox,
  expectSameHeight,
  largestShift,
  settledBox,
  settledHeight,
} from '../../support/layout';
import { CORRECT_ANSWERS, stubOpenTrivia } from '../../support/open-trivia';
import { holdRequests } from '../../support/requests';

const password = 'Str0ngPassw0rd!';
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const uniqueEmail = () => `avatar-${unique()}@example.com`;

/**
 * A Google profile photo's address. Nothing here reaches Google: every request
 * to the host is answered by `servePhoto` below, and the address is what the
 * Auth emulator stores on the account the way a Google sign-in would.
 */
const PHOTO_URL = 'https://lh3.googleusercontent.com/a/avatar-e2e=s96-c';
const PHOTO_HOST = 'https://lh3.googleusercontent.com/**';
const PHOTO_BODY =
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
  '<rect width="96" height="96" fill="#b91c1c"/></svg>';

/** The two widths the brief names: a phone, and a desktop past every breakpoint. */
const PHONE = { width: 390, height: 800 };
const DESKTOP = { width: 1280, height: 800 };

type Kind = AvatarSeed['avatar']['kind'];

/**
 * Answers every request for the photo host with an image — or, with
 * `status: 404`, with nothing — and records each request so a test can read
 * what the browser sent.
 */
async function servePhoto(
  target: Page | BrowserContext,
  status = 200,
): Promise<{ requests: Request[] }> {
  const requests: Request[] = [];
  await target.route(PHOTO_HOST, async (route) => {
    requests.push(route.request());
    await route.fulfill(
      status === 200
        ? { status, contentType: 'image/svg+xml', body: PHOTO_BODY }
        : { status, contentType: 'text/plain', body: 'gone' },
    );
  });
  return { requests };
}

/** An account with a stored choice, signed in on a page of its own. */
async function accountShowing(
  browser: Browser,
  baseURL: string | undefined,
  firebase: FirebaseBackend,
  kind: Kind,
): Promise<{ page: Page; context: BrowserContext; done: () => Promise<void> }> {
  const email = uniqueEmail();
  const { uid } = await firebase.createVerifiedUser({
    email,
    password,
    displayName: 'Ada Lovelace',
    ...(kind === 'photo' ? { photoURL: PHOTO_URL } : {}),
  });
  if (kind !== 'initials') {
    await firebase.seedAvatar({
      uid,
      avatar:
        kind === 'built'
          ? { kind, seed: 'core-35', showPublicly: false }
          : { kind, showPublicly: false },
    });
  }

  // A context of its own per account, so all three can be measured side by
  // side. The fixture's uid tracker covers only the test's own context, so
  // this one reports its uids the same way.
  const context = await browser.newContext({ baseURL });
  const tracker = await installAuthUidTracker(context);
  await servePhoto(context);
  const page = await context.newPage();
  await page.goto('/');
  await signInViaUi(page, email, password);
  await expect(page.getByTestId('auth-menu-avatar')).toHaveAttribute('data-avatar', kind);

  return {
    page,
    context,
    done: async () => {
      firebase.trackAuthUids(tracker.take());
      await context.close();
    },
  };
}

/**
 * The account chip's box, once two consecutive readings agree — read with the
 * page scrolled to the top. The chip lives in the sticky top bar, so its
 * document box moves with the scroll position while nothing about the layout
 * does. Playwright scrolls a target into view before clicking it, and in one
 * full run that left one of the three pages scrolled 11px after sign-in (the
 * trace's snapshots say so), so its chip read 11px lower than the other two.
 * At the top of the page the document box is the layout box.
 */
async function chipBox(page: Page, what: string): Promise<DocumentBox> {
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
  return settledBox(page.getByTestId('auth-menu-trigger'), what);
}

/**
 * The `users/{uid}` read the chip makes once per session — a
 * `documents:batchGet` whose body names the document. The reviewer register is
 * read the same way, so the body is what tells them apart.
 */
function isAvatarRead(request: Request): boolean {
  return (
    request.url().includes('/documents:batchGet') &&
    (request.postData() ?? '').includes('/documents/users/')
  );
}

/**
 * `FEAT-038`: the player chooses their avatar — initials, their Google photo,
 * or one they build — and whether it may ever be shown to anybody else.
 *
 * **Emulator-only.** The picker saves through the new `setAvatar` callable,
 * and Cloud Functions are not channel-scoped (`docs/ci-cd.md` §4.2a): on a
 * preview channel the callable does not exist until the merge deploys it.
 * `playwright.preview.config.ts` includes authenticated specs by name, so this
 * file reaches the real project only if somebody adds it.
 */
test.describe('avatar choice', () => {
  /**
   * **The measurement the brief asks for.** Three earlier resizes of this
   * chip were real defects (`CLAUDE.md` §4.4), and an avatar arriving from the
   * network would have been a fourth — so the box is reserved, and this is
   * the proof: three accounts showing the three kinds, measured side by side
   * in a real browser at a phone width and a desktop width. jsdom has no
   * layout, so nothing below this layer can see it.
   *
   * Each chip is first asserted to be showing its kind — the photo one only
   * once the image has loaded — or three initials chips would pass this
   * vacuously.
   */
  test('keeps the account chip one box across initials, a photo and a built avatar', async ({
    browser,
    baseURL,
    firebase,
  }) => {
    const accounts = await Promise.all(
      (['initials', 'photo', 'built'] as const).map((kind) =>
        accountShowing(browser, baseURL, firebase, kind),
      ),
    );

    try {
      for (const viewport of [PHONE, DESKTOP]) {
        const boxes: DocumentBox[] = [];
        for (const [index, { page }] of accounts.entries()) {
          await page.setViewportSize(viewport);
          boxes.push(await chipBox(page, `chip ${index} at ${viewport.width}px`));
        }
        const [initials, photo, built] = boxes;
        expect(
          largestShift(initials, photo),
          `photo against initials at ${viewport.width}px: ${JSON.stringify(boxes)}`,
        ).toBe(0);
        expect(
          largestShift(initials, built),
          `built against initials at ${viewport.width}px: ${JSON.stringify(boxes)}`,
        ).toBe(0);
        // The avatar inside is the same 28px circle in all three.
        for (const { page } of accounts) {
          const avatar = await page.getByTestId('auth-menu-avatar').boundingBox();
          expect(avatar?.width).toBe(28);
          expect(avatar?.height).toBe(28);
        }
      }
    } finally {
      for (const account of accounts) {
        await account.done();
      }
    }
  });

  /**
   * The stored choice arrives after the chip's first paint — initials first,
   * the choice when the read lands — and the chip does not move when it does.
   * The read is held open so the initials state is measured rather than
   * raced; `seen` proves the gate held something.
   */
  test('does not move the chip when the stored choice arrives after first paint', async ({
    page,
    firebase,
  }) => {
    const email = uniqueEmail();
    const { uid } = await firebase.createVerifiedUser({ email, password, displayName: 'Ada' });
    await firebase.seedAvatar({
      uid,
      avatar: { kind: 'built', seed: 'core-12', showPublicly: false },
    });

    await page.setViewportSize(PHONE);
    await page.goto('/');
    const read = await holdRequests(page, isAvatarRead);
    await signInViaUi(page, email, password);
    await read.seen;

    const avatar = page.getByTestId('auth-menu-avatar');
    await expect(avatar).toHaveAttribute('data-avatar', 'initials');
    const before = await chipBox(page, 'the chip on initials, before the read lands');

    read.release();
    await expect(avatar).toHaveAttribute('data-avatar', 'built');
    const after = await chipBox(page, 'the chip once the built avatar is drawn');

    expect(
      largestShift(before, after),
      `${JSON.stringify(before)} → ${JSON.stringify(after)}`,
    ).toBe(0);
  });

  /**
   * The photo's own arrival: initials inside the box until the image has
   * loaded, then the image, with nothing moving — and the request carries no
   * referrer, so Google's image server is not told which page asked.
   */
  test('shows initials until the photo loads, then the photo, sending no referrer', async ({
    page,
    firebase,
  }) => {
    const email = uniqueEmail();
    const { uid } = await firebase.createVerifiedUser({
      email,
      password,
      displayName: 'Ada',
      photoURL: PHOTO_URL,
    });
    await firebase.seedAvatar({ uid, avatar: { kind: 'photo', showPublicly: false } });

    // Serve first, hold second: Playwright runs route handlers newest first,
    // so the hold sees each request before the stub answers it.
    const served = await servePhoto(page);
    const photo = await holdRequests(page, (request) => request.url().startsWith(PHOTO_URL));
    await page.setViewportSize(PHONE);
    await page.goto('/');
    await signInViaUi(page, email, password);
    await photo.seen;

    const avatar = page.getByTestId('auth-menu-avatar');
    await expect(avatar).toHaveAttribute('data-avatar', 'initials');
    await expect(avatar).toContainText('A');
    const before = await chipBox(page, 'the chip while the photo loads');

    photo.release();
    await expect(avatar).toHaveAttribute('data-avatar', 'photo');
    await expect(avatar.locator('img')).toBeVisible();
    const after = await chipBox(page, 'the chip with the photo drawn');
    expect(largestShift(before, after)).toBe(0);

    expect(served.requests.length).toBeGreaterThan(0);
    for (const request of served.requests) {
      expect(await request.headerValue('referer')).toBeNull();
    }
  });

  /**
   * A photo that fails — revoked, rate-limited, offline — leaves the
   * initials and no broken image. Silent on purpose: an avatar is not worth
   * an error state.
   */
  test('falls back to initials, with no broken image, when the photo fails', async ({
    page,
    firebase,
  }) => {
    const email = uniqueEmail();
    const { uid } = await firebase.createVerifiedUser({
      email,
      password,
      displayName: 'Ada',
      photoURL: PHOTO_URL,
    });
    await firebase.seedAvatar({ uid, avatar: { kind: 'photo', showPublicly: false } });
    const served = await servePhoto(page, 404);

    await page.goto('/');
    await signInViaUi(page, email, password);

    await expect
      .poll(() => served.requests.length, { message: 'the photo was asked for' })
      .toBeGreaterThan(0);
    const avatar = page.getByTestId('auth-menu-avatar');
    await expect(avatar.locator('img')).toHaveCount(0);
    await expect(avatar).toHaveAttribute('data-avatar', 'initials');
    await expect(avatar).toContainText('A');
  });

  /**
   * The whole picker, by keyboard alone (`CLAUDE.md` §4.5): the named
   * radiogroups walked with Tab and the arrow keys, the switch with Space,
   * Save with Enter — through the real `setAvatar` on the emulator, with the
   * stored document read back through the Admin SDK. Then a second save, of
   * initials, proves the write replaces the field whole: a merging write
   * would leave the old seed under the new kind. And the totals seeded first
   * prove it touches nothing else on the document.
   */
  test('saves a built avatar by keyboard, and replaces it whole with the next choice', async ({
    page,
    firebase,
  }) => {
    const email = uniqueEmail();
    const { uid } = await firebase.createVerifiedUser({ email, password, displayName: 'Ada' });
    await firebase.seedGameplayStats({
      uid,
      gamesPlayed: 3,
      questionsAnswered: 15,
      correctAnswers: 11,
      bestStreak: 4,
      statsSince: Date.UTC(2026, 0, 15),
    });

    await page.goto('/');
    await signInViaUi(page, email, password);
    await page.goto('/profile');

    await expect(page.getByTestId('avatar-idle')).toBeVisible();
    await expectRadiosAreGrouped(page);
    await expect(page.getByRole('radiogroup', { name: 'Show as', exact: true })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Core Shape', exact: true })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Core Colour', exact: true })).toBeVisible();
    // The set level 3 opens is on the page for this level-0 account too, locked.
    await expect(page.getByRole('radiogroup', { name: 'Bold Shape', exact: true })).toBeVisible();
    // No photo on this account, so no photo to offer.
    await expect(page.getByTestId('avatar-kind-photo')).toHaveCount(0);

    await page.getByTestId('avatar-kind-initials').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Build your own', exact: true })).toBeChecked();

    await page.keyboard.press('Tab');
    await expect(page.getByRole('radio', { name: 'Dot', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Ring', exact: true })).toBeChecked();

    await page.keyboard.press('Tab');
    await expect(page.getByRole('radio', { name: 'Emerald', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Forest', exact: true })).toBeChecked();

    // The locked bold set is passed through, one stop per group: reachable,
    // which is how a keyboard user learns it exists (`FEAT-041`), and choosing
    // nothing on the way.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('radio', { name: 'Star', exact: true })).toBeFocused();
    await expect(page.getByRole('radio', { name: 'Star', exact: true })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.keyboard.press('Tab');
    await expect(page.getByRole('radio', { name: 'Ruby', exact: true })).toBeFocused();

    await page.keyboard.press('Tab');
    const publicSwitch = page.getByRole('checkbox', {
      name: 'Show my avatar to other players',
      exact: true,
    });
    await expect(publicSwitch).toBeFocused();
    await expect(publicSwitch).not.toBeChecked();
    await page.keyboard.press('Space');
    await expect(publicSwitch).toBeChecked();

    await page.keyboard.press('Tab');
    await expect(page.getByTestId('avatar-save')).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('avatar-saved')).toBeVisible();
    await expect(page.getByTestId('profile-announcement')).toHaveText('Avatar saved.');
    await expect(page.getByTestId('auth-menu-avatar')).toHaveAttribute('data-avatar', 'built');
    await expect(page.getByTestId('profile-avatar')).toHaveAttribute('data-avatar', 'built');
    // Focus stayed on the button that was pressed — `aria-disabled` while in
    // flight, never `disabled`, which would have dropped it to `<body>`.
    await expect(page.getByTestId('avatar-save')).toBeFocused();

    await expect
      .poll(async () => (await firebase.inspectAccountState({ uid })).gameplayStats?.['avatar'])
      .toEqual({ kind: 'built', seed: 'core-11', showPublicly: true });

    await optionLabel(page, page.getByTestId('avatar-kind-initials')).click();
    await page.getByTestId('avatar-save').click();
    await expect(page.getByTestId('auth-menu-avatar')).toHaveAttribute('data-avatar', 'initials');

    await expect
      .poll(async () => (await firebase.inspectAccountState({ uid })).gameplayStats?.['avatar'])
      .toEqual({ kind: 'initials', showPublicly: true });
    const stored = (await firebase.inspectAccountState({ uid })).gameplayStats!;
    expect(stored['avatar']).not.toHaveProperty('seed');
    expect(stored).toMatchObject({ gamesPlayed: 3, questionsAnswered: 15, correctAnswers: 11 });
  });

  /**
   * **The regression this feature would otherwise have shipped.** A game
   * banked by `recordGameResult` used to replace `users/{uid}` whole, which
   * would have erased the avatar with every game — and a document holding
   * only an avatar made the totals arithmetic produce `NaN`, so the first game
   * after choosing one never banked at all. One game played over a stored
   * choice, on the real callable, covers both.
   */
  test('banks a first game over a stored avatar, and keeps the avatar', async ({
    page,
    firebase,
  }) => {
    const email = uniqueEmail();
    const { uid } = await firebase.createVerifiedUser({ email, password, displayName: 'Ada' });
    const avatar = { kind: 'built' as const, seed: 'core-40', showPublicly: false };
    await firebase.seedAvatar({ uid, avatar });

    await stubOpenTrivia(page);
    await page.goto('/');
    await signInViaUi(page, email, password);
    await startNewGame(page, 5);
    for (const answer of CORRECT_ANSWERS) {
      await answerQuestion(page, answer);
    }
    await expect(page).toHaveURL(/\/game-over$/);

    // Not `waitForGameplayStats`, which waits for the document to exist — and
    // this one exists from the start, holding only the avatar. What has to
    // appear is the game.
    await expect
      .poll(
        async () => (await firebase.inspectAccountState({ uid })).gameplayStats?.['gamesPlayed'],
        {
          message: 'recordGameResult banked the game onto a document holding only an avatar',
        },
      )
      .toBe(1);
    const stored = (await firebase.inspectAccountState({ uid })).gameplayStats!;
    expect(stored).toMatchObject({ gamesPlayed: 1, questionsAnswered: 5, correctAnswers: 5 });
    expect(stored['avatar']).toEqual(avatar);
  });

  /**
   * The browser half of "the choice holds still while a save is in flight":
   * a click on another kind is cancelled, and the radio group goes on showing
   * the choice being saved. jsdom does not restore a group on a cancelled
   * click, which is why this is asserted here rather than in the unit spec.
   */
  test('holds the choice still while a save is in flight', async ({ page, firebase }) => {
    const email = uniqueEmail();
    await firebase.createVerifiedUser({ email, password, displayName: 'Ada' });

    await page.goto('/');
    await signInViaUi(page, email, password);
    await page.goto('/profile');
    await expect(page.getByTestId('avatar-idle')).toBeVisible();

    const call = await holdRequests(page, (request) => request.url().endsWith('/setAvatar'));
    await page.getByTestId('avatar-save').click();
    await call.seen;

    await expect(page.getByTestId('avatar-saving')).toBeVisible();
    await expect(page.getByTestId('avatar-save')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('avatar-kind-built')).toHaveAttribute('aria-disabled', 'true');

    // A pointer click at the label, not `locator.click()`: Playwright's
    // actionability check reads `aria-disabled="true"` as disabled and waits
    // for it to clear — which here means waiting out the save and clicking a
    // live control, measuring nothing. A person's click does not wait.
    const label = await optionLabel(page, page.getByTestId('avatar-kind-built')).boundingBox();
    await page.mouse.click(label!.x + label!.width / 2, label!.y + label!.height / 2);
    // The arrow keys move a radio group's selection natively; they are held too.
    const initials = page.getByTestId('avatar-kind-initials');
    await initials.focus();
    await page.keyboard.press('ArrowRight');
    // Two frames, so any change detection either gesture scheduled has run
    // and the reads below are of the settled DOM rather than racing it.
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    await expect(initials).toBeChecked();
    await expect(initials).toBeFocused();
    await expect(page.getByTestId('avatar-kind-built')).not.toBeChecked();
    await expect(page.getByTestId('avatar-shape-dot')).not.toBeChecked();

    call.release();
    await expect(page.getByTestId('avatar-saved')).toBeVisible();
    await expect(page.getByTestId('avatar-save')).not.toHaveAttribute('aria-disabled', 'true');
  });

  /**
   * **Where Google's image server is contacted, counted** — the claim the
   * Privacy Policy makes about it, and the one a later change is most likely
   * to falsify (`CLAUDE.md` §4.0). For an account with a Google photo that has
   * never chosen it: nothing on `/`, where the chip draws initials, and one
   * request on `/profile`, where the picker previews the photo as a choice it
   * offers. The read of the stored choice is awaited first, so "none" means
   * the chip had its answer and drew no photo, not that it had not looked yet.
   */
  test('loads the Google photo only where it is offered or chosen', async ({ page, firebase }) => {
    const email = uniqueEmail();
    await firebase.createVerifiedUser({
      email,
      password,
      displayName: 'Ada',
      photoURL: PHOTO_URL,
    });
    const served = await servePhoto(page);

    await page.goto('/');
    const choiceRead = page.waitForResponse((response) => isAvatarRead(response.request()));
    await signInViaUi(page, email, password);
    await choiceRead;
    await expect(page.getByTestId('auth-menu-avatar')).toHaveAttribute('data-avatar', 'initials');
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    expect(served.requests, 'requests to Google’s image host on /').toHaveLength(0);

    await page.goto('/profile');
    await expect(page.getByTestId('avatar-idle')).toBeVisible();
    const preview = optionLabel(page, page.getByTestId('avatar-kind-photo')).locator('app-avatar');
    await expect(preview).toHaveAttribute('data-avatar', 'photo');
    await expect
      .poll(() => served.requests.length, {
        message: 'requests to Google’s image host on /profile',
      })
      .toBe(1);
    // The header and the chip draw the stored choice, which is not the photo.
    await expect(page.getByTestId('profile-avatar')).toHaveAttribute('data-avatar', 'initials');
    await expect(page.getByTestId('auth-menu-avatar')).toHaveAttribute('data-avatar', 'initials');
    expect(served.requests).toHaveLength(1);
  });

  /**
   * The photo is offered only to an account that has one, and the label says
   * whose it is.
   */
  test('offers the Google photo to an account that has one', async ({ page, firebase }) => {
    const email = uniqueEmail();
    await firebase.createVerifiedUser({
      email,
      password,
      displayName: 'Ada',
      photoURL: PHOTO_URL,
    });
    await servePhoto(page);

    await page.goto('/');
    await signInViaUi(page, email, password);
    await page.goto('/profile');

    const photoOption = page.getByRole('radio', { name: 'Google photo', exact: true });
    await expect(photoOption).toHaveCount(1);
    await optionLabel(page, page.getByTestId('avatar-kind-photo')).click();
    await page.getByTestId('avatar-save').click();
    await expect(page.getByTestId('auth-menu-avatar')).toHaveAttribute('data-avatar', 'photo');
  });

  /**
   * An anonymous visitor has no `users/{uid}` and never will, so the card
   * explains why it cannot save and offers the way out — and it is the same
   * height as the picker it stands in for, because the picker is laid out
   * underneath, hidden.
   */
  test('explains itself to an anonymous visitor, and offers sign-in', async ({ page }) => {
    await page.goto('/profile');

    // The sentence shown **and** its sibling hidden: the status lines share
    // one grid cell, and before the card's first binding pass every one of
    // them reads as visible (`docs/ci-cd.md` §4.3).
    await expect(page.getByTestId('avatar-signed-out')).toBeVisible();
    await expect(page.getByTestId('avatar-loading')).toBeHidden();
    await expect(page.getByTestId('avatar-picker')).toBeHidden();
    await expect(page.getByTestId('avatar-save')).toBeHidden();
    await expect(page.getByTestId('profile-avatar')).toHaveAttribute('data-avatar', 'guest');

    await page.getByTestId('avatar-sign-in').click();
    await expect(authMenu(page)).toBeVisible();
  });

  /**
   * Signing in from that state turns the explanation into the picker without
   * the card changing height — the stacked-states construction, measured
   * where it can be.
   */
  test('keeps the avatar card one height from signed out to the picker', async ({
    page,
    firebase,
  }) => {
    const email = uniqueEmail();
    await firebase.createVerifiedUser({ email, password, displayName: 'Ada' });

    // Tall enough that the page does not pin the card against an edge, which
    // can hide a resize (`CLAUDE.md` §4.4).
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto('/profile');
    await expect(page.getByTestId('avatar-signed-out')).toBeVisible();
    await expect(page.getByTestId('avatar-loading')).toBeHidden();
    const card = page.getByTestId('avatar-card');
    const signedOut = await settledHeight(card, 'the avatar card, signed out');

    await signInViaUi(page, email, password);

    await expect(page.getByTestId('avatar-idle')).toBeVisible();
    await expectSameHeight(
      card,
      signedOut,
      'the avatar card once the picker replaces the sign-in prompt',
    );
  });

  /**
   * The same measurement for an account with a Google photo, whose picker has
   * a photo tile the other one does not. The tiles are a fixed three-column
   * grid with the photo's cell kept for every account, so the tile arriving
   * with auth cannot wrap the row and grow the card — which a wrapping row
   * does, by 66px at this width.
   */
  test('keeps the avatar card one height for an account with a Google photo', async ({
    page,
    firebase,
  }) => {
    const email = uniqueEmail();
    await firebase.createVerifiedUser({
      email,
      password,
      displayName: 'Ada',
      photoURL: PHOTO_URL,
    });
    await servePhoto(page);

    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto('/profile');
    await expect(page.getByTestId('avatar-signed-out')).toBeVisible();
    await expect(page.getByTestId('avatar-loading')).toBeHidden();
    const card = page.getByTestId('avatar-card');
    const signedOut = await settledHeight(card, 'the avatar card, signed out');

    await signInViaUi(page, email, password);

    await expect(page.getByTestId('avatar-idle')).toBeVisible();
    await expect(page.getByTestId('avatar-kind-photo')).toHaveCount(1);
    await expectSameHeight(
      card,
      signedOut,
      'the avatar card once a picker with a photo tile replaces the sign-in prompt',
    );
  });
});
