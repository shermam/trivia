import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { AuthService } from './auth.service';
import { DonationService, NO_DONATION_PRICE_MESSAGE, presetsByCurrency } from './donation.service';
import { FirebaseAppService } from './firebase-app.service';
import { GeoService } from './geo.service';
import { SubscriptionError } from './session-handshake.service';

/**
 * The tip jar is a payment path, so what is pinned here is what the server is
 * relying on the client to get right: which prices it is willing to offer (a
 * donation price and nothing else), the exact payload it writes — anything
 * extra is refused by the `hasOnly()` allowlist in `firestore.rules` — and the
 * document ID it writes under, where the volume cap lives.
 *
 * Firestore is faked at `fetch`, the same layer `subscription.service.spec.ts`
 * fakes it at, so these tests run through the real `FirestoreRestClient` and
 * assert on the request that would actually reach Firestore.
 */

const PROJECT = 'demo-project';
const RESOURCE_ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const URL_ROOT = `https://firestore.googleapis.com/v1/${RESOURCE_ROOT}`;
const SESSION_WINDOW_MS = 300_000;

interface PriceSeed {
  id: string;
  active?: boolean;
  type?: string;
  kind?: string | null;
  currency?: string | null;
  unitAmount?: number | null;
}

interface ProductSeed {
  id: string;
  active?: boolean;
  kind?: string | null;
  prices: PriceSeed[];
}

interface RecordedQuery {
  collectionPath: string;
  wheres: { field: string; op: string; value: unknown }[];
  limit?: number;
}

/** Deliberately not the production encoder, so a symmetric bug cannot hide. */
function wire(value: unknown): unknown {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return { integerValue: String(value) };
  if (value === null) return { nullValue: null };
  return { mapValue: { fields: wireFields(value as Record<string, unknown>) } };
}

function wireFields(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, wire(v)]));
}

function unwire(value: Record<string, unknown>): unknown {
  if ('stringValue' in value) return value['stringValue'];
  if ('integerValue' in value) return Number(value['integerValue']);
  if ('booleanValue' in value) return value['booleanValue'];
  if ('nullValue' in value) return null;
  throw new Error('fake server cannot decode ' + JSON.stringify(value));
}

function unwireFields(fields: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, unwire(v)]));
}

interface FakeOptions {
  products?: ProductSeed[];
  /** Session document IDs the rules should refuse, as a spent slot would be. */
  deniedIds?: string[];
  /** What the Cloud Function eventually writes onto the session document. */
  writeBack?: Record<string, unknown>;
  /** Fail the catalog query, as an offline tab or a refused read would. */
  failCatalog?: boolean;
}

function fakeFirestore(options: FakeOptions = {}) {
  const writes: { path: string; data: Record<string, unknown> }[] = [];
  const queries: RecordedQuery[] = [];
  const denied = new Set(options.deniedIds ?? []);
  /** Every attempt, including the ones this fake refuses before parsing them. */
  let catalogAttempts = 0;

  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => new AbortController().signal);

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
      : [{ readTime: '2026-09-12T00:00:00Z' }];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method: string; body?: string }) => {
      const body = init.body ? (JSON.parse(init.body) as Record<string, never>) : undefined;
      const pathOf = (u: string) => u.split('?')[0].slice(`${URL_ROOT}/`.length);

      if (url.includes(':runQuery')) {
        catalogAttempts++;
        if (options.failCatalog) {
          return fail(500, 'INTERNAL');
        }
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

        if (collectionId === 'products') {
          // The fake applies the filter rather than returning the seed
          // verbatim: a fake that ignored `where` could not tell a query that
          // asks for donation products from one that asks for all of them,
          // which is the assertion this collection most needs.
          let rows = options.products ?? [];
          for (const filter of wheres) {
            rows = rows.filter(
              (product) =>
                (product as unknown as Record<string, unknown>)[filter.field] === filter.value,
            );
          }
          return ok(
            docsFor(
              collectionPath,
              rows.map((product) => ({
                id: product.id,
                data: { kind: product.kind ?? null, active: product.active ?? true },
              })),
            ),
          );
        }

        const productId = collectionPath.split('/')[1];
        const product = (options.products ?? []).find((p) => p.id === productId)!;
        let prices = product.prices;
        for (const filter of wheres) {
          prices = prices.filter(
            (price) =>
              (filter.field === 'active' ? (price.active ?? true) : undefined) === filter.value,
          );
        }
        return ok(
          docsFor(
            collectionPath,
            prices.map((price) => ({
              id: price.id,
              data: {
                type: price.type ?? 'one_time',
                kind: price.kind === undefined ? 'donation' : price.kind,
                currency: price.currency === undefined ? 'usd' : price.currency,
                unit_amount: price.unitAmount === undefined ? 500 : price.unitAmount,
              },
            })),
          ),
        );
      }

      const path = pathOf(url);
      if (init.method === 'GET') {
        return ok({
          name: `${RESOURCE_ROOT}/${path}`,
          fields: wireFields(options.writeBack ?? { url: 'https://stripe.test/donate' }),
        });
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

  return { writes, queries, catalogAttempts: () => catalogAttempts };
}

/**
 * What the app believes about where the reader is, as a test double — the two
 * real inputs (the machine's IANA zone and a `fetch` to an endpoint that does
 * not exist under Vitest) are exactly what a test cannot choose.
 * `geo.service.spec.ts` covers the real chain.
 */
function geoStub(country: string | null = null, server?: Promise<string | null>) {
  return {
    timeZoneCountry: () => country,
    knownCountry: () => country,
    resolveCountry: () => server ?? Promise.resolve(country),
  };
}

function configure(
  user: unknown,
  geo: Pick<GeoService, 'timeZoneCountry' | 'knownCountry' | 'resolveCountry'> = geoStub(),
  options: { authReady?: boolean } = {},
) {
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
          authReady: signal(options.authReady ?? true),
          getIdToken: () => Promise.resolve('id-token'),
        },
      },
      { provide: GeoService, useValue: geo },
    ],
  });
  return TestBed.inject(DonationService);
}

