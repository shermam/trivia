import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { AuthService } from './auth.service';
import { FirebaseAppService } from './firebase-app.service';
import { SubscriptionService } from './subscription.service';

/**
 * `SubscriptionService` is the payment path, so the parts of it worth pinning
 * are the ones `firestore.rules` is relying on the client to get right: the
 * exact payload it writes (anything extra is rejected by the `hasOnly()`
 * allowlist) and the document ID it writes under (the volume cap lives there,
 * because rules cannot count documents). Both are conventions shared with a
 * file the compiler never sees, which is exactly the kind of agreement that
 * rots silently.
 *
 * Firestore is faked at `fetch`, one layer below where this suite used to
 * stand. It had to move: the two `onSnapshot` listeners it was built around no
 * longer exist (`BACKLOG.md` item 2), and the SDK namespace it faked is not in
 * the bundle any more. The replacement is better placed anyway — these tests
 * now run through the real `FirestoreRestClient` and assert on the request
 * that would actually reach Firestore.
 */

const PROJECT = 'demo-project';
const RESOURCE_ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const URL_ROOT = `https://firestore.googleapis.com/v1/${RESOURCE_ROOT}`;
const SESSION_WINDOW_MS = 300_000;

interface WrittenDoc {
  path: string;
  data: Record<string, unknown>;
}

interface RecordedQuery {
  collectionPath: string;
  /** Field, operator and decoded value — the operator matters: IN is not EQUAL. */
  wheres: { field: string; op: string; value: unknown }[];
  limit?: number;
}

interface ProductSeed {
  id: string;
  role: string | null;
  active: boolean;
  prices: { id: string; active: boolean; interval: string }[];
  /** Lets a test make the *first* product the slowest to answer. */
  delayMs?: number;
}

/** Deliberately not the production encoder, so a symmetric bug cannot hide. */
function wire(value: unknown): unknown {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return { integerValue: String(value) };
  if (value === null) return { nullValue: null };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(wire) } };
  return { mapValue: { fields: wireFields(value as Record<string, unknown>) } };
}

function wireFields(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, wire(v)]));
}

/**
 * The inverse, for reading back what the service wrote and what it asked for.
 * Also deliberately local.
 *
 * `arrayValue` is here because without it the status filter is *structurally*
 * unobservable: `status IN ['trialing','active']` recorded as `null` cannot be
 * asserted on, so the one thing keeping the client's Pro signal from being
 * broader than the server's gate had no test at all.
 */
function unwire(value: Record<string, unknown>): unknown {
  if ('stringValue' in value) return value['stringValue'];
  if ('integerValue' in value) return Number(value['integerValue']);
  if ('booleanValue' in value) return value['booleanValue'];
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) {
    const values = (value['arrayValue'] as { values?: Record<string, unknown>[] }).values ?? [];
    return values.map(unwire);
  }
  throw new Error('fake server cannot decode ' + JSON.stringify(value));
}

function unwireFields(fields: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, unwire(v)]));
}

interface FakeOptions {
  /** Session document IDs the rules should refuse, as a spent slot would be. */
  deniedIds?: string[];
  /** What the Cloud Function eventually writes onto the session document. */
  writeBack?: Record<string, unknown>;
  /** Never write back, so the handshake reaches its deadline instead. */
  neverRespond?: boolean;
  /** Reads of the session document that answer "still working" before `writeBack`. */
  writeBackAfterReads?: number;
  /** Documents in `customers/{uid}/subscriptions`. Filtered by `role` in memory. */
  subscriptionDocs?: Record<string, unknown>[];
  /**
   * One entry per subscriptions query, in order, for tests that need two
   * concurrent reads to answer differently or out of order. The last entry
   * repeats once exhausted.
   */
  subscriptionQueryPlan?: { docs: Record<string, unknown>[]; delayMs?: number }[];
  /** Fail this many session reads before answering, as a flaky network would. */
  failSessionReads?: number;
  /** The `products` catalog, for the price lookup. */
  products?: ProductSeed[];
  /** A write failure that is *not* a rules refusal. */
  failWriteWith?: 'server-error';
}

