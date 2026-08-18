import { TestBed } from '@angular/core/testing';
import { ApplicationRef, signal } from '@angular/core';
import { Router } from '@angular/router';
import { of } from 'rxjs';
import {
  GameConfig,
  LeaderboardEntry,
  TimeLimitOption,
  TriviaQuestion,
} from '../../models/question.model';
import { AuthService } from '../../services/auth.service';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { EmbedModeService } from '../../services/embed-mode.service';
import { FirebaseService, QuestionReportRejectedError } from '../../services/firebase.service';
import { FirestoreRestError } from '../../services/firestore-rest/firestore-rest.client';
import { GameControllerService } from '../../services/game-controller.service';
import { GameOverComponent } from './game-over.component';

/**
 * Finding B4. A rejected score save was reported as "your best score is
 * already higher" for *any* `permission-denied`. Since the leaderboard rules
 * were tightened that covers several distinct causes — a clock outside the
 * accepted window, a name over 30 characters, an unverified account, a score
 * inconsistent with the question count — so the message was false whenever the
 * cause was any of those. Worse, it set `hasSaved`, replacing the form with
 * the saved panel and leaving no way to retry a failure that might well have
 * succeeded on a second attempt.
 */

/**
 * The error a rules refusal actually produces now.
 *
 * It used to be `Object.assign(new Error(...), { code: 'permission-denied' })`,
 * mirroring the Firestore SDK. That shape no longer exists — `FirebaseService`
 * goes over REST and throws `FirestoreRestError` — and the old fake is the
 * reason this suite kept passing while the component underneath had stopped
 * recognising a refusal at all. Building the real error is what makes the test
 * a check on the contract rather than on a copy of it.
 */
const permissionDenied = () =>
  new FirestoreRestError('PERMISSION_DENIED', 403, 'Missing permissions.');

function makeEntry(overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    uid: 'player-1',
    name: 'Ada',
    score: 9,
    totalQuestions: 10,
    percentage: 90,
    createdAt: Date.now(),
    timeLimit: '15',
    ...overrides,
  };
}

/** A config whose only interesting part here is which board the game ranks on. */
function makeConfig(timeLimit: TimeLimitOption = 15): GameConfig {
  return { amount: 10, category: '', difficulty: '', source: 'open_trivia', timeLimit };
}