const donationProduct = (prices: PriceSeed[]): ProductSeed => ({
  id: 'prod_coffee',
  kind: 'donation',
  active: true,
  prices,
});

const usdPresets: PriceSeed[] = [
  { id: 'price_usd_small', currency: 'usd', unitAmount: 200 },
  { id: 'price_usd_medium', currency: 'usd', unitAmount: 500 },
  { id: 'price_usd_large', currency: 'usd', unitAmount: 1000 },
];

const brlPresets: PriceSeed[] = [
  { id: 'price_brl_small', currency: 'brl', unitAmount: 1000 },
  { id: 'price_brl_medium', currency: 'brl', unitAmount: 2500 },
  { id: 'price_brl_large', currency: 'brl', unitAmount: 5000 },
];

const currentWindow = () => Math.floor(Date.now() / SESSION_WINDOW_MS);

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('location', { origin: 'https://example.web.app', assign: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
});

describe('presetsByCurrency', () => {
  it('sorts each currency ascending, so the row reads small to large', () => {
    const grouped = presetsByCurrency([
      { priceId: 'p3', currency: 'usd', unitAmount: 1000 },
      { priceId: 'p1', currency: 'usd', unitAmount: 200 },
      { priceId: 'p2', currency: 'usd', unitAmount: 500 },
    ]);

    expect(grouped.get('usd')?.map((preset) => preset.priceId)).toEqual(['p1', 'p2', 'p3']);
  });

  it('keeps the currencies apart', () => {
    const grouped = presetsByCurrency([
      { priceId: 'u', currency: 'usd', unitAmount: 200 },
      { priceId: 'b', currency: 'brl', unitAmount: 1000 },
    ]);

    expect([...grouped.keys()]).toEqual(['usd', 'brl']);
  });

  // The row is three cells wide. A fourth would render off the edge, and
  // which three survive must not depend on document order.
  it('offers the three cheapest when the catalog carries more', () => {
    const grouped = presetsByCurrency([
      { priceId: 'p4', currency: 'usd', unitAmount: 2000 },
      { priceId: 'p1', currency: 'usd', unitAmount: 200 },
      { priceId: 'p3', currency: 'usd', unitAmount: 1000 },
      { priceId: 'p2', currency: 'usd', unitAmount: 500 },
    ]);

    expect(grouped.get('usd')?.map((preset) => preset.priceId)).toEqual(['p1', 'p2', 'p3']);
  });

  it('breaks a tie deterministically rather than by arrival order', () => {
    const grouped = presetsByCurrency([
      { priceId: 'p_b', currency: 'usd', unitAmount: 500 },
      { priceId: 'p_a', currency: 'usd', unitAmount: 500 },
    ]);

    expect(grouped.get('usd')?.map((preset) => preset.priceId)).toEqual(['p_a', 'p_b']);
  });
});

