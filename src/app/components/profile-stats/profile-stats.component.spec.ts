import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AccountService, BankedXp, UnbankedGame } from '../../services/account.service';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AvatarChoice } from '../../models/avatar.model';
import { AuthService } from '../../services/auth.service';
import { AvatarService } from '../../services/avatar.service';
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
  line(): ProfileView | 'notBanked' | 'dailyLimit';
  tiles(): { id: string; label: string; value: string }[];
  trackingSince(): string | null;
  statusAnnouncement(): string;
  progressXp(): number | null;
  progressState(): string;
  levelUp(): number | null;
  xpKnowledge(): { state: string; xp?: number };
  retry(): void;
  openSignIn(): void;
}

interface FakeUser {
  uid: string;
  isAnonymous: boolean;
  displayName?: string;
}

function stats(overrides: Partial<GameplayStats> = {}): GameplayStats {
  return {
    gamesPlayed: 3,
    questionsAnswered: 25,
    correctAnswers: 20,
    bestStreak: 7,
    statsSince: Date.UTC(2026, 0, 15),
    xp: 340,
    ...overrides,
  };
}

interface SetupOptions {
  user?: FakeUser | null;
  authReady?: boolean;
  result?: GameplayStats | null;
  fails?: boolean;
  embedded?: boolean;
  /** The stored avatar choice the header draws, or `null` while unknown. */
  avatar?: AvatarChoice | null;
  /** A game the server declined to bank in this tab (`AccountService.unbankedGame`). */
  unbanked?: UnbankedGame | null;
  /** The XP the last game banked in this tab came to (`AccountService.bankedXp`). */
  banked?: BankedXp | null;
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
  const unbankedGame = signal<UnbankedGame | null>(options.unbanked ?? null);
  const bankedXp = signal<BankedXp | null>(options.banked ?? null);

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
          // The avatar picker on the same page asks this — its own spec
          // covers what it does with the answer.
          isFullyAuthenticated: () => {
            const current = userSignal();
            return current !== null && !current.isAnonymous;
          },
        },
      },
      // The header and the picker draw from `AvatarService`; a stub keeps the
      // page from reaching the network to read a choice these tests do not
      // need. `status` is what the picker's states hang on.
      {
        provide: AvatarService,
        useValue: {
          choice: signal<AvatarChoice | null>(options.avatar ?? null),
          photoUrl: signal<string | null>(null),
          status: () => (userSignal()?.isAnonymous === false ? 'ready' : 'none'),
          save: vi.fn(() => Promise.resolve('saved')),
          retry: vi.fn(),
        },
      },
      { provide: AuthMenuStateService, useValue: { open } },
      { provide: AccountService, useValue: { unbankedGame, bankedXp } },
      // The real service reads `window.location.search` once, at construction,
      // so embed mode is not something a test can turn on afterwards.
      {
        provide: EmbedModeService,
        useValue: { isEmbedded: () => options.embedded ?? false },
      },
    ],
  });

  return { getGameplayStats, userSignal, authReadySignal, open, unbankedGame, bankedXp };
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

  /**
   * A game the server refused to bank (`AccountService.unbankedGame`). "Nothing
   * banked yet — finish a game and your totals will show up here" is the
   * sentence every GitHub, Microsoft, Apple, Twitter/X and Yahoo player read
   * while every game they finished was refused, so it must not be the sentence
   * shown once the app knows a game was refused — and neither may "Tracking
   * since", which promises the same thing to a player with older totals.
   */
  it('says the last game was not added, over an empty card', async () => {
    const { component } = setup({
      result: null,
      unbanked: { uid: 'u1', reason: 'unsupported-provider' },
    });

    await settle();

    expect(component.view()).toBe('empty');
    expect(component.line()).toBe('notBanked');
    expect(component.statusAnnouncement()).toBe('Your last game could not be added to your stats.');
  });

  it('says it over a full card too, and keeps the totals already banked', async () => {
    const { component } = setup({ unbanked: { uid: 'u1', reason: 'rate-limited' } });

    await settle();

    expect(component.line()).toBe('notBanked');
    expect(component.tiles().find((tile) => tile.id === 'games-played')?.value).toBe('3');
  });

  it('says it the moment the refusal lands, with the page already open', async () => {
    const { component, unbankedGame } = setup();
    await settle();
    expect(component.line()).toBe('stats');

    unbankedGame.set({ uid: 'u1', reason: 'unsupported-provider' });

    expect(component.line()).toBe('notBanked');
  });

  /**
   * **The server's daily ceiling has words of its own** (`daily-ceiling.ts`):
   * what the limit is and when the count starts again, which the general
   * sentence cannot say. Over an empty card and a full one alike, and the
   * totals already banked stay on the tiles.
   */
  it('names the daily limit when the server refused the last game for it', async () => {
    const { component } = setup({ unbanked: { uid: 'u1', reason: 'daily-limit' } });

    await settle();

    expect(component.line()).toBe('dailyLimit');
    expect(component.statusAnnouncement()).toBe(
      'Your last game was not added: you reached the daily limit of 200 games.',
    );
    expect(component.tiles().find((tile) => tile.id === 'games-played')?.value).toBe('3');
  });

  it('names the daily limit over an empty card too', async () => {
    const { component } = setup({ result: null, unbanked: { uid: 'u1', reason: 'daily-limit' } });

    await settle();

    expect(component.view()).toBe('empty');
    expect(component.line()).toBe('dailyLimit');
  });

  /**
   * Any other reason keeps the general sentence — one from a newer server this
   * build does not know included, which is the honest thing to say about it.
   */
  it('keeps the general sentence for every other reason', async () => {
    for (const reason of ['unsupported-provider', 'invalid', 'rate-limited', 'some-newer-reason']) {
      const { component } = setup({ unbanked: { uid: 'u1', reason } });
      await settle();
      expect(component.line(), reason).toBe('notBanked');
      TestBed.resetTestingModule();
    }
  });

  it('shows nothing of a refused game that belongs to another account', async () => {
    const { component } = setup({ unbanked: { uid: 'someone-else', reason: 'invalid' } });

    await settle();

    expect(component.line()).toBe('stats');
    expect(component.statusAnnouncement()).toBe('Your stats are ready.');
  });

  /**
   * It refines what the card says about totals, so it only ever replaces a
   * sentence about totals: a read in flight, a failed read and a signed-out
   * visitor keep their own, and the failed read keeps its retry.
   */
  it('leaves the loading, failed and signed-out sentences alone', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unbanked = { uid: 'u1', reason: 'unsupported-provider' };

    const failed = setup({ fails: true, unbanked });
    await settle();
    expect(failed.component.line()).toBe('failed');
    TestBed.resetTestingModule();

    const loading = setup({ authReady: false, unbanked });
    await settle();
    expect(loading.component.line()).toBe('loading');
    TestBed.resetTestingModule();

    const signedOut = setup({ user: null, unbanked });
    await settle();
    expect(signedOut.component.line()).toBe('signedOut');
    TestBed.resetTestingModule();

    // The daily-limit sentence refines the same two views and no others.
    const dailyLimit = { uid: 'u1', reason: 'daily-limit' };
    const failedForTheDay = setup({ fails: true, unbanked: dailyLimit });
    await settle();
    expect(failedForTheDay.component.line()).toBe('failed');
    TestBed.resetTestingModule();

    const signedOutForTheDay = setup({ user: null, unbanked: dailyLimit });
    await settle();
    expect(signedOutForTheDay.component.line()).toBe('signedOut');
  });
});

