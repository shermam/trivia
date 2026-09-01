import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { environment } from '../../../environments/environment';
import { buildLabel } from '../../build-info';

/**
 * Site footer, carrying the legal links. Sits as a sibling of
 * `<router-outlet>` alongside `TopBarComponent` and is hidden in embed mode
 * for the same reason the top bar is — an embedded widget is a game panel,
 * not a site.
 *
 * These links have to be reachable from every screen: Stripe expects a
 * merchant's terms and privacy policy to be findable, and a policy nobody
 * can navigate to is not much better than not having one.
 */
@Component({
  selector: 'app-footer',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './footer.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FooterComponent {
  protected readonly year = new Date().getFullYear();

  /**
   * Which build this is — hover the brand name to see it.
   *
   * Computed once at construction rather than in a signal: `--define`
   * substitutes a constant, so there is nothing here that can change while the
   * page is open.
   */
  protected readonly build = buildLabel(environment.environmentLabel);
}
