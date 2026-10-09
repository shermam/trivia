/**
 * The duplicate check behind `recordGameResult`: the ids of the last games an
 * account banked, kept on `users/{uid}` as a bounded ring, newest first.
 *
 * **A ring rather than the one id it replaced.** The check used to be a single
 * `lastGameId`, which stops an immediate repeat and nothing else: bank game A,
 * then B, then A again, and A counted twice. Nothing about that needs a forger.
 * `/game-over` survives a reload by design, so a results screen left open in one
 * tab re-sends its game when it is reloaded after a second tab has banked
 * another — and a saved payload can be sent in alternation with fresh games at
 * will. Holding the last {@link RECENT_GAMES_KEPT} ids makes "one bank per game
 * id" true across any interleaving a person could produce.
 *
 * **Idempotency, not anti-cheat.** The game id is minted by the client, so a
 * caller who wants a game counted twice can send it again under a new id, and
 * no ring of any size stops that. What bounds a forger is the daily ceiling
 * (`daily-ceiling.ts`) and the payload's own bounds — audit decision A1,
 * bounded rather than attested. The ring's job is narrower and absolute: the
 * same id never banks twice while it is in the ring.
 *
 * **Bounded, so the document stays small.** Twenty ids of at most 128
 * characters is under three kilobytes in the worst case and well under one for
 * the UUIDs the app mints. An id falls out of the ring once twenty newer games
 * have banked — far past any reload, retry or second tab a real player makes.
 *
 * Kept pure and dependency-free for the reason `game-xp.ts` is: `CLAUDE.md`
 * §4.6 wants a direct unit test on every decision a Cloud Function makes, and
 * that stays cheap only while the decision needs no Firestore behind it.
 */

/** How many game ids the ring keeps — the newest first, the oldest dropped. */
export const RECENT_GAMES_KEPT = 20;

/** The longest game id `recordGameResult` accepts, and therefore stores. */
export const MAX_GAME_ID_LENGTH = 128;

function isGameId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_GAME_ID_LENGTH;
}

/**
 * The ring a stored `users/{uid}` holds, newest first and never longer than
 * {@link RECENT_GAMES_KEPT}.
 *
 * - **A malformed ring reads as empty.** Only `recordGameResult` writes
 *   `recentGameIds`, and only ever as an array of game ids, so anything else is
 *   a hand edit in the console — and a reader has to be right regardless of the
 *   writer (`CLAUDE.md` §4.4). One entry that is not an id makes the whole
 *   array suspect rather than a list to pick through.
 * - **The old `lastGameId` is read as a ring of one** — the migration, done in
 *   place: a document written before the ring existed carries only that, and
 *   the first game banked on it writes the ring and drops the field
 *   (`hasLegacyGameId`). Should both ever be present — an instance still on the
 *   old code banking a game during the deploy that replaced it — the legacy id
 *   is the newer of the two and goes first, so it is the last to fall out.
 */
export function recentGameIdsOf(stored: unknown): string[] {
  if (typeof stored !== 'object' || stored === null) {
    return [];
  }
  const { recentGameIds, lastGameId } = stored as Record<string, unknown>;
  const ring =
    Array.isArray(recentGameIds) && recentGameIds.every(isGameId) ? [...recentGameIds] : [];
  if (isGameId(lastGameId) && !ring.includes(lastGameId)) {
    ring.unshift(lastGameId);
  }
  return ring.slice(0, RECENT_GAMES_KEPT);
}

/**
 * Whether a stored document still carries the field the ring replaced — in
 * which case the write that banks its next game deletes it. Any value counts,
 * a malformed one included: the field is retired, not repaired.
 */
export function hasLegacyGameId(stored: unknown): boolean {
  return typeof stored === 'object' && stored !== null && Object.hasOwn(stored, 'lastGameId');
}

/** The ring once `gameId` has banked: it first, then the rest, the oldest beyond the bound dropped. */
export function withRecentGame(ring: readonly string[], gameId: string): string[] {
  return [gameId, ...ring.filter((id) => id !== gameId)].slice(0, RECENT_GAMES_KEPT);
}
