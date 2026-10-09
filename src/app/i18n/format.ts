/**
 * The message syntax, and the one place that reads it.
 *
 * Three things can appear in a message, and nothing else:
 *
 * - **text**, rendered as it is — including a `#` and a `'`, which mean
 *   nothing outside a plural branch;
 * - **`{name}`**, replaced by the parameter of that name as text, unformatted
 *   (`String(value)`), so a number reads exactly as it did before the string
 *   was extracted. A parameter nobody passed shows as `{name}`, which is loud
 *   enough to be noticed and quiet enough not to break the screen;
 * - **one plural**, `{n, plural, =0 {…} one {…} other {…}}`: the branch is
 *   chosen by an exact `=N` first, then by the locale's own category from
 *   `Intl.PluralRules` (`zero`, `one`, `two`, `few`, `many`), then `other`,
 *   which is required. Inside a branch `#` is the number formatted for the
 *   locale and `{name}` works as above. No `select`, no plural inside a plural,
 *   and no escapes: a brace is always syntax. Portuguese puts 0 in `one`, so
 *   a message that has to say "none" says it with `=0`.
 *
 * Deliberately not ICU MessageFormat. The subset is what the app's strings
 * use, it is small enough to ship on `/` (`docs/ci-cd.md` §4.4 has its cost),
 * and a translator who knows ICU reads it without being told anything.
 *
 * A message that does not parse renders as its raw text rather than throwing:
 * every English default is parsed by `i18n-bundles.spec.ts` and by
 * `npm run i18n:verify` before it can ship, so this branch exists for a
 * translation nobody checked, where an odd string beats a broken screen.
 */

/** Values the formatter interpolates. Anything else is the caller's to format first. */
export type FormatParams = Readonly<Record<string, string | number | null | undefined>>;

/** Where the formatted number goes inside a plural branch. */
const HASH = 0;

interface Argument {
  readonly arg: string;
}

interface Plural {
  readonly arg: string;
  readonly cases: Readonly<Record<string, readonly Part[]>>;
}

type Part = string | typeof HASH | Argument | Plural;

/** Thrown inside the parser only; {@link parseMessage} turns it into `null`. */
class SyntaxFault extends Error {}

const parsed = new Map<string, readonly Part[] | null>();
const pluralRules = new Map<string, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();

/**
 * Parses a message, or returns `null` when it is not valid syntax. Exported for
 * the checks that hold every English default to the grammar; the app itself only
 * ever calls {@link formatMessage}.
 */
export function parseMessage(source: string): readonly Part[] | null {
  let parts = parsed.get(source);
  if (parts === undefined) {
    try {
      const [result, end] = parseParts(source, 0, false);
      if (end !== source.length) throw new SyntaxFault();
      parts = result;
    } catch {
      parts = null;
    }
    parsed.set(source, parts);
  }
  return parts;
}

/** Renders `source` with `params`, choosing plural branches and number formats for `locale`. */
export function formatMessage(
  source: string,
  params: FormatParams | undefined,
  locale: string,
): string {
  if (!source.includes('{')) return source;
  const parts = parseMessage(source);
  return parts ? render(parts, params ?? {}, locale, undefined) : source;
}

function parseParts(source: string, start: number, inBranch: boolean): [Part[], number] {
  const parts: Part[] = [];
  let text = '';
  let i = start;
  const flush = () => {
    if (text) parts.push(text);
    text = '';
  };
  while (i < source.length) {
    const char = source[i];
    if (char === '}') {
      if (!inBranch) throw new SyntaxFault();
      break;
    }
    if (char === '#' && inBranch) {
      flush();
      parts.push(HASH);
      i++;
    } else if (char === '{') {
      flush();
      const [part, end] = parseArgument(source, i + 1, inBranch);
      parts.push(part);
      i = end;
    } else {
      text += char;
      i++;
    }
  }
  flush();
  return [parts, i];
}

function parseArgument(source: string, start: number, inBranch: boolean): [Part, number] {
  const close = source.indexOf('}', start);
  const comma = source.indexOf(',', start);
  if (close < 0) throw new SyntaxFault();
  if (comma < 0 || close < comma) {
    return [{ arg: argumentName(source.slice(start, close)) }, close + 1];
  }
  // A plural: `name, plural, <selector> {<branch>} …}`. Never inside a branch.
  if (inBranch) throw new SyntaxFault();
  const arg = argumentName(source.slice(start, comma));
  const typeEnd = source.indexOf(',', comma + 1);
  if (typeEnd < 0 || source.slice(comma + 1, typeEnd).trim() !== 'plural') throw new SyntaxFault();
  const cases: Record<string, readonly Part[]> = {};
  let i = typeEnd + 1;
  for (;;) {
    while (/\s/.test(source[i] ?? '')) i++;
    if (source[i] === '}') break;
    const open = source.indexOf('{', i);
    if (open < 0) throw new SyntaxFault();
    const selector = source.slice(i, open).trim();
    if (!/^(=\d+|zero|one|two|few|many|other)$/.test(selector) || selector in cases) {
      throw new SyntaxFault();
    }
    const [branch, end] = parseParts(source, open + 1, true);
    if (source[end] !== '}') throw new SyntaxFault();
    cases[selector] = branch;
    i = end + 1;
  }
  if (!('other' in cases)) throw new SyntaxFault();
  return [{ arg, cases }, i + 1];
}

function argumentName(raw: string): string {
  const name = raw.trim();
  if (!/^[A-Za-z_]\w*$/.test(name)) throw new SyntaxFault();
  return name;
}

function render(
  parts: readonly Part[],
  params: FormatParams,
  locale: string,
  count: number | undefined,
): string {
  let out = '';
  for (const part of parts) {
    if (typeof part === 'string') {
      out += part;
    } else if (part === HASH) {
      out += numberFormat(locale).format(count ?? 0);
    } else if ('cases' in part) {
      const value = params[part.arg];
      if (typeof value !== 'number') {
        out += `{${part.arg}}`;
        continue;
      }
      const branch =
        part.cases[`=${value}`] ?? part.cases[rules(locale).select(value)] ?? part.cases['other'];
      out += render(branch, params, locale, value);
    } else {
      const value = params[part.arg];
      out += value === undefined || value === null ? `{${part.arg}}` : String(value);
    }
  }
  return out;
}

function rules(locale: string): Intl.PluralRules {
  let found = pluralRules.get(locale);
  if (!found) pluralRules.set(locale, (found = new Intl.PluralRules(locale)));
  return found;
}

function numberFormat(locale: string): Intl.NumberFormat {
  let found = numberFormats.get(locale);
  if (!found) numberFormats.set(locale, (found = new Intl.NumberFormat(locale)));
  return found;
}
