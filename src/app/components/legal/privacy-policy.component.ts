import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LegalPageComponent } from './legal-page.component';
import { ReviewRequiredComponent } from './review-required.component';

@Component({
  selector: 'app-privacy-policy',
  standalone: true,
  imports: [LegalPageComponent, ReviewRequiredComponent, RouterLink],
  templateUrl: './privacy-policy.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PrivacyPolicyComponent {}
