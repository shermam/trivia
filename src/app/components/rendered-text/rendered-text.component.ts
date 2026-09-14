import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { QuestionFormat } from '../../models/question.model';
import { containsMath } from './math-delimiters';

/**
 * The engine modules, fetched the first time something actually needs them and
 * remembered afterwards.
 *
 * **The `catch` that clears the cache is the whole point** (`CLAUDE.md` §4.4, a
 * rule this repo has already broken twice). A memoized promise with no reset
 * turns one failed chunk fetch — a deploy mid-session, a flaky connection —
 * into a session that renders every Markdown question as source text until the
 * tab is closed. Clearing it means the next question retries.
 */
let markdownEngine: Promise<typeof import('./markdown-engine')> | null = null;
let mathEngine: Promise<typeof import('./math-engine')> | null = null;

function loadMarkdownEngine(): Promise<typeof import('./markdown-engine')> {
  markdownEngine ??= import('./markdown-engine').catch((error: unknown) => {
    markdownEngine = null;
    throw error;
  });
  return markdownEngine;
}

function loadMathEngine(): Promise<typeof import('./math-engine')> {
  mathEngine ??= import('./math-engine').catch((error: unknown) => {
    mathEngine = null;
    throw error;
  });
  return mathEngine;
}

/**
 * Renders one piece of question text — a prompt, an answer, a justification —
 * as Markdown with LaTeX math when the document says so, and as plain text
 * when it does not (`FEAT-019`).
 *
 * **One component, not a pipe called from five templates.** The allowlist, the
 * MathML handling and the prose styles are the feature; a pipe would let the
 * screen a reviewer approves from and the screen a player sees drift apart,
 * which is precisely the drift that makes a review meaningless.
 *
 * ## Three things about it that are load-bearing
 *
 * **A plain question costs nothing.** `marked`, `dompurify` and `katex` are
 * reached through `import()` and only on the branch that needs them, so the
 * home route's bundle — which sits on a Lighthouse budget — does not grow, and
 * neither does the first paint of a game made entirely of Open Trivia
 * questions. KaTeX is a second fetch behind a second condition: the source has
 * to contain a delimiter (`math-delimiters.ts`), because KaTeX is much the
 * larger of the two and most Markdown carries no math at all.
 *
 * **It never renders nothing.** Until the engine arrives, and forever if it
 * never does, the component renders the source text — readable, if unformatted.
 * A blank question is unrecoverable for the reader; a formula written as
 * `$x^2$` is merely ugly. The same applies inside the engine: an unparseable
 * formula falls back to its own source rather than blanking the line.
 *
 * **The format value is not trusted to be one of two strings.** Firestore is a
 * public API and `firestore.rules` is one deploy from being widened, so
 * anything that is not exactly `'markdown'` renders as plain text
 * (`CLAUDE.md` §4.4: be right regardless of the writer).
 *
 * ## Where it may be placed
 *
 * Block mode emits a `<div>`, so its host must be flow content: the callers
 * that used to wrap the text in a `<p>` now use a `<div>`, and the quiz loop's
 * question heading is a `<div role="heading" aria-level="2">` rather than an
 * `<h2>`, which is the same thing to a screen reader and can legally contain a
 * code block. `[inline]` emits a `<span>` and parses with no block constructs
 * at all, which is what an answer option inside a `<button>` needs.
 */
