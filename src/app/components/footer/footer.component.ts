import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  viewChild,
} from '@angular/core';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { buildLabel } from '../../build-info';
import { DonationDialogStateService } from '../../services/donation-dialog-state.service';
import { DonationDialogComponent } from '../donation/donation-dialog.component';
import { IconComponent } from '../icon/icon.component';

/**
 * The route the donation CTA is excluded from, and the one screen in the app
 * with a zero-distraction rule: an active quiz round (`FEAT-013` §1).
 */
const GAMEPLAY_ROUTE = '/play';

/**
 * Site footer, carrying the legal links and the "Buy me a coffee" call to
 * action. Sits as a sibling of `<router-outlet>` alongside `TopBarComponent`
 * and is hidden in embed mode for the same reason the top bar is — an embedded
 * widget is a game panel, not a site. That gating is also why neither the CTA
 * nor the dialog needs an embed check of its own.
 *
 * The legal links have to be reachable from every screen: Stripe expects a
 * merchant's terms and privacy policy to be findable, and a policy nobody can
 * navigate to is not much better than not having one.
 *
 * **This component hosts the donation dialog**, which is opened from here and
 * from the auth menu at the other end of the page
 * (`DonationDialogStateService`). One mount point rather than two, so there is
 * never a second copy of a `role="dialog"` on the page, and it lives beside
 * the CTA because that is where focus returns when the dialog closes.
 */
@Component({
  selector: 'app-footer',
  standalone: true,
  imports: [RouterLink, DonationDialogComponent, IconComponent],
  templateUrl: './footer.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FooterComponent {
  private readonly router = inject(Router);
  private readonly dialogState = inject(DonationDialogStateService);

  protected readonly year = new Date().getFullYear();

  /**
   * Which build this is — hover the brand name to see it.
   *
   * Computed once at construction rather than in a signal: `--define`
   * substitutes a constant, so there is nothing here that can change while the
   * page is open.
   */
  protected readonly build = buildLabel(environment.environmentLabel);

  /**
   * The current URL as a signal, seeded with the one the app started on.
   *
   * `NavigationEnd` alone would leave this empty until the first in-app
   * navigation, so a reader who lands directly on `/play` would see the CTA
   * for as long as they stayed there — which is the one case the exclusion
   * exists for.
   */
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
      takeUntilDestroyed(),
    ),
    { initialValue: this.router.url },
  );

  /**
   * Whether to offer the donation CTA. Excluded from the active quiz round
   * outright: the whole point of that screen is that nothing competes with the
   * question.
   *
   * Matched on the path rather than the whole URL, since `/play` never carries
   * a query today but `?embed=1` proves the app is willing to add one.
   */
  protected readonly showsDonateCta = computed(
    () => this.url().split('?')[0].split('#')[0] !== GAMEPLAY_ROUTE,
  );

  private readonly donateTrigger = viewChild<ElementRef<HTMLElement>>('donateTrigger');

  /** Handed to the dialog so closing it puts focus back on the button that opens it. */
  protected readonly donateTriggerElement = computed(
    () => this.donateTrigger()?.nativeElement ?? null,
  );

  protected readonly isDialogOpen = this.dialogState.isOpen;

  protected openDonationDialog(): void {
    // The catalog read is the dialog's own business — it happens on the first
    // open, wherever that open came from, since the auth menu opens the same
    // dialog through the same service.
    this.dialogState.open();
  }
}
