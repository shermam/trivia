import { TestBed } from '@angular/core/testing';
import { ApplicationRef, signal } from '@angular/core';
import { Router } from '@angular/router';
import { NEVER, Observable, Subject, of, throwError } from 'rxjs';
import {
  GameConfig,
  LeaderboardEntry,
  RegionalLeaderboardEntry,
  PickedAnswer,
  SKIPPED,
  TIMED_OUT,
  TimeLimitOption,
  TriviaQuestion,
  answeredWith,
} from '../../models/question.model';
import { AccountService } from '../../services/account.service';
import { AudioService } from '../../services/audio.service';
import { AuthService } from '../../services/auth.service';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { EmbedModeService } from '../../services/embed-mode.service';
import { FirebaseService, QuestionReportRejectedError } from '../../services/firebase.service';
import { FirestoreRestError } from '../../services/firestore-rest/firestore-rest.client';
import { GameControllerService } from '../../services/game-controller.service';
import { RegionService } from '../../services/region.service';
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
  correctAnswers?: number;
  maxStreak?: number;
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
          correctAnswers: signal(options.correctAnswers ?? options.score ?? 7),
          maxStreak: signal(options.maxStreak ?? 0),
          totalQuestions: signal(10),
          percentage: signal(70),
          questions: signal([]),
          config: signal(makeConfig(options.timeLimit)),
          flaggedQuestionIds: signal<ReadonlySet<string>>(new Set()),
          answerHistory: signal<readonly PickedAnswer[]>([]),
          answerDurations: signal<readonly number[]>([]),
          gameId: signal<string | null>('game-fixture'),
          resetGame: () => undefined,
        },
      },
      {
        provide: AuthService,
        useValue: {
          user: signal({ uid: 'player-1', displayName: 'Ada' }),
          isAnonymous: signal(false),
          isFullyAuthenticated: signal(true),
          resendVerificationEmail: () => Promise.resolve(),
        },
      },
      { provide: AuthMenuStateService, useValue: { open: () => undefined } },
      {
        provide: AccountService,
        useValue: { recordGameResult: vi.fn().mockResolvedValue(undefined) },
      },
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
          correctAnswers: signal(7),
          maxStreak: signal(4),
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
          answerHistory: signal<readonly PickedAnswer[]>([]),
          answerDurations: signal<readonly number[]>([]),
          gameId: signal<string | null>('game-fixture'),
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
      {
        provide: AccountService,
        useValue: { recordGameResult: vi.fn().mockResolvedValue(undefined) },
      },
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
 * The board holds its height, because ten is known before the data is.
 *
 * It used to be one line of "Loading leaderboard…" that became up to ten rows.
 * Measured against the compiled stylesheet, that is a **508px** jump — 68px to
 * 576px — landing exactly as a player reads their final score.
 *
 * jsdom does no layout, so the heights themselves are measured in a browser
 * (all three row kinds are 72px; every board configuration is 576px). What is
 * pinned here is the invariant those measurements rest on: **ten rows, always,
 * whatever the state.**
 */
