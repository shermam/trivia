import { TestBed } from '@angular/core/testing';
import { AuthService } from './auth.service';
import { FirebaseAppService } from './firebase-app.service';

/**
 * Finding E2. `AuthService` had produced three real bugs found only by e2e —
 * the anonymous sign-in racing a restoring session, linking mutating the
 * Firebase `User` in place without firing `onAuthStateChanged`, and sign-out
 * flashing a transient signed-out state — and no unit-level coverage. Each of
 * those fixed behaviours is pinned here, plus the entitlement logic
 * (`isFullyAuthenticated` mirrors the Firestore rules' anti-cheat gate, and
 * `stripeRole` handling decides who the UI treats as Pro).
 *
 * `firebase/auth` is faked at the module boundary (`vi.mock`), the same seam
 * the other service specs use for Firestore. The fake reproduces the two SDK
 * behaviours the service exists to work around, because a fake without them
 * would pass against a service that has the bugs: linking mutates the user
 * in place *without* notifying `onAuthStateChanged`, and `signOut` fires the
 * listener with `null` before any follow-up sign-in can land.
 */

interface FakeUser {
  isAnonymous: boolean;
  emailVerified: boolean;
  providerData: { providerId: string }[];
  displayName?: string;
}

const h = vi.hoisted(() => {
  interface HoistedFakeUser {
    isAnonymous: boolean;
    emailVerified: boolean;
    providerData: { providerId: string }[];
    displayName?: string;
  }
  interface State {
    listeners: ((user: HoistedFakeUser | null) => void)[];
    /** What `authStateReady()` restores, standing in for IndexedDB persistence. */
    persistedUser: HoistedFakeUser | null;
    currentUser: HoistedFakeUser | null;
    claims: Record<string, unknown>;
    forcedRefreshError: unknown;
    anonSignInError: unknown;
    signInError: unknown;
    createUserError: unknown;
    popupError: unknown;
    errorCredential: unknown;
    lastCredential: unknown;
    calls: string[];
    /** Runs right after signOut's listener-with-null fires — the exact moment
     * the "verify your email" flash used to happen. */
    probeAfterSignOutNull: (() => void) | null;
  }
  const state: State = {
    listeners: [],
    persistedUser: null,
    currentUser: null,
    claims: {},
    forcedRefreshError: null,
    anonSignInError: null,
    signInError: null,
    createUserError: null,
    popupError: null,
    errorCredential: null,
    lastCredential: null,
    calls: [],
    probeAfterSignOutNull: null,
  };
  const reset = () => {
    state.listeners = [];
    state.persistedUser = null;
    state.currentUser = null;
    state.claims = {};
    state.forcedRefreshError = null;
    state.anonSignInError = null;
    state.signInError = null;
    state.createUserError = null;
    state.popupError = null;
    state.errorCredential = null;
    state.lastCredential = null;
    state.calls = [];
    state.probeAfterSignOutNull = null;
  };
  return { state, reset };
});

