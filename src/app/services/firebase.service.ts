import { Injectable } from '@angular/core';
import { FirebaseApp, initializeApp } from 'firebase/app';
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
import { environment } from '../../environments/environment';
import { CustomQuestionDoc, LeaderboardEntry } from '../models/question.model';
import { withTimeout } from '../utils/with-timeout.util';

const CUSTOM_QUESTIONS_COLLECTION = 'custom_questions';
const LEADERBOARD_COLLECTION = 'leaderboard';
const FIRESTORE_TIMEOUT_MS = 10_000;

/**
 * Thin wrapper around the Firebase modular SDK. Kept framework-agnostic
 * (no AngularFire) so this service can be reused as-is inside Capacitor
 * and Tauri shells without pulling in Angular-specific DI wiring.
 */
@Injectable({ providedIn: 'root' })
export class FirebaseService {
  private readonly app: FirebaseApp;
  private readonly firestore: Firestore;

  constructor() {
    this.app = initializeApp(environment.firebase);
    this.firestore = getFirestore(this.app);
  }

  async getCustomQuestions(): Promise<(CustomQuestionDoc & { id: string })[]> {
    const snapshot = await withTimeout(
      getDocs(collection(this.firestore, CUSTOM_QUESTIONS_COLLECTION)),
      FIRESTORE_TIMEOUT_MS,
    );
    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...(doc.data() as CustomQuestionDoc),
    }));
  }

  async saveHighScore(entry: LeaderboardEntry): Promise<void> {
    await withTimeout(
      addDoc(collection(this.firestore, LEADERBOARD_COLLECTION), entry),
      FIRESTORE_TIMEOUT_MS,
    );
  }

  async getTopScores(topN = 10): Promise<LeaderboardEntry[]> {
    const leaderboardQuery = query(
      collection(this.firestore, LEADERBOARD_COLLECTION),
      orderBy('score', 'desc'),
      limit(topN),
    );
    const snapshot = await withTimeout(getDocs(leaderboardQuery), FIRESTORE_TIMEOUT_MS);
    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...(doc.data() as Omit<LeaderboardEntry, 'id'>),
    }));
  }
}
