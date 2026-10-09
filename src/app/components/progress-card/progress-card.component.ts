import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { AvatarChoice } from '../../models/avatar.model';
import {
  AVATAR_SET_UNLOCK_LEVELS,
  isSetUnlocked,
  levelProgress,
  nextUnlock,
} from '../../models/levels';
import { AvatarComponent } from '../avatar/avatar.component';
import { builtSeed } from '../avatar/built-avatar';
import { IconComponent } from '../icon/icon.component';

/**
 * Which state the card is in, as `/profile` decides it from the same read as
 * its totals: `ready` covers a player with XP and one with none yet, because
 * zero is a real total once somebody is signed in.
 */
export type ProgressState = 'loading' | 'signedOut' | 'failed' | 'ready';

/** The sentence under the heading — the state, or the level the last game reached. */
type ProgressLine = Exclude<ProgressState, 'ready'> | 'ready' | 'levelUp';

/**
 * What the unlock row says of the featured set: the level it opens at, as a
 * fact about the set (`opensAt`), or — once there is an answer — whether it is
 * this reader's (`locked`, `unlocked`).
 */
type UnlockLine = 'opensAt' | 'locked' | 'unlocked';

/** What a box shows before there is a number, as on the totals card: the absence of a fact. */
const UNKNOWN = '—';

/** The reader's own locale, as the totals card formats its counts. */
const COUNT_FORMAT = new Intl.NumberFormat();

/** `bold` → `Bold`: the set's name is its id, as the picker labels it. */
const labelFor = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

/** The last set in the table — what the card features once every set is open. */
const LAST_SET = Object.keys(AVATAR_SET_UNLOCK_LEVELS).at(-1) ?? 'core';

/**
 * A player's level, XP and progress to the next level, and what the next
 * unlock is (`FEAT-041`) — the card on `/profile` between the totals and the
 * avatar picker.
 *
 * **Presentational, and decided by the page.** `/profile` reads `users/{uid}`
 * once per visit for its totals, and the XP is a field of the same document,
 * so the page hands this card the state and the number rather than the card
 * making a second read of its own — the same value the picker's locks are
 * computed from, so the card and the picker cannot disagree.
 *
 * **One height in every state, by construction** (`CLAUDE.md` §4.4). Every
 * box is on the page from the first paint — the level and the XP as an
 * em-dash, the bar as an empty track, the unlock row with its avatar — and
 * each state only fills them. The sentences that differ are stacked in one
 * grid cell, so the space they take is the tallest of them; the unlock
 * preview is `AvatarComponent`, whose box is its size whatever it draws — the
 * neutral face for anybody not signed in, the set's first avatar over the
 * player's initial for anybody who is.
 *
 * **The bar is a `progressbar` once there is a value**, with `aria-valuenow`,
 * `aria-valuemin`, `aria-valuemax` and an `aria-valuetext` saying the same as
 * the line under it. With no value — loading, signed out, a failed read — it is
 * an empty track hidden from assistive tech, because the sentence above it is
 * what says why there is no number, and an indeterminate bar would announce a
 * wait that is not happening.
 *
 * **Only an answer draws the lock.** While the read is out, or after it
 * failed, the unlock row says the level the set opens at and nothing about
 * whether it is the reader's — the reader may be level 40, and "unlock at
 * level 3" under a lock is the alarming guess (`CLAUDE.md` §4.4). A visitor
 * who is not signed in is an answer: a guest earns no XP, so the set is not
 * theirs, and the row says what would open it.
 *
 * **Nothing here is shown to anyone else.** The XP is bounded, not attested
 * (audit decision A1), which is why a level unlocks a cosmetic and appears on
 * no public surface.
 */
@Component({
  selector: 'app-progress-card',
  standalone: true,
  imports: [AvatarComponent, IconComponent],
  templateUrl: './progress-card.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProgressCardComponent {
  readonly state = input<ProgressState>('loading');

  /** `users/{uid}.xp`, or `null` while there is none to show. Read only in `ready`. */
  readonly xp = input<number | null>(null);

  /**
   * The level the player's last game in this tab took them to, when it crossed
   * one — `null` otherwise. `/profile` works it out from the callable's answer
   * (`AccountService.bankedXp`), and says it through its live region too.
   */
  readonly levelUp = input<number | null>(null);

  /** The initial the unlock preview draws over, or `null` for the neutral face. */
  readonly letter = input<string | null>(null);

  /** Where the XP stands between two levels, or `null` when there is no number to show. */
  protected readonly progress = computed(() => {
    const xp = this.xp();
    return this.state() === 'ready' && xp !== null ? levelProgress(xp) : null;
  });

  protected readonly line = computed<ProgressLine>(() => {
    const state = this.state();
    if (state !== 'ready') {
      return state;
    }
    return this.levelUp() !== null ? 'levelUp' : 'ready';
  });

  protected readonly levelText = computed(() => {
    const progress = this.progress();
    return progress ? COUNT_FORMAT.format(progress.level) : UNKNOWN;
  });

  protected readonly xpText = computed(() => {
    const progress = this.progress();
    return `${progress ? COUNT_FORMAT.format(progress.xp) : UNKNOWN} XP`;
  });

  /** How far through this level the bar is filled, 0–100. */
  protected readonly percent = computed(() => {
    const progress = this.progress();
    return progress ? (progress.into / progress.span) * 100 : 0;
  });

  protected readonly toNextText = computed(() => {
    const progress = this.progress();
    if (!progress) {
      return UNKNOWN;
    }
    const toGo = COUNT_FORMAT.format(progress.span - progress.into);
    return `${toGo} XP to level ${COUNT_FORMAT.format(progress.level + 1)}`;
  });

  protected readonly valueText = computed(() => {
    const progress = this.progress();
    if (!progress) {
      return null;
    }
    return (
      `${COUNT_FORMAT.format(progress.into)} of ${COUNT_FORMAT.format(progress.span)} XP ` +
      `towards level ${COUNT_FORMAT.format(progress.level + 1)}`
    );
  });

  /**
   * The set the unlock row features: the next one still locked, or — once
   * every set is open — the last of them. With no XP to go on, the first one
   * above level 0, which is what opens next for anybody who starts playing.
   */
  protected readonly featuredSet = computed(() => {
    const progress = this.progress();
    return nextUnlock(progress?.xp ?? 0)?.set ?? LAST_SET;
  });

  protected readonly featuredLabel = computed(() => `${labelFor(this.featuredSet())} avatars`);

  protected readonly featuredLevel = computed(() => AVATAR_SET_UNLOCK_LEVELS[this.featuredSet()]);

  /**
   * Whether the featured set is this reader's: an answer once the XP is known,
   * or for a guest, who has none — and neither while the read is out or after
   * it failed.
   */
  protected readonly unlockLine = computed<UnlockLine>(() => {
    if (this.state() === 'signedOut') {
      return 'locked';
    }
    const progress = this.progress();
    if (progress === null) {
      return 'opensAt';
    }
    return isSetUnlocked(this.featuredSet(), progress.xp) ? 'unlocked' : 'locked';
  });

  /** The featured set's first avatar, which the row previews. */
  protected readonly featuredPreview = computed<AvatarChoice>(() => ({
    kind: 'built',
    seed: builtSeed(this.featuredSet(), 0, 0),
    showPublicly: false,
  }));
}
