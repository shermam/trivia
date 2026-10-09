import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, Locator } from '@playwright/test';

/**
 * An axe-core scan of one element, in the real browser the spec is driving.
 *
 * A plain support module rather than something exported from a spec: a spec
 * file's `test` calls run on import, so a helper living in one would silently
 * re-register its own tests inside every spec that imported it.
 *
 * **What it is for, and what it is not.** Lighthouse runs axe too, but on `/`
 * alone and in a fresh profile, so a screen that needs an account never meets
 * it (`docs/ci-cd.md` §4.4). This is that same engine pointed at the element a
 * spec has just put into a known state. It is not accessibility coverage —
 * `CLAUDE.md` §4.5 says why no automated audit is — but it does catch the
 * mechanical half (a progress bar with no name, an ARIA attribute on a role
 * that does not take it, text under its contrast minimum) on screens nothing
 * else audits.
 *
 * Scoped to the WCAG 2.x A and AA rules, which is the bar the app holds
 * itself to; axe's best-practice rules are left out, because they would fail a
 * card for not being a landmark, which is the page's business rather than the
 * card's.
 *
 * `axe-core` is a pinned devDependency (`docs/stack.md` §2.2) and is resolved
 * from the repository root, where every runner of this suite starts.
 */
const AXE_SCRIPT = createRequire(join(process.cwd(), 'package.json')).resolve(
  'axe-core/axe.min.js',
);

const WCAG_A_AND_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[] }[];
}

interface AxeWindow {
  axe?: {
    run(
      context: Element,
      options: { runOnly: { type: 'tag'; values: string[] } },
    ): Promise<{ violations: AxeViolation[] }>;
  };
}

/**
 * Fails, naming every rule and element, unless axe finds no WCAG A/AA
 * violation inside `scope`. Assert the state under test first: this reads the
 * DOM once, as it is at that instant (`CLAUDE.md` §4.6).
 */
export async function expectNoAxeViolations(scope: Locator, what: string): Promise<void> {
  await scope.page().addScriptTag({ path: AXE_SCRIPT });
  const violations = await scope.evaluate(async (element, tags) => {
    const axe = (window as unknown as AxeWindow).axe;
    if (!axe) {
      throw new Error('axe-core did not load into the page');
    }
    const result = await axe.run(element, { runOnly: { type: 'tag', values: tags } });
    return result.violations.map(
      (violation) =>
        `${violation.id} (${violation.impact ?? 'unrated'}): ${violation.help} — ` +
        violation.nodes.map((node) => node.target.join(' ')).join(', '),
    );
  }, WCAG_A_AND_AA);
  expect(violations, `axe on ${what}`).toEqual([]);
}
