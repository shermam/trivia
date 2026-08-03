import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { GameConfig } from '../../models/question.model';
import { GameControllerService } from '../../services/game-controller.service';
import { SubscriptionService } from '../../services/subscription.service';
import { TriviaCategory, TriviaService } from '../../services/trivia.service';
import { IconComponent } from '../icon/icon.component';

@Component({
  selector: 'app-game-setup',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, IconComponent],
  templateUrl: './game-setup.component.html',
  styleUrl: './game-setup.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameSetupComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly triviaService = inject(TriviaService);
  protected readonly gameController = inject(GameControllerService);
  protected readonly subscriptionService = inject(SubscriptionService);

  protected readonly categories = signal<TriviaCategory[]>([]);
  protected readonly categoriesError = signal<string | null>(null);

  protected readonly form = this.fb.nonNullable.group({
    amount: [10, [Validators.required, Validators.min(5), Validators.max(50)]],
    category: [''],
    difficulty: [''],
    source: ['open_trivia' as GameConfig['source'], Validators.required],
  });

  async ngOnInit(): Promise<void> {
    try {
      const categories = await this.triviaService.getCategories();
      this.categories.set(categories);
    } catch {
      this.categoriesError.set(
        'Could not load categories from Open Trivia DB. You can still start with "Any Category".',
      );
    }
  }

  onSubmit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const raw = this.form.getRawValue();
    const config: GameConfig = {
      amount: raw.amount,
      category: raw.category,
      difficulty: raw.difficulty as GameConfig['difficulty'],
      source: raw.source,
    };

    void this.gameController.startGame(config);
  }
}
