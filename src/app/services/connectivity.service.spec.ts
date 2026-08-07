import { TestBed } from '@angular/core/testing';
import { ConnectivityService } from './connectivity.service';

describe('ConnectivityService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
  });

  it('reflects navigator.onLine at construction time', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const service = TestBed.inject(ConnectivityService);
    expect(service.isOnline()).toBe(true);
  });

  it('flips to false on a window "offline" event', () => {
    const service = TestBed.inject(ConnectivityService);
    window.dispatchEvent(new Event('offline'));
    expect(service.isOnline()).toBe(false);
  });

  it('flips back to true on a window "online" event', () => {
    const service = TestBed.inject(ConnectivityService);
    window.dispatchEvent(new Event('offline'));
    expect(service.isOnline()).toBe(false);

    window.dispatchEvent(new Event('online'));
    expect(service.isOnline()).toBe(true);
  });
});
