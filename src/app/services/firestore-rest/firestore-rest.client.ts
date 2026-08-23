import { Injectable, inject } from '@angular/core';
import { environment } from '../../../environments/environment';
import { AuthService } from '../auth.service';
import { FirebaseAppService } from '../firebase-app.service';
import { FirestoreFields, decodeFields, encodeFields, encodeValue } from './firestore-value';

/**
 * Firestore over its REST API, with `fetch`.
 *
 * Why at all: `FIRESTORE_SDK_VS_REST.md`. The short version is that the client
 * SDK is 559 kB raw / 141 kB transfer — the single largest thing this app
 * ships, roughly 5× its own code — for thirteen API symbols over five
 * collections of flat documents, with its headline feature (offline
 * persistence) deliberately switched off.
 *
 * Two things this buys beyond the bundle, both of which the audit worked
 * around rather than fixed:
 *
 * - **Cancellation.** `getDocs`/`getDoc`/`setDoc`/`addDoc` take no options
 *   argument, which is why `giveUpAfter()` exists and why its name says it
 *   stops waiting without stopping the work. `AbortSignal.timeout()` tears the
 *   connection down.
 * - **Visibility.** Every request here is one `fetch` written in this file.
 *   Nothing retries, reconnects or re-reads on its own.
 *
 * What does *not* change: `firestore.rules`. REST requests carrying a Firebase
 * ID token go through the same rules engine with the same `request.auth`, so
 * the security boundary and the rules suite are untouched.
 */

const PRODUCTION_BASE_URL = 'https://firestore.googleapis.com/v1';

/** Where `firebase emulators:exec --only firestore` serves the REST API. */
const EMULATOR_BASE_URL = 'http://127.0.0.1:8080/v1';

/** Matches the deadline the SDK call sites used via `giveUpAfter`. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Firestore's name for the document-ID pseudo-field, in queries and cursors. */
export const DOCUMENT_ID_FIELD = '__name__';

/**
 * Field paths in an `updateMask` are a path *expression*: a dot separates map
 * segments, so a field literally named `a.b` would write to `b` inside a map
 * `a` unless it is backtick-quoted. Every field this app writes is a plain
 * identifier, so rather than implement quoting for a case that does not exist,
 * `setDocument` refuses anything else — see the throw in `updateMaskFor`.
 */
const PLAIN_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A document as read back: its ID, its path, and its decoded fields. */
export interface RestDocument {
  id: string;
  /** Path relative to the database root, e.g. `custom_questions/abc123`. */
  path: string;
  data: Record<string, unknown>;
}

export type RestFilterOp = 'EQUAL' | 'IN';

export interface RestFieldFilter {
  field: string;
  op: RestFilterOp;
  value: unknown;
}

export interface RestOrderBy {
  field: string;
  direction?: 'ASCENDING' | 'DESCENDING';
}

/**
 * A query over one collection.
 *
 * Cursors are expressed as bare document IDs rather than as wire values
 * because a `__name__` cursor is a **`referenceValue` holding the full
 * resource path** — `projects/{p}/databases/(default)/documents/{path}/{id}` —
 * and the project is known here, not at the call site. Passing the ID alone
 * makes the wrong thing impossible to write.
 */
export interface RestQuery {
  /** Full collection path, e.g. `custom_questions` or `leaderboards/15/entries`. */
  collectionPath: string;
  where?: RestFieldFilter[];
  orderBy?: RestOrderBy[];
  limit?: number;
  /** Inclusive lower bound, by document ID. Requires ordering by `__name__`. */
  startAtDocumentId?: string;
  /** Exclusive upper bound, by document ID. Requires ordering by `__name__`. */
  endBeforeDocumentId?: string;
}

/** One document write inside a batched {@link FirestoreRestClient.commit}. */
export interface RestWrite {
  /** Document path, e.g. `custom_questions/abc123`. */
  path: string;
  data: Record<string, unknown>;
  /**
   * Require that the document does not already exist. Firestore refuses the
   * whole batch if it does, which is what makes a client-generated document ID
   * safe to mint.
   */
  mustNotExist?: boolean;
}

