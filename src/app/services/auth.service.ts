import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { Auth, User } from 'firebase/auth';
import { environment } from '../../environments/environment';
import { isAliasEmail } from '../utils/email-alias.util';
import { giveUpAfter } from '../utils/give-up-after.util';
import { nextAnonymousRetryDelayMs } from '../utils/sign-in-retry.util';
import { FirebaseAppService } from './firebase-app.service';

const ANONYMOUS_SIGN_IN_TIMEOUT_MS = 10_000;
const AUTH_EMULATOR_URL = 'http://127.0.0.1:9099';

/** OAuth providers with a working Firebase Web SDK implementation. */
export type OAuthProviderId =
  | 'google.com'
  | 'facebook.com'
  | 'github.com'
  | 'microsoft.com'
  | 'apple.com'
  | 'twitter.com'
  | 'yahoo.com';

export const PROMINENT_OAUTH_PROVIDERS: readonly OAuthProviderId[] = ['google.com'];

/**
 * Play Games and Game Center are listed in the Firebase console but have no
 * Web SDK equivalent — they only work from native Android/Apple apps — so
 * they're intentionally left out here rather than shown as dead buttons.
 */
export const SECONDARY_OAUTH_PROVIDERS: readonly OAuthProviderId[] = [
  'facebook.com',
  'github.com',
  'microsoft.com',
  'apple.com',
  'twitter.com',
  'yahoo.com',
];

export const OAUTH_PROVIDER_LABELS: Record<OAuthProviderId, string> = {
  'google.com': 'Google',
  'facebook.com': 'Facebook',
  'github.com': 'GitHub',
  'microsoft.com': 'Microsoft',
  'apple.com': 'Apple',
  'twitter.com': 'Twitter / X',
  'yahoo.com': 'Yahoo',
};

type AuthModule = typeof import('firebase/auth');

function friendlyAuthErrorMessage(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case 'auth/operation-not-allowed':
      return "This sign-in method isn't enabled yet.";
    case 'auth/email-already-in-use':
      return 'An account with this email already exists. Try signing in instead.';
    case 'auth/invalid-email':
      return 'That email address looks invalid.';
    case 'auth/weak-password':
      return 'Choose a stronger password (at least 6 characters).';
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'Incorrect email or password.';
    case 'auth/user-not-found':
      return 'No account found with this email.';
    case 'auth/credential-already-in-use':
      return 'This account is already linked to another user.';
    case 'auth/network-request-failed':
      return 'Network error. Please check your connection and try again.';
    // The OAuth popup's own failure modes. Each of these has a single,
    // checkable meaning, so naming it is not narrating an unverified cause —
    // and each is something the person in front of the screen can act on,
    // which "something went wrong" is not.
    case 'auth/popup-blocked':
      return 'Your browser blocked the sign-in popup. Allow popups for this site, then try again.';
    case 'auth/account-exists-with-different-credential':
      return 'An account with this email already exists, created with a different sign-in method.';
    case 'auth/user-disabled':
      return 'This account has been disabled.';
    case 'auth/unauthorized-domain':
      return "Sign-in isn't allowed from this address yet.";
    case 'auth/operation-not-supported-in-this-environment':
      return "This browser can't complete that sign-in method.";
    default:
      // The message stays deliberately vague, because the codes that reach
      // here are broad ones — `auth/internal-error` covers everything from a
      // transient backend hiccup to a resource the popup resolver could not
      // load — and inventing a story for them would be false whenever the
      // real cause was something else (`CLAUDE.md` §4.4).
      //
      // Vague to the user must not mean lost to whoever has to fix it,
      // though, and it was: Google sign-in failed intermittently for weeks
      // with no artefact but this sentence, because the code behind it was
      // discarded on this line. It turned out to be the service worker
      // re-fetching `apis.google.com/js/api.js` under a `connect-src` that
      // did not list it (`scripts/verify-csp.mjs`). The one line below is
      // what would have named it on day one.
      console.error(`[auth] unhandled ${code ?? 'error without a code'}`, error);
      return 'Something went wrong. Please try again.';
  }
}

