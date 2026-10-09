import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { avatarLetter } from '../../models/avatar.model';
import { DAILY_GAME_CEILING } from '../../models/daily-ceiling';
import { levelFor } from '../../models/levels';
import { AccountService } from '../../services/account.service';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { AvatarService } from '../../services/avatar.service';
import { EmbedModeService } from '../../services/embed-mode.service';
import { FirebaseService, GameplayStats } from '../../services/firebase.service';
import { AvatarPickerComponent, XpKnowledge } from '../avatar-picker/avatar-picker.component';
import { AvatarComponent } from '../avatar/avatar.component';
import { IconComponent, IconName } from '../icon/icon.component';
import { ProgressCardComponent, ProgressState } from '../progress-card/progress-card.component';
import { msg, sameMessage, type Message } from '../../i18n/message';
import { TPipe } from '../../i18n/t.pipe';

/**
 * Which of the screen's five states is showing.
 *
 * A single computed rather than an `@if`/`@else if` chain in the template, for
 * the reason game-over's `scoreAction` is one (`docs/app.md` §1.1): the
 * ordering of those branches is itself a defect a template test cannot reach,
 * and this one has a branch — "auth has not answered yet" — that has to lose
 * to nothing at all.
 */
type ProfileView = 'loading' | 'signedOut' | 'empty' | 'stats' | 'failed';

/**
 * Which sentence the card's status line shows: the view, or — over an empty
 * card or a full one — that the signed-in account's last game in this tab was
 * refused by the server (`AccountService.unbankedGame`): `dailyLimit` when the
 * refusal was the server's daily ceiling, which has something precise to say,
 * and `notBanked` for any other reason. The tiles and the action row go by the
 * view alone; only the sentence changes.
 */
type StatsLine = ProfileView | 'notBanked' | 'dailyLimit';

/** The picker's two answers for a player whose XP is not a number yet. */
const CHECKING_XP: XpKnowledge = { state: 'checking' };
const FAILED_XP: XpKnowledge = { state: 'failed' };

/** One number on the card. `id` is the `@for` track key, never the label (`CLAUDE.md` §4.4). */
interface StatTile {
  id: string;
  label: Message;
  icon: IconName;
  /** Already formatted, or the placeholder — the template never does arithmetic. */
  value: string;
}

/**
 * What a tile shows before the read has answered, and what accuracy shows for
 * a player who has answered no questions.
 *
 * An em-dash rather than `0`, because the two say different things: zero is a
 * fact about a finished game, and this is the absence of one. It is also what
 * keeps `0/0` off the screen as `NaN%`.
 */
const UNKNOWN = '—';

/**
 * The reader's own locale, deliberately — unlike a price, which is a fact
 * about a charge and is pinned to its currency's conventions
 * (`utils/money.util.ts`). These are the reader's own counts, so they are
 * rendered the way the reader's machine renders numbers.
 */
const COUNT_FORMAT = new Intl.NumberFormat();
const PERCENT_FORMAT = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 0,
});
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' });

/**
 * The server's daily ceiling, as the refused-game sentence names it — the
 * app's copy, pinned to `functions/src/daily-ceiling.ts` by
 * `daily-ceiling.spec.ts`.
 */
const DAILY_CEILING_TEXT = COUNT_FORMAT.format(DAILY_GAME_CEILING);

/**
 * Lifetime totals, read back and shown to the player they belong to
 * (`FEAT-005`, reduced to what `users/{uid}` already stores).
 *
 * **Read-only, and it has no write path to grow one.** The document is written
 * exclusively by the `recordGameResult` callable on the Admin SDK, which is
 * what lets the collection carry no `hasOnly()` allowlist and therefore grow a
 * field without a rules deploy (`docs/data-model.md`). A screen that wrote
 * here would end that property, so this one only reads.
 *
 * **Nothing here is shown to anyone else.** The numbers are bounded rather
 * than attested — the callable range-checks a payload the client supplied
 * (audit decision A1) — so they are worth showing their owner and would not be
 * worth ranking.
 */
