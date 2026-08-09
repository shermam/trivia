import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { AuthService } from './auth.service';
import { FirebaseService } from './firebase.service';
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
 * Firestore is faked at the module boundary — `FirebaseService.getFirestore()`
 * hands back the SDK namespace, so a stand-in for it is enough to observe
 * every call without an emulator.
 */

const SESSION_WINDOW_MS = 300_000;

interface WrittenDoc {
  path: string[];
  data: Record<string, unknown>;
}

/** Fails `setDoc` for any doc ID in `deniedIds`, the way the rules would. */
function fakeFirestore(
  options: {
    deniedIds?: string[];
    writeBack?: Record<string, unknown>;
    /** Never call back, so the handshake reaches its deadline instead. */
    neverRespond?: boolean;
  } = {},
) {
  const writes: WrittenDoc[] = [];
  const denied = new Set(options.deniedIds ?? []);
  const unsubscribe = vi.fn();

  const firestoreModule = {
    doc: (_firestore: unknown, ...path: string[]) => ({ path }),
    collection: (_firestore: unknown, ...path: string[]) => ({ path }),
    query: (ref: unknown) => ref,
    where: () => undefined,
    getDocs: () => Promise.resolve({ docs: [] }),
    setDoc: (ref: { path: string[] }, data: Record<string, unknown>) => {
      const id = ref.path[ref.path.length - 1];
      if (denied.has(id)) {
        return Promise.reject(
          Object.assign(new Error('Missing permissions.'), {
            code: 'permission-denied',
          }),
        );
      }
      writes.push({ path: ref.path, data });
      return Promise.resolve();
    },
    onSnapshot: (_ref: unknown, next: (snap: { data: () => unknown }) => void) => {
      // Stand in for the Cloud Function's write-back, which is what the
      // service is waiting on.
      if (!options.neverRespond) {
        queueMicrotask(() =>
          next({ data: () => options.writeBack ?? { url: 'https://stripe.test/s' } }),
        );
      }
      return unsubscribe;
    },
  };

  return { writes, firestoreModule, unsubscribe };
}

function configure(fake: ReturnType<typeof fakeFirestore>, user: unknown) {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: FirebaseService,
        useValue: {
          getFirestore: () =>
            Promise.resolve({ firestore: {}, firestoreModule: fake.firestoreModule }),
        },
      },
      {
        provide: AuthService,
        useValue: {
          user: signal(user),
          isProUser: signal(false),
          refreshIdToken: () => Promise.resolve(),
        },
      },
    ],
  });
  return TestBed.inject(SubscriptionService);
}

