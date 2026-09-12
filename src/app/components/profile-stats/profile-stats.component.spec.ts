import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { EmbedModeService } from '../../services/embed-mode.service';
import { FirebaseService, GameplayStats } from '../../services/firebase.service';
import { ProfileStatsComponent } from './profile-stats.component';

/**
 * `/profile` renders numbers it did not compute and cannot check, so what is
 * worth testing here is everything *around* them: which of the five states the
 * screen resolves to, and in particular that the two states nobody asks for —
 * "auth has not answered yet" and "the read failed" — resolve to the least
 * alarming thing rather than to the most specific one (`CLAUDE.md` §4.4).
 *
 * The formatting is covered too, for one reason: `correctAnswers /
 * questionsAnswered` is a division by a number that is legitimately zero, and
 * `NaN%` on a player's own profile is the kind of defect that reaches a real
 * person before it reaches a test.
 */

type ProfileView = 'loading' | 'signedOut' | 'empty' | 'stats' | 'failed';

/** The template-facing members are `protected`; the spec drives them directly. */
interface InternalProfileStats {
  view(): ProfileView;
  tiles(): { id: string; label: string; value: string }[];
  trackingSince(): string | null;
  statusAnnouncement(): string;
  retry(): void;
  openSignIn(): void;
}

interface FakeUser {
  uid: string;
  isAnonymous: boolean;
}

function stats(overrides: Partial<GameplayStats> = {}): GameplayStats {
  return {
    gamesPlayed: 3,
    questionsAnswered: 25,
    correctAnswers: 20,
    bestStreak: 7,
    statsSince: Date.UTC(2026, 0, 15),
    ...overrides,
  };
}

interface SetupOptions {
  user?: FakeUser | null;
  authReady?: boolean;
  result?: GameplayStats | null;
  fails?: boolean;
  embedded?: boolean;
}

/**
 * Providers only — no component. `setup()` below drives an instance built by
 * hand, and `render()` at the bottom needs the same doubles behind a real
 * fixture; creating a component here would give the rendered tests a second
 * instance and let them assert against the one they are not driving.
 */
function configure(options: SetupOptions = {}) {
  const { user = { uid: 'u1', isAnonymous: false }, authReady = true } = options;

  const userSignal = signal<FakeUser | null>(user);
  const authReadySignal = signal(authReady);
  // `'result' in options` rather than `?? stats()`: `null` is a meaningful
  // value here — it is the answer for an account that has never finished a
  // game — and a nullish default would silently turn that case into the
  // populated one.
  const result = 'result' in options ? options.result : stats();
  const getGameplayStats = vi.fn(() =>
    options.fails ? Promise.reject(new Error('refused')) : Promise.resolve(result),
  );
  const open = vi.fn();

  TestBed.configureTestingModule({
    providers: [
      // The template's two `routerLink`s need an `ActivatedRoute`; nothing here
      // navigates, so the route table is empty.
      provideRouter([]),
      { provide: FirebaseService, useValue: { getGameplayStats } },
      {
        provide: AuthService,
        useValue: {
          user: userSignal,
          authReady: authReadySignal,
          isAnonymous: () => userSignal()?.isAnonymous ?? false,
        },
      },
      { provide: AuthMenuStateService, useValue: { open } },
      // The real service reads `window.location.search` once, at construction,
      // so embed mode is not something a test can turn on afterwards.
      {
        provide: EmbedModeService,
        useValue: { isEmbedded: () => options.embedded ?? false },
      },
    ],
  });

  return { getGameplayStats, userSignal, authReadySignal, open };
}

function setup(options: SetupOptions = {}) {
  const doubles = configure(options);

  const component = TestBed.runInInjectionContext(
    () => new ProfileStatsComponent(),
  ) as never as InternalProfileStats;

  // The read is started from an effect, so nothing has happened yet — every
  // test drives `settle()` below before asserting.
  return { component, ...doubles };
}

/** Runs pending effects, then drains the microtask queue the read resolves on. */
async function settle(): Promise<void> {
  TestBed.tick();
  await Promise.resolve();
  await Promise.resolve();
  TestBed.tick();
}

afterEach(() => {
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
});

