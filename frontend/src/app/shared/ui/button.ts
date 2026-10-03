import {
  booleanAttribute,
  Component,
  computed,
  HostAttributeToken,
  inject,
  input,
} from '@angular/core';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'md' | 'sm';

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-control font-semibold ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover',
  secondary: 'border border-line-strong bg-surface text-ink hover:bg-subtle',
  danger: 'bg-negative text-on-negative hover:bg-negative-hover',
  ghost: 'text-accent hover:bg-subtle',
};

const SIZES: Record<ButtonSize, string> = {
  md: 'min-h-11 px-4 py-2 text-sm',
  sm: 'min-h-9 px-3 py-1.5 text-sm',
};

/** The classes of a button, for the elements that look like one: `a[appLinkButton]` uses them too. */
export function buttonClasses(variant: ButtonVariant, size: ButtonSize): string {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]}`;
}

/**
 * A native `<button>` with the app's look: `<button appButton variant="danger" [loading]="saving()">`.
 * It is `type="button"` unless you say otherwise (so it never submits a form by accident). While
 * `loading` it shows a spinner, is disabled and is marked `aria-busy`.
 */
@Component({
  selector: 'button[appButton]',
  template: `
    @if (loading()) {
      <span
        aria-hidden="true"
        class="size-4 shrink-0 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin"
      ></span>
    }
    <ng-content />
  `,
  host: {
    '[class]': 'classes()',
    '[attr.type]': 'type',
    '[disabled]': 'disabled() || loading()',
    '[attr.aria-busy]': 'loading() ? "true" : null',
  },
})
export class Button {
  readonly variant = input<ButtonVariant>('primary');
  readonly size = input<ButtonSize>('md');
  readonly loading = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly type = inject(new HostAttributeToken('type'), { optional: true }) ?? 'button';
  protected readonly classes = computed(() => buttonClasses(this.variant(), this.size()));
}