/** Popup was dismissed by the user — not a real error, don't surface anything. */
function isUserCancelledPopup(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request';
}

/**
 * The two ways linking an OAuth credential to the anonymous session fails
 * because the account it names already exists. Both are recoverable the same
 * way — sign in as that account with the credential the popup just produced —
 * so `signInWithOAuth` handles them in one branch.
 *
 * - `credential-already-in-use`: this exact provider account (`FEDERATED_USER_ID_ALREADY_LINKED`)
 *   is linked to a different uid.
 * - `email-already-in-use`: the provider's **email address** belongs to
 *   another account, which under this project's "one account per email"
 *   setting is enough for the server to refuse the link (`EMAIL_EXISTS`).
 *   In practice that other account is an email/password one, and this used to
 *   fall through to "An account with this email already exists. Try signing in
 *   instead." — a dead end offered to somebody who was *already* trying to
 *   sign in. It reached the owner's own account: his Google address had a
 *   password account here, so "Continue with Google" could not get him in at
 *   all. The friendly sentence is still right for the sign-up form it was
 *   written for; it was only ever wrong on this path.
 *
 * Both errors are tagged by the SDK with the IdP response (`customData._tokenResponse`),
 * which is what `credentialFromError` reads — the popup and link strategies
 * always request it (`returnIdpCredential: true`), so the credential is
 * normally there and the fallback popup below is genuinely a rare case.
 */
function isExistingAccountConflict(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'auth/credential-already-in-use' || code === 'auth/email-already-in-use';
}