function fakeFirestore(options: FakeOptions = {}) {
  const writes: WrittenDoc[] = [];
  const queries: RecordedQuery[] = [];
  const sessionReads: string[] = [];
  // Every deadline the client actually armed, so a test can check that a poll
  // hands each read the budget it has left rather than the whole budget.
  const armedTimeouts: number[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    armedTimeouts.push(ms);
    return new AbortController().signal;
  });
  const denied = new Set(options.deniedIds ?? []);
  let subscriptionQueryCount = 0;
  let failedSessionReads = 0;
  let inFlightPriceQueries = 0;
  let maxConcurrentPriceQueries = 0;

  const ok = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  const fail = (status: number, code: string) =>
    Promise.resolve({
      ok: false,
      status,
      json: () => Promise.resolve({ error: { status: code, message: code } }),
    });
  const docsFor = (
    collectionPath: string,
    rows: { id: string; data: Record<string, unknown> }[],
  ) =>
    rows.length
      ? rows.map((row) => ({
          document: {
            name: `${RESOURCE_ROOT}/${collectionPath}/${row.id}`,
            fields: wireFields(row.data),
          },
        }))
      : [{ readTime: '2026-08-18T00:00:00Z' }];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method: string; body?: string }) => {
      const body = init.body ? (JSON.parse(init.body) as Record<string, never>) : undefined;
      const pathOf = (u: string) => u.split('?')[0].slice(`${URL_ROOT}/`.length);

      if (url.includes(':runQuery')) {
        const query = body!['structuredQuery'] as Record<string, never>;
        const collectionId = (query['from'] as { collectionId: string }[])[0].collectionId;
        const parent = url.startsWith(`${URL_ROOT}:runQuery`)
          ? ''
          : pathOf(url.replace(':runQuery', ''));
        const collectionPath = parent ? `${parent}/${collectionId}` : collectionId;

        const where = query['where'] as Record<string, never> | undefined;
        const rawFilters = where
          ? ((where['compositeFilter'] as { filters: Record<string, never>[] } | undefined)
              ?.filters ?? [where])
          : [];
        const wheres = rawFilters.map((filter) => {
          const f = filter['fieldFilter'] as {
            field: { fieldPath: string };
            op: string;
            value: Record<string, unknown>;
          };
          return { field: f.field.fieldPath, op: f.op, value: unwire(f.value) };
        });
        queries.push({ collectionPath, wheres, limit: query['limit'] as number | undefined });

        if (collectionId === 'subscriptions') {
          const plan = options.subscriptionQueryPlan;
          const step = plan ? plan[Math.min(subscriptionQueryCount, plan.length - 1)] : undefined;
          subscriptionQueryCount++;
          if (step?.delayMs) {
            await new Promise((resolve) => setTimeout(resolve, step.delayMs));
          }
          // Applies the filter rather than returning the seed verbatim. A fake
          // that ignores `where` cannot distinguish a query that asks for the
          // right statuses from one that asks for all of them, which is
          // exactly the assertion this collection most needs.
          let rows = step ? step.docs : (options.subscriptionDocs ?? []);
          for (const filter of wheres) {
            rows = rows.filter((doc) =>
              filter.op === 'IN'
                ? (filter.value as unknown[]).includes(doc[filter.field])
                : doc[filter.field] === filter.value,
            );
          }
          return ok(
            docsFor(
              collectionPath,
              rows.map((data, i) => ({ id: `sub_${i}`, data })),
            ),
          );
        }

        if (collectionId === 'products') {
          let rows = options.products ?? [];
          for (const filter of wheres) {
            rows = rows.filter(
              (p) => (p as unknown as Record<string, unknown>)[filter.field] === filter.value,
            );
          }
          return ok(
            docsFor(
              collectionPath,
              rows.map((p) => ({ id: p.id, data: { role: p.role, active: p.active } })),
            ),
          );
        }

        // prices, under products/{id}/prices
        inFlightPriceQueries++;
        maxConcurrentPriceQueries = Math.max(maxConcurrentPriceQueries, inFlightPriceQueries);
        const productId = collectionPath.split('/')[1];
        const product = (options.products ?? []).find((p) => p.id === productId)!;
        if (product.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, product.delayMs));
        }
        inFlightPriceQueries--;
        let prices = product.prices;
        for (const filter of wheres) {
          prices = prices.filter(
            (p) => (p as unknown as Record<string, unknown>)[filter.field] === filter.value,
          );
        }
        return ok(
          docsFor(
            collectionPath,
            prices.map((p) => ({ id: p.id, data: { interval: p.interval } })),
          ),
        );
      }

      const path = pathOf(url);

      if (init.method === 'GET') {
        // Polling a session document for the Cloud Function's write-back.
        sessionReads.push(path);
        if (
          options.failSessionReads !== undefined &&
          failedSessionReads < options.failSessionReads
        ) {
          failedSessionReads++;
          return fail(503, 'UNAVAILABLE');
        }
        if (options.neverRespond) {
          return fail(404, 'NOT_FOUND');
        }
        if (
          options.writeBackAfterReads !== undefined &&
          sessionReads.length <= options.writeBackAfterReads
        ) {
          // The document exists but the function has not finished — neither a
          // url nor an error yet.
          return ok({ name: `${RESOURCE_ROOT}/${path}`, fields: {} });
        }
        return ok({
          name: `${RESOURCE_ROOT}/${path}`,
          fields: wireFields(options.writeBack ?? { url: 'https://stripe.test/s' }),
        });
      }

      // A write: the session document.
      if (options.failWriteWith === 'server-error') {
        return fail(500, 'INTERNAL');
      }
      if (denied.has(path.slice(path.lastIndexOf('/') + 1))) {
        return fail(403, 'PERMISSION_DENIED');
      }
      writes.push({
        path,
        data: unwireFields(body!['fields'] as Record<string, Record<string, unknown>>),
      });
      return ok({ name: `${RESOURCE_ROOT}/${path}` });
    }),
  );

  return {
    writes,
    queries,
    sessionReads,
    armedTimeouts,
    priceQueries: () => queries.filter((q) => q.collectionPath.endsWith('/prices')),
    maxConcurrentPriceQueries: () => maxConcurrentPriceQueries,
  };
}