describe('ProfileStatsComponent', () => {
  it('shows the loading state, and reads nothing, before auth has answered', async () => {
    const { component, getGameplayStats } = setup({ user: null, authReady: false });

    await settle();

    expect(component.view()).toBe('loading');
    // The announcement is empty on purpose: "loading" is not an outcome, and a
    // live region that says it announces something on every visit.
    expect(component.statusAnnouncement()).toBe('');
    expect(getGameplayStats).not.toHaveBeenCalled();
  });

  /**
   * **The `isAnonymous()` trap.** `user()?.isAnonymous ?? false` is `false`
   * when there is no user at all, so a gate written as `!isAnonymous()` treats
   * the pre-auth frame as a signed-in account and tries to read a document for
   * a uid that does not exist. `signedInUid` asserts the positive fact
   * instead, and this is the case that tells the two apart.
   */
  it('treats a null user as signed out rather than as an account', async () => {
    const { component, getGameplayStats } = setup({ user: null });

    await settle();

    expect(component.view()).toBe('signedOut');
    expect(getGameplayStats).not.toHaveBeenCalled();
  });

  it('shows the signed-out state for an anonymous session and reads nothing', async () => {
    const { component, getGameplayStats } = setup({
      user: { uid: 'anon', isAnonymous: true },
    });

    await settle();

    expect(component.view()).toBe('signedOut');
    expect(component.statusAnnouncement()).toBe(
      'Signed out. Stats are only kept for a signed-in account.',
    );
    // An anonymous session has no document by design — the callable refuses to
    // create one (`docs/data-model.md`) — so reading would be a billed request
    // whose answer is known in advance.
    expect(getGameplayStats).not.toHaveBeenCalled();
  });

  it('reads the signed-in account and renders the five totals', async () => {
    const { component, getGameplayStats } = setup();

    await settle();

    expect(getGameplayStats).toHaveBeenCalledExactlyOnceWith('u1');
    expect(component.view()).toBe('stats');
    expect(component.tiles().map((tile) => [tile.id, tile.value])).toEqual([
      ['games-played', '3'],
      ['questions-answered', '25'],
      ['correct-answers', '20'],
      ['accuracy', '80%'],
      ['best-streak', '7'],
    ]);
    expect(component.trackingSince()).toBeTruthy();
  });

  it('shows the empty state, not zeroes, for an account with no document yet', async () => {
    const { component } = setup({ result: null });

    await settle();

    expect(component.view()).toBe('empty');
    // Placeholders rather than `0`: zero is a fact about a finished game, and
    // this player has not finished one.
    expect(component.tiles().every((tile) => tile.value === '—')).toBe(true);
    expect(component.statusAnnouncement()).toBe('No finished games yet.');
  });

  /**
   * A failed read is **not** the empty state. Collapsing the two would tell a
   * player with perfectly good totals that they have never finished a game —
   * a cause nobody verified, stated as fact (`CLAUDE.md` §4.4) — and would
   * offer no way to try again.
   */
  it('distinguishes a failed read from an account with no games', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { component } = setup({ fails: true });

    await settle();

    expect(component.view()).toBe('failed');
    expect(component.statusAnnouncement()).toBe('Could not load your stats.');
  });

  it('re-reads on retry, and recovers when the second read works', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { component, getGameplayStats } = setup({ fails: true });
    await settle();
    expect(component.view()).toBe('failed');

    getGameplayStats.mockResolvedValue(stats({ gamesPlayed: 1 }));
    component.retry();
    await settle();

    expect(getGameplayStats).toHaveBeenCalledTimes(2);
    expect(component.view()).toBe('stats');
  });

  /**
   * Zero questions answered is reachable — a game every question of which was
   * skipped or timed out banks with `questionsAnswered: 0` — and `0 / 0` is
   * `NaN`, which `Intl.NumberFormat` renders as "NaN%".
   */
  it('renders a placeholder rather than NaN% when nothing has been answered', async () => {
    const { component } = setup({
      result: stats({ gamesPlayed: 1, questionsAnswered: 0, correctAnswers: 0, bestStreak: 0 }),
    });

    await settle();

    const accuracy = component.tiles().find((tile) => tile.id === 'accuracy');
    expect(accuracy?.value).toBe('—');
    // The counts around it are still real numbers, so the placeholder is about
    // the division and not about the state.
    expect(component.tiles().find((tile) => tile.id === 'games-played')?.value).toBe('1');
  });

  /**
   * `statsSince` is absent on a document written before the field existed —
   * possible precisely because `users/{uid}` has no rules-level schema, which
   * is the property that lets it grow (`docs/data-model.md`). A formatted
   * `null` would read "Invalid Date" on the player's own profile.
   */
  it('drops the tracking-since line for a document without the date', async () => {
    const { component } = setup({ result: stats({ statsSince: null }) });

    await settle();

    expect(component.view()).toBe('stats');
    expect(component.trackingSince()).toBeNull();
  });

  it('clears the previous account’s totals on sign-out', async () => {
    const { component, userSignal } = setup();
    await settle();
    expect(component.view()).toBe('stats');

    userSignal.set(null);
    await settle();

    expect(component.view()).toBe('signedOut');
    expect(component.tiles().every((tile) => tile.value === '—')).toBe(true);
  });

  it('reads the new account when a different one signs in', async () => {
    const { component, getGameplayStats, userSignal } = setup();
    await settle();

    userSignal.set({ uid: 'u2', isAnonymous: false });
    await settle();

    expect(getGameplayStats).toHaveBeenLastCalledWith('u2');
    expect(component.view()).toBe('stats');
  });

  /**
   * `AuthService.user` is declared `equal: () => false`, so it notifies on
   * every set even when nothing about the user changed. The read is keyed on
   * the uid rather than on that signal so a token refresh does not buy a
   * second billed read of the same document.
   */
  it('does not re-read when the same user is re-emitted', async () => {
    const { getGameplayStats, userSignal } = setup();
    await settle();

    userSignal.set({ uid: 'u1', isAnonymous: false });
    await settle();

    expect(getGameplayStats).toHaveBeenCalledTimes(1);
  });

  it('opens the auth menu from the signed-out state', async () => {
    const { component, open } = setup({ user: { uid: 'anon', isAnonymous: true } });
    await settle();

    component.openSignIn();

    expect(open).toHaveBeenCalledOnce();
  });
});

