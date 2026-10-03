import {
  booleanAttribute,
  Component,
  computed,
  contentChild,
  effect,
  InjectionToken,
  input,
  signal,
  type Signal,
} from '@angular/core';
import { NgControl } from '@angular/forms';
import { Icon } from '../ui/icon';
import { controlErrorMessage } from './error-messages';

let nextFieldId = 0;

/** What a control inside a `Field` needs to wire itself to its label, hint and error. */
export interface FieldContext {
  /** The `id` the control must have, so the label's `for` points at it. */
  readonly controlId: string;
  /** Ids for `aria-describedby`: the hint, and the error while there is one. */
  readonly describedBy: Signal<string | null>;
  /** True while an error is shown: the control gets `aria-invalid`. */
  readonly invalid: Signal<boolean>;
}

export const FIELD_CONTEXT = new InjectionToken<FieldContext>('FIELD_CONTEXT');

/**
 * A labelled form field: label, the control (projected), an optional hint and the error.
 *
 *     <app-field label="Name" hint="Shown on the budget card">
 *       <input appInput formControlName="name" />
 *     </app-field>
 *
 * The control gets its `id`, `aria-describedby` and `aria-invalid` from the field (see `AppInput`).
 * The error shows once the control is touched and invalid, and sits in an `aria-live` region that is
 * always in the page, so an error that arrives later (such as one from the API) is announced.
 */
@Component({
  selector: 'app-field',
  imports: [Icon],
  providers: [{ provide: FIELD_CONTEXT, useExisting: Field }],
  template: `
    <label [for]="controlId" class="mb-1.5 block text-sm font-medium text-ink">
      {{ label() }}
      @if (optional()) {
        <span class="font-normal text-muted">(optional)</span>
      }
    </label>
    <ng-content />
    @if (hint(); as hint) {
      <p [id]="hintId" class="mt-1.5 text-sm text-muted">{{ hint }}</p>
    }
    <div [id]="errorId" aria-live="polite">
      @if (message(); as message) {
        <p class="mt-1.5 flex items-start gap-1.5 text-sm font-medium text-negative">
          <app-icon name="alert" class="mt-0.5" />
          <span>{{ message }}</span>
        </p>
      }
    </div>
  `,
  host: { class: 'block' },
})
export class Field implements FieldContext {
  readonly label = input.required<string>();
  readonly hint = input<string>();
  /** Marks the field "(optional)". Everything else is understood to be required. */
  readonly optional = input(false, { transform: booleanAttribute });
  /** An error to show whatever the control says, for problems that do not live in the control. */
  readonly error = input<string>();

  readonly controlId = `field-${nextFieldId++}`;
  protected readonly hintId = `${this.controlId}-hint`;
  protected readonly errorId = `${this.controlId}-error`;

  private readonly ngControl = contentChild(NgControl);
  private readonly control = signal<NgControl['control']>(null);
  /** Bumped on every event of the control, so the computed below re-reads its plain properties. */
  private readonly changes = signal(0);

  protected readonly message = computed(() => {
    const external = this.error();
    if (external) return external;
    this.changes();
    const control = this.control();
    if (!control || !control.touched || !control.invalid) return null;
    return controlErrorMessage(control.errors, this.label());
  });

  readonly invalid = computed(() => this.message() !== null);

  readonly describedBy = computed(() => {
    const ids = [this.hint() ? this.hintId : null, this.message() ? this.errorId : null];
    return ids.filter((id) => id !== null).join(' ') || null;
  });

  constructor() {
    // Follow whichever control sits inside the field, and re-read its state on every event of it.
    effect((onCleanup) => {
      const control = this.ngControl()?.control ?? null;
      this.control.set(control);
      if (!control) return;
      const subscription = control.events.subscribe(() =>
        this.changes.update((count) => count + 1),
      );
      onCleanup(() => subscription.unsubscribe());
    });
  }
}
