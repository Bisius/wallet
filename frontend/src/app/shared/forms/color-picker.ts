import { Component, computed, forwardRef, input, signal } from '@angular/core';
import { type ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { Icon } from '../ui/icon';

export interface ColorSwatch {
  /** The color as the API stores it: lower-case `#rrggbb`. */
  value: string;
  name: string;
}

/**
 * The colors on offer. Each one keeps at least 4.5:1 contrast against the white check mark that
 * shows it is selected, in both themes.
 */
export const COLOR_SWATCHES: readonly ColorSwatch[] = [
  { value: '#2563eb', name: 'Blue' },
  { value: '#0e7490', name: 'Teal' },
  { value: '#15803d', name: 'Green' },
  { value: '#4d7c0f', name: 'Olive' },
  { value: '#b45309', name: 'Amber' },
  { value: '#c2410c', name: 'Orange' },
  { value: '#dc2626', name: 'Red' },
  { value: '#be185d', name: 'Pink' },
  { value: '#7e22ce', name: 'Purple' },
  { value: '#475569', name: 'Slate' },
];

let nextPickerId = 0;

const HEX_COLOR = /^#[0-9a-f]{6}$/;

/**
 * A color as a form control: a row of swatches plus "None", for `formControlName="color"`. The
 * value is a lower-case `#rrggbb` string, or `null` for no color. It is a real radio group, so the
 * arrow keys move between the choices and a screen reader names each one ("Blue"). A color that is
 * not on offer (one set through the API) is kept and shown as one more swatch.
 */
@Component({
  selector: 'app-color-picker',
  imports: [Icon],
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => ColorPicker), multi: true },
  ],
  template: `
    <fieldset class="min-w-0">
      <legend class="mb-1.5 text-sm font-medium text-ink">
        {{ label() }}
        <span class="font-normal text-muted">(optional)</span>
      </legend>
      <div class="flex flex-wrap items-center gap-2">
        <label class="cursor-pointer">
          <input
            type="radio"
            class="peer sr-only"
            [name]="group"
            [checked]="value() === null"
            [disabled]="disabled()"
            (change)="select(null)"
            (blur)="onTouched()"
          />
          <span
            class="flex min-h-10 items-center gap-1.5 rounded-control border border-line-strong bg-surface px-3 text-sm text-ink peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:font-semibold peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus"
          >
            @if (value() === null) {
              <app-icon name="check" />
            }
            None
          </span>
        </label>
        @for (swatch of swatches(); track swatch.value) {
          <label class="cursor-pointer">
            <input
              type="radio"
              class="peer sr-only"
              [name]="group"
              [value]="swatch.value"
              [checked]="value() === swatch.value"
              [disabled]="disabled()"
              (change)="select(swatch.value)"
              (blur)="onTouched()"
            />
            <span
              aria-hidden="true"
              class="flex size-10 items-center justify-center rounded-full text-white ring-1 ring-line-strong peer-checked:ring-2 peer-checked:ring-ink peer-checked:ring-offset-2 peer-checked:ring-offset-surface peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-focus"
              [style.background-color]="swatch.value"
            >
              @if (value() === swatch.value) {
                <app-icon name="check" />
              }
            </span>
            <span class="sr-only">{{ swatch.name }}</span>
          </label>
        }
      </div>
    </fieldset>
  `,
  host: { class: 'block' },
})
export class ColorPicker implements ControlValueAccessor {
  readonly label = input('Color');

  protected readonly group = `color-picker-${nextPickerId++}`;
  protected readonly value = signal<string | null>(null);
  protected readonly disabled = signal(false);

  /** The palette, plus the current color when it is not part of it. */
  protected readonly swatches = computed<readonly ColorSwatch[]>(() => {
    const current = this.value();
    if (current && HEX_COLOR.test(current) && !COLOR_SWATCHES.some((s) => s.value === current)) {
      return [...COLOR_SWATCHES, { value: current, name: `Custom ${current}` }];
    }
    return COLOR_SWATCHES;
  });

  private onChange: (value: string | null) => void = () => undefined;
  protected onTouched: () => void = () => undefined;

  writeValue(value: string | null): void {
    this.value.set(value ? value.toLowerCase() : null);
  }

  registerOnChange(fn: (value: string | null) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  protected select(value: string | null): void {
    this.value.set(value);
    this.onChange(value);
  }
}
