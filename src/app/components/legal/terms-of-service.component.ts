import { ChangeDetectionStrategy, Component } from '@angular/core';
import { LegalPageComponent } from './legal-page.component';
import { ReviewRequiredComponent } from './review-required.component';

@Component({
  selector: 'app-terms-of-service',
  standalone: true,
  imports: [LegalPageComponent, ReviewRequiredComponent],
  templateUrl: './terms-of-service.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TermsOfServiceComponent {}
