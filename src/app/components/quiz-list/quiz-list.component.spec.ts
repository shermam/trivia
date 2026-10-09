import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router, provideRouter } from '@angular/router';
import { Quiz } from '../../models/quiz.model';
import { ConnectivityService } from '../../services/connectivity.service';
import { QuizService } from '../../services/quiz.service';
import { QuizListComponent } from './quiz-list.component';

/**
 * The curated quizzes on `/` (`FEAT-024`). jsdom has no layout, so the strip's
 * fixed height is measured by `quiz-list.spec.ts` in a real browser; these pin
 * the states, the read's trigger and its teardown.
 */

function quiz(id: string, overrides: Partial<Quiz> = {}): Quiz {
  return {
    id,
    title: `Quiz ${id}`,
    description: 'A curated quiz.',
    questionIds: ['q-1', 'q-2'],
    createdBy: 'curator-uid',
    createdAt: 1_759_900_000_000,
    isPublished: true,
    ...overrides,
  };
}

/**
 * Stands in for `IntersectionObserver`, which jsdom does not implement, so a
 * test can say when the section comes into view — and see that the observer
 * is let go of.
 */
class FakeObserver {
  static instances: FakeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.observed.push(target);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  unobserve(): void {
    // Unused by the component.
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  /** Reports the section at a given share of it on screen. */
  report(ratio: number): void {
    this.callback(
      [{ isIntersecting: true, intersectionRatio: ratio } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function setup(
  options: {
    listPublished?: () => Promise<Quiz[]>;
    withObserver?: boolean;
    online?: boolean;
  } = {},
) {
  FakeObserver.instances = [];
  if (options.withObserver !== false) {
    vi.stubGlobal('IntersectionObserver', FakeObserver);
  }
  const listPublished = vi.fn(options.listPublished ?? (() => Promise.resolve([quiz('a')])));
  // Writable, so a test can take the connection away and give it back.
  const online = signal(options.online ?? true);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: QuizService, useValue: { listPublished } },
      { provide: ConnectivityService, useValue: { isOnline: online } },
    ],
  });
  const fixture = TestBed.createComponent(QuizListComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement, listPublished, online };
}

async function settle(fixture: { whenStable: () => Promise<unknown>; detectChanges: () => void }) {
  await fixture.whenStable();
  fixture.detectChanges();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('QuizListComponent — it reads when it is scrolled to', () => {
  // `/` reads nothing else on arrival, and most visitors never scroll this far.
  it('reads nothing until the section comes into view', async () => {
    const { fixture, listPublished } = setup();
    await settle(fixture);

    expect(listPublished).not.toHaveBeenCalled();
    expect(FakeObserver.instances).toHaveLength(1);
  });

  // The section starts exactly at the first screen's bottom edge, which an
  // observer reports as intersecting with a ratio of 0 — reading on that
  // would read on every visit.
  it('ignores a section that only touches the edge of the screen', async () => {
    const { fixture, listPublished } = setup();
    await settle(fixture);

    FakeObserver.instances[0].report(0);

    expect(listPublished).not.toHaveBeenCalled();
    expect(FakeObserver.instances[0].options?.threshold).toBeGreaterThan(0);
  });

  it('reads once it is on screen, and stops watching', async () => {
    const { fixture, host, listPublished } = setup({
      listPublished: () => Promise.resolve([quiz('a'), quiz('b', { questionIds: ['q-1'] })]),
    });
    await settle(fixture);

    FakeObserver.instances[0].report(0.2);
    await settle(fixture);

    expect(listPublished).toHaveBeenCalledTimes(1);
    expect(FakeObserver.instances[0].disconnected).toBe(true);
    const links = [...host.querySelectorAll('[data-cy="quiz-link"]')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/quiz/a', '/quiz/b']);
    expect(links[1].textContent).toContain('1 question');
    expect(links[0].textContent).toContain('2 questions');
  });

  // Leaving `/` before scrolling down must not leave it watching (`CLAUDE.md` §4.4).
  it('lets go of the observer when it is destroyed unseen', async () => {
    const { fixture } = setup();
    await settle(fixture);

    fixture.destroy();

    expect(FakeObserver.instances[0].disconnected).toBe(true);
  });

  it('reads straight away where there is no IntersectionObserver at all', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { fixture, listPublished } = setup({ withObserver: false });
    await settle(fixture);

    expect(listPublished).toHaveBeenCalledTimes(1);
  });
});

describe('QuizListComponent — its states share one box', () => {
  async function inView(options: Parameters<typeof setup>[0]) {
    const rendered = setup(options);
    await settle(rendered.fixture);
    FakeObserver.instances[0].report(1);
    await settle(rendered.fixture);
    return rendered;
  }

  it('shows the placeholders, pulsing and hidden from assistive tech, before the read', async () => {
    const { fixture, host } = setup();
    await settle(fixture);

    const placeholders = host.querySelector('[data-cy="quiz-list-placeholders"]') as HTMLElement;
    expect(placeholders.getAttribute('aria-hidden')).toBe('true');
    expect(placeholders.querySelectorAll('li')).toHaveLength(3);
    expect(placeholders.querySelector('.motion-safe\\:animate-pulse')).not.toBeNull();
    expect(host.querySelector('[data-cy="quiz-list-status"]')?.textContent?.trim()).toBe('');
  });

  // Laid over invisible placeholders rather than replacing them, so the strip
  // is the same height empty as full.
  it('says when nothing is published, over placeholders that keep the strip’s size', async () => {
    const { host } = await inView({ listPublished: () => Promise.resolve([]) });

    expect(host.querySelector('[data-cy="quiz-list-empty"]')?.textContent?.trim()).toBe(
      'No quizzes have been published yet.',
    );
    const cards = [...host.querySelectorAll('[data-cy="quiz-list-placeholders"] li')];
    expect(cards).toHaveLength(3);
    expect(cards.every((card) => card.classList.contains('invisible'))).toBe(true);
    expect(host.querySelector('[data-cy="quiz-list-status"]')?.textContent?.trim()).toBe(
      'No quizzes have been published yet.',
    );
  });

  // A failed read is not an empty collection (`CLAUDE.md` §4.4).
  it('offers a retry when the read fails, moving focus off the button first', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let calls = 0;
    const { fixture, host, listPublished } = await inView({
      listPublished: () =>
        calls++ === 0 ? Promise.reject(new Error('timeout')) : Promise.resolve([quiz('a')]),
    });

    expect(host.querySelector('[data-cy="quiz-list-failed"]')?.textContent).toContain(
      'The quizzes could not be loaded.',
    );
    (host.querySelector('[data-cy="quiz-list-retry"]') as HTMLButtonElement).click();
    expect(document.activeElement?.id).toBe('quiz-list-heading');
    await settle(fixture);

    expect(listPublished).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll('[data-cy="quiz-link"]')).toHaveLength(1);
  });

  it('says the quizzes need a connection when the read fails offline', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { host } = await inView({
      listPublished: () => Promise.reject(new Error('offline')),
      online: false,
    });

    expect(host.querySelector('[data-cy="quiz-list-failed"]')?.textContent).toContain(
      "You're offline, and the quizzes need a connection.",
    );
  });

