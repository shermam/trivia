import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { TopBarComponent } from './components/top-bar/top-bar.component';
import { AuthService } from './services/auth.service';
import { EmbedModeService } from './services/embed-mode.service';
import { TriviaService } from './services/trivia.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, TopBarComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly embedMode = inject(EmbedModeService);
  private readonly authService = inject(AuthService);
  private readonly triviaService = inject(TriviaService);

  constructor() {
    void this.authService.ensureSignedIn();
    this.triviaService.initOfflinePrefetch();
  }
}