function setup(options: {
  saveError: unknown;
  existingEntry?: LeaderboardEntry | null;
  lookupFails?: boolean;
  score?: number;
  timeLimit?: TimeLimitOption;
}) {
  const saveHighScore = vi.fn().mockRejectedValue(options.saveError);
  const getLeaderboardEntry = vi.fn(() =>
    options.lookupFails
      ? Promise.reject(new Error('offline'))
      : Promise.resolve(options.existingEntry ?? null),
  );

  TestBed.configureTestingModule({
    providers: [
      {
        provide: GameControllerService,
        useValue: {
          score: signal(options.score ?? 7),
          totalQuestions: signal(10),
          percentage: signal(70),
          questions: signal([]),
          config: signal(makeConfig(options.timeLimit)),
          flaggedQuestionIds: signal<ReadonlySet<string>>(new Set()),
          resetGame: () => undefined,
        },
      },
      {
        provide: AuthService,
        useValue: {
          user: signal({ uid: 'player-1', displayName: 'Ada' }),
          isFullyAuthenticated: signal(true),
          resendVerificationEmail: () => Promise.resolve(),
        },
      },
      { provide: AuthMenuStateService, useValue: { open: () => undefined } },
      { provide: EmbedModeService, useValue: { isEmbedded: () => false } },
      {
        provide: FirebaseService,
        useValue: { saveHighScore, getLeaderboardEntry, getTopScores: () => of([]) },
      },
      { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
    ],
  });

  const fixture = TestBed.createComponent(GameOverComponent);
  const component = fixture.componentInstance as unknown as {
    playerName: string;
    saveScore: () => Promise<void>;
    saveError: () => string | null;
    hasSaved: () => boolean;
  };
  component.playerName = 'Ada';
  return { component, saveHighScore, getLeaderboardEntry };
}

describe('GameOverComponent save failures', () => {
  afterEach(() => TestBed.resetTestingModule());

  // The one case where the friendly message is actually true.
  it('claims a higher existing best only after reading one that is higher', async () => {
    const { component, getLeaderboardEntry } = setup({
      saveError: permissionDenied(),
      existingEntry: makeEntry({ score: 9 }),
      score: 7,
    });

    await component.saveScore();

    expect(getLeaderboardEntry).toHaveBeenCalledWith('player-1', '15');
    expect(component.saveError()).toMatch(/already higher/);
    // Retry is suppressed here on purpose: the rules will refuse the same
    // write every time, so offering the form again would only mislead.
    expect(component.hasSaved()).toBe(true);
  });

  /*
   * The bug. A clock outside the accepted window, an over-long name and an
   * unverified account all surface as permission-denied too, and none of them
   * mean the player's best is higher — this one has no existing entry at all.
   */
  it('stays generic when no existing entry can explain the rejection', async () => {
    const { component } = setup({ saveError: permissionDenied(), existingEntry: null });

    await component.saveScore();

    expect(component.saveError()).toBe('Could not save your score. Please try again.');
    expect(component.hasSaved()).toBe(false);
  });

  it('stays generic when the existing entry is lower than this game', async () => {
    const { component } = setup({
      saveError: permissionDenied(),
      existingEntry: makeEntry({ score: 3 }),
      score: 7,
    });

    await component.saveScore();

    expect(component.saveError()).toMatch(/Please try again/);
    expect(component.hasSaved()).toBe(false);
  });

  // Equal scores genuinely can't improve on the existing best, so the rules
  // reject them and the friendly message is accurate.
  it('treats an equal existing score as the higher best', async () => {
    const { component } = setup({
      saveError: permissionDenied(),
      existingEntry: makeEntry({ score: 7 }),
      score: 7,
    });

    await component.saveScore();

    expect(component.saveError()).toMatch(/already higher/);
    expect(component.hasSaved()).toBe(true);
  });

  // Never narrate a cause a failed lookup could not confirm.
  it('stays generic when the explaining lookup itself fails', async () => {
    const { component } = setup({ saveError: permissionDenied(), lookupFails: true });

    await component.saveScore();

    expect(component.saveError()).toMatch(/Please try again/);
    expect(component.hasSaved()).toBe(false);
  });

  it('does not go looking for an explanation for an ordinary failure', async () => {
    const { component, getLeaderboardEntry } = setup({ saveError: new Error('network down') });

    await component.saveScore();

    expect(getLeaderboardEntry).not.toHaveBeenCalled();
    expect(component.saveError()).toMatch(/Please try again/);
    expect(component.hasSaved()).toBe(false);
  });
});

/**
 * Finding H4 — the game-over reporting flow. The rules and the write
 * mechanics have their own suites (`firestore-tests/`,
 * `firebase.service.spec.ts`); what belongs to the component is which
 * questions are offered, what payload leaves it, and what each outcome does
 * to the UI state.
 */

function makeTriviaQuestion(overrides: Partial<TriviaQuestion> = {}): TriviaQuestion {
  return {
    id: 'q-custom-1',
    category: 'Science',
    type: 'multiple',
    difficulty: 'easy',
    question: 'Q?',
    correct_answer: 'A',
    incorrect_answers: ['B'],
    all_answers: [],
    source: 'custom',
    ...overrides,
  };
}

interface ReportingComponent {
  reportableQuestions: () => TriviaQuestion[];
  openReportQuestionId: () => string | null;
  reportedQuestionIds: () => ReadonlySet<string>;
  reportError: () => string | null;
  reportStatus: () => string;
  reportReason: string;
  reportDetail: string;
  toggleReportForm: (question: TriviaQuestion) => void;
  closeReportForm: () => void;
  submitReport: (question: TriviaQuestion) => Promise<void>;
}

/**
 * Providers only — no `createComponent`, so the rendered tests below can
 * create exactly one instance and drive the same one they query. (An earlier
 * version created a second instance here and asserted against the first,
 * which fails for a reason that has nothing to do with the code.)
 */
function configureReporting(options: {
  questions: TriviaQuestion[];
  reportError?: unknown;
  flaggedIds?: string[];
  timeLimit?: TimeLimitOption;
}) {
  const reportQuestion = options.reportError
    ? vi.fn().mockRejectedValue(options.reportError)
    : vi.fn().mockResolvedValue(undefined);

  TestBed.configureTestingModule({
    providers: [
      {
        provide: GameControllerService,
        useValue: {
          score: signal(7),
          totalQuestions: signal(10),
          percentage: signal(70),
          questions: signal(options.questions),
          config: signal(makeConfig(options.timeLimit)),
          // The flagged set drives which questions the screen leads with;
          // default to "all of them flagged" so the existing reporting tests
          // keep exercising the visible list rather than the dialog.
          flaggedQuestionIds: signal<ReadonlySet<string>>(
            new Set(options.flaggedIds ?? options.questions.map((q) => q.id)),
          ),
          resetGame: () => undefined,
        },
      },
      {
        provide: AuthService,
        useValue: {
          user: signal({ uid: 'anon-1', displayName: null }),
          // An anonymous session, the population this flow is for — and the
          // rendered tests below need every signal the template reads.
          isAnonymous: signal(true),
          isFullyAuthenticated: signal(false),
          resendVerificationEmail: () => Promise.resolve(),
        },
      },
      { provide: AuthMenuStateService, useValue: { open: () => undefined } },
      { provide: EmbedModeService, useValue: { isEmbedded: () => false } },
      {
        provide: FirebaseService,
        useValue: {
          reportQuestion,
          getLeaderboardEntry: () => Promise.resolve(null),
          getTopScores: () => of([]),
        },
      },
      { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
    ],
  });

  return { reportQuestion };
}

function reportingSetup(options: {
  questions: TriviaQuestion[];
  reportError?: unknown;
  flaggedIds?: string[];
}) {
  const { reportQuestion } = configureReporting(options);
  const fixture = TestBed.createComponent(GameOverComponent);
  const component = fixture.componentInstance as unknown as ReportingComponent;
  return { component, reportQuestion };
}

describe('GameOverComponent question reporting (H4)', () => {
  afterEach(() => TestBed.resetTestingModule());

  const custom = makeTriviaQuestion({ id: 'q-custom-1' });
  const openTrivia = makeTriviaQuestion({ id: 'open-123', source: 'open_trivia' });

  it('offers only custom-source questions — Open Trivia DB content is not ours to moderate', () => {
    const { component } = reportingSetup({ questions: [openTrivia, custom] });

    expect(component.reportableQuestions().map((q) => q.id)).toEqual(['q-custom-1']);
  });

  it('sends the chosen reason attributed to the caller, omitting a blank detail', async () => {
    const { component, reportQuestion } = reportingSetup({ questions: [custom] });
    component.toggleReportForm(custom);
    component.reportReason = 'incorrect';
    component.reportDetail = '   ';

    await component.submitReport(custom);

    expect(reportQuestion).toHaveBeenCalledTimes(1);
    const payload = reportQuestion.mock.calls[0][0];
    expect(payload.questionId).toBe('q-custom-1');
    expect(payload.reason).toBe('incorrect');
    expect(payload.reportedBy).toBe('anon-1');
    expect(Math.abs(payload.createdAt - Date.now())).toBeLessThan(5_000);
    // Omitted, not undefined: Firestore rejects undefined field values, and
    // the rules only allow `detail` with content.
    expect('detail' in payload).toBe(false);
  });

  it('includes a trimmed detail when one was written', async () => {
    const { component, reportQuestion } = reportingSetup({ questions: [custom] });
    component.toggleReportForm(custom);
    component.reportReason = 'other';
    component.reportDetail = '  The year is off by a decade.  ';

    await component.submitReport(custom);

    expect(reportQuestion.mock.calls[0][0].detail).toBe('The year is off by a decade.');
  });

  it('does nothing until a reason is chosen', async () => {
    const { component, reportQuestion } = reportingSetup({ questions: [custom] });
    component.toggleReportForm(custom);

    await component.submitReport(custom);

    expect(reportQuestion).not.toHaveBeenCalled();
  });

  it('marks the question reported, closes the form, and announces on success', async () => {
    const { component } = reportingSetup({ questions: [custom] });
    component.toggleReportForm(custom);
    component.reportReason = 'spam';

    await component.submitReport(custom);

    expect(component.reportedQuestionIds().has('q-custom-1')).toBe(true);
    expect(component.openReportQuestionId()).toBeNull();
    expect(component.reportStatus()).toMatch(/Report sent/);
    expect(component.reportError()).toBeNull();
  });

  it("surfaces the service's own advice when every slot was refused, and keeps the form open", async () => {
    const { component } = reportingSetup({
      questions: [custom],
      reportError: new QuestionReportRejectedError(),
    });
    component.toggleReportForm(custom);
    component.reportReason = 'incorrect';

    await component.submitReport(custom);

    expect(component.reportError()).toMatch(/try again in a few minutes/);
    // Announced too — the visible paragraph alone is silent to a screen
    // reader mid-flow (G3 pattern).
    expect(component.reportStatus()).toMatch(/try again in a few minutes/);
    expect(component.openReportQuestionId()).toBe('q-custom-1');
    expect(component.reportedQuestionIds().has('q-custom-1')).toBe(false);
  });

  it('stays generic for an ordinary failure', async () => {
    const { component } = reportingSetup({
      questions: [custom],
      reportError: new Error('network down'),
    });
    component.toggleReportForm(custom);
    component.reportReason = 'incorrect';

    await component.submitReport(custom);

    expect(component.reportError()).toBe('Could not send the report. Please try again.');
    expect(component.openReportQuestionId()).toBe('q-custom-1');
  });

  // A live region only announces on mutation, and signals drop same-value
  // sets — so the region must pass through '' while a write is in flight,
  // or a second identical outcome ("Report sent" for another question, the
  // same failure on a retry) would be silent to a screen reader. Found by
  // review, not by this suite's first version.
  it('empties the status region while a submit is in flight (G3)', async () => {
    const { component, reportQuestion } = reportingSetup({ questions: [custom] });
    component.toggleReportForm(custom);
    component.reportReason = 'spam';
    await component.submitReport(custom);
    expect(component.reportStatus()).toMatch(/Report sent/);

    let resolveWrite!: () => void;
    reportQuestion.mockReturnValue(new Promise<void>((resolve) => (resolveWrite = resolve)));
    const secondSubmit = component.submitReport(custom);

    expect(component.reportStatus()).toBe('');

    resolveWrite();
    await secondSubmit;
    expect(component.reportStatus()).toMatch(/Report sent/);
  });

  /**
   * Rendered, not instance-level, because the defect this pins is only
   * visible in the DOM: the first fix read the badge with
   * `getElementById` inside the closing effect, found nothing (it hadn't
   * rendered yet) and left focus on `<body>` — green in every
   * instance-level test and red in CI's real browser. The control below
   * (cancel path) proves the probe can see focus move at all, so a `body`
   * result here means the bug, not a jsdom artifact.
   */
  describe('focus after the panel closes (G2, rendered)', () => {
    async function render(reportError?: unknown) {
      configureReporting({ questions: [custom], reportError });
      const fixture = TestBed.createComponent(GameOverComponent);
      const component = fixture.componentInstance as unknown as ReportingComponent;
      const host = fixture.nativeElement as HTMLElement;
      // `ApplicationRef.tick()`, not just `detectChanges()`: the badge focus
      // runs in an after-render hook, and those flush on the application
      // tick — which is what happens in a real browser, and what a bare
      // fixture-level change detection pass skips.
      const appRef = TestBed.inject(ApplicationRef);
      const settle = async () => {
        appRef.tick();
        await fixture.whenStable();
        appRef.tick();
      };
      const query = <T extends HTMLElement>(selector: string) =>
        host.querySelector<T>(selector) ?? undefined;
      await settle();

      // Focus the trigger the way a real click does, so the effect captures
      // it rather than <body>.
      const openForm = async () => {
        const trigger = query<HTMLButtonElement>(`[data-cy="report-question-${custom.id}"]`)!;
        trigger.focus();
        trigger.click();
        await settle();
      };
      return { component, fixture, query, settle, openForm };
    }

    it('moves focus to the Reported badge when the trigger it would restore is gone', async () => {
      const { component, query, settle, openForm } = await render();
      await openForm();

      component.reportReason = 'incorrect';
      await settle();
      // Awaited rather than clicked: the app is zoneless, so `whenStable()`
      // does not track the handler's promise and the assertions would race
      // the write. Opening above still goes through a real click, which is
      // what makes the focus capture realistic.
      await component.submitReport(custom);
      await settle();

      const active = document.activeElement as HTMLElement | null;
      expect(query(`[data-cy="report-question-${custom.id}"]`), 'trigger is gone').toBeUndefined();
      expect(active?.id, `focus landed on <${active?.tagName.toLowerCase()}>`).toBe(
        `report-badge-${custom.id}`,
      );
    });

    // Control: the trigger survives a cancel, so focus must return to it —
    // proof the probe above can detect focus moving at all.
    it('returns focus to the trigger when the form is cancelled', async () => {
      const { component, settle, openForm } = await render();
      await openForm();

      component.closeReportForm();
      await settle();

      const active = document.activeElement as HTMLElement | null;
      expect(active?.getAttribute('data-cy')).toBe(`report-question-${custom.id}`);
    });
  });

  it('clears the previous attempt when the form reopens', () => {
    const { component } = reportingSetup({ questions: [custom] });
    component.toggleReportForm(custom);
    component.reportReason = 'spam';
    component.reportDetail = 'left over';
    component.closeReportForm();

    component.toggleReportForm(custom);

    expect(component.reportReason).toBe('');
    expect(component.reportDetail).toBe('');
    expect(component.openReportQuestionId()).toBe('q-custom-1');
  });
});

/**
 * The redesign: game-over leads with what the player flagged mid-game, and
 * everything else is behind a dialog. Rendered throughout — the modal's whole
 * contract (focus in, trap, Escape, focus back) is invisible to a test that
 * only reads signals, which is the lesson the H4 review left behind.
 */
describe('GameOverComponent flagged questions and the report dialog', () => {
  afterEach(() => TestBed.resetTestingModule());

  const custom1 = makeTriviaQuestion({ id: 'q-custom-1', question: 'First community question?' });
  const custom2 = makeTriviaQuestion({ id: 'q-custom-2', question: 'Second community question?' });
  const openTrivia = makeTriviaQuestion({ id: 'open-1', source: 'open_trivia' });

  function render(options: { questions: TriviaQuestion[]; flaggedIds?: string[] }) {
    const { reportQuestion } = configureReporting({
      questions: options.questions,
      flaggedIds: options.flaggedIds ?? [],
    });
    const fixture = TestBed.createComponent(GameOverComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    return {
      fixture,
      host,
      reportQuestion,
      query: (selector: string) => host.querySelector<HTMLElement>(selector),
      queryAll: (selector: string) => Array.from(host.querySelectorAll<HTMLElement>(selector)),
    };
  }

  it('leads with the flagged question only, not every community question', () => {
    const { host, query } = render({
      questions: [custom1, custom2, openTrivia],
      flaggedIds: ['q-custom-1'],
    });

    expect(host.textContent).toContain('Questions you flagged');
    expect(query('[data-cy="report-question-q-custom-1"]')).not.toBeNull();
    expect(query('[data-cy="report-question-q-custom-2"]')).toBeNull();
  });

  it('shows no flagged section when nothing was flagged', () => {
    const { host } = render({ questions: [custom1, custom2] });

    expect(host.textContent).not.toContain('Questions you flagged');
  });

  // The escape hatch for "I noticed but didn't flag it".
  it('still offers the dialog when nothing was flagged', () => {
    const { query } = render({ questions: [custom1, custom2] });

    expect(query('[data-cy="open-report-dialog"]')).not.toBeNull();
  });

  it('offers nothing at all for a game with no community questions', () => {
    const { query, host } = render({ questions: [openTrivia] });

    expect(query('[data-cy="open-report-dialog"]')).toBeNull();
    expect(host.textContent).not.toContain('Questions you flagged');
  });

  it('opens a labelled modal listing every community question', async () => {
    const { fixture, query, queryAll } = render({
      questions: [custom1, custom2, openTrivia],
      flaggedIds: ['q-custom-1'],
    });

    query('[data-cy="open-report-dialog"]')?.click();
    fixture.detectChanges();

    const dialog = query('[data-cy="report-dialog"]');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('report-dialog-title');
    // Both community questions, including the one that was never flagged —
    // and still not the Open Trivia DB one.
    expect(queryAll('[data-cy="report-dialog"] [data-cy^="report-question-"]')).toHaveLength(2);
    expect(query('[data-cy="report-dialog"] [data-cy="report-question-open-1"]')).toBeNull();
  });

  it('moves focus into the dialog and back to the trigger on close', async () => {
    const { fixture, query } = render({ questions: [custom1] });

    query('[data-cy="open-report-dialog"]')?.click();
    fixture.detectChanges();
    await Promise.resolve();
    expect(document.activeElement).toBe(query('[data-cy="report-dialog"]'));

    query('[data-cy="close-report-dialog"]')?.click();
    fixture.detectChanges();
    // The restore is deferred by a microtask so it runs after the pass that
    // removes the dialog has committed — see the comment in the component.
    await Promise.resolve();
    expect(document.activeElement).toBe(query('[data-cy="open-report-dialog"]'));
  });

  it('closes on Escape', async () => {
    const { fixture, query } = render({ questions: [custom1] });
    query('[data-cy="open-report-dialog"]')?.click();
    fixture.detectChanges();

    query('[data-cy="report-dialog"]')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    fixture.detectChanges();

    expect(query('[data-cy="report-dialog"]')).toBeNull();
  });

  // `aria-modal="true"` is a promise to assistive tech; the trap is what
  // makes it true for everyone else.
  it('wraps Tab from the last control back to the first', async () => {
    const { fixture, query, host } = render({ questions: [custom1] });
    query('[data-cy="open-report-dialog"]')?.click();
    fixture.detectChanges();

    const focusable = Array.from(
      host.querySelectorAll<HTMLElement>('[data-cy="report-dialog"] button'),
    );
    const last = focusable[focusable.length - 1];
    last.focus();

    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    query('[data-cy="report-dialog"]')?.dispatchEvent(tab);

    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusable[0]);
  });

  it('wraps Shift+Tab from the dialog itself back to the last control', async () => {
    const { fixture, query, host } = render({ questions: [custom1] });
    query('[data-cy="open-report-dialog"]')?.click();
    fixture.detectChanges();
    await Promise.resolve();

    const focusable = Array.from(
      host.querySelectorAll<HTMLElement>('[data-cy="report-dialog"] button'),
    );
    const shiftTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    query('[data-cy="report-dialog"]')?.dispatchEvent(shiftTab);

    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);
  });

  // The dialog element is only `activeElement` for the very first keystroke
  // after opening. Every Shift+Tab after that starts from the *first control*,
  // which is a different branch of the same condition — and it was the
  // untested one, so `active === first ||` could be deleted with the suite
  // still green.
  it('wraps Shift+Tab from the first control back to the last', async () => {
    const { fixture, query, host } = render({ questions: [custom1] });
    query('[data-cy="open-report-dialog"]')?.click();
    fixture.detectChanges();

    const focusable = Array.from(
      host.querySelectorAll<HTMLElement>('[data-cy="report-dialog"] button'),
    );
    focusable[0].focus();

    const shiftTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    query('[data-cy="report-dialog"]')?.dispatchEvent(shiftTab);

    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);
  });

  /**
   * A flagged question is offered in two places — the card that leads the
   * screen and the dialog that lists everything — and both render through the
   * same `questionRow` template against the same `openReportQuestionId`
   * signal. Rendering both at once duplicates `report-panel-{id}` and
   * `report-badge-{id}` in the document, and `viewChild('reportPanel')`
   * returns the first match in view order: the card, which is declared above
   * the dialog. Opening a report form from inside the modal would then move
   * focus to the copy behind the backdrop, outside the trap that is the whole
   * point of the modal.
   */
  it('renders each question once, never in the card and the dialog at the same time', () => {
    const { fixture, query, queryAll } = render({
      questions: [custom1, custom2],
      flaggedIds: ['q-custom-1'],
    });

    expect(queryAll('[data-cy="report-question-q-custom-1"]')).toHaveLength(1);

    query('[data-cy="open-report-dialog"]')?.click();
    fixture.detectChanges();

    // Still exactly one, and it is the copy inside the dialog.
    const triggers = queryAll('[data-cy="report-question-q-custom-1"]');
    expect(triggers).toHaveLength(1);
    expect(triggers[0].closest('[data-cy="report-dialog"]')).not.toBeNull();

    // Closing brings the card back, so nothing is lost by hiding it.
    query('[data-cy="close-report-dialog"]')?.click();
    fixture.detectChanges();
    expect(queryAll('[data-cy="report-question-q-custom-1"]')).toHaveLength(1);
  });

  // The consequence of the above, asserted directly: the panel focused when a
  // form opens inside the dialog must be inside the dialog.
  it('keeps focus inside the dialog when a report form is opened from it', async () => {
    const { fixture, query } = render({
      questions: [custom1, custom2],
      flaggedIds: ['q-custom-1'],
    });

    query('[data-cy="open-report-dialog"]')?.click();
    fixture.detectChanges();
    await Promise.resolve();

    query('[data-cy="report-question-q-custom-1"]')?.click();
    fixture.detectChanges();
    await Promise.resolve();

    const focused = document.activeElement as HTMLElement | null;
    expect(focused?.id).toBe('report-panel-q-custom-1');
    expect(focused?.closest('[data-cy="report-dialog"]')).not.toBeNull();
  });
});

