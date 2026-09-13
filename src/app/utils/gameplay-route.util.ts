/**
 * The one screen in the app with a zero-distraction rule: an active quiz
 * round. Both the footer's donation CTA and the auth menu's entry are hidden
 * there (`FEAT-013` §1), and the exclusion is about the screen rather than
 * about which control it is reached from — so the two ask the same function
 * rather than each carrying their own copy of the path and the parsing.
 */
const GAMEPLAY_ROUTE = '/play';

/**
 * Whether a router URL is the quiz round.
 *
 * Matched on the path rather than the whole URL: `/play` carries no query
 * today, but `?embed=1` proves the app is willing to add one, and a fragment
 * costs nothing to allow for while the query is already being stripped.
 */
export function isGameplayRoute(url: string): boolean {
  return url.split('?')[0].split('#')[0] === GAMEPLAY_ROUTE;
}
