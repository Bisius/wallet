import { Component, inject, signal } from '@angular/core';
import { AppInput } from '../../shared/forms/app-input';
import { Field } from '../../shared/forms/field';
import { Alert } from '../../shared/ui/alert';
import { Button } from '../../shared/ui/button';
import { ImportProfilesDialog } from './import-profiles-dialog';
import { ImportProfilesStore } from './import-profiles.store';
import { ImportWizardStore } from './import-wizard.store';

/**
 * The saved profiles as a choice: picking one fills in the mapping (a file the server recognises
 * gets its profile applied by itself, and this says so). "Manage profiles" opens the dialog that
 * renames and deletes them. A profile that cannot be loaded never blocks the mapping by hand.
 */
@Component({
  selector: 'app-import-profile-picker',
  imports: [Alert, Field, AppInput, Button, ImportProfilesDialog],
  template: `
    <div class="space-y-2">
      <app-field
        label="Saved profile"
        [hint]="
          profiles.state() === 'error'
            ? undefined
            : 'A profile remembers the columns and formats of one bank.'
        "
      >
        <select appInput [disabled]="profiles.state() === 'loading'" (change)="onPick($event)">
          <option value="" [selected]="wizard.selectedProfileId() === null">
            {{
              profiles.state() === 'loading' ? 'Loading profiles…' : 'None: set the columns below'
            }}
          </option>
          @for (profile of profiles.profiles(); track profile.id) {
            <option [value]="profile.id" [selected]="profile.id === wizard.selectedProfileId()">
              {{ profile.name }}
            </option>
          }
        </select>
      </app-field>

      @if (profiles.state() === 'error') {
        <app-alert tone="warning">
          The saved profiles could not be loaded, so none was applied. You can still set the columns
          by hand.
          <button alertAction appButton variant="secondary" size="sm" (click)="profiles.reload()">
            Try again
          </button>
        </app-alert>
      }

      <div role="status" class="empty:hidden">
        @if (wizard.profileNotice(); as notice) {
          <app-alert tone="info">{{ notice }}</app-alert>
        }
      </div>

      <button appButton variant="ghost" size="sm" (click)="managing.set(true)">
        Manage profiles
      </button>
    </div>

    @if (managing()) {
      <app-import-profiles-dialog (closed)="managing.set(false)" />
    }
  `,
  host: { class: 'block' },
})
export class ImportProfilePicker {
  protected readonly wizard = inject(ImportWizardStore);
  protected readonly profiles = inject(ImportProfilesStore);
  protected readonly managing = signal(false);

  protected onPick(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value === '') {
      this.wizard.clearProfile();
      return;
    }
    const profile = this.profiles.profiles().find((candidate) => String(candidate.id) === value);
    if (profile) void this.wizard.applyProfile(profile, 'chosen');
  }
}
