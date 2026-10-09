import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  AvatarChoice,
  AvatarKind,
  DEFAULT_AVATAR_CHOICE,
  avatarLetter,
} from '../../models/avatar.model';
import { AVATAR_SET_UNLOCK_LEVELS, isSetUnlocked } from '../../models/levels';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { AvatarSaveOutcome, AvatarService } from '../../services/avatar.service';
import { EmbedModeService } from '../../services/embed-mode.service';
import { AvatarComponent } from '../avatar/avatar.component';
import {
  BUILT_AVATAR_SETS,
  DEFAULT_BUILT_SEED,
  builtAvatar,
  builtSeed,
} from '../avatar/built-avatar';
import { IconComponent } from '../icon/icon.component';

/**
 * Which of the card's states is showing — decided in one `computed`, for the
 * reason `ProfileStatsComponent` decides its own that way: the order of these
 * branches is itself the thing a template test cannot reach.
 */
type PickerView = 'loading' | 'signedOut' | 'unverified' | 'failed' | 'ready';

/** The line under the heading — the view, refined by a save in progress or just finished. */
type PickerLine =
  | Exclude<PickerView, 'ready'>
  | 'idle'
  | 'saving'
  | 'saved'
  | 'unavailable'
  | 'saveFailed'
  | 'unconfirmed';

interface KindOption {
  kind: AvatarKind;
  label: string;
  /** What the option draws — built once per draft, so the binding is stable. */
  preview: AvatarChoice;
  /**
   * Whether this account can choose it. Only the photo can be unavailable, and
   * then its cell is still laid out — invisible, with no radio — so the grid
   * keeps three cells whatever the account has.
   */
  available: boolean;
}

interface BuiltOption {
  id: string;
  index: number;
  label: string;
  preview: AvatarChoice;
}

/**
 * What `/profile` knows of the player's XP (`FEAT-041`), which decides the
 * sets above level 0: still being read, not known — a read that failed, or
 * nobody signed in — or known.
 */
export type XpKnowledge =
  | { readonly state: 'checking' }
  | { readonly state: 'unknown' }
  | { readonly state: 'known'; readonly xp: number };

/**
 * Where one set stands for this player. `open` is a set every level has
 * (`core`), and says nothing; `checking` is the XP still being read, and
 * holds the set's tiles still rather than guessing either way
 * (`CLAUDE.md` §4.4).
 */
type SetStatus = 'open' | 'checking' | 'locked' | 'unlocked';

/** One set's two rows, and where the set stands. */
interface SetBlock {
  set: string;
  label: string;
  unlockLevel: number;
  status: SetStatus;
  /** Whether its tiles can be chosen — `aria-disabled` and inert to input when not. */
  choosable: boolean;
  shapes: BuiltOption[];
  palettes: BuiltOption[];
}

/** What the page's live region says when a save ends — shorter than the visible line. */
const ANNOUNCEMENTS: Record<AvatarSaveOutcome, string> = {
  saved: 'Avatar saved.',
  unavailable: 'Avatars cannot be saved on this deployment yet.',
  failed: 'Could not save your avatar.',
  unconfirmed: 'Your avatar could not be confirmed as saved.',
};

const INITIALS_PREVIEW: AvatarChoice = { kind: 'initials', showPublicly: false };
const PHOTO_PREVIEW: AvatarChoice = { kind: 'photo', showPublicly: false };

const builtChoice = (set: string, shapeIndex: number, paletteIndex: number): AvatarChoice => ({
  kind: 'built',
  seed: builtSeed(set, shapeIndex, paletteIndex),
  showPublicly: false,
});

/** `dot` → `Dot`: the tables' ids are the names, so the labels cannot drift from them. */
const labelFor = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

