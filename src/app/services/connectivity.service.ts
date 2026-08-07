import { Injectable, signal } from '@angular/core';

/** Tracks `navigator.onLine`, kept live via the `online`/`offline` window events. */
@Injectable({ providedIn: 'root' })
export class ConnectivityService {
  private readonly online = signal(navigator.onLine);

  readonly isOnline = this.online.asReadonly();

  constructor() {
    window.addEventListener('online', () => this.online.set(true));
    window.addEventListener('offline', () => this.online.set(false));
  }
}