/**
 * The progress card and the picker's locks (`FEAT-041`) draw one XP, decided
 * here from the same read as the totals — so which state the card is in, which
 * number it shows, and when a level-up is said are the page's to get right.
 */
describe('ProfileStatsComponent — level and XP', () => {
  it('hands the card the XP the read returned, in the ready state', async () => {
    const { component } = setup();

    await settle();

    expect(component.progressState()).toBe('ready');
    expect(component.progressXp()).toBe(340);
    expect(component.xpKnowledge()).toEqual({ state: 'known', xp: 340 });
  });

  /**
   * Zero is a real total for a signed-in account with nothing banked — the
   * card shows level 0 and the bar empty, and the picker's locks are decided
   * on it rather than left guessing.
   */
  it('treats an account with nothing banked as a known total of zero', async () => {
    const { component } = setup({ result: null });

    await settle();

    expect(component.progressState()).toBe('ready');
    expect(component.progressXp()).toBe(0);
    expect(component.xpKnowledge()).toEqual({ state: 'known', xp: 0 });
  });

  /** The least alarming answer while the read is out: no number, and the picker holds its locks. */
  it('shows no XP while the read is in flight, and tells the picker it is checking', () => {
    const { component } = setup();

    // Before `settle()`: auth has answered, the read has not.
    TestBed.tick();

    expect(component.view()).toBe('loading');
    expect(component.progressState()).toBe('loading');
    expect(component.progressXp()).toBeNull();
    expect(component.xpKnowledge()).toEqual({ state: 'checking' });
  });

  /**
   * A failed read is told to the picker as one, so its sets can say so rather
   * than call themselves locked; a visitor who is not signed in cannot use
   * the picker, and is told the neutral answer the picker starts from.
   */
  it('shows no XP to a visitor who is not signed in, or after a failed read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const signedOut = setup({ user: { uid: 'anon', isAnonymous: true } });
    await settle();
    expect(signedOut.component.progressState()).toBe('signedOut');
    expect(signedOut.component.progressXp()).toBeNull();
    expect(signedOut.component.xpKnowledge()).toEqual({ state: 'checking' });
    TestBed.resetTestingModule();

    const failed = setup({ fails: true });
    await settle();
    expect(failed.component.progressState()).toBe('failed');
    expect(failed.component.progressXp()).toBeNull();
    expect(failed.component.xpKnowledge()).toEqual({ state: 'failed' });
  });

  /**
   * A game that banked after the read was made: the callable's answer is what
   * the transaction committed, so the card shows it rather than the older
   * read — and never goes backwards when the answer is the smaller of the two.
   */
  it('raises the read to the XP a game banked in this tab came to', async () => {
    const { component, bankedXp } = setup({ result: stats({ xp: 590 }) });
    await settle();
    expect(component.progressXp()).toBe(590);

    bankedXp.set({ uid: 'u1', xp: 650, gained: 60 });
    expect(component.progressXp()).toBe(650);

    bankedXp.set({ uid: 'u1', xp: 120, gained: 20 });
    expect(component.progressXp()).toBe(590);
  });

  it('says when the last game crossed a level, on the card and in the live region', async () => {
    const { component } = setup({
      result: stats({ xp: 650 }),
      banked: { uid: 'u1', xp: 650, gained: 60 },
    });

    await settle();

    expect(component.levelUp()).toBe(3);
    expect(component.statusAnnouncement()).toBe(
      'Your stats are ready. Your last game took you to level 3.',
    );
  });

  it('says nothing of a game that stayed within its level', async () => {
    const { component } = setup({
      result: stats({ xp: 640 }),
      banked: { uid: 'u1', xp: 640, gained: 40 },
    });

    await settle();

    expect(component.levelUp()).toBeNull();
    expect(component.statusAnnouncement()).toBe('Your stats are ready.');
  });

  it('says nothing of another account’s game', async () => {
    const { component } = setup({
      result: stats({ xp: 340 }),
      banked: { uid: 'someone-else', xp: 650, gained: 60 },
    });

    await settle();

    expect(component.progressXp()).toBe(340);
    expect(component.levelUp()).toBeNull();
  });

  /**
   * Over "nothing banked yet" a level-up would contradict the sentence above
   * it; over a refused last game there is no level for it to have crossed.
   */
  it('says no level-up over an empty card or a refused game', async () => {
    const empty = setup({ result: null, banked: { uid: 'u1', xp: 170, gained: 170 } });
    await settle();
    expect(empty.component.levelUp()).toBeNull();
    TestBed.resetTestingModule();

    const refused = setup({
      unbanked: { uid: 'u1', reason: 'rate-limited' },
      banked: { uid: 'u1', xp: 650, gained: 60 },
    });
    await settle();
    expect(refused.component.levelUp()).toBeNull();
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

  /**
   * The profile header's avatar (`FEAT-038`): the same component the chip
   * draws with, and the neutral face for anybody who is not a signed-in
   * account — including the frames before auth has answered.
   */
  it('draws the neutral face in the header for a visitor who is not signed in', async () => {
    const { query } = await render({ user: { uid: 'anon', isAnonymous: true } });

    expect(query('[data-cy="profile-avatar"]')?.getAttribute('data-avatar')).toBe('guest');
  });

  it('draws the signed-in account’s stored choice in the header', async () => {
    const { query } = await render({
      user: { uid: 'u1', isAnonymous: false, displayName: 'Ada' },
      avatar: { kind: 'built', seed: 'core-23', showPublicly: false },
    });

    const avatar = query('[data-cy="profile-avatar"]');
    expect(avatar?.getAttribute('data-avatar')).toBe('built');
    expect(avatar?.className).toContain('h-12');
  });

  /**
   * One live region for the page: the picker's outcome is said through the
   * region this page already has, and replaces the stats line until the stats
   * have something new to say (`CLAUDE.md` §4.5).
   */
  it('announces the avatar picker’s outcome through the page’s one live region', async () => {
    const { query, fixture } = await render();
    const region = () => query('[role="status"]')?.textContent?.trim();
    expect(region()).toBe('Your stats are ready.');

    const picker = fixture.debugElement.query((node) => node.name === 'app-avatar-picker')
      .componentInstance as { announce: { emit(text: string): void } };
    picker.announce.emit('Avatar saved.');
    fixture.detectChanges();

    expect(region()).toBe('Avatar saved.');
    expect(fixture.nativeElement.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it('renders the progress card between the totals and the picker, fed by the read', async () => {
    const { query, fixture } = await render({ result: stats({ xp: 650 }) });

    const cards = [...fixture.nativeElement.querySelectorAll('[data-cy$="-card"]')].map(
      (card) => (card as HTMLElement).dataset['cy'],
    );
    expect(cards).toEqual(['stats-card', 'progress-card', 'avatar-card']);
    expect(query('[data-cy="progress-level"]')?.textContent?.trim()).toBe('3');
    // The picker is handed the same number, so its locks match the card.
    expect(query('[data-cy="avatar-set-bold-unlocked"]')?.classList.contains('invisible')).toBe(
      false,
    );
  });

  it('offers the signed-out visitor a sign-in button', async () => {
    const { query } = await render({ user: { uid: 'anon', isAnonymous: true } });

    expect(query('[data-cy="stats-signed-out"]')).not.toBeNull();
    expect(query('[data-cy="stats-sign-in"]')).not.toBeNull();
  });

  /**
   * The refused-game sentence takes the place of the one it contradicts, in the
   * same grid cell, so the card says one thing and keeps its height — and the
   * live region says it too, because it arrives after a round trip.
   */
  it('shows the refused-game sentence in place of the one that promised totals', async () => {
    const { query } = await render({
      result: null,
      unbanked: { uid: 'u1', reason: 'unsupported-provider' },
    });

    const shown = (cy: string) => !query(`[data-cy="${cy}"]`)!.classList.contains('invisible');
    expect(shown('stats-not-banked')).toBe(true);
    expect(shown('stats-empty')).toBe(false);
    expect(shown('stats-since')).toBe(false);
    expect(query('[data-cy="stats-not-banked"]')?.parentElement).toBe(
      query('[data-cy="stats-status"]'),
    );
    expect(query('[role="status"]')?.textContent?.trim()).toBe(
      'Your last game could not be added to your stats.',
    );
  });

  /**
   * The daily-limit sentence is one more face in the same cell: it says what
   * the limit is and when it resets, and the general sentence, the empty one
   * and "tracking since" are all hidden while it shows.
   */
  it('shows the daily-limit sentence in place of the general one', async () => {
    const { query } = await render({ unbanked: { uid: 'u1', reason: 'daily-limit' } });

    const shown = (cy: string) => !query(`[data-cy="${cy}"]`)!.classList.contains('invisible');
    expect(shown('stats-daily-limit')).toBe(true);
    expect(shown('stats-not-banked')).toBe(false);
    expect(shown('stats-empty')).toBe(false);
    expect(shown('stats-since')).toBe(false);
    expect(query('[data-cy="stats-daily-limit"]')?.parentElement).toBe(
      query('[data-cy="stats-status"]'),
    );
    expect(query('[data-cy="stats-daily-limit"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Your last game was not added: the limit is 200 games a day, reset at midnight UTC.',
    );
    expect(query('[role="status"]')?.textContent?.trim()).toBe(
      'Your last game was not added: you reached the daily limit of 200 games.',
    );
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
