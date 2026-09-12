import { Locator, Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { authMenu, openAuthMenu, signInViaUi } from '../../support/auth';

test.describe('authenticated profile management', () => {
  const password = 'correct horse battery staple';

  /**
   * Unique per test, not per file: workers share one emulator and there is no
   * `resetBackend()` between tests, so a fixed address would collide with the
   * account another worker (or this test's own previous run) already created.
   * The same is true against the real preview backend, where a second
   * `createVerifiedUser` with an address that already exists fails outright.
   */
  const uniqueEmail = () =>
    `profile-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  test.beforeEach(async ({ page, firebase }) => {
    const email = uniqueEmail();
    await firebase.createVerifiedUser({ email, password });
    await page.goto('/');
    await signInViaUi(page, email, password);
  });

  test('updates the display name and reflects it in the top bar', async ({ page }) => {
    await openAuthMenu(page);
    await expect(authMenu(page)).toContainText('Your profile');
    // G6: the display name is data about the user, so it declares its purpose.
    await expect(page.locator('#displayName')).toHaveAttribute('autocomplete', 'nickname');
    await page.locator('#displayName').fill('Ada Lovelace');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    // A text assertion, which is the right check now that the name is `sr-only`
    // in the chip: it is the button's accessible name rather than something a
    // sighted user reads off the bar.
    await expect(page.getByTestId('auth-menu-trigger')).toContainText('Ada Lovelace');
  });

  /**
   * The width animation, at the only layer that can see it — and the layer that
   * caught it being wrong.
   *
   * The unit suite pins which class is set; whether that class *does* anything
   * is a browser question, and the first version of this animation failed it. It
   * used `grid-template-columns: 0fr` -> `1fr`, which is the technique every
   * accordion recipe reaches for. Every unit test passed. In a real browser the
   * `0fr` track never collapsed: an `fr` track only collapses when the grid
   * container has a width of its own to divide up, and every box in this chip is
   * shrink-to-fit, so the container was sized *from* the track's content and the
   * `fr` filled exactly that. Measured at 53.36px for both `0fr` and `1fr`, and
   * an inline `style="grid-template-columns:0fr"` did the same.
   *
   * These assertions are what failed then and pass now. All three are read from
   * *resolved* styles at rest rather than by watching an animation, because
   * catching a 600ms transition mid-flight is a race and its start and end
   * states are not — and they are polled as one object so that a late layout
   * frame cannot satisfy them one at a time.
   */
  test('collapses the chip label region to nothing, and can animate it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });

    await expect
      .poll(() => measureLabelRegion(labelRegion(page)), {
        message: 'the collapsed label region, at rest',
      })
      .toEqual({
        // Signed in, on a phone: fully collapsed. `0px` rather than some small
        // residue is the whole point — see the width assertion in the next test.
        maxWidth: '0px',
        width: 0,
        // And the class has to resolve to a real declaration: Tailwind can fail
        // to emit an arbitrary variant, leaving a class that matches no rule.
        // The runner carries no motion preference, so `motion-safe:` is live
        // here.
        transitionsMaxWidth: true,
      });
  });

  /**
   * The account chip is the only part of the top bar whose width the user
   * controls, and it now shows the avatar alone at **every** viewport.
   *
   * On a phone that started as an overlap fix — a long name ran into the centred
   * brand. On a desktop it is a layout-shift fix, and the two things it removes
   * arrive separately: the display name when auth resolves, then the PRO badge a
   * beat later when the Stripe claim does. Measured at 1024px against a 123.4px
   * skeleton, a short name landed the chip at 104.4px, a short name with PRO at
   * 144px, and this 29-character name at 277.5px.
   *
   * Both halves are asserted on purpose. `sr-only` rather than `hidden` is what
   * keeps the name in the button's accessible name — a trigger announced as the
   * single letter "B" would be a worse bug than the shift, and an invisible one.
   */
  test('collapses the account chip to the avatar at every viewport, keeping the name for screen readers', async ({
    page,
  }) => {
    const longName = 'Bartholomew Featherstonehaugh';
    await openAuthMenu(page);
    await page.locator('#displayName').fill(longName);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(authMenu(page)).toContainText('Saved!');
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 390, height: 780 });

    // Derived from the DOM rather than hard-coded, and *exact* rather than a
    // bound: the collapsed chip has to be the avatar plus the button's own
    // padding and border and nothing else. A loose "less than 100" passed
    // happily against the version where the label region kept 8px of wrapper
    // margin — the chip was 50px where it should have been 42px, which reads as
    // slightly the wrong shape rather than as a bug. That 42px is also the width
    // the skeleton state collapses to, so this is what makes the sign-in
    // animation start from the same place a signed-in chip ends at.
    await expect
      .poll(() => chipWidthError(page.getByTestId('auth-menu-trigger'), 'phone'), {
        message: 'collapsed chip width against avatar + padding + border',
      })
      .toBeLessThanOrEqual(0.5);

    // Text content, not visibility — the point is that it is still there.
    await expect(page.getByTestId('auth-menu-trigger')).toContainText(longName);

    // The brand must not be run into by the chip. Both boxes are read in one
    // pass so a resize landing between two reads cannot produce a comparison
    // that was never true at any single moment.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const brand = document.querySelector('header a[href="/"]')!.getBoundingClientRect();
            const chip = document
              .querySelector('[data-cy="auth-menu-trigger"]')!
              .getBoundingClientRect();
            return brand.x + brand.width <= chip.x;
          }),
        { message: 'the brand ends before the chip begins' },
      )
      .toBe(true);

    // ...and the same at desktop width, which is the shift this change exists to
    // remove. The label region carrying zero width is the whole mechanism: there
    // is nothing rendered that could arrive late and resize the chip.
    await page.setViewportSize({ width: 1024, height: 780 });

    await expect
      .poll(() => labelRegion(page).evaluate((element) => element.getBoundingClientRect().width), {
        message: 'desktop label region',
      })
      .toBe(0);

    await expect
      .poll(() => chipWidthError(page.getByTestId('auth-menu-trigger'), 'desktop'), {
        message: 'desktop chip width against avatar + chevron + gap + padding + border',
      })
      .toBeLessThanOrEqual(0.5);

    // The name is still there for a screen reader at this width too — the
    // desktop chip used to be the one place it was visible, so this is the
    // assertion that stops it being dropped rather than hidden.
    await expect(page.getByTestId('auth-menu-trigger')).toContainText(longName);
  });

  test('signs out back to an anonymous session without flashing the verify-email prompt', async ({
    page,
  }) => {
    await openAuthMenu(page);

    // Sign-out briefly transitions through a signed-out `null` user before
    // re-anonymizing; a MutationObserver over the whole render (rather than a
    // point-in-time assertion) is what actually catches a flash that a
    // synchronous text check would step right over.
    await page.evaluate(() => {
      const state = { sawVerifyEmailFlash: false };
      const observer = new MutationObserver(() => {
        if (document.body.innerText.includes('Verify your email')) {
          state.sawVerifyEmailFlash = true;
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      (
        window as unknown as {
          __signOutObserver: { state: typeof state; observer: MutationObserver };
        }
      ).__signOutObserver = { state, observer };
    });

    await authMenu(page).getByRole('button', { name: 'Sign out', exact: true }).click();

    await expect(page.getByTestId('auth-menu-trigger')).toContainText('Sign in');

    // Disconnected as it is read, rather than left attached for the life of the
    // page: an observer with no teardown is the same leak `CLAUDE.md` §4.4 names,
    // and here it would go on running through every assertion after this one.
    const sawVerifyEmailFlash = await page.evaluate(() => {
      const { state, observer } = (
        window as unknown as {
          __signOutObserver: {
            state: { sawVerifyEmailFlash: boolean };
            observer: MutationObserver;
          };
        }
      ).__signOutObserver;
      observer.disconnect();
      return state.sawVerifyEmailFlash;
    });
    expect(sawVerifyEmailFlash, 'the verify-email prompt should never flash during sign-out').toBe(
      false,
    );
  });
});

/** The one box in the chip that is allowed to change size. */
function labelRegion(page: Page): Locator {
  return page.getByTestId('auth-menu-trigger').locator('span.overflow-hidden');
}

function measureLabelRegion(
  region: Locator,
): Promise<{ maxWidth: string; width: number; transitionsMaxWidth: boolean }> {
  return region.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      maxWidth: styles.maxWidth,
      width: element.getBoundingClientRect().width,
      transitionsMaxWidth: styles.transitionProperty.includes('max-width'),
    };
  });
}

/**
 * How far the chip's rendered width is from the sum of the boxes that are
 * allowed to contribute to it.
 *
 * A single difference rather than a pair of numbers, because `expect.poll`
 * reports the value it settled on: a failure reads as "3.4px wider than the
 * parts that should make it up", which is the number worth having. The parts
 * differ by viewport only in the chevron, which is `hidden sm:block`.
 */
function chipWidthError(chip: Locator, viewport: 'phone' | 'desktop'): Promise<number> {
  return chip.evaluate((element, which) => {
    const styles = getComputedStyle(element);
    const box = (value: string) => parseFloat(value);
    const avatar = element.querySelector('.h-7');
    if (!avatar) {
      throw new Error('the chip has no avatar box (.h-7) — has the top bar been restructured?');
    }
    let expected =
      avatar.getBoundingClientRect().width +
      box(styles.paddingLeft) +
      box(styles.paddingRight) +
      box(styles.borderLeftWidth) +
      box(styles.borderRightWidth);

    if (which === 'desktop') {
      const chevron = element.querySelector('app-icon');
      if (!chevron) {
        throw new Error('the chip has no chevron (app-icon) at desktop width');
      }
      expected += chevron.getBoundingClientRect().width + box(getComputedStyle(chevron).marginLeft);
    }

    return Math.abs(element.getBoundingClientRect().width - expected);
  }, viewport);
}