  // `/` keeps its console free of errors (Lighthouse's `errors-in-console`),
  // and an optional list that failed is not one: it says so on screen.
  it('logs a failed read as a warning, never as an error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await inView({ listPublished: () => Promise.reject(new Error('refused')) });

    expect(warn).toHaveBeenCalledWith(
      '[quizzes] could not read the published quizzes',
      expect.any(Error),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('announces how many quizzes there are once they land', async () => {
    const { host } = await inView({ listPublished: () => Promise.resolve([quiz('a'), quiz('b')]) });

    expect(host.querySelector('[data-cy="quiz-list-status"]')?.textContent?.trim()).toBe(
      '2 quizzes.',
    );
  });
});

describe('QuizListComponent — offline, a card says it needs a connection', () => {
  /**
   * A quiz's page is a lazy chunk outside the precache and the quiz itself is
   * a Firestore read, so a card cannot open offline — a tap used to start a
   * navigation whose chunk failed to load, with nothing on screen to say so.
   * jsdom has no network to lose; `offline-play.spec.ts` cuts a real one.
   */
  async function listed(options: Parameters<typeof setup>[0]) {
    const rendered = setup({
      listPublished: () => Promise.resolve([quiz('a'), quiz('b', { questionIds: ['q-1'] })]),
      ...options,
    });
    await settle(rendered.fixture);
    FakeObserver.instances[0].report(1);
    await settle(rendered.fixture);
    const links = () => [...rendered.host.querySelectorAll<HTMLElement>('[data-cy="quiz-link"]')];
    return { ...rendered, links };
  }

  /** The two cells stacked in a card's foot: the question count, and the offline reason. */
  function foot(link: HTMLElement) {
    const reason = link.querySelector('[data-cy="quiz-link-offline"]') as HTMLElement;
    const count = [...(reason.parentElement as HTMLElement).children].find(
      (cell) => cell !== reason,
    ) as HTMLElement;
    return { count, reason };
  }

  it('makes every card a disabled link with the reason in place of the count', async () => {
    const { links } = await listed({ online: false });

    expect(links()).toHaveLength(2);
    for (const link of links()) {
      // No href: a tap has nowhere to go. role + aria-disabled: still the
      // link it is, announced as unavailable.
      expect(link.hasAttribute('href')).toBe(false);
      expect(link.getAttribute('role')).toBe('link');
      expect(link.getAttribute('aria-disabled')).toBe('true');
      const { count, reason } = foot(link);
      expect(reason.textContent?.trim()).toBe('Needs a connection');
      expect(reason.classList.contains('invisible')).toBe(false);
      expect(count.classList.contains('invisible')).toBe(true);
    }
  });

  it('goes nowhere when a card is tapped', async () => {
    const { links } = await listed({ online: false });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);

    links()[0].click();

    expect(navigate).not.toHaveBeenCalled();
  });

  it('re-enables the cards when the connection returns, with nothing re-read', async () => {
    const { fixture, links, listPublished, online } = await listed({ online: false });

    online.set(true);
    fixture.detectChanges();

    expect(links().map((link) => link.getAttribute('href'))).toEqual(['/quiz/a', '/quiz/b']);
    for (const link of links()) {
      expect(link.hasAttribute('role')).toBe(false);
      expect(link.hasAttribute('aria-disabled')).toBe(false);
      const { count, reason } = foot(link);
      expect(count.classList.contains('invisible')).toBe(false);
      expect(reason.classList.contains('invisible')).toBe(true);
    }
    expect(links()[1].textContent).toContain('1 question');
    expect(listPublished).toHaveBeenCalledTimes(1);

    // Stubbed, because the test router has no `/quiz` route to arrive at.
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    links()[0].click();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(String(navigate.mock.calls[0][0])).toBe('/quiz/a');
  });

  // The foot holds both cells in every state, one of them invisible, so its
  // height is the taller of the two whichever is showing (`CLAUDE.md` §4.4).
  it('keeps both of the foot’s cells rendered online and offline', async () => {
    const { fixture, links, online } = await listed({ online: true });

    const visible = () =>
      links().map((link) => {
        const { count, reason } = foot(link);
        return [count, reason].map((cell) => !cell.classList.contains('invisible'));
      });
    expect(visible()).toEqual([
      [true, false],
      [true, false],
    ]);

    online.set(false);
    fixture.detectChanges();
    expect(visible()).toEqual([
      [false, true],
      [false, true],
    ]);
  });
});
