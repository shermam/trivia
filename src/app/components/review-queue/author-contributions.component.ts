import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  OnInit,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CustomQuestionDoc } from '../../models/question.model';
import {
  AUTHOR_PAGE_SIZE,
  BulkDecisionOutcome,
  FirebaseService,
  MAX_REJECTION_REASON_LENGTH,
  UserQuestionCursor,
} from '../../services/firebase.service';
import { topicTagsOf } from '../../utils/category-tags';
import { IconComponent } from '../icon/icon.component';
import { QuestionTagsComponent } from '../question-tags/question-tags.component';
import { RenderedTextComponent } from '../rendered-text/rendered-text.component';
import { msg, verbatim, type Message } from '../../i18n/message';
import { TPipe } from '../../i18n/t.pipe';
import { difficultyLabel } from '../../utils/difficulty-label.util';

type ReviewQuestion = CustomQuestionDoc & { id: string };

/** What a bulk action did, for the queue to bring its own copies of these questions up to date. */
export interface BulkRejection {
  ids: readonly string[];
  reason: string;
}

/**
 * Where each page of the set starts: `undefined` for the newest page, then the
 * cursor every later page was read from. Its length less one is the page on
 * screen.
 */
type PageStarts = readonly (UserQuestionCursor | undefined)[];

/** Which of the status block's messages is showing. */
export type AuthorStatusView = 'loading' | 'failed' | 'empty' | 'loaded';

/** Which of the selection line's messages is showing. */
export type SelectionLineView = 'count' | 'nothing-to-reject' | 'progress' | 'outcome' | 'error';

/**
 * The selection line has to be as tall as the longest thing it can say, or the
 * list under it moves the moment an outcome lands (`CLAUDE.md` §4.4). That
 * sentence is a partial failure, and its length depends on the numbers in it,
 * so the reserved copy is written with the widest numbers a page can produce.
 */
const LONGEST_OUTCOME = partialOutcome(AUTHOR_PAGE_SIZE, AUTHOR_PAGE_SIZE, AUTHOR_PAGE_SIZE);

/**
 * The reason box's two errors. Named here rather than in the template because
 * the template reserves a line for whichever is longer — invisible copies of
 * both, stacked in the cell the showing one lands in — so the Reject button
 * under them and every row below stay put when one appears or clears
 * (`CLAUDE.md` §4.4).
 */
const REASON_MISSING = msg(
  'author.reasonMissing',
  'Give a reason — it is shown to the author on every question this rejects.',
);
const REASON_TOO_LONG = msg('author.reasonTooLong', 'A reason must be {max} characters or fewer.', {
  max: MAX_REJECTION_REASON_LENGTH,
});
const SELECT_ONE = msg('author.selectOne', 'Select at least one question to reject.');

/**
 * A rejected question is not selectable: the action this view offers is
 * rejecting, and a question already rejected has nothing left to reject.
 * Re-rejecting it would only overwrite whatever note a reviewer already left
 * its author — a change the Rejected tab's "Update reason" makes on purpose,
 * one question at a time.
 */
function isSelectable(question: ReviewQuestion): boolean {
  return question.status !== 'rejected';
}

/**
 * The sentence a bulk action ends with, honest about a partial failure
 * rather than reporting the whole set as failed or as done (`FEAT-006`).
 *
 * "Could not be confirmed", never "was not saved": a write that timed out may
 * still have landed, and narrating a cause nobody checked is what `CLAUDE.md`
 * §4.4 forbids. Retrying is safe either way, which is why the unconfirmed ones
 * stay selected.
 */
export function describeOutcome(succeeded: number, total: number): Message {
  const failed = total - succeeded;
  if (failed === 0) {
    return msg(
      'author.outcomeAll',
      '{n, plural, one {Rejected # question.} other {Rejected # questions.}}',
      { n: succeeded },
    );
  }
  if (succeeded === 0) {
    return total === 1
      ? msg(
          'author.outcomeNoneOne',
          'That question could not be confirmed and is still selected — try again.',
        )
      : msg(
          'author.outcomeNone',
          'None of the {total} could be confirmed. They are still selected — try again.',
          { total },
        );
  }
  return partialOutcome(succeeded, total, failed);
}

/** Some landed and some did not — the selection line's longest sentence. */
function partialOutcome(succeeded: number, total: number, failed: number): Message {
  return msg(
    'author.outcomePartial',
    '{failed, plural, one {Rejected {succeeded} of {total}. # could not be confirmed and is still selected — try again.} other {Rejected {succeeded} of {total}. # could not be confirmed and are still selected — try again.}}',
    { succeeded, total, failed },
  );
}

