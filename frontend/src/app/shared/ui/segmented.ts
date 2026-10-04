import { booleanAttribute, Component, forwardRef, input, model, signal } from '@angular/core';
import { type ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { Icon } from './icon';

/** One choice of a segmented control: what it stores and what it says. */
export interface SegmentedOption {
  value: string;
  label: string;
}

let nextSegmentedId = 0;

/**
 * A choice between a few things, shown side by side as one control: this month or all months, a
 * daily or monthly view.
 *
 * ```html
 * <app-segmented legend="Show spendings from" [options]="options" formControlName="scope" />
 * <app-segmented legend="Show" [options]="options" [(value)]="view" legendHidden />
 * ```
 *
 * It is a group of native radio buttons (a `fieldset` named by its `legend`), so the keyboard is the
 * browser's: Tab enters the group on the selected option, the arrow keys move the choice, and a
 * screen reader says "2 of 3". The selected option is filled with the accent color and shows a check
 * mark, so it is not told by color alone, and the focused one has the app's focus ring, drawn inside
 * the control so that its rounded edge does not cut it off. Every option is 44 px tall.
 *
 * It works with reactive forms (`formControlName`, `[formControl]`) as the toggle and the inputs do,
 * and without them (`[(value)]`). The value is the `value` of the chosen option, or `null` when none
 * is. The legend is shown above the control; `legendHidden` keeps it for screen readers only, when
 * the control sits under a heading that says it already.
 *
 * A long label wraps inside its option instead of widening the page.
 */
@Component({
  selector: 'app-segmented',
  imports: [Icon],
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => Segmented), multi: true },
  ],
  template: `
    <fieldset class="min-w-0">
      <legend [class]="legendHidden() ? 'sr-only' : 'mb-1.5 text-sm font-medium text-ink'">
        {{ legend() }}
      </legend>
      <div class="inline-flex max-w-full overflow-hidden rounded-control border border-line-strong">
        @for (option of options(); track option.value) {
          <label class="min-w-0 cursor-pointer border-l border-line-strong first:border-l-0">
            <input
              type="radio"
              class="peer sr-only"
              [name]="name"
              [value]="option.value"
              [checked]="value() === option.value"
              [disabled]="isDisabled()"
              (change)="select(option.value)"
              (blur)="onTouched()"
            />
            <span
              class="flex min-h-11 items-center gap-1.5 px-4 text-sm font-medium text-ink peer-checked:bg-accent peer-checked:text-on-accent peer-focus-visible:-outline-offset-2 peer-focus-visible:outline-2 peer-focus-visible:outline-focus peer-checked:peer-focus-visible:outline-on-accent peer-disabled:cursor-not-allowed peer-disabled:opacity-60"
            >
              @if (value() === option.value) {
                <app-icon name="check" />
              }
              {{ option.label }}
            </span>
          </label>
        }
      </div>
    </fieldset>
  `,
  host: { class: 'block' },
})
export class Segmented implements ControlValueAccessor {
  /** What the group is: "Show spendings from". It names the `fieldset`. */
  readonly legend = input.required<string>();
  readonly options = input.required<readonly SegmentedOption[]>();
  /** Keep the legend for screen readers only. */
  readonly legendHidden = input(false, { transform: booleanAttribute });
  /** The `value` of the chosen option. Two-way: `[(value)]`. */
  readonly value = model<string | null>(null);

  protected readonly name = `segmented-${nextSegmentedId++}`;
  protected readonly isDisabled = signal(false);

  private onChange: (value: string) => void = () => undefined;
  protected onTouched: () => void = () => undefined;

  writeValue(value: string | null): void {
    this.value.set(value);
  }

  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.isDisabled.set(isDisabled);
  }

  protected select(value: string): void {
    this.value.set(value);
    this.onChange(value);
  }
}
