import { Injectable } from '@angular/core';
import type { FirebaseOptions } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';
import { Observable, defer, map } from 'rxjs';
import { CustomQuestionDoc, LeaderboardEntry } from '../models/question.model';
import { withTimeout } from '../utils/with-timeout.util';

const CUSTOM_QUESTIONS_COLLECTION = 'custom_questions';
const LEADERBOARD_COLLECTION = 'leaderboard';
const FIRESTORE_TIMEOUT_MS = 10_000;

/**
 * Reserved Firebase Hosting endpoint that returns the web app config for
 * whichever project is serving the current origin. In production this is
 * generated automatically by Hosting; in dev it's proxied to the live
 * Hosting site (see src/proxy.conf.json). This means no Firebase config —
 * not even the "safe to expose" apiKey — ever needs to live in a committed
 * environment file.
 */
const RUNTIME_CONFIG_URL = '/__/firebase/init.json';

/**
 * Thin wrapper around the Firebase modular SDK. Kept framework-agnostic
 * (no AngularFire) so this service can be reused as-is inside Capacitor
 * and Tauri shells without pulling in Angular-specific DI wiring.
 */
type FirestoreModule = typeof import('firebase/firestore');

@Injectable({ providedIn: 'root' })
export class FirebaseService {
  private firestorePromise: Promise<{ firestore: Firestore; firestoreModule: FirestoreModule }> | null =
    null;

  private async loadRuntimeConfig(): Promise<FirebaseOptions> {
    const response = await fetch(RUNTIME_CONFIG_URL);
    if (!response.ok) {
      throw new Error(`Failed to load Firebase config from ${RUNTIME_CONFIG_URL}`);
    }
    return response.json();
  }

  /**
   * Lazily loads the Firebase SDK, fetches the runtime config, and initializes
   * Firebase exactly once. The SDK is dynamically imported (instead of a
   * top-level import) so it isn't bundled into the initial route chunk —
   * most users never touch custom questions or the leaderboard.
   */
  private getFirestore() {
    if (!this.firestorePromise) {
      this.firestorePromise = Promise.all([
        import('firebase/app'),
        import('firebase/firestore'),
        this.loadRuntimeConfig(),
      ]).then(([{ initializeApp }, firestoreModule, config]) => {
        const app = initializeApp(config);
        return { firestore: firestoreModule.getFirestore(app), firestoreModule };
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

  async saveHighScore(entry: LeaderboardEntry): Promise<void> {
    const { firestore, firestoreModule } = await this.getFirestore();
    await withTimeout(
      firestoreModule.addDoc(firestoreModule.collection(firestore, LEADERBOARD_COLLECTION), entry),
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
