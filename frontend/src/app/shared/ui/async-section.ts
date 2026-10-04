import { booleanAttribute, Component, contentChild, input, output, viewChild } from '@angular/core';
import type { LoadState } from '../../core/resource-state';
import { Disclosure } from './disclosure';
import { AppSection, SectionHelp, type SectionVariant } from './section';
import { ErrorState, LoadingState } from './states';

/**
 * An `app-section` that loads its own data: while that loads it says so, when it failed it shows the
 * API's message with a way to try again, and only when it is ready does it show its content. Each
 * block has its own, so one failing request never blanks the page.
 *
 * ```html
 * <app-async-section
 *   heading="Budget progress"
 *   description="What each budget has left."
 *   [state]="data.viewState()"
 *   [error]="data.view.error()"
 *   loadingLabel="Loading budget progress…"
 *   errorTitle="Couldn't load budget progress"
 *   (retry)="data.view.reload()"
 * >
 *   <app-see-all-link sectionAction route="/budgets" what="budgets" />
 *   @if (lines(); as lines) { …content, guarded by the data it needs… }
 * </app-async-section>
 * ```
 *
 * It takes the inputs of `app-section` (heading, description, level, variant, `sectionAction`,
 * `sectionDescription` and `sectionHelp` content) and adds the three below.
 *
 * Controls that change what the content shows (a filter, a search box) go into an element marked
 * `sectionToolbar`: it sits above the content and stays whatever the state is, so a filter that was
 * just changed does not vanish, with the keyboard still on it, while the new list loads or fails. Get `state` from
 * `resourceState(resource)` (core/resource-state.ts): a resource that reloads with a value stays
 * `ready`, so the content does not flash away on every refresh.
 */
@Component({
  selector: 'app-async-section',
  imports: [AppSection, Disclosure, ErrorState, LoadingState],
  template: `
    <app-section
      [heading]="heading()"
      [description]="description()"
      [level]="level()"
      [variant]="variant()"
      [focusable]="focusable()"
      [landmark]="landmark()"
    >
      <ng-container ngProjectAs="[sectionAction]">
        <ng-content select="[sectionAction]" />
      </ng-container>
      <ng-container ngProjectAs="[sectionDescription]">
        <ng-content select="[sectionDescription]" />
      </ng-container>

      @if (help()) {
        <app-disclosure [summary]="helpTitle()">
          <div class="space-y-2 text-sm text-muted">
            <ng-content select="[sectionHelp]" />
          </div>
        </app-disclosure>
      }

      <ng-content select="[sectionToolbar]" />

      @switch (state()) {
        @case ('loading') {
          <app-loading-state [label]="loadingLabel()" />
        }
        @case ('error') {
          <app-error-state [title]="errorTitle()" [error]="error()" (retry)="retry.emit()" />
        }
        @default {
          <ng-content />
        }
      }
    </app-section>
  `,
  host: { class: 'block' },
})
export class AsyncSection {
  readonly heading = input.required<string>();
  readonly description = input<string>();
  /** 2 or 3, so `level="3"` works as an attribute. */
  readonly level = input<2 | 3, number | string>(2, {
    transform: (value) => (Number(value) === 3 ? 3 : 2),
  });
  readonly variant = input<SectionVariant>();
  readonly helpTitle = input('How this works');
  readonly focusable = input(false, { transform: booleanAttribute });
  readonly landmark = input<boolean | undefined, boolean | string | undefined>(undefined, {
    transform: (value) => (value === undefined ? undefined : booleanAttribute(value)),
  });

  readonly state = input.required<LoadState>();
  /** Why loading failed: usually `resource.error()`. */
  readonly error = input<unknown>();
  /** What the loading state says: "Loading budget progress…". */
  readonly loadingLabel = input.required<string>();
  /** What failed, for the error state: "Couldn't load budget progress". */
  readonly errorTitle = input.required<string>();
  /** The user asks to load it again. */
  readonly retry = output<void>();

  protected readonly help = contentChild(SectionHelp);
  private readonly section = viewChild.required(AppSection);

  /** The heading element, for code that decides itself whether to focus it. */
  headingElement(): HTMLElement | null {
    return this.section().headingElement();
  }

  /** Puts the keyboard on the heading. The section has to be `focusable`. */
  focusHeading(): void {
    this.section().focusHeading();
  }
}
