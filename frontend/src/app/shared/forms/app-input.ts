import { computed, Directive, HostAttributeToken, inject, input } from '@angular/core';
import { FIELD_CONTEXT } from './field';

/**
 * The look of a text, number, date, month, select or textarea control, and its wiring to the
 * surrounding `Field`: `<input appInput formControlName="name" />`. Outside a field it only styles.
 *
 * Inputs are at least 16px so mobile browsers do not zoom in when one is focused, and 44px tall for
 * a comfortable touch target. An invalid control gets a thicker outline besides the error text, so
 * the error is not signalled by color alone.
 */
@Directive({
  selector: 'input[appInput], select[appInput], textarea[appInput]',
  host: {
    class:
      'block min-h-11 w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-base text-ink ' +
      'placeholder:text-muted read-only:bg-subtle disabled:cursor-not-allowed disabled:opacity-60 ' +
      'aria-invalid:border-negative aria-invalid:ring-1 aria-invalid:ring-negative',
    '[attr.id]': 'id()',
    '[attr.aria-describedby]': 'describedBy()',
    '[attr.aria-invalid]': 'invalid() ? "true" : null',
  },
})
export class AppInput {
  private readonly field = inject(FIELD_CONTEXT, { optional: true });
  private readonly ownId = inject(new HostAttributeToken('id'), { optional: true });

  /** Another element to describe this control, besides the field's hint and error. */
  readonly extraDescribedBy = input<string | null>(null);

  protected readonly id = computed(() => this.field?.controlId ?? this.ownId);
  protected readonly invalid = computed(() => this.field?.invalid() ?? false);
  protected readonly describedBy = computed(() => {
    const ids = [this.field?.describedBy() ?? null, this.extraDescribedBy()];
    return ids.filter((id) => id !== null).join(' ') || null;
  });
}
