import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { CustomQuestionDoc, NewQuestionReportDoc } from '../models/question.model';
import { FirebaseService, QuestionReportRejectedError } from './firebase.service';

/**
 * Finding C1. `getCustomQuestions()` was `getDocs(collection(...))` — no
 * `where`, no `limit` — so every custom or mixed game downloaded the entire
 * public `custom_questions` collection and filtered it in the browser. That is
 * billed per document, scales with other people's contributions rather than
 * with anything the player asked for, and on a publicly readable collection is
 * trivially scriptable into a bill (`CLAUDE.md` §4.1).
 *
 * The fake Firestore module below implements just enough of the query
 * semantics (ID ordering, equality filters, `startAt`/`endBefore`, `limit`) to
 * assert on **what was actually sent to the server** rather than only on what
 * came back — which is the whole point of the finding: the old code returned
 * the right questions too, it just read the entire collection to do it.
 */

interface SeedDoc {
  id: string;
  data: CustomQuestionDoc;
}

function makeQuestion(overrides: Partial<CustomQuestionDoc> = {}): CustomQuestionDoc {
  return {
    category: 'Science',
    type: 'multiple',
    difficulty: 'easy',
    question: 'Q?',
    correct_answer: 'A',
    incorrect_answers: ['B'],
    ...overrides,
  };
}

interface RecordedQuery {
  wheres: { field: string; value: unknown }[];
  startAt?: string;
  endBefore?: string;
  limit?: number;
}

function fakeFirestore(seed: SeedDoc[]) {
  const queries: RecordedQuery[] = [];

  const firestoreModule = {
    collection: () => ({}),
    where: (field: string, _op: string, value: unknown) => ({ kind: 'where', field, value }),
    orderBy: () => ({ kind: 'orderBy' }),
    documentId: () => '__name__',
    startAt: (value: string) => ({ kind: 'startAt', value }),
    endBefore: (value: string) => ({ kind: 'endBefore', value }),
    limit: (value: number) => ({ kind: 'limit', value }),
    query: (_collection: unknown, ...constraints: Record<string, unknown>[]) => ({ constraints }),
    getDocs: (q: { constraints: Record<string, unknown>[] }) => {
      const find = (kind: string) => q.constraints.find((c) => c['kind'] === kind);
      const recorded: RecordedQuery = {
        wheres: q.constraints
          .filter((c) => c['kind'] === 'where')
          .map((c) => ({ field: c['field'] as string, value: c['value'] })),
        startAt: find('startAt')?.['value'] as string | undefined,
        endBefore: find('endBefore')?.['value'] as string | undefined,
        limit: find('limit')?.['value'] as number | undefined,
      };
      queries.push(recorded);

      let rows = [...seed].sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const w of recorded.wheres) {
        rows = rows.filter(
          (r) => (r.data as unknown as Record<string, unknown>)[w.field] === w.value,
        );
      }
      if (recorded.startAt !== undefined) {
        rows = rows.filter((r) => r.id >= recorded.startAt!);
      }
      if (recorded.endBefore !== undefined) {
        rows = rows.filter((r) => r.id < recorded.endBefore!);
      }
      if (recorded.limit !== undefined) {
        rows = rows.slice(0, recorded.limit);
      }
      return Promise.resolve({ docs: rows.map((r) => ({ id: r.id, data: () => r.data })) });
    },
  };

  return { firestoreModule, queries };
}

/** Forces every character of the random cursor, so the wraparound branch is reachable on purpose. */
function pinCursor(alphabetIndex: number) {
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
    const bytes = array as Uint8Array;
    bytes.fill(alphabetIndex);
    return array;
  });
}

const HIGH_CURSOR = 51; // 'z' — sorts after a 'q…' document id
const LOW_CURSOR = 61; // '9' — sorts before a 'q…' document id

function setup(seed: SeedDoc[]) {
  TestBed.configureTestingModule({});
  const service = TestBed.inject(FirebaseService);
  const { firestoreModule, queries } = fakeFirestore(seed);
  vi.spyOn(service, 'getFirestore').mockResolvedValue({
    firestore: {},
    firestoreModule,
  } as unknown as Awaited<ReturnType<FirebaseService['getFirestore']>>);
  return { service, queries };
}

