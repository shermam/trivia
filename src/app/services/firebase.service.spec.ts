import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { CustomQuestionDoc, NewQuestionReportDoc } from '../models/question.model';
import { AuthService } from './auth.service';
import { FirebaseAppService } from './firebase-app.service';
import { FirebaseService, QuestionReportRejectedError } from './firebase.service';

/**
 * Finding C1. `getCustomQuestions()` was `getDocs(collection(...))` — no
 * `where`, no `limit` — so every custom or mixed game downloaded the entire
 * public `custom_questions` collection and filtered it in the browser. That is
 * billed per document, scales with other people's contributions rather than
 * with anything the player asked for, and on a publicly readable collection is
 * trivially scriptable into a bill (`CLAUDE.md` §4.1).
 *
 * The fake below implements just enough Firestore to assert on **what was
 * actually sent to the server** rather than only on what came back — which is
 * the whole point of the finding: the old code returned the right questions
 * too, it just read the entire collection to do it.
 *
 * It now fakes `fetch` rather than the SDK module, because the server boundary
 * moved there (`BACKLOG.md` item 2). That is a strictly better place to stand:
 * these tests now run through the real `FirestoreRestClient` and assert on the
 * actual `structuredQuery` JSON, so they cover the wire format for real
 * payloads as well as the query logic. The seed data is encoded by a local
 * five-line encoder rather than by importing the production one — otherwise a
 * symmetric encode/decode bug would cancel itself out and never be seen.
 */

const PROJECT = 'demo-project';
const RESOURCE_ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const URL_ROOT = `https://firestore.googleapis.com/v1/${RESOURCE_ROOT}`;

interface SeedDoc {
  id: string;
  data: Record<string, unknown>;
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

/** Deliberately not the production encoder — see the note at the top. */
function toWire(value: unknown): unknown {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return { integerValue: String(value) };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toWire) } };
  return { nullValue: null };
}

function toWireFields(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, toWire(value)]));
}

interface RecordedQuery {
  collectionPath: string;
  wheres: { field: string; value: unknown }[];
  orderBy: { field: string; direction: string }[];
  startAt?: string;
  endBefore?: string;
  limit?: number;
}

interface RecordedWrite {
  method: string;
  /** Document or collection path, query string stripped. */
  path: string;
  /** The request body exactly as it went on the wire, still encoded. */
  fields: Record<string, unknown>;
}

/** How the fake server should answer one write. */
type WriteOutcome = 'ok' | 'permission-denied' | 'server-error';

interface FakeServer {
  queries: RecordedQuery[];
  writes: RecordedWrite[];
  /** Every write attempt, including the refused ones. */
  attempts: RecordedWrite[];
}

function pathFromUrl(url: string): string {
  const [withoutQuery] = url.split('?');
  return withoutQuery.slice(`${URL_ROOT}/`.length);
}

function cursorId(cursor: { values?: { referenceValue?: string }[] } | undefined) {
  const reference = cursor?.values?.[0]?.referenceValue;
  return reference ? reference.slice(reference.lastIndexOf('/') + 1) : undefined;
}

/**
 * Stands in for Firestore's REST endpoints: `:runQuery` over a seeded
 * collection, plus `PATCH`/`POST` writes whose outcome the test chooses.
 */
