import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
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
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { AvatarSaveOutcome, AvatarService } from '../../services/avatar.service';
import { EmbedModeService } from '../../services/embed-mode.service';
import { AvatarComponent } from '../avatar/avatar.component';
import {
  BUILT_AVATAR_SETS,
  DEFAULT_BUILT_SEED,
  DEFAULT_BUILT_SET,
  builtAvatar,
  builtSeed,
} from '../avatar/built-avatar';

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

/** What the page's live region says when a save ends — shorter than the visible line. */
const ANNOUNCEMENTS: Record<AvatarSaveOutcome, string> = {
  saved: 'Avatar saved.',
  unavailable: 'Avatars cannot be saved on this deployment yet.',
  failed: 'Could not save your avatar.',
  unconfirmed: 'Your avatar could not be confirmed as saved.',
};

const CORE = BUILT_AVATAR_SETS[DEFAULT_BUILT_SET];

const INITIALS_PREVIEW: AvatarChoice = { kind: 'initials', showPublicly: false };
const PHOTO_PREVIEW: AvatarChoice = { kind: 'photo', showPublicly: false };

const builtChoice = (shapeIndex: number, paletteIndex: number): AvatarChoice => ({
  kind: 'built',
  seed: builtSeed(DEFAULT_BUILT_SET, shapeIndex, paletteIndex),
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
 */
@Component({
  selector: 'app-avatar-picker',
  standalone: true,
  imports: [AvatarComponent],
  templateUrl: './avatar-picker.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AvatarPickerComponent {
  private readonly auth = inject(AuthService);
  private readonly avatars = inject(AvatarService);
  private readonly authMenuState = inject(AuthMenuStateService);
  protected readonly embedMode = inject(EmbedModeService);

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

  /** Each shape, drawn in the draft's colour. */
  protected readonly shapeOptions = computed<BuiltOption[]>(() => {
    const palette = this.draftBuilt()?.paletteIndex ?? 0;
    return CORE.shapes.map((shape, index) => ({
      id: shape.id,
      index,
      label: labelFor(shape.id),
      preview: builtChoice(index, palette),
    }));
  });

  /** Each colour, drawn with the draft's shape. */
  protected readonly paletteOptions = computed<BuiltOption[]>(() => {
    const shape = this.draftBuilt()?.shapeIndex ?? 0;
    return CORE.palettes.map((palette, index) => ({
      id: palette.id,
      index,
      label: labelFor(palette.id),
      preview: builtChoice(shape, index),
    }));
  });

  protected chooseKind(kind: AvatarKind): void {
    if (this.saving()) {
      return;
    }
    this.draftKind.set(kind);
    this.outcome.set(null);
  }

  /** Picking a shape or a colour is building one, so it selects `built` too. */
  protected chooseShape(shapeIndex: number): void {
    if (this.saving()) {
      return;
    }
    this.draftSeed.set(
      builtSeed(DEFAULT_BUILT_SET, shapeIndex, this.draftBuilt()?.paletteIndex ?? 0),
    );
    this.draftKind.set('built');
    this.outcome.set(null);
  }

  protected choosePalette(paletteIndex: number): void {
    if (this.saving()) {
      return;
    }
    this.draftSeed.set(
      builtSeed(DEFAULT_BUILT_SET, this.draftBuilt()?.shapeIndex ?? 0, paletteIndex),
    );
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