function configure(user: unknown, hasProClaim = false) {
  const refreshIdToken = vi.fn(() => Promise.resolve());
  TestBed.configureTestingModule({
    providers: [
      {
        provide: FirebaseAppService,
        useValue: { getConfig: () => Promise.resolve({ projectId: PROJECT, apiKey: 'test-key' }) },
      },
      {
        provide: AuthService,
        useValue: {
          user: signal(user),
          isProUser: signal(hasProClaim),
          refreshIdToken,
          getIdToken: () => Promise.resolve('id-token'),
        },
      },
    ],
  });
  return { service: TestBed.inject(SubscriptionService), refreshIdToken };
}

/** Lets the effect's read and any queued microtasks land before asserting. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const currentWindow = () => Math.floor(Date.now() / SESSION_WINDOW_MS);
const slotIds = () => Array.from({ length: 10 }, (_, slot) => `${currentWindow()}-${slot}`);

describe('SubscriptionService session handshake', () => {
  const user = { uid: 'user-1', isAnonymous: false };

  beforeEach(() => {
    // `window.location.assign` is non-configurable in a real browser, but this
    // is jsdom; the redirect itself is covered for real by pricing.cy.ts.
    vi.stubGlobal('location', { origin: 'https://example.web.app', assign: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('writes only the origin for a billing-portal session', async () => {
    const fake = fakeFirestore();
    await configure(user).service.openBillingPortal();

    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].data).toEqual({ origin: 'https://example.web.app' });
  });

  // The redirect URLs and the checkout mode used to be here and were handed to
  // Stripe verbatim (finding A2). The rules' `hasOnly()` allowlist now rejects
  // them outright, so sending them again would break checkout, not just widen
  // it.
  it('never sends redirect URLs or a mode the function decides for itself', async () => {
    const fake = fakeFirestore();
    await configure(user).service.openBillingPortal();

    expect(Object.keys(fake.writes[0].data)).toEqual(['origin']);
  });

  // The assertion above covers `portal_sessions`, whose rules allowlist is
  // `hasOnly(['origin'])`. Finding A2 was about `checkout_sessions`, whose
  // allowlist is `hasOnly(['price','origin'])` — a different collection and a
  // different key set, so it needs its own test. Without this, putting
  // `success_url` or `mode` back into the checkout payload passes every test
  // here and is refused by the rules at runtime.
  it('sends exactly price and origin for a checkout session', async () => {
    const fake = fakeFirestore({
      products: [
        {
          id: 'prod_pro',
          role: 'pro',
          active: true,
          prices: [{ id: 'price_pro', active: true, interval: 'month' }],
        },
      ],
    });

    await configure(user).service.startProCheckout();

    expect(Object.keys(fake.writes[0].data).sort()).toEqual(['origin', 'price']);
  });

  it('writes under a {5-minute window}-{slot} document ID the volume cap accepts', async () => {
    const fake = fakeFirestore();
    await configure(user).service.openBillingPortal();

    expect(fake.writes[0].path).toMatch(
      new RegExp(`^customers/user-1/portal_sessions/${currentWindow()}-[0-9]$`),
    );
  });

  // A slot already spent this window is a refusal, and a user who genuinely
  // opens the portal twice in five minutes should not see an error for it.
  it('moves to another slot when the one it picked is already spent', async () => {
    const fake = fakeFirestore({ deniedIds: slotIds().slice(0, 9) });
    await configure(user).service.openBillingPortal();

    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].path.endsWith(slotIds()[9])).toBe(true);
  });

  it('gives up with an actionable message once every slot in the window is spent', async () => {
    const fake = fakeFirestore({ deniedIds: slotIds() });

    await expect(configure(user).service.openBillingPortal()).rejects.toThrow(/Reload the page/);
    expect(fake.writes).toHaveLength(0);
  });

  // Only a rules refusal means "try another slot"; anything else is a real
  // failure and burning nine more writes on it would just delay reporting it.
  it('does not retry a failure that is not a permission denial', async () => {
    const fake = fakeFirestore({ failWriteWith: 'server-error' });

    await expect(configure(user).service.openBillingPortal()).rejects.toThrow(/INTERNAL/);
    expect(fake.writes).toHaveLength(0);
  });

  it('surfaces the error the Cloud Function writes back', async () => {
    fakeFirestore({ writeBack: { error: { message: 'Could not start checkout.' } } });

    await expect(configure(user).service.openBillingPortal()).rejects.toThrow(
      'Could not start checkout.',
    );
  });

  it('refuses an anonymous caller before writing anything', async () => {
    const fake = fakeFirestore();
    const { service } = configure({ uid: 'anon-1', isAnonymous: true });

    await expect(service.openBillingPortal()).rejects.toThrow('Sign in before managing');
    await expect(service.startProCheckout()).rejects.toThrow('Sign in before subscribing');
    expect(fake.writes).toHaveLength(0);
  });

  // The price lookup is a pair of Firestore reads; an anonymous click that
  // can't succeed anyway shouldn't pay for them.
  it('does not look up the Pro price for a caller it will refuse', async () => {
    const fake = fakeFirestore({ products: [] });

    await expect(
      configure({ uid: 'anon-1', isAnonymous: true }).service.startProCheckout(),
    ).rejects.toThrow();
    expect(fake.queries.filter((q) => q.collectionPath === 'products')).toHaveLength(0);
  });
});

/**
 * What replaced the `onSnapshot` handshake. The Cloud Function writes the URL
 * onto the session document some moments after the client creates it, and
 * there is no listener to hear that any more — so the client asks again.
 */