@Component({
  selector: 'app-profile-stats',
  standalone: true,
  imports: [
    RouterLink,
    IconComponent,
    AvatarComponent,
    AvatarPickerComponent,
    ProgressCardComponent,
    TPipe,
  ],
  templateUrl: './profile-stats.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileStatsComponent {
  private readonly firebaseService = inject(FirebaseService);
  private readonly authService = inject(AuthService);
  private readonly accountService = inject(AccountService);
  private readonly authMenuState = inject(AuthMenuStateService);
  protected readonly embedMode = inject(EmbedModeService);
  /** The header's avatar — the same choice, read once, that the chip draws (`FEAT-038`). */
  protected readonly avatarService = inject(AvatarService);

  /**
   * The block of stacked messages, focused when a retry starts — see `retry()`.
   *
   * A `viewChild` of an element that is rendered unconditionally and visible in
   * every state, which is what makes a plain `focus()` in the click handler
   * correct here rather than an `afterRenderEffect`: nothing about this element
   * depends on the binding that is changing (`CLAUDE.md` §4.4).
   */
  private readonly statusRegion = viewChild<ElementRef<HTMLElement>>('statusRegion');

  private readonly statsSignal = signal<GameplayStats | null>(null);
  private readonly hasReadSignal = signal(false);
  private readonly readFailedSignal = signal(false);

  /**
   * The uid a read has already been started for.
   *
   * A plain field rather than a signal on purpose: the effect below must not
   * depend on it, or setting it would schedule the effect that set it.
   */
  private startedForUid: string | null = null;

  /**
   * The account whose totals this screen may read, or `null` for anybody else
   * — including "auth has not answered yet".
   *
   * **`user() !== null` is the load-bearing half.** `isAnonymous()` is
   * `user()?.isAnonymous ?? false`, so it reads `false` when there is no user
   * at all, and a gate written as `!isAnonymous()` falls straight through to
   * the signed-in branch for every frame before `onAuthStateChanged` fires
   * (`CLAUDE.md` §4.4). Asserting the positive fact makes that impossible
   * rather than merely unlikely.
   *
   * It is also what stops the effect below re-reading on every auth emission:
   * `AuthService.user` is declared `equal: () => false`, so it notifies on
   * every set — while this computed narrows it to a string, whose default
   * equality holds.
   */
  private readonly signedInUid = computed(() => {
    const user = this.authService.user();
    return user !== null && !user.isAnonymous ? user.uid : null;
  });

  /**
   * The header avatar's letter, or `null` for the neutral face — every state
   * that is not a signed-in account, including "auth has not answered yet",
   * which defaults to the least specific picture rather than a guessed one
   * (`CLAUDE.md` §4.4).
   */
  protected readonly headerLetter = computed(() =>
    this.signedInUid() === null ? null : avatarLetter(this.authService.user()),
  );

  protected readonly view = computed<ProfileView>(() => {
    if (!this.authService.authReady()) {
      return 'loading';
    }
    if (this.signedInUid() === null) {
      return 'signedOut';
    }
    if (!this.hasReadSignal()) {
      return 'loading';
    }
    if (this.readFailedSignal()) {
      return 'failed';
    }
    return this.statsSignal() === null ? 'empty' : 'stats';
  });

  /**
   * The server's refusal of the last game this account finished in this tab,
   * or `null` — so the sentence that would promise totals ("finish a game and
   * your totals will show up here") is replaced by one saying the game was not
   * added. Scoped to the account the refused call was made as: another
   * account signed in since sees nothing of it.
   *
   * Nothing is stored, so it lasts as long as the tab. That is enough for what
   * it is for — a player checking their totals after a game that did not count
   * — and it is the only thing that can say so: nothing is written for a
   * refused game, so there is nothing to read back.
   */
  private readonly lastGameRefusal = computed(() => {
    const unbanked = this.accountService.unbankedGame();
    return unbanked !== null && unbanked.uid === this.signedInUid() ? unbanked : null;
  });

  protected readonly line = computed<StatsLine>(() => {
    const view = this.view();
    const refusal = this.lastGameRefusal();
    if ((view !== 'empty' && view !== 'stats') || refusal === null) {
      return view;
    }
    // The server's daily ceiling is the one refusal with something precise to
    // say: what the limit is and when the count starts again. Every other
    // reason gets the general sentence — including one from a newer server this
    // build does not know, which is the honest thing to say about it.
    return refusal.reason === 'daily-limit' ? 'dailyLimit' : 'notBanked';
  });

  /** The ceiling the daily-limit sentence names. */
  protected readonly dailyCeiling = DAILY_CEILING_TEXT;

  /**
   * The XP of the last game this account banked in this tab, as the callable
   * answered it (`AccountService.bankedXp`), or `null` — for nobody else.
   */
  private readonly bankedXp = computed(() => {
    const banked = this.accountService.bankedXp();
    return banked !== null && banked.uid === this.signedInUid() ? banked : null;
  });

  /**
   * The XP the progress card draws and the picker's locks are decided on
   * (`FEAT-041`) — one value, so the two cannot disagree — or `null` while
   * there is none to show.
   *
   * The read's, raised to the callable's answer when a game banked in this tab
   * landed after the read was made: the answer is what the transaction
   * committed, so it is never ahead of the document, and XP only grows. A
   * document with no `xp` — no game banked since XP began, or none at all —
   * is a real total of zero once somebody is signed in.
   */
  protected readonly progressXp = computed<number | null>(() => {
    const view = this.view();
    if (view !== 'empty' && view !== 'stats') {
      return null;
    }
    return Math.max(this.statsSignal()?.xp ?? 0, this.bankedXp()?.xp ?? 0);
  });

  /** The progress card's state: the totals card's view, with no games yet a level of its own. */
  protected readonly progressState = computed<ProgressState>(() => {
    const view = this.view();
    return view === 'empty' || view === 'stats' ? 'ready' : view;
  });

  /**
   * The level this account's last game in this tab took it to, when it
   * crossed one — said on the progress card and through the live region.
   *
   * Only over loaded totals: over "nothing banked yet" it would contradict the
   * line above it, which can only happen when the first game banked in the
   * moment between the read and the answer, and a refused last game earned
   * nothing to cross a level with (`AccountService` drops the note then).
   */
  protected readonly levelUp = computed<number | null>(() => {
    const banked = this.bankedXp();
    if (banked === null || this.line() !== 'stats') {
      return null;
    }
    const reached = levelFor(banked.xp);
    return reached > levelFor(banked.xp - banked.gained) ? reached : null;
  });

  /**
   * What the picker knows of the XP: known, a read that failed, or not read
   * yet — which is also what it is told for a visitor who is not signed in,
   * since the picker cannot be used then and holding still is the right
   * default for whoever signs in next (`CLAUDE.md` §4.4).
   */
  protected readonly xpKnowledge = computed<XpKnowledge>(() => {
    const xp = this.progressXp();
    if (xp !== null) {
      return { state: 'known', xp };
    }
    return this.view() === 'failed' ? FAILED_XP : CHECKING_XP;
  });

  /**
   * The five numbers, formatted, or five placeholders.
   *
   * Built in every state rather than only when there is something to show:
   * the grid is rendered from first paint so that what arrives fills boxes
   * that are already on the page instead of creating them (`CLAUDE.md` §4.4).
   * `profile-stats.spec.ts` measures the card through the state change.
   */
  protected readonly tiles = computed<StatTile[]>(() => {
    const stats = this.view() === 'stats' ? this.statsSignal() : null;
    return [
      {
        id: 'games-played',
        label: msg('profile.gamesPlayed', 'Games played'),
        icon: 'trophy',
        value: stats ? COUNT_FORMAT.format(stats.gamesPlayed) : UNKNOWN,
      },
      {
        id: 'questions-answered',
        label: msg('profile.questionsAnswered', 'Questions answered'),
        icon: 'sparkles',
        value: stats ? COUNT_FORMAT.format(stats.questionsAnswered) : UNKNOWN,
      },
      {
        id: 'correct-answers',
        label: msg('profile.correctAnswers', 'Correct answers'),
        icon: 'check',
        value: stats ? COUNT_FORMAT.format(stats.correctAnswers) : UNKNOWN,
      },
      {
        id: 'accuracy',
        label: msg('profile.accuracy', 'Accuracy'),
        icon: 'percent',
        // Zero questions answered is a real state — a game can be banked with
        // every question skipped or timed out — and `0/0` is `NaN`, which is
        // the one thing this must never render.
        value:
          stats && stats.questionsAnswered > 0
            ? PERCENT_FORMAT.format(stats.correctAnswers / stats.questionsAnswered)
            : UNKNOWN,
      },
      {
        id: 'best-streak',
        label: msg('profile.bestStreak', 'Best streak'),
        icon: 'zap',
        value: stats ? COUNT_FORMAT.format(stats.bestStreak) : UNKNOWN,
      },
    ];
  });

  /**
   * The "tracking since" line, for a document that carries the date.
   *
   * `statsSince` is written once on create and never again, so it is the
   * honest answer to "since when" for an account that predates the feature —
   * and `null` for one written before the field existed, which is why the
   * template has a second sentence rather than a formatted `Invalid Date`.
   */
  protected readonly trackingSince = computed(() => {
    const since = this.statsSignal()?.statsSince;
    return since === null || since === undefined ? null : DATE_FORMAT.format(new Date(since));
  });

  /**
   * What the live region says, and it is deliberately not the sentence on
   * screen.
   *
   * Everything on this card arrives after a round trip, which is silent to
   * assistive tech without this (`CLAUDE.md` §4.5). Short, and different from
   * the visible copy, so a screen reader user is not read the same paragraph
   * twice — once as the announcement and once as the text under the heading.
   * Empty while loading: "loading" is not an outcome, and announcing it on
   * every visit is noise.
   *
   * **One region for the page, and the avatar picker speaks through it too**
   * (`FEAT-038`): a save's outcome replaces the stats line until the stats
   * have something new to say, so whichever happened last is what is heard.
   */
  protected readonly statusAnnouncement = computed(() => {
    const stats = this.statsAnnouncement();
    const notice = this.avatarNotice();
    return notice !== null && sameMessage(notice.over, stats) ? notice.text : stats;
  });

  /** The picker's last announcement, and the stats line it was made over. */
  private readonly avatarNotice = signal<{ text: Message | null; over: Message | null } | null>(
    null,
  );

  private readonly statsAnnouncement = computed<Message | null>(() => {
    switch (this.line()) {
      case 'stats': {
        const level = this.levelUp();
        return level === null
          ? msg('profile.saidReady', 'Your stats are ready.')
          : msg(
              'profile.saidLevelUp',
              'Your stats are ready. Your last game took you to level {level}.',
              { level },
            );
      }
      case 'empty':
        return msg('profile.saidEmpty', 'No finished games yet.');
      case 'notBanked':
        return msg('profile.saidNotBanked', 'Your last game could not be added to your stats.');
      case 'dailyLimit':
        return msg(
          'profile.saidDailyLimit',
          'Your last game was not added: you reached the daily limit of {limit} games.',
          { limit: DAILY_CEILING_TEXT },
        );
      case 'signedOut':
        return msg(
          'profile.saidSignedOut',
          'Signed out. Stats are only kept for a signed-in account.',
        );
      case 'failed':
        return msg('profile.saidFailed', 'Could not load your stats.');
      default:
        return null;
    }
  });

  constructor() {
    // Keyed on the uid, so it runs on arrival, on sign-in, and on sign-out —
    // the last of which has to *clear* the previous account's numbers rather
    // than leave them on screen under somebody else's session.
    effect(() => {
      const uid = this.signedInUid();
      if (uid === null) {
        this.startedForUid = null;
        this.statsSignal.set(null);
        this.hasReadSignal.set(false);
        this.readFailedSignal.set(false);
        return;
      }
      if (uid === this.startedForUid) {
        return;
      }
      this.startedForUid = uid;
      void this.read(uid);
    });
  }

  /**
   * Re-runs a read that failed. The only action the failed state offers.
   *
   * **It moves focus before it starts the read**, because starting the read is
   * what takes the focused element away: the view goes back to `loading`, "Try
   * again" turns `visibility: hidden`, and focus on a hidden element silently
   * drops to `<body>` (`CLAUDE.md` §4.4) — sending a keyboard user back to the
   * top of the document to reach a second "Try again". Focus goes to the block
   * of messages rather than the page heading: it is visible in every state, it
   * carries the sentence that answers the retry, and it sits directly above the
   * tiles and the action row, so the button is one Tab away if this fails too.
   */
  protected retry(): void {
    const uid = this.signedInUid();
    if (uid === null) {
      return;
    }
    this.statusRegion()?.nativeElement.focus();
    void this.read(uid);
  }

  /**
   * Opens the top bar's auth menu, the same way game-over's "Sign in to save
   * this score" does — so the signed-out state offers the action it is asking
   * for rather than describing it.
   */
  protected openSignIn(): void {
    this.authMenuState.open();
  }

  /** The avatar picker's outcome, said through this page's one live region. */
  protected onAvatarNotice(text: Message | null): void {
    this.avatarNotice.set({ text, over: untracked(this.statsAnnouncement) });
  }

  private async read(uid: string): Promise<void> {
    this.hasReadSignal.set(false);
    this.readFailedSignal.set(false);

    let stats: GameplayStats | null = null;
    let failed = false;
    try {
      stats = await this.firebaseService.getGameplayStats(uid);
    } catch (error) {
      // A refused or failed read is **not** the empty state. Both would
      // otherwise render "you have not finished a game yet", which is a cause
      // nobody verified being told to somebody whose totals are fine
      // (`CLAUDE.md` §4.4). The console keeps the only copy of the real
      // reason once the screen has said "try again".
      failed = true;
      console.error('[profile] could not read your lifetime totals', error);
    }

    // The account may have changed while the read was in flight. Writing a
    // stale answer is the bug this exists to prevent: signing out must not
    // leave the previous player's totals on the screen.
    if (this.signedInUid() !== uid) {
      return;
    }
    this.statsSignal.set(stats);
    this.readFailedSignal.set(failed);
    this.hasReadSignal.set(true);
  }
}
