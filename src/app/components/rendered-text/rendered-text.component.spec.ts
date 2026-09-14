import { expect } from 'vitest';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { QuestionFormat } from '../../models/question.model';
import { RenderedTextComponent } from './rendered-text.component';

/**
 * What the component decides, as opposed to what the engine does: which branch
 * a document's `format` lands on, and what a reader is left looking at while —
 * or if — the engine never arrives.
 *
 * The engine's own behaviour, including every injection payload, is
 * `markdown-engine.spec.ts`. Splitting them keeps this file about the two
 * failures that would be the component's fault: parsing something that asked
 * to be plain, and rendering nothing at all.
 */

@Component({
  standalone: true,
  imports: [RenderedTextComponent],
  template: `<app-rendered-text [text]="text()" [format]="format()" [inline]="inline()" />`,
})
class HostComponent {
  readonly text = signal('');
  readonly format = signal<QuestionFormat | undefined>(undefined);
  readonly inline = signal(false);
}

function create(text: string, format?: QuestionFormat, inline = false) {
  const fixture = TestBed.createComponent(HostComponent);
  fixture.componentInstance.text.set(text);
  fixture.componentInstance.format.set(format);
  fixture.componentInstance.inline.set(inline);
  fixture.detectChanges();
  return fixture;
}

function box(fixture: ComponentFixture<HostComponent>): HTMLElement {
  const element = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
    '[data-cy="rendered-text"]',
  );
  if (!element) {
    throw new Error('the component rendered nothing at all, which it never may');
  }
  return element;
}

/**
 * Waits until the component has finished with this input, then renders.
 *
 * **Not `fixture.whenStable()`**, which would look like the right call and is
 * not: a bare `import()` is not a task Angular tracks, so stability says
 * nothing about whether the engine has arrived.
 *
 * **And not the `data-rendered` marker on its own**, which is the mistake this
 * comment exists to record: the marker flips when the signal is set, while the
 * markup is written by an `afterRenderEffect` a phase later. Waiting on the
 * marker alone made this suite fail about one run in three, on an assertion
 * about content that had not been written yet. Waiting for the box to be
 * *filled* is the condition the tests actually mean.
 *
 * The imports are real here rather than mocked: the point of the branch is that
 * it produces markup, and a mocked module would prove only that a promise
 * resolved.
 */