/**
 * The avatar picker on `/profile` (`FEAT-038`): initials, the Google photo, or
 * one the player builds from a shape and a colour — and a switch, off by
 * default, for whether any of it may ever be shown to another player.
 *
 * **Usable in the signed-in state only, and the same height in all five.** An
 * anonymous session has no `users/{uid}` and never will (the callable refuses
 * one, because nothing would ever delete it), and an unverified password
 * account is refused by the same gate `isRealAuthedUser()` applies to every
 * other write a player makes about themselves — so both are told why rather
 * than handed a control that cannot save. The picker is laid out in every
 * state and only shown in one, the messages share one grid cell and so do the
 * three actions: the construction `ProfileStatsComponent` uses, so the card
 * cannot resize when auth or the read resolves (`CLAUDE.md` §4.4).
 *
 * **One save, one round trip.** The controls edit a draft; "Save avatar"
 * commits it through `setAvatar`. While it is in flight every control is
 * `aria-disabled` and inert to input — **not** `disabled`, which would throw
 * focus off the button the reader just pressed and onto `<body>`. The outcome
 * is announced through the page's existing `role="status"` region, via
 * {@link announce}, rather than a second region of the card's own.
 *
 * **A locked set is shown locked, never hidden** (`FEAT-041`). Every set in
 * `BUILT_AVATAR_SETS` is drawn as its own block — its shapes and its colours —
 * and one the player's level has not reached keeps every tile on the page,
 * `aria-disabled` and described by the line that says which level opens it,
 * with clicks, Space and the arrow keys held the way a save in flight holds
 * them. Locked or not, the block is the same markup, so the card is the same
 * height either way. The rule is `isSetUnlocked`, the app's copy of the one
 * `setAvatar` enforces, applied to the XP `/profile` read — never broader than
 * the server, which reads the same field at least as late (`CLAUDE.md` §4.2).
 * A seed already stored stays checked whatever its set's threshold, because
 * `setAvatar` accepts it again: what was granted is never re-locked.
 */
