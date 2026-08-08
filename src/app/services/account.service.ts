import { Injectable, inject } from '@angular/core';
import { environment } from '../../environments/environment';
import { withTimeout } from '../utils/with-timeout.util';
import { AuthService } from './auth.service';
import { FirebaseAppService } from './firebase-app.service';

const FUNCTIONS_EMULATOR_HOST = '127.0.0.1';
const FUNCTIONS_EMULATOR_PORT = 5001;

/**
 * Account deletion spans Stripe, Auth, the leaderboard and the question bank,
 * and touches documents `firestore.rules` deliberately forbids the client from
 * writing — `leaderboard` has no delete rule at all, `custom_questions` is
 * create-only. None of that can be done from here, so this is a thin wrapper
 * around the `deleteAccount` callable, which does the work with the Admin SDK.
 *
 * Deliberately generous: 60s, rather than the 10s the Firestore reads use. The
 * function makes several Stripe round-trips and batched Firestore writes, and
 * a client-side timeout does not cancel it — so timing out early would leave
 * the user staring at an error while their account is deleted anyway, which is
 * the worst possible outcome to report.
 */
const DELETE_ACCOUNT_TIMEOUT_MS = 60_000;

/** Read-only and cheaper than deletion, but still several Firestore round-trips. */
const EXPORT_TIMEOUT_MS = 30_000;

type FunctionsModule = typeof import('firebase/functions');

@Injectable({ providedIn: 'root' })
export class AccountService {
  private readonly firebaseAppService = inject(FirebaseAppService);
  private readonly authService = inject(AuthService);

  private functionsPromise: Promise<{
    functions: import('firebase/functions').Functions;
    functionsModule: FunctionsModule;
  }> | null = null;

  private getFunctions() {
    if (!this.functionsPromise) {
      this.functionsPromise = Promise.all([
        import('firebase/functions'),
        this.firebaseAppService.getApp(),
      ]).then(([functionsModule, app]) => {
        const functions = functionsModule.getFunctions(app);
        if (environment.useEmulators) {
          functionsModule.connectFunctionsEmulator(
            functions,
            FUNCTIONS_EMULATOR_HOST,
            FUNCTIONS_EMULATOR_PORT,
          );
        }
        return { functions, functionsModule };
      });
    }
    return this.functionsPromise;
  }

  /**
   * Fetches everything the app holds about the signed-in user and saves it as
   * a JSON file.
   *
   * The uid is never sent — the callable reads it from the verified token, so
   * a caller can only ever export themselves.
   *
   * The object URL is revoked in a `finally`: it pins the whole payload in
   * memory until released, and this one contains the user's personal data, so
   * leaving it reachable for the lifetime of the tab is exactly the wrong
   * thing to be careless about.
   */
  async downloadMyData(): Promise<void> {
    const { functions, functionsModule } = await this.getFunctions();
    const callable = functionsModule.httpsCallable<unknown, unknown>(
      functions,
      'exportAccountData',
    );
    const result = await withTimeout(
      callable(),
      EXPORT_TIMEOUT_MS,
      'Preparing your data is taking longer than expected.',
    );

    const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = 'trivimind-my-data.json';
      link.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Permanently deletes the signed-in account.
   *
   * The uid is never sent — the callable reads it from the verified token, so
   * a caller can only ever delete themselves. Passing it would create a
   * parameter that looks authoritative and isn't.
   *
   * On success the server-side Auth user is gone, which invalidates this
   * browser's token; `signOut()` clears the dead session and mints a fresh
   * anonymous one so the app is immediately usable rather than stuck holding
   * credentials for a user that no longer exists.
   */
  async deleteAccount(): Promise<void> {
    const { functions, functionsModule } = await this.getFunctions();
    const callable = functionsModule.httpsCallable(functions, 'deleteAccount');
    await withTimeout(
      callable(),
      DELETE_ACCOUNT_TIMEOUT_MS,
      'Deleting your account is taking longer than expected.',
    );
    await this.authService.signOut();
  }
}
