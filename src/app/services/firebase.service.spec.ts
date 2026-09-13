import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { CustomQuestionDoc, NewQuestionReportDoc } from '../models/question.model';
import { AuthService } from './auth.service';
import { FirebaseAppService } from './firebase-app.service';
import { FirebaseService, QuestionReportRejectedError, REVIEW_PAGE_SIZE } from './firebase.service';

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
    // Every question in the real bank carries one once
    // `scripts/backfill-question-status.mjs` has run, and `getCustomQuestions`
    // now filters on it — a fixture without one models a state that no longer
    // exists, and would make every query in this file return nothing.
    status: 'approved',
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
  /**
   * The bare document IDs a `__name__` filter named, recorded apart from
   * `wheres` because they are not a field comparison: Firestore matches them
   * against a **reference**, so they arrive as resource paths and are checked
   * against a document's ID rather than against anything in its data.
   */
  documentIds?: string[];
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
  /**
   * The `updateMask.fieldPaths` the URL carried.
   *
   * Recorded because a path in the mask with **no** value in the body is how
   * Firestore deletes a field, and that asymmetry is the whole mechanism behind
   * clearing a `rejectionReason` (`FEAT-007`). A test asserting only on
   * `fields` cannot see a deletion at all.
   */
  mask?: string[];
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

/** The `updateMask.fieldPaths` values a write URL carried, in order. */
function maskFromUrl(url: string): string[] {
  const [, query = ''] = url.split('?');
  return new URLSearchParams(query).getAll('updateMask.fieldPaths');
}

function cursorId(cursor: { values?: { referenceValue?: string }[] } | undefined) {
  return referenceId(cursor?.values?.[0]);
}