/**
 * Thin wrapper around the Firebase modular Auth SDK (dynamically imported,
 * same lazy-load convention as FirebaseService). Every player gets an
 * anonymous uid on load with zero friction; signing in with a real provider
 * upgrades that same uid in place (via linking) whenever possible, so
 * anything already saved under it carries forward.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly firebaseAppService = inject(FirebaseAppService);

  private authPromise: Promise<{ auth: Auth; authModule: AuthModule }> | null = null;

  // Firebase `User` instances are mutated in place by the SDK (e.g. after
  // updateProfile/reload), so this signal must always notify on `.set()`
  // regardless of referential equality — otherwise consumers wouldn't see
  // updates like a changed displayName.
  private readonly userSignal = signal<User | null>(null, { equal: () => false });
  private readonly authReadySignal = signal(false);
  // Populated from the `stripeRole` custom claim our Cloud Functions backend
  // (functions/src/subscriptions.ts) sets on the ID token once a Pro
  // subscription is active. Custom claims don't change on their own once
  // cached by the SDK — see `refreshIdToken()`, called by SubscriptionService
  // whenever a read of the subscription documents first shows one active, so
  // this doesn't have to wait for the token's natural ~1hr refresh.
  private readonly stripeRoleSignal = signal<string | null>(null);

  /**
   * Whether the `stripeRole` claim above has been *looked at* yet — as
   * distinct from what it says.
   *
   * `authReady()` is not this. It flips as soon as `onAuthStateChanged`
   * delivers a user, and the claim is read from that user's ID token a beat
   * later, so there is a real window in which auth is "ready" and a paying
   * subscriber still reads as not Pro. That window used to be invisible
   * because everything auth-shaped resolved during bootstrap; since the
   * bootstrap moved off the critical path (`FEAT-017` §3.2) it is up to two
   * seconds long, and anything that renders one thing for a subscriber and
   * another for a free player has to wait for this rather than for
   * `authReady()`, or it shows the free-tier answer to somebody who paid
   * (`CLAUDE.md` §4.4 — default to the least alarming outcome while the data
   * is still loading).
   *
   * True also means "and the answer may be nobody": a failed bootstrap and a
   * signed-out visitor both settle here, because in both cases the claim is
   * as known as it is ever going to be.
   */
  private readonly proStatusReadySignal = signal(false);

  /** Resolves `proStatusReadyPromise`; declared first so the field below can capture it. */
  private resolveProStatusReady: () => void = () => undefined;

  /**
   * The promise half of `proStatusReady`, for a caller that has to make a
   * decision rather than render one.
   *
   * A deferred rather than "await `authStateReady()`, then await the claim
   * read", which is the obvious shape and is subtly racy: `authStateReady()`
   * resolves as soon as `auth.currentUser` is populated, while the SDK
   * delivers `onAuthStateChanged` to its own listeners in a microtask — so the
   * listener that *starts* the claim read is not guaranteed to have run, and a
   * waiter can sail past a read that has not begun. Resolved wherever
   * `proStatusReadySignal` is set (`markProStatusReady`), so the promise and
   * the signal cannot disagree.
   *
   * It settles on the **first** answer, which is the window this exists for —
   * the seconds after a cold load. A later sign-in re-reads the claim and
   * moves the signal, and a caller mid-flight there is inside a round trip it
   * just initiated rather than inside a bootstrap it never saw.
   */
  private readonly proStatusReadyPromise = new Promise<void>((resolve) => {
    this.resolveProStatusReady = resolve;
  });

  /**
   * The anonymous sign-in currently in flight, so two callers share one.
   *
   * Cleared however it settles, which is the half that matters: a memoised
   * **failure** is the thing `CLAUDE.md` §4.4 is about, and this promise is
   * reached by every retry below as well as by every gesture, so holding a
   * settled one would turn a single bad round trip into a permanent answer.
   * It exists only to stop a timer firing beside a click from asking Firebase
   * for two accounts at once.
   */
  private signInAttempt: Promise<void> | null = null;

  /** Attempts that have failed since the last success — the retry's position in the schedule. */
  private failedSignInAttempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Removes the `online`/`visibilitychange` listeners; null when none are attached. */
  private detachRetryListeners: (() => void) | null = null;

  // `signOut()` immediately re-anonymizes (see below), but Firebase always
  // fires `onAuthStateChanged(null)` for the sign-out itself before the
  // follow-up anonymous sign-in's callback lands. Without suppressing that
  // one known-transient `null`, every `user()`-derived signal (isAnonymous,
  // isFullyAuthenticated) briefly reads as "signed in, unverified", which
  // flashed a "Verify your email" prompt on logout.
  private suppressNextNullState = false;

  readonly user = this.userSignal.asReadonly();
  readonly authReady = this.authReadySignal.asReadonly();
  readonly proStatusReady = this.proStatusReadySignal.asReadonly();
  readonly isProUser = computed(() => this.stripeRoleSignal() === 'pro');

  readonly isAnonymous = computed(() => this.user()?.isAnonymous ?? false);

  readonly isEmailPasswordAccount = computed(
    () => this.user()?.providerData.some((p) => p.providerId === 'password') ?? false,
  );

  readonly isEmailVerified = computed(() => this.user()?.emailVerified ?? false);

  constructor() {
    // A root service is destroyed only when the whole injector is — the page
    // going away, or a unit test tearing its `TestBed` down — so this is the
    // one moment a pending retry and the two listeners behind it have an
    // owner that no longer exists (`CLAUDE.md` §4.4: every timer and listener
    // has a teardown).
    inject(DestroyRef).onDestroy(() => this.stopRetryingSignIn());
  }

  /** Mirrors the Firestore rules' anti-cheat gate: signed in, not anonymous,
   * and (not a password account, or verified). Used to gate leaderboard UI. */
  readonly isFullyAuthenticated = computed(() => {
    const user = this.user();
    if (!user || user.isAnonymous) {
      return false;
    }
    return !this.isEmailPasswordAccount() || user.emailVerified;
  });

  private getAuth() {
    if (!this.authPromise) {
      this.authPromise = Promise.all([
        import('firebase/auth'),
        this.firebaseAppService.getApp(),
      ]).then(([authModule, app]) => {
        // Deliberately `initializeAuth` (not the `getAuth` convenience
        // wrapper) with no `popupRedirectResolver`: `getAuth` wires one in
        // unconditionally, which eagerly loads a third-party iframe on
        // `firebaseapp.com` (plus Google's gapi.js) for every visitor to
        // check for a pending redirect result — even the vast majority who
        // only ever play anonymously and never touch OAuth. That iframe is
        // exactly what Lighthouse's "third-party cookies" best-practices
        // audit flags in browsers that don't block third-party cookies.
        // `signInWithOAuth` below passes the resolver explicitly instead, so
        // it's only ever loaded for someone actually using it.
        const auth = authModule.initializeAuth(app, {
          persistence: authModule.browserLocalPersistence,
        });
        if (environment.useEmulators) {
          authModule.connectAuthEmulator(auth, AUTH_EMULATOR_URL, { disableWarnings: true });
        }
        authModule.onAuthStateChanged(auth, (user) => {
          if (user === null && this.suppressNextNullState) {
            return;
          }
          this.suppressNextNullState = false;
          this.userSignal.set(user);
          this.authReadySignal.set(true);
          void this.loadStripeRoleClaim(authModule, user);
        });
        return { auth, authModule };
      });

      // **Never cache a rejected promise** (`CLAUDE.md` §4.4). Without this,
      // one failed dynamic import of `firebase/auth` — or one runtime-config
      // fetch that times out — is memoised for the life of the tab: every
      // later call reuses the rejection, so `onAuthStateChanged` is never
      // registered, `authReadySignal` is never set, and auth is permanently
      // dead. `FirebaseAppService.getApp()` and
      // `SubscriptionService.getProPrices()` both already clear on failure;
      // this one was missed.
      this.authPromise.catch(() => {
        this.authPromise = null;

        // And *say so*, rather than leaving `authReady()` false forever.
        //
        // It is only ever set from inside the `onAuthStateChanged` callback
        // above, which now will never run — so the account chip would sit on
        // its loading skeleton indefinitely, pulsing at a user whose auth is
        // never coming. "Ready, and nobody is signed in" is the true statement
        // once the attempt has failed, and `showsRealAccount()` renders that
        // as the "Sign in" prompt: an affordance that retries on click, rather
        // than a spinner that cannot.
        //
        // Note this widens what `authReady()` asserts, from "auth resolved" to
        // "we know the answer, and the answer may be nobody". Everything
        // gating on it wants the second meaning — see `docs/app.md`.
        this.authReadySignal.set(true);
        // Same reasoning one level down: there is no claim coming either, and
        // a consumer waiting to be told what the entitlement is would wait
        // forever rather than fall back to the free-tier answer.
        this.markProStatusReady();
      });
    }
    return this.authPromise;
  }

  /**
   * Resolves once Firebase Auth has finished restoring a persisted session.
   *
   * **The token is not attached until this settles**, which is what makes it
   * load-bearing rather than tidy: `auth.currentUser` reads `null` for a
   * moment after `getAuth()` even for a returning, already-signed-in user
   * (persistence restores asynchronously — see `ensureSignedIn` below, which
   * documents the same trap for a different symptom). A callable invoked
   * inside that window is sent with **no** ID token, so it arrives
   * unauthenticated and is refused, silently.
   *
   * That is not hypothetical: it is how the first `recordGameResult` call
   * behaved on a freshly loaded `/game-over` — and reloading `/game-over` is a
   * supported flow, so the effect was that a real player's game could be
   * silently dropped from their totals.
   *
   * Swallows its own failures for the same reason `ensureSignedIn` does: a
   * caller that cannot reach auth should degrade, not reject.
   */
  async whenAuthStateReady(): Promise<void> {
    try {
      const { auth } = await this.getAuth();
      await auth.authStateReady();
    } catch {
      // Offline or unreachable. The caller decides what to do without auth.
    }
  }

  /**
   * Makes sure this visitor has a session, anonymous if nothing else, and
   * keeps trying when the attempt fails.
   *
   * **Called once at app bootstrap, without the caller awaiting or catching**
   * (see `App`'s constructor) — so every failure mode here, including the
   * runtime-config fetch inside `getAuth()`, is swallowed internally rather
   * than left to reject as an unhandled promise. A visitor who cannot reach
   * Firebase still gets a fully playable game; that part is deliberate and
   * unchanged.
   *
   * **What was missing is that nothing came after the swallow.** The one
   * attempt bootstrap makes is deferred to the first idle moment after paint
   * (`docs/app.md` §1.5), and on `/` and `/play` there is no second caller —
   * the others are gestures (`AuthMenuStateService`,
   * `DonationDialogStateService`) and `signOut()`. So a single dropped round
   * trip, or one that ran past the ten seconds `giveUpAfter` allows it, left
   * the tab with **no uid for the rest of its life**: every later game was
   * unsaveable, and the reader was told only at the moment they tried to save
   * a score. It is invisible against the emulator, where the round trip is a
   * millisecond, and the preview suite is where it surfaced — twice in two
   * runs, on whichever test happened to be holding it
   * (`e2e/specs/unauthenticated/test-isolation.spec.ts`).
   *
   * So a failed attempt now schedules the next one
   * (`nextAnonymousRetryDelayMs`) and listens for the two events that mean
   * "the thing that was wrong may have stopped being wrong" — coming back
   * online, and the tab becoming visible again after the browser has had it
   * in the background. A give-up counts as a failure, because from here it is
   * indistinguishable from one.
   */
  async ensureSignedIn(): Promise<void> {
    // `??=` rather than a fresh attempt per call: a scheduled retry, an
    // `online` event and a click on the auth menu can land together, and
    // three concurrent `signInAnonymously()` calls would mint three accounts.
    this.signInAttempt ??= this.attemptSignIn().finally(() => {
      this.signInAttempt = null;
    });
    await this.signInAttempt;
  }

  /** One attempt, with every outcome funnelled into "stop" or "try again". */
  private async attemptSignIn(): Promise<void> {
    try {
      const { auth, authModule } = await this.getAuth();
      // `auth.currentUser` can still read `null` right after `getAuth()`
      // even for a returning, already-signed-in user — persistence restores
      // it asynchronously. Without this, a slow IndexedDB read loses the
      // race and this method mints a throwaway anonymous session on top of
      // (or instead of) the one being restored.
      await auth.authStateReady();
      if (!auth.currentUser) {
        await giveUpAfter(authModule.signInAnonymously(auth), ANONYMOUS_SIGN_IN_TIMEOUT_MS);
      }
      // A restored session counts as success as much as a minted one: either
      // way there is a uid, which is the whole question.
      this.failedSignInAttempts = 0;
      this.stopRetryingSignIn();
    } catch {
      this.scheduleSignInRetry();
    }
  }

  /**
   * Arms the next attempt, or stops once the schedule is spent.
   *
   * Note what is *not* reset when it stops: `failedSignInAttempts` keeps
   * counting, so a gesture that fails afterwards attempts and fails without
   * re-arming a schedule that has already been judged hopeless. Gestures
   * themselves never stop working — they call `ensureSignedIn()` directly.
   */
  private scheduleSignInRetry(): void {
    this.failedSignInAttempts += 1;
    const delay = nextAnonymousRetryDelayMs(this.failedSignInAttempts);
    if (delay === null) {
      this.stopRetryingSignIn();
      return;
    }
    this.listenForSignInRecovery();
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.ensureSignedIn();
    }, delay);
  }

  /**
   * The two events worth interrupting the schedule for.
   *
   * Both are "the reason it failed may be over": a device that has just
   * reconnected, and a tab the reader has come back to — which matters
   * because a backgrounded tab has its timers throttled to roughly once a
   * minute, so the schedule above effectively pauses while nobody is looking
   * and the return is the moment to catch up.
   *
   * Attached only while a retry is pending and removed the moment one is not,
   * so the listeners cannot outlive the thing they exist to hurry along.
   */
  private listenForSignInRecovery(): void {
    if (this.detachRetryListeners) {
      return;
    }
    const retryNow = () => {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      // Safe beside an attempt already in flight: `ensureSignedIn()` hands
      // back the in-flight one rather than starting a second.
      void this.ensureSignedIn();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        retryNow();
      }
    };
    window.addEventListener('online', retryNow);
    document.addEventListener('visibilitychange', onVisibilityChange);
    this.detachRetryListeners = () => {
      window.removeEventListener('online', retryNow);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      this.detachRetryListeners = null;
    };
  }

  /** Cancels a pending attempt and everything holding the page open for it. */
  private stopRetryingSignIn(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.detachRetryListeners?.();
  }

  async signUpWithEmail(email: string, password: string): Promise<void> {
    if (isAliasEmail(email)) {
      throw new Error(
        'Email aliases (e.g. "name+tag@domain.com") aren\'t allowed. Please use your plain email address.',
      );
    }

    const { auth, authModule } = await this.getAuth();
    try {
      if (auth.currentUser?.isAnonymous) {
        const credential = authModule.EmailAuthProvider.credential(email, password);
        // Linking mutates the existing (same-uid) user in place rather than
        // firing `onAuthStateChanged` — without this, `isAnonymous` etc. would
        // stay stale in the UI until some unrelated auth event happened to
        // refire the listener.
        await authModule.linkWithCredential(auth.currentUser, credential);
        this.userSignal.set(auth.currentUser);
      } else {
        await authModule.createUserWithEmailAndPassword(auth, email, password);
      }
      if (auth.currentUser) {
        await authModule.sendEmailVerification(auth.currentUser);
      }
    } catch (error) {
      throw new Error(friendlyAuthErrorMessage(error), { cause: error });
    }
  }

  async signInWithEmail(email: string, password: string): Promise<void> {
    const { auth, authModule } = await this.getAuth();
    try {
      await authModule.signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      throw new Error(friendlyAuthErrorMessage(error), { cause: error });
    }
  }

  /**
   * Sends the password-reset email (finding H1 — without it, an
   * email/password user who forgets is locked out of a paid subscription).
   * `auth/user-not-found` deliberately resolves as if it succeeded: whether
   * an address has an account is not something this form should disclose (an
   * enumeration oracle), and the caller's neutral "if an account exists…"
   * message is truthful either way. Real transport failures still throw,
   * mapped to friendly text.
   */
  async sendPasswordReset(email: string): Promise<void> {
    const { auth, authModule } = await this.getAuth();
    try {
      await authModule.sendPasswordResetEmail(auth, email);
    } catch (error) {
      if ((error as { code?: string } | null)?.code === 'auth/user-not-found') {
        return;
      }
      throw new Error(friendlyAuthErrorMessage(error), { cause: error });
    }
  }

  async resendVerificationEmail(): Promise<void> {
    const { auth, authModule } = await this.getAuth();
    if (auth.currentUser) {
      await authModule.sendEmailVerification(auth.currentUser);
    }
  }

  /**
   * Tries to upgrade the current anonymous session in place with
   * `linkWithPopup` so the uid (and anything saved under it) is preserved.
   * If the account that credential names already exists — either the provider
   * account itself or just its email address (see `isExistingAccountConflict`)
   * — Firebase's error carries the exact credential the user just produced in
   * the popup (`error.customData`), so we sign in with that directly via
   * `signInWithCredential` instead of making the user pick their account a
   * second time in a fresh popup. That switches uid, which is the trade the
   * anonymous session loses: there is no merging two accounts.
   */
  async signInWithOAuth(providerId: OAuthProviderId): Promise<void> {
    const { auth, authModule } = await this.getAuth();
    const provider = this.createProvider(authModule, providerId);

    try {
      if (auth.currentUser?.isAnonymous) {
        // Same in-place mutation caveat as the email/password link path above.
        await authModule.linkWithPopup(
          auth.currentUser,
          provider,
          authModule.browserPopupRedirectResolver,
        );
        this.userSignal.set(auth.currentUser);
      } else {
        await authModule.signInWithPopup(auth, provider, authModule.browserPopupRedirectResolver);
      }
    } catch (error) {
      if (isUserCancelledPopup(error)) {
        return;
      }
      if (isExistingAccountConflict(error)) {
        const credential = this.credentialFromError(authModule, providerId, error);
        try {
          if (credential) {
            await authModule.signInWithCredential(auth, credential);
          } else {
            // Fallback for the rare case the SDK didn't attach a credential
            // to the error — only path left is asking the user to pick
            // their account again in a fresh popup.
            await authModule.signInWithPopup(
              auth,
              provider,
              authModule.browserPopupRedirectResolver,
            );
          }
          return;
        } catch (retryError) {
          if (isUserCancelledPopup(retryError)) {
            return;
          }
          throw new Error(friendlyAuthErrorMessage(retryError), { cause: retryError });
        }
      }
      throw new Error(friendlyAuthErrorMessage(error), { cause: error });
    }
  }

  async updateDisplayName(name: string): Promise<void> {
    const { auth, authModule } = await this.getAuth();
    if (!auth.currentUser) {
      return;
    }
    await authModule.updateProfile(auth.currentUser, { displayName: name });
    this.userSignal.set(auth.currentUser);
  }

  async signOut(): Promise<void> {
    const { auth, authModule } = await this.getAuth();
    this.suppressNextNullState = true;
    try {
      await authModule.signOut(auth);
      await this.ensureSignedIn();
    } finally {
      this.suppressNextNullState = false;
    }
    // If re-anonymizing above didn't land (e.g. offline), the suppressed
    // `null` from signOut() was never applied — push it through now so the
    // UI reflects the real signed-out state instead of staying stuck on the
    // just-signed-out account.
    if (!auth.currentUser) {
      this.userSignal.set(null);
      this.authReadySignal.set(true);
      void this.loadStripeRoleClaim(authModule, null);
    }
  }

  /**
   * The current user's ID token, or `null` when nobody is signed in.
   *
   * This is what a Firestore REST call puts in its `Authorization: Bearer`
   * header. `FIRESTORE_SDK_VS_REST.md` §7 flags manual token handling as one
   * of the two likely sources of a quiet bug in the migration, and it is worth
   * being precise about how much of that risk actually lands here: **the Auth
   * SDK stays**, and `getIdToken()` already returns a cached token and
   * re-mints it when it is within five minutes of expiring. Expiry and refresh
   * are therefore still the SDK's job. The manual part is only attaching the
   * header.
   *
   * `authStateReady()` for the same reason `ensureSignedIn` awaits it:
   * `currentUser` reads `null` for a moment while persistence restores a
   * returning session, and a read that lost that race would go out
   * unauthenticated and be refused by rules that were going to allow it.
   *
   * Returns `null` rather than throwing when signed out — the public
   * collections (`custom_questions`, `products`, the leaderboards) are
   * readable with no token at all, so an anonymous-sign-in that has not landed
   * yet should not fail a read that never needed it.
   */
  async getIdToken(): Promise<string | null> {
    const { auth } = await this.getAuth();
    await auth.authStateReady();
    return (await auth.currentUser?.getIdToken()) ?? null;
  }

  private async loadStripeRoleClaim(authModule: AuthModule, user: User | null): Promise<void> {
    if (!user) {
      this.stripeRoleSignal.set(null);
      this.markProStatusReady();
      return;
    }
    try {
      const result = await authModule.getIdTokenResult(user);
      this.stripeRoleSignal.set((result.claims['stripeRole'] as string | undefined) ?? null);
    } catch {
      this.stripeRoleSignal.set(null);
    } finally {
      // `finally`, because a failed read is still an answer: "not Pro, as far
      // as anyone can tell". Leaving it unset would hang every consumer that
      // waits for the entitlement to be known on a transient token error.
      this.markProStatusReady();
    }
  }

  /** The one place the entitlement stops being unknown, in both of its forms. */
  private markProStatusReady(): void {
    this.proStatusReadySignal.set(true);
    this.resolveProStatusReady();
  }

  /**
   * Resolves once the `stripeRole` claim has been read for whoever is signed
   * in — the promise form of `proStatusReady`, for a caller that has to make a
   * decision rather than render one.
   *
   * Starts the bootstrap if nothing else has, since the caller is asking a
   * question only the bootstrap can answer, and swallows its failures for the
   * same reason `whenAuthStateReady()` does: a caller that cannot reach auth
   * should go on with the free-tier answer, not reject. The runtime-config
   * fetch is bounded by its own `AbortSignal.timeout`, so a connection that
   * never settles *there* still resolves this; the one half nothing bounds is
   * the `firebase/auth` chunk import stalling without failing, which is the
   * same exposure every other consumer of the bootstrap already has.
   */
  async whenProStatusReady(): Promise<void> {
    await this.whenAuthStateReady();
    await this.proStatusReadyPromise;
  }

  /**
   * Forces the cached ID token to be re-minted so a just-granted `stripeRole`
   * custom claim (set server-side by our Stripe webhook handler after a
   * successful checkout) is picked up without waiting for the SDK's natural ~1hr
   * refresh. Called by SubscriptionService the first time a read shows the
   * user's subscription active — not on a timer, so it only ever fires when
   * there is actually something new to pick up.
   */
  async refreshIdToken(): Promise<void> {
    const { auth, authModule } = await this.getAuth();
    if (!auth.currentUser) {
      return;
    }
    try {
      const result = await authModule.getIdTokenResult(auth.currentUser, /* forceRefresh */ true);
      this.stripeRoleSignal.set((result.claims['stripeRole'] as string | undefined) ?? null);
    } catch {
      // Leave the previous claim value in place — a transient refresh
      // failure shouldn't demote a user who was already known to be Pro.
    }
  }

  private createProvider(authModule: AuthModule, providerId: OAuthProviderId) {
    switch (providerId) {
      case 'google.com':
        return new authModule.GoogleAuthProvider();
      case 'facebook.com':
        return new authModule.FacebookAuthProvider();
      case 'github.com':
        return new authModule.GithubAuthProvider();
      case 'twitter.com':
        return new authModule.TwitterAuthProvider();
      default:
        return new authModule.OAuthProvider(providerId);
    }
  }

  /** Mirrors `createProvider`'s mapping — each provider class's static
   * `credentialFromError` knows how to read its own shape out of
   * `error.customData`. */
  private credentialFromError(authModule: AuthModule, providerId: OAuthProviderId, error: unknown) {
    const firebaseError = error as import('firebase/auth').AuthError;
    switch (providerId) {
      case 'google.com':
        return authModule.GoogleAuthProvider.credentialFromError(firebaseError);
      case 'facebook.com':
        return authModule.FacebookAuthProvider.credentialFromError(firebaseError);
      case 'github.com':
        return authModule.GithubAuthProvider.credentialFromError(firebaseError);
      case 'twitter.com':
        return authModule.TwitterAuthProvider.credentialFromError(firebaseError);
      default:
        return authModule.OAuthProvider.credentialFromError(firebaseError);
    }
  }
}
