import { TestBed } from '@angular/core/testing';
import { ProgressCardComponent, ProgressState } from './progress-card.component';

/**
 * The progress card on `/profile` (`FEAT-041`). It renders what the page hands
 * it, so what is pinned is each state's content — the signed-out one first,
 * because it is what most visitors see — the progress bar's accessible value,
 * and that every state is the same markup, which is what keeps the card one
 * height. jsdom has no layout, so the height itself is measured in Chromium by
 * `xp-and-levels.spec.ts`.
 */

interface Inputs {
  state: ProgressState;
  xp?: number | null;
  levelUp?: number | null;
  letter?: string | null;
}

function render(inputs: Inputs) {
  TestBed.configureTestingModule({ imports: [ProgressCardComponent] });
  const fixture = TestBed.createComponent(ProgressCardComponent);
  fixture.componentRef.setInput('state', inputs.state);
  fixture.componentRef.setInput('xp', inputs.xp ?? null);
  fixture.componentRef.setInput('levelUp', inputs.levelUp ?? null);
  fixture.componentRef.setInput('letter', inputs.letter ?? null);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const q = (cy: string) => host.querySelector<HTMLElement>(`[data-cy="${cy}"]`);
  const text = (cy: string) => q(cy)?.textContent?.replace(/\s+/g, ' ').trim();
  /** The status sentences not hidden — exactly one in every state. */
  const line = () =>
    [...host.querySelectorAll('[data-cy="progress-status"] > p')]
      .filter((p) => !p.classList.contains('invisible'))
      .map((p) => p.getAttribute('data-cy'));
  /** The unlock row's sentences not hidden — exactly one in every state. */
  const unlockLine = () =>
    [...host.querySelectorAll('[data-cy="progress-unlock"] p[data-cy]')]
      .filter((p) => !p.classList.contains('invisible'))
      .map((p) => p.getAttribute('data-cy'));
  const lockShown = () => !q('progress-unlock-lock')!.classList.contains('invisible');
  return { fixture, host, q, text, line, unlockLine, lockShown };
}

afterEach(() => TestBed.resetTestingModule());

