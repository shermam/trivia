import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { FirebaseService, GameplayStats } from '../../services/firebase.service';
import { IconComponent, IconName } from '../icon/icon.component';

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

/** One number on the card. `id` is the `@for` track key, never the label (`CLAUDE.md` §4.4). */
interface StatTile {
  id: string;
  label: string;
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
  imports: [RouterLink, IconComponent],
  templateUrl: './profile-stats.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileStatsComponent {
  private readonly firebaseService = inject(FirebaseService);
  private readonly authService = inject(AuthService);
  private readonly authMenuState = inject(AuthMenuStateService);

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
        label: 'Games played',
        icon: 'trophy',
        value: stats ? COUNT_FORMAT.format(stats.gamesPlayed) : UNKNOWN,
      },
      {
        id: 'questions-answered',
        label: 'Questions answered',
        icon: 'sparkles',
        value: stats ? COUNT_FORMAT.format(stats.questionsAnswered) : UNKNOWN,
      },
      {
        id: 'correct-answers',
        label: 'Correct answers',
        icon: 'check',
        value: stats ? COUNT_FORMAT.format(stats.correctAnswers) : UNKNOWN,
      },
      {
        id: 'accuracy',
        label: 'Accuracy',
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
        label: 'Best streak',
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
   */
  protected readonly statusAnnouncement = computed(() => {
    switch (this.view()) {
      case 'stats':
        return 'Your stats are ready.';
      case 'empty':
        return 'No finished games yet.';
      case 'signedOut':
        return 'Signed out. Stats are only kept for a signed-in account.';
      case 'failed':
        return 'Could not load your stats.';
      default:
        return '';
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

  /** Re-runs a read that failed. The only action the failed state offers. */
  protected retry(): void {
    const uid = this.signedInUid();
    if (uid !== null) {
      void this.read(uid);
    }
  }

  /**
   * Opens the top bar's auth menu, the same way game-over's "Sign in to save
   * this score" does — so the signed-out state offers the action it is asking
   * for rather than describing it.
   */
  protected openSignIn(): void {
    this.authMenuState.open();
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
