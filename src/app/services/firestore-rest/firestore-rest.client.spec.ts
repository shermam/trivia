import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth.service';
import { FirebaseAppService } from '../firebase-app.service';
import {
  DOCUMENT_ID_FIELD,
  FirestoreRestClient,
  FirestoreRestError,
} from './firestore-rest.client';

/**
 * The client's job is to put the right request on the wire, so these tests
 * assert on **what was sent** — URL, method, headers and body — rather than
 * only on what came back. That is the same standard `firebase.service.spec.ts`
 * already holds the query builder to, and for the same reason: a query that
 * returns the right documents while reading the whole collection (finding C1)
 * looks perfectly healthy from the outside.
 */

const PROJECT = 'demo-project';
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const RESOURCE_ROOT = `projects/${PROJECT}/databases/(default)/documents`;

interface StubbedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

let fetchMock: ReturnType<typeof vi.fn>;
let idToken: string | null;

function respondWith(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  fetchMock.mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  });
}

function rejectWith(error: unknown) {
  fetchMock.mockRejectedValue(error);
}

function lastCall(): StubbedCall {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [
    string,
    { method: string; headers: Record<string, string>; body?: string },
  ];
  return {
    url,
    method: init.method,
    headers: init.headers,
    body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
  };
}

function structuredQuery(): Record<string, unknown> {
  return lastCall().body!['structuredQuery'] as Record<string, unknown>;
}

function makeClient(): FirestoreRestClient {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: FirebaseAppService,
        useValue: { getConfig: () => Promise.resolve({ projectId: PROJECT, apiKey: 'test-key' }) },
      },
      { provide: AuthService, useValue: { getIdToken: () => Promise.resolve(idToken) } },
    ],
  });
  return TestBed.inject(FirestoreRestClient);
}