describe('SubscriptionService handshake polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('location', { origin: 'https://example.web.app', assign: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('keeps reading until the function writes the URL back', async () => {
    const fake = fakeFirestore({ writeBackAfterReads: 3 });
    const { service } = configure({ uid: 'user-1', isAnonymous: false });

    const pending = service.openBillingPortal();
    await vi.runAllTimersAsync();
    await pending;

    expect(fake.sessionReads).toHaveLength(4);
  });

  // A document that does not exist yet is the normal first state of the
  // handshake — the client's own create has landed but the function has not
  // run. Treating that 404 as a failure would break every checkout.
  it('treats a not-yet-written document as "still working", not a failure', async () => {
    fakeFirestore({ neverRespond: true });
    const { service } = configure({ uid: 'user-1', isAnonymous: false });

    const pending = service.openBillingPortal();
    const assertion = expect(pending).rejects.toThrow(/Timed out/);
    await vi.runAllTimersAsync();
    await assertion;
  });

  /**
   * Part of finding B6. The handshake's deadline used to be a `Promise.race`
   * around an `onSnapshot`, and `Promise.race` settles without telling the
   * loser — so a timed-out checkout left its subscription attached for the
   * rest of the session, still receiving writes and still billed for them.
   * Polling has nothing to detach, but it can still leave a timer armed, which
   * is the same bug wearing different clothes.
   */
  it('leaves nothing armed once the handshake is over', async () => {
    const fake = fakeFirestore({ neverRespond: true });
    const { service } = configure({ uid: 'user-1', isAnonymous: false });

    const pending = service.openBillingPortal();
    const assertion = expect(pending).rejects.toThrow(/Timed out/);
    // Advanced by a fixed amount rather than `runAllTimersAsync()`, which
    // drains the queue by definition and made this assertion a tautology — a
    // leaked one-hour timer per poll iteration passed it. Twenty-five seconds
    // is past the deadline but nowhere near a leak, so a leak is still
    // pending and still counted.
    await vi.advanceTimersByTimeAsync(25_000);
    await assertion;

    expect(vi.getTimerCount()).toBe(0);
    // And nothing kept polling past the deadline.
    const readsAtDeadline = fake.sessionReads.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.sessionReads).toHaveLength(readsAtDeadline);
  });

  // `onSnapshot` reconnected through a transient drop by itself and only
  // surfaced terminal errors. A poll that rejects on the first failed read
  // would turn the payment path one-strike — a regression the migration has no
  // reason to cause.
  it('treats a failed read as a not-yet rather than killing the checkout', async () => {
    const fake = fakeFirestore({ failSessionReads: 3 });
    const { service } = configure({ uid: 'user-1', isAnonymous: false });

    const pending = service.openBillingPortal();
    await vi.runAllTimersAsync();
    await pending;

    expect(fake.sessionReads.length).toBeGreaterThan(3);
  });

  // ...but tolerating a failure must not mean hiding it. Reaching the deadline
  // while every read is failing is a network fault, and reporting it as
  // "timed out waiting for Stripe" would narrate a cause nobody verified
  // (`CLAUDE.md` §4.4).
  it('reports the read failure, not a timeout, when the reads never recover', async () => {
    fakeFirestore({ failSessionReads: 1_000 });
    const { service } = configure({ uid: 'user-1', isAnonymous: false });

    const pending = service.openBillingPortal();
    const assertion = expect(pending).rejects.toThrow(/UNAVAILABLE/);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('hands each read the budget that is left, not the whole budget', async () => {
    // Giving every read the full CHECKOUT_TIMEOUT_MS composes two 20s bounds
    // into forty seconds of wall clock, because a read starting at 19.5s is
    // still allowed its own twenty. Every armed deadline would be exactly
    // 20000 without the fix; with it they shrink towards zero.
    const fake = fakeFirestore({ neverRespond: true });
    const { service } = configure({ uid: 'user-1', isAnonymous: false });

    const pending = service.openBillingPortal();
    const assertion = expect(pending).rejects.toThrow(/Timed out/);
    await vi.runAllTimersAsync();
    await assertion;

    expect(Math.min(...fake.armedTimeouts)).toBeLessThan(1_000);
  });

  it('bounds the number of reads a single handshake can cost', async () => {
    const fake = fakeFirestore({ neverRespond: true });
    const { service } = configure({ uid: 'user-1', isAnonymous: false });

    const pending = service.openBillingPortal();
    const assertion = expect(pending).rejects.toThrow(/Timed out/);
    await vi.runAllTimersAsync();
    await assertion;

    // 20s at 500ms. The point is that it is a fixed, small number rather than
    // something that grows with how long the function takes.
    expect(fake.sessionReads.length).toBeLessThanOrEqual(40);
    expect(fake.sessionReads.length).toBeGreaterThan(1);
  });
});

