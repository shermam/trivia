import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { environment } from '../../../environments/environment';
import { buildLabel } from '../../build-info';
import { FooterComponent } from './footer.component';

/**
 * The build identity is a diagnostic, and a diagnostic nobody can reach is
 * worth nothing — which is the whole reason this has a spec at all. Two
 * carriers, on two elements, and the failure mode for each is silent: a
 * dropped `title` leaves the tooltip gone with the page looking identical, and
 * a dropped `sr-only` span leaves it unreachable by anyone not using a mouse,
 * which nothing about the rendered page would reveal.
 */
function render() {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(FooterComponent);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('FooterComponent build identity', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('carries the build on the brand name as a hover tooltip', () => {
    const brand = render().querySelector<HTMLElement>('[data-cy="footer-build"]');

    expect(brand?.textContent?.trim()).toBe('Trivimind');
    expect(brand?.getAttribute('title')).toBe(buildLabel(environment.environmentLabel));
  });

  it('also puts the build in the accessibility tree, not only in the tooltip', () => {
    // `title` is not reachable by keyboard and its screen-reader support is
    // inconsistent, so the tooltip alone would hide this from exactly the
    // people who cannot hover.
    const host = render();
    const spoken = host.querySelector<HTMLElement>('.sr-only');

    expect(spoken?.textContent).toContain(buildLabel(environment.environmentLabel));
  });

  it('keeps the two on separate elements', () => {
    // Same element would make the title an accessible *description* of text
    // that already says it, which some screen readers announce twice.
    const brand = render().querySelector<HTMLElement>('[data-cy="footer-build"]');

    expect(brand?.querySelector('.sr-only')).toBeNull();
    expect(brand?.classList.contains('sr-only')).toBe(false);
  });

  it('still renders the copyright line it hangs off', () => {
    expect(render().textContent).toContain(`${new Date().getFullYear()}`);
  });
});