/**
 * Everything one account has contributed, for a reviewer (`FEAT-006`) — the
 * abuse-tooling slice of the moderation spec: one bounded list across every
 * status, and one action on the set rather than one row at a time.
 *
 * **Reached from a question, never from a uid.** The queue opens this from a
 * card's "Everything this account contributed", and the account is named on
 * screen by that question — the uid is held to query by and rendered nowhere
 * in this view.
 *
 * **One action, and nothing destructive.** Rejecting with a reason is the same
 * `status` + `rejectionReason` write a single decision makes, issued once per
 * selected document; it stops a question being served and shows the author
 * why, and a reviewer can approve any of them again from the Rejected tab.
 * There is no delete and no account action — suspending or deleting an account
 * is the owner's job in the Firebase console, and the view says so.
 *
 * **A page at a time, and a selection never leaves its page.** Paging replaces
 * the list rather than appending to it, and clears the selection, so the most
 * one action can name is one page — {@link AUTHOR_PAGE_SIZE}, the review page
 * size — and `FirebaseService.rejectQuestions` refuses more regardless.
 *
 * Reviewer-gated by where it is mounted: only the queue's reviewer branch
 * renders it, gated on the same `user_roles` document `firestore.rules` reads.
 * The rules decide whether its read and its writes do anything.
 */
