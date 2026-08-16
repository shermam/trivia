import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LegalPageComponent } from './legal-page.component';
import { ReviewRequiredComponent } from './review-required.component';

@Component({
  selector: 'app-terms-of-service',
  standalone: true,
  imports: [LegalPageComponent, ReviewRequiredComponent, RouterLink],
  templateUrl: './terms-of-service.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TermsOfServiceComponent {}
