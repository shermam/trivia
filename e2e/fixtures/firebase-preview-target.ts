import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { App, deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { CreatedState, FirebaseTarget } from './firebase-target';
import { LEADERBOARD_BOARDS } from './types';

/**
 * The **real** Firebase project a preview run writes to, as the other half of
 * the `FirebaseTarget` seam (`firebase-target.ts`).
 *
 * Everything here exists because this target is not an emulator. There is no
 * `firebase emulators:exec` discarding the database at the end, no `demo-`
 * prefix keeping the SDK offline, and no second chance: the project is
 * persistent, publicly readable, and — until FEAT-012 — was production. A run
 * that creates an account and forgets it leaves that account there for good.
 *
 * So the two things this file is: a refusal to guess which project it is
 * pointed at, and a sweep that deletes exactly what the run created.
 */

/** The project id refused outright, however it is spelled into the environment. */
function productionProjectId(): string {
  /*
   * Read from `.firebaserc` rather than restated as a constant here, for two
   * reasons that happen to point the same way.
   *
   * `.firebaserc` is where the production project id lives and, per
   * `scripts/verify-environment-isolation.mjs`, the only place it lives that a
   * developer's machine can reach — so a second copy in this file would be a
   * second thing to update if the project is ever renamed, and the copy that
   * went stale would be this guard, silently passing the id it was written to
   * refuse. And `npm run env:verify` fails when any `e2e/fixtures/*.ts` names
   * the production project at all, which is the rule that protects this
   * directory; deriving the id keeps that rule absolute rather than needing an
   * exception carved out for the one line that means the opposite.
   */
  const config = JSON.parse(readFileSync(join(repositoryRoot(), '.firebaserc'), 'utf8')) as {
    projects?: { default?: string };
  };
  const projectId = config.projects?.default;
  if (!projectId) {
    throw new Error(
      '.firebaserc names no default project, so there is nothing to check the preview target ' +
        'against. That file is where the production project id lives; this target refuses to ' +
        'run without knowing which id it must never accept.',
    );
  }
  return projectId;
}

/**
 * The repository root, found by walking up for `.firebaserc`.
 *
 * `process.cwd()` is the root already when the suite is started the supported
 * way (`npm run e2e:preview`, and npm runs scripts from the package
 * directory), so the walk is only there so that running `playwright test` by
 * hand from a subdirectory does not turn into a confusing "cannot find
 * `.firebaserc`". Not finding it at all throws rather than falling back,
 * because the fallback would be "skip the production check".
 */
function repositoryRoot(): string {
  let directory = process.cwd();
  for (;;) {
    if (existsSync(join(directory, '.firebaserc'))) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(
        `No .firebaserc above ${process.cwd()}. The preview target reads the production project ` +
          'id from it so it can refuse that project; without the file it cannot make that check ' +
          'and will not run. Start the suite from the repository root.',
      );
    }
    directory = parent;
  }
}

/**
 * Which project this run writes to — from the environment, with **no default**,
 * because there is no value it could safely default to.
 *
 * It was hard-coded to production once, which meant every PR seeded real Auth
 * users, real `custom_questions` documents and real leaderboard rows into the
 * live project and swept them afterwards on a best-effort basis. A default
 * would preserve exactly that failure mode: silently correct-looking, pointed
 * at the wrong database. Throwing is the point.
 *
 * The production id is *rejected* rather than merely not defaulted to. This
 * target holds Admin-SDK credentials and bypasses `firestore.rules` entirely,
 * so "someone set the variable to production" is a mistake worth refusing
 * rather than obeying.
 */
