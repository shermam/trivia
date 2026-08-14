import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { of } from 'rxjs';
import { LeaderboardEntry, TriviaQuestion } from '../../models/question.model';
import { AuthService } from '../../services/auth.service';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { EmbedModeService } from '../../services/embed-mode.service';
import { FirebaseService, QuestionReportRejectedError } from '../../services/firebase.service';
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

const permissionDenied = () =>
  Object.assign(new Error('Missing permissions.'), {
    code: 'permission-denied',
  });

function makeEntry(overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    uid: 'player-1',
    name: 'Ada',
    score: 9,
    totalQuestions: 10,
    percentage: 90,
    createdAt: Date.now(),
    ...overrides,
  };
}

function setup(options: {
  saveError: unknown;
  existingEntry?: LeaderboardEntry | null;
  lookupFails?: boolean;
  score?: number;
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

    expect(getLeaderboardEntry).toHaveBeenCalledWith('player-1');
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

function reportingSetup(options: { questions: TriviaQuestion[]; reportError?: unknown }) {
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
          resetGame: () => undefined,
        },
      },
      {
        provide: AuthService,
        useValue: {
          user: signal({ uid: 'anon-1', displayName: null }),
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
