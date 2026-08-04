import { TestBed } from '@angular/core/testing';
import { ThemeService } from './theme.service';

describe('ThemeService', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark');
    localStorage.clear();
    TestBed.configureTestingModule({});
  });

  it('defaults to light when no dark class is present on <html>', () => {
    const service = TestBed.inject(ThemeService);
    expect(service.currentTheme()).toBe('light');
  });

  it('picks up an already-applied dark class (e.g. from the no-flash script)', () => {
    document.documentElement.classList.add('dark');
    const service = TestBed.inject(ThemeService);
    expect(service.currentTheme()).toBe('dark');
  });

  it('toggle() flips the theme, updates the <html> class, and persists to localStorage', () => {
    const service = TestBed.inject(ThemeService);

    service.toggle();
    expect(service.currentTheme()).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('trivia-theme')).toBe('dark');

    service.toggle();
    expect(service.currentTheme()).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('trivia-theme')).toBe('light');
  });
});
