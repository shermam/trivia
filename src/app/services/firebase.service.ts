import { Injectable, inject } from '@angular/core';
import type { Firestore, QueryConstraint } from 'firebase/firestore';
import { Observable, defer, map } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  CustomQuestionDoc,
  Difficulty,
  LeaderboardEntry,
  NewCustomQuestionDoc,
} from '../models/question.model';
import { giveUpAfter } from '../utils/give-up-after.util';
import { FirebaseAppService } from './firebase-app.service';

const CUSTOM_QUESTIONS_COLLECTION = 'custom_questions';
const LEADERBOARD_COLLECTION = 'leaderboard';
const FIRESTORE_TIMEOUT_MS = 10_000;
const FIRESTORE_EMULATOR_HOST = '127.0.0.1';
const FIRESTORE_EMULATOR_PORT = 8080;

/**
 * Thin wrapper around the Firebase modular SDK. Kept framework-agnostic
 * (no AngularFire) so this service can be reused as-is inside Capacitor
 * and Tauri shells without pulling in Angular-specific DI wiring.
 */
type FirestoreModule = typeof import('firebase/firestore');

/** What to draw from the shared question bank. `limit` is mandatory on purpose — see `getCustomQuestions`. */
export interface CustomQuestionsQuery {
  /** Exact category match; empty/omitted means any. */
  category?: string;
  /** Exact difficulty match; empty/omitted means any. */
  difficulty?: Difficulty | '';
  /** Hard ceiling on documents read. */
  limit: number;
}

/**
 * The alphabet Firestore draws auto-IDs from, and the length it uses.
 *
 * Reproduced rather than imported because the SDK doesn't export its ID
 * generator. It only has to describe the same *space* the real IDs occupy —
 * a cursor is a position to start reading from, never a document that has to
 * exist.
 */
const AUTO_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const AUTO_ID_LENGTH = 20;

/**
 * A random point in the document-ID space, used as a sampling cursor.
 *
 * Uses `crypto.getRandomValues` for a uniform draw over the alphabet;
 * `Math.random() * 62` truncated is also uniform enough here, but the crypto
 * API is available everywhere this app runs and costs nothing.
 */
function randomDocumentId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(AUTO_ID_LENGTH));
  let id = '';
  for (const byte of bytes) {
    id += AUTO_ID_ALPHABET[byte % AUTO_ID_ALPHABET.length];
  }
  return id;
}

@Injectable({ providedIn: 'root' })
export class FirebaseService {
  private readonly firebaseAppService = inject(FirebaseAppService);

  private firestorePromise: Promise<{
    firestore: Firestore;
    firestoreModule: FirestoreModule;
  }> | null = null;

  /**
   * Public so other services (e.g. SubscriptionService) can share the same
   * lazily-initialized Firestore instance instead of each opening their own
   * — `getFirestore(app)` is idempotent per app, but there's no reason to
   * duplicate the dynamic import + emulator-connect logic below.
   */
  getFirestore() {
    if (!this.firestorePromise) {
      this.firestorePromise = Promise.all([
        import('firebase/firestore'),
        this.firebaseAppService.getApp(),
      ]).then(([firestoreModule, app]) => {
        const firestore = firestoreModule.getFirestore(app);
        if (environment.useEmulators) {
          firestoreModule.connectFirestoreEmulator(
            firestore,
            FIRESTORE_EMULATOR_HOST,
            FIRESTORE_EMULATOR_PORT,
          );
        }
        return { firestore, firestoreModule };
      });
    }
    return this.firestorePromise;
  }

  /**
   * Draws up to `limit` questions from the shared bank, filtered server-side.
   *
   * This used to be `getDocs(collection(...))` with no `where` and no `limit`:
   * every custom or mixed game downloaded the **entire** public collection and
   * filtered it in the browser (finding C1). That is billed per document, grows
   * with other people's contributions rather than with anything this player
   * asked for, and — on a publicly readable collection — is trivially
   * scriptable into a bill. `CLAUDE.md` §4.1 states the rule it broke.
   *
   * **Randomness is the reason this isn't just `limit(n)`.** Ordering is by
   * document ID, so a plain limit would hand every player the same first N
   * questions forever. Instead the query starts at a randomly generated
   * document ID and reads forward, wrapping around to the start of the
   * collection if that lands too near the end. Firestore's auto-IDs are drawn
   * uniformly from a 62-character alphabet, so a random ID is a uniform
   * position in the collection — which makes the ID space usable as a sampling
   * cursor with **no schema change, no new field and no backfill**.
   *
   * That last part is what makes this affordable: the obvious alternative is a
   * `random` field on every document, which `custom_questions`' exact-key
   * `hasOnly()` allowlist would have to be widened for, which existing
   * documents would not have, and which no client can backfill because the
   * collection is create-only (the same wall A10 hit).
   *
   * Costs at most two reads of `limit` documents each, and usually one — the
   * wrap only runs when the first pass came up short.
   */
  getCustomQuestions(
    options: CustomQuestionsQuery,
  ): Observable<(CustomQuestionDoc & { id: string })[]> {
    return defer(() => this.fetchCustomQuestions(options));
  }