export interface RestRequestOptions {
  timeoutMs?: number;
}

/**
 * Every failure this client produces, so a call site has one type to catch.
 *
 * `status` is Google's canonical error code (`PERMISSION_DENIED`,
 * `NOT_FOUND`, …) taken from the response body, or one this client synthesises
 * for a failure that never reached the server: `DEADLINE_EXCEEDED` when the
 * abort fired, `UNAVAILABLE` when `fetch` itself rejected.
 */
export class FirestoreRestError extends Error {
  constructor(
    readonly status: string,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'FirestoreRestError';
  }

  /**
   * A rules refusal. Four call sites branch on this rather than on a message,
   * because it is routine rather than exceptional for them: a taken
   * `{window}-{slot}` document ID means "try the next slot", and a leaderboard
   * write that does not beat the existing best is simply not a new PB.
   */
  get isPermissionDenied(): boolean {
    return this.status === 'PERMISSION_DENIED';
  }
}

/**
 * Whether an error is Firestore refusing a request under `firestore.rules`.
 *
 * Exported and shared because four call sites branch on it and each one gets
 * it wrong differently if it drifts: `FirebaseService.reportQuestion` and
 * `SubscriptionService.createSessionDoc` would each abandon their
 * `{window}-{slot}` slot loop on the first collision and report a rate limit
 * nobody hit, and the two components would stop explaining a refusal they can
 * explain and fall back to "please try again".
 *
 * Under the SDK this was `error.code === 'permission-denied'` written out at
 * each site. That shape no longer exists — REST reports `PERMISSION_DENIED` in
 * the response body — and a duck-typed check against the old shape now matches
 * nothing at all, silently. One function, so there is one thing to keep true.
 */
export function isFirestorePermissionDenied(error: unknown): boolean {
  return error instanceof FirestoreRestError && error.isPermissionDenied;
}

@Injectable({ providedIn: 'root' })
export class FirestoreRestClient {
  private readonly firebaseAppService = inject(FirebaseAppService);
  private readonly authService = inject(AuthService);

  private documentsRootPromise: Promise<DocumentsRoot> | null = null;