beforeEach(() => {
  idToken = 'id-token-123';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FirestoreRestClient.getDocument', () => {
  it('GETs the document path under the project root, with the API key', async () => {
    respondWith({ name: `${RESOURCE_ROOT}/leaderboards/15/entries/user-1`, fields: {} });
    await makeClient().getDocument('leaderboards/15/entries/user-1');

    const call = lastCall();
    expect(call.method).toBe('GET');
    expect(call.url).toBe(`${ROOT}/leaderboards/15/entries/user-1?key=test-key`);
  });

  it('decodes the document into id, path and data', async () => {
    respondWith({
      name: `${RESOURCE_ROOT}/leaderboards/15/entries/user-1`,
      fields: { score: { integerValue: '8' }, name: { stringValue: 'Ada' } },
    });

    const document = await makeClient().getDocument('leaderboards/15/entries/user-1');

    expect(document).toEqual({
      id: 'user-1',
      path: 'leaderboards/15/entries/user-1',
      data: { score: 8, name: 'Ada' },
    });
  });

  it('returns null when the document does not exist', async () => {
    respondWith(
      { error: { status: 'NOT_FOUND', message: 'No document' } },
      { ok: false, status: 404 },
    );
    expect(await makeClient().getDocument('leaderboards/15/entries/nobody')).toBeNull();
  });

  it('throws rather than returning null when the read is refused', async () => {
    // The distinction `getLeaderboardEntry` depends on: "you have no entry
    // yet" must not be indistinguishable from "that was refused".
    respondWith(
      { error: { status: 'PERMISSION_DENIED', message: 'Missing permissions' } },
      { ok: false, status: 403 },
    );

    await expect(makeClient().getDocument('customers/someone-else')).rejects.toSatisfy(
      (error: unknown) => error instanceof FirestoreRestError && error.isPermissionDenied,
    );
  });

  it('rejects a path with an odd number of segments', async () => {
    await expect(makeClient().getDocument('custom_questions')).rejects.toThrow(
      /not a document path/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('FirestoreRestClient auth headers', () => {
  it('sends the ID token as a bearer token', async () => {
    respondWith({ name: `${RESOURCE_ROOT}/products/p1` });
    await makeClient().getDocument('products/p1');
    expect(lastCall().headers['Authorization']).toBe('Bearer id-token-123');
  });

  it('omits the header entirely when nobody is signed in', async () => {
    // `custom_questions`, `products` and the leaderboards are all
    // `allow read: if true`, so an anonymous sign-in that has not landed yet
    // must not fail a read that never needed a token.
    idToken = null;
    respondWith({ name: `${RESOURCE_ROOT}/products/p1` });
    await makeClient().getDocument('products/p1');
    expect(lastCall().headers['Authorization']).toBeUndefined();
  });
});

describe('FirestoreRestClient.setDocument', () => {
  it('PATCHes with an updateMask naming every field written', async () => {
    respondWith({ name: `${RESOURCE_ROOT}/leaderboards/15/entries/user-1` });
    await makeClient().setDocument('leaderboards/15/entries/user-1', {
      score: 8,
      name: 'Ada',
    });

    const call = lastCall();
    expect(call.method).toBe('PATCH');
    expect(call.url).toBe(
      `${ROOT}/leaderboards/15/entries/user-1?updateMask.fieldPaths=score&updateMask.fieldPaths=name&key=test-key`,
    );
  });

  it('sends integers as strings, not JSON numbers', async () => {
    // The failure this prevents is invisible from the client: a JSON number
    // stores as a double, `data.createdAt is int` in firestore.rules then
    // fails, and the write comes back as a permission-denied naming no cause.
    respondWith({ name: `${RESOURCE_ROOT}/leaderboards/15/entries/user-1` });
    await makeClient().setDocument('leaderboards/15/entries/user-1', {
      score: 8,
      createdAt: 1_755_000_000_000,
    });

    expect(lastCall().body).toEqual({
      fields: { score: { integerValue: '8' }, createdAt: { integerValue: '1755000000000' } },
    });
  });

  it('refuses a field name an updateMask path would misread', async () => {
    // `a.b` in an updateMask means field `b` inside map `a`, so writing it
    // unquoted would silently write somewhere else.
    await expect(makeClient().setDocument('custom_questions/q1', { 'a.b': 1 })).rejects.toThrow(
      /backtick quoting/,
    );
  });
});

describe('FirestoreRestClient.createDocument', () => {
  it('POSTs to the collection and returns the server-generated ID', async () => {
    respondWith({
      name: `${RESOURCE_ROOT}/custom_questions/generated-id`,
      fields: { question: { stringValue: 'Q?' } },
    });

    const created = await makeClient().createDocument('custom_questions', { question: 'Q?' });

    const call = lastCall();
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${ROOT}/custom_questions?key=test-key`);
    expect(created.id).toBe('generated-id');
  });

  it('rejects a path with an even number of segments', async () => {
    await expect(makeClient().createDocument('custom_questions/q1', {})).rejects.toThrow(
      /not a collection path/,
    );
  });
});

describe('FirestoreRestClient.runQuery', () => {
  it('posts to the database root for a top-level collection', async () => {
    respondWith([]);
    await makeClient().runQuery({ collectionPath: 'custom_questions' });

    expect(lastCall().url).toBe(`${ROOT}:runQuery?key=test-key`);
    expect(structuredQuery()['from']).toEqual([{ collectionId: 'custom_questions' }]);
  });

  it('posts to the parent document for a subcollection', async () => {
    respondWith([]);
    await makeClient().runQuery({ collectionPath: 'leaderboards/15/entries' });

    expect(lastCall().url).toBe(`${ROOT}/leaderboards/15:runQuery?key=test-key`);
    expect(structuredQuery()['from']).toEqual([{ collectionId: 'entries' }]);
  });

  it('sends a single filter as a bare fieldFilter', async () => {
    respondWith([]);
    await makeClient().runQuery({
      collectionPath: 'custom_questions',
      where: [{ field: 'category', op: 'EQUAL', value: 'Science' }],
    });

    expect(structuredQuery()['where']).toEqual({
      fieldFilter: {
        field: { fieldPath: 'category' },
        op: 'EQUAL',
        value: { stringValue: 'Science' },
      },
    });
  });

  it('sends two filters as an AND compositeFilter', async () => {
    respondWith([]);
    await makeClient().runQuery({
      collectionPath: 'custom_questions',
      where: [
        { field: 'category', op: 'EQUAL', value: 'Science' },
        { field: 'difficulty', op: 'EQUAL', value: 'easy' },
      ],
    });

    const where = structuredQuery()['where'] as { compositeFilter: { op: string; filters: [] } };
    expect(where.compositeFilter.op).toBe('AND');
    expect(where.compositeFilter.filters).toHaveLength(2);
  });

  it('encodes an IN filter as an array value', async () => {
    // The subscription-status query: where('status','in',['trialing','active']).
    respondWith([]);
    await makeClient().runQuery({
      collectionPath: 'customers/user-1/subscriptions',
      where: [{ field: 'status', op: 'IN', value: ['trialing', 'active'] }],
    });

    expect(structuredQuery()['where']).toEqual({
      fieldFilter: {
        field: { fieldPath: 'status' },
        op: 'IN',
        value: {
          arrayValue: { values: [{ stringValue: 'trialing' }, { stringValue: 'active' }] },
        },
      },
    });
  });

  it('omits `where` entirely when there are no filters', async () => {
    respondWith([]);
    await makeClient().runQuery({ collectionPath: 'custom_questions' });
    expect(structuredQuery()['where']).toBeUndefined();
  });

  it('sends orderBy and limit', async () => {
    respondWith([]);
    await makeClient().runQuery({
      collectionPath: 'leaderboards/15/entries',
      orderBy: [{ field: 'score', direction: 'DESCENDING' }],
      limit: 10,
    });

    const query = structuredQuery();
    expect(query['orderBy']).toEqual([{ field: { fieldPath: 'score' }, direction: 'DESCENDING' }]);
    expect(query['limit']).toBe(10);
  });

  it('turns a startAt document ID into an inclusive reference cursor', async () => {
    respondWith([]);
    await makeClient().runQuery({
      collectionPath: 'custom_questions',
      orderBy: [{ field: DOCUMENT_ID_FIELD }],
      startAtDocumentId: 'cursor-id',
    });

    // `before: true` on a *start* cursor includes the value — the SDK's
    // `startAt`. The reference is the resource name, not the request URL.
    expect(structuredQuery()['startAt']).toEqual({
      values: [{ referenceValue: `${RESOURCE_ROOT}/custom_questions/cursor-id` }],
      before: true,
    });
  });

  it('turns an endBefore document ID into an exclusive end cursor', async () => {
    respondWith([]);
    await makeClient().runQuery({
      collectionPath: 'custom_questions',
      orderBy: [{ field: DOCUMENT_ID_FIELD }],
      endBeforeDocumentId: 'cursor-id',
    });

    // Same `before: true`, opposite meaning: on an *end* cursor it stops
    // before the value, excluding it — the SDK's `endBefore`. Both directions
    // are pinned because getting one backwards shifts the sampling window by a
    // document and nothing fails visibly.
    expect(structuredQuery()['endAt']).toEqual({
      values: [{ referenceValue: `${RESOURCE_ROOT}/custom_questions/cursor-id` }],
      before: true,
    });
    expect(structuredQuery()['startAt']).toBeUndefined();
  });

  it('decodes the returned documents', async () => {
    respondWith([
      {
        document: {
          name: `${RESOURCE_ROOT}/custom_questions/q1`,
          fields: {
            question: { stringValue: 'Q?' },
            incorrect_answers: { arrayValue: { values: [{ stringValue: 'B' }] } },
          },
        },
        readTime: '2026-08-18T00:00:00Z',
      },
    ]);

    const documents = await makeClient().runQuery({ collectionPath: 'custom_questions' });

    expect(documents).toEqual([
      {
        id: 'q1',
        path: 'custom_questions/q1',
        data: { question: 'Q?', incorrect_answers: ['B'] },
      },
    ]);
  });

  it('drops the readTime-only entry a query matching nothing returns', async () => {
    // Firestore answers an empty result set with one entry carrying a
    // `readTime` and no `document`. Counting entries instead of documents
    // would report one result and then decode it as `{}`.
    respondWith([{ readTime: '2026-08-18T00:00:00Z' }]);
    expect(await makeClient().runQuery({ collectionPath: 'custom_questions' })).toEqual([]);
  });
});

describe('FirestoreRestClient error handling', () => {
  it('reports a timeout as DEADLINE_EXCEEDED', async () => {
    rejectWith(new DOMException('The operation timed out', 'TimeoutError'));

    await expect(makeClient().getDocument('products/p1')).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof FirestoreRestError &&
        error.status === 'DEADLINE_EXCEEDED' &&
        error.message === 'Request timed out',
    );
  });

  it('reports a dead network as UNAVAILABLE', async () => {
    rejectWith(new TypeError('Failed to fetch'));

    await expect(makeClient().getDocument('products/p1')).rejects.toSatisfy(
      (error: unknown) => error instanceof FirestoreRestError && error.status === 'UNAVAILABLE',
    );
  });

  it('passes the caller-supplied deadline to the abort signal', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    respondWith({ name: `${RESOURCE_ROOT}/products/p1` });

    await makeClient().getDocument('products/p1', { timeoutMs: 20_000 });

    expect(timeoutSpy).toHaveBeenCalledWith(20_000);
    timeoutSpy.mockRestore();
  });

  it('falls back to the HTTP status when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
    });

    await expect(makeClient().getDocument('products/p1')).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof FirestoreRestError &&
        error.status === 'UNKNOWN' &&
        error.httpStatus === 502,
    );
  });

  it('reads an error delivered inside runQuery’s result array', async () => {
    respondWith([{ error: { status: 'PERMISSION_DENIED', message: 'Missing permissions' } }], {
      ok: false,
      status: 403,
    });

    await expect(makeClient().runQuery({ collectionPath: 'question_reports' })).rejects.toSatisfy(
      (error: unknown) => error instanceof FirestoreRestError && error.isPermissionDenied,
    );
  });
});
