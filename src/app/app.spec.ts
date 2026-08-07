import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { TriviaService } from './services/trivia.service';

describe('App', () => {
  beforeEach(async () => {
    // Real background prefetch schedules a timer + a real opentdb.com fetch (see
    // TriviaService.initOfflinePrefetch) — neither belongs in a unit test.
    vi.spyOn(TriviaService.prototype, 'initOfflinePrefetch').mockImplementation(() => {
      /* intentional no-op */
    });

    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([]), provideHttpClient()],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });
});
