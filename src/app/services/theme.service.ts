import { Injectable, signal } from '@angular/core';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'trivia-theme';

/**
 * Manual light/dark toggle, backed by a `dark` class on `<html>` (Tailwind's
 * class-based dark variant, see `@custom-variant dark` in styles.css — not
 * the default `prefers-color-scheme` media strategy, since the top bar needs
 * a real toggle button rather than only following the OS setting).
 *
 * A no-flash inline script in index.html applies the same class/localStorage
 * read before Angular bootstraps, so this constructor is just keeping the
 * signal in sync with whatever that script already decided.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly theme = signal<Theme>(readInitialTheme());

  readonly currentTheme = this.theme.asReadonly();

  toggle(): void {
    this.setTheme(this.theme() === 'dark' ? 'light' : 'dark');
  }

  private setTheme(theme: Theme): void {
    this.theme.set(theme);
    applyTheme(theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }
}

function readInitialTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}
