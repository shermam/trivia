import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { AuthService } from './auth.service';
import { FirebaseAppService } from './firebase-app.service';
import { FirestoreRestError } from './firestore-rest/firestore-rest.client';
import { GeoService } from './geo.service';
import { PricingCacheService, READY_CHECKOUT_TTL_MS } from './pricing-cache.service';
import {
  type ProPriceOption,
  SubscriptionError,
  SubscriptionService,
  defaultProCurrency,
  subscriptionFailureMessage,
} from './subscription.service';

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

interface PriceSeed {
  id: string;
  active: boolean;
  interval: string;
  /** Omitted means `usd`; `null` means the document carries no currency at all. */
  currency?: string | null;
  unitAmount?: number | null;
}

interface ProductSeed {
  id: string;
  role: string | null;
  active: boolean;
  prices: PriceSeed[];
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
            prices.map((p) => ({
              id: p.id,
              data: {
                interval: p.interval,
                // Defaults, so a seed that does not care about money still
                // produces the document shape the catalog really holds — the
                // currency is what the service now groups prices by, and a
                // fake that left it out would make every price look alike.
                currency: p.currency === undefined ? 'usd' : p.currency,
                unit_amount: p.unitAmount === undefined ? 99 : p.unitAmount,
              },
            })),
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

/**
 * What the app believes about where the reader is, as a test double.
 *
 * Faked rather than driven through the real `GeoService`, because the two
 * things it reads are the two things a test cannot choose: the machine's own
 * IANA time zone and a `fetch` to an endpoint that does not exist under
 * Vitest. `geo.service.spec.ts` covers the real chain; what these tests are
 * about is what `SubscriptionService` does with its answer.
 *
 * The double keeps the real contract's shape, including the fallback:
 * `resolveCountry()` answers the server's country if there is one and the time
 * zone's otherwise, exactly as the service does. A `Promise` passed as
 * `server` is used as is, which is how a test holds the answer open long
 * enough to click something before it lands.
 */
function geoStub(
  options: {
    timeZone?: string | null;
    server?: string | null | Promise<string | null>;
    /** What a previous visit's stored answer says, if anything. */
    remembered?: string | null;
  } = {},
) {
  const timeZone = options.timeZone ?? null;
  const known = options.remembered ?? timeZone;
  return {
    timeZoneCountry: () => timeZone,
    // The real one is `remembered ?? timeZone` too — a day-old answer about an
    // IP address outranks a clock.
    knownCountry: () => known,
    resolveCountry: () =>
      options.server instanceof Promise ? options.server : Promise.resolve(options.server ?? known),
  };
}

function configure(
  user: unknown,
  hasProClaim = false,
  geo: Pick<GeoService, 'timeZoneCountry' | 'knownCountry' | 'resolveCountry'> = geoStub(),
  options: { fullyAuthenticated?: boolean } = {},
) {
  const refreshIdToken = vi.fn(() => Promise.resolve());
  // Defaults to what the real signal would say for this user — signed in and
  // not anonymous — so only a test about the *unverified* case has to say so.
  // It gates pre-creation, and a stub that always said `true` would let a
  // pre-created session be checked for somebody the server would refuse.
  const isRealUser = Boolean(user) && !(user as { isAnonymous?: boolean })?.isAnonymous;
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
          isFullyAuthenticated: signal(options.fullyAuthenticated ?? isRealUser),
          refreshIdToken,
          getIdToken: () => Promise.resolve('id-token'),
        },
      },
      { provide: GeoService, useValue: geo },
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

/**
 * The catalog, the country and any pre-created session live in browser storage
 * now (`PricingCacheService`), and `TestBed.resetTestingModule()` does not
 * touch it. Without this, the first test to resolve a catalog hands it to
 * every later one as a cache hit and the fake server is never asked at all —
 * which would look like the suite passing.
 */
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  // A no-op idle scheduler, so the once-per-page-load prime does not arm a
  // two-second `setTimeout` fallback in every test that signs somebody in —
  // one that would fire after the test ended, into a `fetch` nobody is faking
  // any more. The block that is *about* the idle prime replaces this with one
  // that runs its callback.
  vi.stubGlobal('requestIdleCallback', () => 0);
});