function previewProjectId(): string {
  const projectId = process.env['FIREBASE_PREVIEW_PROJECT_ID'];
  if (!projectId) {
    throw new Error(
      'FIREBASE_PREVIEW_PROJECT_ID is not set. The preview target writes to a real Firebase ' +
        'project with Admin-SDK credentials, so it will not guess which one. Set it in ' +
        '.github/workflows/firebase-preview.yml (or your shell, for a local run).',
    );
  }
  const production = productionProjectId();
  if (projectId === production) {
    throw new Error(
      `FIREBASE_PREVIEW_PROJECT_ID is set to the production project (${production}). This ` +
        'target seeds and deletes Auth users and Firestore documents directly, bypassing ' +
        'firestore.rules. Point it at trivimind-dev.',
    );
  }
  return projectId;
}

/**
 * The real deployed project behind a Hosting preview channel.
 *
 * `projectId` is a **getter** so that none of the checks above run at import
 * time. This module is imported by `test.ts` alongside the emulator target, and
 * a throw at module scope would take the emulator suite down with it for a
 * variable only the preview suite needs.
 */
export const previewTarget: FirebaseTarget = {
  get projectId(): string {
    return previewProjectId();
  },

  /**
   * Credentials come from `GOOGLE_APPLICATION_CREDENTIALS` — the service-account
   * key the workflow writes to a temp file — through the Admin SDK's default
   * credential lookup. Unlike the emulator target, `FIRESTORE_EMULATOR_HOST` and
   * `FIREBASE_AUTH_EMULATOR_HOST` are never set here, and their presence is a
   * hard error rather than something to unset quietly: the browser under test
   * talks to the *deployed* channel's real Firestore and Auth whatever this
   * process does, so an Admin SDK pointed at an emulator would seed nothing the
   * app can see and — the part that matters — sweep nothing the run created,
   * leaving real accounts and documents behind while reporting success.
   */
  createAdminApp(): App {
    const projectId = previewProjectId();
    const emulatorHosts = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST'].filter(
      (name) => process.env[name],
    );
    if (emulatorHosts.length > 0) {
      throw new Error(
        `${emulatorHosts.join(' and ')} set while targeting the real project ${projectId}. The ` +
          'Admin SDK would talk to an emulator while the browser talks to the deployed channel, ' +
          'so nothing this run creates in the real project would ever be swept up.',
      );
    }
    // Named after the project, like the emulator target: an unnamed
    // `initializeApp` is a per-process singleton, so a "reuse whatever app
    // exists" shortcut would hand the second target in a worker the first
    // one's credentials without anything about the app looking wrong.
    return initializeApp({ projectId }, projectId);
  },

  /**
   * Delete exactly what the run created, and say so loudly if any of it could
   * not be deleted.
   *
   * **Not best-effort.** The original sweep was, and that is precisely why
   * nobody noticed it missing the ambient anonymous accounts for months: a
   * sweep that mostly works and never complains is indistinguishable from one
   * that works. Every delete is caught individually so one failure cannot abort
   * the rest, and the failures are then reported together — with the paths — so
   * the run that left something behind is the run that says so.
   *
   * Every path swept is keyed by something this run brought into existence: a
   * uid that did not exist before the run, or a document id the run chose. So
   * the sweep cannot reach a real visitor's data even if the list is wrong.
   */
  async cleanup(app: App, created: CreatedState): Promise<void> {
    const auth = getAuth(app);
    const firestore = getFirestore(app);
    const failures: string[] = [];

    /** Records a failure instead of throwing, so the rest of the sweep still runs. */
    const attempt = async (what: string, operation: Promise<unknown>): Promise<void> => {
      try {
        await operation;
      } catch (error) {
        failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    // A row can belong to a uid that was never an Auth user — a seeded rival
    // champion, for instance — and an account that saved a score has a row
    // nothing seeded, so the sweep has to visit the union of both.
    const leaderboardUids = new Set([...created.authUids, ...created.leaderboardUids]);

    /*
     * Which country boards exist on the real project, asked rather than
     * guessed (`FEAT-028`).
     *
     * A saved score now writes a second document under whatever country the
     * picker was set to, and on a preview channel that is decided by the
     * runner's own IP and time zone — so the sweep cannot know the country in
     * advance and must not have to. `listDocuments()` is the call that finds
     * these at all: nothing writes `regions/{region}`, so every country board
     * is a missing parent with an `entries` subcollection under it, invisible
     * to a `get()` and to a query alike. Same reasoning, and the same call, as
     * `deleteAccount`'s own sweep in `functions/src/leaderboards.ts`.
     */
    const regionsByBoard = await Promise.all(
      LEADERBOARD_BOARDS.map(async (board) => ({
        board,
        regions: await firestore.collection(`leaderboards/${board}/regions`).listDocuments(),
      })),
    );

    await Promise.all([
      ...[...created.authUids].flatMap((uid) => [
        attempt(
          `auth user ${uid}`,
          auth.deleteUser(uid).catch((error: unknown) => {
            // Already gone is the outcome this is trying to produce. Every
            // other Auth error is a real failure to report.
            if ((error as { code?: string })?.code === 'auth/user-not-found') {
              return;
            }
            throw error;
          }),
        ),
        // Lifetime totals, written by the `recordGameResult` callable the first
        // time a signed-in account finishes a game. Without this the document
        // outlives the Auth user that owned it, orphaned and beyond the reach
        // of `deleteAccount`.
        //
        // **Recursive**, like `customers/{uid}` below and for the same reason:
        // since `FEAT-049` the same callable writes a `plays` document per
        // completed game underneath this one, and deleting a document in
        // Firestore does not delete what hangs beneath it. A plain `delete()`
        // here would leave a real player-history subcollection in the project
        // on every preview run, with nothing able to find it again.
        attempt(`users/${uid}`, firestore.recursiveDelete(firestore.doc(`users/${uid}`))),
        // The next two are keyed by uid and so are swept without being tracked
        // individually. No spec in the current slice writes either — both come
        // from specs the slice deliberately excludes — but a slice that grows
        // should not also have to remember to grow this list, and deleting a
        // document that was never written costs one no-op write.
        attempt(`user_roles/${uid}`, firestore.doc(`user_roles/${uid}`).delete()),
        // Recursive, because `customers/{uid}` carries a `subscriptions`
        // subcollection and deleting a document in Firestore does not delete
        // what hangs beneath it.
        attempt(`customers/${uid}`, firestore.recursiveDelete(firestore.doc(`customers/${uid}`))),
      ]),
      // Every board, or a run leaves real rows behind on the ones this slice
      // happens not to write to.
      ...[...leaderboardUids].flatMap((uid) =>
        LEADERBOARD_BOARDS.map((board) =>
          attempt(
            `leaderboards/${board}/entries/${uid}`,
            firestore.doc(`leaderboards/${board}/entries/${uid}`).delete(),
          ),
        ),
      ),
      // Every country board that exists, for every uid this run touched — the
      // same union, one path segment deeper.
      ...[...leaderboardUids].flatMap((uid) =>
        regionsByBoard.flatMap(({ board, regions }) =>
          regions.map((region) =>
            attempt(
              `leaderboards/${board}/regions/${region.id}/entries/${uid}`,
              firestore.doc(`leaderboards/${board}/regions/${region.id}/entries/${uid}`).delete(),
            ),
          ),
        ),
      ),
      ...[...created.customQuestionIds].map((id) =>
        attempt(`custom_questions/${id}`, firestore.doc(`custom_questions/${id}`).delete()),
      ),
    ]);

    // The app holds gRPC channels and a metadata-server lookup that keeps
    // retrying for the life of the process, so it is closed whether or not the
    // sweep was clean.
    await deleteApp(app);

    if (failures.length > 0) {
      throw new Error(
        `The preview sweep could not delete ${failures.length} item(s) from the real project. ` +
          `They are still there, and nothing will retry them — delete them by hand:\n  ` +
          failures.join('\n  '),
      );
    }
  },
};