/**
 * Finding C5. `getProPriceId()` read the product catalog and then awaited each
 * product's `prices` subcollection **one at a time**, so the wait was the sum
 * of the round trips rather than the slowest — on the click that starts
 * checkout, where a delay is most visible. Neither query carried a `limit`
 * either, which is the same unbounded-read rule C1 was about (`CLAUDE.md` §4.1).
 *
 * It also selected "first active product with a monthly price", while the
 * server accepts a price only from an active product carrying `role: 'pro'`
 * (`functions/src/checkout-request.ts`). Those are the same question only while
 * exactly one product exists; the day a second is added the client would send a
 * price the server is bound to reject, and checkout would simply stop working.
 */
describe('SubscriptionService Pro price lookup (C5)', () => {
  const monthly = (id: string) => ({ id, active: true, interval: 'month' });

  beforeEach(() => {
    vi.stubGlobal('location', { origin: 'https://example.web.app', assign: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  /** The price the service settled on, read off the session doc it wrote. */
  const writtenPrice = (fake: ReturnType<typeof fakeFirestore>) =>
    fake.writes.at(-1)?.data['price'];

  it('fetches every product’s prices at once instead of one after another', async () => {
    const fake = fakeFirestore({
      products: [
        { id: 'prod_a', role: 'pro', active: true, prices: [], delayMs: 20 },
        { id: 'prod_b', role: 'pro', active: true, prices: [], delayMs: 20 },
        { id: 'prod_c', role: 'pro', active: true, prices: [monthly('price_c')], delayMs: 20 },
      ],
    });

    await configure({ uid: 'user-1', isAnonymous: false }).service.startProCheckout();

    expect(fake.priceQueries()).toHaveLength(3);
    // The finding itself: sequentially, this would never exceed 1.
    expect(fake.maxConcurrentPriceQueries()).toBe(3);
  });

  it('bounds both queries with a limit', async () => {
    const fake = fakeFirestore({
      products: [{ id: 'prod_a', role: 'pro', active: true, prices: [monthly('price_a')] }],
    });

    await configure({ uid: 'user-1', isAnonymous: false }).service.startProCheckout();

    expect(fake.queries.every((q) => q.limit !== undefined)).toBe(true);
  });

  it('selects on role, the same predicate the server enforces', async () => {
    const fake = fakeFirestore({
      products: [
        { id: 'prod_other', role: 'team', active: true, prices: [monthly('price_team')] },
        { id: 'prod_pro', role: 'pro', active: true, prices: [monthly('price_pro')] },
      ],
    });

    await configure({ uid: 'user-1', isAnonymous: false }).service.startProCheckout();

    expect(fake.queries.find((q) => q.collectionPath === 'products')!.wheres).toContainEqual({
      field: 'role',
      op: 'EQUAL',
      value: 'pro',
    });
    expect(writtenPrice(fake)).toBe('price_pro');
  });

  it('ignores a Pro product that is no longer active', async () => {
    const fake = fakeFirestore({
      products: [
        { id: 'prod_old', role: 'pro', active: false, prices: [monthly('price_old')] },
        { id: 'prod_new', role: 'pro', active: true, prices: [monthly('price_new')] },
      ],
    });

    await configure({ uid: 'user-1', isAnonymous: false }).service.startProCheckout();

    expect(fake.priceQueries()).toHaveLength(1);
    expect(writtenPrice(fake)).toBe('price_new');
  });

  // Parallelism must not make the answer depend on which request came back
  // first — the catalog's own order decides.
  it('picks the first product in catalog order even when it answers last', async () => {
    const fake = fakeFirestore({
      products: [
        {
          id: 'prod_first',
          role: 'pro',
          active: true,
          prices: [monthly('price_first')],
          delayMs: 30,
        },
        { id: 'prod_second', role: 'pro', active: true, prices: [monthly('price_second')] },
      ],
    });

    await configure({ uid: 'user-1', isAnonymous: false }).service.startProCheckout();

    expect(writtenPrice(fake)).toBe('price_first');
  });

  it('only considers monthly prices', async () => {
    const fake = fakeFirestore({
      products: [
        {
          id: 'prod_pro',
          role: 'pro',
          active: true,
          prices: [
            { id: 'price_yearly', active: true, interval: 'year' },
            { id: 'price_monthly', active: true, interval: 'month' },
          ],
        },
      ],
    });

    await configure({ uid: 'user-1', isAnonymous: false }).service.startProCheckout();

    expect(writtenPrice(fake)).toBe('price_monthly');
  });

  it('reports an actionable error when the catalog has no Pro price', async () => {
    fakeFirestore({ products: [{ id: 'prod_pro', role: 'pro', active: true, prices: [] }] });

    await expect(
      configure({ uid: 'user-1', isAnonymous: false }).service.startProCheckout(),
    ).rejects.toThrow(/check the Stripe Dashboard/i);
  });
});

/**
 * The entitlement signal, and the reason it isn't just "has an active
 * subscription".
 *
 * `stripeWebhook` derives the `stripeRole` claim from
 * `deriveClaimRole(status, priceRole)` — no `firebaseRole` metadata on the
 * price means no claim, whatever the subscription's status. `firestore.rules`
 * gates every privileged write on that claim, so a UI signal that stops at
 * `status` is strictly *broader* than the server's, and the gap is a form the
 * user can fill in and can never submit. That was a real production report,
 * not a hypothetical: an active subscription mirrored with `role: null`.
 */
describe('SubscriptionService entitlement signal', () => {
  const user = { uid: 'user-1', isAnonymous: false };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('grants Pro for an active subscription carrying the pro role', async () => {
    fakeFirestore({ subscriptionDocs: [{ status: 'active', role: 'pro' }] });
    const { service } = configure(user);
    await flush();
    expect(service.isProUser()).toBe(true);
  });

  // The regression test. This exact document — active, but on a price with no
  // firebaseRole metadata — unlocked the add-question form while the rules
  // refused every write it produced.
  it('does NOT grant Pro for an active subscription whose role is null', async () => {
    fakeFirestore({ subscriptionDocs: [{ status: 'active', role: null }] });
    const { service } = configure(user);
    await flush();
    expect(service.isProUser()).toBe(false);
  });

  it('does not grant Pro for a role that is not pro', async () => {
    fakeFirestore({ subscriptionDocs: [{ status: 'trialing', role: 'basic' }] });
    const { service } = configure(user);
    await flush();
    expect(service.isProUser()).toBe(false);
  });

  it('grants Pro from a role-carrying doc even alongside a role-less one', async () => {
    fakeFirestore({
      subscriptionDocs: [
        { status: 'active', role: null },
        { status: 'active', role: 'pro' },
      ],
    });
    const { service } = configure(user);
    await flush();
    expect(service.isProUser()).toBe(true);
  });

  // The claim is the authority; the doc signal only ever front-runs it.
  it('still grants Pro from the claim alone when no document has arrived', async () => {
    fakeFirestore();
    const { service } = configure(user, /* hasProClaim */ true);
    await flush();
    expect(service.isProUser()).toBe(true);
  });

  it('grants nothing to an anonymous session, and does not read for one', async () => {
    const fake = fakeFirestore({ subscriptionDocs: [{ status: 'active', role: 'pro' }] });
    const { service } = configure({ uid: 'anon-1', isAnonymous: true });
    await flush();
    expect(service.isProUser()).toBe(false);
    expect(fake.queries).toHaveLength(0);
  });

  it('asks only for the statuses that can be paying, and bounds the read', async () => {
    // The listener this replaced filtered by status but carried no limit,
    // which §4.1 asks for on every read.
    const fake = fakeFirestore({ subscriptionDocs: [] });
    configure(user);
    await flush();

    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0].collectionPath).toBe('customers/user-1/subscriptions');
    expect(fake.queries[0].limit).toBeDefined();
    // The load-bearing assertion, and it was missing. The status list is the
    // ONLY thing keeping this client signal from being broader than the
    // server's gate: `subscriptionMirrorFrom` stores the price's
    // `firebaseRole` on the document whatever the status, so a cancelled
    // subscription is still mirrored with `role: 'pro'`, while
    // `deriveClaimRole` grants the claim only for active/trialing. Widening
    // this list — or dropping the filter, or sending EQUAL instead of IN —
    // unlocks UI the server is bound to refuse, which is finding H6 exactly
    // (`CLAUDE.md` §4.2).
    expect(fake.queries[0].wheres).toEqual([
      { field: 'status', op: 'IN', value: ['trialing', 'active'] },
    ]);
  });

  it('does not grant Pro from a cancelled subscription that still carries the role', async () => {
    // The end-to-end half of the assertion above: the server filters by status,
    // so the document must never come back at all. `role: 'pro'` is deliberate
    // — the mirror keeps the role on a cancelled subscription, so filtering on
    // role alone would grant Pro to someone who has stopped paying.
    fakeFirestore({ subscriptionDocs: [{ status: 'canceled', role: 'pro' }] });
    const { service } = configure(user);
    await flush();
    expect(service.isProUser()).toBe(false);
  });

  it('nudges the ID token to refresh the first time it sees Pro', async () => {
    // The claim is what firestore.rules actually checks, and it is only
    // re-minted on request — so a subscription that has just gone active has
    // to prompt a refresh or the user stays gated for up to an hour.
    fakeFirestore({ subscriptionDocs: [{ status: 'active', role: 'pro' }] });
    const { refreshIdToken } = configure(user);
    await flush();
    expect(refreshIdToken).toHaveBeenCalledTimes(1);
  });

  it('does not nudge a refresh when there is no Pro subscription', async () => {
    fakeFirestore({ subscriptionDocs: [{ status: 'active', role: null }] });
    const { refreshIdToken } = configure(user);
    await flush();
    expect(refreshIdToken).not.toHaveBeenCalled();
  });

  it('survives a failed read without breaking the claim half of the signal', async () => {
    // A read that fails leaves the optimistic half false. It must not throw
    // out of the effect, and it must not stop the claim from granting Pro.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    const { service } = configure(user, /* hasProClaim */ true);
    await flush();
    expect(service.isProUser()).toBe(true);
  });
});

/**
 * The other half of what the subscription listener used to do for free: notice
 * that Pro has arrived. Stripe redirects to `/pricing?checkout=success`, which
 * is a full page load — but our own `stripeWebhook` races that redirect and
 * often loses, so a single read on load would show the user as not-Pro on the
 * very page confirming their payment.
 */
describe('SubscriptionService.awaitProActivation', () => {
  const user = { uid: 'user-1', isAnonymous: false };

  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('keeps asking until the webhook’s subscription document lands', async () => {
    const docs: Record<string, unknown>[] = [];
    const fake = fakeFirestore({ subscriptionDocs: docs });
    const { service } = configure(user);

    const pending = service.awaitProActivation();
    // The webhook lands after a few polls.
    setTimeout(() => docs.push({ status: 'active', role: 'pro' }), 3_500);
    await vi.runAllTimersAsync();
    await pending;

    expect(service.isProUser()).toBe(true);
    expect(fake.queries.length).toBeGreaterThan(1);
  });

  it('does not let a slower earlier read undo a newer one', async () => {
    // Both readers are live on this page at once: the constructor effect's
    // read, and this poll. If the effect's read started first, found nothing
    // (the webhook had not landed), and lands *after* the poll has found Pro,
    // an unordered apply flips Pro back off on the page confirming the
    // payment. `onSnapshot` could not do this — one stream, commit order.
    const fake = fakeFirestore({
      subscriptionQueryPlan: [
        { docs: [], delayMs: 5_000 }, // the effect's read: started first, slow, stale
        { docs: [{ status: 'active', role: 'pro' }] }, // the poll's read: fresh
      ],
    });
    const { service } = configure(user);

    const pending = service.awaitProActivation();
    await vi.runAllTimersAsync();
    await pending;

    expect(fake.queries.length).toBeGreaterThan(1);
    expect(service.isProUser()).toBe(true);
  });

  it('gives up quietly at the deadline rather than throwing at the user', async () => {
    fakeFirestore({ subscriptionDocs: [] });
    const { service } = configure(user);

    const pending = service.awaitProActivation();
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBeUndefined();
    expect(service.isProUser()).toBe(false);
  });
});
