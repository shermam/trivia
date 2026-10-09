/**
 * The server's daily ceiling on banked games — the app's copy of
 * `DAILY_GAME_CEILING` in `functions/src/daily-ceiling.ts`, which is the one
 * `recordGameResult` enforces.
 *
 * **Only words, never a decision.** The client does not count games against it
 * or hold one back: the free tier's five a day is `DailyGameLimitService`'s and
 * stays exactly as it is, and Pro has no limit the app applies. This number is
 * here for one sentence — `/profile` naming the limit when the server refused
 * the last game with `daily-limit` — and it is held equal to the server's by
 * `daily-ceiling.spec.ts`, which imports the functions module across the
 * package boundary, so the sentence cannot name a number the server does not
 * enforce.
 */
export const DAILY_GAME_CEILING = 200;