describe('DonationService catalog', () => {
  it('asks only for donation products, with a bound on both queries', async () => {
    const fake = fakeFirestore({ products: [donationProduct(usdPresets)] });
    await configure({ uid: 'user-1', isAnonymous: false }).loadPresets();

    const products = fake.queries.find((query) => query.collectionPath === 'products');
    expect(products?.wheres).toEqual([{ field: 'kind', op: 'EQUAL', value: 'donation' }]);
    expect(products?.limit).toBeGreaterThan(0);

    const prices = fake.queries.find((query) => query.collectionPath.endsWith('/prices'));
    expect(prices?.wheres).toEqual([{ field: 'active', op: 'EQUAL', value: true }]);
    expect(prices?.limit).toBeGreaterThan(0);
  });

  it('offers the catalog’s own amounts, cheapest first', async () => {
    fakeFirestore({ products: [donationProduct(usdPresets)] });
    const service = configure({ uid: 'user-1', isAnonymous: false });
    await service.loadPresets();

    expect(service.presets().map((preset) => preset.unitAmount)).toEqual([200, 500, 1000]);
    expect(service.selectedCurrency()).toBe('usd');
  });

  /*
   * The mutual exclusion the server enforces, mirrored on the client: a Pro
   * price is a recurring charge, and taking one as a donation would charge a
   * subscription as a one-off. Both markers are checked because both are
   * mirrored — the product's decides which products come back, the price's
   * keeps a stray price on the donation product out of the row.
   */
  it('refuses a price the catalog has not marked as a donation', async () => {
    fakeFirestore({
      products: [
        donationProduct([
          { id: 'price_pro', currency: 'usd', unitAmount: 99, kind: null },
          { id: 'price_coffee', currency: 'usd', unitAmount: 500 },
        ]),
      ],
    });
    const service = configure({ uid: 'user-1', isAnonymous: false });
    await service.loadPresets();

    expect(service.presets().map((preset) => preset.priceId)).toEqual(['price_coffee']);
  });

  it('refuses a recurring price, which `mode: payment` cannot charge', async () => {
    fakeFirestore({
      products: [
        donationProduct([
          { id: 'price_monthly', currency: 'usd', unitAmount: 99, type: 'recurring' },
          { id: 'price_coffee', currency: 'usd', unitAmount: 500 },
        ]),
      ],
    });
    const service = configure({ uid: 'user-1', isAnonymous: false });
    await service.loadPresets();

    expect(service.presets().map((preset) => preset.priceId)).toEqual(['price_coffee']);
  });

  it('drops a price with no currency or no amount rather than quoting nothing', async () => {
    fakeFirestore({
      products: [
        donationProduct([
          { id: 'price_no_currency', currency: null, unitAmount: 500 },
          { id: 'price_no_amount', currency: 'usd', unitAmount: null },
          { id: 'price_coffee', currency: 'usd', unitAmount: 500 },
        ]),
      ],
    });
    const service = configure({ uid: 'user-1', isAnonymous: false });
    await service.loadPresets();

    expect(service.presets().map((preset) => preset.priceId)).toEqual(['price_coffee']);
  });

  it('ignores an archived donation product', async () => {
    fakeFirestore({ products: [{ ...donationProduct(usdPresets), active: false }] });
    const service = configure({ uid: 'user-1', isAnonymous: false });
    await service.loadPresets();

    expect(service.presets()).toEqual([]);
    expect(service.isUnavailable()).toBe(true);
  });

  /*
   * The empty catalog is what a deployment looks like before the donation
   * Product has been created in the Stripe Dashboard, and it has to degrade
   * honestly rather than throw: the CTA still opens, and the dialog says so.
   */
  it('says donations are unavailable when nothing is priced', async () => {
    fakeFirestore({ products: [] });
    const service = configure({ uid: 'user-1', isAnonymous: false });
    await service.loadPresets();

    expect(service.isUnavailable()).toBe(true);
    expect(service.catalogResolved()).toBe(true);
  });

  it('reports the same when the catalog cannot be read at all', async () => {
    fakeFirestore({ failCatalog: true });
    const service = configure({ uid: 'user-1', isAnonymous: false });
    await service.loadPresets();

    expect(service.isUnavailable()).toBe(true);
  });

  // §4.4: a rejected promise must not be cached, or a catalog created in the
  // Dashboard after a failed attempt would need a page reload to appear.
  it('does not cache a failed lookup', async () => {
    const fake = fakeFirestore({ failCatalog: true });
    const service = configure({ uid: 'user-1', isAnonymous: false });
    await service.loadPresets();
    const afterFirst = fake.catalogAttempts();

    await service.loadPresets();

    expect(fake.catalogAttempts()).toBeGreaterThan(afterFirst);
  });

  // Nothing is on screen until the read has answered, so the dialog can tell
  // "still loading" from "nothing to offer" (`CLAUDE.md` §4.4).
  it('reports the catalog as unresolved before the read answers', () => {
    fakeFirestore({ products: [donationProduct(usdPresets)] });
    const service = configure({ uid: 'user-1', isAnonymous: false });

    expect(service.catalogResolved()).toBe(false);
    expect(service.isUnavailable()).toBe(false);
  });
});