@Component({
  selector: 'app-rendered-text',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (inline()) {
      @if (html() !== null) {
        <span
          #target
          class="rendered-text rendered-text--inline"
          data-cy="rendered-text"
          data-rendered="markdown"
        ></span>
      } @else {
        <span
          class="rendered-text rendered-text--inline"
          data-cy="rendered-text"
          [attr.data-rendered]="pendingState()"
          [textContent]="text()"
        ></span>
      }
    } @else {
      @if (html() !== null) {
        <div #target class="rendered-text" data-cy="rendered-text" data-rendered="markdown"></div>
      } @else {
        <!-- Bound rather than interpolated, on both plain branches, because
             the plain box is white-space: pre-line: interpolation puts the
             template's own indentation inside the element, where a formatter
             is free to move it and a preserveWhitespaces build would render it
             as a leading blank line. A property binding carries the string and
             nothing else. It is not the innerHTML above by another name —
             textContent never parses markup. -->
        <div
          class="rendered-text rendered-text--plain"
          data-cy="rendered-text"
          [attr.data-rendered]="pendingState()"
          [textContent]="text()"
        ></div>
      }
    }
  `,
})
export class RenderedTextComponent {
  readonly text = input.required<string>();

  /**
   * The document's `format` field, straight from Firestore. `undefined` — the
   * overwhelmingly common case — means plain, as does any value that is not
   * exactly `'markdown'`.
   */
  readonly format = input<QuestionFormat | undefined>(undefined);

  /** Render as a run of text: no paragraphs, no lists, no fenced code. */
  readonly inline = input(false);

  private readonly rendered = signal<string | null>(null);

  protected readonly html = this.rendered.asReadonly();

  /** The empty box the sanitised markup is written into. Absent on the plain branch. */
  private readonly target = viewChild<ElementRef<HTMLElement>>('target');

  private readonly isMarkdown = computed(() => this.format() === 'markdown');

  /**
   * What the fallback branch says about itself: `'plain'` when the document
   * asked for plain text and the markup is therefore final, `'loading'` while a
   * Markdown source is waiting for its engine. Two values rather than one
   * because a test asserting "this rendered as plain text" and a test asserting
   * "this has not finished yet" are asking different questions, and a single
   * value would answer both the same way.
   */
  protected readonly pendingState = computed(() => (this.isMarkdown() ? 'loading' : 'plain'));

  constructor() {
    effect((onCleanup) => {
      const source = this.text();
      const inline = this.inline();
      if (!this.isMarkdown()) {
        this.rendered.set(null);
        return;
      }

      // The guard is what keeps a slow render of the previous question from
      // landing on the next one: the quiz loop reuses this component instance
      // across questions, so an `import()` started for question 3 can resolve
      // after question 4 has already asked for its own.
      let live = true;
      onCleanup(() => {
        live = false;
      });

      void this.toHtml(source, inline).then((html) => {
        if (live) {
          this.rendered.set(html);
        }
      });
    });

    // The markup is written to the element rather than bound with
    // `[innerHTML]`, and this is the one deliberate deviation from the plan
    // `FEAT-019` §3 sets out. It is a measurement, not a preference: a template
    // `[innerHTML]` binding *plus* `DomSanitizer.bypassSecurityTrustHtml`
    // retains Angular's own HTML sanitiser, and that sanitiser lands in the
    // shared chunk `main` imports — **+2,615 bytes gzip on every first load**,
    // including `/`, which nothing on the home route would ever use. Measured
    // by building all four combinations: dropping either half alone saves
    // 100–355 bytes, dropping both puts the chunk back to exactly its size on
    // `main`.
    //
    // Nothing about the security posture changes, which is what makes the trade
    // available at all: `bypassSecurityTrustHtml` *means* "Angular will not
    // check this", so the boundary is `markdown-engine.ts`'s allowlist in both
    // designs — this one simply does not carry a second sanitiser it has
    // already told not to run. See `docs/app.md` §1.4.
    //
    // `afterRenderEffect` rather than `effect`, because it touches an element a
    // template binding creates: a plain effect runs before `@if` has put the
    // element in the DOM, so `target()` would be the previous frame's
    // (`CLAUDE.md` §4.4).
    afterRenderEffect(() => {
      const element = this.target()?.nativeElement;
      const html = this.rendered();
      if (element && html !== null) {
        element.innerHTML = html;
      }
    });
  }

  private async toHtml(source: string, inline: boolean): Promise<string | null> {
    let engine: typeof import('./markdown-engine');
    try {
      engine = await loadMarkdownEngine();
    } catch {
      // Nothing to render with, so the source text stays on screen. Not
      // reported: the reader can read the question, and the retry is the next
      // question rather than anything they have to do.
      return null;
    }

    // A failed math chunk is not a failed render — the prose still formats, and
    // each formula falls back to its own source. Awaited separately from the
    // Markdown engine for exactly that reason.
    const math = containsMath(source) ? await loadMathEngine().catch(() => undefined) : undefined;

    try {
      return engine.renderMarkdown(source, { inline, renderMath: math?.renderMath });
    } catch {
      // **The render itself, not only the fetch.** `throwOnError: false` covers
      // KaTeX's `ParseError` and nothing else, and neither `marked` nor
      // DOMPurify promises never to throw on input this app does not control —
      // so "the engine arrived" is not the same as "the engine returned". An
      // uncaught throw here would reject a promise nobody awaits: the reader
      // would still get the source text, by accident rather than by design,
      // and the console would carry an unhandled rejection instead. Falling
      // back deliberately makes the component's one promise — it never renders
      // nothing — true whatever the engines do.
      return null;
    }
  }
}
