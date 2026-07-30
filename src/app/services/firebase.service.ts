import { Injectable, inject } from '@angular/core';
import type { Firestore } from 'firebase/firestore';
import { Observable, defer, map } from 'rxjs';
import { environment } from '../../environments/environment';
import { CustomQuestionDoc, LeaderboardEntry } from '../models/question.model';
import { withTimeout } from '../utils/with-timeout.util';
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

  getCustomQuestions(): Observable<(CustomQuestionDoc & { id: string })[]> {
    return defer(() =>
      this.getFirestore().then(({ firestore, firestoreModule }) =>
        withTimeout(
          firestoreModule.getDocs(
            firestoreModule.collection(firestore, CUSTOM_QUESTIONS_COLLECTION),
          ),
          FIRESTORE_TIMEOUT_MS,
        ),
      ),
    ).pipe(
      map((snapshot) =>
        snapshot.docs.map((doc) => ({
          id: doc.id,
          ...(doc.data() as CustomQuestionDoc),
        })),
      ),
    );
  }

  /**
   * Adds a player-submitted question to the shared bank via an auto-id
   * `addDoc` (unlike the leaderboard, there's no per-user document to
   * upsert). Rejected outright by `firestore.rules` for anonymous/unverified
   * callers or a malformed payload — see `isValidCustomQuestion` there.
   */
  async addCustomQuestion(question: CustomQuestionDoc): Promise<void> {
    const { firestore, firestoreModule } = await this.getFirestore();
    await withTimeout(
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
    await withTimeout(
      firestoreModule.setDoc(
        firestoreModule.doc(firestore, LEADERBOARD_COLLECTION, entry.uid),
        entry,
      ),
      FIRESTORE_TIMEOUT_MS,
    );
  }

  getTopScores(topN = 10): Observable<LeaderboardEntry[]> {
    return defer(() =>
      this.getFirestore().then(({ firestore, firestoreModule }) => {
        const leaderboardQuery = firestoreModule.query(
          firestoreModule.collection(firestore, LEADERBOARD_COLLECTION),
          firestoreModule.orderBy('score', 'desc'),
          firestoreModule.limit(topN),
        );
        return withTimeout(firestoreModule.getDocs(leaderboardQuery), FIRESTORE_TIMEOUT_MS);
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