async function settle(fixture: ComponentFixture<HostComponent>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    fixture.detectChanges();
    const rendered = box(fixture);
    const state = rendered.dataset['rendered'];
    if (state === 'plain' || (state === 'markdown' && rendered.innerHTML.length > 0)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('the markdown engine never resolved');
}

/**
 * Waits for the box to hold exactly the source text and no markup.
 *
 * Not {@link settle}, and not the `data-rendered` marker: a Markdown source
 * whose render never returns markup stays on `loading` for the life of the
 * component, deliberately — the document did ask for Markdown. The content is
 * the assertion.
 */
async function settleOnSource(
  fixture: ComponentFixture<HostComponent>,
  source: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    fixture.detectChanges();
    const rendered = box(fixture);
    if (rendered.textContent === source && rendered.children.length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('the component never fell back to the source text');
}

/**
 * A formula nested deep enough to overflow KaTeX's recursive builder.
 *
 * **The one input that makes the real pipeline throw**, and the reason these
 * tests need no mock: `throwOnError: false` converts KaTeX's own `ParseError`
 * and nothing else, so the `RangeError` a runaway recursion raises comes
 * straight back out of `renderMarkdown`. Measured — 1,000 levels compiles in
 * 15 ms, 2,000 overflows — and set far above the boundary because stack depth
 * is a property of the engine rather than of this code. If some future runtime
 * has a stack deep enough to swallow it, the tests below fail loudly on markup
 * they did not expect rather than quietly passing.
 *
 * Not reachable from a real document: `firestore.rules` caps a question at 500
 * characters, which is about 160 levels. What is being tested is the
 * component's promise, which is not conditional on the engines behaving.
 */
const OVERFLOWING_FORMULA = `$${'x^{'.repeat(8000)}a${'}'.repeat(8000)}$`;

/**
 * Node's unhandled-rejection hook, reached through `globalThis` because the
 * app's `tsconfig` carries no Node types — and it is the app's `tsconfig` that
 * compiles this file. Vitest runs jsdom on top of Node, so a rejected promise
 * is reported here rather than as a `window` event.
 */
const nodeProcess = globalThis as unknown as {
  process: {
    on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
    off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  };
};

describe('RenderedTextComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('renders plain text as text when the document carries no format', async () => {
    const fixture = create('**not bold** and $x^2$');
    await settle(fixture);

    const rendered = box(fixture);
    expect(rendered.dataset['rendered']).toBe('plain');
    expect(rendered.querySelector('strong')).toBeNull();
    expect(rendered.querySelector('math')).toBeNull();
    expect(rendered.textContent).toBe('**not bold** and $x^2$');
  });

  it('renders plain text as text when the document says plain', async () => {
    const fixture = create('**not bold**', 'plain');
    await settle(fixture);

    expect(box(fixture).querySelector('strong')).toBeNull();
  });

  /**
   * Firestore is a public API and the rule that bounds this field is one deploy
   * from being widened, so the reader decides rather than trusting the writer
   * (`CLAUDE.md` §4.4). Anything that is not exactly `'markdown'` is plain.
   */
  it('treats an unknown format value as plain', async () => {
    const fixture = create('**not bold**', 'html' as QuestionFormat);
    await settle(fixture);

    expect(box(fixture).querySelector('strong')).toBeNull();
  });

  it('renders markup when the document says markdown', async () => {
    const fixture = create('**bold** and `code`', 'markdown');
    await settle(fixture);

    const rendered = box(fixture);
    expect(rendered.dataset['rendered']).toBe('markdown');
    expect(rendered.querySelector('strong')?.textContent).toBe('bold');
    expect(rendered.querySelector('code')?.textContent).toBe('code');
  });

  it('compiles math in a markdown document', async () => {
    const fixture = create('The area is $x^2$.', 'markdown');
    await settle(fixture);

    expect(box(fixture).querySelector('math')).not.toBeNull();
  });

  /**
   * The state before the engine lands, and the state it stays in forever if the
   * chunk never arrives. A blank question is unrecoverable for the reader; the
   * source text is merely unformatted, which is why this is the fallback rather
   * than an empty box or an error.
   */
  it('shows the source text before the engine has loaded', () => {
    const fixture = create('**bold**', 'markdown');

    const rendered = box(fixture);
    expect(rendered.dataset['rendered']).toBe('loading');
    expect(rendered.textContent).toBe('**bold**');
  });

  /**
   * **The engine arriving is not the same as the engine returning**, and the
   * assertion that matters here is the second one rather than the first.
   *
   * Measured: with the `catch` in `toHtml` removed, the reader sees exactly the
   * same thing — the source text, from the branch the component had not yet
   * left. A test that checked only the rendering would pass against the bug,
   * which is what the first version of this did. What actually changes is that
   * the render's promise rejects with nobody awaiting it, so the difference has
   * to be read off the rejection rather than off the DOM.
   */
  it('falls back to the source text when the render itself throws, without leaking the rejection', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    nodeProcess.process.on('unhandledRejection', record);

    try {
      const fixture = create(OVERFLOWING_FORMULA, 'markdown');
      await settleOnSource(fixture, OVERFLOWING_FORMULA);

      const rendered = box(fixture);
      expect(rendered.querySelector('math')).toBeNull();
      expect(rendered.children.length).toBe(0);

      // Node reports an unhandled rejection a turn after it is left unhandled,
      // so the absence of one only means something once the queue has drained.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      nodeProcess.process.off('unhandledRejection', record);
    }
  });

  /**
   * A throw must not poison the component the way a cached rejected promise
   * would (`CLAUDE.md` §4.4). The quiz loop reuses one instance for a whole
   * game, so one unlucky question may not cost the reader the rest of them.
   */
  it('renders the next question normally after a render threw', async () => {
    const fixture = create(OVERFLOWING_FORMULA, 'markdown');
    await settleOnSource(fixture, OVERFLOWING_FORMULA);

    fixture.componentInstance.text.set('**second**');
    fixture.detectChanges();

    await expect
      .poll(() => {
        fixture.detectChanges();
        return box(fixture).querySelector('strong')?.textContent;
      })
      .toBe('second');
  });

  it('renders a block container by default and an inline one when asked', async () => {
    const block = create('one', 'markdown');
    await settle(block);
    expect(box(block).tagName).toBe('DIV');

    const inline = create('one', 'markdown', true);
    await settle(inline);
    expect(box(inline).tagName).toBe('SPAN');
  });

  it('parses no block constructs in inline mode', async () => {
    const fixture = create('- one\n- two', 'markdown', true);
    await settle(fixture);

    expect(box(fixture).querySelector('li')).toBeNull();
  });

  /**
   * The quiz loop reuses one instance across every question in a game, so the
   * component has to follow its input rather than render once — and a source
   * that goes back to plain has to stop being parsed.
   */
  it('re-renders when the text changes and unrenders when the format goes back to plain', async () => {
    const fixture = create('**first**', 'markdown');
    await settle(fixture);
    expect(box(fixture).querySelector('strong')?.textContent).toBe('first');

    fixture.componentInstance.text.set('**second**');
    fixture.detectChanges();
    await expect
      .poll(() => {
        fixture.detectChanges();
        return box(fixture).querySelector('strong')?.textContent;
      })
      .toBe('second');

    fixture.componentInstance.format.set('plain');
    fixture.detectChanges();
    expect(box(fixture).querySelector('strong')).toBeNull();
    expect(box(fixture).textContent).toBe('**second**');
  });
});
