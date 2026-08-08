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
  options: { deniedIds?: string[]; writeBack?: Record<string, unknown> } = {},
) {
  const writes: WrittenDoc[] = [];
  const denied = new Set(options.deniedIds ?? []);

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
      queueMicrotask(() =>
        next({ data: () => options.writeBack ?? { url: 'https://stripe.test/s' } }),
      );
      return () => undefined;
    },
  };

  return { writes, firestoreModule };
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