function fakeServer(
  seed: SeedDoc[],
  onWrite: (path: string, attempt: number) => WriteOutcome = () => 'ok',
): FakeServer {
  const server: FakeServer = { queries: [], writes: [], attempts: [] };
  let writeAttempt = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: { method: string; body?: string }) => {
      const body = init.body ? (JSON.parse(init.body) as Record<string, never>) : undefined;

      if (url.includes(':runQuery')) {
        const query = body!['structuredQuery'] as Record<string, never>;
        const parent = pathFromUrl(url.replace(':runQuery', ''));
        const collectionId = (query['from'] as { collectionId: string }[])[0].collectionId;
        const collectionPath = url.startsWith(`${URL_ROOT}:runQuery`)
          ? collectionId
          : `${parent}/${collectionId}`;

        const where = query['where'] as Record<string, never> | undefined;
        const rawFilters = where
          ? where['compositeFilter']
            ? ((where['compositeFilter'] as { filters: Record<string, never>[] }).filters as Record<
                string,
                never
              >[])
            : [where]
          : [];
        const wheres = rawFilters.map((filter) => {
          const fieldFilter = filter['fieldFilter'] as {
            field: { fieldPath: string };
            value: { stringValue?: string };
          };
          return { field: fieldFilter.field.fieldPath, value: fieldFilter.value.stringValue };
        });

        const recorded: RecordedQuery = {
          collectionPath,
          wheres,
          orderBy: (query['orderBy'] ?? []) as { field: string; direction: string }[],
          startAt: cursorId(query['startAt']),
          endBefore: cursorId(query['endAt']),
          limit: query['limit'] as number | undefined,
        };
        server.queries.push(recorded);

        let rows = [...seed].sort((a, b) => (a.id < b.id ? -1 : 1));
        const descending = ((query['orderBy'] ?? []) as { direction: string }[]).some(
          (order) => order.direction === 'DESCENDING',
        );
        if (descending) {
          const field = (
            (query['orderBy'] as { field: { fieldPath: string } }[])[0].field as {
              fieldPath: string;
            }
          ).fieldPath;
          rows = rows.sort((a, b) => Number(b.data[field]) - Number(a.data[field]));
        }
        for (const filter of recorded.wheres) {
          rows = rows.filter((row) => row.data[filter.field] === filter.value);
        }
        if (recorded.startAt !== undefined) {
          rows = rows.filter((row) => row.id >= recorded.startAt!);
        }
        if (recorded.endBefore !== undefined) {
          rows = rows.filter((row) => row.id < recorded.endBefore!);
        }
        if (recorded.limit !== undefined) {
          rows = rows.slice(0, recorded.limit);
        }

        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              rows.length
                ? rows.map((row) => ({
                    document: {
                      name: `${RESOURCE_ROOT}/${collectionPath}/${row.id}`,
                      fields: toWireFields(row.data),
                    },
                  }))
                : // Firestore answers an empty result set with a readTime and
                  // no document, which the client has to drop.
                  [{ readTime: '2026-08-18T00:00:00Z' }],
            ),
        });
      }

      if (init.method === 'GET') {
        const path = pathFromUrl(url);
        const id = path.slice(path.lastIndexOf('/') + 1);
        const match = seed.find((row) => row.id === id);
        return Promise.resolve(
          match
            ? {
                ok: true,
                status: 200,
                json: () =>
                  Promise.resolve({
                    name: `${RESOURCE_ROOT}/${path}`,
                    fields: toWireFields(match.data),
                  }),
              }
            : {
                ok: false,
                status: 404,
                json: () => Promise.resolve({ error: { status: 'NOT_FOUND', message: 'gone' } }),
              },
        );
      }

      if (url.includes(':commit')) {
        // A batched write. Recorded per-document so a test can assert what the
        // batch contained, and refused as a unit, which is how Firestore
        // treats it.
        const batch = (body!['writes'] as Record<string, never>[]).map((write) => {
          const update = write['update'] as { name: string; fields: Record<string, unknown> };
          return {
            method: 'COMMIT',
            path: update.name.slice(`${RESOURCE_ROOT}/`.length),
            fields: update.fields,
          } as RecordedWrite;
        });
        server.attempts.push(...batch);
        const outcome = onWrite(batch.map((w) => w.path).join(','), writeAttempt++);
        if (outcome === 'permission-denied') {
          return Promise.resolve({
            ok: false,
            status: 403,
            json: () =>
              Promise.resolve({ error: { status: 'PERMISSION_DENIED', message: 'refused' } }),
          });
        }
        if (outcome === 'server-error') {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ error: { status: 'INTERNAL', message: 'boom' } }),
          });
        }
        server.writes.push(...batch);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      }

      // A write: PATCH at a chosen ID, or POST for a server-generated one.
      const path = pathFromUrl(url);
      const record: RecordedWrite = {
        method: init.method,
        path,
        fields: body!['fields'] as Record<string, unknown>,
      };
      server.attempts.push(record);
      const outcome = onWrite(path, writeAttempt++);
      if (outcome === 'permission-denied') {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () =>
            Promise.resolve({ error: { status: 'PERMISSION_DENIED', message: 'refused' } }),
        });
      }
      if (outcome === 'server-error') {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: { status: 'INTERNAL', message: 'boom' } }),
        });
      }
      server.writes.push(record);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ name: `${RESOURCE_ROOT}/${path}/generated-id` }),
      });
    }),
  );

  return server;
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

