import katex from 'katex';
import { describe, expect, it, vi } from 'vitest';
import { LARGEST_SIZE, TOKEN_ELEMENTS, postprocessMathML, renderMath } from './math-engine';

/**
 * `postprocessMathML` on its own: the string rewrites that keep KaTeX's token
 * wrappers from being re-homed in the HTML namespace and its nested sizes from
 * compounding. Their effect on what a reader sees — every character of
 * `\overset` and the rest surviving the sanitiser, no formula larger than
 * `\Huge` — is `markdown-engine.spec.ts`'s; their published statement is
 * `render-contract.spec.ts`'s. This is the rewrites' own contract: what is
 * collapsed, what is renamed, what is resized, and that nothing else about
 * the markup moves.
 */
describe('postprocessMathML: a token element holding elements', () => {
  it.each(TOKEN_ELEMENTS)(
    'renames a %s that holds an element, keeping its attributes and children',
    (token) => {
      expect(
        postprocessMathML(
          `<math><${token} lspace="0.22em" rspace="0.22em"><mi>a</mi>b<mi>c</mi></${token}></math>`,
        ),
      ).toBe('<math><mrow lspace="0.22em" rspace="0.22em"><mi>a</mi>b<mi>c</mi></mrow></math>');
    },
  );

  it.each(TOKEN_ELEMENTS)('leaves a %s that holds only text', (token) => {
    const markup = `<math><mrow><${token} stretchy="false">&lt;x&amp;</${token}></mrow></math>`;
    expect(postprocessMathML(markup)).toBe(markup);
  });

  /**
   * KaTeX's `\coloneqq` is `<mo><mi mathvariant="normal">≔</mi></mo>`: an
   * operator around one upright character, which collapses into exactly the
   * operator KaTeX meant — spaced as one, where an `mrow` would set it with no
   * space at all. The wrapper keeps its own attributes; the child's go with it.
   */
  it('collapses an mo around one upright character into an mo holding that character', () => {
    for (const [markup, collapsed] of [
      ['<mo><mi mathvariant="normal">≔</mi></mo>', '<mo>≔</mo>'],
      [
        '<mo lspace="0.22em" rspace="0.22em"><mo>:</mo></mo>',
        '<mo lspace="0.22em" rspace="0.22em">:</mo>',
      ],
      ['<mo><mn>1</mn></mo>', '<mo>1</mo>'],
      ['<mo><mtext>a</mtext></mo>', '<mo>a</mo>'],
      ['<mo><mo>&lt;</mo></mo>', '<mo>&lt;</mo>'],
      ['<mo><mi mathvariant="normal">𝔸</mi></mo>', '<mo>𝔸</mo>'],
    ]) {
      expect(postprocessMathML(markup), markup).toBe(collapsed);
    }
  });

  /**
   * Anything else holding an element is renamed, and each refusal is a glyph
   * that would change: a bare `mi` is italic and an `mo` is not; an `mi`
   * wrapper would lose the child's `mathvariant`; an `ms` draws quotes; an
   * attribute on the child would be dropped; two characters are not one.
   */
  it('renames instead whenever collapsing would change what is drawn', () => {
    for (const [markup, renamed] of [
      ['<mo><mi>b</mi></mo>', '<mrow><mi>b</mi></mrow>'],
      ['<mi><mi mathvariant="normal">x</mi></mi>', '<mrow><mi mathvariant="normal">x</mi></mrow>'],
      ['<mo><ms>x</ms></mo>', '<mrow><ms>x</ms></mrow>'],
      ['<mo><mo stretchy="false">(</mo></mo>', '<mrow><mo stretchy="false">(</mo></mrow>'],
      ['<mo><mi mathvariant="bold">x</mi></mo>', '<mrow><mi mathvariant="bold">x</mi></mrow>'],
      [
        '<mo><mi mathvariant="normal">ab</mi></mo>',
        '<mrow><mi mathvariant="normal">ab</mi></mrow>',
      ],
      ['<mo><mo>a</mo><mo>b</mo></mo>', '<mrow><mo>a</mo><mo>b</mo></mrow>'],
    ]) {
      expect(postprocessMathML(markup), markup).toBe(renamed);
    }
  });

  /**
   * KaTeX writes a space as `<mspace width="…"/>`, and `\approxcolon` puts one
   * alone inside an `<mo>`: no text, no closing tag, and an element all the
   * same, which the HTML parser re-homes like any other.
   */
  it('counts a self-closing element as an element, alone or beside others', () => {
    expect(postprocessMathML('<mo><mspace width="-0.0667em"/></mo>')).toBe(
      '<mrow><mspace width="-0.0667em"/></mrow>',
    );
    expect(postprocessMathML('<mo><mo>≈</mo><mspace width="-0.07em"/></mo>')).toBe(
      '<mrow><mo>≈</mo><mspace width="-0.07em"/></mrow>',
    );
  });

  it('leaves every element that is not a token alone, whatever it holds', () => {
    const markup =
      '<span class="katex"><math><semantics><mrow><mstyle mathsize="1.2em"><mi>x</mi></mstyle>' +
      '<mover><mi>a</mi><mo>^</mo></mover></mrow><annotation encoding="application/x-tex">x</annotation>' +
      '</semantics></math></span>';
    expect(postprocessMathML(markup)).toBe(markup);
  });

  /**
   * KaTeX's `\overset{!}{=}`: a math class around a supsub around an operator
   * with a body — a token in a token, two levels down. Innermost first, so the
   * `=` collapses into its operator before the outer wrapper is looked at.
   */
  it('works innermost first, at every depth', () => {
    expect(
      postprocessMathML(
        '<mi>a</mi><mo><mover><mo><mo>=</mo></mo><mo stretchy="false">!</mo></mover></mo><mi>b</mi>',
      ),
    ).toBe('<mi>a</mi><mrow><mover><mo>=</mo><mo stretchy="false">!</mo></mover></mrow><mi>b</mi>');
    expect(postprocessMathML('<mo><mo><mo>:</mo></mo></mo>')).toBe('<mo>:</mo>');
  });

  /**
   * The token rewrite is idempotent; the size rewrite is deliberately not,
   * because it reads every `mathsize` as KaTeX writes one — a multiple of the
   * formula's size — and writes it relative to its parent. It runs once, on
   * what `renderToString` returned.
   */
  it('collapses and renames nothing more on its own output', () => {
    const once = postprocessMathML(
      '<mo><mover><mo><mo>=</mo></mo><mo>!</mo></mover></mo><mo><mi mathvariant="normal">≔</mi></mo>',
    );
    expect(postprocessMathML(once)).toBe(once);
  });

  it("leaves KaTeX's error markup as it is", () => {
    const error =
      '<span class="katex-error" title="ParseError: KaTeX parse error: Expected &#x27;}&#x27;" ' +
      'style="color:#cc0000">\\frac{</span>';
    expect(postprocessMathML(error)).toBe(error);
  });

  it('leaves markup whose tags do not balance as it is', () => {
    for (const markup of ['<mo><mi>x</mi>', '<mo><mi>x</mo></mi>', '</mo><mo><mi>x</mi></mo>']) {
      expect(postprocessMathML(markup), markup).toBe(markup);
    }
  });
});