describe('DonationService currency', () => {
  it('opens on BRL for a visitor the app places in Brazil', async () => {
    fakeFirestore({ products: [donationProduct([...usdPresets, ...brlPresets])] });
    const service = configure({ uid: 'user-1', isAnonymous: false }, geoStub('BR'));
    await service.loadPresets();

    expect(service.selectedCurrency()).toBe('brl');
    expect(service.presets().map((preset) => preset.unitAmount)).toEqual([1000, 2500, 5000]);
  });

  it('opens on USD for everybody else', async () => {
    fakeFirestore({ products: [donationProduct([...usdPresets, ...brlPresets])] });
    const service = configure({ uid: 'user-1', isAnonymous: false }, geoStub('US'));
    await service.loadPresets();

    expect(service.selectedCurrency()).toBe('usd');
  });

  /*
   * The server's answer can arrive after the reader has already clicked, and a
   * default landing on top of that click would undo the one gesture the switch
   * exists for.
   */
  it('does not override a currency the reader chose while the server was answering', async () => {
    fakeFirestore({ products: [donationProduct([...usdPresets, ...brlPresets])] });
    let answer!: (country: string | null) => void;
    const server = new Promise<string | null>((resolve) => {
      answer = resolve;
    });
    const service = configure({ uid: 'user-1', isAnonymous: false }, geoStub(null, server));

    const loading = service.loadPresets();
    await vi.waitUntil(() => service.presets().length > 0);
    service.selectCurrency('brl');
    answer('US');
    await loading;

    expect(service.selectedCurrency()).toBe('brl');
  });

  it('keeps the reader’s rank when they change currency', async () => {
    fakeFirestore({ products: [donationProduct([...usdPresets, ...brlPresets])] });
    const service = configure({ uid: 'user-1', isAnonymous: false }, geoStub('US'));
    await service.loadPresets();

    service.selectPreset('price_usd_large');
    service.selectCurrency('brl');

    expect(service.selectedPriceId()).toBe('price_brl_large');
  });

  it('ignores a currency the catalog does not carry', async () => {
    fakeFirestore({ products: [donationProduct(usdPresets)] });
    const service = configure({ uid: 'user-1', isAnonymous: false });
    await service.loadPresets();

    service.selectCurrency('eur');

    expect(service.selectedCurrency()).toBe('usd');
  });

  // A radiogroup with nothing checked is a control the reader has to discover
  // is a control.
  it('checks the middle amount by default', async () => {
    fakeFirestore({ products: [donationProduct(usdPresets)] });
    const service = configure({ uid: 'user-1', isAnonymous: false });
    await service.loadPresets();

    expect(service.selectedPriceId()).toBe('price_usd_medium');
  });

  it('ignores a preset that is not on offer', async () => {
    fakeFirestore({ products: [donationProduct(usdPresets)] });
    const service = configure({ uid: 'user-1', isAnonymous: false });
    await service.loadPresets();

    service.selectPreset('price_someone_elses');

    expect(service.selectedPriceId()).toBe('price_usd_medium');
  });
});

