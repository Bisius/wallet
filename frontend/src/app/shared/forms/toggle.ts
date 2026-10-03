import { Component, forwardRef, input, signal } from '@angular/core';
import { type ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

let nextToggleId = 0;

/**
 * A boolean control with its label: a switch (default) or a checkbox.
 *
 *     <app-toggle formControlName="incremental" label="Incremental" hint="Leftovers carry over." />
 *
 * It is a real checkbox underneath (`role="switch"` for the switch), so it works with the keyboard
 * (Space), is announced correctly and keeps its native focus. The switch shows its state by the
 * position of the knob and a check mark, not by color alone.
 */
@Component({
  selector: 'app-toggle',
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => Toggle), multi: true }],
  template: `
    <label class="flex cursor-pointer items-start gap-3">
      @if (kind() === 'switch') {
        <input
          type="checkbox"
          role="switch"
          class="peer sr-only"
          [attr.aria-labelledby]="labelId"
          [attr.aria-describedby]="hint() ? hintId : null"
          [checked]="checked()"
          [disabled]="disabled()"
          (change)="onToggle($event)"
          (blur)="onTouched()"
        />
        <span
          aria-hidden="true"
          class="relative mt-0.5 h-6 w-11 shrink-0 rounded-full border border-line-strong bg-subtle motion-safe:transition-colors peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-disabled:opacity-60"
        >
          <span
            class="absolute top-0.5 left-0.5 flex size-4.5 items-center justify-center rounded-full border border-line-strong bg-surface text-[0.6rem] leading-none text-ink motion-safe:transition-transform"
            [class.translate-x-5]="checked()"
            >{{ checked() ? '✓' : '' }}</span
          >
        </span>
      } @else {
        <input
          type="checkbox"
          class="mt-0.5 size-6 shrink-0 accent-accent"
          [attr.aria-labelledby]="labelId"
          [attr.aria-describedby]="hint() ? hintId : null"
          [checked]="checked()"
          [disabled]="disabled()"
          (change)="onToggle($event)"
          (blur)="onTouched()"
        />
      }
      <span class="min-w-0">
        <span [id]="labelId" class="block text-sm font-medium text-ink">{{ label() }}</span>
        @if (hint(); as hint) {
          <span [id]="hintId" class="block text-sm text-muted">{{ hint }}</span>
        }
      </span>
    </label>
  `,
  host: { class: 'block' },
})
export class Toggle implements ControlValueAccessor {
  readonly label = input.required<string>();
  readonly hint = input<string>();
  readonly kind = input<'switch' | 'checkbox'>('switch');

  private readonly id = nextToggleId++;
  // The label text names the control; the hint only describes it (it would otherwise be read twice).
  protected readonly labelId = `toggle-label-${this.id}`;
  protected readonly hintId = `toggle-hint-${this.id}`;
  protected readonly checked = signal(false);
  protected readonly disabled = signal(false);

  private onChange: (value: boolean) => void = () => undefined;
  protected onTouched: () => void = () => undefined;

  writeValue(value: boolean | null): void {
    this.checked.set(value === true);
  }

  registerOnChange(fn: (value: boolean) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  protected onToggle(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.checked.set(checked);
    this.onChange(checked);
  }
}