describe('FirebaseService.getCustomQuestions (C1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  const bank: SeedDoc[] = Array.from({ length: 50 }, (_, i) => ({
    id: `q${String(i).padStart(2, '0')}`,
    data: makeQuestion({ question: `Q${i}?` }),
  }));

  it('never reads more documents than the requested limit', async () => {
    pinCursor(LOW_CURSOR);
    const { service, queries } = setup(bank);

    const result = await firstValueFrom(service.getCustomQuestions({ limit: 5 }));

    expect(result).toHaveLength(5);
    // The finding itself: every query carries a ceiling, so a 50-document bank
    // (or a 50,000-document one) costs the same as this five-question game.
    expect(queries.every((q) => q.limit !== undefined)).toBe(true);
    expect(queries.reduce((sum, q) => sum + (q.limit ?? 0), 0)).toBeLessThanOrEqual(5);
  });

  it('filters by category and difficulty server-side, not in the browser', async () => {
    pinCursor(LOW_CURSOR);
    const seed: SeedDoc[] = [
      { id: 'qa', data: makeQuestion({ category: 'Science', difficulty: 'easy' }) },
      { id: 'qb', data: makeQuestion({ category: 'History', difficulty: 'easy' }) },
      { id: 'qc', data: makeQuestion({ category: 'Science', difficulty: 'hard' }) },
    ];
    const { service, queries } = setup(seed);

    const result = await firstValueFrom(
      service.getCustomQuestions({ category: 'Science', difficulty: 'easy', limit: 10 }),
    );

    expect(result.map((q) => q.id)).toEqual(['qa']);
    expect(queries[0].wheres).toEqual([
      { field: 'category', value: 'Science' },
      { field: 'difficulty', value: 'easy' },
    ]);
  });

  it('omits a filter that was not asked for', async () => {
    pinCursor(LOW_CURSOR);
    const { service, queries } = setup(bank);

    await firstValueFrom(service.getCustomQuestions({ category: '', difficulty: '', limit: 3 }));

    expect(queries[0].wheres).toEqual([]);
  });

  // Without the wrap, a cursor landing past the last document returns nothing,
  // and the questions sorting earliest would be served far less often.
  it('wraps around when the random cursor lands past the end of the collection', async () => {
    pinCursor(HIGH_CURSOR);
    const { service, queries } = setup(bank);

    const result = await firstValueFrom(service.getCustomQuestions({ limit: 4 }));

    expect(result).toHaveLength(4);
    expect(queries).toHaveLength(2);
    expect(queries[0].startAt).toBeDefined();
    expect(queries[1].endBefore).toBeDefined();
  });

  it('does not run a second query when the first one filled the limit', async () => {
    pinCursor(LOW_CURSOR);
    const { service, queries } = setup(bank);

    await firstValueFrom(service.getCustomQuestions({ limit: 4 }));

    expect(queries).toHaveLength(1);
  });

  // A bank smaller than the requested amount is normal — `mixed` asks for half
  // of the game from a bank that may hold three questions.
  it('returns everything available when the bank is smaller than the limit', async () => {
    pinCursor(HIGH_CURSOR);
    const seed: SeedDoc[] = [
      { id: 'q1', data: makeQuestion() },
      { id: 'q2', data: makeQuestion() },
    ];
    const { service } = setup(seed);

    const result = await firstValueFrom(service.getCustomQuestions({ limit: 5 }));

    expect(result.map((q) => q.id).sort()).toEqual(['q1', 'q2']);
  });

  it('never returns the same document twice across the wrap', async () => {
    pinCursor(HIGH_CURSOR);
    const { service } = setup(bank);

    const result = await firstValueFrom(service.getCustomQuestions({ limit: 10 }));

    expect(new Set(result.map((q) => q.id)).size).toBe(result.length);
  });

  it('reads nothing at all for a zero limit', async () => {
    const { service, queries } = setup(bank);

    const result = await firstValueFrom(service.getCustomQuestions({ limit: 0 }));

    expect(result).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  // The cursor is what makes sampling random; a fixed one would hand every
  // player the same questions forever, which is why `limit` alone isn't enough.
  it('draws a different cursor each call', async () => {
    const { service, queries } = setup(bank);

    await firstValueFrom(service.getCustomQuestions({ limit: 1 }));
    await firstValueFrom(service.getCustomQuestions({ limit: 1 }));

    expect(queries[0].startAt).not.toEqual(queries[1].startAt);
  });
});

