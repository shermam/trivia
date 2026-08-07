import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { FooterComponent } from './components/footer/footer.component';
import { TopBarComponent } from './components/top-bar/top-bar.component';
import { AuthService } from './services/auth.service';
import { EmbedModeService } from './services/embed-mode.service';
import { RouteAnnouncerService } from './services/route-announcer.service';
import { TriviaService } from './services/trivia.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, TopBarComponent, FooterComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly embedMode = inject(EmbedModeService);
  protected readonly routeAnnouncer = inject(RouteAnnouncerService);
  private readonly authService = inject(AuthService);
  private readonly triviaService = inject(TriviaService);

  constructor() {
    void this.authService.ensureSignedIn();
    this.triviaService.initOfflinePrefetch();
  }
}
