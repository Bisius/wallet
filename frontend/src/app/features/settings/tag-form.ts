import {
  afterNextRender,
  Component,
  ElementRef,
  inject,
  Injector,
  input,
  OnInit,
  output,
  signal,
} from '@angular/core';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  type ValidatorFn,
  Validators,
} from '@angular/forms';
import type { TagDto, TagUpdateInput } from '@wallet/shared';
import { TAG_NAME_MAX_LENGTH } from '@wallet/shared/limits';
import { aliveFlag } from '../../core/alive';
import { parseApiError } from '../../core/api-error';
import { TagsStore } from '../../core/tags.store';
import { applyApiErrors, focusFirstInvalidOrSubmit } from '../../shared/forms/api-errors';
import { AppInput } from '../../shared/forms/app-input';
import { ColorPicker } from '../../shared/forms/color-picker';
import { Field } from '../../shared/forms/field';
import { Button } from '../../shared/ui/button';
import { AppDialog } from '../../shared/ui/dialog';
import { Icon } from '../../shared/ui/icon';
import { ToastService } from '../../shared/ui/toast.service';

/** A name of only spaces is no name: the API trims it and refuses what is left. */
const notBlank: ValidatorFn = (control) =>
  typeof control.value === 'string' && control.value.trim() === '' ? { required: true } : null;

/**
 * Renames a tag and changes or clears its color (`PATCH /api/tags/:id`), in a dialog. Only what
 * changed is sent. A name that another tag has, ignoring case, is refused by the API (409
 * `tag_name_taken`) and shown on the name field, with the dialog still open.
 *
 * `finished` closes the dialog once the change is saved: the tag list (`TagsStore`) is loaded again
 * by then, so every chip in the app already shows the new name and color.
 */
@Component({
  selector: 'app-tag-form',
  imports: [ReactiveFormsModule, AppDialog, Field, AppInput, ColorPicker, Button, Icon],
  template: `
    <app-dialog
      [heading]="'Edit tag ' + tag().name"
      [locked]="saving()"
      (closed)="cancelled.emit()"
    >
      <form [formGroup]="form" (ngSubmit)="save()" novalidate class="space-y-5">
        <app-field
          label="Name"
          hint="Up to {{ nameMaxLength }} characters. Capital letters do not make another tag."
        >
          <input
            appInput
            formControlName="name"
            autocomplete="off"
            [attr.maxlength]="nameMaxLength"
          />
        </app-field>

        <app-color-picker formControlName="color" />

        @if (formError(); as error) {
          <p
            role="alert"
            class="flex items-start gap-2 rounded-control border border-negative bg-negative-soft p-3 text-sm text-ink"
          >
            <app-icon name="alert" class="mt-0.5 text-negative" />
            <span>{{ error }}</span>
          </p>
        }

        <div class="dialog-footer grid grid-cols-[auto_1fr] gap-2 sm:flex sm:justify-end">
          <button appButton variant="secondary" [disabled]="saving()" (click)="cancelled.emit()">
            Cancel
          </button>
          <button appButton type="submit" [loading]="saving()">Save changes</button>
        </div>
      </form>
    </app-dialog>
  `,
  host: { class: 'block' },
})
export class TagForm implements OnInit {
  private readonly store = inject(TagsStore);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly alive = aliveFlag();

  /** The tag to edit. */
  readonly tag = input.required<TagDto>();

  readonly finished = output<void>();
  readonly cancelled = output<void>();

  protected readonly nameMaxLength = TAG_NAME_MAX_LENGTH;
  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);

  /** The control names are the request's field names, so a field error from the API lands on its control. */
  protected readonly form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, notBlank, Validators.maxLength(TAG_NAME_MAX_LENGTH)],
    }),
    color: new FormControl<string | null>(null),
  });

  ngOnInit(): void {
    const { name, color } = this.tag();
    this.form.setValue({ name, color });
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.form.markAllAsTouched();
    if (this.form.invalid) {
      this.focusInvalidAfterRender();
      return;
    }

    const tag = this.tag();
    const value = this.form.getRawValue();
    const name = value.name.trim();
    const changes: TagUpdateInput = {};
    if (name !== tag.name) changes.name = name;
    if (value.color !== tag.color) changes.color = value.color;
    if (Object.keys(changes).length === 0) {
      this.cancelled.emit();
      return;
    }

    this.saving.set(true);
    this.formError.set(null);
    try {
      await this.store.update(tag.id, changes);
      this.toast.success(`Tag ${name} updated.`);
      if (this.alive()) this.finished.emit();
    } catch (error) {
      if (!this.alive()) return;
      const parsed = parseApiError(error);
      // A name another tag has is a problem with the name, though the API gives it no field.
      const shown =
        parsed.code === 'tag_name_taken'
          ? { ...parsed, fieldErrors: { ...parsed.fieldErrors, name: parsed.message } }
          : parsed;
      this.formError.set(applyApiErrors(this.form, shown));
      this.focusInvalidAfterRender();
    } finally {
      this.saving.set(false);
    }
  }

  private focusInvalidAfterRender(): void {
    afterNextRender(() => focusFirstInvalidOrSubmit(this.host.nativeElement), {
      injector: this.injector,
    });
  }
}