describe('SubscriptionService session handshake', () => {
  const user = { uid: 'user-1', isAnonymous: false };
  let assign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    assign = vi.fn();
    // `window.location.assign` is non-configurable in a real browser, but this
    // is jsdom; the redirect itself is covered for real by pricing.cy.ts.
    vi.stubGlobal('location', { origin: 'https://example.web.app', assign });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('writes only the origin for a billing-portal session', async () => {
    const fake = fakeFirestore();
    await configure(fake, user).openBillingPortal();

    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].data).toEqual({ origin: 'https://example.web.app' });
  });

  // The redirect URLs and the checkout mode used to be here and were handed to
  // Stripe verbatim (finding A2). The rules' `hasOnly()` allowlist now rejects
  // them outright, so sending them again would break checkout, not just widen
  // it.
  it('never sends redirect URLs or a mode the function decides for itself', async () => {
    const fake = fakeFirestore();
    await configure(fake, user).openBillingPortal();

    expect(Object.keys(fake.writes[0].data)).toEqual(['origin']);
  });

  it('writes under a {5-minute window}-{slot} document ID the volume cap accepts', async () => {
    const fake = fakeFirestore();
    await configure(fake, user).openBillingPortal();

    const [, uid, collectionName, id] = fake.writes[0].path;
    expect(uid).toBe('user-1');
    expect(collectionName).toBe('portal_sessions');
    expect(id).toMatch(new RegExp(`^${Math.floor(Date.now() / SESSION_WINDOW_MS)}-[0-9]$`));
  });

  // A slot already spent this window is a `permission-denied`, and a user who
  // genuinely opens the portal twice in five minutes should not see an error
  // for it.
  it('moves to another slot when the one it picked is already spent', async () => {
    const allSlots = Array.from({ length: 10 }, (_, slot) => {
      return `${Math.floor(Date.now() / SESSION_WINDOW_MS)}-${slot}`;
    });
    const fake = fakeFirestore({ deniedIds: allSlots.slice(0, 9) });
    await configure(fake, user).openBillingPortal();

    expect(fake.writes).toHaveLength(1);
    expect(allSlots.indexOf(fake.writes[0].path[3])).toBe(9);
  });

  it('gives up with an actionable message once every slot in the window is spent', async () => {
    const allSlots = Array.from({ length: 10 }, (_, slot) => {
      return `${Math.floor(Date.now() / SESSION_WINDOW_MS)}-${slot}`;
    });
    const fake = fakeFirestore({ deniedIds: allSlots });

    await expect(configure(fake, user).openBillingPortal()).rejects.toThrow(/Reload the page/);
    expect(fake.writes).toHaveLength(0);
  });

  // Only `permission-denied` means "try another slot"; anything else is a real
  // failure and burning nine more writes on it would just delay reporting it.
  it('does not retry a failure that is not a permission denial', async () => {
    const fake = fakeFirestore();
    fake.firestoreModule.setDoc = () => Promise.reject(new Error('offline'));

    await expect(configure(fake, user).openBillingPortal()).rejects.toThrow('offline');
  });

  it('surfaces the error the Cloud Function writes back', async () => {
    const fake = fakeFirestore({ writeBack: { error: { message: 'Could not start checkout.' } } });

    await expect(configure(fake, user).openBillingPortal()).rejects.toThrow(
      'Could not start checkout.',
    );
  });

  it('refuses an anonymous caller before writing anything', async () => {
    const fake = fakeFirestore();
    const service = configure(fake, { uid: 'anon-1', isAnonymous: true });

    await expect(service.openBillingPortal()).rejects.toThrow('Sign in before managing');
    await expect(service.startProCheckout()).rejects.toThrow('Sign in before subscribing');
    expect(fake.writes).toHaveLength(0);
  });

  // The price lookup is a pair of Firestore reads; an anonymous click that
  // can't succeed anyway shouldn't pay for them.
  it('does not look up the Pro price for a caller it will refuse', async () => {
    const fake = fakeFirestore();
    let priceLookups = 0;
    fake.firestoreModule.getDocs = () => {
      priceLookups++;
      return Promise.resolve({ docs: [] });
    };

    await expect(
      configure(fake, { uid: 'anon-1', isAnonymous: true }).startProCheckout(),
    ).rejects.toThrow();
    expect(priceLookups).toBe(0);
  });
});

/**
 * Part of finding B6. The handshake's deadline used to be a `Promise.race`
 * around the listener, and `Promise.race` settles without telling the loser —
 * so a timed-out checkout left its `onSnapshot` subscription attached for the
 * rest of the session, still receiving writes, and still billed for them, for
 * a checkout nobody was waiting on any more.
 */