describe('SubscriptionService session handshake', () => {
  const user = { uid: 'user-1', isAnonymous: false };

  beforeEach(() => {
    // `window.location.assign` is non-configurable in a real browser, but this
    // is jsdom; the redirect itself is covered for real by pricing.spec.ts.
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

    const pending = configure(user).service.openBillingPortal();
    await expect(pending).rejects.toThrow(/Reload the page/);
    // The type is what gets that message onto the screen (`subscriptionFailureMessage`).
    await expect(pending).rejects.toBeInstanceOf(SubscriptionError);
    expect(fake.writes).toHaveLength(0);
  });

  // Only a rules refusal means "try another slot"; anything else is a real
  // failure and burning nine more writes on it would just delay reporting it.
  it('does not retry a failure that is not a permission denial', async () => {
    const fake = fakeFirestore({ failWriteWith: 'server-error' });

    const pending = configure(user).service.openBillingPortal();
    await expect(pending).rejects.toThrow(/INTERNAL/);
    // ...and hands it on as the transport failure it is, not as a cause this
    // service explained — a component shows its generic line for it, not
    // "INTERNAL".
    await expect(pending).rejects.not.toBeInstanceOf(SubscriptionError);
    expect(fake.writes).toHaveLength(0);
  });

  it('surfaces the error the Cloud Function writes back', async () => {
    fakeFirestore({ writeBack: { error: { message: 'Could not start checkout.' } } });

    const pending = configure(user).service.openBillingPortal();
    await expect(pending).rejects.toThrow('Could not start checkout.');
    // The function wrote that message for the screen (`clientMessageFor`).
    await expect(pending).rejects.toBeInstanceOf(SubscriptionError);
  });

  it('refuses an anonymous caller before writing anything', async () => {
    const fake = fakeFirestore();
    const { service } = configure({ uid: 'anon-1', isAnonymous: true });

    await expect(service.openBillingPortal()).rejects.toThrow('Sign in before managing');
    await expect(service.startProCheckout()).rejects.toThrow('Sign in before subscribing');
    await expect(service.startProCheckout()).rejects.toBeInstanceOf(SubscriptionError);
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
    // A deadline reached with every read answering is a cause this service
    // has verified, so the timeout reaches the screen in those words.
    const explained = expect(pending).rejects.toBeInstanceOf(SubscriptionError);
    await vi.runAllTimersAsync();
    await assertion;
    await explained;
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
    // ...as the transport's own error, whose cause nobody verified — so the
    // component shows its generic line rather than a raw status.
    const unexplained = expect(pending).rejects.toBeInstanceOf(FirestoreRestError);
    await vi.runAllTimersAsync();
    await assertion;
    await unexplained;
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
 * Finding C5. `getProPrices()` read the product catalog and then awaited each
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
  const monthly = (
    id: string,
    currency?: string | null,
    unitAmount?: number | null,
  ): PriceSeed => ({
    id,
    active: true,
    interval: 'month',
    currency,
    unitAmount,
  });

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

  // What an environment looks like before its Stripe webhook has delivered a
  // single catalog event (`dev-environment.md` §3.1 steps 8–9). The message
  // has to say Pro is not on sale, in words meant for the screen: "please try
  // again" is wrong here, since nothing the user does can populate the catalog.
  it('explains an empty catalog as Pro not being on sale', async () => {
    fakeFirestore({ products: [{ id: 'prod_pro', role: 'pro', active: true, prices: [] }] });

    const pending = configure({ uid: 'user-1', isAnonymous: false }).service.startProCheckout();

    await expect(pending).rejects.toBeInstanceOf(SubscriptionError);
    await expect(pending).rejects.toThrow(/no active monthly Pro price/i);
  });
});

/**
 * Which currency the reader is quoted, and therefore which Stripe Price ID
 * checkout is started against.
 *
 * This is the whole feature, and the reason it is not cosmetic: a
 * Brazilian-issued card cannot be charged in USD by a Brazilian Stripe
 * account, and Adaptive Pricing does not help because it localises only for
 * buyers *outside* the merchant's country. So a BR visitor landing on the USD
 * price does not see a slightly odd number — they see a declined card. The
 * default has to be right before anybody clicks anything.
 */
describe('SubscriptionService currency selection', () => {
  const user = { uid: 'user-1', isAnonymous: false };
  const monthly = (
    id: string,
    currency?: string | null,
    unitAmount?: number | null,
  ): PriceSeed => ({
    id,
    active: true,
    interval: 'month',
    currency,
    unitAmount,
  });
  const bothCurrencies = [
    {
      id: 'prod_pro',
      role: 'pro',
      active: true,
      prices: [monthly('price_usd', 'usd', 99), monthly('price_brl', 'brl', 590)],
    },
  ];

  /**
   * Points the fake at a different catalog part-way through a test.
   *
   * `fakeFirestore` stubs `fetch`, so a second catalog needs the first stub
   * out of the way — and `location`, stubbed by `beforeEach`, goes with it and
   * has to be put back. The `GeoService` double is a provider rather than a
   * global, so it deliberately survives: which currencies are on sale is the
   * variable here, and where the reader is is not.
   */
  function recatalog(products: ProductSeed[]) {
    vi.unstubAllGlobals();
    vi.stubGlobal('location', { origin: 'https://example.web.app', assign: vi.fn() });
    return fakeFirestore({ products });
  }

  beforeEach(() => {
    vi.stubGlobal('location', { origin: 'https://example.web.app', assign: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('offers one price per currency, in catalog order', async () => {
    fakeFirestore({ products: bothCurrencies });
    const { service } = configure(user);

    await service.loadProPrices();

    expect(service.proPriceOptions()).toEqual([
      { priceId: 'price_usd', currency: 'usd', unitAmount: 99 },
      { priceId: 'price_brl', currency: 'brl', unitAmount: 590 },
    ]);
  });

  // Two monthly prices in the same currency is a Dashboard mistake rather than
  // a choice, and offering both would put two identical-looking options in
  // front of the reader.
  it('keeps only the first price in each currency', async () => {
    fakeFirestore({
      products: [
        {
          id: 'prod_pro',
          role: 'pro',
          active: true,
          prices: [monthly('price_usd_old', 'usd', 99), monthly('price_usd_new', 'usd', 149)],
        },
      ],
    });
    const { service } = configure(user);

    await service.loadProPrices();

    expect(service.proPriceOptions().map((o) => o.priceId)).toEqual(['price_usd_old']);
  });

  // A price with no currency cannot be quoted in one, and showing it as an
  // unnamed option would be worse than not showing it.
  it('drops a price the catalog carries no currency for', async () => {
    fakeFirestore({
      products: [
        {
          id: 'prod_pro',
          role: 'pro',
          active: true,
          prices: [monthly('price_broken', null), monthly('price_usd', 'usd', 99)],
        },
      ],
    });
    const { service } = configure(user);

    await service.loadProPrices();

    expect(service.proPriceOptions().map((o) => o.priceId)).toEqual(['price_usd']);
  });

  it('opens on BRL for a visitor the server places in Brazil, when BRL is on sale', async () => {
    fakeFirestore({ products: bothCurrencies });
    const { service } = configure(user, false, geoStub({ server: 'BR' }));

    await service.loadProPrices();

    expect(service.selectedCurrency()).toBe('brl');
    expect(service.selectedProPrice()).toEqual({
      priceId: 'price_brl',
      currency: 'brl',
      unitAmount: 590,
    });
  });

  it('opens on USD for everybody else', async () => {
    fakeFirestore({ products: bothCurrencies });
    const { service } = configure(user, false, geoStub({ server: 'US' }));

    await service.loadProPrices();

    expect(service.selectedCurrency()).toBe('usd');
  });

  /**
   * The time zone answers while the server is still being asked, so a
   * Brazilian machine is quoted in reais from the first frame the control
   * exists rather than a beat later. Held apart from the server case because
   * this is the path that runs on `ng serve` and on a preview channel, where
   * the endpoint does not exist at all.
   */
  it('opens on BRL from the browser’s time zone before the server has answered', async () => {
    fakeFirestore({ products: bothCurrencies });
    // Deliberately never settled: the claim is about what the page shows while
    // the server is still being waited on.
    const neverAnswers = new Promise<string | null>(() => undefined);
    const { service } = configure(user, false, geoStub({ timeZone: 'BR', server: neverAnswers }));

    void service.loadProPrices();
    await flush();

    expect(service.selectedCurrency()).toBe('brl');
  });

  /**
   * The server outranks the time zone, and the difference is not academic: a
   * laptop still set to São Paulo in a New York hotel is a Brazilian *clock*
   * and an American *card*, and the address is the half that decides whether
   * the charge goes through.
   */
  it('lets the server’s country overrule the time zone when they disagree', async () => {
    fakeFirestore({ products: bothCurrencies });
    const { service } = configure(user, false, geoStub({ timeZone: 'BR', server: 'US' }));

    await service.loadProPrices();

    expect(service.selectedCurrency()).toBe('usd');
  });

  /**
   * The one ordering that can undo a real gesture. The reader sees the control
   * as soon as the catalog lands, which is up to two seconds before the server
   * says where they are — so a click in that window must survive the answer.
   */
  it('keeps a currency chosen before the server answers', async () => {
    fakeFirestore({ products: bothCurrencies });
    let answerServer!: (country: string | null) => void;
    const server = new Promise<string | null>((resolve) => {
      answerServer = resolve;
    });
    const { service } = configure(user, false, geoStub({ server }));

    const loading = service.loadProPrices();
    await flush();
    expect(service.selectedCurrency()).toBe('usd');

    service.selectCurrency('brl');
    answerServer('US');
    await loading;

    expect(service.selectedCurrency()).toBe('brl');
  });

  // The other half of that: with no gesture to respect, a late answer is
  // exactly what the reader wants applied.
  it('moves an unchosen selection when the server answers late', async () => {
    fakeFirestore({ products: bothCurrencies });
    let answerServer!: (country: string | null) => void;
    const server = new Promise<string | null>((resolve) => {
      answerServer = resolve;
    });
    const { service } = configure(user, false, geoStub({ server }));

    const loading = service.loadProPrices();
    await flush();
    expect(service.selectedCurrency()).toBe('usd');

    answerServer('BR');
    await loading;

    expect(service.selectedCurrency()).toBe('brl');
  });

  // The catalog decides what exists. A Brazilian visitor with no BRL price on
  // sale gets the USD one rather than a currency that isn't there.
  it('falls back to what is on sale when the reader’s currency is not', async () => {
    fakeFirestore({
      products: [{ id: 'prod_pro', role: 'pro', active: true, prices: [monthly('price_usd')] }],
    });
    const { service } = configure(user, false, geoStub({ server: 'BR' }));

    await service.loadProPrices();

    expect(service.selectedCurrency()).toBe('usd');
    expect(service.proPriceOptions()).toHaveLength(1);
  });

  it('checks out against the price of the currency the reader picked', async () => {
    const fake = fakeFirestore({ products: bothCurrencies });
    const { service } = configure(user);
    await service.loadProPrices();

    service.selectCurrency('brl');
    await service.startProCheckout();

    expect(fake.writes.at(-1)!.data['price']).toBe('price_brl');
  });

  // The selection decides which price ID checkout uses, so a currency with no
  // price behind it would be a Subscribe button that cannot work.
  it('ignores a currency the catalog does not offer', async () => {
    fakeFirestore({ products: bothCurrencies });
    const { service } = configure(user);
    await service.loadProPrices();

    service.selectCurrency('eur');

    expect(service.selectedCurrency()).toBe('usd');
  });

  /**
   * A refused selection is not a choice, so it must not freeze the default
   * either — otherwise a stray `selectCurrency('eur')` would leave the reader
   * on USD for the rest of the page load even once the server said Brazil.
   */
  it('does not treat a refused selection as the reader having chosen', async () => {
    fakeFirestore({ products: bothCurrencies });
    let answerServer!: (country: string | null) => void;
    const server = new Promise<string | null>((resolve) => {
      answerServer = resolve;
    });
    const { service } = configure(user, false, geoStub({ server }));

    const loading = service.loadProPrices();
    await flush();
    service.selectCurrency('eur');
    answerServer('BR');
    await loading;

    expect(service.selectedCurrency()).toBe('brl');
  });

  /**
   * What `loadProPrices()` promises is not "a selection exists" but "the
   * selection is one of the currencies the catalog offers", and the two come
   * apart when a currency is withdrawn under a reader who had chosen it:
   * every radio asks whether it *is* the selection, so none of them would be
   * checked, while `selectedProPrice` falls back to the first price — a card
   * quoting an amount no control claims.
   *
   * **The memo is dropped by hand, because nothing else can drop it.** A
   * successful lookup is memoised for the service's lifetime and only a
   * *rejected* one clears the cache, so no sequence of public calls reads the
   * catalog twice — which is exactly why no reader can walk into this today.
   * The guard is here so the invariant survives the memo changing (a refresh,
   * a TTL, a second service instance), and a test that could only be written
   * after that change would be a test written too late.
   */
  it('re-defaults a selection the catalog has stopped offering', async () => {
    fakeFirestore({ products: bothCurrencies });
    const { service } = configure(user);
    await service.loadProPrices();
    service.selectCurrency('brl');
    expect(service.selectedCurrency()).toBe('brl');

    (service as unknown as { proPricesPromise: unknown }).proPricesPromise = null;
    recatalog([{ id: 'prod_pro', role: 'pro', active: true, prices: [monthly('price_usd')] }]);
    await service.loadProPrices();

    expect(service.selectedCurrency()).toBe('usd');
    expect(service.selectedProPrice()?.currency).toBe('usd');
  });

  // The page shows a placeholder and the Subscribe click reports the cause;
  // what must not happen is the load rejecting into nothing and taking the
  // page's own bootstrap with it.
  it('leaves the page priceless rather than throwing when the catalog cannot be read', async () => {
    fakeFirestore({ products: [] });
    const { service } = configure(user);

    await expect(service.loadProPrices()).resolves.toBeUndefined();

    expect(service.proPriceOptions()).toEqual([]);
    expect(service.selectedProPrice()).toBeNull();
  });

  // `CLAUDE.md` §4.4: a memoised promise that is never cleared on rejection
  // turns one failed read into a permanently priceless page.
  it('retries a failed catalog read rather than replaying the failure', async () => {
    const first = fakeFirestore({ products: [] });
    const { service } = configure(user);
    await service.loadProPrices();
    expect(first.queries.filter((q) => q.collectionPath === 'products')).toHaveLength(1);

    const second = recatalog(bothCurrencies);
    await service.loadProPrices();

    expect(second.queries.filter((q) => q.collectionPath === 'products')).toHaveLength(1);
    expect(service.proPriceOptions()).toHaveLength(2);
  });
});

/**
 * The country → currency rule on its own, away from Firestore and away from
 * however the country was arrived at.
 *
 * Exported and tested directly because the Brazilian case is the point of the
 * feature: it decides whether a real card is accepted or declined, and it must
 * not depend on anything about the machine running the suite.
 */
describe('defaultProCurrency', () => {
  const option = (currency: string): ProPriceOption => ({
    priceId: `price_${currency}`,
    currency,
    unitAmount: 100,
  });
  const both = [option('usd'), option('brl')];

  it('sends a Brazilian visitor to the Brazilian price', () => {
    expect(defaultProCurrency(both, 'BR')).toBe('brl');
  });

  // The code is normalised on the way in by both producers, but this function
  // is exported and the rule is about the country rather than its spelling.
  it('matches the country code case-insensitively', () => {
    expect(defaultProCurrency(both, 'br')).toBe('brl');
  });

  it('quotes everybody else in the default currency', () => {
    expect(defaultProCurrency(both, 'PT')).toBe('usd');
    expect(defaultProCurrency(both, 'US')).toBe('usd');
  });

  /**
   * The three ways a country can be missing — never asked, could not be told,
   * or a reader somewhere the app prices normally — all have to land on the
   * same answer, because the page cannot tell them apart and neither can the
   * reader.
   */
  it('quotes the default currency when the country is unknown', () => {
    expect(defaultProCurrency(both, null)).toBe('usd');
  });

  // The catalog decides what exists: a mapping to a currency nothing is priced
  // in would leave the Subscribe button quoting a price that is not for sale.
  it('ignores the country’s currency when the catalog does not carry it', () => {
    expect(defaultProCurrency([option('usd')], 'BR')).toBe('usd');
  });

  it('falls back to the catalog’s first currency when neither rule matches', () => {
    expect(defaultProCurrency([option('gbp'), option('eur')], 'GB')).toBe('gbp');
  });

  it('has nothing to select from an empty catalog', () => {
    expect(defaultProCurrency([], 'BR')).toBeNull();
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

/**
 * The client half of `clientMessageFor` (`functions/src/checkout-request.ts`):
 * what a component shows for a rejection, decided by the error's type rather
 * than by reading its message.
 */
describe('subscriptionFailureMessage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the message the service wrote for the screen, and logs nothing', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const message = subscriptionFailureMessage(
      new SubscriptionError('Sign in before subscribing.'),
      'Could not start checkout. Please try again.',
    );

    expect(message).toBe('Sign in before subscribing.');
    expect(consoleError).not.toHaveBeenCalled();
  });

  // A `FirestoreRestError` message is Google's canonical status or a raw HTTP
  // line — true, but not a story a user can act on, and picking one to tell
  // would be narrating a cause nobody verified (`CLAUDE.md` §4.4).
  it('stays generic for a transport failure and keeps its real cause in the console', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new FirestoreRestError('UNAVAILABLE', 0, 'Failed to fetch');

    const message = subscriptionFailureMessage(
      error,
      'Could not start checkout. Please try again.',
    );

    expect(message).toBe('Could not start checkout. Please try again.');
    expect(consoleError).toHaveBeenCalledWith(expect.any(String), error);
  });

  it('stays generic for a rejection that is not an Error at all', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(subscriptionFailureMessage('boom', 'generic')).toBe('generic');
  });
});

/**
 * The pricing page's first frame, and what the network answer is allowed to do
 * to it afterwards.
 *
 * Two things were measured on production and neither gets faster by being
 * asked nicely: the currency takes a visible moment to settle (a geo round
 * trip plus two Firestore reads), and Subscribe sits on "Redirecting…" for
 * seconds. This half fixes the first — the page renders from what this browser
 * already knows and revalidates behind it.
 *
 * The assertions are deliberately about *when*: `loadProPrices()` is called
 * and not awaited, because the whole claim is that there is something to
 * render before it resolves.
 */
describe('SubscriptionService cache-first pricing', () => {
  const user = { uid: 'user-1', isAnonymous: false };
  const usd = { priceId: 'price_usd', currency: 'usd', unitAmount: 99 };
  const brl = { priceId: 'price_brl', currency: 'brl', unitAmount: 590 };

  const priced = (id: string, currency: string, unitAmount: number): PriceSeed => ({
    id,
    active: true,
    interval: 'month',
    currency,
    unitAmount,
  });

  const catalog = (...prices: PriceSeed[]): ProductSeed[] => [
    { id: 'prod_pro', role: 'pro', active: true, prices },
  ];

  const cache = () => TestBed.inject(PricingCacheService);

  beforeEach(() => {
    vi.stubGlobal('location', { origin: 'https://example.web.app', assign: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('renders the last visit’s catalog before the network has answered', async () => {
    fakeFirestore({ products: catalog(priced('price_usd', 'usd', 99)) });
    const { service } = configure(user);
    cache().writeCatalog([usd, brl]);

    const loading = service.loadProPrices();

    expect(service.proPriceOptions()).toEqual([usd, brl]);
    expect(service.selectedProPrice()).toEqual(usd);
    await loading;
  });

  // The country is the slow half — two seconds of `AbortSignal` budget — so a
  // returning Brazilian reader opening on BRL is the case this is for.
  it('opens on the country the server last named, with no request', async () => {
    fakeFirestore({ products: catalog(priced('price_usd', 'usd', 99)) });
    const { service } = configure(user, false, geoStub({ remembered: 'BR' }));
    cache().writeCatalog([usd, brl]);

    const loading = service.loadProPrices();

    expect(service.selectedCurrency()).toBe('brl');
    await loading;
  });

  it('has nothing to render without a cache, exactly as before', async () => {
    fakeFirestore({ products: catalog(priced('price_usd', 'usd', 99)) });
    const { service } = configure(user);

    const loading = service.loadProPrices();

    expect(service.proPriceOptions()).toEqual([]);
    await loading;
    expect(service.proPriceOptions()).toHaveLength(1);
  });

  it('corrects a cached amount the Dashboard has since changed', async () => {
    fakeFirestore({ products: catalog(priced('price_usd', 'usd', 199)) });
    const { service } = configure(user);
    cache().writeCatalog([usd]);

    const loading = service.loadProPrices();
    expect(service.selectedProPrice()?.unitAmount).toBe(99);

    await loading;
    expect(service.selectedProPrice()?.unitAmount).toBe(199);
  });

  /**
   * Identity, not equality, and that is the point: a signal set to a freshly
   * built array with identical contents is still a change, and re-publishing
   * re-runs the default-currency rule — which would move a radio the reader is
   * looking at for no reason at all.
   */
  it('leaves the rendered catalog untouched when the revalidation agrees', async () => {
    fakeFirestore({ products: catalog(priced('price_usd', 'usd', 99)) });
    const { service } = configure(user);
    cache().writeCatalog([usd]);

    const loading = service.loadProPrices();
    const rendered = service.proPriceOptions();
    await loading;

    expect(service.proPriceOptions()).toBe(rendered);
  });

  /**
   * The rule that already governed the late server answer, now with one more
   * way to reach it: the reader can click during the window between a cached
   * render and the revalidation, and a default landing after that click would
   * silently undo the one gesture the control exists for.
   */
  it('never overrides a currency the reader chose against the cached render', async () => {
    fakeFirestore({
      products: catalog(priced('price_usd', 'usd', 99), priced('price_brl', 'brl', 590)),
    });
    const { service } = configure(user, false, geoStub({ remembered: 'BR', server: 'BR' }));
    cache().writeCatalog([usd, brl]);

    const loading = service.loadProPrices();
    expect(service.selectedCurrency()).toBe('brl');

    service.selectCurrency('usd');
    await loading;

    expect(service.selectedCurrency()).toBe('usd');
  });

  it('writes what it resolved back for the next page load', async () => {
    fakeFirestore({ products: catalog(priced('price_usd', 'usd', 99)) });
    const { service } = configure(user);

    await service.loadProPrices();

    expect(cache().readCatalog()).toEqual([usd]);
  });

  /**
   * A cache is useless for a first visit, so the read has to happen before the
   * reader gets there. Hover and focus on any link to `/pricing` call this,
   * and so does one idle callback per page load for somebody who could buy.
   */
  describe('priming on intent', () => {
    it('resolves the catalog without rendering anything', async () => {
      const fake = fakeFirestore({ products: catalog(priced('price_usd', 'usd', 99)) });
      const { service } = configure(user);

      service.primePricing();
      await flush();

      expect(fake.priceQueries()).toHaveLength(1);
      expect(service.proPriceOptions()).toEqual([]);
      expect(cache().readCatalog()).toEqual([usd]);
    });

    it('makes the visit itself cost no read at all', async () => {
      const fake = fakeFirestore({ products: catalog(priced('price_usd', 'usd', 99)) });
      const { service } = configure(user);

      service.primePricing();
      await flush();
      await service.loadProPrices();

      expect(fake.priceQueries()).toHaveLength(1);
      expect(service.selectedProPrice()).toEqual(usd);
    });
  });

  /**
   * Who the idle prime runs for, which is the whole of its cost argument: two
   * public reads and one geo request, spent only on readers who can actually
   * buy something. An anonymous visitor is most of the traffic and none of the
   * buyers, and a subscriber has nothing left to buy.
   */
  describe('priming when the browser goes idle', () => {
    const idleRunner = () => {
      const idle = vi.fn((callback: () => void) => callback());
      vi.stubGlobal('requestIdleCallback', idle);
      return idle;
    };

    it('warms the cache once the read confirms the reader is not Pro', async () => {
      const idle = idleRunner();
      const fake = fakeFirestore({
        products: catalog(priced('price_usd', 'usd', 99)),
        subscriptionDocs: [],
      });
      configure(user);
      await flush();

      expect(idle).toHaveBeenCalledTimes(1);
      expect(fake.priceQueries()).toHaveLength(1);
    });

    it('spends nothing on a subscriber', async () => {
      const idle = idleRunner();
      const fake = fakeFirestore({
        products: catalog(priced('price_usd', 'usd', 99)),
        subscriptionDocs: [{ status: 'active', role: 'pro' }],
      });
      configure(user);
      await flush();

      expect(idle).not.toHaveBeenCalled();
      expect(fake.priceQueries()).toHaveLength(0);
    });

    // The read cost the service comment refuses to pay: most visitors never go
    // near the pricing page, and none of them can check out.
    it('never runs for an anonymous visitor', async () => {
      const idle = idleRunner();
      const fake = fakeFirestore({ products: catalog(priced('price_usd', 'usd', 99)) });
      configure({ uid: 'anon-1', isAnonymous: true });
      await flush();

      expect(idle).not.toHaveBeenCalled();
      expect(fake.priceQueries()).toHaveLength(0);
    });
  });
});

/**
 * Subscribe, when the session already exists.
 *
 * The seconds that click used to spend were an Eventarc delivery, a cold start
 * of `createCheckoutSession`, Stripe's own customer and session creation, and
 * a 500 ms poll on top — none of which get faster, and all of which can happen
 * while the reader is still reading the card. What has to be true is that the
 * saved URL is only ever used for the account and the price it was created
 * for, and that nothing creates two sessions where one would do: each one
 * expires the customer's previous open session server-side, so a second is not
 * merely wasteful, it invalidates the first.
 */
describe('SubscriptionService pre-created checkout', () => {
  const user = { uid: 'user-1', isAnonymous: false };

  const priced = (id: string, currency: string): PriceSeed => ({
    id,
    active: true,
    interval: 'month',
    currency,
    unitAmount: 99,
  });

  const catalog = (...prices: PriceSeed[]): ProductSeed[] => [
    { id: 'prod_pro', role: 'pro', active: true, prices },
  ];

  const bothCurrencies = catalog(priced('price_usd', 'usd'), priced('price_brl', 'brl'));

  let assign = vi.fn();
  const redirectedTo = () => assign.mock.calls.at(-1)?.[0];

  beforeEach(() => {
    assign = vi.fn();
    vi.stubGlobal('location', { origin: 'https://example.web.app', assign });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('redirects on the click without writing a second session document', async () => {
    const fake = fakeFirestore({ products: catalog(priced('price_usd', 'usd')) });
    const { service } = configure(user);
    await service.loadProPrices();

    await service.prepareCheckout();
    expect(fake.writes).toHaveLength(1);

    await service.startProCheckout();

    expect(fake.writes).toHaveLength(1);
    expect(redirectedTo()).toBe('https://stripe.test/s');
  });

  /**
   * The deduplication case: the reader clicks while the background handshake
   * is still in flight. Starting a second one would spend another slot of the
   * `firestore.rules` volume cap *and* expire the session the first is about
   * to hand back — so the click has to join the promise that already exists.
   *
   * Real timers, and the poll's own 500 ms interval is what holds the window
   * open. Faking them here would fake the thing being waited on.
   */
  it('joins a handshake already in flight rather than starting a second', async () => {
    const fake = fakeFirestore({
      products: catalog(priced('price_usd', 'usd')),
      writeBackAfterReads: 2,
    });
    const { service } = configure(user);
    await service.loadProPrices();

    const prepared = service.prepareCheckout();
    // The write has landed and the first read has answered "still working" —
    // which is the window a real click lands in.
    await flush();
    expect(fake.writes).toHaveLength(1);

    const clicked = service.startProCheckout();
    await Promise.all([prepared, clicked]);

    expect(fake.writes).toHaveLength(1);
    expect(redirectedTo()).toBe('https://stripe.test/s');
  });

  it('does not pre-create anything for an anonymous visitor', async () => {
    const fake = fakeFirestore({ products: catalog(priced('price_usd', 'usd')) });
    const { service } = configure({ uid: 'anon-1', isAnonymous: true });
    await service.loadProPrices();

    await service.prepareCheckout();

    expect(fake.writes).toHaveLength(0);
  });

  // An unverified account has a refusal waiting on the click; pre-creating for
  // it would spend a Stripe session on a checkout that cannot happen.
  it('does not pre-create for an account that has not verified its email', async () => {
    const fake = fakeFirestore({ products: catalog(priced('price_usd', 'usd')) });
    const { service } = configure(user, false, geoStub(), { fullyAuthenticated: false });
    await service.loadProPrices();

    await service.prepareCheckout();

    expect(fake.writes).toHaveLength(0);
  });

  it('does not pre-create for somebody who is already subscribed', async () => {
    const fake = fakeFirestore({
      products: catalog(priced('price_usd', 'usd')),
      subscriptionDocs: [{ status: 'active', role: 'pro' }],
    });
    const { service } = configure(user);
    await service.loadProPrices();
    await flush();

    await service.prepareCheckout();

    expect(fake.writes).toHaveLength(0);
  });

  it('does nothing twice for the same price', async () => {
    const fake = fakeFirestore({ products: catalog(priced('price_usd', 'usd')) });
    const { service } = configure(user);
    await service.loadProPrices();

    await service.prepareCheckout();
    await service.prepareCheckout();

    expect(fake.writes).toHaveLength(1);
  });

  /**
   * **Never two at once**, and this is the sharp edge of the whole feature.
   *
   * `createCheckoutSession` expires the customer's open sessions before
   * creating its own, so two concurrent invocations race: whichever create
   * lands second kills the session the first is about to hand back, and
   * nothing on the client can tell. A currency change while a pre-creation was
   * in flight is exactly how that happened — the guard used to be keyed on the
   * price, so a *different* price started a second handshake.
   */
  it('starts no second handshake while one is in flight, and covers the new currency after', async () => {
    const fake = fakeFirestore({ products: bothCurrencies, writeBackAfterReads: 1 });
    const { service } = configure(user);
    await service.loadProPrices();

    const inFlight = service.prepareCheckout();
    await flush();
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].data['price']).toBe('price_usd');

    // The reader switches currency while the first handshake is still running.
    service.selectCurrency('brl');
    await service.prepareCheckout();
    expect(fake.writes, 'a second concurrent handshake').toHaveLength(1);

    // …and the currency they actually chose is not simply abandoned: the one
    // retry fires when the slot is free, so the click still finds a session.
    await inFlight;
    await vi.waitFor(() => expect(fake.writes).toHaveLength(2), { timeout: 5_000, interval: 20 });
    expect(fake.writes.at(-1)?.data['price']).toBe('price_brl');
  });

  /**
   * Another tab on the same device is the second way two sessions collide, and
   * the one no amount of care inside this service can see: the entry therefore
   * lives in `localStorage` and is re-read on every use, so the tab that
   * clicks uses whatever is live *now* rather than what it remembered.
   */
  describe('when another tab has been on the same page', () => {
    it('redirects to the session that tab left, not the one this tab remembered', async () => {
      const fake = fakeFirestore({ products: catalog(priced('price_usd', 'usd')) });
      const { service } = configure(user);
      await service.loadProPrices();
      await service.prepareCheckout();

      // The other tab pre-created for itself. Its create expired the session
      // this tab was holding; the entry it left behind is the live one.
      localStorage.setItem(
        'trivia-checkout-ready',
        JSON.stringify({
          uid: user.uid,
          priceId: 'price_usd',
          url: 'https://stripe.test/from-the-other-tab',
          readyAt: Date.now(),
        }),
      );

      await service.startProCheckout();

      expect(fake.writes).toHaveLength(1);
      expect(redirectedTo()).toBe('https://stripe.test/from-the-other-tab');
    });

    it('creates a fresh session when that tab has taken the waiting one away', async () => {
      const fake = fakeFirestore({ products: catalog(priced('price_usd', 'usd')) });
      const { service } = configure(user);
      await service.loadProPrices();
      await service.prepareCheckout();

      // The other tab started a handshake of its own, which clears the entry
      // before its create expires everything open.
      localStorage.removeItem('trivia-checkout-ready');

      await service.startProCheckout();

      expect(fake.writes).toHaveLength(2);
      expect(redirectedTo()).toBe('https://stripe.test/s');
    });
  });

  /**
   * A session nobody can find again is a Stripe session and a slot of the
   * volume cap spent for nothing. A browser that refuses to store the entry
   * (a private window, a quota refusal) gets the pre-pre-creation behaviour:
   * the click creates its own.
   */
  it('stops pre-creating once it learns the entry cannot be stored', async () => {
    const fake = fakeFirestore({ products: bothCurrencies });
    const { service } = configure(user);
    await service.loadProPrices();
    // Mocked after the catalog is cached, so this is about the checkout entry.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });

    await service.prepareCheckout();
    expect(fake.writes).toHaveLength(1);

    service.selectCurrency('brl');
    await service.prepareCheckout();

    expect(fake.writes).toHaveLength(1);
  });

  /**
   * Changing currency is the one gesture that genuinely invalidates a waiting
   * session: it is a different Stripe Price, and creating the new session
   * expires the old one. Switching *back* therefore cannot reuse the first
   * URL — it points at a session Stripe has already closed.
   */
  describe('when the reader changes currency', () => {
    it('checks out against the new price, not the waiting one', async () => {
      const fake = fakeFirestore({ products: bothCurrencies });
      const { service } = configure(user);
      await service.loadProPrices();
      await service.prepareCheckout();

      service.selectCurrency('brl');
      await service.prepareCheckout();
      expect(fake.writes).toHaveLength(2);

      await service.startProCheckout();

      expect(fake.writes).toHaveLength(2);
      expect(fake.writes.at(-1)?.data['price']).toBe('price_brl');
    });

    it('never reuses a session the newer one has expired', async () => {
      const fake = fakeFirestore({ products: bothCurrencies });
      const { service } = configure(user);
      await service.loadProPrices();
      await service.prepareCheckout();

      service.selectCurrency('brl');
      await service.prepareCheckout();
      service.selectCurrency('usd');

      await service.startProCheckout();

      // A third document: the first USD session died when the BRL one was
      // created, and handing the reader its URL would land them on an expired
      // Stripe page.
      expect(fake.writes).toHaveLength(3);
      expect(fake.writes.at(-1)?.data['price']).toBe('price_usd');
    });

    /**
     * The same gesture, but during a *click* rather than a pre-creation — and
     * here the follow-up that is right for pre-creation is catastrophic.
     *
     * `startProCheckout` shares `beginCheckoutHandshake`, and a retry attached
     * to that handshake runs before the caller's own `await` resumes: it
     * dispatches a second `createCheckoutSession` while the tab is still on
     * its way to `location.assign`, and that create expires the session being
     * navigated to. The reader lands on Stripe's "this session has expired"
     * page having done nothing but flick a switch. So the retry belongs to
     * `prepareCheckout`, after its `await`, and this pins it: one document,
     * and the redirect goes to it.
     *
     * Mutation-checked by moving the retry back into the handshake's success
     * handler, which writes `['price_usd', 'price_brl']` and fails here.
     */
    it('spends no second session when the currency changes during the click', async () => {
      const fake = fakeFirestore({ products: bothCurrencies, writeBackAfterReads: 1 });
      const { service } = configure(user);
      await service.loadProPrices();

      // Nothing waiting — this click runs the handshake itself, which is the
      // state a reader who never idled on the page is in.
      const clicked = service.startProCheckout();
      await flush();
      expect(fake.writes).toHaveLength(1);
      expect(fake.writes[0].data['price']).toBe('price_usd');

      // The switch, while the button still says "Redirecting…".
      service.selectCurrency('brl');
      await clicked;
      // Several turns, so a stray retry has every chance to land its write
      // before the assertion rather than after the test.
      await flush();

      expect(fake.writes.map((write) => write.data['price'])).toEqual(['price_usd']);
      expect(redirectedTo()).toBe('https://stripe.test/s');
    });

    /**
     * Three, out of the ten sessions per five minutes `firestore.rules`
     * allows. Pre-creation happens without anybody asking for it, so left
     * unbounded a reader flicking the switch while they decide would exhaust
     * the cap and then be refused the checkout they finally wanted.
     */
    it('stops pre-creating once this window’s allowance is spent', async () => {
      const fake = fakeFirestore({ products: bothCurrencies });
      const { service } = configure(user);
      await service.loadProPrices();

      for (const currency of ['usd', 'brl', 'usd', 'brl', 'usd']) {
        service.selectCurrency(currency);
        await service.prepareCheckout();
      }

      expect(fake.writes).toHaveLength(3);
    });

    // …and running out is invisible, because the click falls back to the path
    // it took before any of this existed.
    it('still lets the click create its own session after that', async () => {
      const fake = fakeFirestore({ products: bothCurrencies });
      const { service } = configure(user);
      await service.loadProPrices();

      for (const currency of ['usd', 'brl', 'usd', 'brl']) {
        service.selectCurrency(currency);
        await service.prepareCheckout();
      }
      await service.startProCheckout();

      expect(fake.writes).toHaveLength(4);
      expect(redirectedTo()).toBe('https://stripe.test/s');
    });
  });

  /**
   * A reload is the commonest thing a reader does on a page they are thinking
   * about, and without this each one would spend another of the ten sessions
   * the volume cap allows — five refreshes and checkout starts failing.
   */
  describe('across a reload', () => {
    const reload = () => {
      TestBed.resetTestingModule();
      return configure(user).service;
    };

    it('reuses the session the previous page load created', async () => {
      const fake = fakeFirestore({ products: catalog(priced('price_usd', 'usd')) });
      const first = configure(user).service;
      await first.loadProPrices();
      await first.prepareCheckout();
      expect(fake.writes).toHaveLength(1);

      const reloaded = reload();
      await reloaded.loadProPrices();
      await reloaded.startProCheckout();

      expect(fake.writes).toHaveLength(1);
      expect(redirectedTo()).toBe('https://stripe.test/s');
    });

    it('does not pre-create a second one either', async () => {
      const fake = fakeFirestore({ products: catalog(priced('price_usd', 'usd')) });
      const first = configure(user).service;
      await first.loadProPrices();
      await first.prepareCheckout();

      const reloaded = reload();
      await reloaded.loadProPrices();
      await reloaded.prepareCheckout();

      expect(fake.writes).toHaveLength(1);
    });

    /**
     * Stripe expires an open Checkout Session 24 hours after creating it and
     * the URL stops working at that moment, so ours is treated as usable for
     * 20 — a margin between the clock that stamped it (the reader's) and the
     * clock that enforces it (Stripe's).
     */
    it('ignores one left over from yesterday', async () => {
      const fake = fakeFirestore({ products: catalog(priced('price_usd', 'usd')) });
      localStorage.setItem(
        'trivia-checkout-ready',
        JSON.stringify({
          uid: user.uid,
          priceId: 'price_usd',
          url: 'https://stripe.test/stale',
          readyAt: Date.now() - (READY_CHECKOUT_TTL_MS + 60_000),
        }),
      );
      const { service } = configure(user);
      await service.loadProPrices();

      await service.startProCheckout();

      expect(fake.writes).toHaveLength(1);
      expect(redirectedTo()).toBe('https://stripe.test/s');
    });

    // The entry is per-device, not per-account: a second person signing in on
    // the same machine must not be handed the first one's checkout.
    it('refuses a session belonging to another account', async () => {
      const fake = fakeFirestore({ products: catalog(priced('price_usd', 'usd')) });
      localStorage.setItem(
        'trivia-checkout-ready',
        JSON.stringify({
          uid: 'somebody-else',
          priceId: 'price_usd',
          url: 'https://stripe.test/theirs',
          readyAt: Date.now(),
        }),
      );
      const { service } = configure(user);
      await service.loadProPrices();

      await service.startProCheckout();

      expect(fake.writes).toHaveLength(1);
      expect(redirectedTo()).toBe('https://stripe.test/s');
    });
  });

  /**
   * A failed pre-creation is invisible on purpose — nobody asked for it — but
   * it must not become a failure the reader cannot get past. Nothing is cached
   * for a rejection (`CLAUDE.md` §4.4), so the click runs the handshake again
   * and reports whatever it says.
   */
  it('leaves a failed pre-creation for the click to report', async () => {
    const fake = fakeFirestore({
      products: catalog(priced('price_usd', 'usd')),
      writeBack: { error: { message: 'Your account is already set up to pay in BRL.' } },
    });
    const { service } = configure(user);
    await service.loadProPrices();

    await expect(service.prepareCheckout()).resolves.toBeUndefined();
    expect(fake.writes).toHaveLength(1);

    await expect(service.startProCheckout()).rejects.toThrow(
      'Your account is already set up to pay in BRL.',
    );
    expect(fake.writes).toHaveLength(2);
  });
});
