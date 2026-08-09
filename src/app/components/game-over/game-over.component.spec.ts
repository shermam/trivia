import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Router } from '@angular/router';
import { of } from 'rxjs';
import { LeaderboardEntry } from '../../models/question.model';
import { AuthService } from '../../services/auth.service';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { EmbedModeService } from '../../services/embed-mode.service';
import { FirebaseService } from '../../services/firebase.service';
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
