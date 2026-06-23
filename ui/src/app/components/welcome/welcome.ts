import { Component } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { NewFlagsFileFormComponent } from '../new-flags-file-form/new-flags-file-form';

@Component({
  selector: 'app-welcome',
  standalone: true,
  imports: [MatCardModule, MatDividerModule, MatIconModule, NewFlagsFileFormComponent],
  templateUrl: './welcome.html',
  styleUrl: './welcome.scss',
})
export class WelcomeComponent {
  onFormSubmitted(): void {
    // Form actions already navigate away via store/router
  }
}
