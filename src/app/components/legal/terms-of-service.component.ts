import { ChangeDetectionStrategy, Component } from '@angular/core';
import { LegalPageComponent } from './legal-page.component';
import { ReviewRequiredComponent } from './review-required.component';

// No `RouterLink` here, unlike the Privacy Policy: this template links out to
// nothing. Angular reports an unused import as NG8113, which is a *warning*
// rather than an error — so `ng build` still succeeds and only a full read of
// its output catches it.
@Component({
  selector: 'app-terms-of-service',
  standalone: true,
  imports: [LegalPageComponent, ReviewRequiredComponent],
  templateUrl: './terms-of-service.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TermsOfServiceComponent {}