describe('GameOverComponent — the leaderboard holds its height', () => {
  afterEach(() => TestBed.resetTestingModule());

  const BOARD_SIZE = 10;

  function renderBoard(
    topScores: LeaderboardEntry[],
    options: { fail?: boolean; pending?: boolean } = {},
  ) {
    const getTopScores = vi.fn(() => {
      if (options.pending) {
        // Never settles, so the loading state is a state the test can look at
        // rather than a race it has to win. `of(...)` resolves synchronously.
        return NEVER;
      }
      return options.fail ? throwError(() => new Error('nope')) : of(topScores);
    });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: GameControllerService,
          useValue: {
            score: signal(7),
            correctAnswers: signal(7),
            maxStreak: signal(4),
            totalQuestions: signal(10),
            percentage: signal(70),
            questions: signal([]),
            config: signal(makeConfig(15)),
            flaggedQuestionIds: signal<ReadonlySet<string>>(new Set()),
            answerHistory: signal<readonly PickedAnswer[]>([]),
            answerDurations: signal<readonly number[]>([]),
            gameId: signal<string | null>('game-fixture'),
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
        {
          provide: AccountService,
          useValue: { recordGameResult: vi.fn().mockResolvedValue(undefined) },
        },
        { provide: EmbedModeService, useValue: { isEmbedded: signal(false) } },
        {
          provide: FirebaseService,
          useValue: {
            saveHighScore: vi.fn().mockResolvedValue(undefined),
            getTopScores,
            getLeaderboardEntry: vi.fn().mockResolvedValue(null),
          },
        },
        { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
      ],
    });
    const fixture = TestBed.createComponent(GameOverComponent);
    fixture.detectChanges();
    return { fixture, host: fixture.nativeElement as HTMLElement };
  }

  const entry = (n: number): LeaderboardEntry =>
    makeEntry({ uid: `u${n}`, name: `Player ${n}`, score: 10 - n, percentage: (10 - n) * 10 });

  /**
   * Every box that holds a row's worth of height, whatever is inside it:
   * real entries, skeletons, and fillers alike.
   *
   * The `:not(...)` matters — the skeleton wrapper is itself an `aria-hidden`
   * direct child, so without it the loading state counts eleven.
   */
  const rowCount = (host: HTMLElement) => {
    const body = host.querySelector('[data-cy="leaderboard-body"]')!;
    return (
      body.querySelectorAll('li').length +
      body.querySelectorAll('[data-cy="leaderboard-skeleton"] > div').length +
      body.querySelectorAll(
        ':scope > div[aria-hidden="true"]:not([data-cy="leaderboard-skeleton"])',
      ).length
    );
  };

  it('shows ten skeleton rows while the fetch is in flight', () => {
    const { host } = renderBoard([], { pending: true });

    expect(host.querySelectorAll('[data-cy="leaderboard-skeleton"] > div').length).toBe(BOARD_SIZE);
    expect(rowCount(host)).toBe(BOARD_SIZE);
    // No real rows yet, and nothing claiming the board is empty.
    expect(host.querySelectorAll('[data-cy="leaderboard-body"] li').length).toBe(0);
    expect(host.querySelector('[data-cy="leaderboard-message"]')).toBeNull();
    expect(host.querySelector('[data-cy="leaderboard-status"]')?.textContent).toContain('Loading');
  });

  it('pads a partial board out to ten rows', async () => {
    const { fixture, host } = renderBoard([entry(1), entry(2), entry(3)]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(host.querySelectorAll('[data-cy="leaderboard-body"] li').length).toBe(3);
    expect(rowCount(host)).toBe(BOARD_SIZE);
  });

  it('adds no padding to a full board', async () => {
    const { fixture, host } = renderBoard(Array.from({ length: 10 }, (_, i) => entry(i)));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(host.querySelectorAll('[data-cy="leaderboard-body"] li').length).toBe(BOARD_SIZE);
    expect(rowCount(host)).toBe(BOARD_SIZE);
  });

  /**
   * The empty and failed boards keep their height too, with the message laid
   * *over* the reserved rows. Replacing the rows with the message instead would
   * put the shift back for exactly the players who see it — a first-ever game,
   * or a Firestore hiccup.
   */
  it('keeps the height when there are no scores, and says so', async () => {
    const { fixture, host } = renderBoard([]);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(rowCount(host)).toBe(BOARD_SIZE);
    expect(host.querySelector('[data-cy="leaderboard-message"]')?.textContent).toContain(
      'No scores yet',
    );
  });

  it('keeps the height when the fetch fails, and says so', async () => {
    const { fixture, host } = renderBoard([], { fail: true });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(rowCount(host)).toBe(BOARD_SIZE);
    expect(host.querySelector('[data-cy="leaderboard-message"]')?.textContent).toContain(
      'Could not load the leaderboard',
    );
  });

  /**
   * The placeholder rows are pixels, not content: a screen reader meeting ten
   * blank list items would be worse than the shift. `leaderboardStatus()` is
   * what carries their meaning into words.
   */
  it('keeps the placeholder rows out of the accessibility tree', async () => {
    const { fixture, host } = renderBoard([entry(1)]);
    await fixture.whenStable();
    fixture.detectChanges();

    const fillers = host.querySelectorAll('[data-cy="leaderboard-body"] > div[aria-hidden="true"]');
    expect(fillers.length).toBe(BOARD_SIZE - 1);
    expect(host.querySelector('[data-cy="leaderboard-status"]')).not.toBeNull();
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
            correctAnswers: signal(7),
            maxStreak: signal(4),
            totalQuestions: signal(10),
            percentage: signal(70),
            questions: signal([]),
            config: signal(makeConfig(timeLimit)),
            flaggedQuestionIds: signal<ReadonlySet<string>>(new Set()),
            answerHistory: signal<readonly PickedAnswer[]>([]),
            answerDurations: signal<readonly number[]>([]),
            gameId: signal<string | null>('game-fixture'),
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
        {
          provide: AccountService,
          useValue: { recordGameResult: vi.fn().mockResolvedValue(undefined) },
        },
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
            correctAnswers: signal(7),
            maxStreak: signal(4),
            totalQuestions: signal(10),
            percentage: signal(70),
            questions: signal([]),
            config: signal(null),
            flaggedQuestionIds: signal<ReadonlySet<string>>(new Set()),
            answerHistory: signal<readonly PickedAnswer[]>([]),
            answerDurations: signal<readonly number[]>([]),
            gameId: signal<string | null>('game-fixture'),
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
        {
          provide: AccountService,
          useValue: { recordGameResult: vi.fn().mockResolvedValue(undefined) },
        },
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

/**
 * **The card between the score and the leaderboard, and the bug it shipped
 * with.** Before auth answers, `user()` is `null`; `isAnonymous()` is
 * `user()?.isAnonymous ?? false`, so it reads `false`; and the old
 * `@else if (isAnonymous())` chain therefore fell straight through to its
 * "signed in but unverified" arm. A signed-out visitor was told to verify an
 * email they had never given us, and then watched it change to "sign in" a
 * moment later.
 *
 * The chain is now one computed, which is the point: an ordering bug inside a
 * template `@if`/`@else if` cannot be reached by a test, and this one can.
 */
describe('GameOverComponent: which face of the score card shows', () => {
  function cardSetup(auth: { user: unknown; isAnonymous: boolean; isFullyAuthenticated: boolean }) {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: GameControllerService,
          useValue: {
            score: signal(7),
            correctAnswers: signal(7),
            maxStreak: signal(4),
            totalQuestions: signal(10),
            percentage: signal(70),
            questions: signal([]),
            config: signal(makeConfig()),
            flaggedQuestionIds: signal<ReadonlySet<string>>(new Set()),
            answerHistory: signal<readonly PickedAnswer[]>([]),
            answerDurations: signal<readonly number[]>([]),
            gameId: signal<string | null>('game-fixture'),
            resetGame: () => undefined,
          },
        },
        {
          provide: AuthService,
          useValue: {
            user: signal(auth.user),
            isAnonymous: signal(auth.isAnonymous),
            isFullyAuthenticated: signal(auth.isFullyAuthenticated),
            resendVerificationEmail: () => Promise.resolve(),
          },
        },
        { provide: AuthMenuStateService, useValue: { open: () => undefined } },
        {
          provide: AccountService,
          useValue: { recordGameResult: vi.fn().mockResolvedValue(undefined) },
        },
        { provide: EmbedModeService, useValue: { isEmbedded: signal(false) } },
        {
          provide: FirebaseService,
          useValue: {
            saveHighScore: vi.fn(),
            getLeaderboardEntry: () => Promise.resolve(null),
            getTopScores: () => NEVER,
          },
        },
        { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
      ],
    });

    const fixture = TestBed.createComponent(GameOverComponent);
    const component = fixture.componentInstance as unknown as {
      scoreAction: () => string;
      hasSaved: { set: (value: boolean) => void };
      saveError: { set: (value: string | null) => void };
    };
    fixture.detectChanges();
    return { fixture, component };
  }

  const el = (fixture: { nativeElement: HTMLElement }, selector: string) =>
    fixture.nativeElement.querySelector(selector) as HTMLElement;

  /**
   * The regression test. `authReady` is not even consulted — the predicate
   * asserts a positive fact (`user() !== null && !isAnonymous()`) rather than
   * the absence of a negative, so "nothing has happened yet" and "signed out"
   * are the same answer by construction rather than by a second condition
   * somebody has to remember to add.
   */
  it('prompts sign-in, not verification, before auth has answered', () => {
    const { component } = cardSetup({
      user: null,
      isAnonymous: false,
      isFullyAuthenticated: false,
    });

    expect(component.scoreAction()).toBe('signIn');
  });

  // The same window reopens on every sign-out, between the old user going and
  // the replacement anonymous session arriving — so this is not a cold-start
  // curiosity.
  it('prompts sign-in in the gap between sign-out and the new anonymous session', () => {
    const { component } = cardSetup({
      user: null,
      isAnonymous: false,
      isFullyAuthenticated: true,
    });

    expect(component.scoreAction()).toBe('signIn');
  });

  it('prompts sign-in for an anonymous session', () => {
    const { component } = cardSetup({
      user: { uid: 'anon-1' },
      isAnonymous: true,
      isFullyAuthenticated: false,
    });

    expect(component.scoreAction()).toBe('signIn');
  });

  it('asks a real but unverified account to verify', () => {
    const { component } = cardSetup({
      user: { uid: 'player-1' },
      isAnonymous: false,
      isFullyAuthenticated: false,
    });

    expect(component.scoreAction()).toBe('verify');
  });

  it('offers the save form to a fully authenticated account', () => {
    const { component } = cardSetup({
      user: { uid: 'player-1' },
      isAnonymous: false,
      isFullyAuthenticated: true,
    });

    expect(component.scoreAction()).toBe('save');
  });

  it('shows the confirmation once a save has landed', () => {
    const { component, fixture } = cardSetup({
      user: { uid: 'player-1' },
      isAnonymous: false,
      isFullyAuthenticated: true,
    });

    component.hasSaved.set(true);
    fixture.detectChanges();

    expect(component.scoreAction()).toBe('saved');
  });

  it('shows the failure when a save landed with an error', () => {
    const { component, fixture } = cardSetup({
      user: { uid: 'player-1' },
      isAnonymous: false,
      isFullyAuthenticated: true,
    });

    component.hasSaved.set(true);
    component.saveError.set('Something went wrong.');
    fixture.detectChanges();

    expect(component.scoreAction()).toBe('saveFailed');
  });

  /**
   * The other half of the fix: the faces are stacked in one grid cell so the
   * card's height cannot depend on its state. jsdom has no layout, so it
   * cannot check the heights — `game-flow.spec.ts` does that at 390px wide.
   * What it *can* check is the mechanism the heights rest on: every face
   * present, exactly one of them not `invisible`.
   */
  it('renders every face, with exactly one visible', () => {
    const { fixture } = cardSetup({
      user: null,
      isAnonymous: false,
      isFullyAuthenticated: false,
    });

    const faces = [...el(fixture, '[data-cy="score-action"]').children];

    expect(faces.map((face) => face.getAttribute('data-cy'))).toEqual([
      'score-saved',
      'score-save-failed',
      'score-sign-in',
      'score-verify',
      'score-save',
    ]);
    const visible = faces.filter((face) => !face.classList.contains('invisible'));
    expect(visible.map((face) => face.getAttribute('data-cy'))).toEqual(['score-sign-in']);
  });

  /**
   * `invisible` is `visibility: hidden`, which keeps the box — that is what
   * reserves the height — while taking it out of the tab order and the
   * accessibility tree. The save form is the one that matters: an anonymous
   * visitor must not be able to tab into a form `firestore.rules` will reject.
   */
  it('keeps the save form out of reach while it is hidden', () => {
    const { fixture } = cardSetup({
      user: { uid: 'anon-1' },
      isAnonymous: true,
      isFullyAuthenticated: false,
    });

    const form = el(fixture, '[data-cy="score-save"]');
    expect(form.classList.contains('invisible')).toBe(true);
    expect(form.querySelector('input[name="playerName"]')).not.toBeNull();
  });
});

/**
 * `FEAT-001`. Rendered rather than signal-read throughout, because the whole
 * feature is a rendering: `recap()` returning the right rows proves nothing
 * about whether the panel opens, whether a timeout looks different from a
 * wrong answer, or whether the correct answer is shown when it should be.
 */
describe('GameOverComponent answer recap (FEAT-001)', () => {
  afterEach(() => TestBed.resetTestingModule());

  /** Two options with distinct ids; `wrongText` differing lets the assertions tell them apart. */
  function recapQuestion(id: string, overrides: Partial<TriviaQuestion> = {}): TriviaQuestion {
    return makeTriviaQuestion({
      id,
      question: `${id} text?`,
      category: 'History',
      difficulty: 'medium',
      correct_answer: `${id} right`,
      incorrect_answers: [`${id} wrong`],
      all_answers: [
        { id: `${id}:right`, text: `${id} right`, isCorrect: true },
        { id: `${id}:wrong`, text: `${id} wrong`, isCorrect: false },
      ],
      ...overrides,
    });
  }

  function render(options: { questions: TriviaQuestion[]; answerHistory: PickedAnswer[] }) {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: GameControllerService,
          useValue: {
            score: signal(1),
            correctAnswers: signal(1),
            maxStreak: signal(1),
            totalQuestions: signal(options.questions.length),
            percentage: signal(50),
            questions: signal(options.questions),
            config: signal(makeConfig()),
            flaggedQuestionIds: signal<ReadonlySet<string>>(new Set()),
            answerHistory: signal<readonly PickedAnswer[]>(options.answerHistory),
            answerDurations: signal<readonly number[]>([]),
            gameId: signal<string | null>('game-fixture'),
            resetGame: () => undefined,
          },
        },
        {
          provide: AuthService,
          useValue: {
            user: signal({ uid: 'player-1', displayName: 'Ada' }),
            isAnonymous: signal(false),
            isFullyAuthenticated: signal(true),
            resendVerificationEmail: () => Promise.resolve(),
          },
        },
        { provide: AuthMenuStateService, useValue: { open: () => undefined } },
        {
          provide: AccountService,
          useValue: { recordGameResult: vi.fn().mockResolvedValue(undefined) },
        },
        { provide: EmbedModeService, useValue: { isEmbedded: () => false } },
        {
          provide: FirebaseService,
          useValue: {
            saveHighScore: vi.fn().mockResolvedValue(undefined),
            getLeaderboardEntry: () => Promise.resolve(null),
            getTopScores: () => of([]),
          },
        },
        { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
      ],
    });
    const fixture = TestBed.createComponent(GameOverComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const query = (selector: string) => host.querySelector<HTMLElement>(selector);
    const queryAll = (selector: string) => Array.from(host.querySelectorAll<HTMLElement>(selector));
    return {
      fixture,
      host,
      query,
      queryAll,
      open() {
        query('[data-cy="recap-toggle"]')?.click();
        fixture.detectChanges();
      },
    };
  }

  const q0 = recapQuestion('q0');
  const q1 = recapQuestion('q1');
  const q2 = recapQuestion('q2');

  /**
   * `FEAT-022`. The rendering rules live in `SourceLinkComponent`'s own spec;
   * what these two pin is the wiring, which is the half a refactor breaks — a
   * recap row that stops passing the fields through renders exactly the same
   * as a question that never had a source, and nothing else would notice.
   */
  it('offers a source as a link on the row that has one, and nowhere else', () => {
    const cited = recapQuestion('q0', {
      sourceUrl: 'https://example.org/h2o',
      sourceTitle: 'Example Journal',
    });
    const { open, queryAll } = render({
      questions: [cited, q1],
      answerHistory: [answeredWith('q0:right'), answeredWith('q1:wrong')],
    });
    open();

    const rows = queryAll('[data-cy="recap-row"]');
    const link = rows[0].querySelector<HTMLAnchorElement>('[data-cy="question-source-link"]');
    expect(link?.getAttribute('href')).toBe('https://example.org/h2o');
    expect(link?.textContent).toContain('Example Journal');

    // The common case: no source, and therefore no row furniture at all — no
    // badge, no "unverified", no reserved empty line.
    expect(rows[1].querySelector('[data-cy="question-source"]')).toBeNull();
  });

  it("offers the contributor's justification on the row that carries one", () => {
    const explained = recapQuestion('q0', {
      explanation: 'CO2 and O2 are both real molecules, which is what makes this one tricky.',
    });
    const { open, queryAll } = render({
      questions: [explained, q1],
      answerHistory: [answeredWith('q0:right'), answeredWith('q1:wrong')],
    });
    open();

    const rows = queryAll('[data-cy="recap-row"]');
    expect(rows[0].querySelector('[data-cy="question-justification"]')?.textContent).toContain(
      'both real molecules',
    );

    // The common case: no justification, and therefore no row furniture at
    // all — no heading, no reserved empty block.
    expect(rows[1].querySelector('[data-cy="question-justification"]')).toBeNull();
  });

  it('shows a citation with no link as plain text', () => {
    const cited = recapQuestion('q0', { sourceTitle: 'Feynman Lectures, Vol. II' });
    const { open, queryAll } = render({
      questions: [cited],
      answerHistory: [answeredWith('q0:right')],
    });
    open();

    const row = queryAll('[data-cy="recap-row"]')[0];
    expect(row.querySelector('[data-cy="question-source"]')?.textContent).toContain(
      'Feynman Lectures',
    );
    expect(row.querySelector('[data-cy="question-source-link"]')).toBeNull();
  });

  it('summarises the round on the toggle, and starts collapsed', () => {
    const { query } = render({
      questions: [q0, q1, q2],
      answerHistory: [answeredWith('q0:right'), answeredWith('q1:wrong'), TIMED_OUT],
    });

    const toggle = query('[data-cy="recap-toggle"]');
    expect(toggle?.textContent).toContain('Review answers');
    expect(toggle?.textContent).toContain('(1/3 correct)');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(query('[data-cy="recap-panel"]')).toBeNull();
  });

  it('expands and collapses on the toggle', () => {
    const { query, queryAll, open } = render({
      questions: [q0, q1, q2],
      answerHistory: [answeredWith('q0:right'), answeredWith('q1:wrong'), TIMED_OUT],
    });

    open();
    expect(query('[data-cy="recap-toggle"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(queryAll('[data-cy="recap-row"]')).toHaveLength(3);

    open(); // toggling again
    expect(query('[data-cy="recap-toggle"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(query('[data-cy="recap-panel"]')).toBeNull();
  });

  // The disclosure contract from `CLAUDE.md` §4.5: `aria-controls` has to name
  // an element that actually exists once open, or it points at nothing.
  it('points aria-controls at the panel it opens', () => {
    const { query, open } = render({ questions: [q0], answerHistory: [answeredWith('q0:right')] });
    open();

    const controls = query('[data-cy="recap-toggle"]')?.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    expect(query('[data-cy="recap-panel"]')?.id).toBe(controls);
  });

  // ...and deliberately *not* `aria-haspopup`: the panel expands in place, so
  // announcing a popup would misdescribe it (§4.5's scoped exception).
  it('does not claim to open a popup', () => {
    const { query } = render({ questions: [q0], answerHistory: [answeredWith('q0:right')] });

    expect(query('[data-cy="recap-toggle"]')?.hasAttribute('aria-haspopup')).toBe(false);
  });

  it('renders every question with its number, text and badges', () => {
    const { queryAll, open } = render({
      questions: [q0, q1, q2],
      answerHistory: [answeredWith('q0:right'), answeredWith('q1:wrong'), TIMED_OUT],
    });
    open();

    const rows = queryAll('[data-cy="recap-row"]');
    expect(rows.map((row) => row.textContent?.trim().startsWith('1'))).toEqual([
      true,
      false,
      false,
    ]);
    expect(rows[1].textContent).toContain('q1 text?');
    expect(rows[1].textContent).toContain('History');
    expect(rows[1].textContent).toContain('medium');
  });

  // A correct answer shows what was picked and nothing else — repeating the
  // same string under "Correct answer" reads as a bug in the app.
  it('shows a correct answer once, with no second line', () => {
    const { queryAll, open } = render({
      questions: [q0],
      answerHistory: [answeredWith('q0:right')],
    });
    open();

    expect(queryAll('[data-cy="recap-picked"]')[0].textContent).toContain('q0 right');
    expect(queryAll('[data-cy="recap-correct"]')).toHaveLength(0);
  });

  it('shows the correct answer alongside a wrong pick', () => {
    const { queryAll, open } = render({
      questions: [q1],
      answerHistory: [answeredWith('q1:wrong')],
    });
    open();

    expect(queryAll('[data-cy="recap-picked"]')[0].textContent).toContain('q1 wrong');
    expect(queryAll('[data-cy="recap-correct"]')[0].textContent).toContain('q1 right');
  });

  /*
   * `FEAT-002`. A skip scores the same as a timeout and as a wrong answer, and
   * has to read as none of them: the player chose to move on, and telling them
   * "Time expired" is a small lie about their own game. This is the case the
   * `string | null` shape had no room for.
   */
  it('marks a skipped question as skipped, not as a timeout', () => {
    const { queryAll, open } = render({ questions: [q1], answerHistory: [SKIPPED] });
    open();

    const row = queryAll('[data-cy="recap-row"]')[0];
    expect(row.querySelector('[data-cy="recap-skipped"]')).not.toBeNull();
    expect(row.querySelector('[data-cy="recap-timed-out"]')).toBeNull();
    expect(row.querySelector('[data-cy="recap-picked"]')?.textContent).toContain(
      'You skipped this',
    );
    // Still shows what the answer was — the whole point of reviewing it.
    expect(row.querySelector('[data-cy="recap-correct"]')?.textContent).toContain('q1 right');
  });

  it('counts a skip as not-correct in the tally', () => {
    const { query } = render({
      questions: [q0, q1],
      answerHistory: [answeredWith('q0:right'), SKIPPED],
    });

    expect(query('[data-cy="recap-toggle"]')?.textContent).toContain('(1/2 correct)');
  });

  // Three outcomes, three renderings — asserted together so a future change
  // that collapses two of them fails here rather than in one branch's test.
  it('renders skipped, timed out and answered as three different things', () => {
    const { queryAll, open } = render({
      questions: [q0, q1, q2],
      answerHistory: [answeredWith('q0:wrong'), TIMED_OUT, SKIPPED],
    });
    open();

    const rows = queryAll('[data-cy="recap-row"]');
    expect(rows[0].querySelector('[data-cy="recap-picked"]')?.textContent).toContain('q0 wrong');
    expect(rows[1].querySelector('[data-cy="recap-picked"]')?.textContent).toContain('No answer');
    expect(rows[2].querySelector('[data-cy="recap-picked"]')?.textContent).toContain(
      'You skipped this',
    );
    expect(queryAll('[data-cy="recap-timed-out"]')).toHaveLength(1);
    expect(queryAll('[data-cy="recap-skipped"]')).toHaveLength(1);
  });

  // The case the old `boolean` signature could not represent. A timeout scores
  // the same as a wrong answer and has to *look* different, or the recap
  // claims the player picked something they never saw.
  it('marks a timeout as time expired rather than as a wrong answer', () => {
    const { queryAll, open } = render({ questions: [q2], answerHistory: [TIMED_OUT] });
    open();

    const row = queryAll('[data-cy="recap-row"]')[0];
    expect(row.querySelector('[data-cy="recap-timed-out"]')).not.toBeNull();
    expect(row.querySelector('[data-cy="recap-picked"]')?.textContent).toContain('No answer');
    expect(row.querySelector('[data-cy="recap-correct"]')?.textContent).toContain('q2 right');
  });

  it('does not mark an answered question as timed out', () => {
    const { queryAll, open } = render({
      questions: [q0],
      answerHistory: [answeredWith('q0:wrong')],
    });
    open();

    expect(
      queryAll('[data-cy="recap-row"]')[0].querySelector('[data-cy="recap-timed-out"]'),
    ).toBeNull();
  });

  // Identity is the id, never the text (`CLAUDE.md` §4.4). Two options sharing
  // a string is exactly the data that made a wrong answer score as correct
  // once already, and a text-matching recap would repeat it one screen later.
  it('scores by id when two options carry the same text', () => {
    const ambiguous = recapQuestion('amb', {
      all_answers: [
        { id: 'amb:right', text: 'Same', isCorrect: true },
        { id: 'amb:wrong', text: 'Same', isCorrect: false },
      ],
    });
    const { query, queryAll, open } = render({
      questions: [ambiguous],
      answerHistory: [answeredWith('amb:wrong')],
    });

    expect(query('[data-cy="recap-toggle"]')?.textContent).toContain('(0/1 correct)');
    open();
    expect(queryAll('[data-cy="recap-correct"]')).toHaveLength(1);
  });

  /*
   * The whole card is absent unless the history covers the round. A save
   * written before this feature restores with none, and a recap built from it
   * would read "Review answers (0/3 correct)" underneath a score card saying
   * 2/3 — confidently wrong, which is worse than nothing at all.
   */
  it.each([
    ['no history at all', [] as PickedAnswer[]],
    ['a partial history', [answeredWith('q0:right')] as PickedAnswer[]],
  ])('renders no recap for %s', (_label, answerHistory) => {
    const { query } = render({ questions: [q0, q1, q2], answerHistory });

    expect(query('[data-cy="recap-card"]')).toBeNull();
  });

  /*
   * A history *longer* than the round — the one input the length check catches
   * that nothing else does, and the reason this test exists at all. Deleting
   * `history.length !== questions.length` left the whole suite green until it
   * was written: a *shorter* history yields `undefined` per missing entry,
   * which the unresolvable-pick guard below already refuses, so every case
   * covered above proved the wrong line. Here every entry resolves — there is
   * simply one too many, and only the length comparison notices.
   */
  it('renders no recap for a history longer than the round', () => {
    const { query } = render({
      questions: [q0],
      answerHistory: [answeredWith('q0:right'), answeredWith('q1:right')],
    });

    expect(query('[data-cy="recap-card"]')).toBeNull();
  });

  // Same all-or-nothing stance, for an id that names an option on a different
  // question: it would render a plausible, wrong row rather than an obviously
  // broken one, so the card goes rather than the row.
  it("renders no recap when an entry names another question's option", () => {
    const { query } = render({
      questions: [q0, q1],
      answerHistory: [answeredWith('q1:right'), answeredWith('q0:right')],
    });

    expect(query('[data-cy="recap-card"]')).toBeNull();
  });
});

/**
 * Recording a finished game into `users/{uid}`. Rendered through the real
 * component rather than calling the private method, because the two things
 * worth pinning are *when* it fires (on init, unconditionally) and *what it
 * sends* — and what it sends is now three numbers that no longer coincide, so
 * sending the wrong one is a live mistake rather than a hypothetical.
 */
describe('GameOverComponent lifetime stats recording', () => {
  afterEach(() => TestBed.resetTestingModule());

  function statsQuestion(id: string): TriviaQuestion {
    return makeTriviaQuestion({
      id,
      all_answers: [
        { id: `${id}:right`, text: 'right', isCorrect: true },
        { id: `${id}:wrong`, text: 'wrong', isCorrect: false },
      ],
    });
  }

  function render(options: {
    questions: TriviaQuestion[];
    answerHistory: PickedAnswer[];
    score: number;
    correctAnswers: number;
    maxStreak: number;
    gameId?: string | null;
  }) {
    const recordGameResult = vi.fn().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: GameControllerService,
          useValue: {
            score: signal(options.score),
            correctAnswers: signal(options.correctAnswers),
            maxStreak: signal(options.maxStreak),
            totalQuestions: signal(options.questions.length),
            percentage: signal(50),
            questions: signal(options.questions),
            config: signal(makeConfig()),
            flaggedQuestionIds: signal<ReadonlySet<string>>(new Set()),
            answerHistory: signal<readonly PickedAnswer[]>(options.answerHistory),
            answerDurations: signal<readonly number[]>([]),
            gameId: signal<string | null>(options.gameId === undefined ? 'game-1' : options.gameId),
            resetGame: () => undefined,
          },
        },
        {
          provide: AuthService,
          useValue: {
            user: signal({ uid: 'player-1', displayName: 'Ada' }),
            isAnonymous: signal(false),
            isFullyAuthenticated: signal(true),
            resendVerificationEmail: () => Promise.resolve(),
          },
        },
        { provide: AuthMenuStateService, useValue: { open: () => undefined } },
        { provide: AccountService, useValue: { recordGameResult } },
        { provide: EmbedModeService, useValue: { isEmbedded: () => false } },
        {
          provide: FirebaseService,
          useValue: {
            saveHighScore: vi.fn().mockResolvedValue(undefined),
            getLeaderboardEntry: () => Promise.resolve(null),
            getTopScores: () => of([]),
          },
        },
        { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
      ],
    });
    const fixture = TestBed.createComponent(GameOverComponent);
    fixture.detectChanges();
    return { recordGameResult };
  }

  const q = [statsQuestion('q0'), statsQuestion('q1'), statsQuestion('q2'), statsQuestion('q3')];
  const history: PickedAnswer[] = [
    answeredWith('q0:right'),
    answeredWith('q1:right'),
    answeredWith('q2:wrong'),
    answeredWith('q3:right'),
  ];

  it('records the finished game on init', () => {
    const { recordGameResult } = render({
      questions: q,
      answerHistory: history,
      score: 3,
      correctAnswers: 3,
      maxStreak: 2,
    });

    expect(recordGameResult).toHaveBeenCalledExactlyOnceWith({
      gameId: 'game-1',
      totalQuestions: 4,
      correctAnswers: 3,
      bestStreak: 2,
    });
  });

  /*
   * **The regression this test exists for.** `correctAnswers` was sent as
   * `score()`, correct only while the two were the same quantity. A streak
   * multiplier carries the score past the question count, and
   * `isValidSubmission` refuses a correct-answer count above `totalQuestions`
   * — so the whole submission would be dropped, silently, for exactly the
   * games a player most wants counted. All three numbers in this fixture are
   * deliberately different.
   */
  it('sends the correct-answer count, never the multiplied score', () => {
    const { recordGameResult } = render({
      questions: q,
      answerHistory: history,
      score: 9,
      correctAnswers: 3,
      maxStreak: 2,
    });

    expect(recordGameResult.mock.calls[0][0].correctAnswers).toBe(3);
  });

  /*
   * The streak is the run the quiz counted, not one re-derived from the recap
   * here. The two disagree by design: a skip leaves the run intact
   * (`FEAT-004`) and appears in the history as an answer nobody got right, so
   * a recap-derived walk would under-report exactly the games that spent a
   * lifeline well. This fixture would derive 2 and must report 3.
   */
  it('sends the run the game tracked, not one re-derived from the recap', () => {
    const { recordGameResult } = render({
      questions: q,
      answerHistory: [
        answeredWith('q0:right'),
        SKIPPED,
        answeredWith('q2:right'),
        answeredWith('q3:right'),
      ],
      score: 3,
      correctAnswers: 3,
      maxStreak: 3,
    });

    expect(recordGameResult.mock.calls[0][0].bestStreak).toBe(3);
  });

  /*
   * A game restored from a save written before the counters existed has no
   * streak to report, so it banks as 0 while the score is genuinely 3. The
   * game is still banked — a knowing under-report beats losing the totals —
   * and the server accepts it (`game-stats.test.ts` pins the accept case).
   */
  it('still records a game whose save predates the counters, with a zero streak', () => {
    const { recordGameResult } = render({
      questions: q,
      answerHistory: [],
      score: 3,
      correctAnswers: 3,
      maxStreak: 0,
    });

    expect(recordGameResult).toHaveBeenCalledExactlyOnceWith({
      gameId: 'game-1',
      totalQuestions: 4,
      correctAnswers: 3,
      bestStreak: 0,
    });
  });

  /*
   * **The duplicate guard.** A save written before `gameId` existed restores
   * with `null`, and minting one here would produce a fresh id on every reload
   * of this screen — inflating the totals on each one, which is precisely what
   * the id exists to prevent. Not banking it is the cheaper mistake.
   */
  it('records nothing when the game has no id', () => {
    const { recordGameResult } = render({
      questions: q,
      answerHistory: history,
      score: 4,
      correctAnswers: 4,
      maxStreak: 4,
      gameId: null,
    });

    expect(recordGameResult).not.toHaveBeenCalled();
  });
});

