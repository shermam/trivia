import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { LeaderboardEntry } from '../../models/question.model';
import { AuthMenuStateService } from '../../services/auth-menu-state.service';
import { AuthService } from '../../services/auth.service';
import { EmbedModeService } from '../../services/embed-mode.service';
import { FirebaseService } from '../../services/firebase.service';
import { GameControllerService } from '../../services/game-controller.service';
import { IconComponent } from '../icon/icon.component';

function isPermissionDeniedError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'permission-denied';
}

/** Derives initials for a leaderboard avatar, e.g. "Jane Doe" -> "JD". */
function initialsFor(name: string): string {
  const initials = name
    .trim()
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
  return initials || '?';
}

@Component({
  selector: 'app-game-over',
  standalone: true,
  imports: [FormsModule, IconComponent, NgClass],
  templateUrl: './game-over.component.html',
  styleUrl: './game-over.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameOverComponent implements OnInit {
  protected readonly gameController = inject(GameControllerService);
  protected readonly authService = inject(AuthService);
  protected readonly authMenuState = inject(AuthMenuStateService);
  protected readonly embedMode = inject(EmbedModeService);
  private readonly firebaseService = inject(FirebaseService);
  private readonly router = inject(Router);

  protected readonly initialsFor = initialsFor;

  protected playerName = '';
  protected readonly isSaving = signal(false);
  protected readonly hasSaved = signal(false);
  protected readonly saveError = signal<string | null>(null);
  protected readonly leaderboard = signal<LeaderboardEntry[]>([]);
  protected readonly isLoadingLeaderboard = signal(true);
  protected readonly leaderboardError = signal<string | null>(null);

  protected readonly performanceLabel = computed(() => {
    const percentage = this.gameController.percentage();
    if (percentage >= 90) return 'Outstanding!';
    if (percentage >= 70) return 'Great job!';
    if (percentage >= 50) return 'Good effort!';
    return 'Keep practicing!';
  });

  protected readonly performanceColorClass = computed(() => {
    const percentage = this.gameController.percentage();
    if (percentage >= 90) return 'text-emerald-700 dark:text-emerald-400';
    if (percentage >= 70) return 'text-emerald-600 dark:text-emerald-400';
    if (percentage >= 50) return 'text-amber-700 dark:text-amber-400';
    return 'text-red-700 dark:text-red-400';
  });

  /**
   * Rank among the fetched top 10 only — there's no cheap way to know a
   * player's exact rank if their score didn't make the top 10 without a
   * dedicated Firestore count query, so this stays `null` in that case
   * rather than guessing.
   */
  protected readonly playerRank = computed(() => {
    const uid = this.authService.user()?.uid;
    if (!uid) {
      return null;
    }
    const index = this.leaderboard().findIndex((entry) => entry.uid === uid);
    return index === -1 ? null : index + 1;
  });

  ngOnInit(): void {
    if (this.gameController.totalQuestions() === 0) {
      void this.router.navigateByUrl('/');
      return;
    }
    this.playerName = this.authService.user()?.displayName ?? '';
    void this.loadLeaderboard();
  }

  protected openSignIn(): void {
    this.authMenuState.open();
  }

  protected async resendVerification(): Promise<void> {
    this.saveError.set(null);
    try {
      await this.authService.resendVerificationEmail();
    } catch {
      this.saveError.set('Could not send the verification email. Please try again.');
    }
  }

  async saveScore(): Promise<void> {
    const user = this.authService.user();
    const name = this.playerName.trim();
    if (!name || this.hasSaved() || !user || !this.authService.isFullyAuthenticated()) {
      return;
    }

    this.isSaving.set(true);
    this.saveError.set(null);

    try {
      await this.firebaseService.saveHighScore({
        uid: user.uid,
        name,
        score: this.gameController.score(),
        totalQuestions: this.gameController.totalQuestions(),
        percentage: this.gameController.percentage(),
        createdAt: Date.now(),
      });
      this.hasSaved.set(true);
      await this.loadLeaderboard();
    } catch (error) {
      await this.reportSaveFailure(error, this.gameController.score());
    } finally {
      this.isSaving.set(false);
    }
  }

  /**
   * Explains a failed save, without inventing a reason for it.
   *
   * `permission-denied` used to be reported as "your best score is already
   * higher" unconditionally. Since the leaderboard rules were tightened that
   * is one of several reasons a write is refused — a clock outside the
   * accepted window, a name over 30 characters, an account that isn't
   * verified, a score inconsistent with the question count — so the message
   * was false whenever the cause was any of the others. It also set
   * `hasSaved`, which replaces the form with the saved panel and leaves no way
   * to retry something that might well have succeeded on a second attempt.
   *
   * So the claim is now checked before it is made: the leaderboard is publicly
   * readable, and the caller's own row says whether their existing best really
   * does beat this game. Only then is the friendly message true — and only
   * then is suppressing retry right, because the rules will refuse the same
   * write every time. Anything else, including a lookup that itself fails,
   * gets the generic message and keeps the form open.
   */
  private async reportSaveFailure(error: unknown, attemptedScore: number): Promise<void> {
    if (isPermissionDeniedError(error)) {
      const existing = await this.firebaseService
        .getLeaderboardEntry(this.authService.user()?.uid ?? '')
        .catch(() => null);

      if (existing && existing.score >= attemptedScore) {
        this.hasSaved.set(true);
        this.saveError.set(
          `Your best score is already higher (${existing.score}/${existing.totalQuestions}) — ` +
            'nice consistency! We kept your existing best.',
        );
        return;
      }
    }
    this.saveError.set('Could not save your score. Please try again.');
  }

  protected playAgain(): void {
    this.gameController.resetGame();
  }

  private async loadLeaderboard(): Promise<void> {
    this.isLoadingLeaderboard.set(true);
    this.leaderboardError.set(null);
    try {
      const topScores = await firstValueFrom(this.firebaseService.getTopScores(10));
      this.leaderboard.set(topScores);
    } catch {
      this.leaderboard.set([]);
      this.leaderboardError.set('Could not load the leaderboard. Please try again later.');
    } finally {
      this.isLoadingLeaderboard.set(false);
    }
  }
}