vi.mock('firebase/auth', () => {
  const s = h.state;
  const emit = () => {
    for (const listener of [...s.listeners]) {
      listener(s.currentUser);
    }
  };

  const authObject = {
    get currentUser() {
      return s.currentUser;
    },
    // Persistence restores asynchronously — exactly the window the
    // ensureSignedIn race lived in.
    authStateReady: async () => {
      if (s.persistedUser && !s.currentUser) {
        s.currentUser = s.persistedUser;
        emit();
      }
    },
  };

  return {
    initializeAuth: () => authObject,
    browserLocalPersistence: {},
    browserPopupRedirectResolver: {},
    connectAuthEmulator: () => undefined,
    onAuthStateChanged: (_auth: unknown, callback: (user: unknown) => void) => {
      s.listeners.push(callback as (typeof s.listeners)[number]);
      callback(s.currentUser);
      return () => undefined;
    },
    signInAnonymously: async () => {
      s.calls.push('signInAnonymously');
      if (s.anonSignInError) {
        throw s.anonSignInError;
      }
      s.currentUser = { isAnonymous: true, emailVerified: false, providerData: [] };
      emit();
      return { user: s.currentUser };
    },
    EmailAuthProvider: { credential: (email: string) => ({ email }) },
    // Mutates the user in place and deliberately does NOT emit — the real
    // SDK's behaviour, and the reason the service re-pushes the user itself.
    linkWithCredential: async (user: unknown) => {
      s.calls.push('linkWithCredential');
      Object.assign(user as object, {
        isAnonymous: false,
        emailVerified: false,
        providerData: [{ providerId: 'password' }],
      });
      return { user };
    },
    createUserWithEmailAndPassword: async () => {
      s.calls.push('createUserWithEmailAndPassword');
      if (s.createUserError) {
        throw s.createUserError;
      }
      s.currentUser = {
        isAnonymous: false,
        emailVerified: false,
        providerData: [{ providerId: 'password' }],
      };
      emit();
    },
    sendEmailVerification: async () => {
      s.calls.push('sendEmailVerification');
    },
    signInWithEmailAndPassword: async () => {
      s.calls.push('signInWithEmailAndPassword');
      if (s.signInError) {
        throw s.signInError;
      }
      s.currentUser = {
        isAnonymous: false,
        emailVerified: true,
        providerData: [{ providerId: 'password' }],
      };
      emit();
    },
    // Fires the listener with null before returning — the real SDK's
    // behaviour, and the source of the sign-out flash. Also clears the
    // persisted session, as the real SDK does: without that, the follow-up
    // ensureSignedIn's authStateReady would "restore" the account that was
    // just signed out, which no real persistence layer would do.
    signOut: async () => {
      s.calls.push('signOut');
      s.currentUser = null;
      s.persistedUser = null;
      emit();
      s.probeAfterSignOutNull?.();
    },
    getIdTokenResult: async (_user: unknown, forceRefresh?: boolean) => {
      if (forceRefresh && s.forcedRefreshError) {
        throw s.forcedRefreshError;
      }
      return { claims: s.claims };
    },
    updateProfile: async (user: unknown, updates: { displayName: string }) => {
      Object.assign(user as object, updates);
    },
    linkWithPopup: async () => {
      s.calls.push('linkWithPopup');
      if (s.popupError) {
        throw s.popupError;
      }
      Object.assign(s.currentUser as object, {
        isAnonymous: false,
        providerData: [{ providerId: 'google.com' }],
      });
      return { user: s.currentUser };
    },
    signInWithPopup: async () => {
      s.calls.push('signInWithPopup');
    },
    signInWithCredential: async (_auth: unknown, credential: unknown) => {
      s.calls.push('signInWithCredential');
      s.lastCredential = credential;
    },
    GoogleAuthProvider: class {
      static credentialFromError = () => h.state.errorCredential;
    },
    FacebookAuthProvider: class {
      static credentialFromError = () => h.state.errorCredential;
    },
    GithubAuthProvider: class {
      static credentialFromError = () => h.state.errorCredential;
    },
    TwitterAuthProvider: class {
      static credentialFromError = () => h.state.errorCredential;
    },
    OAuthProvider: class {
      static credentialFromError = () => h.state.errorCredential;
    },
  };
});