/**
 * The end-of-round cue (`FEAT-003`).
 *
 * The variant is chosen from **accuracy**, not from the point total and not
 * from anything about previous games: this screen does not know whether the
 * player has ever done better, and inventing a personal-best signal to feed a
 * fanfare would be a claim the app cannot check (`CLAUDE.md` §4.4). So the only
 * thing asserted is that the perfect round and the ordinary one are told apart,
 * and that a multiplied score — which can exceed the question count — is not
 * what does the telling.
 */
describe('GameOverComponent — the end-of-round cue (FEAT-003)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function render(options: { correctAnswers: number; totalQuestions: number; score?: number }) {
    const playGameOver = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        {
          provide: GameControllerService,
          useValue: {
            score: signal(options.score ?? options.correctAnswers),
            correctAnswers: signal(options.correctAnswers),
            maxStreak: signal(options.correctAnswers),
            totalQuestions: signal(options.totalQuestions),
            percentage: signal(
              options.totalQuestions === 0
                ? 0
                : Math.round((options.correctAnswers / options.totalQuestions) * 100),
            ),
            questions: signal([]),
            config: signal(makeConfig()),
            flaggedQuestionIds: signal<ReadonlySet<string>>(new Set()),
            answerHistory: signal<readonly PickedAnswer[]>([]),
            answerDurations: signal<readonly number[]>([]),
            gameId: signal<string | null>('game-fixture'),
            resetGame: () => undefined,
          },
        },
        {
          provide: AuthService,
          useValue: {
            user: signal({ uid: 'player-1', displayName: 'Ada' }),
            isAnonymous: signal(false),
            isFullyAuthenticated: signal(true),
            resendVerificationEmail: () => Promise.resolve(),
          },
        },
        { provide: AuthMenuStateService, useValue: { open: () => undefined } },
        {
          provide: AccountService,
          useValue: { recordGameResult: vi.fn().mockResolvedValue(undefined) },
        },
        { provide: EmbedModeService, useValue: { isEmbedded: () => false } },
        {
          provide: FirebaseService,
          useValue: {
            saveHighScore: vi.fn(),
            getLeaderboardEntry: () => Promise.resolve(null),
            getTopScores: () => of([]),
          },
        },
        {
          provide: AudioService,
          useValue: {
            isMuted: signal(false),
            toggleMute: vi.fn(),
            playCorrect: vi.fn(),
            playIncorrect: vi.fn(),
            playTimerTick: vi.fn(),
            playLifeline: vi.fn(),
            playGameOver,
          },
        },
        { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
      ],
    });

    const fixture = TestBed.createComponent(GameOverComponent);
    fixture.detectChanges();
    return { fixture, playGameOver };
  }

  it('celebrates a round with every question right', () => {
    const { playGameOver } = render({ correctAnswers: 5, totalQuestions: 5 });

    expect(playGameOver).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('plays the ordinary cue when one answer was missed', () => {
    const { playGameOver } = render({ correctAnswers: 4, totalQuestions: 5 });

    expect(playGameOver).toHaveBeenCalledExactlyOnceWith(false);
  });

  /**
   * The trap a score-based test would fall into. Streak multipliers make a
   * perfect five-question round worth seven points, so "score equals question
   * count" is false for exactly the round that should be celebrated — and
   * "score is at least the question count" is true for rounds that should not
   * be. Accuracy is the only number that survives multipliers (§1.1).
   */
  it('reads accuracy, not the multiplied point total', () => {
    const { playGameOver } = render({ correctAnswers: 5, totalQuestions: 5, score: 7 });

    expect(playGameOver).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('treats a round with nothing right as an ordinary one', () => {
    const { playGameOver } = render({ correctAnswers: 0, totalQuestions: 5, score: 0 });

    expect(playGameOver).toHaveBeenCalledExactlyOnceWith(false);
  });
});

/**
 * `FEAT-028`: the region picker, the Global/Regional toggle, and the save that
 * now writes two documents.
 *
 * Three properties are worth more than the rest here. The **preselection is
 * not a declaration** — it fills the control and touches nothing durable, and
 * an answer that arrives late must never overwrite a choice already made. The
 * **two writes are independent** — separate documents under separate
 * improving-score floors, so a round can publish one and be refused the other,
 * and the refusal that gets narrated is still only the one the component can
 * verify. And the **regional tab with no country never becomes a failure** —
 * it explains, rather than reading an empty board or asking for a location.
 */
describe('GameOverComponent — regional leaderboards (FEAT-028)', () => {
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  function render(
    options: {
      declared?: string | null;
      inferred?: string | null | Promise<string | null>;
      saveGlobal?: () => Promise<void>;
      saveRegional?: () => Promise<void>;
      regionalTop?: LeaderboardEntry[];
      /** Replaces the whole read, for the tests that need to control when it resolves. */
      getTopScores?: () => Observable<LeaderboardEntry[]>;
      getRegionalTopScores?: () => Observable<LeaderboardEntry[]>;
    } = {},
  ) {
    const declaredRegion = signal<string | null>(options.declared ?? null);
    // Typed by their parameter, not only their result: the assertions below
    // read the payload each board was written with, and a `vi.fn()` inferred
    // from a nullary stub records calls typed as an empty tuple.
    const saveHighScore = vi.fn((_entry: LeaderboardEntry) =>
      (options.saveGlobal ?? (() => Promise.resolve()))(),
    );
    const saveRegionalHighScore = vi.fn((_entry: RegionalLeaderboardEntry) =>
      (options.saveRegional ?? (() => Promise.resolve()))(),
    );
    const getTopScores = vi.fn(
      options.getTopScores ?? ((): Observable<LeaderboardEntry[]> => of([])),
    );
    const getRegionalTopScores = vi.fn(
      options.getRegionalTopScores ??
        ((): Observable<LeaderboardEntry[]> => of(options.regionalTop ?? [])),
    );
    const getLeaderboardEntry = vi.fn().mockResolvedValue(null);
    const declareRegion = vi.fn((region: string | null) => declaredRegion.set(region));

    TestBed.configureTestingModule({
      providers: [
        {
          provide: GameControllerService,
          useValue: {
            score: signal(7),
            correctAnswers: signal(7),
            maxStreak: signal(4),
            totalQuestions: signal(10),
            percentage: signal(70),
            questions: signal([]),
            config: signal(makeConfig(15)),
            flaggedQuestionIds: signal<ReadonlySet<string>>(new Set()),
            answerHistory: signal<readonly PickedAnswer[]>([]),
            answerDurations: signal<readonly number[]>([]),
            gameId: signal<string | null>('game-fixture'),
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
        {
          provide: AccountService,
          useValue: { recordGameResult: vi.fn().mockResolvedValue(undefined) },
        },
        { provide: EmbedModeService, useValue: { isEmbedded: signal(false) } },
        {
          provide: FirebaseService,
          useValue: {
            saveHighScore,
            saveRegionalHighScore,
            getTopScores,
            getRegionalTopScores,
            getLeaderboardEntry,
          },
        },
        {
          provide: RegionService,
          useValue: {
            declaredRegion,
            declareRegion,
            inferredRegion: () => Promise.resolve(options.inferred ?? null),
          },
        },
        { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
      ],
    });

    const fixture = TestBed.createComponent(GameOverComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance as unknown as {
      playerName: string;
      saveScore(): Promise<void>;
      hasSaved(): boolean;
      saveError(): string | null;
      selectedRegion(): string;
      onRegionChange(region: string): void;
      onBoardScopeChange(scope: 'global' | 'regional'): void;
      leaderboard(): LeaderboardEntry[];
      isLoadingLeaderboard(): boolean;
    };
    component.playerName = 'Ada';
    return {
      fixture,
      component,
      declareRegion,
      saveHighScore,
      saveRegionalHighScore,
      getTopScores,
      getRegionalTopScores,
      host: fixture.nativeElement as HTMLElement,
    };
  }

  const select = (host: HTMLElement) =>
    host.querySelector<HTMLSelectElement>('[data-cy="save-score-region"]')!;
  const message = (host: HTMLElement) =>
    host.querySelector('[data-cy="leaderboard-message"]')?.textContent?.trim() ?? null;

  it('opens on nothing when the app cannot tell and the player has not said', async () => {
    const { fixture, component, host } = render();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.selectedRegion()).toBe('');
    expect(select(host).value).toBe('');
  });

  it('preselects the country the app inferred', async () => {
    const { fixture, component, host } = render({ inferred: 'BR' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.selectedRegion()).toBe('BR');
    expect(select(host).value).toBe('BR');
  });

  // The preselection is a suggestion, not a record: it must not write itself.
  it('does not declare the country it merely inferred', async () => {
    const { fixture, declareRegion } = render({ inferred: 'BR' });
    await fixture.whenStable();

    expect(declareRegion).not.toHaveBeenCalled();
  });

  /*
   * **Read off the element, not off the signal**, and that is the whole test.
   * A `[value]` binding on the `<select>` set the signal's value onto an
   * element whose options the `@for` had not created yet, and Angular never
   * re-applied it — so `selectedRegion()` said `PT` and the control said
   * "Prefer not to say" for every game after the first save. Two things
   * followed and neither was visible from the signal: the save published a
   * country the reader could not see, falsifying the Privacy Policy's "what is
   * published is whatever the dropdown says"; and picking "Prefer not to say"
   * fired no `change`, because it was already the selected option, so there
   * was no way out. `CLAUDE.md` §4.4 — drive the real element.
   */
  it('opens the control itself on the stored declaration, not just the signal', async () => {
    const { fixture, component, host } = render({ declared: 'PT', inferred: 'BR' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.selectedRegion()).toBe('PT');
    expect(select(host).value).toBe('PT');
  });

  it('lets a reader with a stored country opt back out', async () => {
    const { fixture, component, declareRegion, host } = render({ declared: 'PT' });
    await fixture.whenStable();
    fixture.detectChanges();

    const control = select(host);
    // **The precondition is the test.** Driving `value` from here proves
    // nothing on its own — a spec that sets the control directly cannot see a
    // control that was never set (`CLAUDE.md` §4.4). What made opting out
    // impossible was the element sitting on "Prefer not to say" while the
    // signal said Portugal: choosing it then selects the already-selected
    // option and fires no `change` at all.
    expect(control.value).toBe('PT');

    control.value = '';
    control.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(declareRegion).toHaveBeenCalledWith(null);
    expect(component.selectedRegion()).toBe('');
    expect(control.value).toBe('');
  });

  /*
   * The race the pricing switch documents, on a slower screen: `/api/geo`
   * takes up to two seconds, and a reader who picked a country in the first
   * one must not watch it change in the second.
   */
  it('leaves a choice made before the guess arrives alone', async () => {
    let answer!: (country: string | null) => void;
    const pending = new Promise<string | null>((resolve) => {
      answer = resolve;
    });
    const { fixture, component } = render({ inferred: pending });

    component.onRegionChange('JP');
    answer('BR');
    await fixture.whenStable();

    expect(component.selectedRegion()).toBe('JP');
  });

  it('records a country the player picks', () => {
    const { component, declareRegion } = render();

    component.onRegionChange('BR');

    expect(declareRegion).toHaveBeenCalledWith('BR');
    expect(component.selectedRegion()).toBe('BR');
  });

  it('withdraws the declaration when the player prefers not to say', () => {
    const { component, declareRegion } = render({ declared: 'BR' });

    component.onRegionChange('');

    expect(declareRegion).toHaveBeenCalledWith(null);
    expect(component.selectedRegion()).toBe('');
  });

  it('publishes to both boards, with the country in the path and on the document', async () => {
    const { fixture, component, saveHighScore, saveRegionalHighScore } = render({
      inferred: 'BR',
    });
    await fixture.whenStable();

    await component.saveScore();

    expect(saveHighScore).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'player-1', timeLimit: '15' }),
    );
    expect(saveRegionalHighScore).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'player-1', timeLimit: '15', region: 'BR' }),
    );
    // The two documents differ in exactly one key. `firestore.rules` refuses a
    // `region` on the global board and requires one here, so a payload shared
    // wholesale between them would be rejected at one of the two paths.
    expect(saveHighScore.mock.calls[0][0]).not.toHaveProperty('region');
  });

  it('publishes only the global board when no country is set', async () => {
    const { fixture, component, saveHighScore, saveRegionalHighScore } = render();
    await fixture.whenStable();

    await component.saveScore();

    expect(saveHighScore).toHaveBeenCalledTimes(1);
    expect(saveRegionalHighScore).not.toHaveBeenCalled();
    expect(component.hasSaved()).toBe(true);
  });

  /*
   * The case the two independent writes exist for. A player whose global best
   * already stands is refused there and is still first in a country they have
   * only just declared — so the round did publish something, and telling them
   * it failed would be false.
   */
  it('counts as saved when the global board refuses but the country board accepts', async () => {
    const { fixture, component } = render({
      declared: 'BR',
      saveGlobal: () => Promise.reject(permissionDenied()),
    });
    await fixture.whenStable();

    await component.saveScore();

    expect(component.hasSaved()).toBe(true);
    expect(component.saveError()).toBeNull();
  });

  it('counts as saved when the country board refuses but the global one accepts', async () => {
    const { fixture, component } = render({
      declared: 'BR',
      saveRegional: () => Promise.reject(permissionDenied()),
    });
    await fixture.whenStable();

    await component.saveScore();

    expect(component.hasSaved()).toBe(true);
    expect(component.saveError()).toBeNull();
  });

  // Only a round that published nothing gets an explanation, and it is still
  // the one the component verified against the player's own row (B4).
  it('explains the failure only when both boards refuse', async () => {
    const { fixture, component } = render({
      declared: 'BR',
      saveGlobal: () => Promise.reject(permissionDenied()),
      saveRegional: () => Promise.reject(permissionDenied()),
    });
    await fixture.whenStable();

    await component.saveScore();

    expect(component.hasSaved()).toBe(false);
    expect(component.saveError()).toBe('Could not save your score. Please try again.');
  });

  it('reads the country board when the toggle is switched to it', async () => {
    const { fixture, component, getRegionalTopScores } = render({ declared: 'BR' });
    await fixture.whenStable();

    component.onBoardScopeChange('regional');
    await fixture.whenStable();

    expect(getRegionalTopScores).toHaveBeenCalledWith('15', 'BR', 10);
  });

  it('re-reads the board when the country changes under the regional tab', async () => {
    const { fixture, component, getRegionalTopScores } = render({ declared: 'BR' });
    await fixture.whenStable();
    component.onBoardScopeChange('regional');
    await fixture.whenStable();

    component.onRegionChange('PT');
    await fixture.whenStable();

    expect(getRegionalTopScores).toHaveBeenLastCalledWith('15', 'PT', 10);
  });

  /*
   * Never blocks and never asks for a location: the tab is selectable with no
   * country set, and what it shows is how to get one. Reading a board here
   * would mean querying a path that does not exist and then narrating the
   * empty result as "no scores yet", which is a claim no request supports
   * (`CLAUDE.md` §4.4).
   */
  it('offers to set a country instead of reading a board that has no path', async () => {
    const { fixture, component, getRegionalTopScores, host } = render();
    await fixture.whenStable();

    component.onBoardScopeChange('regional');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(getRegionalTopScores).not.toHaveBeenCalled();
    expect(message(host)).toContain('Choose your country');
  });

  /**
   * The regional tab is showing and the guess lands *after* it — a slow
   * `/api/geo` on a reader who switched boards in the first second.
   *
   * Setting the country without reading its board left `leaderboard()` empty
   * and `isLoadingLeaderboard()` false, so `leaderboardMessage` fell straight
   * through to its empty-board branch and told the reader "No scores in Brazil
   * yet. Be the first!" about a board nothing had asked for — the most
   * specific of the available answers, arrived at by not knowing (`CLAUDE.md`
   * §4.4). The read is what makes the claim honest, and the loading flag it
   * sets synchronously is what keeps the wrong message off the screen in the
   * meantime.
   */
  it('reads the board when the guess arrives with the regional tab already showing', async () => {
    let answer!: (country: string | null) => void;
    const pending = new Promise<string | null>((resolve) => {
      answer = resolve;
    });
    // Held open so the window between "the country is set" and "the board has
    // answered" — the window the bug lived in — can be inspected rather than
    // stepped over.
    const board = new Subject<LeaderboardEntry[]>();
    const rows = [makeEntry({ uid: 'br-player', name: 'BR Player' })];
    const { fixture, component, getRegionalTopScores, host } = render({
      inferred: pending,
      getRegionalTopScores: () => board,
    });

    component.onBoardScopeChange('regional');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(getRegionalTopScores).not.toHaveBeenCalled();
    expect(message(host)).toContain('Choose your country');

    answer('BR');
    await fixture.whenStable();
    fixture.detectChanges();

    // The country has landed and the read is in flight: skeletons, and no
    // claim about a board nobody has heard back from.
    expect(getRegionalTopScores).toHaveBeenCalledWith('15', 'BR', 10);
    expect(component.isLoadingLeaderboard()).toBe(true);
    expect(message(host)).toBeNull();

    board.next(rows);
    board.complete();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.leaderboard().map((entry) => entry.uid)).toEqual(['br-player']);
    expect(message(host)).toBeNull();
  });

  /**
   * Two boards are one click apart, so Global → Regional → Global puts two
   * reads in flight and the network decides which lands last. Without a
   * sequence number the loser wins: the world's top ten renders under "In
   * Brazil", or the country's under "Worldwide", and nothing about the screen
   * says which board the rows came from.
   *
   * Resolved deliberately out of order here, because in-order resolution is
   * the case that passes either way.
   */
  it('discards a board read that a later one has already superseded', async () => {
    const globalRows = [makeEntry({ uid: 'global-player', name: 'Global Player' })];
    const regionalRows = [makeEntry({ uid: 'regional-player', name: 'Regional Player' })];

    const regional = new Subject<LeaderboardEntry[]>();
    const second = new Subject<LeaderboardEntry[]>();
    let globalCalls = 0;

    const { fixture, component } = render({
      declared: 'BR',
      // The first global read is the one `ngOnInit` issues and resolves at
      // once; the second is the one this test races.
      getTopScores: () => (globalCalls++ === 0 ? of(globalRows) : second),
      getRegionalTopScores: () => regional,
    });
    await fixture.whenStable();

    component.onBoardScopeChange('regional');
    component.onBoardScopeChange('global');
    await fixture.whenStable();

    // The regional read finishes last, and is now the stale one.
    second.next(globalRows);
    second.complete();
    regional.next(regionalRows);
    regional.complete();
    await fixture.whenStable();

    expect(component.leaderboard().map((entry) => entry.uid)).toEqual(['global-player']);
    expect(component.isLoadingLeaderboard()).toBe(false);
  });

  it('names the country in the board header once one is set', async () => {
    const { fixture, component, host } = render({ declared: 'BR' });
    await fixture.whenStable();

    component.onBoardScopeChange('regional');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(host.querySelector('[data-cy="leaderboard-scope"]')?.textContent).toContain('Brazil');
    // The heading itself does not move: the country is a second line rendered
    // in both states, so the header keeps one height across the toggle (§4.4).
    expect(host.querySelector('[data-cy="leaderboard-title"]')?.textContent).toContain(
      'Top 10 — 15-second games',
    );
  });

  it('says the board is worldwide before anybody switches', async () => {
    const { fixture, host } = render({ declared: 'BR' });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(host.querySelector('[data-cy="leaderboard-scope"]')?.textContent).toContain('Worldwide');
  });

  /*
   * `CLAUDE.md` §4.5: a segmented pair conveys nothing about what it selects
   * unless the group itself is named. Built from real radios inside a
   * `role="radiogroup"`, the same shape as the pricing page's currency switch,
   * so the group's keyboard behaviour is the platform's rather than ours — and
   * so the e2e suite's existing `expectRadiosAreGrouped` sweep covers it.
   *
   * Both options are rendered in both states, with fixed labels, so nothing
   * about the toggle can resize as the preselection lands (§4.4, the account
   * chip's defect).
   */
  it('groups the toggle as a labelled radiogroup with both options always present', async () => {
    const { fixture, component, host } = render();
    await fixture.whenStable();
    fixture.detectChanges();

    const group = host.querySelector('[data-cy="board-scope"]')!;
    expect(group.getAttribute('role')).toBe('radiogroup');
    const labelledBy = group.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(host.querySelector(`#${labelledBy}`)?.textContent?.trim()).toBeTruthy();

    const radios = [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((radio) => radio.value)).toEqual(['global', 'regional']);
    expect(radios.map((radio) => radio.checked)).toEqual([true, false]);
    const labels = radios.map((radio) => radio.closest('label')?.textContent?.trim());

    component.onBoardScopeChange('regional');
    fixture.detectChanges();

    expect(radios.map((radio) => radio.checked)).toEqual([false, true]);
    expect(radios.map((radio) => radio.closest('label')?.textContent?.trim())).toEqual(labels);
  });

  // The picker is a country list, not an address field: `autocomplete` tokens
  // describe the user, and this describes which board they compete on.
  it('labels the picker and offers an opt-out, with no autocomplete token', async () => {
    const { fixture, host } = render();
    await fixture.whenStable();
    fixture.detectChanges();

    const control = select(host);
    expect(host.querySelector(`label[for="${control.id}"]`)?.textContent?.trim()).toBeTruthy();
    expect(control.getAttribute('autocomplete')).toBeNull();
    expect(control.options[0].value).toBe('');
    expect(control.options.length).toBeGreaterThan(200);
  });
});