/**
 * Finding G7, the leaderboard half. Each timing constraint has its own board,
 * so the screen must read and write the one the game was actually played
 * under — and say which one it is, or a modest score on the no-limit board
 * reads as a modest score overall.
 */
describe('GameOverComponent — per-board leaderboards', () => {
  afterEach(() => TestBed.resetTestingModule());

  function render(timeLimit: TimeLimitOption) {
    const saveHighScore = vi.fn().mockResolvedValue(undefined);
    const getTopScores = vi.fn(() => of([]));
    const getLeaderboardEntry = vi.fn().mockResolvedValue(null);

    TestBed.configureTestingModule({
      providers: [
        {
          provide: GameControllerService,
          useValue: {
            score: signal(7),
            totalQuestions: signal(10),
            percentage: signal(70),
            questions: signal([]),
            config: signal(makeConfig(timeLimit)),
            flaggedQuestionIds: signal<ReadonlySet<string>>(new Set()),
            resetGame: () => undefined,
          },
        },
        {
          provide: AuthService,
          useValue: {
            user: signal({ uid: 'player-1', displayName: 'Ada' }),
            isFullyAuthenticated: signal(true),
            isAnonymous: signal(false),
          },
        },
        { provide: AuthMenuStateService, useValue: { open: () => undefined } },
        { provide: EmbedModeService, useValue: { isEmbedded: signal(false) } },
        {
          provide: FirebaseService,
          useValue: { saveHighScore, getTopScores, getLeaderboardEntry },
        },
        { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
      ],
    });

    const fixture = TestBed.createComponent(GameOverComponent);
    fixture.detectChanges();
    return { fixture, saveHighScore, getTopScores, host: fixture.nativeElement as HTMLElement };
  }

  it.each([
    [15 as TimeLimitOption, '15'],
    [30 as TimeLimitOption, '30'],
    ['unlimited' as TimeLimitOption, 'unlimited'],
  ])('loads the board matching the game played (%s)', (timeLimit, board) => {
    const { getTopScores } = render(timeLimit);
    expect(getTopScores).toHaveBeenCalledWith(board, 10);
  });

  /*
   * The write has to carry the same board twice — in the path and in the
   * `timeLimit` field — because `firestore.rules` requires them to agree. The
   * component derives both from one value, and this is what pins that.
   */
  it.each([
    [15 as TimeLimitOption, '15'],
    [30 as TimeLimitOption, '30'],
    ['unlimited' as TimeLimitOption, 'unlimited'],
  ])('writes the score to that same board (%s)', async (timeLimit, board) => {
    const { fixture, saveHighScore } = render(timeLimit);
    const component = fixture.componentInstance as unknown as {
      playerName: string;
      saveScore(): Promise<void>;
    };
    component.playerName = 'Ada';

    await component.saveScore();

    expect(saveHighScore).toHaveBeenCalledWith(expect.objectContaining({ timeLimit: board }));
  });

  it.each([
    [15 as TimeLimitOption, '15-second'],
    [30 as TimeLimitOption, '30-second'],
    ['unlimited' as TimeLimitOption, 'no-limit'],
  ])('names the board on screen (%s)', (timeLimit, label) => {
    const { host } = render(timeLimit);
    expect(host.querySelector('[data-cy="leaderboard-title"]')?.textContent).toContain(label);
  });

  // A game restored from a save written before the picker existed has no
  // limit recorded, and every one of those was played at 15 seconds.
  it('falls back to the 15s board when the game carries no limit', () => {
    const saveHighScore = vi.fn();
    const getTopScores = vi.fn(() => of([]));
    TestBed.configureTestingModule({
      providers: [
        {
          provide: GameControllerService,
          useValue: {
            score: signal(7),
            totalQuestions: signal(10),
            percentage: signal(70),
            questions: signal([]),
            config: signal(null),
            flaggedQuestionIds: signal<ReadonlySet<string>>(new Set()),
            resetGame: () => undefined,
          },
        },
        {
          provide: AuthService,
          useValue: {
            user: signal({ uid: 'p', displayName: 'Ada' }),
            isFullyAuthenticated: signal(true),
            isAnonymous: signal(false),
          },
        },
        { provide: AuthMenuStateService, useValue: { open: () => undefined } },
        { provide: EmbedModeService, useValue: { isEmbedded: signal(false) } },
        {
          provide: FirebaseService,
          useValue: { saveHighScore, getTopScores, getLeaderboardEntry: vi.fn() },
        },
        { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
      ],
    });
    const fixture = TestBed.createComponent(GameOverComponent);
    fixture.detectChanges();

    expect(getTopScores).toHaveBeenCalledWith('15', 10);
  });
});