describe('DonationService handshake', () => {
  it('writes exactly the price and the origin', async () => {
    const fake = fakeFirestore({ products: [donationProduct(usdPresets)] });
    const service = configure({ uid: 'user-1', isAnonymous: false });
    await service.loadPresets();

    await service.startDonation();

    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].data).toEqual({
      price: 'price_usd_medium',
      origin: 'https://example.web.app',
    });
  });

  // A separate subcollection is what keeps the two volume caps and the two
  // catalog validations apart.
  it('writes into donation_sessions, never into checkout_sessions', async () => {
    const fake = fakeFirestore({ products: [donationProduct(usdPresets)] });
    const service = configure({ uid: 'user-1', isAnonymous: false });
    await service.loadPresets();

    await service.startDonation();

    expect(fake.writes[0].path).toMatch(
      new RegExp(`^customers/user-1/donation_sessions/${currentWindow()}-\\d$`),
    );
  });

  it('redirects to the URL the Cloud Function writes back', async () => {
    fakeFirestore({
      products: [donationProduct(usdPresets)],
      writeBack: { url: 'https://checkout.stripe.test/c/pay/cs_1' },
    });
    const service = configure({ uid: 'user-1', isAnonymous: false });
    await service.loadPresets();

    await service.startDonation();

    expect(window.location.assign).toHaveBeenCalledWith('https://checkout.stripe.test/c/pay/cs_1');
  });

  // Anonymous donors are the common case — every page load signs one in — and
  // `firestore.rules` allows them on this path deliberately.
  it('lets an anonymous session donate', async () => {
    const fake = fakeFirestore({ products: [donationProduct(usdPresets)] });
    const service = configure({ uid: 'anon-1', isAnonymous: true });
    await service.loadPresets();

    await service.startDonation();

    expect(fake.writes[0].path).toContain('customers/anon-1/donation_sessions/');
  });

  it('moves to another slot when one is already spent this window', async () => {
    const spent = Array.from({ length: 9 }, (_, slot) => `${currentWindow()}-${slot}`);
    const fake = fakeFirestore({ products: [donationProduct(usdPresets)], deniedIds: spent });
    const service = configure({ uid: 'user-1', isAnonymous: false });
    await service.loadPresets();

    await service.startDonation();

    expect(fake.writes[0].path).toBe(`customers/user-1/donation_sessions/${currentWindow()}-9`);
  });

  it('gives up with a message a reader can act on when every slot is spent', async () => {
    const spent = Array.from({ length: 10 }, (_, slot) => `${currentWindow()}-${slot}`);
    fakeFirestore({ products: [donationProduct(usdPresets)], deniedIds: spent });
    const service = configure({ uid: 'user-1', isAnonymous: false });
    await service.loadPresets();

    await expect(service.startDonation()).rejects.toThrow(SubscriptionError);
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it('shows the message the Cloud Function wrote back rather than a generic one', async () => {
    fakeFirestore({
      products: [donationProduct(usdPresets)],
      writeBack: {
        error: {
          message:
            'Your account is already set up to pay in BRL, so a donation can only be made in BRL from this account.',
        },
      },
    });
    const service = configure({ uid: 'user-1', isAnonymous: false });
    await service.loadPresets();

    await expect(service.startDonation()).rejects.toThrow(/already set up to pay in BRL/);
  });

  it('refuses to start when nothing is on sale, and says why', async () => {
    fakeFirestore({ products: [] });
    const service = configure({ uid: 'user-1', isAnonymous: false });
    await service.loadPresets();

    await expect(service.startDonation()).rejects.toThrow(NO_DONATION_PRICE_MESSAGE);
  });

  it('refuses before auth has produced any account at all', async () => {
    fakeFirestore({ products: [donationProduct(usdPresets)] });
    const service = configure(null);
    await service.loadPresets();

    await expect(service.startDonation()).rejects.toThrow(SubscriptionError);
  });
});

describe('DonationService guest notice', () => {
  it('is shown to an anonymous session', () => {
    fakeFirestore();
    expect(configure({ uid: 'anon-1', isAnonymous: true }).isGuest()).toBe(true);
  });

  it('is not shown to a real account', () => {
    fakeFirestore();
    expect(configure({ uid: 'user-1', isAnonymous: false }).isGuest()).toBe(false);
  });

  /*
   * `isAnonymous()` is `user()?.isAnonymous ?? false`, so a null user reads as
   * "not anonymous" — the exact shape of the account-chip and game-over
   * flashes in `CLAUDE.md` §4.4. A signed-out visitor is a guest, and the
   * notice must say so rather than falling through to the signed-in branch.
   */
  it('is shown when there is no user at all', () => {
    fakeFirestore();
    expect(configure(null).isGuest()).toBe(true);
  });

  // Least alarming until it is known: telling somebody their donation cannot
  // be credited, a frame before their account arrives, is the wrong guess.
  it('is not shown before auth has resolved', () => {
    fakeFirestore();
    expect(configure(null, geoStub(), { authReady: false }).isGuest()).toBe(false);
  });
});
