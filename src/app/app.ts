import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { TopBarComponent } from './components/top-bar/top-bar.component';
import { AuthService } from './services/auth.service';
import { EmbedModeService } from './services/embed-mode.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, TopBarComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly embedMode = inject(EmbedModeService);
  private readonly authService = inject(AuthService);

  constructor() {
    void this.authService.ensureSignedIn();
  }
}