/** The document ID at the end of a `referenceValue`'s full resource path. */
function referenceId(value: { referenceValue?: string } | undefined) {
  const reference = value?.referenceValue;
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
        const fieldFilters = rawFilters.map(
          (filter) =>
            filter['fieldFilter'] as {
              field: { fieldPath: string };
              value: {
                stringValue?: string;
                arrayValue?: { values?: { referenceValue?: string }[] };
              };
            },
        );
        const wheres = fieldFilters
          .filter((filter) => filter.field.fieldPath !== '__name__')
          .map((filter) => ({ field: filter.field.fieldPath, value: filter.value.stringValue }));
        const documentIds = fieldFilters
          .filter((filter) => filter.field.fieldPath === '__name__')
          .flatMap((filter) => (filter.value.arrayValue?.values ?? []).map(referenceId))
          .filter((id): id is string => id !== undefined);

        const recorded: RecordedQuery = {
          collectionPath,
          wheres,
          ...(documentIds.length ? { documentIds } : {}),
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
        if (recorded.documentIds) {
          rows = rows.filter((row) => recorded.documentIds!.includes(row.id));
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

      // A write: PATCH at a chosen ID, POST for a server-generated one, or
      // DELETE, which carries no body at all.
      const path = pathFromUrl(url);
      const record: RecordedWrite = {
        method: init.method,
        path,
        fields: (body?.['fields'] ?? {}) as Record<string, unknown>,
        mask: maskFromUrl(url),
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
      { field: 'status', value: 'approved' },
      { field: 'category', value: 'Science' },
      { field: 'difficulty', value: 'easy' },
    ]);
  });

  it('always filters on status, so players are never served an unapproved question', async () => {
    pinCursor(LOW_CURSOR);
    const { service, queries } = setup(bank);

    await firstValueFrom(service.getCustomQuestions({ limit: 3 }));

    // Not conditional on anything the caller passes. This is the client half
    // of review-before-publish, and the half that has to be unconditional —
    // the rule stays open for one release, so until 4c this filter is the only
    // thing keeping a rejected question out of a game.
    expect(queries.every((q) => q.wheres.some((w) => w.field === 'status'))).toBe(true);
    expect(queries[0].wheres).toContainEqual({ field: 'status', value: 'approved' });
  });

  it('omits a filter that was not asked for', async () => {
    pinCursor(LOW_CURSOR);
    const { service, queries } = setup(bank);

    await firstValueFrom(service.getCustomQuestions({ category: '', difficulty: '', limit: 3 }));

    // Only `status`, which is never optional — the two the caller declined are
    // absent. An empty category must not become `category == ''`.
    expect(queries[0].wheres).toEqual([{ field: 'status', value: 'approved' }]);
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

/**
 * The per-country boards (`FEAT-028`), one path segment below the ones above.
 *
 * Both halves of the path are pinned here because `firestore.rules` compares
 * both against fields on the document: `timeLimit` against the board segment
 * and `region` against the country segment. A path assembled from anything but
 * the entry itself could disagree with them, and the whole write would be
 * refused with a bare `permission-denied`.
 */
describe('FirebaseService regional leaderboards (FEAT-028)', () => {
  const ENTRY = {
    uid: 'user-1',
    name: 'Ada',
    score: 8,
    totalQuestions: 10,
    percentage: 80,
    createdAt: 1_755_000_000_000,
    timeLimit: '30',
    region: 'BR',
  };

  it('writes the entry under both path segments its own fields name', async () => {
    const { service, writes } = setup([]);

    await service.saveRegionalHighScore(ENTRY);

    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('leaderboards/30/regions/BR/entries/user-1');
    expect(writes[0].method).toBe('PATCH');
  });

  it('sends region as a string beside the same integer fields', async () => {
    const { service, writes } = setup([]);

    await service.saveRegionalHighScore(ENTRY);

    expect(writes[0].fields).toEqual({
      uid: { stringValue: 'user-1' },
      name: { stringValue: 'Ada' },
      score: { integerValue: '8' },
      totalQuestions: { integerValue: '10' },
      percentage: { integerValue: '80' },
      createdAt: { integerValue: '1755000000000' },
      timeLimit: { stringValue: '30' },
      region: { stringValue: 'BR' },
    });
  });

  it('reads one country board, same bounded shape as the global one', async () => {
    const seed: SeedDoc[] = [
      { id: 'a', data: { ...ENTRY, uid: 'a', score: 3 } },
      { id: 'b', data: { ...ENTRY, uid: 'b', score: 9 } },
    ];
    const { service, queries } = setup(seed);

    const top = await firstValueFrom(service.getRegionalTopScores('unlimited', 'PT', 10));

    expect(top.map((entry) => entry.uid)).toEqual(['b', 'a']);
    expect(queries[0].collectionPath).toBe('leaderboards/unlimited/regions/PT/entries');
    expect(queries[0].limit).toBe(10);
    // The same `orderBy` as the global board, which is the reason a board per
    // country needs no index of its own: Firestore's automatic single-field
    // index on `score` serves it in any collection.
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

  it('submits for review rather than publishing, and does not ask the caller', async () => {
    // Two things at once, and both matter. `status` is not on
    // `NewCustomQuestionDoc`, so the caller cannot choose it — a submitter
    // approving their own question is the failure this feature exists to
    // prevent, and `firestore.rules` refuses it independently.
    //
    // And the value is pinned against `statusOnSubmission()` in
    // `firestore.rules`: if the two ever drift, every submission is refused in
    // production and nothing else in either suite would say so.
    const { service, writes } = setup([]);

    await service.addCustomQuestion(question());

    const doc = writes.find((w) => w.path.startsWith('custom_questions/'))!;
    expect(doc.fields['status']).toEqual({ stringValue: 'pending' });
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

describe('FirebaseService: the review queue (item 4b-ii)', () => {
  const seed: SeedDoc[] = [
    { id: 'p2', data: makeQuestion({ status: 'pending', createdAt: 200 }) as never },
    { id: 'p1', data: makeQuestion({ status: 'pending', createdAt: 100 }) as never },
    { id: 'a1', data: makeQuestion({ status: 'approved', createdAt: 150 }) as never },
    { id: 'r1', data: makeQuestion({ status: 'rejected', createdAt: 50 }) as never },
  ];

  it('asks the server for one status and bounds the read', async () => {
    // `CLAUDE.md` §4.1 — a `getDocs` without both a `where` and a `limit` is
    // billed per document over a collection that grows with other people's
    // contributions.
    const { service, queries } = setup(seed);

    await firstValueFrom(service.getQuestionsByStatus('pending'));

    expect(queries).toHaveLength(1);
    expect(queries[0].collectionPath).toBe('custom_questions');
    expect(queries[0].wheres).toEqual([{ field: 'status', value: 'pending' }]);
    expect(queries[0].limit).toBe(REVIEW_PAGE_SIZE);
  });

  it('returns only the requested status', async () => {
    const { service } = setup(seed);

    const result = await firstValueFrom(service.getQuestionsByStatus('pending'));

    expect(result.map((q) => q.id).sort()).toEqual(['p1', 'p2']);
  });

  it('sends no orderBy, so the query needs no composite index', async () => {
    // The trade is deliberate and documented on REVIEW_PAGE_SIZE: sorting in
    // the browser costs a page boundary that is not strictly by age, and buys
    // the removal of a whole class of D3 deploy risk.
    const { service, queries } = setup(seed);

    await firstValueFrom(service.getQuestionsByStatus('pending'));

    expect(queries[0].orderBy).toEqual([]);
  });

  it('sorts the page oldest-first in the browser', async () => {
    const { service } = setup(seed);

    const result = await firstValueFrom(service.getQuestionsByStatus('pending'));

    expect(result.map((q) => q.id)).toEqual(['p1', 'p2']);
  });

  it('sorts an unattributed question first rather than dropping it', async () => {
    // Documents predating attribution have no `createdAt` and never will. They
    // still have to appear in a queue whose whole job is to show everything in
    // a status.
    const { service } = setup([
      { id: 'dated', data: makeQuestion({ status: 'pending', createdAt: 100 }) as never },
      { id: 'legacy', data: makeQuestion({ status: 'pending' }) as never },
    ]);

    const result = await firstValueFrom(service.getQuestionsByStatus('pending'));

    expect(result.map((q) => q.id)).toEqual(['legacy', 'dated']);
  });

  it('writes only the status field, leaving the question as its author wrote it', async () => {
    // The app's first genuinely partial write. `firestore.rules` allows a
    // moderation update that affects no key but `status`, so a full-document
    // replace would be refused as well as destructive — and the updateMask is
    // what makes this a patch.
    const { service, writes } = setup(seed);

    await service.setQuestionStatus('p1', 'approved');

    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe('PATCH');
    expect(writes[0].path).toBe('custom_questions/p1');
    expect(Object.keys(writes[0].fields)).toEqual(['status']);
    expect(writes[0].fields['status']).toEqual({ stringValue: 'approved' });
  });

  it('propagates a refused decision rather than reporting success', async () => {
    const { service } = setup(seed, () => 'permission-denied');

    await expect(service.setQuestionStatus('p1', 'approved')).rejects.toThrow();
  });

  /**
   * The reviewer's rejection note (`FEAT-007`).
   *
   * The half worth pinning is the *clearing*. `firestore.rules` refuses a
   * `rejectionReason` on any question that is not `rejected`, so approving one
   * that carries a stale note is refused outright rather than merely untidy —
   * and the only way to clear a field without replacing the whole document is a
   * path in the `updateMask` with no value in the body. A test reading `fields`
   * alone cannot see that at all.
   */
  it('writes the reason alongside a rejection', async () => {
    const { service, writes } = setup(seed);

    await service.setQuestionStatus('p1', 'rejected', '  The date is wrong.  ');

    expect(writes[0].fields['rejectionReason']).toEqual({ stringValue: 'The date is wrong.' });
    expect(writes[0].mask).toEqual(['status', 'rejectionReason']);
  });

  it('clears the reason when approving, in the mask rather than the body', async () => {
    const { service, writes } = setup(seed);

    await service.setQuestionStatus('p1', 'approved', 'ignored on an approval');

    expect(Object.keys(writes[0].fields)).toEqual(['status']);
    expect(writes[0].mask).toEqual(['status', 'rejectionReason']);
  });

  it('clears the reason when rejecting with an empty one', async () => {
    // "No reason given" is an absent key, not a blank string — the rules refuse
    // an empty one, and the author's screen has a sentence for the absence.
    const { service, writes } = setup(seed);

    await service.setQuestionStatus('p1', 'rejected', '   ');

    expect(Object.keys(writes[0].fields)).toEqual(['status']);
    expect(writes[0].mask).toEqual(['status', 'rejectionReason']);
  });
});

/**
 * An author's own contributions (`FEAT-007`).
 *
 * Two properties are load-bearing and neither is visible in the result:
 * the `createdBy` filter, because **rules are not filters** — without it the
 * query is refused outright rather than narrowed to the caller's own rows — and
 * the `limit`, which `CLAUDE.md` §4.1 requires of every collection read. The
 * fake records the `structuredQuery` that actually went on the wire, which is
 * the only place either can be seen.
 */
describe('FirebaseService.getUserQuestions (FEAT-007)', () => {
  const mine: SeedDoc[] = Array.from({ length: 3 }, (_, i) => ({
    id: `mine-${i}`,
    data: makeQuestion({
      question: `Mine ${i}?`,
      createdBy: 'author-1',
      createdAt: 1_760_000_000_000 + i,
      status: 'pending',
    }) as unknown as Record<string, unknown>,
  }));
  const theirs: SeedDoc = {
    id: 'theirs',
    data: makeQuestion({
      question: 'Somebody else?',
      createdBy: 'author-2',
      createdAt: 1_760_000_000_000,
    }) as unknown as Record<string, unknown>,
  };

  it('filters on the author and bounds the read', async () => {
    const { service, queries } = setup([...mine, theirs]);

    await service.getUserQuestions('author-1');

    expect(queries).toHaveLength(1);
    expect(queries[0].collectionPath).toBe('custom_questions');
    expect(queries[0].wheres).toEqual([{ field: 'createdBy', value: 'author-1' }]);
    expect(queries[0].limit).toBe(25);
  });

  /**
   * Newest first, with the document ID as a tiebreaker.
   *
   * The tiebreaker is not decoration: two questions submitted in the same
   * millisecond put one of them at a page boundary and its twin immediately
   * after the cursor value, where an exclusive `startAfter` on `createdAt`
   * alone steps straight over it — measured on `question_reports`, where
   * exactly one document vanished between pages.
   */
  it('orders newest first with the document id breaking ties', async () => {
    const { service, queries } = setup(mine);

    await service.getUserQuestions('author-1');

    expect(queries[0].orderBy).toEqual([
      { field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' },
      { field: { fieldPath: '__name__' }, direction: 'DESCENDING' },
    ]);
  });

  it('reports no next page when the page is short', async () => {
    const { service } = setup(mine);

    expect((await service.getUserQuestions('author-1')).next).toBeNull();
  });

  it('hands back a cursor when the page is full', async () => {
    const full: SeedDoc[] = Array.from({ length: 25 }, (_, i) => ({
      id: `full-${String(i).padStart(2, '0')}`,
      data: makeQuestion({
        createdBy: 'author-1',
        createdAt: 1_760_000_000_000 + i,
      }) as unknown as Record<string, unknown>,
    }));
    const { service } = setup(full);

    const page = await service.getUserQuestions('author-1');

    expect(page.questions).toHaveLength(25);
    expect(page.next).not.toBeNull();
  });
});

/**
 * Editing and withdrawing one's own question (`FEAT-007`).
 *
 * Every assertion here is about the `updateMask`, because that is what makes
 * the write legal: `createdBy` and `createdAt` are left *out* of it, so
 * "unchanged" is true by construction rather than by the client resending the
 * same values; every optional field is *in* it whether or not it has a value,
 * so clearing a source link removes the key; and `rejectionReason` is always in
 * it, because the rules refuse an owner edit that leaves the reviewer's note
 * about the replaced text standing.
 */
describe('FirebaseService.updateUserQuestion / deleteUserQuestion (FEAT-007)', () => {
  const content = {
    category: 'History',
    type: 'multiple' as const,
    difficulty: 'hard' as const,
    question: 'Corrected?',
    correct_answer: 'Yes',
    incorrect_answers: ['No', 'Maybe', 'Unsure'],
  };
  const seed: SeedDoc[] = [
    {
      id: 'mine',
      data: makeQuestion({ createdBy: 'author-1' }) as unknown as Record<string, unknown>,
    },
  ];

  it('sends the question back to pending and never touches its attribution', async () => {
    const { service, writes } = setup(seed);

    await service.updateUserQuestion('mine', content);

    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe('PATCH');
    expect(writes[0].path).toBe('custom_questions/mine');
    expect(writes[0].fields['status']).toEqual({ stringValue: 'pending' });
    expect(writes[0].mask).not.toContain('createdBy');
    expect(writes[0].mask).not.toContain('createdAt');
  });

  it('clears the reviewer note and every optional field the author left blank', async () => {
    const { service, writes } = setup(seed);

    await service.updateUserQuestion('mine', content);

    expect(Object.keys(writes[0].fields)).not.toContain('sourceUrl');
    expect(writes[0].mask).toEqual(
      expect.arrayContaining(['sourceUrl', 'sourceTitle', 'explanation', 'rejectionReason']),
    );
  });

  it('writes the optional fields the author did fill in', async () => {
    const { service, writes } = setup(seed);

    await service.updateUserQuestion('mine', {
      ...content,
      sourceUrl: 'https://example.com/a',
      explanation: 'Because.',
    });

    expect(writes[0].fields['sourceUrl']).toEqual({ stringValue: 'https://example.com/a' });
    expect(writes[0].fields['explanation']).toEqual({ stringValue: 'Because.' });
    // Still cleared: the one the author left blank, and the reviewer's note.
    expect(Object.keys(writes[0].fields)).not.toContain('sourceTitle');
    expect(writes[0].mask).toEqual(expect.arrayContaining(['sourceTitle', 'rejectionReason']));
  });

  it('deletes the document when the author withdraws it', async () => {
    const { service, writes } = setup(seed);

    await service.deleteUserQuestion('mine');

    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe('DELETE');
    expect(writes[0].path).toBe('custom_questions/mine');
  });

  /**
   * A 204, or a proxy that strips the body, leaves nothing for `json()` to
   * parse. Reporting that as a failed removal would be wrong twice over: the
   * server has already deleted the document, and the retry it invites answers
   * 404. `ok` with no body is the answer, not an error.
   */
  it('treats a successful delete with no response body as done', async () => {
    const { service } = setup(seed);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 204,
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    } as never);

    await expect(service.deleteUserQuestion('mine')).resolves.toBeUndefined();
  });

  it('propagates a refused removal rather than reporting success', async () => {
    const { service } = setup(seed, () => 'permission-denied');

    await expect(service.deleteUserQuestion('mine')).rejects.toThrow();
  });
});

/**
 * The questions a page of reports names (`FEAT-026`).
 *
 * The interesting property is the read count. A report carries a `questionId`
 * and nothing else about the question, so the obvious implementation is one
 * `getDocument` per row — twenty-five round trips for a page of twenty-five.
 * These rows pin the batched shape instead, including the two edges that make
 * it correct: Firestore's thirty-value ceiling on an `IN`, and a report whose
 * question has since been deleted.
 */
describe('FirebaseService.getQuestionsByIds (FEAT-026)', () => {
  const seed: SeedDoc[] = [
    { id: 'q1', data: makeQuestion({ status: 'approved', question: 'First?' }) as never },
    { id: 'q2', data: makeQuestion({ status: 'pending', question: 'Second?' }) as never },
    { id: 'q3', data: makeQuestion({ status: 'rejected', question: 'Third?' }) as never },
  ];

  it('reads the named questions in one bounded query', async () => {
    const { service, queries } = setup(seed);

    const result = await firstValueFrom(service.getQuestionsByIds(['q1', 'q3']));

    expect(result.map((q) => q.id).sort()).toEqual(['q1', 'q3']);
    expect(queries).toHaveLength(1);
    expect(queries[0].collectionPath).toBe('custom_questions');
    expect(queries[0].documentIds).toEqual(['q1', 'q3']);
    // `CLAUDE.md` §4.1 — the filter is the bound, and the limit says so again.
    expect(queries[0].limit).toBe(2);
  });

  // A queue whose whole job is reports about *questionable* questions must be
  // able to show one in any status; the rules allow a reviewer exactly that.
  it('returns questions whatever their moderation status', async () => {
    const { service } = setup(seed);

    const result = await firstValueFrom(service.getQuestionsByIds(['q1', 'q2', 'q3']));

    expect(result.map((q) => q.status).sort()).toEqual(['approved', 'pending', 'rejected']);
  });

  it('asks once for a question several reports name', async () => {
    const { service, queries } = setup(seed);

    const result = await firstValueFrom(service.getQuestionsByIds(['q1', 'q1', 'q1']));

    expect(queries[0].documentIds).toEqual(['q1']);
    expect(result).toHaveLength(1);
  });

  // Firestore rejects an `IN` carrying more than thirty comparison values, so
  // a page larger than that has to arrive as more than one query. Nothing in
  // the emulator or the types says so — it is a server-side limit that surfaces
  // as a failed read.
  it('splits a page wider than the IN limit into batches of thirty', async () => {
    const many: SeedDoc[] = Array.from({ length: 35 }, (_, i) => ({
      id: `b${String(i).padStart(2, '0')}`,
      data: makeQuestion({ status: 'pending' }) as never,
    }));
    const { service, queries } = setup(many);

    const result = await firstValueFrom(service.getQuestionsByIds(many.map((doc) => doc.id)));

    expect(queries).toHaveLength(2);
    expect(queries[0].documentIds).toHaveLength(30);
    expect(queries[1].documentIds).toHaveLength(5);
    expect(result).toHaveLength(35);
  });

  // A report outlives the question it names: `custom_questions` is deletable
  // from the console and nothing cascades. The absence has to come back as an
  // absence, so the row can say the question is gone rather than the whole
  // page failing.
  it('leaves out an id the bank no longer holds, rather than failing', async () => {
    const { service } = setup(seed);

    const result = await firstValueFrom(service.getQuestionsByIds(['q1', 'deleted-question']));

    expect(result.map((q) => q.id)).toEqual(['q1']);
  });

  it('reads nothing at all for an empty list of ids', async () => {
    const { service, queries } = setup(seed);

    expect(await firstValueFrom(service.getQuestionsByIds([]))).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  /**
   * **One malformed id must not take the page down with it.**
   *
   * These ids come out of `question_reports`, which is writable from the
   * Firebase console where nothing validates `questionId` — and
   * `ReviewerService` maps a non-string one to `''` rather than dropping the
   * complaint. A `__name__` filter refuses an empty id and one carrying a `/`
   * by throwing, and that throw would come out of the whole batched read: the
   * reviewer would lose every report on the page behind "Could not load the
   * reports", with a Try again that can never succeed while that document
   * exists. Dropped, the row that names it falls through to the same "no longer
   * in the bank" branch as a deleted question, which is all the reviewer can do
   * about it anyway.
   */
  it('drops an id that cannot address a document, and reads the rest', async () => {
    const { service, queries } = setup(seed);

    const result = await firstValueFrom(
      service.getQuestionsByIds(['q1', '', 'custom_questions/q2', 42 as never, 'q3']),
    );

    expect(result.map((q) => q.id).sort()).toEqual(['q1', 'q3']);
    expect(queries).toHaveLength(1);
    expect(queries[0].documentIds).toEqual(['q1', 'q3']);
  });

  it('reads nothing rather than throwing when every id is malformed', async () => {
    const { service, queries } = setup(seed);

    expect(await firstValueFrom(service.getQuestionsByIds(['', 'a/b']))).toEqual([]);
    expect(queries).toHaveLength(0);
  });
});

describe('FirebaseService.getGameplayStats (FEAT-005)', () => {
  const TOTALS = {
    gamesPlayed: 4,
    questionsAnswered: 40,
    correctAnswers: 31,
    bestStreak: 9,
    statsSince: 1_755_000_000_000,
    // Bookkeeping the callable keeps and the profile screen has no use for.
    lastGameId: 'game-7',
    updatedAt: 1_755_000_100_000,
    rateWindowStart: 1_755_000_000_000,
    gamesInWindow: 4,
  };

  /**
   * A single-document `get` on a known path, never a query. It is the only
   * shape `firestore.rules` permits — `users` allows `get` to the owner and
   * refuses `list` to everybody — so a query here would be refused rather than
   * merely expensive, and the assertion is on the request as well as on what
   * came back (`CLAUDE.md` §4.1).
   */
  it('reads exactly one document, at the caller’s own path', async () => {
    const { service, queries } = setup([{ id: 'user-1', data: { ...TOTALS } }]);

    await service.getGameplayStats('user-1');

    expect(queries).toHaveLength(0);
    const urls = vi.mocked(fetch).mock.calls.map((call) => String(call[0]));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`${RESOURCE_ROOT}/users/user-1`);
  });

  it('returns the five totals the profile renders, and nothing else', async () => {
    const { service } = setup([{ id: 'user-1', data: { ...TOTALS } }]);

    expect(await service.getGameplayStats('user-1')).toEqual({
      gamesPlayed: 4,
      questionsAnswered: 40,
      correctAnswers: 31,
      bestStreak: 9,
      statsSince: 1_755_000_000_000,
    });
  });

  /**
   * `null` means "no games banked yet" and has to mean only that: the empty
   * state on `/profile` is built on it, and a failed read arriving as `null`
   * would tell a player with perfectly good totals that they had never
   * finished a game (`CLAUDE.md` §4.4).
   */
  it('returns null for an account that has never finished a game', async () => {
    const { service } = setup([]);

    expect(await service.getGameplayStats('user-1')).toBeNull();
  });

  /**
   * The collection deliberately carries no `hasOnly()` allowlist and no
   * rules-level schema, which is what lets a server-written field be added
   * without a migration (`docs/data-model.md`). The price is that a reader may
   * not assume a field is present — so a document written before `statsSince`
   * existed reads as "no date" rather than as `Invalid Date` on the screen.
   */
  it('survives a document written before a field existed', async () => {
    const { service } = setup([{ id: 'user-1', data: { gamesPlayed: 2 } }]);

    expect(await service.getGameplayStats('user-1')).toEqual({
      gamesPlayed: 2,
      questionsAnswered: 0,
      correctAnswers: 0,
      bestStreak: 0,
      statsSince: null,
    });
  });

  it('propagates a refused read rather than reporting an empty profile', async () => {
    const { service } = setup([]);
    // The 404 the fake answers an unseeded path with is the *absence* case.
    // This one is a refusal, and the two must not collapse into each other.
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: { status: 'PERMISSION_DENIED', message: 'refused' } }),
    } as never);

    await expect(service.getGameplayStats('user-1')).rejects.toThrow();
  });
});