@Component({
  selector: 'app-author-contributions',
  standalone: true,
  imports: [IconComponent, QuestionTagsComponent, RenderedTextComponent, TPipe],
  templateUrl: './author-contributions.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthorContributionsComponent implements OnInit {
  private readonly firebaseService = inject(FirebaseService);
  private readonly injector = inject(Injector);

  /** Whose contributions. A filter value, never rendered (`FEAT-006` §0). */
  readonly authorUid = input.required<string>();

  /** The question the view was opened from — how the screen names the account without a uid. */
  readonly anchor = input.required<ReviewQuestion>();

  /** The tab "Back" returns to, in the picker's own words. */
  readonly returnLabel = input.required<Message>();

  /** "Back" was pressed. */
  readonly closed = output<void>();

  /** These questions are now rejected with this reason, so the queue's copies of them are stale. */
  readonly rejected = output<BulkRejection>();

  protected readonly pageSize = AUTHOR_PAGE_SIZE;
  protected readonly maxReasonLength = MAX_REJECTION_REASON_LENGTH;
  protected readonly longestOutcome = LONGEST_OUTCOME;
  protected readonly reasonMissing = REASON_MISSING;
  protected readonly reasonTooLong = REASON_TOO_LONG;

  protected readonly rows = signal<ReviewQuestion[]>([]);
  private readonly pageStarts = signal<PageStarts>([undefined]);
  protected readonly pageIndex = computed(() => this.pageStarts().length - 1);
  protected readonly next = signal<UserQuestionCursor | null>(null);
  protected readonly isLoading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly hasPages = computed(() => this.pageIndex() > 0 || this.next() !== null);

  /**
   * A load superseded by a later one drops its answer: two pages are one click
   * apart, and the network would otherwise decide which one renders.
   */
  private loadSequence = 0;

  /** The page a failed load was asking for, so "Try again" asks for it again. */
  private failedStarts: PageStarts | null = null;

  /**
   * Which of the status block's messages is showing. A failed read outranks an
   * empty one: "nothing from this account" is a claim about the bank, and a
   * read that was refused or timed out is not evidence for it (`CLAUDE.md`
   * §4.4).
   */
  protected readonly statusView = computed<AuthorStatusView>(() => {
    if (this.isLoading()) {
      return 'loading';
    }
    if (this.loadFailed()) {
      return 'failed';
    }
    return this.rows().length === 0 ? 'empty' : 'loaded';
  });

  /**
   * What the loaded page is — "Page 2: 50 contributions, newest first." — and
   * the sentence the status block says when a page arrives, which is why the
   * page number is in it only once there is more than one page.
   */
  protected readonly pageLabel = computed(() => {
    const n = this.rows().length;
    return this.hasPages()
      ? msg(
          'author.pageOf',
          '{n, plural, one {Page {page}: # contribution, newest first.} other {Page {page}: # contributions, newest first.}}',
          { n, page: this.pageIndex() + 1 },
        )
      : msg(
          'author.page',
          '{n, plural, one {# contribution, newest first.} other {# contributions, newest first.}}',
          { n },
        );
  });

  /** The selection, by document id. It belongs to the page on screen and is cleared with it. */
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly selectable = computed(() => this.rows().filter(isSelectable));
  protected readonly selectedCount = computed(() => this.selected().size);
  protected readonly allSelected = computed(() => {
    const selectable = this.selectable();
    return (
      selectable.length > 0 && selectable.every((question) => this.selected().has(question.id))
    );
  });
  protected readonly someSelected = computed(() => this.selectedCount() > 0 && !this.allSelected());

  /** The one reason every question this rejects is given. Required — see {@link reasonError}. */
  protected readonly reason = signal('');

  /** Whether Reject has been pressed since the last action finished — what makes a missing input an error. */
  private readonly attempted = signal(false);

  protected readonly inFlight = signal(false);
  protected readonly progress = signal<{ done: number; total: number } | null>(null);
  protected readonly outcome = signal<Message | null>(null);

  /**
   * Announced through a permanent `role="status"` region (`CLAUDE.md` §4.5):
   * a bulk action changes rows all over the list at once, which is silent to
   * assistive tech otherwise.
   */
  protected readonly announcement = signal<Message | null>(null);

  protected readonly isBusy = computed(() => this.isLoading() || this.inFlight());

  protected readonly reasonError = computed(() => {
    const length = this.reason().trim().length;
    if (length > MAX_REJECTION_REASON_LENGTH) {
      return REASON_TOO_LONG;
    }
    if (this.attempted() && length === 0) {
      return REASON_MISSING;
    }
    return null;
  });

  protected readonly selectionError = computed(() =>
    this.attempted() && this.selectedCount() === 0 ? SELECT_ONE : null,
  );

  protected readonly selectOne = SELECT_ONE;
  protected readonly difficultyLabel = difficultyLabel;

  /** The selection line's face. In flight wins, then an error the reviewer has to act on. */
  protected readonly selectionLine = computed<SelectionLineView>(() => {
    if (this.inFlight()) {
      return 'progress';
    }
    if (this.selectionError()) {
      return 'error';
    }
    if (this.outcome()) {
      return 'outcome';
    }
    return this.selectable().length === 0 ? 'nothing-to-reject' : 'count';
  });

  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly statusBlock = viewChild<ElementRef<HTMLElement>>('statusBlock');
  private readonly selectAllBox = viewChild<ElementRef<HTMLInputElement>>('selectAll');
  private readonly reasonBox = viewChild<ElementRef<HTMLTextAreaElement>>('reasonBox');

  /**
   * Whether the view has gone — signed out mid-action, or navigated away from
   * `/review` — while its writes were still out. They land regardless; there is
   * just nobody left to tell, and an output emitted after its owner is
   * destroyed is a console warning rather than a message.
   */
  private destroyed = false;

  constructor() {
    // The view replaces the queue under the reader, so focus moves to its
    // heading and it is announced by name. After the render, because the
    // heading does not exist until the template has run (`CLAUDE.md` §4.4).
    afterNextRender(() => this.heading()?.nativeElement.focus(), { injector: this.injector });
    inject(DestroyRef).onDestroy(() => (this.destroyed = true));
  }

  ngOnInit(): void {
    void this.loadPage([undefined]);
  }

  private async loadPage(starts: PageStarts): Promise<void> {
    const sequence = ++this.loadSequence;
    this.isLoading.set(true);
    this.loadFailed.set(false);
    try {
      const page = await this.firebaseService.getQuestionsByAuthor(this.authorUid(), starts.at(-1));
      if (sequence !== this.loadSequence) {
        return;
      }
      this.pageStarts.set(starts);
      this.rows.set(page.questions);
      this.next.set(page.next);
      // A selection belongs to the page it was made on. Keeping it across a
      // page change would let one action name questions the reviewer can no
      // longer see — and more than one page of them.
      this.selected.set(new Set());
      this.outcome.set(null);
      this.attempted.set(false);
      this.failedStarts = null;
    } catch {
      // Generic, for the reason every read in the queue is: a refusal, a
      // timeout and a dead network are indistinguishable from here, so the
      // message is a fixed sentence in the template — which also means its
      // face holds its height from first paint. The rows already on screen
      // stay: they are a page that did load.
      if (sequence === this.loadSequence) {
        this.failedStarts = starts;
        this.loadFailed.set(true);
      }
    } finally {
      if (sequence === this.loadSequence) {
        this.isLoading.set(false);
      }
    }
  }

  /**
   * The next page, older than this one.
   *
   * **Focus moves before the read starts**, because starting it disables the
   * button that was pressed, and focus on a control that stops being focusable
   * drops silently to `<body>` (`CLAUDE.md` §4.4). The status block is the
   * target: it is present in every state, and it carries the sentence that
   * says which page arrived.
   */
  protected older(): void {
    const next = this.next();
    if (next === null || this.isBusy()) {
      return;
    }
    this.focusStatus();
    void this.loadPage([...this.pageStarts(), next]);
  }

  /** The previous page, newer than this one. Focus moves first, for the reason {@link older} gives. */
  protected newer(): void {
    if (this.pageIndex() === 0 || this.isBusy()) {
      return;
    }
    this.focusStatus();
    void this.loadPage(this.pageStarts().slice(0, -1));
  }

  /** Asks again for the page that failed. Focus moves first: "Try again" is about to be hidden. */
  protected retry(): void {
    if (this.isBusy()) {
      return;
    }
    this.focusStatus();
    void this.loadPage(this.failedStarts ?? this.pageStarts());
  }

  protected back(): void {
    // Not while writes are in flight: the outcome would land on a view that is
    // gone, and the queue would be told about decisions it never sees settle.
    if (this.inFlight()) {
      return;
    }
    this.closed.emit();
  }

  protected isSelected(question: ReviewQuestion): boolean {
    return this.selected().has(question.id);
  }

  protected canSelect(question: ReviewQuestion): boolean {
    return isSelectable(question) && !this.isBusy();
  }

  protected toggle(question: ReviewQuestion, checked: boolean): void {
    if (!this.canSelect(question)) {
      return;
    }
    this.selected.update((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(question.id);
      } else {
        next.delete(question.id);
      }
      return next;
    });
    this.outcome.set(null);
  }

  /** Selects every question on this page that can be rejected, or clears the selection if all are. */
  protected toggleAll(): void {
    if (this.isBusy() || this.selectable().length === 0) {
      return;
    }
    const clearing = this.allSelected();
    this.selected.set(
      clearing ? new Set() : new Set(this.selectable().map((question) => question.id)),
    );
    this.outcome.set(null);
    this.announcement.set(
      clearing
        ? msg('author.cleared', 'Selection cleared.')
        : msg('author.selectedAll', '{count} selected on this page.', {
            count: this.selectedCount(),
          }),
    );
  }

  protected setReason(value: string): void {
    this.reason.set(value);
  }

  /**
   * Rejects the selection, one write per question, with the one reason.
   *
   * What is wrong is said and focused rather than refused quietly — no
   * selection, no reason, a reason the rules would refuse — the same contract
   * as the contribute form. On the way back the rows that were rejected change
   * status where they stand, the ones that could not be confirmed **stay
   * selected**, so pressing Reject again is the retry, and the sentence says
   * which is which.
   *
   * The button keeps focus throughout: it is `aria-disabled` rather than
   * `disabled` while the writes are out, because disabling the focused control
   * would drop focus to `<body>` (`CLAUDE.md` §4.4).
   */
  protected async rejectSelected(): Promise<void> {
    if (this.isBusy()) {
      return;
    }
    this.attempted.set(true);
    this.outcome.set(null);

    const ids = this.selectable()
      .filter((question) => this.selected().has(question.id))
      .map((question) => question.id);
    const reason = this.reason().trim();
    if (ids.length === 0) {
      this.selectAllBox()?.nativeElement.focus();
      return;
    }
    if (reason.length === 0 || reason.length > MAX_REJECTION_REASON_LENGTH) {
      this.reasonBox()?.nativeElement.focus();
      return;
    }

    this.inFlight.set(true);
    this.progress.set({ done: 0, total: ids.length });
    this.announcement.set(null);
    let outcome: BulkDecisionOutcome;
    try {
      outcome = await this.firebaseService.rejectQuestions(ids, reason, (done, total) =>
        this.progress.set({ done, total }),
      );
    } catch {
      // Only a bound the checks above already enforce throws here, and it
      // throws before any write is sent — so nothing landed.
      outcome = { succeeded: [], failed: ids };
    }

    const landed = new Set(outcome.succeeded);
    this.rows.update((rows) =>
      rows.map((question) =>
        landed.has(question.id)
          ? { ...question, status: 'rejected', rejectionReason: reason }
          : question,
      ),
    );
    this.selected.set(new Set(outcome.failed));
    if (outcome.succeeded.length > 0 && !this.destroyed) {
      this.rejected.emit({ ids: outcome.succeeded, reason });
    }
    const message = describeOutcome(outcome.succeeded.length, ids.length);
    this.outcome.set(message);
    this.announcement.set(message);
    this.attempted.set(false);
    this.progress.set(null);
    this.inFlight.set(false);
  }

  protected topicsOf(question: ReviewQuestion): string[] {
    return topicTagsOf(question);
  }

  protected submittedAt(question: ReviewQuestion): Message {
    return question.createdAt
      ? verbatim(new Date(question.createdAt).toLocaleString())
      : msg('author.unknownDate', 'Unknown');
  }

  private focusStatus(): void {
    this.statusBlock()?.nativeElement.focus();
  }
}