  private async fetchCustomQuestions(
    options: CustomQuestionsQuery,
  ): Promise<(CustomQuestionDoc & { id: string })[]> {
    const { category, difficulty, limit } = options;
    if (limit <= 0) {
      return [];
    }

    const { firestore, firestoreModule: fm } = await this.getFirestore();
    const collection = fm.collection(firestore, CUSTOM_QUESTIONS_COLLECTION);

    const filters = [
      ...(category ? [fm.where('category', '==', category)] : []),
      ...(difficulty ? [fm.where('difficulty', '==', difficulty)] : []),
    ];
    const cursor = randomDocumentId();

    const runQuery = async (...constraints: QueryConstraint[]) => {
      const snapshot = await giveUpAfter(
        fm.getDocs(fm.query(collection, ...filters, fm.orderBy(fm.documentId()), ...constraints)),
        FIRESTORE_TIMEOUT_MS,
      );
      return snapshot.docs;
    };

    const docs = await runQuery(fm.startAt(cursor), fm.limit(limit));

    // The cursor landed near the end of the collection (or the bank simply
    // holds fewer than `limit` matches), so take the remainder from the start.
    // Without this, a high cursor would systematically return short and the
    // questions sorting earliest would be served far less often than the rest.
    if (docs.length < limit) {
      docs.push(...(await runQuery(fm.endBefore(cursor), fm.limit(limit - docs.length))));
    }

    return docs.map((doc) => ({
      id: doc.id,
      ...(doc.data() as CustomQuestionDoc),
    }));
  }

  /**
   * Adds a player-submitted question to the shared bank via an auto-id
   * `addDoc` (unlike the leaderboard, there's no per-user document to
   * upsert). Rejected outright by `firestore.rules` for anonymous/unverified
   * callers or a malformed payload — see `isValidCustomQuestion` there.
   *
   * The caller supplies `createdBy`/`createdAt` (same convention as
   * `saveHighScore` taking `uid`). The rules reject a `createdBy` that isn't
   * the caller's own uid, so passing the wrong one fails the write rather
   * than mis-attributing the question.
   */
  async addCustomQuestion(question: NewCustomQuestionDoc): Promise<void> {
    const { firestore, firestoreModule } = await this.getFirestore();
    await giveUpAfter(
      firestoreModule.addDoc(
        firestoreModule.collection(firestore, CUSTOM_QUESTIONS_COLLECTION),
        question,
      ),
      FIRESTORE_TIMEOUT_MS,
    );
  }

  /**
   * Leaderboard entries are keyed by uid (one entry per user, best score
   * wins) — the write is a `setDoc` on `leaderboard/{uid}`, not an
   * auto-id `addDoc`. Firestore rules reject the write outright if
   * `entry.score` isn't higher than the user's existing best, so a
   * rejection here doesn't necessarily mean an error, just "not a new PB".
   */
  async saveHighScore(entry: LeaderboardEntry): Promise<void> {
    const { firestore, firestoreModule } = await this.getFirestore();
    await giveUpAfter(
      firestoreModule.setDoc(
        firestoreModule.doc(firestore, LEADERBOARD_COLLECTION, entry.uid),
        entry,
      ),
      FIRESTORE_TIMEOUT_MS,
    );
  }

  /**
   * The caller's own leaderboard row, or null if they have never saved one.
   *
   * Exists so a rejected save can be *explained* rather than guessed at: the
   * rules refuse a write for several reasons (a score that doesn't improve, a
   * clock too far off, a name too long, an account that isn't verified), and
   * only one of them is the friendly "your best is already higher". Reading
   * the existing row is what tells those apart. A document `get` on a known
   * path, not a collection scan — see `CLAUDE.md` §4.1.
   */
  async getLeaderboardEntry(uid: string): Promise<LeaderboardEntry | null> {
    const { firestore, firestoreModule } = await this.getFirestore();
    const snapshot = await giveUpAfter(
      firestoreModule.getDoc(firestoreModule.doc(firestore, LEADERBOARD_COLLECTION, uid)),
      FIRESTORE_TIMEOUT_MS,
    );
    return snapshot.exists() ? ({ id: snapshot.id, ...snapshot.data() } as LeaderboardEntry) : null;
  }

  getTopScores(topN = 10): Observable<LeaderboardEntry[]> {
    return defer(() =>
      this.getFirestore().then(({ firestore, firestoreModule }) => {
        const leaderboardQuery = firestoreModule.query(
          firestoreModule.collection(firestore, LEADERBOARD_COLLECTION),
          firestoreModule.orderBy('score', 'desc'),
          firestoreModule.limit(topN),
        );
        return giveUpAfter(firestoreModule.getDocs(leaderboardQuery), FIRESTORE_TIMEOUT_MS);
      }),
    ).pipe(
      map((snapshot) =>
        snapshot.docs.map((doc) => ({
          id: doc.id,
          ...(doc.data() as Omit<LeaderboardEntry, 'id'>),
        })),
      ),
    );
  }
}
