import katex from 'katex';
import { describe, expect, it, vi } from 'vitest';
import { TOKEN_ELEMENTS, renameTokensHoldingElements, renderMath } from './math-engine';

/**
 * `renameTokensHoldingElements` on its own: the string rewrite that keeps
 * KaTeX's token wrappers from being re-homed in the HTML namespace. Its effect
 * on what a reader sees — every character of `\overset` and the rest surviving
 * the sanitiser — is `markdown-engine.spec.ts`'s; its published statement is
 * `render-contract.spec.ts`'s. This is the rewrite's own contract: what is
 * renamed, what is left alone, and that nothing else about the markup moves.
 */
describe('renameTokensHoldingElements', () => {
  it.each(TOKEN_ELEMENTS)(
    'renames a %s that holds an element, keeping its attributes and children',
    (token) => {
      expect(
        renameTokensHoldingElements(
          `<math><${token} lspace="0.22em" rspace="0.22em"><mi>a</mi>b<mi>c</mi></${token}></math>`,
        ),
      ).toBe('<math><mrow lspace="0.22em" rspace="0.22em"><mi>a</mi>b<mi>c</mi></mrow></math>');
    },
  );

  it.each(TOKEN_ELEMENTS)('leaves a %s that holds only text', (token) => {
    const markup = `<math><mrow><${token} stretchy="false">&lt;x&amp;</${token}></mrow></math>`;
    expect(renameTokensHoldingElements(markup)).toBe(markup);
  });

  /**
   * KaTeX writes a space as `<mspace width="…"/>`, and `\approxcolon` puts one
   * alone inside an `<mo>`: no text, no closing tag, and an element all the
   * same, which the HTML parser re-homes like any other.
   */
  it('counts a self-closing element as an element, alone or beside others', () => {
    expect(renameTokensHoldingElements('<mo><mspace width="-0.0667em"/></mo>')).toBe(
      '<mrow><mspace width="-0.0667em"/></mrow>',
    );
    expect(renameTokensHoldingElements('<mo><mo>≈</mo><mspace width="-0.07em"/></mo>')).toBe(
      '<mrow><mo>≈</mo><mspace width="-0.07em"/></mrow>',
    );
  });

  it('leaves every element that is not a token alone, whatever it holds', () => {
    const markup =
      '<span class="katex"><math><semantics><mrow><mstyle mathsize="1.2em"><mi>x</mi></mstyle>' +
      '<mover><mi>a</mi><mo>^</mo></mover></mrow><annotation encoding="application/x-tex">x</annotation>' +
      '</semantics></math></span>';
    expect(renameTokensHoldingElements(markup)).toBe(markup);
  });

  /**
   * KaTeX's `\overset{!}{=}`: a math class around a supsub around an operator
   * with a body — a token in a token, two levels down. Each wrapper is renamed
   * with its own end tag, and the leaves keep their names.
   */
  it('renames at every depth, each end tag with its own start tag', () => {
    expect(
      renameTokensHoldingElements(
        '<mi>a</mi><mo><mover><mo><mo>=</mo></mo><mo stretchy="false">!</mo></mover></mo><mi>b</mi>',
      ),
    ).toBe(
      '<mi>a</mi><mrow><mover><mrow><mo>=</mo></mrow><mo stretchy="false">!</mo></mover></mrow><mi>b</mi>',
    );
  });

  it('is a no-op on its own output', () => {
    const once = renameTokensHoldingElements(
      '<mo><mover><mo><mo>=</mo></mo><mo>!</mo></mover></mo>',
    );
    expect(renameTokensHoldingElements(once)).toBe(once);
  });

  it("leaves KaTeX's error markup as it is", () => {
    const error =
      '<span class="katex-error" title="ParseError: KaTeX parse error: Expected &#x27;}&#x27;" ' +
      'style="color:#cc0000">\\frac{</span>';
    expect(renameTokensHoldingElements(error)).toBe(error);
  });
});

describe('renderMath', () => {
  /**
   * The rewrite runs on exactly what KaTeX returned and on nothing else, so
   * the output differs from KaTeX's markup only where a token held an element.
   */
  it("returns KaTeX's markup with its token wrappers renamed, and nothing else changed", () => {
    const renderToString = vi.spyOn(katex, 'renderToString');
    try {
      for (const tex of [String.raw`a \overset{!}{=} b`, String.raw`\frac{a}{b}`]) {
        renderToString.mockClear();
        const out = renderMath(tex, false);
        expect(out, tex).toBe(
          renameTokensHoldingElements(renderToString.mock.results[0].value as string),
        );
      }
      expect(renderMath(String.raw`a \overset{!}{=} b`, false)).toContain(
        '<mrow><mover><mrow><mo>=</mo></mrow>',
      );
    } finally {
      renderToString.mockRestore();
    }
  });
});
