/**
 * Keeps Tab inside a modal dialog, in both directions.
 *
 * `aria-modal="true"` is a promise to assistive tech and nothing more — the
 * page behind is still rendered and still focusable, so without a trap Tab
 * walks straight out of the dialog (`CLAUDE.md` §4.5). Three plausible ways of
 * writing this do not work, and all three are avoided here rather than
 * rediscovered per dialog:
 *
 * - **It must be bound to a plain `(keydown)`**, never Angular's
 *   `keydown.tab`, which does not fire while Shift is held — the direction
 *   that escapes backwards past the first control ends up with no handler at
 *   all. That binding is the caller's to get right; this helper only reads the
 *   event.
 * - **No visibility filter on the selector.** The usual idiom,
 *   `offsetParent !== null`, returns null for any `position: fixed` element —
 *   which a dialog is — and is unimplemented in jsdom, so it silently empties
 *   the list and the trap degrades to bouncing everything back to the dialog.
 *   Templates that remove controls with `@if` rather than hiding them need no
 *   filter; `:not([disabled])` covers the rest.
 * - **The dialog element itself counts as "the first control"** for the
 *   backwards case, because focus is moved to it on open so it is announced
 *   with its title before Tab reaches anything inside.
 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), ' +
  'select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function keepTabInside(event: KeyboardEvent, dialog: HTMLElement | undefined): void {
  if (event.key !== 'Tab' || !dialog) {
    return;
  }

  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && (active === first || active === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
