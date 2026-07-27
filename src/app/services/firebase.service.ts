import { Injectable } from '@angular/core';
import { FirebaseApp, FirebaseOptions, initializeApp } from 'firebase/app';
import {
  Firestore,
  addDoc,
  collection,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
} from 'firebase/firestore';
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
@Injectable({ providedIn: 'root' })
export class FirebaseService {
  private firestorePromise: Promise<Firestore> | null = null;

  private async loadRuntimeConfig(): Promise<FirebaseOptions> {
    const response = await fetch(RUNTIME_CONFIG_URL);
    if (!response.ok) {
      throw new Error(`Failed to load Firebase config from ${RUNTIME_CONFIG_URL}`);
    }
    return response.json();
  }

  /** Lazily fetches the runtime config and initializes Firebase exactly once. */
  private getFirestore(): Promise<Firestore> {
    if (!this.firestorePromise) {
      this.firestorePromise = this.loadRuntimeConfig()
        .then((config): FirebaseApp => initializeApp(config))
        .then((app) => getFirestore(app));
    }
    return this.firestorePromise;
  }

  getCustomQuestions(): Observable<(CustomQuestionDoc & { id: string })[]> {
    return defer(() =>
      this.getFirestore().then((firestore) =>
        withTimeout(
          getDocs(collection(firestore, CUSTOM_QUESTIONS_COLLECTION)),
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
    const firestore = await this.getFirestore();
    await withTimeout(
      addDoc(collection(firestore, LEADERBOARD_COLLECTION), entry),
      FIRESTORE_TIMEOUT_MS,
    );
  }

  getTopScores(topN = 10): Observable<LeaderboardEntry[]> {
    return defer(() =>
      this.getFirestore().then((firestore) => {
        const leaderboardQuery = query(
          collection(firestore, LEADERBOARD_COLLECTION),
          orderBy('score', 'desc'),
          limit(topN),
        );
        return withTimeout(getDocs(leaderboardQuery), FIRESTORE_TIMEOUT_MS);
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