/** Lets the `void loadStripeRoleClaim(...)` fire-and-forget calls settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeUser(overrides: Partial<FakeUser> = {}): FakeUser {
  return { isAnonymous: false, emailVerified: true, providerData: [], ...overrides };
}

function setup(options: { appUnreachable?: boolean } = {}) {
  h.reset();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: FirebaseAppService,
        useValue: {
          getApp: () =>
            options.appUnreachable
              ? Promise.reject(new Error('config fetch failed'))
              : Promise.resolve({}),
        },
      },
    ],
  });
  return TestBed.inject(AuthService);
}

describe('AuthService anonymous bootstrap', () => {
  it('does not mint an anonymous session on top of a restoring one', async () => {
    // The race found by e2e: `currentUser` reads null right after init even
    // for a returning user, because persistence restores asynchronously.
    const service = setup();
    const returning = fakeUser({ providerData: [{ providerId: 'password' }] });
    h.state.persistedUser = returning;

    await service.ensureSignedIn();
    await settle();

    expect(h.state.calls).not.toContain('signInAnonymously');
    expect(service.user()).toBe(returning);
    expect(service.authReady()).toBe(true);
  });

  it('signs in anonymously when nothing restores', async () => {
    const service = setup();

    await service.ensureSignedIn();
    await settle();

    expect(h.state.calls).toContain('signInAnonymously');
    expect(service.isAnonymous()).toBe(true);
  });

  it('swallows every failure, because bootstrap calls it without a catch', async () => {
    const service = setup({ appUnreachable: true });
    await expect(service.ensureSignedIn()).resolves.toBeUndefined();
  });
});

describe('AuthService email sign-up', () => {
  it('links an anonymous session in place and re-pushes the user into the signal', async () => {
    // The stale-UI bug found by e2e: linking mutates the same-uid user
    // without firing onAuthStateChanged, so the service must notify itself.
    const service = setup();
    await service.ensureSignedIn();
    await settle();
    expect(service.isAnonymous()).toBe(true);

    await service.signUpWithEmail('player@example.com', 'correct horse');

    expect(h.state.calls).toContain('linkWithCredential');
    expect(h.state.calls).not.toContain('createUserWithEmailAndPassword');
    expect(h.state.calls).toContain('sendEmailVerification');
    expect(service.isAnonymous()).toBe(false);
    expect(service.isEmailPasswordAccount()).toBe(true);
  });

  it('rejects an alias email before any SDK call', async () => {
    const service = setup();

    await expect(service.signUpWithEmail('name+tag@example.com', 'pw')).rejects.toThrow(/aliases/i);
    expect(h.state.calls).toEqual([]);
  });

  it('maps SDK error codes to friendly messages, and unknown codes to a generic one', async () => {
    const service = setup();
    h.state.createUserError = Object.assign(new Error('raw sdk text'), {
      code: 'auth/email-already-in-use',
    });

    await expect(service.signUpWithEmail('player@example.com', 'pw')).rejects.toThrow(
      /already exists/i,
    );

    h.state.createUserError = Object.assign(new Error('??'), { code: 'auth/brand-new-code' });
    await expect(service.signUpWithEmail('player@example.com', 'pw')).rejects.toThrow(
      /something went wrong/i,
    );
  });
});

describe('AuthService sign-out', () => {
  it('never exposes the transient signed-out state, then re-anonymizes', async () => {
    // The flash found by e2e: Firebase fires onAuthStateChanged(null) for the
    // sign-out itself before the follow-up anonymous sign-in lands, which
    // briefly read as "signed in, unverified" and flashed a verify prompt.
    const service = setup();
    const account = fakeUser({ providerData: [{ providerId: 'password' }] });
    h.state.persistedUser = account;
    await service.ensureSignedIn();
    await settle();

    let userAtTheFlashMoment: unknown = 'probe never ran';
    h.state.probeAfterSignOutNull = () => {
      userAtTheFlashMoment = service.user();
    };

    await service.signOut();
    await settle();

    expect(userAtTheFlashMoment).toBe(account);
    expect(service.isAnonymous()).toBe(true);
    expect(h.state.calls).toContain('signInAnonymously');
  });

  it('falls back to a real signed-out state when re-anonymizing fails', async () => {
    // Offline: the suppressed null was never applied, so the service must
    // push it through rather than staying stuck on the signed-out account.
    const service = setup();
    h.state.persistedUser = fakeUser();
    await service.ensureSignedIn();
    await settle();
    h.state.anonSignInError = new Error('offline');

    await service.signOut();
    await settle();

    expect(service.user()).toBeNull();
    expect(service.authReady()).toBe(true);
    expect(service.isProUser()).toBe(false);
  });
});

describe('AuthService entitlement signals', () => {
  it('isFullyAuthenticated mirrors the rules anti-cheat gate', async () => {
    const service = setup();
    await service.ensureSignedIn();
    await settle();

    // Anonymous: never.
    expect(service.isFullyAuthenticated()).toBe(false);

    const cases: { user: FakeUser; expected: boolean }[] = [
      // Password account, unverified: not yet.
      {
        user: fakeUser({ emailVerified: false, providerData: [{ providerId: 'password' }] }),
        expected: false,
      },
      // Password account, verified: yes.
      {
        user: fakeUser({ emailVerified: true, providerData: [{ providerId: 'password' }] }),
        expected: true,
      },
      // OAuth account: verified-ness of the email is the provider's problem.
      {
        user: fakeUser({ emailVerified: false, providerData: [{ providerId: 'google.com' }] }),
        expected: true,
      },
    ];
    for (const { user, expected } of cases) {
      h.state.currentUser = user;
      h.state.listeners.forEach((listener) => listener(user));
      expect(service.isFullyAuthenticated()).toBe(expected);
    }
  });

  it('reads the stripeRole claim into isProUser', async () => {
    const service = setup();
    h.state.claims = { stripeRole: 'pro' };
    h.state.persistedUser = fakeUser();

    await service.ensureSignedIn();
    await settle();

    expect(service.isProUser()).toBe(true);
  });

  it('keeps the previous claim when a forced refresh fails', async () => {
    // A transient refresh failure must not demote a user already known to be
    // Pro — the write it would gate is still validated server-side anyway.
    const service = setup();
    h.state.claims = { stripeRole: 'pro' };
    h.state.persistedUser = fakeUser();
    await service.ensureSignedIn();
    await settle();
    expect(service.isProUser()).toBe(true);

    h.state.forcedRefreshError = new Error('network blip');
    await service.refreshIdToken();

    expect(service.isProUser()).toBe(true);
  });
});

describe('AuthService OAuth upgrade fallbacks', () => {
  it('a dismissed popup is not an error', async () => {
    const service = setup();
    await service.ensureSignedIn();
    await settle();
    h.state.popupError = Object.assign(new Error('closed'), {
      code: 'auth/popup-closed-by-user',
    });

    await expect(service.signInWithOAuth('google.com')).resolves.toBeUndefined();
  });

  it('falls back to signing in with the credential the failed link produced', async () => {
    // The anonymous-upgrade path when the credential already belongs to an
    // account: the error carries the credential the user just produced, so no
    // second popup is needed.
    const service = setup();
    await service.ensureSignedIn();
    await settle();
    const credential = { fromError: true };
    h.state.errorCredential = credential;
    h.state.popupError = Object.assign(new Error('in use'), {
      code: 'auth/credential-already-in-use',
    });

    await service.signInWithOAuth('google.com');

    expect(h.state.calls).toContain('signInWithCredential');
    expect(h.state.lastCredential).toBe(credential);
    expect(h.state.calls.filter((c) => c === 'signInWithPopup')).toEqual([]);
  });
});