/**
 * `FEAT-049` — what the screen submits about the round it just showed.
 *
 * The shaping is `buildPlayAnswers`' and is tested directly in
 * `play-history.util.spec.ts`; what is pinned here is the wiring, which is the
 * half that can be silently wrong: the payload reaching the callable at all,
 * and the key being **omitted** rather than sent short when the game has no
 * usable history — a short array is a submission `recordGameResult` refuses
 * whole, taking the lifetime totals with it.
 */
describe('GameOverComponent — the play history it submits (FEAT-049)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function question(id: string): TriviaQuestion {
    return {
      id,
      category: 'Science',
      type: 'multiple',
      difficulty: 'easy',
      question: `Question ${id}?`,
      correct_answer: 'A',
      incorrect_answers: ['B'],
      all_answers: [
        { id: `${id}:right`, text: 'A', isCorrect: true },
        { id: `${id}:wrong`, text: 'B', isCorrect: false },
      ],
      source: 'custom',
    };
  }

  function render(options: {
    questions: TriviaQuestion[];
    answerHistory: PickedAnswer[];
    answerDurations: number[];
    gameId?: string | null;
  }) {
    const recordGameResult = vi.fn().mockResolvedValue(undefined);

    TestBed.configureTestingModule({
      providers: [
        {
          provide: GameControllerService,
          useValue: {
            score: signal(1),
            correctAnswers: signal(1),
            maxStreak: signal(1),
            totalQuestions: signal(options.questions.length),
            percentage: signal(50),
            questions: signal(options.questions),
            config: signal(makeConfig()),
            flaggedQuestionIds: signal<ReadonlySet<string>>(new Set()),
            answerHistory: signal<readonly PickedAnswer[]>(options.answerHistory),
            answerDurations: signal<readonly number[]>(options.answerDurations),
            gameId: signal<string | null>('gameId' in options ? options.gameId! : 'game-fixture'),
            resetGame: () => undefined,
          },
        },
        {
          provide: AuthService,
          useValue: {
            user: signal({ uid: 'player-1', displayName: 'Ada' }),
            isAnonymous: signal(false),
            isFullyAuthenticated: signal(true),
            resendVerificationEmail: () => Promise.resolve(),
          },
        },
        { provide: AuthMenuStateService, useValue: { open: () => undefined } },
        { provide: AccountService, useValue: { recordGameResult } },
        { provide: EmbedModeService, useValue: { isEmbedded: () => false } },
        {
          provide: FirebaseService,
          useValue: {
            saveHighScore: vi.fn(),
            getLeaderboardEntry: () => Promise.resolve(null),
            getTopScores: () => of([]),
          },
        },
        { provide: Router, useValue: { navigateByUrl: () => Promise.resolve(true) } },
      ],
    });

    TestBed.createComponent(GameOverComponent).detectChanges();
    return { recordGameResult };
  }

  it('submits one record per question beside the totals', () => {
    const { recordGameResult } = render({
      questions: [question('q0'), question('q1')],
      answerHistory: [answeredWith('q0:right'), TIMED_OUT],
      answerDurations: [2_500, 15_000],
    });

    expect(recordGameResult).toHaveBeenCalledWith({
      gameId: 'game-fixture',
      totalQuestions: 2,
      correctAnswers: 1,
      bestStreak: 1,
      answers: [
        { questionId: 'q0', correct: true, ms: 2_500, difficulty: 'easy' },
        { questionId: 'q1', correct: false, ms: 15_000, difficulty: 'easy' },
      ],
    });
  });

  /**
   * **The key is absent, not `undefined` and not empty.** The callable SDK's
   * own encoder maps `undefined` to `null` (`@firebase/functions`, `encode()`),
   * so a payload carrying the key with nothing in it arrives at the server as
   * `answers: null` — which is a malformed array rather than an absent one, and
   * `isValidSubmission` refuses the whole submission for it, costing this
   * player their lifetime totals as well as a history they were never going to
   * get. Asserted on the key rather than on its value, because the two forms
   * are indistinguishable in a `toHaveBeenCalledWith`.
   */
  it('omits the key entirely when the round has no usable history', () => {
    const { recordGameResult } = render({
      questions: [question('q0'), question('q1')],
      answerHistory: [], // what a save written before the recap existed restores as
      answerDurations: [],
    });

    expect(recordGameResult).toHaveBeenCalledTimes(1);
    const [payload] = recordGameResult.mock.calls[0] as [Record<string, unknown>];
    expect('answers' in payload).toBe(false);
    expect(payload['totalQuestions']).toBe(2);
  });

  // Unchanged by this feature, and pinned here because the history made the
  // payload bigger: a game with no id is still never banked at all, because an
  // id minted on this screen would be fresh on every reload.
  it('submits nothing at all for a game that has no id', () => {
    const { recordGameResult } = render({
      questions: [question('q0')],
      answerHistory: [answeredWith('q0:right')],
      answerDurations: [1_000],
      gameId: null,
    });

    expect(recordGameResult).not.toHaveBeenCalled();
  });
});