/**
 * The cases above drive the class; these two need the template, because what
 * they are about is which elements exist and where focus is — neither of which
 * a signal can answer.
 *
 * jsdom has no layout and no stylesheet, so `invisible` is inert here: an
 * element the browser would hide is still focusable in these tests. That makes
 * the focus case below a test of the *deliberate* move and not of the fallout
 * from it — the fallout is what `profile-stats.spec.ts` measures in Chromium.
 */
describe('ProfileStatsComponent (rendered)', () => {
  async function render(options: SetupOptions = {}) {
    const doubles = configure(options);
    const fixture = TestBed.createComponent(ProfileStatsComponent);
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    return {
      ...doubles,
      fixture,
      query: (selector: string) => host.querySelector<HTMLElement>(selector),
    };
  }

  it('offers the signed-out visitor a sign-in button', async () => {
    const { query } = await render({ user: { uid: 'anon', isAnonymous: true } });

    expect(query('[data-cy="stats-signed-out"]')).not.toBeNull();
    expect(query('[data-cy="stats-sign-in"]')).not.toBeNull();
  });

  /**
   * `?embed=1` removes the top bar, and with it the auth menu this button
   * opens — so rendering it in an embed puts a control on the page that
   * cannot do the thing it names. Game-over's identical opener is gated the
   * same way. The explanation stays: it is the half that still applies.
   */
  it('drops the sign-in button in an embed, where there is no menu to open', async () => {
    const { query } = await render({
      user: { uid: 'anon', isAnonymous: true },
      embedded: true,
    });

    expect(query('[data-cy="stats-sign-in"]')).toBeNull();
    expect(query('[data-cy="stats-signed-out"]')).not.toBeNull();
  });

  /**
   * Retrying puts the card back into its loading state, which turns "Try
   * again" `visibility: hidden` — and focus on a hidden element does not stay
   * put, it drops silently to `<body>` (`CLAUDE.md` §4.4). A keyboard user
   * would then be at the top of the document, tabbing back down to a button
   * they had already reached once.
   */
  it('moves focus to the status line when a retry hides the button it was on', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { query, fixture } = await render({ fails: true });

    const retry = query('[data-cy="stats-retry"]')!;
    retry.focus();
    expect(document.activeElement).toBe(retry);

    retry.click();
    fixture.detectChanges();

    expect(document.activeElement).toBe(query('[data-cy="stats-status"]'));
  });
});
