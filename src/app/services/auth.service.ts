import { Injectable, computed, inject, signal } from '@angular/core';
import type { Auth, User } from 'firebase/auth';
import { environment } from '../../environments/environment';
import { isAliasEmail } from '../utils/email-alias.util';
import { withTimeout } from '../utils/with-timeout.util';
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
    default:
      return 'Something went wrong. Please try again.';
  }
}

/** Popup was dismissed by the user — not a real error, don't surface anything. */
function isUserCancelledPopup(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request';
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

  readonly user = this.userSignal.asReadonly();
  readonly authReady = this.authReadySignal.asReadonly();

  readonly isAnonymous = computed(() => this.user()?.isAnonymous ?? false);

  readonly isEmailPasswordAccount = computed(
    () => this.user()?.providerData.some((p) => p.providerId === 'password') ?? false,
  );

  readonly isEmailVerified = computed(() => this.user()?.emailVerified ?? false);

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
          this.userSignal.set(user);
          this.authReadySignal.set(true);
        });
        return { auth, authModule };
      });
    }
    return this.authPromise;
  }

  /**
   * Called once at app bootstrap, without the caller awaiting or catching
   * (see `App`'s constructor) — so every failure mode here, including the
   * runtime-config fetch inside `getAuth()`, must be swallowed internally
   * rather than left to reject as an unhandled promise.
   */
  async ensureSignedIn(): Promise<void> {
    try {
      const { auth, authModule } = await this.getAuth();
      // `auth.currentUser` can still read `null` right after `getAuth()`
      // even for a returning, already-signed-in user — persistence restores
      // it asynchronously. Without this, a slow IndexedDB read loses the
      // race and this method mints a throwaway anonymous session on top of
      // (or instead of) the one being restored.
      await auth.authStateReady();
      if (auth.currentUser) {
        return;
      }
      await withTimeout(authModule.signInAnonymously(auth), ANONYMOUS_SIGN_IN_TIMEOUT_MS);
    } catch {
      // Offline or otherwise unreachable — the game stays fully playable,
      // just without the ability to save to the leaderboard until this
      // resolves (retried automatically next time ensureSignedIn runs).
    }
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
      throw new Error(friendlyAuthErrorMessage(error));
    }
  }

  async signInWithEmail(email: string, password: string): Promise<void> {
    const { auth, authModule } = await this.getAuth();
    try {
      await authModule.signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      throw new Error(friendlyAuthErrorMessage(error));
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
   * If that provider credential already belongs to an existing account,
   * falls back to a fresh `signInWithPopup` — accepting one extra popup in
   * that edge case to keep this provider-agnostic across all 7 providers.
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
      if ((error as { code?: string }).code === 'auth/credential-already-in-use') {
        try {
          await authModule.signInWithPopup(auth, provider, authModule.browserPopupRedirectResolver);
          return;
        } catch (retryError) {
          if (isUserCancelledPopup(retryError)) {
            return;
          }
          throw new Error(friendlyAuthErrorMessage(retryError));
        }
      }
      throw new Error(friendlyAuthErrorMessage(error));
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
    await authModule.signOut(auth);
    await this.ensureSignedIn();
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
}
