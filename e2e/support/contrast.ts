import { expect, Locator } from '@playwright/test';

/**
 * Text contrast, computed from what the browser actually renders.
 *
 * Lighthouse's `color-contrast` audit is asserted on its own in CI
 * (`docs/ci-cd.md` §4.4), but it loads `/` once, in a fresh profile, in the
 * light theme — so it never sees a screen that needs a game in progress, a
 * finished round, or the dark theme at all. Those are what this module is for,
 * and `color-contrast.spec.ts` is where it is used.
 *
 * A plain support module rather than something exported from a spec: a spec
 * file's `test` calls run on import, so a helper living in one would silently
 * re-register its own tests inside every spec that imported it.
 */

/** One piece of text and how it reads against what is painted behind it. */
export interface ContrastReading {
  /** The element's own text, whitespace collapsed — what identifies it in a report. */
  text: string;
  /** The WCAG 2 contrast ratio, `(L1 + 0.05) / (L2 + 0.05)`. */
  ratio: number;
  /** What WCAG 1.4.3 asks of this text: 3:1 at the large-text sizes, 4.5:1 below them. */
  required: number;
  /** The text colour as painted, composited over the background. */
  foreground: string;
  /** Everything painted behind the text, composited down to one colour. */
  background: string;
}

/**
 * Every piece of visible text inside `scope` (itself included), with its
 * contrast — one reading per element that carries text of its own.
 *
 * **The browser does the colour work, so the test never parses a colour.**
 * Tailwind 4's palette is `oklch()` and its opacity modifiers compute to
 * `color-mix()` results, so `getComputedStyle` hands back strings no regular
 * expression should be trusted with. Each one is painted onto a 1×1 canvas
 * instead, in the order the page stacks them — the nearest opaque background,
 * then every translucent one inside it, then the text — and the pixel is read
 * back: the same conversion to sRGB and the same source-over compositing the
 * page itself was drawn with.
 *
 * **What a sighted reader cannot see is not measured**: text hidden by
 * `visibility` or `display`, and the 1px boxes `sr-only` text lives in.
 *
 * **It refuses what it cannot measure rather than measuring something else.**
 * A background image between the text and the first opaque colour behind it,
 * or an `opacity` below 1 on any ancestor, changes the colours on screen in a
 * way a flat composite does not reproduce, so either one throws, naming the
 * element — a future layout that puts a gradient behind this text fails loudly
 * instead of passing against a colour nobody sees.
 */
export function readTextContrast(scope: Locator): Promise<ContrastReading[]> {
  return scope.evaluate((root) => {
    const describe = (target: Element): string => {
      const classes = target.getAttribute('class')?.trim().split(/\s+/).slice(0, 4).join('.');
      return `<${target.tagName.toLowerCase()}${classes ? `.${classes}` : ''}>`;
    };

    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('no 2D canvas to composite colours on');
    }
    const paint = (color: string): void => {
      // A colour the canvas cannot parse leaves `fillStyle` where it was, so a
      // sentinel is what tells "painted" apart from "silently ignored".
      const sentinel = '#010203';
      context.fillStyle = sentinel;
      context.fillStyle = color;
      if (context.fillStyle === sentinel && color.replace(/\s/g, '') !== sentinel) {
        throw new Error(`the canvas cannot parse the colour "${color}"`);
      }
      context.fillRect(0, 0, 1, 1);
    };
    const pixel = (): number[] => Array.from(context.getImageData(0, 0, 1, 1).data);
    const alphaOf = (color: string): number => {
      context.clearRect(0, 0, 1, 1);
      paint(color);
      return pixel()[3];
    };
    // WCAG 2's relative luminance, from 8-bit sRGB.
    const luminance = ([r, g, b]: number[]): number => {
      const [lr, lg, lb] = [r, g, b].map((channel) => {
        const c = channel / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    };
    const rgb = ([r, g, b]: number[]) => `rgb(${r}, ${g}, ${b})`;

    const read = (element: Element, text: string) => {
      for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
        if (Number(getComputedStyle(ancestor).opacity) < 1) {
          throw new Error(`"${text}": ${describe(ancestor)} has an opacity below 1`);
        }
      }
      // Innermost first, up to the first opaque background: nothing behind
      // that one can show through it.
      const layers: string[] = [];
      let ancestor: Element | null = element;
      for (; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.backgroundImage !== 'none') {
          throw new Error(`"${text}": ${describe(ancestor)} paints a background image behind it`);
        }
        const alpha = alphaOf(style.backgroundColor);
        if (alpha > 0) {
          layers.push(style.backgroundColor);
        }
        if (alpha === 255) {
          break;
        }
      }
      if (!ancestor) {
        throw new Error(`"${text}": nothing opaque is painted behind it`);
      }

      context.clearRect(0, 0, 1, 1);
      for (const layer of layers.reverse()) {
        paint(layer);
      }
      const background = pixel();
      const style = getComputedStyle(element);
      paint(style.color);
      const foreground = pixel();

      // Large text is 18pt, or 14pt bold: 24px, or 18.66px at weight 700+.
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
        (a, b) => b - a,
      );
      return {
        text,
        ratio: (lighter + 0.05) / (darker + 0.05),
        required: large ? 3 : 4.5,
        foreground: rgb(foreground),
        background: rgb(background),
      };
    };

    const readings: ReturnType<typeof read>[] = [];
    for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
      const text = Array.from(element.childNodes)
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => child.textContent ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const box = element.getBoundingClientRect();
      if (
        text === '' ||
        box.width <= 1 ||
        box.height <= 1 ||
        !element.checkVisibility({ visibilityProperty: true })
      ) {
        continue;
      }
      readings.push(read(element, text));
    }
    return readings;
  });
}

/**
 * Fails unless every piece of visible text inside `scope` meets WCAG 1.4.3 —
 * and `scope` holds each of `texts`, so a sweep that found nothing to measure
 * cannot pass for one that measured everything.
 *
 * Polled, so a read cannot land on a frame where a colour is still settling (a
 * hover's `transition-colors`, a theme class arriving); the only value it can
 * settle to is one that passes. What it polls is a description rather than a
 * number, because a poll's message is fixed when the poll starts and the
 * received value is the only place a measurement can travel to the report: a
 * failure names the text, its ratio, what it needed and both colours as
 * painted.
 */
export async function expectReadableText(
  scope: Locator,
  texts: readonly string[],
  what: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const readings = await readTextContrast(scope);
        return {
          measured: readings.map((reading) => reading.text),
          unreadable: readings
            .filter((reading) => reading.ratio < reading.required)
            .map(
              (reading) =>
                `"${reading.text}" at ${reading.ratio.toFixed(2)}:1, needing ${reading.required}:1 — ` +
                `${reading.foreground} on ${reading.background}`,
            ),
        };
      },
      { message: `${what}: every piece of text reaches WCAG AA contrast` },
    )
    .toEqual({ measured: expect.arrayContaining([...texts]), unreadable: [] });
}