@Component({
  selector: 'app-avatar-picker',
  standalone: true,
  imports: [AvatarComponent, IconComponent],
  templateUrl: './avatar-picker.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AvatarPickerComponent {
  private readonly auth = inject(AuthService);
  private readonly avatars = inject(AvatarService);
  private readonly authMenuState = inject(AuthMenuStateService);
  protected readonly embedMode = inject(EmbedModeService);

  /**
   * What the page knows of the player's XP — the same value its progress card
   * draws, so the card and the locks cannot disagree. `unknown` until the page
   * says otherwise, which holds every set above level 0 locked.
   */
  readonly xp = input<XpKnowledge>({ state: 'unknown' });

  /**
   * Text for the page's live region: empty when a save starts, the outcome
   * when it ends. Empty first, so a second identical outcome is still a change
   * the region announces.
   */
  readonly announce = output<string>();

  /** Focused when a retry starts, because the button pressed is about to be hidden. */
  private readonly statusLine = viewChild<ElementRef<HTMLElement>>('statusLine');

  protected readonly view = computed<PickerView>(() => {
    if (!this.auth.authReady()) {
      return 'loading';
    }
    const user = this.auth.user();
    // `user !== null` is the load-bearing half: `isAnonymous()` reads `false`
    // for no user at all, and a gate on its negation would treat every frame
    // before auth answered as an account (`CLAUDE.md` §4.4).
    if (user === null || user.isAnonymous) {
      return 'signedOut';
    }
    // The client half of `setAvatar`'s caller gate — and the whole of it, so
    // this is never broader than the server's (`CLAUDE.md` §4.2): not
    // anonymous, and verified if it is a password account.
    if (!this.auth.isFullyAuthenticated()) {
      return 'unverified';
    }
    switch (this.avatars.status()) {
      case 'ready':
        return 'ready';
      case 'failed':
        return 'failed';
      default:
        return 'loading';
    }
  });

  protected readonly saving = signal(false);
  private readonly outcome = signal<AvatarSaveOutcome | null>(null);

  protected readonly line = computed<PickerLine>(() => {
    const view = this.view();
    if (view !== 'ready') {
      return view;
    }
    if (this.saving()) {
      return 'saving';
    }
    switch (this.outcome()) {
      case 'saved':
        return 'saved';
      case 'unavailable':
        return 'unavailable';
      case 'failed':
        return 'saveFailed';
      case 'unconfirmed':
        return 'unconfirmed';
      default:
        return 'idle';
    }
  });

  protected readonly letter = computed(() => avatarLetter(this.auth.user()));
  protected readonly photoUrl = this.avatars.photoUrl;

  private readonly stored = computed(() => this.avatars.choice() ?? DEFAULT_AVATAR_CHOICE);

  /**
   * The draft, which starts from the stored choice and starts again whenever
   * that changes — on arrival, on a save landing, on a change of account.
   *
   * A stored `photo` with no photo to show reads as `initials`, because that
   * is what the chip is drawing: the radio checked has to be the picture on
   * screen.
   */
  protected readonly draftKind = linkedSignal<AvatarKind>(() => {
    const kind = this.stored().kind;
    return kind === 'photo' && this.photoUrl() === null ? 'initials' : kind;
  });
  /** Remembered across a switch away from `built`, so switching back finds it. */
  protected readonly draftSeed = linkedSignal(() => {
    const seed = this.stored().seed;
    return builtAvatar(seed) ? (seed as string) : DEFAULT_BUILT_SEED;
  });
  protected readonly draftPublic = linkedSignal(() => this.stored().showPublicly);

  /** The built variant the draft remembers, whichever kind is chosen. */
  protected readonly draftBuilt = computed(() => builtAvatar(this.draftSeed()));

  /**
   * The shape and colour the radios show as checked — only while building.
   * With another kind chosen no shape *is* chosen, and a shape left checked
   * would be a radio a click cannot change: picking the dot that already
   * reads as picked fires no `change`, so the click would build nothing.
   */
  protected readonly builtSelection = computed(() =>
    this.draftKind() === 'built' ? this.draftBuilt() : null,
  );

  /**
   * The three kinds, each drawing itself. Previews are built here rather than
   * by a method called from the template, which would hand the binding a new
   * object on every check — and fail Angular's dev-mode check for it.
   */
  protected readonly kindOptions = computed<KindOption[]>(() => [
    { kind: 'initials', label: 'Initials', preview: INITIALS_PREVIEW, available: true },
    // Offered only to an account that has a photo on the one host the CSP
    // admits: a choice that can only ever resolve to initials is worse than
    // no choice (`FEAT-038` §1). Its cell stays either way — see the template.
    {
      kind: 'photo',
      label: 'Google photo',
      preview: PHOTO_PREVIEW,
      available: this.photoUrl() !== null,
    },
    {
      kind: 'built',
      label: 'Build your own',
      preview: { kind: 'built', seed: this.draftSeed(), showPublicly: false },
      available: true,
    },
  ]);

  /**
   * Every set, as one block of two rows. A set's shapes are drawn in the
   * draft's colour and its colours with the draft's shape when the draft is
   * from that set, and on the set's first otherwise — so a tile shows exactly
   * the avatar choosing it would build.
   */
  protected readonly setBlocks = computed<SetBlock[]>(() => {
    const draft = this.draftBuilt();
    const knowledge = this.xp();
    return Object.entries(BUILT_AVATAR_SETS).map(([set, table]) => {
      const unlockLevel = AVATAR_SET_UNLOCK_LEVELS[set];
      const status: SetStatus =
        unlockLevel === 0
          ? 'open'
          : knowledge.state === 'checking'
            ? 'checking'
            : knowledge.state === 'known' && isSetUnlocked(set, knowledge.xp)
              ? 'unlocked'
              : 'locked';
      const shapeIndex = draft?.set === set ? draft.shapeIndex : 0;
      const paletteIndex = draft?.set === set ? draft.paletteIndex : 0;
      return {
        set,
        label: labelFor(set),
        unlockLevel,
        status,
        choosable: status === 'open' || status === 'unlocked',
        shapes: table.shapes.map((shape, index) => ({
          id: shape.id,
          index,
          label: labelFor(shape.id),
          preview: builtChoice(set, index, paletteIndex),
        })),
        palettes: table.palettes.map((palette, index) => ({
          id: palette.id,
          index,
          label: labelFor(palette.id),
          preview: builtChoice(set, shapeIndex, index),
        })),
      };
    });
  });

  /** Whether a set's tiles can be chosen right now — the template's lock, checked again here. */
  private choosable(set: string): boolean {
    return this.setBlocks().some((block) => block.set === set && block.choosable);
  }

  protected chooseKind(kind: AvatarKind): void {
    if (this.saving()) {
      return;
    }
    this.draftKind.set(kind);
    this.outcome.set(null);
  }

  /**
   * Picking a shape or a colour is building one, so it selects `built` too.
   * The other half of the variant is kept when the draft is already from this
   * set and is the set's first otherwise — what the tile was drawn with.
   */
  protected chooseShape(set: string, shapeIndex: number): void {
    if (this.saving() || !this.choosable(set)) {
      return;
    }
    const draft = this.draftBuilt();
    this.draftSeed.set(builtSeed(set, shapeIndex, draft?.set === set ? draft.paletteIndex : 0));
    this.draftKind.set('built');
    this.outcome.set(null);
  }

  protected choosePalette(set: string, paletteIndex: number): void {
    if (this.saving() || !this.choosable(set)) {
      return;
    }
    const draft = this.draftBuilt();
    this.draftSeed.set(builtSeed(set, draft?.set === set ? draft.shapeIndex : 0, paletteIndex));
    this.draftKind.set('built');
    this.outcome.set(null);
  }

  protected choosePublic(showPublicly: boolean): void {
    if (this.saving()) {
      return;
    }
    this.draftPublic.set(showPublicly);
    this.outcome.set(null);
  }

  /**
   * Stops a pointer or Space from changing a control while a save is in
   * flight. Cancelling the `click` is what reverts a native radio or checkbox
   * — the browser restores the previous state when activation is cancelled.
   */
  protected holdWhileSaving(event: Event): void {
    if (this.saving()) {
      event.preventDefault();
    }
  }

  /** Arrow keys move a radio group's selection natively; held the same way. */
  protected holdKeysWhileSaving(event: KeyboardEvent): void {
    if (this.saving() && (event.key.startsWith('Arrow') || event.key === ' ')) {
      event.preventDefault();
    }
  }

  /**
   * A built tile's two holds: a save in flight, as every control has, and a
   * set the player has not unlocked. Cancelling the `click` reverts the radio,
   * and cancelling the arrow keys and Space stops one being checked by
   * keyboard — so a locked tile can be reached, read and never chosen.
   */
  protected holdBuiltClick(event: Event, block: SetBlock): void {
    if (this.saving() || !block.choosable) {
      event.preventDefault();
    }
  }

  protected holdBuiltKeys(event: KeyboardEvent, block: SetBlock): void {
    if (!block.choosable && (event.key.startsWith('Arrow') || event.key === ' ')) {
      event.preventDefault();
      return;
    }
    this.holdKeysWhileSaving(event);
  }

  protected async save(): Promise<void> {
    if (this.saving() || this.view() !== 'ready') {
      return;
    }
    const kind = this.draftKind();
    const choice: AvatarChoice =
      kind === 'built'
        ? { kind, seed: this.draftSeed(), showPublicly: this.draftPublic() }
        : { kind, showPublicly: this.draftPublic() };

    this.saving.set(true);
    this.outcome.set(null);
    this.announce.emit('');
    const outcome = await this.avatars.save(choice);
    this.saving.set(false);
    this.outcome.set(outcome);
    this.announce.emit(ANNOUNCEMENTS[outcome]);
  }

  /**
   * Re-reads after a failed read. Focus moves to the status line first, for
   * the reason `ProfileStatsComponent.retry()` gives: the retry hides the
   * button it was pressed from, and focus left on a hidden element drops to
   * `<body>` silently (`CLAUDE.md` §4.4).
   */
  protected retry(): void {
    this.statusLine()?.nativeElement.focus();
    this.avatars.retry();
  }

  protected openSignIn(): void {
    this.authMenuState.open();
  }
}