/**
 * Finding H4. The write is a `setDoc` against a `{window}-{slot}-{uid}`
 * document ID — the A3 volume-cap mechanism — so the interesting behaviour is
 * all in how slots are chosen and retried, not in the payload.
 */
describe('FirebaseService.reportQuestion (H4)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  const REPORT: NewQuestionReportDoc = {
    questionId: 'q1',
    reason: 'incorrect',
    reportedBy: 'uid-123',
    createdAt: Date.now(),
  };

  function reportSetup(rejectWith: (id: string, attempt: number) => unknown | null) {
    TestBed.configureTestingModule({});
    const service = TestBed.inject(FirebaseService);
    const writes: { id: string; data: unknown }[] = [];
    let attempt = 0;

    const firestoreModule = {
      doc: (_firestore: unknown, _collection: string, id: string) => ({ id }),
      setDoc: (ref: { id: string }, data: unknown) => {
        const rejection = rejectWith(ref.id, attempt++);
        if (rejection) {
          return Promise.reject(rejection);
        }
        writes.push({ id: ref.id, data });
        return Promise.resolve();
      },
    };
    vi.spyOn(service, 'getFirestore').mockResolvedValue({
      firestore: {},
      firestoreModule,
    } as unknown as Awaited<ReturnType<FirebaseService['getFirestore']>>);
    return { service, writes };
  }

  const ID_SHAPE = /^(\d+)-(\d)-uid-123$/;

  it('writes the report to a {window}-{slot}-{uid} document, payload untouched', async () => {
    const { service, writes } = reportSetup(() => null);

    await service.reportQuestion(REPORT);

    expect(writes).toHaveLength(1);
    const match = writes[0].id.match(ID_SHAPE);
    expect(match, `id "${writes[0].id}" has the {window}-{slot}-{uid} shape`).not.toBeNull();
    // The window must be the same 5-minute bucket the rules derive from
    // request.time — allow ±1 in case this test straddles a boundary.
    const window = Number(match![1]);
    expect(Math.abs(window - Math.floor(Date.now() / 300_000))).toBeLessThanOrEqual(1);
    expect(writes[0].data).toEqual(REPORT);
  });

  it('moves to the next slot when one is refused with permission-denied', async () => {
    let denials = 0;
    const { service, writes } = reportSetup((_id, attempt) => {
      if (attempt < 3) {
        denials++;
        return { code: 'permission-denied' };
      }
      return null;
    });

    await service.reportQuestion(REPORT);

    expect(denials).toBe(3);
    expect(writes).toHaveLength(1);
  });

  it('tries all ten slots, each exactly once, before giving up', async () => {
    const attemptedIds: string[] = [];
    const { service } = reportSetup((id) => {
      attemptedIds.push(id);
      return { code: 'permission-denied' };
    });

    await expect(service.reportQuestion(REPORT)).rejects.toBeInstanceOf(
      QuestionReportRejectedError,
    );
    expect(attemptedIds).toHaveLength(10);
    expect(new Set(attemptedIds).size).toBe(10);
    const slots = attemptedIds.map((id) => Number(id.match(ID_SHAPE)![2])).sort((a, b) => a - b);
    expect(slots).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  // A network failure is not a taken slot — retrying nine more times would
  // just fail nine more times, slower.
  it('rethrows a non-permission failure immediately', async () => {
    const failure = new Error('network down');
    let attempts = 0;
    const { service } = reportSetup(() => {
      attempts++;
      return failure;
    });

    await expect(service.reportQuestion(REPORT)).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });
});
