import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, map } from 'rxjs';
import {
  CustomQuestionDoc,
  Difficulty,
  GameConfig,
  OpenTriviaApiQuestion,
  OpenTriviaApiResponse,
  TriviaQuestion,
} from '../models/question.model';
import { decodeHtmlEntities } from '../utils/html-entities.util';
import { shuffleArray } from '../utils/shuffle.util';
import { FirebaseService } from './firebase.service';

export interface TriviaCategory {
  id: number;
  name: string;
}

const OPEN_TRIVIA_QUESTIONS_URL = 'https://opentdb.com/api.php';
const OPEN_TRIVIA_CATEGORIES_URL = 'https://opentdb.com/api_category.php';

@Injectable({ providedIn: 'root' })
export class TriviaService {
  private readonly http = inject(HttpClient);
  private readonly firebaseService = inject(FirebaseService);

  private categoriesPromise: Promise<TriviaCategory[]> | null = null;

  getCategories(): Promise<TriviaCategory[]> {
    if (!this.categoriesPromise) {
      this.categoriesPromise = firstValueFrom(
        this.http.get<{ trivia_categories: TriviaCategory[] }>(OPEN_TRIVIA_CATEGORIES_URL).pipe(
          map((res) => res.trivia_categories),
        ),
      );
    }
    return this.categoriesPromise;
  }

  /** Unified entry point: fetches questions from Open Trivia DB, Firestore, or both. */
  async getQuestions(config: GameConfig): Promise<TriviaQuestion[]> {
    const { amount, category, difficulty, source } = config;

    if (source === 'open_trivia') {
      return this.fetchOpenTriviaQuestions(amount, category, difficulty);
    }

    if (source === 'custom') {
      return this.fetchCustomQuestions(amount, category, difficulty);
    }

    const openTriviaAmount = Math.ceil(amount / 2);
    const customAmount = amount - openTriviaAmount;

    const [openTriviaQuestions, customQuestions] = await Promise.all([
      this.fetchOpenTriviaQuestions(openTriviaAmount, category, difficulty).catch(() => []),
      this.fetchCustomQuestions(customAmount, category, difficulty),
    ]);

    return shuffleArray([...openTriviaQuestions, ...customQuestions]).slice(0, amount);
  }

  private async fetchOpenTriviaQuestions(
    amount: number,
    category: string,
    difficulty: Difficulty | '',
  ): Promise<TriviaQuestion[]> {
    if (amount <= 0) {
      return [];
    }

    let params = new HttpParams().set('amount', amount);

    if (category) {
      const categoryId = await this.resolveCategoryId(category);
      if (categoryId !== undefined) {
        params = params.set('category', categoryId);
      }
    }
    if (difficulty) {
      params = params.set('difficulty', difficulty);
    }

    const response = await firstValueFrom(
      this.http.get<OpenTriviaApiResponse>(OPEN_TRIVIA_QUESTIONS_URL, { params }),
    );

    if (response.response_code !== 0) {
      return [];
    }

    return response.results.map((raw, index) =>
      this.mapToTriviaQuestion(raw, 'open_trivia', `open-${Date.now()}-${index}`),
    );
  }

  private async fetchCustomQuestions(
    amount: number,
    category: string,
    difficulty: Difficulty | '',
  ): Promise<TriviaQuestion[]> {
    if (amount <= 0) {
      return [];
    }

    const docs = await this.firebaseService.getCustomQuestions();

    const filtered = docs.filter((doc) => {
      const matchesCategory = !category || doc.category === category;
      const matchesDifficulty = !difficulty || doc.difficulty === difficulty;
      return matchesCategory && matchesDifficulty;
    });

    return shuffleArray(filtered)
      .slice(0, amount)
      .map((doc) => this.mapToTriviaQuestion(doc, 'custom', doc.id));
  }

  private async resolveCategoryId(categoryName: string): Promise<number | undefined> {
    const categories = await this.getCategories();
    return categories.find((c) => c.name === categoryName)?.id;
  }

  private mapToTriviaQuestion(
    raw: OpenTriviaApiQuestion | (CustomQuestionDoc & { id: string }),
    source: 'open_trivia' | 'custom',
    id: string,
  ): TriviaQuestion {
    const question = decodeHtmlEntities(raw.question);
    const correct_answer = decodeHtmlEntities(raw.correct_answer);
    const incorrect_answers = raw.incorrect_answers.map(decodeHtmlEntities);

    return {
      id,
      category: decodeHtmlEntities(raw.category),
      type: raw.type,
      difficulty: raw.difficulty,
      question,
      correct_answer,
      incorrect_answers,
      all_answers: shuffleArray([correct_answer, ...incorrect_answers]),
      source,
    };
  }
}