  /**
   * Reads one document, or `null` when it does not exist.
   *
   * A missing document is a 404 and a rules refusal is a 403, so the two never
   * collapse into one another — which matters for `getLeaderboardEntry`, whose
   * whole job is to tell "you have no entry yet" apart from "that write was
   * refused for some other reason" (`CLAUDE.md` §4.4).
   */
  async getDocument(
    documentPath: string,
    options: RestRequestOptions = {},
  ): Promise<RestDocument | null> {
    assertDocumentPath(documentPath);
    const { url } = await this.getDocumentsRoot();
    try {
      const document = await this.request<WireDocument>(
        `${url}/${encodePath(documentPath)}`,
        { method: 'GET' },
        options,
      );
      return toRestDocument(document);
    } catch (error) {
      if (error instanceof FirestoreRestError && error.status === 'NOT_FOUND') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Creates or overwrites a document at a known ID — the REST equivalent of
   * `setDoc`.
   *
   * The `updateMask` names exactly the keys being written. Firestore's `patch`
   * leaves server fields *outside* the mask untouched, so strictly this is a
   * merge rather than a replace — and for every write this app makes the two
   * are the same operation, because each one either targets a document ID that
   * cannot already exist (the `{window}-{slot}` session and report slots) or
   * rewrites a leaderboard entry's complete key set. Sending the mask is the
   * unambiguous half of the API rather than a bet on what an absent mask
   * means.
   *
   * **The first genuinely partial write now exists**:
   * `FirebaseService.setQuestionStatus` sends `status` alone, and relies on
   * exactly this behaviour to leave the rest of the question as its author
   * wrote it. `firestore.rules` requires it, too — the moderation rule
   * permits a write that affects no key but `status`, so a full-document
   * replace would be refused as well as wrong.
   */
  async setDocument(
    documentPath: string,
    data: Record<string, unknown>,
    options: RestRequestOptions = {},
  ): Promise<void> {
    assertDocumentPath(documentPath);
    const { url } = await this.getDocumentsRoot();
    const fields = encodeFields(data);
    await this.request<WireDocument>(
      `${url}/${encodePath(documentPath)}?${updateMaskFor(fields)}`,
      { method: 'PATCH', body: JSON.stringify({ fields }) },
      options,
    );
  }

  /**
   * Adds a document under a server-generated ID — the REST equivalent of
   * `addDoc`. Firestore mints the ID, exactly as the SDK's `addDoc` does not
   * (it generates one client-side); either way the rules see a `create`.
   */
  async createDocument(
    collectionPath: string,
    data: Record<string, unknown>,
    options: RestRequestOptions = {},
  ): Promise<RestDocument> {
    assertCollectionPath(collectionPath);
    const { url } = await this.getDocumentsRoot();
    const document = await this.request<WireDocument>(
      `${url}/${encodePath(collectionPath)}`,
      { method: 'POST', body: JSON.stringify({ fields: encodeFields(data) }) },
      options,
    );
    return toRestDocument(document);
  }

  /**
   * Commits several writes atomically — all of them land or none do.
   *
   * This exists for one reason: `firestore.rules` cannot count documents, so
   * the hourly cap on `custom_questions` is a counter the client must
   * increment in the *same* batch as the question it is submitting. The rule
   * reads that counter's post-commit state with `getAfter()`, which only means
   * anything if the two writes are one commit. Two sequential writes would let
   * a client send the question and simply never send the increment.
   */
  async commit(writes: RestWrite[], options: RestRequestOptions = {}): Promise<void> {
    for (const write of writes) {
      assertDocumentPath(write.path);
    }
    const { url, resourceName } = await this.getDocumentsRoot();

    await this.request<unknown>(
      `${url}:commit`,
      {
        method: 'POST',
        body: JSON.stringify({
          writes: writes.map((write) => {
            const fields = encodeFields(write.data);
            return {
              update: { name: `${resourceName}/${write.path}`, fields },
              // Named explicitly, so a write only ever touches the keys it
              // carries — same reasoning as `setDocument`.
              updateMask: { fieldPaths: Object.keys(fields).map(assertPlainFieldName) },
              ...(write.mustNotExist ? { currentDocument: { exists: false } } : {}),
            };
          }),
        }),
      },
      options,
    );
  }

  /** Runs a structured query over one collection. */
  async runQuery(query: RestQuery, options: RestRequestOptions = {}): Promise<RestDocument[]> {
    assertCollectionPath(query.collectionPath);
    const { url, resourceName } = await this.getDocumentsRoot();
    const { parentPath, collectionId } = splitCollectionPath(query.collectionPath);
    const parentUrl = parentPath ? `${url}/${encodePath(parentPath)}` : url;

    const results = await this.request<WireQueryResult[]>(
      `${parentUrl}:runQuery`,
      {
        method: 'POST',
        body: JSON.stringify({
          structuredQuery: buildStructuredQuery(query, collectionId, resourceName),
        }),
      },
      options,
    );

    // A query matching nothing still answers, with a single entry carrying a
    // `readTime` and no `document`. Filtering on the document rather than on
    // the array length is what keeps that from decoding as an empty object.
    return results
      .filter((result): result is WireQueryResult & { document: WireDocument } => !!result.document)
      .map((result) => toRestDocument(result.document));
  }

  /**
   * `projects/{id}/databases/(default)/documents` for this deployment, plus
   * the API key that goes on every request.
   *
   * Memoized, and **cleared on rejection** — the runtime-config fetch behind
   * it can fail transiently, and a cached rejected promise would make one blip
   * permanent for the session (`CLAUDE.md` §4.4).
   */
  private getDocumentsRoot(): Promise<DocumentsRoot> {
    if (!this.documentsRootPromise) {
      this.documentsRootPromise = this.firebaseAppService.getConfig().then((config) => {
        if (!config.projectId) {
          throw new Error('Firebase runtime config has no projectId; cannot address Firestore.');
        }
        const baseUrl = environment.useEmulators ? EMULATOR_BASE_URL : PRODUCTION_BASE_URL;
        // Two forms of the same thing: `url` is where requests go, and
        // `resourceName` is how Firestore names documents to itself — which is
        // what a `referenceValue` cursor has to hold.
        const resourceName = `projects/${config.projectId}/databases/(default)/documents`;
        return { url: `${baseUrl}/${resourceName}`, resourceName, apiKey: config.apiKey };
      });
      this.documentsRootPromise.catch(() => {
        this.documentsRootPromise = null;
      });
    }
    return this.documentsRootPromise;
  }

  private async request<T>(
    url: string,
    init: { method: string; body?: string },
    options: RestRequestOptions,
  ): Promise<T> {
    const { apiKey } = await this.getDocumentsRoot();
    const headers: Record<string, string> = {};
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    // The key identifies the project for quota; the bearer token identifies
    // the user for `firestore.rules`. They are not alternatives — the SDK's
    // own transport sends both — and the token is genuinely optional, because
    // `custom_questions`, `products` and the leaderboards are all
    // `allow read: if true`.
    const token = await this.authService.getIdToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    let response: Response;
    try {
      response = await fetch(withApiKey(url, apiKey), {
        method: init.method,
        headers,
        body: init.body,
        // A real cancellation, not a `Promise.race` that leaves the request
        // running for a caller that has gone (`CLAUDE.md` §4.4). This is the
        // thing the SDK had no mechanism for.
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      throw toTransportError(error);
    }

    if (!response.ok) {
      throw await toResponseError(response);
    }
    return (await response.json()) as T;
  }
}

interface DocumentsRoot {
  /** Absolute URL of the database's document root, for building request URLs. */
  url: string;
  /** `projects/{id}/databases/(default)/documents`, for building references. */
  resourceName: string;
  apiKey?: string;
}

interface WireDocument {
  name: string;
  fields?: FirestoreFields;
}

interface WireQueryResult {
  document?: WireDocument;
  readTime?: string;
}

function withApiKey(url: string, apiKey: string | undefined): string {
  if (!apiKey) {
    return url;
  }
  return `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`;
}

/**
 * `AbortSignal.timeout` rejects with a `TimeoutError` DOMException and a dead
 * network rejects with a `TypeError`. Both become a `FirestoreRestError` so
 * call sites have exactly one error type to reason about — and the timeout
 * message stays the wording `giveUpAfter` used, since the deadline is
 * load-bearing for `TriviaService`'s fall back to the offline pool, which
 * triggers on the throw.
 */
function toTransportError(error: unknown): FirestoreRestError {
  if (
    error instanceof DOMException &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return new FirestoreRestError('DEADLINE_EXCEEDED', 0, 'Request timed out');
  }
  return new FirestoreRestError(
    'UNAVAILABLE',
    0,
    error instanceof Error ? error.message : 'Firestore request failed',
  );
}

async function toResponseError(response: Response): Promise<FirestoreRestError> {
  let status = 'UNKNOWN';
  let message = `Firestore request failed with HTTP ${response.status}`;
  try {
    const body: unknown = await response.json();
    // `:runQuery` streams, so its errors can arrive wrapped in the same array
    // its results would have used.
    const payload = Array.isArray(body) ? body[0] : body;
    const error = (payload as { error?: { status?: string; message?: string } } | null)?.error;
    if (error?.status) {
      status = error.status;
    }
    if (error?.message) {
      message = error.message;
    }
  } catch {
    // A non-JSON error body (a proxy's HTML page, say) leaves the HTTP-status
    // message above, which is more useful than a parse failure.
  }
  return new FirestoreRestError(status, response.status, message);
}

/**
 * A wire document names itself by resource name —
 * `projects/{p}/databases/(default)/documents/{path}`. Neither a project ID
 * nor a database ID can contain a slash, so the **first** `/documents/` is
 * always the separator, even for a collection that happens to be called
 * `documents`.
 */
function toRestDocument(document: WireDocument): RestDocument {
  const marker = '/documents/';
  const index = document.name.indexOf(marker);
  const path = index === -1 ? document.name : document.name.slice(index + marker.length);
  const segments = path.split('/');
  return {
    id: segments[segments.length - 1],
    path,
    data: decodeFields(document.fields ?? {}),
  };
}

function buildStructuredQuery(
  query: RestQuery,
  collectionId: string,
  resourceName: string,
): Record<string, unknown> {
  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId }],
  };

  const filters = (query.where ?? []).map((filter) => ({
    fieldFilter: {
      field: { fieldPath: filter.field },
      op: filter.op,
      value: encodeValue(filter.value),
    },
  }));
  if (filters.length === 1) {
    structuredQuery['where'] = filters[0];
  } else if (filters.length > 1) {
    structuredQuery['where'] = { compositeFilter: { op: 'AND', filters } };
  }

  if (query.orderBy?.length) {
    structuredQuery['orderBy'] = query.orderBy.map((order) => ({
      field: { fieldPath: order.field },
      direction: order.direction ?? 'ASCENDING',
    }));
  }

  // `before: true` on both, and they mean opposite things by design: for a
  // start cursor it positions *before* the value, so the value is included
  // (the SDK's `startAt`); for an end cursor it stops *before* the value, so
  // the value is excluded (the SDK's `endBefore`). Getting either backwards
  // shifts the sampling window by one document and nothing fails visibly,
  // which is why both directions are pinned by a test.
  if (query.startAtDocumentId !== undefined) {
    structuredQuery['startAt'] = {
      values: [documentIdCursor(resourceName, query.collectionPath, query.startAtDocumentId)],
      before: true,
    };
  }
  if (query.endBeforeDocumentId !== undefined) {
    structuredQuery['endAt'] = {
      values: [documentIdCursor(resourceName, query.collectionPath, query.endBeforeDocumentId)],
      before: true,
    };
  }

  if (query.limit !== undefined) {
    structuredQuery['limit'] = query.limit;
  }
  return structuredQuery;
}

function documentIdCursor(resourceName: string, collectionPath: string, documentId: string) {
  // The reference is the *resource name*, starting at `projects/…` — not the
  // https URL the requests go to.
  return { referenceValue: `${resourceName}/${collectionPath}/${documentId}` };
}

function assertPlainFieldName(name: string): string {
  if (!PLAIN_FIELD_NAME.test(name)) {
    throw new TypeError(
      `Cannot write the field "${name}": an updateMask path needs backtick quoting for ` +
        'anything but a plain identifier, which this client does not implement.',
    );
  }
  return name;
}

function updateMaskFor(fields: FirestoreFields): string {
  return Object.keys(fields)
    .map((name) => `updateMask.fieldPaths=${encodeURIComponent(assertPlainFieldName(name))}`)
    .join('&');
}

/** Percent-encodes each segment, leaving the separators alone. */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function splitCollectionPath(collectionPath: string): { parentPath: string; collectionId: string } {
  const segments = collectionPath.split('/');
  return {
    collectionId: segments[segments.length - 1],
    parentPath: segments.slice(0, -1).join('/'),
  };
}

/**
 * A document path has an even number of segments and a collection path an odd
 * one. Checked rather than assumed because getting it wrong produces a
 * confusing server-side 400 rather than anything that names the real mistake,
 * and because the subcollection paths here (`leaderboards/{board}/entries/{uid}`)
 * are exactly where a segment goes missing.
 */
function assertDocumentPath(path: string): void {
  const segments = path.split('/');
  if (segments.length % 2 !== 0 || segments.some((segment) => segment === '')) {
    throw new TypeError(`"${path}" is not a document path (it needs an even number of segments)`);
  }
}

function assertCollectionPath(path: string): void {
  const segments = path.split('/');
  if (segments.length % 2 !== 1 || segments.some((segment) => segment === '')) {
    throw new TypeError(`"${path}" is not a collection path (it needs an odd number of segments)`);
  }
}
