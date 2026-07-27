import { Injectable, inject } from '@angular/core';
import type { Firestore } from 'firebase/firestore';
import { Observable, defer, map } from 'rxjs';
import { CustomQuestionDoc, LeaderboardEntry } from '../models/question.model';
import { withTimeout } from '../utils/with-timeout.util';
import { FirebaseAppService } from './firebase-app.service';

const CUSTOM_QUESTIONS_COLLECTION = 'custom_questions';
const LEADERBOARD_COLLECTION = 'leaderboard';
const FIRESTORE_TIMEOUT_MS = 10_000;

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

  private getFirestore() {
    if (!this.firestorePromise) {
      this.firestorePromise = Promise.all([
        import('firebase/firestore'),
        this.firebaseAppService.getApp(),
      ]).then(([firestoreModule, app]) => ({
        firestore: firestoreModule.getFirestore(app),
        firestoreModule,
      }));
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
