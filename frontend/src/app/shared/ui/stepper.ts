import { Component, input } from '@angular/core';
import { Icon } from './icon';

/** One step of a wizard: a stable id and the short name shown beside its number. */
export interface StepperStep {
  id: string;
  label: string;
}

/**
 * The progress of a wizard: numbered steps, a check for the ones that are done, and "Step 2 of 5".
 *
 * ```html
 * <app-stepper label="Import progress" [steps]="steps" [current]="stepIndex()" />
 * ```
 *
 * It is a list inside a labelled `nav`, and the current step is `aria-current="step"`. A finished
 * step shows the `check` icon and says "(done)" to a screen reader, a step to come says "(upcoming)":
 * the state is the icon, the number and the words, never the color of the circle alone. On a phone
 * only the current step keeps its name on screen (the others are read aloud, and shown from `sm`),
 * so five steps fit one row at 320 px.
 *
 * The stepper only shows where the person is. Moving between steps, and the focus that goes to the
 * heading of each new step, are the wizard's.
 */
@Component({
  selector: 'app-stepper',
  imports: [Icon],
  template: `
    <nav [attr.aria-label]="label()">
      <ol class="flex flex-wrap items-center gap-x-4 gap-y-2">
        @for (step of steps(); track step.id; let i = $index) {
          <li class="flex items-center gap-2" [attr.aria-current]="i === current() ? 'step' : null">
            <span
              aria-hidden="true"
              class="grid size-7 shrink-0 place-items-center rounded-full border-2 text-xs font-semibold"
              [class]="
                i < current()
                  ? 'border-accent bg-accent text-on-accent'
                  : i === current()
                    ? 'border-accent text-accent'
                    : 'border-line-strong text-muted'
              "
            >
              @if (i < current()) {
                <app-icon name="check" />
              } @else {
                {{ i + 1 }}
              }
            </span>
            <span
              class="text-sm"
              [class]="
                i === current() ? 'font-semibold text-ink' : 'sr-only text-muted sm:not-sr-only'
              "
              >{{ step.label }}</span
            >
            @if (i < current()) {
              <span class="sr-only">(done)</span>
            } @else if (i > current()) {
              <span class="sr-only">(upcoming)</span>
            }
          </li>
        }
      </ol>
    </nav>
    <p class="mt-4 text-sm text-muted">Step {{ current() + 1 }} of {{ steps().length }}</p>
  `,
  host: { class: 'block' },
})
export class Stepper {
  /** What the list is: "Setup progress". It names the `nav`. */
  readonly label = input.required<string>();
  readonly steps = input.required<readonly StepperStep[]>();
  /** The index of the current step, from 0. */
  readonly current = input.required<number>();
}