function setup(
  seed: SeedDoc[],
  onWrite?: (path: string, attempt: number) => WriteOutcome,
): { service: FirebaseService } & FakeServer {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: FirebaseAppService,
        useValue: { getConfig: () => Promise.resolve({ projectId: PROJECT, apiKey: 'test-key' }) },
      },
      { provide: AuthService, useValue: { getIdToken: () => Promise.resolve('id-token') } },
    ],
  });
  const server = fakeServer(seed, onWrite);
  return { service: TestBed.inject(FirebaseService), ...server };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  TestBed.resetTestingModule();
});

describe('FirebaseService.getCustomQuestions (C1)', () => {
  const bank: SeedDoc[] = Array.from({ length: 50 }, (_, i) => ({
    id: `q${String(i).padStart(2, '0')}`,
    data: makeQuestion({ question: `Q${i}?` }) as unknown as Record<string, unknown>,
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

  it('queries the custom_questions collection, ordered by document ID', async () => {
    pinCursor(LOW_CURSOR);
    const { service, queries } = setup(bank);

    await firstValueFrom(service.getCustomQuestions({ limit: 3 }));

    expect(queries[0].collectionPath).toBe('custom_questions');
    // Ordering by ID is what makes the random-cursor sampling work at all —
    // without it the cursor bounds have nothing to be a position in.
    expect(queries[0].orderBy).toEqual([
      { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
    ]);
  });

  it('filters by category and difficulty server-side, not in the browser', async () => {
    pinCursor(LOW_CURSOR);
    const seed: SeedDoc[] = [
      { id: 'qa', data: makeQuestion({ category: 'Science', difficulty: 'easy' }) },
      { id: 'qb', data: makeQuestion({ category: 'History', difficulty: 'easy' }) },
      { id: 'qc', data: makeQuestion({ category: 'Science', difficulty: 'hard' }) },
    ] as unknown as SeedDoc[];
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
    ] as unknown as SeedDoc[];
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

  it('decodes the question, string array and all', async () => {
    pinCursor(LOW_CURSOR);
    const { service } = setup([
      {
        id: 'q1',
        data: makeQuestion({ incorrect_answers: ['B', 'C', 'D'] }) as unknown as Record<
          string,
          unknown
        >,
      },
    ]);

    const [question] = await firstValueFrom(service.getCustomQuestions({ limit: 1 }));

    expect(question).toEqual({ id: 'q1', ...makeQuestion({ incorrect_answers: ['B', 'C', 'D'] }) });
  });
});

/**
 * Finding H4. The write is against a `{window}-{slot}-{uid}` document ID — the
 * A3 volume-cap mechanism — so the interesting behaviour is all in how slots
 * are chosen and retried, not in the payload.
 */
describe('FirebaseService.reportQuestion (H4)', () => {
  const REPORT: NewQuestionReportDoc = {
    questionId: 'q1',
    reason: 'incorrect',
    reportedBy: 'uid-123',
    createdAt: Date.now(),
  };

  const ID_SHAPE = /^question_reports\/(\d+)-(\d)-uid-123$/;

  it('writes the report to a {window}-{slot}-{uid} document, payload untouched', async () => {
    const { service, writes } = setup([]);

    await service.reportQuestion(REPORT);

    expect(writes).toHaveLength(1);
    const match = writes[0].path.match(ID_SHAPE);
    expect(match, `path "${writes[0].path}" has the {window}-{slot}-{uid} shape`).not.toBeNull();
    // The window must be the same 5-minute bucket the rules derive from
    // request.time — allow ±1 in case this test straddles a boundary.
    const window = Number(match![1]);
    expect(Math.abs(window - Math.floor(Date.now() / 300_000))).toBeLessThanOrEqual(1);
    // Asserted as it goes on the wire, not decoded back: `createdAt` must be
    // an `integerValue` string, because `isNearRequestTime()` in
    // firestore.rules compares it as an int and a JSON number stores as a
    // double. That failure would surface only as a permission-denied.
    expect(writes[0].fields).toEqual({
      questionId: { stringValue: 'q1' },
      reason: { stringValue: 'incorrect' },
      reportedBy: { stringValue: 'uid-123' },
      createdAt: { integerValue: String(REPORT.createdAt) },
    });
  });

  it('moves to the next slot when one is refused with permission-denied', async () => {
    let denials = 0;
    const { service, writes } = setup([], (_path, attempt) => {
      if (attempt < 3) {
        denials++;
        return 'permission-denied';
      }
      return 'ok';
    });

    await service.reportQuestion(REPORT);

    expect(denials).toBe(3);
    expect(writes).toHaveLength(1);
  });

  it('tries all ten slots, each exactly once, before giving up', async () => {
    const { service, attempts } = setup([], () => 'permission-denied');

    await expect(service.reportQuestion(REPORT)).rejects.toBeInstanceOf(
      QuestionReportRejectedError,
    );
    expect(attempts).toHaveLength(10);
    expect(new Set(attempts.map((a) => a.path)).size).toBe(10);
    const slots = attempts.map((a) => Number(a.path.match(ID_SHAPE)![2])).sort((a, b) => a - b);
    expect(slots).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  // A server failure is not a taken slot — retrying nine more times would just
  // fail nine more times, slower.
  it('rethrows a non-permission failure immediately', async () => {
    const { service, attempts } = setup([], () => 'server-error');

    await expect(service.reportQuestion(REPORT)).rejects.toThrow(/boom/);
    expect(attempts).toHaveLength(1);
  });
});

/**
 * The leaderboard paths (finding G7): entries live at
 * `leaderboards/{board}/entries/{uid}`, and the board comes from the entry's
 * own `timeLimit` so the path and the field the rules compare it against
 * cannot be passed inconsistently.
 */
describe('FirebaseService leaderboard', () => {
  const ENTRY = {
    uid: 'user-1',
    name: 'Ada',
    score: 8,
    totalQuestions: 10,
    percentage: 80,
    createdAt: 1_755_000_000_000,
    timeLimit: '15',
  };

  it('writes the entry to the board named by its own timeLimit', async () => {
    const { service, writes } = setup([]);

    await service.saveHighScore(ENTRY);

    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('leaderboards/15/entries/user-1');
    expect(writes[0].method).toBe('PATCH');
  });

  it('sends the numeric fields as integers, not doubles', async () => {
    // `firestore.rules` bounds `score`, `totalQuestions` and `percentage` with
    // `is int` comparisons. A JSON number stores as a double and every one of
    // those checks fails, which reaches the player as a save that silently
    // will not go through.
    const { service, writes } = setup([]);

    await service.saveHighScore(ENTRY);

    expect(writes[0].fields).toEqual({
      uid: { stringValue: 'user-1' },
      name: { stringValue: 'Ada' },
      score: { integerValue: '8' },
      totalQuestions: { integerValue: '10' },
      percentage: { integerValue: '80' },
      createdAt: { integerValue: '1755000000000' },
      timeLimit: { stringValue: '15' },
    });
  });

  it('returns null when the caller has no entry on that board', async () => {
    const { service } = setup([]);
    expect(await service.getLeaderboardEntry('user-1', '15')).toBeNull();
  });

  it('reads the caller’s own row back, decoded', async () => {
    const { service } = setup([{ id: 'user-1', data: { ...ENTRY } }]);

    expect(await service.getLeaderboardEntry('user-1', '15')).toEqual({ id: 'user-1', ...ENTRY });
  });

  it('reads the top scores of one board, highest first and capped', async () => {
    const seed: SeedDoc[] = [
      { id: 'a', data: { ...ENTRY, uid: 'a', score: 3 } },
      { id: 'b', data: { ...ENTRY, uid: 'b', score: 9 } },
      { id: 'c', data: { ...ENTRY, uid: 'c', score: 6 } },
    ];
    const { service, queries } = setup(seed);

    const top = await firstValueFrom(service.getTopScores('15', 2));

    expect(top.map((entry) => entry.uid)).toEqual(['b', 'c']);
    expect(queries[0].collectionPath).toBe('leaderboards/15/entries');
    expect(queries[0].limit).toBe(2);
    expect(queries[0].orderBy).toEqual([
      { field: { fieldPath: 'score' }, direction: 'DESCENDING' },
    ]);
  });
});

describe('FirebaseService.addCustomQuestion (item 3: the hourly quota)', () => {
  const question = () => ({
    ...makeQuestion(),
    createdBy: 'user-1',
    createdAt: 1_755_000_000_000,
  });
  const quotaPath = () => `custom_question_quota/${Math.floor(Date.now() / 3_600_000)}-user-1`;

  it('commits the question and the counter as one batch', async () => {
    // Two sequential writes would let a client send the question and simply
    // never send the increment. `firestore.rules` reads the counter's
    // post-commit state with getAfter(), which only means anything if the two
    // are one commit.
    const { service, writes } = setup([]);

    await service.addCustomQuestion(question());

    expect(writes).toHaveLength(2);
    expect(writes.every((w) => w.method === 'COMMIT')).toBe(true);
    expect(writes.map((w) => w.path.split('/')[0]).sort()).toEqual([
      'custom_question_quota',
      'custom_questions',
    ]);
  });

  it('mints a question ID from Firestore’s own auto-ID alphabet', async () => {
    // Load-bearing, and the reason the cap is not folded into the question's
    // ID the way the session and report caps are: getCustomQuestions() samples
    // the bank by picking a random point in this exact keyspace, so anything
    // that clusters IDs skews which questions players ever see.
    const { service, writes } = setup([]);

    await service.addCustomQuestion(question());

    const id = writes.find((w) => w.path.startsWith('custom_questions/'))!.path.split('/')[1];
    expect(id).toMatch(/^[A-Za-z0-9]{20}$/);
  });

  it('carries the attribution the rules bind to the caller', async () => {
    const { service, writes } = setup([]);

    await service.addCustomQuestion(question());

    const doc = writes.find((w) => w.path.startsWith('custom_questions/'))!;
    expect(doc.fields['createdBy']).toEqual({ stringValue: 'user-1' });
    expect(doc.fields['createdAt']).toEqual({ integerValue: '1755000000000' });
  });

  it('increments the counter from whatever the hour already holds', async () => {
    const { service, writes } = setup([{ id: quotaPath().split('/')[1], data: { count: 7 } }]);

    await service.addCustomQuestion(question());

    const counter = writes.find((w) => w.path.startsWith('custom_question_quota/'))!;
    expect(counter.fields['count']).toEqual({ integerValue: '8' });
  });

  it('starts the counter at 1 in a fresh hour', async () => {
    const { service, writes } = setup([]);

    await service.addCustomQuestion(question());

    const counter = writes.find((w) => w.path.startsWith('custom_question_quota/'))!;
    expect(counter.fields['count']).toEqual({ integerValue: '1' });
  });

  it('refuses at the cap, and says so only after reading the counter', async () => {
    // The B4 lesson: a refusal alone does not license the claim "you have hit
    // the limit". This message is allowed because the count was checked.
    const { service, writes } = setup([{ id: quotaPath().split('/')[1], data: { count: 20 } }]);

    await expect(service.addCustomQuestion(question())).rejects.toThrow(/20 questions/);
    expect(writes).toHaveLength(0);
  });

  it('retries a refusal, because a racing submission is not an error', async () => {
    // Two tabs compute the same next value; Firestore serializes the writes so
    // the loser's `count == resource.data.count + 1` no longer holds. A fresh
    // read fixes it and the user should never learn it happened.
    let attempts = 0;
    const { service, writes } = setup([], () => (attempts++ === 0 ? 'permission-denied' : 'ok'));

    await service.addCustomQuestion(question());

    expect(attempts).toBe(2);
    expect(writes).toHaveLength(2);
  });

  it('does not retry a failure that is not a refusal', async () => {
    let attempts = 0;
    const { service } = setup([], () => {
      attempts++;
      return 'server-error';
    });

    await expect(service.addCustomQuestion(question())).rejects.toThrow(/boom/);
    expect(attempts).toBe(1);
  });
});
