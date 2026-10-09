import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Quiz } from '../../models/quiz.model';
import { ConnectivityService } from '../../services/connectivity.service';
import { QuizService } from '../../services/quiz.service';
import { msg, type Message } from '../../i18n/message';
import { TPipe } from '../../i18n/t.pipe';
import { IconComponent } from '../icon/icon.component';

/** Shown in the strip and said by the live region, so one message for both. */
const EMPTY = msg('quizzes.empty', 'No quizzes have been published yet.');
const FAILED = msg('quizzes.failed', 'The quizzes could not be loaded.');

/**
 * Which of the list's states is showing. `idle` is "not asked yet": the list
 * reads nothing until it is scrolled into view, and looks exactly like
 * `loading` until then, so nothing changes when the read starts.
 */
type QuizListView = 'idle' | 'loading' | 'ready' | 'empty' | 'failed';

/**
 * How much of the section has to be on screen before it reads.
 *
 * Above zero on purpose. The block above is `min-h-screen`, so this section
 * starts at least one screen down — a top bar's height below the fold
 * normally, and **exactly at the bottom edge** of the first screen in an embed,
 * which has no top bar (`EmbedModeService`). An observer counts a target
 * touching the viewport's edge as intersecting with a ratio of 0, so a
 * threshold of 0 would read on every embedded page load and spend the very read
 * the trigger exists to save. A sliver of a few pixels is the reader actually
 * scrolling to it.
 */
const VISIBLE_THRESHOLD = 0.01;

/** How many placeholder cards hold the strip's shape before there is anything to show. */
const PLACEHOLDER_CARDS = 3;

/**
 * The curated quizzes on `/` (`FEAT-024`), below the setup card and below the
 * first screen.
 *
 * **Below the fold, so it can never move the card.** It is a sibling after the
 * setup screen's `min-h-screen` block rather than a child of it: that block is
 * vertically centred, and anything added inside it — or a list arriving inside
 * it — would lift the card by half its own height (`CLAUDE.md` §4.4). Out here
 * the card is laid out exactly as it was before quizzes existed, at every
 * viewport.
 *
 * **It reads when it is scrolled to, not on every visit.** `/` reads nothing
 * else on arrival, and most visitors never scroll this far, so the list is one
 * bounded query (`QUIZ_LIST_LIMIT`) paid by the people who look at it. Its
 * first sight is the placeholder strip, which is the same size as every other
 * state.
 *
 * **The strip is one fixed height in every state.** Quiz cards are a fixed size
 * with their text clamped, and they scroll sideways rather than wrap, so ten
 * quizzes, one quiz, the loading placeholders and the empty and failed messages
 * all occupy the same box — the messages laid over invisible placeholders, the
 * way the game-over board lays its message over reserved rows.
 *
 * **Offline, a card says it needs a connection and does nothing.** Opening a
 * quiz takes the network twice over: its page is a lazy chunk outside the
 * precache, and the quiz itself is a Firestore read. A plain link would fail
 * there without saying so — its navigation waits on a chunk that cannot load,
 * so nothing appears, the address stays put and the only trace is `Failed to
 * fetch dynamically imported module` in the console — and would go on failing
 * once the connection is back, because Chromium keeps a failed dynamic import
 * in its module map until the page is reloaded. So while
 * `ConnectivityService` says offline, every card is a disabled link instead:
 * no `href`, so a tap goes nowhere and fetches nothing, `role="link"` with
 * `aria-disabled` so it is still announced as the link it is, and the reason
 * in place of the question count. The connection coming back re-enables
 * them, with nothing to re-read — the list already holds them. The reason and
 * the count share one cell, so neither state moves anything inside a card
 * that is a fixed size anyway (`CLAUDE.md` §4.4).
 */
@Component({
  selector: 'app-quiz-list',
  standalone: true,
  imports: [RouterLink, IconComponent, TPipe],
  templateUrl: './quiz-list.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuizListComponent {
  private readonly quizService = inject(QuizService);
  protected readonly connectivity = inject(ConnectivityService);

  private readonly section = viewChild.required<ElementRef<HTMLElement>>('section');

  /** The heading, focused when a retry starts — the "Try again" button is about to go. */
  private readonly heading = viewChild.required<ElementRef<HTMLElement>>('heading');

  private readonly quizzesSignal = signal<Quiz[]>([]);
  private readonly viewSignal = signal<QuizListView>('idle');

  protected readonly view = this.viewSignal.asReadonly();
  protected readonly quizzes = this.quizzesSignal.asReadonly();

  /** Whether the cards are disabled: a quiz cannot be opened without a connection. */
  protected readonly offline = computed(() => !this.connectivity.isOnline());
  protected readonly placeholders = Array.from({ length: PLACEHOLDER_CARDS }, (_, index) => index);

  /** What the live region says once the read lands. Nothing while idle or loading. */
  protected readonly announcement = computed<Message | null>(() => {
    switch (this.view()) {
      case 'ready':
        return msg('quizzes.said', '{n, plural, one {# quiz.} other {# quizzes.}}', {
          n: this.quizzes().length,
        });
      case 'empty':
        return EMPTY;
      case 'failed':
        return FAILED;
      default:
        return null;
    }
  });

  protected readonly emptyMessage = EMPTY;
  protected readonly failedMessage = FAILED;

  constructor() {
    const destroyRef = inject(DestroyRef);
    // After the first render, because the observer needs the element — and
    // browser-only by construction, since `afterNextRender` does not run on a
    // server.
    afterNextRender(() => {
      // Where there is no IntersectionObserver at all (jsdom, a very old
      // browser) the list reads straight away: it costs the read the trigger
      // would have saved, never the list.
      if (typeof IntersectionObserver !== 'function') {
        void this.load();
        return;
      }
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0)) {
            observer.disconnect();
            void this.load();
          }
        },
        { threshold: VISIBLE_THRESHOLD },
      );
      observer.observe(this.section().nativeElement);
      // Torn down with the component as well as on first sight (`CLAUDE.md`
      // §4.4) — leaving `/` before scrolling down must not leave it watching.
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  protected countLabel(quiz: Quiz): Message {
    return msg('quizzes.questions', '{n, plural, one {# question} other {# questions}}', {
      n: quiz.questionIds.length,
    });
  }

  /**
   * Re-reads after a failure. Focus moves to the heading first, because the
   * button that called this is hidden the moment the read starts and focus on a
   * hidden element drops to `<body>` (`CLAUDE.md` §4.4).
   */
  protected retry(): void {
    this.heading().nativeElement.focus();
    void this.load();
  }

  private async load(): Promise<void> {
    this.viewSignal.set('loading');
    try {
      const quizzes = await this.quizService.listPublished();
      this.quizzesSignal.set(quizzes);
      this.viewSignal.set(quizzes.length > 0 ? 'ready' : 'empty');
    } catch (error) {
      // "No quizzes yet" is a claim about the collection, and a read that
      // never answered has established nothing about it (`CLAUDE.md` §4.4).
      //
      // A warning, not an error, and deliberately so. The list is optional and
      // already says it failed, with a retry; and this is `/`, whose console
      // is kept free of errors — Lighthouse asserts `errors-in-console` there,
      // and `sound-effects.spec.ts` fails a round on any script error. A short
      // window scrolls the list into view on the way to Start Game, so a list
      // that could not load would otherwise put an error in front of both.
      console.warn('[quizzes] could not read the published quizzes', error);
      this.viewSignal.set('failed');
    }
  }
}
