/**
 * Checks that everything offline play needs is in the service worker's
 * **prefetch** group, and that everything in the lazy group really is
 * dispensable.
 *
 * ## Why this needs a script rather than a careful read of `ngsw-config.json`
 *
 * The precache is written as globs over hashed filenames, so what a group
 * actually holds is only knowable after a build. Two things then have to be
 * true at once, and neither is visible in the config:
 *
 *  1. **Every chunk `/`, `/play` and `/game-over` load must be prefetched.**
 *     `installMode: "lazy"` caches a file the first time it is *requested
 *     through a controlled page* — which for a route the player has never
 *     visited is never. A game route in the lazy group is therefore a game
 *     that does not start once the network is gone, and the failure appears
 *     only on a device that is already offline.
 *  2. **A chunk reaches exactly one group, and the first one wins.** The
 *     generator assigns each file to the first group whose globs match it and
 *     skips it thereafter (`@angular/service-worker/config`, `seenMap`), which
 *     is what lets `deferred-routes` name seven components ahead of an `app`
 *     group that sweeps up `/*.js`. Ordering that load-bearing deserves a test
 *     rather than a comment, not least because the config file is JSON and
 *     cannot carry the comment.
 *
 * ## What it does
 *
 * Walks the emitted bundle graph from `main`'s entry and from each game
 * route's dynamically-imported chunk, following **static** imports only —
 * a dynamic import is by definition another route's boundary. The resulting
 * set is what a game needs on disk. Every file in it must appear in the
 * prefetch group's `urls`.
 *
 * It then requires every emitted `*.component-*.js` to be *classified*: either
 * reachable from the game closure (and so prefetched) or named by the lazy
 * group. Adding a route therefore fails the build until somebody says which it
 * is — which is the decision `FEAT-017` wants made deliberately, in the same PR
 * as the route, rather than defaulted into the install cost of every visitor.
 *
 * Named chunks (`namedChunks: true` in `angular.json`) are what makes any of
 * this addressable: without them every lazy chunk is emitted as
 * `chunk-<hash>.js` and no glob can pick one out from another.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist/trivia-app/browser';
const MANIFEST = join(DIST, 'ngsw.json');
const PREFETCH_GROUP = 'app';
const LAZY_GROUP = 'deferred-routes';

/**
 * The routes that have to work with no network: the shell, the setup screen,
 * the quiz itself and the result screen. `game-over` is on the list because a
 * game played offline still ends — the screen that says so, and that offers the
 * score to a leaderboard it cannot reach, has to render.
 */
const GAME_ROUTE_CHUNKS = ['game-setup.component-', 'quiz-loop.component-', 'game-over.component-'];

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!existsSync(MANIFEST)) {
  fail(
    `${MANIFEST} does not exist. This runs after a build that emits a service worker (the ` +
      `'production', 'dev-project' and 'lighthouse' configurations in angular.json).`,
  );
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const groupUrls = new Map(manifest.assetGroups.map((group) => [group.name, new Set(group.urls)]));
const prefetch = groupUrls.get(PREFETCH_GROUP);
const lazy = groupUrls.get(LAZY_GROUP);
if (!prefetch || !lazy) {
  fail(
    `ngsw.json has no '${PREFETCH_GROUP}' and '${LAZY_GROUP}' asset groups — it has ` +
      `${[...groupUrls.keys()].join(', ')}. Renaming a group in ngsw-config.json means renaming ` +
      `it here too; the split is the thing being checked.`,
  );
}

const files = readdirSync(DIST).filter((file) => file.endsWith('.js'));

/** `import "./x.js"` / `from "./x.js"`, minus the dynamic ones, per chunk. */
const staticImports = new Map(
  files.map((file) => {
    const source = readFileSync(join(DIST, file), 'utf8');
    const statics = new Set(
      [...source.matchAll(/(?:from|import)\s*["'`]\.\/([^"'`]+\.js)["'`]/g)].map((m) => m[1]),
    );
    for (const [, dynamic] of source.matchAll(/import\s*\(\s*["'`]\.\/([^"'`]+\.js)["'`]\s*\)/g)) {
      statics.delete(dynamic);
    }
    return [file, statics];
  }),
);

function closure(entries) {
  const reached = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || reached.has(file)) {
      continue;
    }
    reached.add(file);
    queue.push(...(staticImports.get(file) ?? []));
  }
  return reached;
}

const entryFor = (prefix) => {
  const match = files.find((file) => file.startsWith(prefix));
  if (!match) {
    fail(
      `No emitted chunk starts with '${prefix}'. Either the route was renamed — in which case ` +
        `GAME_ROUTE_CHUNKS here and the globs in ngsw-config.json both need it — or ` +
        `namedChunks was turned off in angular.json, which makes every lazy chunk ` +
        `'chunk-<hash>.js' and this whole check unaddressable.`,
    );
  }
  return match;
};

const main = entryFor('main-');
const needed = closure([main, ...GAME_ROUTE_CHUNKS.map(entryFor)]);

const missing = [...needed].filter((file) => !prefetch.has(`/${file}`)).sort();
if (missing.length > 0) {
  fail(
    `Offline play needs these chunks and the '${PREFETCH_GROUP}' (prefetch) group does not ` +
      `carry them:\n    ${missing.join('\n    ')}\n  A chunk the game needs but the worker only ` +
      `caches lazily is a game that will not start on a device that is already offline.`,
  );
}

const demoted = [...needed].filter((file) => lazy.has(`/${file}`)).sort();
if (demoted.length > 0) {
  fail(
    `These chunks are in the '${LAZY_GROUP}' group but offline play reaches them:\n    ` +
      `${demoted.join('\n    ')}`,
  );
}

const unclassified = files
  .filter((file) => /\.component-[^.]+\.js$/.test(file))
  .filter((file) => !needed.has(file) && !lazy.has(`/${file}`))
  .sort();
if (unclassified.length > 0) {
  fail(
    `These route chunks are neither reachable from a game route nor named by the ` +
      `'${LAZY_GROUP}' group, so they are being precached by the catch-all:\n    ` +
      `${unclassified.join('\n    ')}\n  Add each to ngsw-config.json's '${LAZY_GROUP}' globs ` +
      `(the install then skips it and the worker caches it on first visit), or say here why the ` +
      `offline game needs it.`,
  );
}

const bytes = (urls) =>
  [...urls]
    .filter((url) => url.endsWith('.js'))
    .reduce((total, url) => total + readFileSync(join(DIST, url.slice(1))).length, 0);

console.log(
  `✓ Service worker precache scoped: ${needed.size} chunks offline play needs are all in ` +
    `'${PREFETCH_GROUP}'; ${lazy.size} route chunks (${bytes(lazy).toLocaleString()} bytes raw) ` +
    `install lazily.`,
);