describe('SubscriptionService handshake deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('location', { origin: 'https://example.web.app', assign: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('detaches the listener when the function never writes back', async () => {
    const fake = fakeFirestore({ neverRespond: true });
    const service = configure(fake, { uid: 'user-1', isAnonymous: false });

    const pending = service.openBillingPortal();
    const assertion = expect(pending).rejects.toThrow(/Timed out/);

    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;

    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
    // And nothing is left ticking for a handshake that is over.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('detaches the listener on the success path too', async () => {
    const fake = fakeFirestore();
    const service = configure(fake, { uid: 'user-1', isAnonymous: false });

    // A delta, not an absolute count: TestBed and Angular's effect scheduling
    // have timers of their own, and this test is only about whether the
    // handshake leaves its own deadline behind.
    const before = vi.getTimerCount();
    await service.openBillingPortal();

    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(before);
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

interface ProductSeed {
  id: string;
  role: string | null;
  active: boolean;
  prices: { id: string; active: boolean; interval: string }[];
  /** Lets a test make the *first* product the slowest to answer. */
  delayMs?: number;
}

interface RecordedQuery {
  target: string;
  wheres: [string, unknown][];
  limit?: number;
}

function fakeCatalog(products: ProductSeed[]) {
  const queries: RecordedQuery[] = [];
  const writes: WrittenDoc[] = [];
  let inFlightPriceQueries = 0;
  let maxConcurrentPriceQueries = 0;

  const firestoreModule = {
    doc: (_fs: unknown, ...path: string[]) => ({ path }),
    collection: (parent: { __productId?: string } | unknown, ...path: string[]) => {
      const productId = (parent as { __productId?: string } | null)?.__productId;
      return productId ? { target: 'prices', productId } : { target: 'products', path };
    },
    where: (field: string, _op: string, value: unknown) => ({ __where: [field, value] }),
    limit: (value: number) => ({ __limit: value }),
    query: (ref: unknown, ...constraints: Record<string, unknown>[]) => ({ ref, constraints }),
    getDocs: async (q: {
      ref: { target: string; productId?: string };
      constraints: Record<string, unknown>[];
    }) => {
      const wheres = q.constraints
        .filter((c) => c['__where'])
        .map((c) => c['__where'] as [string, unknown]);
      const limitConstraint = q.constraints.find((c) => c['__limit'] !== undefined);
      queries.push({
        target: q.ref.target,
        wheres,
        limit: limitConstraint?.['__limit'] as number | undefined,
      });

      if (q.ref.target === 'products') {
        let rows = products;
        for (const [field, value] of wheres) {
          rows = rows.filter((p) => (p as unknown as Record<string, unknown>)[field] === value);
        }
        rows = rows.slice(0, (limitConstraint?.['__limit'] as number) ?? rows.length);
        return {
          docs: rows.map((p) => ({
            id: p.id,
            ref: { __productId: p.id },
            data: () => ({ role: p.role, active: p.active }),
          })),
        };
      }

      inFlightPriceQueries++;
      maxConcurrentPriceQueries = Math.max(maxConcurrentPriceQueries, inFlightPriceQueries);
      const product = products.find((p) => p.id === q.ref.productId)!;
      if (product.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, product.delayMs));
      }
      inFlightPriceQueries--;

      let prices = product.prices;
      for (const [field, value] of wheres) {
        prices = prices.filter((p) => (p as unknown as Record<string, unknown>)[field] === value);
      }
      prices = prices.slice(0, (limitConstraint?.['__limit'] as number) ?? prices.length);
      return { docs: prices.map((p) => ({ id: p.id, data: () => ({ interval: p.interval }) })) };
    },
    setDoc: (ref: { path: string[] }, data: Record<string, unknown>) => {
      writes.push({ path: ref.path, data });
      return Promise.resolve();
    },
    onSnapshot: (_ref: unknown, next: (snap: { data: () => unknown }) => void) => {
      queueMicrotask(() => next({ data: () => ({ url: 'https://stripe.test/s' }) }));
      return vi.fn();
    },
  };

  return {
    firestoreModule,
    queries,
    writes,
    priceQueries: () => queries.filter((q) => q.target === 'prices'),
    maxConcurrentPriceQueries: () => maxConcurrentPriceQueries,
  };
}

function configureCatalog(fake: ReturnType<typeof fakeCatalog>) {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: FirebaseService,
        useValue: {
          getFirestore: () =>
            Promise.resolve({ firestore: {}, firestoreModule: fake.firestoreModule }),
        },
      },
      {
        provide: AuthService,
        useValue: {
          user: signal({ uid: 'user-1', isAnonymous: false }),
          isProUser: signal(false),
          refreshIdToken: () => Promise.resolve(),
        },
      },
    ],
  });
  return TestBed.inject(SubscriptionService);
}

