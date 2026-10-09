import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AvatarChoice } from '../../models/avatar.model';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { AvatarSaveOutcome, AvatarService, AvatarStatus } from '../../services/avatar.service';
import { EmbedModeService } from '../../services/embed-mode.service';
import { AvatarPickerComponent, XpKnowledge } from './avatar-picker.component';

/**
 * The avatar picker on `/profile` (`FEAT-038`).
 *
 * jsdom has no layout and enforces neither `inert` nor `visibility`, so the
 * card's fixed height and the real keyboard walk are the e2e suite's
 * (`avatar-choice.spec.ts`). What is pinned here is which state the card
 * resolves to — the anonymous one above all, which must not be able to save
 * — what a save sends, and that the controls are `aria-disabled` rather than
 * `disabled` while it is in flight.
 */

interface FakeUser {
  uid: string;
  isAnonymous: boolean;
  displayName?: string;
}

interface Options {
  user?: FakeUser | null;
  authReady?: boolean;
  verified?: boolean;
  status?: AvatarStatus;
  choice?: AvatarChoice | null;
  photoUrl?: string | null;
  embedded?: boolean;
  /** What the page knows of the XP (`FEAT-041`); the input's own default when omitted. */
  xp?: XpKnowledge;
}

function render(options: Options = {}) {
  const user = signal<FakeUser | null>(
    options.user === undefined
      ? { uid: 'u1', isAnonymous: false, displayName: 'Ada' }
      : options.user,
  );
  const choice = signal<AvatarChoice | null>(
    options.choice === undefined ? { kind: 'initials', showPublicly: false } : options.choice,
  );
  const status = signal<AvatarStatus>(options.status ?? 'ready');
  let finishSave!: (outcome: AvatarSaveOutcome) => void;
  const save = vi.fn(
    (next: AvatarChoice) =>
      new Promise<AvatarSaveOutcome>((resolve) => {
        finishSave = (outcome) => {
          if (outcome === 'saved') {
            choice.set(next);
          }
          resolve(outcome);
        };
      }),
  );
  const retry = vi.fn();
  const open = vi.fn();

  TestBed.configureTestingModule({
    imports: [AvatarPickerComponent],
    providers: [
      {
        provide: AuthService,
        useValue: {
          user,
          authReady: signal(options.authReady ?? true),
          isFullyAuthenticated: () =>
            user() !== null && !user()!.isAnonymous && (options.verified ?? true),
        },
      },
      {
        provide: AvatarService,
        useValue: {
          status,
          choice,
          photoUrl: signal(options.photoUrl ?? null),
          save,
          retry,
        },
      },
      { provide: AuthMenuStateService, useValue: { open } },
      { provide: EmbedModeService, useValue: { isEmbedded: () => options.embedded ?? false } },
    ],
  });

  const fixture = TestBed.createComponent(AvatarPickerComponent);
  if (options.xp !== undefined) {
    fixture.componentRef.setInput('xp', options.xp);
  }
  const announced: string[] = [];
  fixture.componentInstance.announce.subscribe((text) => announced.push(text));
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(cy: string) =>
    host.querySelector<T>(`[data-cy="${cy}"]`);
  const visible = (cy: string) => {
    const element = q(cy);
    return element !== null && !element.classList.contains('invisible');
  };
  /** The one status line not hidden — there is always exactly one, or none while auth settles. */
  const line = () =>
    [...host.querySelectorAll('[data-cy="avatar-status"] > p')]
      .filter((p) => !p.classList.contains('invisible'))
      .map((p) => p.getAttribute('data-cy'));
  const settle = async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  return {
    fixture,
    host,
    q,
    visible,
    line,
    settle,
    save,
    retry,
    open,
    announced,
    finishSave: (outcome: AvatarSaveOutcome) => finishSave(outcome),
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('AvatarPickerComponent', () => {
  describe('the states that cannot save', () => {
    it('waits, with the picker hidden and inert, while auth settles', () => {
      const h = render({ authReady: false, user: null });

      expect(h.line()).toEqual(['avatar-loading']);
      expect(h.q('avatar-picker')!.hasAttribute('inert')).toBe(true);
      expect(h.visible('avatar-picker')).toBe(false);
      expect(h.visible('avatar-save')).toBe(false);
    });

    /**
     * **The anonymous state, which the spec asks for by name.** An anonymous
     * session has no `users/{uid}` and the callable refuses to make one, so the
     * card says why and offers the way out — and there is no control that
     * could start a save that would only be refused.
     */
    it('explains to an anonymous session why it cannot save, and cannot save', async () => {
      const h = render({ user: { uid: 'guest', isAnonymous: true }, status: 'none' });

      expect(h.line()).toEqual(['avatar-signed-out']);
      expect(h.q('avatar-signed-out')!.textContent).toContain(
        'A guest session has no account to keep one on.',
      );
      expect(h.q('avatar-picker')!.hasAttribute('inert')).toBe(true);
      expect(h.visible('avatar-save')).toBe(false);
      expect(h.visible('avatar-sign-in')).toBe(true);

      // Even driven directly, a save from here goes nowhere.
      h.q('avatar-save')!.click();
      await h.settle();
      expect(h.save).not.toHaveBeenCalled();

      h.q('avatar-sign-in')!.click();
      expect(h.open).toHaveBeenCalled();
    });

    it('treats nobody at all as signed out, never as an account', () => {
      const h = render({ user: null, status: 'none' });

      expect(h.line()).toEqual(['avatar-signed-out']);
    });

    it('drops the sign-in button in an embed, where there is no menu to open', () => {
      const h = render({ user: { uid: 'guest', isAnonymous: true }, embedded: true });

      expect(h.q('avatar-sign-in')).toBeNull();
      expect(h.line()).toEqual(['avatar-signed-out']);
    });

    /**
     * `setAvatar` refuses an unverified password account, the way
     * `isRealAuthedUser()` refuses it every other write about itself — so the
     * client says so up front rather than offering a form the server is bound
     * to refuse (`CLAUDE.md` §4.2).
     */
    it('asks an unverified account to verify first, and offers no save', () => {
      const h = render({ verified: false });

      expect(h.line()).toEqual(['avatar-unverified']);
      expect(h.q('avatar-picker')!.hasAttribute('inert')).toBe(true);
      expect(h.visible('avatar-save')).toBe(false);
    });

    it('says a failed read failed, and retries from the status line', () => {
      const h = render({ status: 'failed', choice: null });

      expect(h.line()).toEqual(['avatar-failed']);
      expect(h.visible('avatar-retry')).toBe(true);
      expect(h.visible('avatar-save')).toBe(false);

      h.q('avatar-retry')!.click();

      expect(h.retry).toHaveBeenCalled();
      expect(document.activeElement).toBe(h.q('avatar-status'));
    });

    it('waits while the stored choice is being read', () => {
      const h = render({ status: 'loading', choice: null });

      expect(h.line()).toEqual(['avatar-loading']);
      expect(h.q('avatar-picker')!.hasAttribute('inert')).toBe(true);
    });
  });

  describe('a signed-in account', () => {
    it('offers the picker, its groups each named — the kind, and two per set', () => {
      const h = render();

      expect(h.line()).toEqual(['avatar-idle']);
      expect(h.q('avatar-picker')!.hasAttribute('inert')).toBe(false);
      expect(h.visible('avatar-save')).toBe(true);

      const groups = [...h.host.querySelectorAll('[role="radiogroup"]')];
      expect(groups.map((group) => group.getAttribute('data-cy'))).toEqual([
        'avatar-kind',
        'avatar-set-core-shapes',
        'avatar-set-core-colours',
        'avatar-set-bold-shapes',
        'avatar-set-bold-colours',
      ]);
      const names = groups.map((group) =>
        group
          .getAttribute('aria-labelledby')!
          .split(' ')
          .map((id) => h.host.querySelector(`#${id}`)?.textContent?.trim())
          .join(' '),
      );
      expect(names).toEqual(['Show as', 'Core Shape', 'Core Colour', 'Bold Shape', 'Bold Colour']);
      for (const group of groups) {
        expect(group.querySelectorAll('input[type="radio"]').length).toBeGreaterThan(0);
      }
    });

    it('checks the stored choice', () => {
      const h = render({ choice: { kind: 'built', seed: 'core-35', showPublicly: true } });

      expect(h.q<HTMLInputElement>('avatar-kind-built')!.checked).toBe(true);
      expect(h.q<HTMLInputElement>('avatar-shape-square')!.checked).toBe(true);
      expect(h.q<HTMLInputElement>('avatar-colour-mint')!.checked).toBe(true);
      expect(h.q<HTMLInputElement>('avatar-public')!.checked).toBe(true);
    });

    /**
     * The photo is offered only to an account that has one on the host the CSP
     * admits — `AvatarService.photoUrl` is already narrowed to it.
     */
    it('offers the Google photo only to an account that has one', () => {
      expect(render({ photoUrl: null }).q('avatar-kind-photo')).toBeNull();
      TestBed.resetTestingModule();

      const h = render({ photoUrl: 'https://lh3.googleusercontent.com/a/x' });
      expect(h.q('avatar-kind-photo')).not.toBeNull();
      expect(h.q('avatar-kind-photo')!.closest('label')!.textContent).toContain('Google photo');
    });

    /**
     * Three cells at every width, whatever the account has — so a photo
     * arriving with auth cannot add a tile, wrap the row and grow the card
     * (`CLAUDE.md` §4.4). An account with no photo keeps the photo's cell,
     * invisible and empty of anything focusable; `avatar-choice.spec.ts`
     * measures the card in a browser.
     */
    it('keeps the photo tile’s cell, invisible and inert, for an account with no photo', () => {
      const h = render({ photoUrl: null });

      const group = h.q('avatar-kind')!;
      expect(group.className).toContain('grid-cols-3');
      expect(group.children).toHaveLength(3);
      const reserved = h.q('avatar-kind-photo-reserved')!;
      expect(reserved.classList.contains('invisible')).toBe(true);
      expect(reserved.getAttribute('aria-hidden')).toBe('true');
      expect(reserved.querySelector('input, button, a, [tabindex]')).toBeNull();
      expect(reserved.querySelector('img')).toBeNull();
    });

    it('fills the same cell with the photo tile for an account that has one', () => {
      const h = render({ photoUrl: 'https://lh3.googleusercontent.com/a/x' });

      expect(h.q('avatar-kind')!.children).toHaveLength(3);
      expect(h.q('avatar-kind-photo-reserved')).toBeNull();
      expect(h.q('avatar-kind-photo')).not.toBeNull();
    });

    it('shows initials as chosen when a stored photo has no photo to show', () => {
      const h = render({ choice: { kind: 'photo', showPublicly: false }, photoUrl: null });

      expect(h.q<HTMLInputElement>('avatar-kind-initials')!.checked).toBe(true);
    });

    /**
     * With another kind chosen no shape is checked, so the shape that reads as
     * the default is a radio a click can still change — picking it builds one.
     */
    it('shows no shape or colour as chosen until building, and builds from any of them', async () => {
      const h = render({ choice: { kind: 'initials', showPublicly: false } });

      const checked = (group: string) =>
        [...h.host.querySelectorAll<HTMLInputElement>(`[data-cy="${group}"] input`)].filter(
          (input) => input.checked,
        );
      expect(checked('avatar-set-core-shapes')).toHaveLength(0);
      expect(checked('avatar-set-core-colours')).toHaveLength(0);

      h.q('avatar-shape-dot')!.click();
      await h.settle();

      expect(h.q<HTMLInputElement>('avatar-kind-built')!.checked).toBe(true);
      expect(h.q<HTMLInputElement>('avatar-shape-dot')!.checked).toBe(true);
      expect(h.q<HTMLInputElement>('avatar-colour-emerald')!.checked).toBe(true);
    });

    it('builds an avatar when a shape or a colour is picked', async () => {
      const h = render();

      h.q('avatar-shape-ring')!.click();
      await h.settle();
      expect(h.q<HTMLInputElement>('avatar-kind-built')!.checked).toBe(true);

      h.q('avatar-colour-gold')!.click();
      await h.settle();

      h.q('avatar-save')!.click();
      await h.settle();
      expect(h.save).toHaveBeenCalledWith({ kind: 'built', seed: 'core-12', showPublicly: false });
    });

    it('sends no seed for a kind that is not built', async () => {
      const h = render({ choice: { kind: 'built', seed: 'core-35', showPublicly: false } });

      h.q('avatar-kind-initials')!.click();
      await h.settle();
      h.q('avatar-save')!.click();
      await h.settle();

      expect(h.save).toHaveBeenCalledWith({ kind: 'initials', showPublicly: false });
    });

    it('starts with the public switch off, and sends it when it is turned on', async () => {
      const h = render({ choice: null, status: 'ready' });
      expect(h.q<HTMLInputElement>('avatar-public')!.checked).toBe(false);

      h.q('avatar-public')!.click();
      await h.settle();
      h.q('avatar-save')!.click();
      await h.settle();

      expect(h.save).toHaveBeenCalledWith({ kind: 'initials', showPublicly: true });
    });

    it('names the public switch honestly, without promising a feature', () => {
      const h = render();

      expect(h.host.querySelector('label[for="avatar-public"]')!.textContent).toContain(
        'Show my avatar to other players',
      );
      expect(h.host.querySelector('#avatar-public-help')!.textContent).toContain(
        'Nothing in the app shows avatars to other players yet; this decides what happens when something does.',
      );
    });
  });

  describe('a save in flight', () => {
    /**
     * `aria-disabled`, never `disabled`: the `disabled` attribute would throw
     * focus off the button the reader just pressed and onto `<body>`.
     */
    it('marks every control aria-disabled, and disables none of them', async () => {
      const h = render();
      const saveButton = h.q<HTMLButtonElement>('avatar-save')!;
      saveButton.focus();

      saveButton.click();
      await h.settle();

      expect(h.line()).toEqual(['avatar-saving']);
      const controls = [...h.host.querySelectorAll<HTMLElement>('input, [data-cy="avatar-save"]')];
      expect(controls.length).toBeGreaterThan(10);
      for (const control of controls) {
        expect(control.getAttribute('aria-disabled')).toBe('true');
        expect(control.hasAttribute('disabled')).toBe(false);
      }
      expect(document.activeElement).toBe(saveButton);
    });

    /**
     * A click on another kind during the save is cancelled, so the draft does
     * not move under it. That the group then still *shows* the old choice is
     * the browser restoring it on a cancelled click — jsdom does not model
     * that half, so `avatar-choice.spec.ts` asserts it in Chromium; what is
     * asserted here is that the click selected nothing and changed nothing.
     */
    it('holds the choice still and ignores a second save until the first answers', async () => {
      const h = render();
      h.q('avatar-save')!.click();
      await h.settle();

      h.q('avatar-kind-built')!.click();
      await h.settle();
      expect(h.q<HTMLInputElement>('avatar-kind-built')!.checked).toBe(false);

      h.q('avatar-save')!.click();
      await h.settle();
      expect(h.save).toHaveBeenCalledTimes(1);

      h.finishSave('saved');
      await h.settle();
      expect(h.q('avatar-save')!.hasAttribute('aria-disabled')).toBe(false);

      // The draft never moved, so the next save sends what the first did.
      h.q('avatar-save')!.click();
      await h.settle();
      expect(h.save).toHaveBeenLastCalledWith({ kind: 'initials', showPublicly: false });
    });

    /**
     * Through the page's live region (`ProfileStatsComponent`): empty when the
     * save starts, so that a second "saved" is still a change the region
     * announces, then the outcome.
     */
    it('announces the outcome, clearing the region first', async () => {
      const h = render();
      h.q('avatar-save')!.click();
      await h.settle();
      expect(h.announced).toEqual(['']);

      h.finishSave('saved');
      await h.settle();

      expect(h.announced).toEqual(['', 'Avatar saved.']);
      expect(h.line()).toEqual(['avatar-saved']);
    });

    it('says a failed save failed, and a preview channel’s save cannot happen there', async () => {
      const h = render();
      h.q('avatar-save')!.click();
      await h.settle();
      h.finishSave('failed');
      await h.settle();
      expect(h.line()).toEqual(['avatar-save-failed']);
      expect(h.announced.at(-1)).toBe('Could not save your avatar.');

      h.q('avatar-save')!.click();
      await h.settle();
      h.finishSave('unavailable');
      await h.settle();
      expect(h.line()).toEqual(['avatar-unavailable']);
    });

    it('says a timed-out save could not be confirmed, not that it was not saved', async () => {
      const h = render();
      h.q('avatar-save')!.click();
      await h.settle();
      h.finishSave('unconfirmed');
      await h.settle();

      expect(h.line()).toEqual(['avatar-unconfirmed']);
      expect(h.q('avatar-unconfirmed')!.textContent).toContain('could not be confirmed');
      expect(h.announced.at(-1)).toBe('Your avatar could not be confirmed as saved.');
    });

    it('clears a finished save’s message once the choice is edited again', async () => {
      const h = render();
      h.q('avatar-save')!.click();
      await h.settle();
      h.finishSave('saved');
      await h.settle();

      h.q('avatar-shape-ring')!.click();
      await h.settle();

      expect(h.line()).toEqual(['avatar-idle']);
    });
  });

  /**
   * `FEAT-041`: the `bold` set opens at level 3 (600 XP). A locked set is
   * shown locked, never hidden — every tile on the page, `aria-disabled`,
   * described by the line that names the level — and cannot be chosen by
   * pointer or keyboard. jsdom cannot measure, so that the card is one height
   * locked or not is `xp-and-levels.spec.ts`'s, in Chromium; what is pinned
   * here is that the two states are the same markup.
   */
  describe('a set the player has not unlocked', () => {
    const LOCKED: XpKnowledge = { state: 'known', xp: 120 };
    const OPEN: XpKnowledge = { state: 'known', xp: 640 };
    const boldTiles = (h: ReturnType<typeof render>) => [
      ...h.host.querySelectorAll<HTMLInputElement>(
        '[data-cy="avatar-set-bold-shapes"] input, [data-cy="avatar-set-bold-colours"] input',
      ),
    ];
    const statusLine = (h: ReturnType<typeof render>, set: string) =>
      [...h.host.querySelectorAll(`[data-cy="avatar-set-${set}-status"] > p`)]
        .filter((p) => !p.classList.contains('invisible'))
        .map((p) => p.textContent?.trim());

    it('renders every tile of the locked set, aria-disabled and described by its level', () => {
      const h = render({ xp: LOCKED });

      const tiles = boldTiles(h);
      expect(tiles).toHaveLength(12);
      for (const tile of tiles) {
        expect(tile.getAttribute('aria-disabled')).toBe('true');
        expect(tile.hasAttribute('disabled')).toBe(false);
        expect(tile.getAttribute('aria-describedby')).toBe('avatar-set-bold-status');
        expect(tile.closest('label')!.classList.contains('opacity-50')).toBe(true);
      }
      expect(statusLine(h, 'bold')).toEqual(['Unlocks at level 3']);
      // The set every level has stays open, and says nothing about levels.
      expect(h.q('avatar-shape-dot')!.hasAttribute('aria-disabled')).toBe(false);
      expect(h.q('avatar-set-core-status')).toBeNull();
    });

    it('treats an XP the page could not read as locked', () => {
      const h = render({ xp: { state: 'unknown' } });

      expect(boldTiles(h).every((tile) => tile.getAttribute('aria-disabled') === 'true')).toBe(
        true,
      );
      expect(statusLine(h, 'bold')).toEqual(['Unlocks at level 3']);
    });

    /** While the XP is read, neither answer is guessed: the tiles hold still and say so. */
    it('says it is checking while the XP is still being read', () => {
      const h = render({ xp: { state: 'checking' } });

      expect(statusLine(h, 'bold')).toEqual(['Checking your level…']);
      expect(boldTiles(h).every((tile) => tile.getAttribute('aria-disabled') === 'true')).toBe(
        true,
      );
    });

    it('cannot be chosen by a click, and the save sends what it sent before', async () => {
      const h = render({ xp: LOCKED });

      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      h.q('avatar-shape-star')!.dispatchEvent(click);
      h.q('avatar-shape-star')!.dispatchEvent(new Event('change'));
      await h.settle();

      expect(click.defaultPrevented).toBe(true);
      expect(h.q<HTMLInputElement>('avatar-kind-initials')!.checked).toBe(true);
      h.q('avatar-save')!.click();
      await h.settle();
      expect(h.save).toHaveBeenCalledWith({ kind: 'initials', showPublicly: false });
    });

    it('holds the arrow keys and Space on a locked tile, and nothing else', () => {
      const h = render({ xp: LOCKED });

      for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', ' ']) {
        const press = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        h.q('avatar-colour-ruby')!.dispatchEvent(press);
        expect(press.defaultPrevented, key).toBe(true);
      }
      // Tab still moves on, past the set and out of it.
      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      h.q('avatar-colour-ruby')!.dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(false);
    });

    it('opens at level 3: the tiles enabled, and a bold avatar built and sent', async () => {
      const h = render({ xp: OPEN });

      expect(boldTiles(h).some((tile) => tile.hasAttribute('aria-disabled'))).toBe(false);
      expect(statusLine(h, 'bold')).toEqual(['Unlocked at level 3']);

      h.q('avatar-shape-crown')!.click();
      await h.settle();
      expect(h.q<HTMLInputElement>('avatar-kind-built')!.checked).toBe(true);
      expect(h.q<HTMLInputElement>('avatar-shape-crown')!.checked).toBe(true);
      // The set's first colour, which is what the crown tile was drawn in.
      expect(h.q<HTMLInputElement>('avatar-colour-ruby')!.checked).toBe(true);

      h.q('avatar-colour-honey')!.click();
      await h.settle();
      h.q('avatar-save')!.click();
      await h.settle();

      expect(h.save).toHaveBeenCalledWith({ kind: 'built', seed: 'bold-33', showPublicly: false });
    });

    /**
     * One variant at a time: moving to the other set checks nothing in the set
     * left behind, so neither block claims a choice it does not hold.
     */
    it('checks tiles in one set at a time', async () => {
      const h = render({
        xp: OPEN,
        choice: { kind: 'built', seed: 'core-35', showPublicly: false },
      });

      h.q('avatar-shape-heart')!.click();
      await h.settle();

      const checkedIn = (group: string) =>
        [...h.host.querySelectorAll<HTMLInputElement>(`[data-cy="${group}"] input`)]
          .filter((input) => input.checked)
          .map((input) => input.value);
      expect(checkedIn('avatar-set-core-shapes')).toEqual([]);
      expect(checkedIn('avatar-set-core-colours')).toEqual([]);
      expect(checkedIn('avatar-set-bold-shapes')).toEqual(['heart']);
      expect(checkedIn('avatar-set-bold-colours')).toEqual(['ruby']);
    });

    /**
     * **Never re-lock what was granted.** A bold avatar stored before a
     * threshold moved stays checked, and saving again sends it — `setAvatar`
     * accepts the seed already stored — while the rest of the set stays shut.
     */
    it('keeps a stored seed from a locked set checked, and saves it again', async () => {
      const h = render({
        xp: LOCKED,
        choice: { kind: 'built', seed: 'bold-21', showPublicly: false },
      });

      expect(h.q<HTMLInputElement>('avatar-kind-built')!.checked).toBe(true);
      expect(h.q<HTMLInputElement>('avatar-shape-heart')!.checked).toBe(true);
      expect(h.q<HTMLInputElement>('avatar-colour-amber')!.checked).toBe(true);
      expect(h.q('avatar-shape-moon')!.getAttribute('aria-disabled')).toBe('true');

      h.q('avatar-public')!.click();
      await h.settle();
      h.q('avatar-save')!.click();
      await h.settle();

      expect(h.save).toHaveBeenCalledWith({ kind: 'built', seed: 'bold-21', showPublicly: true });
    });

    /**
     * The same block either way, so the same height: every sentence of the
     * status line is in its one grid cell whatever the state, and only which
     * one is visible changes.
     */
    it('draws a locked set with exactly the markup of an open one', () => {
      const shape = (xp: XpKnowledge) => {
        const block = render({ xp }).q('avatar-set-bold')!;
        const outline = [...block.querySelectorAll('*')].map((node) => node.tagName).join(',');
        TestBed.resetTestingModule();
        return outline;
      };

      expect(shape(LOCKED)).toBe(shape(OPEN));
      expect(shape({ state: 'checking' })).toBe(shape(OPEN));
    });
  });
});