describe('postprocessMathML: mathsize', () => {
  /**
   * The product of every `mathsize` from the formula down to the innermost
   * element — the size a browser draws it at, as a multiple of the
   * formula's — since an `em` is the parent's size.
   */
  function drawnSize(markup: string): number {
    return [...markup.matchAll(/mathsize="([\d.]+)em"/g)].reduce(
      (size, [, value]) => size * Number(value),
      1,
    );
  }

  const huge = (inner: string) => `<mstyle mathsize="2.488em">${inner}</mstyle>`;
  const tiny = (inner: string) => `<mstyle mathsize="0.5em">${inner}</mstyle>`;

  it('leaves a size that nothing encloses as KaTeX wrote it', () => {
    for (const markup of [
      huge('<mi>x</mi>'),
      tiny('<mi>x</mi>'),
      '<mstyle mathsize="1.2em"><mi>x</mi></mstyle>',
    ]) {
      expect(postprocessMathML(markup)).toBe(markup);
    }
  });

  /**
   * KaTeX writes `\Huge` as 2.488em at every depth, meaning 2.488 times the
   * formula; an em is the parent's size, so as written three levels draw at
   * 2.488³ — 15.4 times the text — and ten reach the largest font a browser
   * will draw.
   */
  it("draws a nested size at KaTeX's own size, not at the product of the nesting", () => {
    const nested = postprocessMathML(huge(huge(huge('<mi>x</mi>'))));
    expect(nested).toBe(
      '<mstyle mathsize="2.488em"><mstyle mathsize="1em"><mstyle mathsize="1em"><mi>x</mi></mstyle></mstyle></mstyle>',
    );
    expect(drawnSize(nested)).toBeCloseTo(2.488, 6);

    const ten = postprocessMathML(
      Array.from({ length: 10 }).reduce<string>((inner) => huge(inner), '<mi>x</mi>'),
    );
    expect(drawnSize(ten)).toBeCloseTo(2.488, 6);

    const hugeInTiny = postprocessMathML(tiny(huge('<mi>x</mi>')));
    expect(hugeInTiny).toBe(
      '<mstyle mathsize="0.5em"><mstyle mathsize="4.976em"><mi>x</mi></mstyle></mstyle>',
    );
    expect(drawnSize(hugeInTiny)).toBeCloseTo(2.488, 6);

    const tinyInHuge = postprocessMathML(huge(tiny('<mi>x</mi>')));
    expect(drawnSize(tinyInHuge)).toBeCloseTo(0.5, 3);
  });

  /** KaTeX never writes more than `\Huge`; whatever does, no size comes to more. */
  it(`caps every size at ${LARGEST_SIZE} times the formula's, however it nests`, () => {
    expect(postprocessMathML('<mstyle mathsize="10em"><mi>x</mi></mstyle>')).toBe(
      `<mstyle mathsize="${LARGEST_SIZE}em"><mi>x</mi></mstyle>`,
    );
    const capped = postprocessMathML(
      '<mstyle mathsize="0.5em"><mstyle mathsize="100em"><mi mathsize="9em">x</mi></mstyle></mstyle>',
    );
    expect(drawnSize(capped)).toBeCloseTo(LARGEST_SIZE, 6);
  });

  it('removes a mathsize that is not a positive number of em', () => {
    for (const value of ['2px', 'big', '-1em', '0em', '1e3em', '']) {
      expect(postprocessMathML(`<mstyle mathsize="${value}"><mi>x</mi></mstyle>`), value).toBe(
        '<mstyle><mi>x</mi></mstyle>',
      );
    }
  });

  it('writes a rewritten size as KaTeX writes a length: four decimals at most', () => {
    expect(
      postprocessMathML(
        '<mstyle mathsize="0.7em"><mstyle mathsize="1.2em"><mi>x</mi></mstyle></mstyle>',
      ),
    ).toBe('<mstyle mathsize="0.7em"><mstyle mathsize="1.7143em"><mi>x</mi></mstyle></mstyle>');
  });
});

describe('renderMath', () => {
  /**
   * The rewrites run on exactly what KaTeX returned and on nothing else, so
   * the output differs from KaTeX's markup only where they apply.
   */
  it("returns KaTeX's markup rewritten, and nothing else changed", () => {
    const renderToString = vi.spyOn(katex, 'renderToString');
    try {
      for (const tex of [
        String.raw`a \overset{!}{=} b`,
        String.raw`\frac{a}{b}`,
        String.raw`\tiny{\Huge x}`,
      ]) {
        renderToString.mockClear();
        const out = renderMath(tex, false);
        expect(out, tex).toBe(postprocessMathML(renderToString.mock.results[0].value as string));
      }
      expect(renderMath(String.raw`a \overset{!}{=} b`, false)).toContain(
        '<mrow><mover><mo>=</mo>',
      );
      expect(renderMath(String.raw`a \coloneqq b`, false)).toContain('<mo>≔</mo>');
      expect(renderMath(String.raw`\tiny{\Huge x}`, false)).toContain('mathsize="4.976em"');
    } finally {
      renderToString.mockRestore();
    }
  });
});
