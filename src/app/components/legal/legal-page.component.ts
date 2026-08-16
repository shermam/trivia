import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent } from '../icon/icon.component';
import {
  LEGAL_ATTRIBUTION_URL,
  LEGAL_AWAITING_PROFESSIONAL_REVIEW,
  LEGAL_CONTACT_EMAIL,
  LEGAL_LAST_UPDATED,
} from './legal';

/**
 * Shared shell for /privacy and /terms: page chrome, the draft banner, and
 * the CC BY attribution, so neither document can drift from the other or
 * quietly lose its attribution line. The documents themselves are projected
 * in, keeping their templates pure prose and reviewable as copy.
 */
@Component({
  selector: 'app-legal-page',
  standalone: true,
  imports: [RouterLink, IconComponent],
  template: `
    <div class="min-h-screen bg-slate-50 px-4 py-10 dark:bg-slate-950">
      <div class="mx-auto w-full max-w-2xl">
        <a
          routerLink="/"
          class="mb-6 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-600 transition-colors hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-50"
        >
          <app-icon name="arrow-left" [size]="16" />
          Back to Trivimind
        </a>

        <div class="rounded-3xl bg-white px-6 py-8 shadow-card-lg sm:px-8 dark:bg-slate-900">
          <h1 class="mb-1 text-3xl font-extrabold tracking-tight text-slate-900 dark:text-slate-50">
            {{ title() }}
          </h1>
          <p class="text-sm text-slate-500 dark:text-slate-400">Last updated: {{ lastUpdated }}</p>

          @if (awaitingReview) {
            <div
              role="note"
              class="mt-6 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3.5 dark:border-amber-500/30 dark:bg-amber-500/10"
            >
              <p class="flex items-center gap-2 font-bold text-amber-900 dark:text-amber-200">
                <app-icon name="triangle-alert" [size]="17" class="shrink-0" />
                In force, but not yet reviewed by a lawyer
              </p>
              <p class="mt-1 text-sm text-amber-900/90 dark:text-amber-200/90">
                This document applies to your use of the service today, and everything it says about
                what the app does with your information was written by reading the application's own
                source code — so it describes real behaviour rather than what a template assumes.
                What it has not had is a professional legal review. If you spot something wrong,
                unclear, or missing, please write to
                <a
                  [href]="'mailto:' + contactEmail"
                  class="font-semibold underline underline-offset-2"
                  >{{ contactEmail }}</a
                >
                — that is genuinely useful and it will be fixed.
              </p>
            </div>
          }

          <div class="prose-legal mt-8">
            <ng-content />
          </div>

          <p
            class="mt-10 border-t border-slate-900/8 pt-5 text-xs text-slate-500 dark:border-white/10 dark:text-slate-400"
          >
            Structure and tone adapted from
            <a
              [href]="attributionUrl"
              rel="noopener noreferrer"
              target="_blank"
              class="font-medium text-emerald-700 underline underline-offset-2 dark:text-emerald-400"
              >Basecamp's open-sourced policies</a
            >, used under
            <a
              href="https://creativecommons.org/licenses/by/4.0/"
              rel="noopener noreferrer license"
              target="_blank"
              class="font-medium text-emerald-700 underline underline-offset-2 dark:text-emerald-400"
              >CC BY 4.0</a
            >.
          </p>
        </div>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LegalPageComponent {
  readonly title = input.required<string>();

  protected readonly awaitingReview = LEGAL_AWAITING_PROFESSIONAL_REVIEW;
  protected readonly lastUpdated = LEGAL_LAST_UPDATED;
  protected readonly attributionUrl = LEGAL_ATTRIBUTION_URL;
  protected readonly contactEmail = LEGAL_CONTACT_EMAIL;
}