/** The price the service settled on, read off the checkout-session doc it wrote. */
function writtenPrice(fake: ReturnType<typeof fakeCatalog>): unknown {
  return fake.writes.at(-1)?.data['price'];
}

const monthly = (id: string) => ({ id, active: true, interval: 'month' });

describe('SubscriptionService Pro price lookup (C5)', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { origin: 'https://example.web.app', assign: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('fetches every product’s prices at once instead of one after another', async () => {
    const fake = fakeCatalog([
      { id: 'prod_a', role: 'pro', active: true, prices: [], delayMs: 20 },
      { id: 'prod_b', role: 'pro', active: true, prices: [], delayMs: 20 },
      { id: 'prod_c', role: 'pro', active: true, prices: [monthly('price_c')], delayMs: 20 },
    ]);

    await configureCatalog(fake).startProCheckout();

    expect(fake.priceQueries()).toHaveLength(3);
    // The finding itself: sequentially, this would never exceed 1.
    expect(fake.maxConcurrentPriceQueries()).toBe(3);
  });

  it('bounds both queries with a limit', async () => {
    const fake = fakeCatalog([
      { id: 'prod_a', role: 'pro', active: true, prices: [monthly('price_a')] },
    ]);

    await configureCatalog(fake).startProCheckout();

    expect(fake.queries.every((q) => q.limit !== undefined)).toBe(true);
  });

  it('selects on role, the same predicate the server enforces', async () => {
    const fake = fakeCatalog([
      { id: 'prod_other', role: 'team', active: true, prices: [monthly('price_team')] },
      { id: 'prod_pro', role: 'pro', active: true, prices: [monthly('price_pro')] },
    ]);

    await configureCatalog(fake).startProCheckout();

    expect(fake.queries[0].wheres).toContainEqual(['role', 'pro']);
    expect(writtenPrice(fake)).toBe('price_pro');
  });

  it('ignores a Pro product that is no longer active', async () => {
    const fake = fakeCatalog([
      { id: 'prod_old', role: 'pro', active: false, prices: [monthly('price_old')] },
      { id: 'prod_new', role: 'pro', active: true, prices: [monthly('price_new')] },
    ]);

    await configureCatalog(fake).startProCheckout();

    expect(fake.priceQueries()).toHaveLength(1);
    expect(writtenPrice(fake)).toBe('price_new');
  });

  // Parallelism must not make the answer depend on which request came back
  // first — the catalog's own order decides.
  it('picks the first product in catalog order even when it answers last', async () => {
    const fake = fakeCatalog([
      {
        id: 'prod_first',
        role: 'pro',
        active: true,
        prices: [monthly('price_first')],
        delayMs: 30,
      },
      { id: 'prod_second', role: 'pro', active: true, prices: [monthly('price_second')] },
    ]);

    await configureCatalog(fake).startProCheckout();

    expect(writtenPrice(fake)).toBe('price_first');
  });

  it('only considers monthly prices', async () => {
    const fake = fakeCatalog([
      {
        id: 'prod_pro',
        role: 'pro',
        active: true,
        prices: [
          { id: 'price_yearly', active: true, interval: 'year' },
          { id: 'price_monthly', active: true, interval: 'month' },
        ],
      },
    ]);

    await configureCatalog(fake).startProCheckout();

    expect(writtenPrice(fake)).toBe('price_monthly');
  });

  it('reports an actionable error when the catalog has no Pro price', async () => {
    const fake = fakeCatalog([{ id: 'prod_pro', role: 'pro', active: true, prices: [] }]);

    await expect(configureCatalog(fake).startProCheckout()).rejects.toThrow(
      /check the Stripe Dashboard/i,
    );
  });
});
