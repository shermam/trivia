import { TestBed } from '@angular/core/testing';
import { AvatarChoice } from '../../models/avatar.model';
import { AvatarComponent, AvatarSize } from './avatar.component';

/**
 * The one avatar component (`FEAT-038`). jsdom has no layout, so the box is
 * pinned by its classes here and measured in a real browser by
 * `e2e/specs/authenticated/avatar-choice.spec.ts`; what this spec owns is the
 * fallback chain — which state is drawn when, and what is never drawn.
 */

const PHOTO = 'https://lh3.googleusercontent.com/a/ada=s96-c';

interface Inputs {
  size?: AvatarSize;
  letter?: string | null;
  choice?: AvatarChoice | null;
  photoUrl?: string | null;
  eager?: boolean;
}

function render(inputs: Inputs = {}) {
  TestBed.configureTestingModule({ imports: [AvatarComponent] });
  const fixture = TestBed.createComponent(AvatarComponent);
  const set = (next: Inputs) => {
    for (const [key, value] of Object.entries(next)) {
      fixture.componentRef.setInput(key, value);
    }
    fixture.detectChanges();
  };
  set({ letter: 'A', ...inputs });
  const host = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    host,
    set,
    shown: () => host.getAttribute('data-avatar'),
    letter: () => host.querySelector('span') as HTMLElement,
    image: () => host.querySelector('img'),
    svg: () => host.querySelector('svg'),
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('AvatarComponent', () => {
  it('draws the initial when there is no choice yet', () => {
    const h = render({ choice: null });

    expect(h.shown()).toBe('initials');
    expect(h.letter().textContent?.trim()).toBe('A');
    expect(h.letter().classList.contains('invisible')).toBe(false);
    expect(h.image()).toBeNull();
    expect(h.svg()).toBeNull();
  });

  it('draws the neutral face for nobody, whatever the choice says', () => {
    const h = render({
      letter: null,
      choice: { kind: 'built', seed: 'core-35', showPublicly: false },
    });

    expect(h.shown()).toBe('guest');
    expect(h.svg()).toBeNull();
    expect(h.host.classList.contains('bg-slate-200')).toBe(true);
  });

  describe('a photo', () => {
    /**
     * Initials inside the box until the image has loaded: the image is laid
     * over the letter and kept invisible, so a slow photo never shows an empty
     * or half-drawn frame.
     */
    it('keeps the initial showing until the image has loaded', () => {
      const h = render({ choice: { kind: 'photo', showPublicly: false }, photoUrl: PHOTO });

      expect(h.image()?.getAttribute('src')).toBe(PHOTO);
      expect(h.image()?.classList.contains('invisible')).toBe(true);
      expect(h.letter().classList.contains('invisible')).toBe(false);
      expect(h.shown()).toBe('initials');

      h.image()!.dispatchEvent(new Event('load'));
      h.fixture.detectChanges();

      expect(h.image()?.classList.contains('invisible')).toBe(false);
      expect(h.letter().classList.contains('invisible')).toBe(true);
      expect(h.shown()).toBe('photo');
    });

    /**
     * **The test the spec names.** A revoked, rate-limited or offline photo
     * falls back to initials silently, and the image element goes with it — so
     * there is no broken-image icon and no alt text to render in its place.
     */
    it('falls back to the initial when the image fails, leaving no broken image behind', () => {
      const h = render({ choice: { kind: 'photo', showPublicly: false }, photoUrl: PHOTO });

      h.image()!.dispatchEvent(new Event('error'));
      h.fixture.detectChanges();

      expect(h.image()).toBeNull();
      expect(h.letter().classList.contains('invisible')).toBe(false);
      expect(h.letter().textContent?.trim()).toBe('A');
      expect(h.shown()).toBe('initials');
    });

    it('does not ask again for a photo that failed, but does for a new one', () => {
      const h = render({ choice: { kind: 'photo', showPublicly: false }, photoUrl: PHOTO });
      h.image()!.dispatchEvent(new Event('error'));
      h.fixture.detectChanges();

      // Re-rendering with the same address does not bring the request back.
      h.set({ choice: { kind: 'photo', showPublicly: true } });
      expect(h.image()).toBeNull();

      const next = 'https://lh3.googleusercontent.com/a/new=s96-c';
      h.set({ photoUrl: next });
      expect(h.image()?.getAttribute('src')).toBe(next);
    });

    it('draws initials for a photo choice with no photo to show', () => {
      const h = render({ choice: { kind: 'photo', showPublicly: false }, photoUrl: null });

      expect(h.image()).toBeNull();
      expect(h.shown()).toBe('initials');
    });

    it('sends no referrer and names no alternative text', () => {
      const h = render({ choice: { kind: 'photo', showPublicly: false }, photoUrl: PHOTO });

      expect(h.image()?.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(h.image()?.getAttribute('alt')).toBe('');
      expect(h.host.getAttribute('aria-hidden')).toBe('true');
    });

    it('loads lazily unless told it is the account chip', () => {
      const lazy = render({ choice: { kind: 'photo', showPublicly: false }, photoUrl: PHOTO });
      expect(lazy.image()?.getAttribute('loading')).toBe('lazy');
      TestBed.resetTestingModule();

      const eager = render({
        choice: { kind: 'photo', showPublicly: false },
        photoUrl: PHOTO,
        eager: true,
      });
      expect(eager.image()?.getAttribute('loading')).toBe('eager');
    });
  });

  describe('a built avatar', () => {
    it('draws the variant its seed names, over the initial', () => {
      const h = render({ choice: { kind: 'built', seed: 'core-35', showPublicly: false } });

      expect(h.shown()).toBe('built');
      const circle = h.svg()!.querySelector('circle')!;
      const path = h.svg()!.querySelector('path')!;
      // `core-35`: the fourth shape (a square) on the sixth colour (mint).
      expect(path.getAttribute('d')).toBe('M10 10h12v12H10z');
      expect(circle.getAttribute('fill')).toBe('#d1fae5');
      expect(path.getAttribute('fill')).toBe('#065f46');
      expect(h.letter().classList.contains('invisible')).toBe(true);
    });

    it('fills a shape with a hole even-odd, and every other shape plainly', () => {
      const ring = render({ choice: { kind: 'built', seed: 'core-10', showPublicly: false } });
      expect(ring.svg()!.querySelector('path')!.getAttribute('fill-rule')).toBe('evenodd');
      TestBed.resetTestingModule();

      const dot = render({ choice: { kind: 'built', seed: 'core-00', showPublicly: false } });
      expect(dot.svg()!.querySelector('path')!.hasAttribute('fill-rule')).toBe(false);
    });

    /**
     * The CSP refuses a `style` attribute and leaves it in the DOM with its
     * declarations dropped — which is how the brand mark once shipped a fill
     * that never applied (`CLAUDE.md` §4.4). Every colour here is a
     * presentation attribute, so this asserts there is no `style` anywhere.
     */
    it('carries no style attribute anywhere in the drawing', () => {
      for (const seed of ['core-00', 'core-15', 'core-35', 'core-52']) {
        const h = render({ choice: { kind: 'built', seed, showPublicly: false } });
        expect(h.host.querySelectorAll('[style]')).toHaveLength(0);
        expect(h.host.hasAttribute('style')).toBe(false);
        TestBed.resetTestingModule();
      }
    });

    it('draws initials for a seed this build cannot draw', () => {
      const h = render({ choice: { kind: 'built', seed: 'gems-00', showPublicly: false } });

      expect(h.svg()).toBeNull();
      expect(h.shown()).toBe('initials');
    });
  });

  /**
   * The box comes from `size` alone and is the same set of classes whatever is
   * drawn in it, which is what makes "the chip never changes size" true by
   * construction. The pixels are measured by the e2e suite.
   */
  it('is the same box in every state', () => {
    const boxOf = (inputs: Inputs) => {
      const h = render(inputs);
      const classes = [...h.host.classList].filter((name) => /^(h|w)-/.test(name)).sort();
      TestBed.resetTestingModule();
      return classes;
    };

    const initials = boxOf({ choice: null });
    expect(initials).toEqual(['h-7', 'w-7']);
    expect(boxOf({ choice: { kind: 'built', seed: 'core-21', showPublicly: false } })).toEqual(
      initials,
    );
    expect(boxOf({ choice: { kind: 'photo', showPublicly: false }, photoUrl: PHOTO })).toEqual(
      initials,
    );
    expect(boxOf({ letter: null })).toEqual(initials);
    expect(boxOf({ size: 'lg', choice: null })).toEqual(['h-12', 'w-12']);
  });
});
