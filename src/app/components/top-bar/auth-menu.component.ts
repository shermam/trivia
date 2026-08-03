import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Output,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  AuthService,
  OAUTH_PROVIDER_LABELS,
  OAuthProviderId,
  PROMINENT_OAUTH_PROVIDERS,
  SECONDARY_OAUTH_PROVIDERS,
} from '../../services/auth.service';
import { SubscriptionService } from '../../services/subscription.service';
import { ProviderIconComponent } from './provider-icon.component';

type EmailFormMode = 'signup' | 'signin';

@Component({
  selector: 'app-auth-menu',
  standalone: true,
  imports: [FormsModule, ProviderIconComponent, RouterLink],
  templateUrl: './auth-menu.component.html',
  styleUrl: './auth-menu.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthMenuComponent {
  protected readonly authService = inject(AuthService);
  protected readonly subscriptionService = inject(SubscriptionService);

  @Output() closeRequested = new EventEmitter<void>();

  protected readonly prominentProviders = PROMINENT_OAUTH_PROVIDERS;
  protected readonly secondaryProviders = SECONDARY_OAUTH_PROVIDERS;
  protected readonly providerLabels = OAUTH_PROVIDER_LABELS;

  protected readonly emailFormMode = signal<EmailFormMode>('signup');
  protected readonly showMoreProviders = signal(false);
  protected readonly isSubmitting = signal(false);
  protected readonly isOpeningPortal = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly infoMessage = signal<string | null>(null);

  protected email = '';
  protected password = '';
  protected readonly nameDraft = signal('');

  constructor() {
    // Keep the profile name field in sync with the authenticated user,
    // without clobbering in-progress edits on unrelated re-renders.
    effect(() => {
      const user = this.authService.user();
      this.nameDraft.set(user?.displayName ?? '');
    });
  }

  protected toggleEmailFormMode(): void {
    this.emailFormMode.set(this.emailFormMode() === 'signup' ? 'signin' : 'signup');
    this.errorMessage.set(null);
  }

  protected toggleMoreProviders(): void {
    this.showMoreProviders.set(!this.showMoreProviders());
  }

  protected async submitEmailForm(): Promise<void> {
    if (this.isSubmitting()) {
      return;
    }
    this.isSubmitting.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);

    try {
      if (this.emailFormMode() === 'signup') {
        await this.authService.signUpWithEmail(this.email, this.password);
        this.infoMessage.set("Account created! We've sent a verification link to your email.");
      } else {
        await this.authService.signInWithEmail(this.email, this.password);
        this.closeRequested.emit();
      }
      this.password = '';
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'Something went wrong.');
    } finally {
      this.isSubmitting.set(false);
    }
  }

  protected async continueWithProvider(providerId: OAuthProviderId): Promise<void> {
    if (this.isSubmitting()) {
      return;
    }
    this.isSubmitting.set(true);
    this.errorMessage.set(null);

    try {
      await this.authService.signInWithOAuth(providerId);
      this.closeRequested.emit();
    } catch (error) {
      this.errorMessage.set(error instanceof Error ? error.message : 'Something went wrong.');
    } finally {
      this.isSubmitting.set(false);
    }
  }

  protected async resendVerification(): Promise<void> {
    this.errorMessage.set(null);
    this.infoMessage.set(null);
    try {
      await this.authService.resendVerificationEmail();
      this.infoMessage.set('Verification email sent — check your inbox.');
    } catch {
      this.errorMessage.set('Could not send the verification email. Please try again.');
    }
  }

  protected async saveDisplayName(): Promise<void> {
    const name = this.nameDraft().trim();
    if (!name) {
      return;
    }
    try {
      await this.authService.updateDisplayName(name);
    } catch {
      this.errorMessage.set('Could not update your name. Please try again.');
    }
  }

  protected async manageSubscription(): Promise<void> {
    if (this.isOpeningPortal()) {
      return;
    }
    this.isOpeningPortal.set(true);
    this.errorMessage.set(null);
    try {
      // Redirects the page to the Stripe billing portal on success, so
      // there's nothing further to do here in the happy path.
      await this.subscriptionService.openBillingPortal();
    } catch {
      this.errorMessage.set('Could not open the billing portal. Please try again.');
      this.isOpeningPortal.set(false);
    }
  }

  protected async signOut(): Promise<void> {
    await this.authService.signOut();
    this.closeRequested.emit();
  }
}
