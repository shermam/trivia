import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import {
  LEGAL_AWAITING_PROFESSIONAL_REVIEW,
  LEGAL_CONTACT_EMAIL,
  LEGAL_ENTITY_CNPJ,
  LEGAL_ENTITY_NAME,
  LEGAL_LAST_UPDATED,
} from './legal';
import { PrivacyPolicyComponent } from './privacy-policy.component';
import { TermsOfServiceComponent } from './terms-of-service.component';

/**
 * These two pages are prose, not logic, so this spec deliberately does not try
 * to test the copy. It pins the handful of properties that are *structural* —
 * the ones where being wrong is a legal problem rather than a typo, and where
 * nothing else in the suite would notice.
 *
 * The one that motivated the file: every promise in both documents about
 * exercising a right, reporting a security problem, or getting a question
 * taken down resolves to a single email address. A page that describes those
 * routes and then doesn't render the address is a page that promises a remedy
 * with no way to reach it — and it would render perfectly, and pass a build,
 * and look fine in review.
 */
async function render(component: typeof PrivacyPolicyComponent | typeof TermsOfServiceComponent) {
  // Reset first so a single test can render both pages — `configureTestingModule`
  // throws once the module has been instantiated, and comparing the two
  // documents against each other is the point of the last test in this file.
  TestBed.resetTestingModule();

  await TestBed.configureTestingModule({
    imports: [component],
    providers: [provideRouter([])],
  }).compileComponents();

  const fixture = TestBed.createComponent(component);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const PAGES = [
  { name: 'Privacy Policy', component: PrivacyPolicyComponent },
  { name: 'Terms of Service', component: TermsOfServiceComponent },
] as const;

describe('legal pages', () => {
  for (const { name, component } of PAGES) {
    describe(name, () => {
      it('renders with its title and the document date', async () => {
        const el = await render(component);

        expect(el.querySelector('h1')?.textContent?.trim()).toBe(name);
        expect(el.textContent).toContain(LEGAL_LAST_UPDATED);
      });

      it('publishes a reachable contact address as a mailto link', async () => {
        const el = await render(component);

        // Scoped to `.prose-legal` — the projected document body — and not to
        // the whole page, which is the difference between this test working
        // and this test being decorative. The shell's own review banner
        // carries a mailto too, so an unscoped `querySelectorAll` is satisfied
        // by the banner no matter what the document says: verified by deleting
        // all five links from the Privacy Policy and watching the suite stay
        // green.
        const body = el.querySelector('.prose-legal');
        expect(body, 'document body rendered').not.toBe(null);

        const mailtos = [...(body?.querySelectorAll('a[href^="mailto:"]') ?? [])].map((a) =>
          a.getAttribute('href'),
        );
        expect(mailtos.length, 'document body links to the contact address').toBeGreaterThan(0);
        for (const href of mailtos) {
          expect(href).toBe(`mailto:${LEGAL_CONTACT_EMAIL}`);
        }
      });

      it('identifies the operating company by name and CNPJ', async () => {
        const el = await render(component);
        const body = el.querySelector('.prose-legal');

        // GDPR Art 13(1)(a) wants the controller's *identity*, and Brazil's
        // e-commerce decree separately wants the corporate name and CNPJ shown
        // to a consumer. "Operated from Brazil" was a location, not either of
        // those. Both documents have to name the company: the Privacy Policy
        // because it is the controller, the Terms because it is the party
        // being contracted with.
        expect(body?.textContent).toContain(LEGAL_ENTITY_NAME);
        expect(body?.textContent).toContain(LEGAL_ENTITY_CNPJ);
      });

      it('carries the CC BY attribution the licence requires', async () => {
        const el = await render(component);

        expect(el.textContent).toContain('adapted from');
        expect(el.querySelector('a[href="https://creativecommons.org/licenses/by/4.0/"]')).not.toBe(
          null,
        );
        expect(el.querySelector('a[href="https://github.com/basecamp/policies"]')).not.toBe(null);
      });

      it('shows the awaiting-review notice while no lawyer has read it', async () => {
        const el = await render(component);
        const notice = el.querySelector('[role="note"]');

        expect(LEGAL_AWAITING_PROFESSIONAL_REVIEW).toBe(true);
        expect(notice?.textContent).toContain('not yet reviewed by a lawyer');
      });

      it('does not describe itself as a draft', async () => {
        const el = await render(component);

        // A document that introduces itself as a draft is a poor candidate for
        // a contract, and the Terms have to bind. The honest disclosure is the
        // narrower "no lawyer has read this", which the previous test asserts.
        expect(el.textContent?.toLowerCase()).not.toContain('this document is a working draft');
        expect(el.textContent).not.toContain('Draft — not yet published');
      });

      it('makes no compliance claim it cannot back', async () => {
        const el = await render(component);
        const text = el.textContent ?? '';

        // Describing behaviour is defensible; asserting compliance is a
        // representation, and a false one is worse than a gap.
        for (const claim of [
          'GDPR compliant',
          'LGPD compliant',
          'CCPA compliant',
          'fully compliant',
        ]) {
          expect(text).not.toContain(claim);
        }
      });
    });
  }

  it('tells contributors that deleting an account keeps their questions', async () => {
    // The single most load-bearing disclosure in either document: account
    // deletion anonymises contributed questions rather than removing them
    // (`functions/src/account.ts`). If the code keeps that behaviour and the
    // Terms stop saying so, the behaviour becomes indefensible.
    const el = await render(TermsOfServiceComponent);
    const text = el.textContent ?? '';

    expect(text).toContain('[deleted-user]');
    expect(text).toContain('stay in the shared bank');
    expect(text).toContain('irrevocable');
  });

  it('states the minimum age on both pages consistently', async () => {
    const privacy = await render(PrivacyPolicyComponent);
    const terms = await render(TermsOfServiceComponent);

    expect(privacy.textContent).toContain('13');
    expect(terms.textContent).toContain('13 or older');
  });
});
