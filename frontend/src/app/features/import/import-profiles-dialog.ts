import { Component, ElementRef, inject, output, signal, viewChild } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { afterNextRender, Injector } from '@angular/core';
import { type ImportProfileDto, NAME_MAX_LENGTH } from '@wallet/shared';
import { parseApiError } from '../../core/api-error';
import { AppInput } from '../../shared/forms/app-input';
import { Field } from '../../shared/forms/field';
import { ActionMenu, MenuItem } from '../../shared/ui/action-menu';
import { Button } from '../../shared/ui/button';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { AppDialog } from '../../shared/ui/dialog';
import { Icon } from '../../shared/ui/icon';
import { AppList, ListRow } from '../../shared/ui/list';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/states';
import { ToastService } from '../../shared/ui/toast.service';
import { ImportProfilesStore } from './import-profiles.store';
import { ImportWizardStore } from './import-wizard.store';

/**
 * The saved profiles, to rename or delete (`PUT` and `DELETE /api/import/profiles/:id`). A rename
 * sends the whole profile again (the API replaces it) with the same mapping and header signature. A
 * name another profile has is shown on the field. Deleting asks first and says that nothing already
 * imported changes.
 */
@Component({
  selector: 'app-import-profiles-dialog',
  imports: [
    ReactiveFormsModule,
    ActionMenu,
    AppDialog,
    AppList,
    Field,
    AppInput,
    Button,
    Icon,
    EmptyState,
    ErrorState,
    ListRow,
    LoadingState,
    MenuItem,
  ],
  template: `
    <app-dialog heading="Import profiles" [locked]="busy()" (closed)="closed.emit()">
      <div class="space-y-4">
        <p class="text-sm text-muted">
          A profile remembers the columns and formats of one bank. Renaming or deleting one never
          changes what you imported.
        </p>

        @switch (store.state()) {
          @case ('loading') {
            <app-loading-state label="Loading profiles…" />
          }
          @case ('error') {
            <app-error-state
              title="Couldn't load the profiles"
              [error]="store.error()"
              (retry)="store.reload()"
            />
          }
          @default {
            @if (store.profiles().length === 0) {
              <app-empty-state
                title="No profiles yet"
                description="Set the columns of a file and use Save these settings as a profile."
              />
            } @else {
              <ul appList>
                @for (profile of store.profiles(); track profile.id) {
                  @if (renaming()?.id === profile.id) {
                    <li appListRow bare>
                      <form (submit)="saveName($event, profile)" novalidate class="space-y-2">
                        <app-field
                          [label]="'New name for ' + profile.name"
                          [error]="renameError() ?? undefined"
                        >
                          <input
                            #nameField
                            appInput
                            [formControl]="name"
                            autocomplete="off"
                            [attr.maxlength]="nameMaxLength"
                          />
                        </app-field>
                        <div class="flex gap-2">
                          <button appButton size="sm" type="submit" [loading]="busy()">
                            Save name
                          </button>
                          <button
                            appButton
                            size="sm"
                            variant="secondary"
                            [disabled]="busy()"
                            (click)="renaming.set(null)"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    </li>
                  } @else {
                    <li appListRow>
                      <span rowTitle>{{ profile.name }}</span>
                      <app-action-menu
                        rowActions
                        [label]="'More actions for profile ' + profile.name"
                      >
                        <button appMenuItem [disabled]="busy()" (click)="startRename(profile)">
                          <app-icon name="pencil" />
                          Rename
                        </button>
                        <button
                          appMenuItem
                          destructive
                          [disabled]="busy()"
                          (click)="remove(profile)"
                        >
                          <app-icon name="trash" />
                          Delete
                        </button>
                      </app-action-menu>
                    </li>
                  }
                }
              </ul>
            }
          }
        }

        <div class="dialog-footer">
          <button appButton variant="secondary" [disabled]="busy()" (click)="closed.emit()">
            Close
          </button>
        </div>
      </div>
    </app-dialog>
  `,
  host: { class: 'block' },
})
export class ImportProfilesDialog {
  protected readonly store = inject(ImportProfilesStore);
  private readonly wizard = inject(ImportWizardStore);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly nameField = viewChild<ElementRef<HTMLInputElement>>('nameField');

  readonly closed = output<void>();

  protected readonly nameMaxLength = NAME_MAX_LENGTH;
  protected readonly busy = signal(false);
  protected readonly renaming = signal<ImportProfileDto | null>(null);
  protected readonly renameError = signal<string | null>(null);
  protected readonly name = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.maxLength(NAME_MAX_LENGTH)],
  });

  protected startRename(profile: ImportProfileDto): void {
    this.renameError.set(null);
    this.name.setValue(profile.name);
    this.renaming.set(profile);
    afterNextRender(() => this.nameField()?.nativeElement.select(), { injector: this.injector });
  }

  protected async saveName(event: Event, profile: ImportProfileDto): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const name = this.name.value.trim();
    if (name === '') {
      this.renameError.set('Name is required.');
      return;
    }
    if (name === profile.name) {
      this.renaming.set(null);
      return;
    }

    this.busy.set(true);
    this.renameError.set(null);
    try {
      // PUT replaces the profile: the mapping and the header signature are sent back as they are.
      await this.store.update(profile.id, {
        name,
        mapping: profile.mapping,
        header: profile.header,
      });
      this.toast.success(`Profile renamed to ${name}.`);
      this.renaming.set(null);
    } catch (error) {
      const parsed = parseApiError(error);
      if (parsed.code === 'import_profile_name_taken' || parsed.code === 'validation_error') {
        this.renameError.set(parsed.fieldErrors['name'] ?? parsed.message);
      } else if (parsed.code === 'not_found') {
        this.toast.info('That profile was already gone.');
        this.renaming.set(null);
        this.store.reload();
      } else {
        this.renameError.set(parsed.message);
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(profile: ImportProfileDto): Promise<void> {
    if (this.busy()) return;
    const confirmed = await this.confirm.confirm({
      title: `Delete the profile "${profile.name}"?`,
      message:
        'Files of this bank will need their columns chosen by hand again. Nothing you imported changes.',
      confirmLabel: 'Delete profile',
      tone: 'danger',
    });
    if (!confirmed) return;

    this.busy.set(true);
    try {
      await this.store.remove(profile.id);
      if (this.wizard.selectedProfileId() === profile.id) this.wizard.clearProfile();
      this.toast.success(`Profile ${profile.name} deleted.`);
    } catch (error) {
      const parsed = parseApiError(error);
      if (parsed.code === 'not_found') {
        this.toast.info('That profile was already gone.');
        this.store.reload();
      } else {
        this.toast.error(`Couldn't delete the profile. ${parsed.message}`);
      }
    } finally {
      this.busy.set(false);
    }
  }
}
