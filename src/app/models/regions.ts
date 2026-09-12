/**
 * The countries a player may publish a regional leaderboard entry under
 * (`FEAT-028`).
 *
 * **The list is a copy, and `firestore.rules`' `isValidRegion()` is the
 * original.** It exists here so the picker cannot offer a country the rules
 * will refuse — a refused save arrives as a bare `permission-denied` on the
 * one screen that cannot honestly narrate one (`CLAUDE.md` §4.4) — and the
 * two are pinned equal by a rules test that reads the codes out of the rules
 * file, the same arrangement `MAX_SCORE_MULTIPLIER` has.
 *
 * Officially assigned ISO 3166-1 alpha-2 codes only. The exceptionally
 * reserved ones (`UK`, `EU`, `XK`, `CQ`, …) and the whole user-assigned range
 * are left out: they are not places a player is in, and a code the dropdown
 * cannot reach is a public board nothing shows and nothing sweeps.
 */
export const REGION_CODES: readonly string[] = [
  'AD',
  'AE',
  'AF',
  'AG',
  'AI',
  'AL',
  'AM',
  'AO',
  'AQ',
  'AR',
  'AS',
  'AT',
  'AU',
  'AW',
  'AX',
  'AZ',
  'BA',
  'BB',
  'BD',
  'BE',
  'BF',
  'BG',
  'BH',
  'BI',
  'BJ',
  'BL',
  'BM',
  'BN',
  'BO',
  'BQ',
  'BR',
  'BS',
  'BT',
  'BV',
  'BW',
  'BY',
  'BZ',
  'CA',
  'CC',
  'CD',
  'CF',
  'CG',
  'CH',
  'CI',
  'CK',
  'CL',
  'CM',
  'CN',
  'CO',
  'CR',
  'CU',
  'CV',
  'CW',
  'CX',
  'CY',
  'CZ',
  'DE',
  'DJ',
  'DK',
  'DM',
  'DO',
  'DZ',
  'EC',
  'EE',
  'EG',
  'EH',
  'ER',
  'ES',
  'ET',
  'FI',
  'FJ',
  'FK',
  'FM',
  'FO',
  'FR',
  'GA',
  'GB',
  'GD',
  'GE',
  'GF',
  'GG',
  'GH',
  'GI',
  'GL',
  'GM',
  'GN',
  'GP',
  'GQ',
  'GR',
  'GS',
  'GT',
  'GU',
  'GW',
  'GY',
  'HK',
  'HM',
  'HN',
  'HR',
  'HT',
  'HU',
  'ID',
  'IE',
  'IL',
  'IM',
  'IN',
  'IO',
  'IQ',
  'IR',
  'IS',
  'IT',
  'JE',
  'JM',
  'JO',
  'JP',
  'KE',
  'KG',
  'KH',
  'KI',
  'KM',
  'KN',
  'KP',
  'KR',
  'KW',
  'KY',
  'KZ',
  'LA',
  'LB',
  'LC',
  'LI',
  'LK',
  'LR',
  'LS',
  'LT',
  'LU',
  'LV',
  'LY',
  'MA',
  'MC',
  'MD',
  'ME',
  'MF',
  'MG',
  'MH',
  'MK',
  'ML',
  'MM',
  'MN',
  'MO',
  'MP',
  'MQ',
  'MR',
  'MS',
  'MT',
  'MU',
  'MV',
  'MW',
  'MX',
  'MY',
  'MZ',
  'NA',
  'NC',
  'NE',
  'NF',
  'NG',
  'NI',
  'NL',
  'NO',
  'NP',
  'NR',
  'NU',
  'NZ',
  'OM',
  'PA',
  'PE',
  'PF',
  'PG',
  'PH',
  'PK',
  'PL',
  'PM',
  'PN',
  'PR',
  'PS',
  'PT',
  'PW',
  'PY',
  'QA',
  'RE',
  'RO',
  'RS',
  'RU',
  'RW',
  'SA',
  'SB',
  'SC',
  'SD',
  'SE',
  'SG',
  'SH',
  'SI',
  'SJ',
  'SK',
  'SL',
  'SM',
  'SN',
  'SO',
  'SR',
  'SS',
  'ST',
  'SV',
  'SX',
  'SY',
  'SZ',
  'TC',
  'TD',
  'TF',
  'TG',
  'TH',
  'TJ',
  'TK',
  'TL',
  'TM',
  'TN',
  'TO',
  'TR',
  'TT',
  'TV',
  'TW',
  'TZ',
  'UA',
  'UG',
  'UM',
  'US',
  'UY',
  'UZ',
  'VA',
  'VC',
  'VE',
  'VG',
  'VI',
  'VN',
  'VU',
  'WF',
  'WS',
  'YE',
  'YT',
  'ZA',
  'ZM',
  'ZW',
];

const REGION_CODE_SET = new Set(REGION_CODES);

/** Whether a value is one of the codes a regional board may exist for. */
export function isRegionCode(value: unknown): value is string {
  return typeof value === 'string' && REGION_CODE_SET.has(value);
}

/**
 * The country's name in the reader's own language, falling back to the code.
 *
 * `Intl.DisplayNames` rather than a shipped table of 249 names: the browser
 * already has them, in every locale it supports, and a table in the bundle
 * would be 249 English strings that are wrong for most of the world. The
 * fallback is not decoration — the constructor throws on a runtime without the
 * `DisplayNames` data (and `of()` returns the code itself for one whose ICU
 * build does not know it), and a board heading reading `BR` is a worse outcome
 * than a blank page only if the page is blank.
 */
export function regionName(code: string): string {
  try {
    return displayNames()?.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * One `Intl.DisplayNames`, built on first use and kept.
 *
 * Constructing one is not free and {@link regionOptions} needs 249 names in a
 * row, so a fresh instance per name is a quarter of a second of the game-over
 * screen's render spent rebuilding the same object. `null` rather than a
 * re-throw when the runtime has no `DisplayNames` data: the memo then answers
 * every later call without retrying a constructor that will not start
 * working, and `regionName` falls back to the code.
 */
let displayNamesMemo: Intl.DisplayNames | null | undefined;

function displayNames(): Intl.DisplayNames | null {
  if (displayNamesMemo === undefined) {
    try {
      displayNamesMemo = new Intl.DisplayNames(undefined, { type: 'region' });
    } catch {
      displayNamesMemo = null;
    }
  }
  return displayNamesMemo;
}

/**
 * Every code paired with its name, sorted by name in the reader's own locale.
 *
 * Sorted here rather than in the template because the order depends on the
 * names, which depend on the locale: an alphabetical-by-code list reads as
 * arbitrary to anyone whose language is not English, and `Intl.Collator` is
 * what puts `Åland` where a Swedish reader expects it rather than after `Z`.
 *
 * Computed once and shared. The list is the same for every reader of a given
 * tab — the locale does not change under them — and the game-over screen is
 * created afresh after every round, so recomputing 249 names and a collated
 * sort each time would be paid repeatedly for an answer that cannot have
 * changed.
 */
let optionsMemo: readonly { code: string; name: string }[] | undefined;

export function regionOptions(): readonly { code: string; name: string }[] {
  if (!optionsMemo) {
    const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
    optionsMemo = REGION_CODES.map((code) => ({ code, name: regionName(code) })).sort((a, b) =>
      collator.compare(a.name, b.name),
    );
  }
  return optionsMemo;
}
