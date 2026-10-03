import { afterNextRender, Component, ElementRef, inject, Injector, signal } from '@angular/core';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  type ValidatorFn,
  Validators,
} from '@angular/forms';
import { type ImportProfileInput, NAME_MAX_LENGTH } from '@wallet/shared';
import { parseApiError } from '../../core/api-error';
import { applyApiErrors, focusFirstInvalidOrSubmit } from '../../shared/forms/api-errors';
import { AppInput } from '../../shared/forms/app-input';
import { Field } from '../../shared/forms/field';
import { Button } from '../../shared/ui/button';
import { Icon } from '../../shared/ui/icon';
import { ImportProfilesStore } from './import-profiles.store';
import { ImportWizardStore, profileHeader } from './import-wizard.store';

const notBlank: ValidatorFn = (control) =>
  typeof control.value === 'string' && control.value.trim() === '' ? { required: true } : null;

/**
 * "Save these settings as a profile" (`POST /api/import/profiles`): the mapping as it stands, with the
 * file's header row (cut to what the API keeps), so the next file of the same bank is recognised and
 * filled in. A name that another profile has, ignoring case, is shown on the field (409
 * `import_profile_name_taken`).
 */
@Component({
  selector: 'app-import-profile-save',
  imports: [ReactiveFormsModule, Field, AppInput, Button, Icon],
  template: `
    <details class="rounded-card border border-line p-3" [open]="open()" (toggle)="onToggle($event)">
      <summary class="cursor-pointer rounded-control text-sm font-medium">
        Save these settings as a profile
      </summary>
      <form [formGroup]="form" (ngSubmit)="save()" novalidate class="mt-3 space-y-3">
        <app-field
          label="Profile name"
          hint="For example the name of your bank. The next file with the same column titles fills itself in."
        >
          <input
            appInput
            formControlName="name"
            autocomplete="off"
            [attr.maxlength]="nameMaxLength"
          />
        </app-field>

        @if (formError(); as error) {
          <p
            role="alert"
            class="flex items-start gap-2 rounded-control border border-negative bg-negative-soft p-3 text-sm text-ink"
          >
            <app-icon name="alert" class="mt-0.5 text-negative" />
            <span>{{ error }}</span>
          </p>
        }

        <button
          appButton
          type="submit"
          variant="secondary"
          [loading]="saving()"
          [disabled]="wizard.mapping() === null"
        >
          Save profile
        </button>
        @if (wizard.mapping() === null) {
          <p class="text-sm text-muted">Finish choosing the columns first.</p>
        }
      </form>
    </details>
  `,
  host: { class: 'block' },
})
export class ImportProfileSave {
  protected readonly wizard = inject(ImportWizardStore);
  private readonly profiles = inject(ImportProfilesStore);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly nameMaxLength = NAME_MAX_LENGTH;
  protected readonly open = signal(false);
  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);

  protected readonly form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, notBlank, Validators.maxLength(NAME_MAX_LENGTH)],
    }),
  });

  protected onToggle(event: Event): void {
    this.open.set((event.target as HTMLDetailsElement).open);
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.form.markAllAsTouched();
    const mapping = this.wizard.mapping();
    const parse = this.wizard.parse();
    if (this.form.invalid || mapping === null || parse === null) {
      this.focusAfterRender();
      return;
    }

    const name = this.form.getRawValue().name.trim();
    // The header is what lets the next file be recognised, so it is only kept for a file that has one.
    const input: ImportProfileInput = mapping.hasHeader
      ? { name, mapping, header: profileHeader(parse.header) }
      : { name, mapping };

    this.saving.set(true);
    this.formError.set(null);
    try {
      const created = await this.profiles.create(input);
      this.wizard.selectedProfileId.set(created.id);
      this.wizard.profileNotice.set(
        `Profile "${created.name}" saved. The next file with the same column titles will use it.`,
      );
      this.form.reset({ name: '' });
      this.open.set(false);
    } catch (error) {
      const parsed = parseApiError(error);
      // A name another profile has is a problem with the name, though the API gives it no field.
      const shown =
        parsed.code === 'import_profile_name_taken'
          ? { ...parsed, fieldErrors: { ...parsed.fieldErrors, name: parsed.message } }
          : parsed;
      this.formError.set(applyApiErrors(this.form, shown));
      this.focusAfterRender();
    } finally {
      this.saving.set(false);
    }
  }

  private focusAfterRender(): void {
    afterNextRender(() => focusFirstInvalidOrSubmit(this.host.nativeElement), {
      injector: this.injector,
    });
  }
}