describe('ProgressCardComponent', () => {
  describe('with no number to show', () => {
    /**
     * Designed first: a guest has no `users/{uid}` and never will, so the card
     * explains how XP is earned rather than showing a zero that would read as
     * a total — and draws the neutral face where a signed-in player's preview
     * would be.
     */
    it('explains itself to a visitor who is not signed in', () => {
      const h = render({ state: 'signedOut' });

      expect(h.line()).toEqual(['progress-signed-out']);
      expect(h.text('progress-signed-out')).toBe(
        'Sign in to earn experience points (XP) from the games you finish. Guest games earn none.',
      );
      expect(h.text('progress-level')).toBe('—');
      expect(h.text('progress-xp')).toBe('— XP');
      expect(h.text('progress-next')).toBe('—');
      expect(h.q('progress-unlock-preview')!.getAttribute('data-avatar')).toBe('guest');
      // What the next unlock is — and a guest, who earns no XP, does not have it.
      expect(h.text('progress-unlock')).toContain('Bold avatars');
      expect(h.unlockLine()).toEqual(['progress-unlock-locked']);
      expect(h.lockShown()).toBe(true);
    });

    /**
     * With no value the bar is an empty track hidden from assistive tech: the
     * sentence above it says why there is no number, and an indeterminate
     * progress bar would announce a wait that is not happening.
     */
    it('draws the bar as an empty track, with no progressbar role', () => {
      for (const state of ['signedOut', 'loading', 'failed'] as const) {
        const h = render({ state, xp: 640 });
        const bar = h.q('progress-bar')!;
        expect(bar.getAttribute('role'), state).toBeNull();
        expect(bar.getAttribute('aria-hidden'), state).toBe('true');
        expect(bar.hasAttribute('aria-valuenow'), state).toBe(false);
        expect(bar.hasAttribute('aria-label'), state).toBe(false);
        expect((bar.firstElementChild as HTMLElement).style.width, state).toBe('0%');
        TestBed.resetTestingModule();
      }
    });

    /**
     * The reader may be level 40: until the read answers, the unlock row says
     * the level the set opens at and nothing about whether it is theirs — no
     * "unlock at", and no lock (`CLAUDE.md` §4.4).
     */
    it('waits while the read is in flight, showing no number and guessing no lock', () => {
      const h = render({ state: 'loading', letter: 'A' });

      expect(h.line()).toEqual(['progress-loading']);
      expect(h.text('progress-level')).toBe('—');
      // The signed-in player's preview is drawn already: its box is the same.
      expect(h.q('progress-unlock-preview')!.getAttribute('data-avatar')).toBe('built');
      expect(h.unlockLine()).toEqual(['progress-unlock-opens']);
      expect(h.text('progress-unlock-opens')).toBe('Opens at level 3');
      expect(h.lockShown()).toBe(false);
    });

    it('says a failed read failed, shows no number, and guesses no lock', () => {
      const h = render({ state: 'failed', xp: null, letter: 'A' });

      expect(h.line()).toEqual(['progress-failed']);
      expect(h.text('progress-xp')).toBe('— XP');
      expect(h.unlockLine()).toEqual(['progress-unlock-opens']);
      expect(h.lockShown()).toBe(false);
    });
  });

  describe('with an XP total', () => {
    it('shows level 0 and the first hundred XP for an account with nothing banked', () => {
      const h = render({ state: 'ready', xp: 0, letter: 'A' });

      expect(h.line()).toEqual(['progress-ready']);
      expect(h.text('progress-level')).toBe('0');
      expect(h.text('progress-xp')).toBe('0 XP');
      expect(h.text('progress-next')).toBe('100 XP to level 1');
    });

    it('fills the bar to the share of this level earned, with the value on the bar', () => {
      const h = render({ state: 'ready', xp: 340 });

      expect(h.text('progress-level')).toBe('2');
      expect(h.text('progress-xp')).toBe('340 XP');
      expect(h.text('progress-next')).toBe('260 XP to level 3');
      const bar = h.q('progress-bar')!;
      expect(bar.getAttribute('role')).toBe('progressbar');
      expect(bar.getAttribute('aria-label')).toBe('Progress to the next level');
      expect(bar.getAttribute('aria-valuemin')).toBe('0');
      expect(bar.getAttribute('aria-valuemax')).toBe('300');
      expect(bar.getAttribute('aria-valuenow')).toBe('40');
      expect(bar.getAttribute('aria-valuetext')).toBe('40 of 300 XP towards level 3');
      expect(bar.hasAttribute('aria-hidden')).toBe(false);
      expect(parseFloat((bar.firstElementChild as HTMLElement).style.width)).toBeCloseTo(13.33, 1);
    });

    it('names the next unlock and the level it opens at', () => {
      const h = render({ state: 'ready', xp: 340, letter: 'A' });

      expect(h.text('progress-unlock')).toContain('Bold avatars');
      expect(h.text('progress-unlock-locked')).toBe('Unlock at level 3');
      expect(h.unlockLine()).toEqual(['progress-unlock-locked']);
      expect(h.lockShown()).toBe(true);
    });

    it('says the set is the player’s once its level is reached', () => {
      const h = render({ state: 'ready', xp: 650, letter: 'A' });

      expect(h.text('progress-level')).toBe('3');
      expect(h.text('progress-next')).toBe('350 XP to level 4');
      expect(h.text('progress-unlock')).toContain('Bold avatars');
      expect(h.unlockLine()).toEqual(['progress-unlock-unlocked']);
      expect(h.lockShown()).toBe(false);
    });

    it('formats large totals in the reader’s own locale', () => {
      const h = render({ state: 'ready', xp: 12_345 });

      expect(h.text('progress-xp')).toBe(`${new Intl.NumberFormat().format(12_345)} XP`);
    });

    it('says when the last game crossed a level, in place of the explanation', () => {
      const h = render({ state: 'ready', xp: 650, levelUp: 3 });

      expect(h.line()).toEqual(['progress-level-up']);
      expect(h.text('progress-level-up')).toBe('Your last game took you to level 3.');
    });
  });

  /**
   * **One height in every state, by construction.** Every state renders the
   * same elements — the sentences stacked in one cell, the boxes filled or
   * holding an em-dash — so nothing can appear or disappear as the read lands.
   * The avatar is compared as its host alone: what it draws inside differs
   * (the neutral face, or a built avatar over an initial), and its box is
   * `AvatarComponent`'s to keep, which its own spec pins.
   */
  it('renders the same elements in every state', () => {
    const outline = (inputs: Inputs) => {
      const h = render(inputs);
      const tags = [...h.host.querySelectorAll('*')]
        .filter((node) => !node.parentElement?.closest('app-avatar'))
        .map((node) => node.tagName)
        .join(',');
      TestBed.resetTestingModule();
      return tags;
    };

    const signedOut = outline({ state: 'signedOut' });
    expect(outline({ state: 'loading', letter: 'A' })).toBe(signedOut);
    expect(outline({ state: 'failed', letter: 'A' })).toBe(signedOut);
    expect(outline({ state: 'ready', xp: 0, letter: 'A' })).toBe(signedOut);
    expect(outline({ state: 'ready', xp: 650, letter: 'A', levelUp: 3 })).toBe(signedOut);
  });
});
