import {
  booleanAttribute,
  Component,
  computed,
  contentChild,
  Directive,
  ElementRef,
  input,
  viewChild,
} from '@angular/core';
import { Disclosure } from './disclosure';

let sections = 0;

/** A card (the usual block of a page) or just the spacing, for a block that sits inside a card. */
export type SectionVariant = 'card' | 'plain';

/** Marks the content of a section's "How this works" disclosure: `<p sectionHelp>…</p>`. */
@Directive({ selector: '[sectionHelp]' })
export class SectionHelp {}

/**
 * A titled block of a page: a heading, a line that says what it shows, room for an action in its
 * corner and the content.
 *
 * ```html
 * <app-section heading="Goals" description="Things you are saving for.">
 *   <button sectionAction appButton>New goal</button>
 *   <p sectionHelp>A longer explanation, folded away behind "How this works".</p>
 *   …content…
 * </app-section>
 * ```
 *
 * - `level` is the heading level (2 by default, 3 for a block inside another block). A level 2 block
 *   is a named region of the page (its heading names it), a level 3 one is not unless you say
 *   `[landmark]="true"`.
 * - `description` is **one line**. Anything longer goes into an element marked `sectionHelp`, which
 *   is shown in a disclosure titled "How this works" (`helpTitle`). For a description that is not
 *   plain text (a live region, an amount) project it into an element marked `sectionDescription`.
 * - `variant="card"` draws the block as a card, `"plain"` only spaces it. **Never put a card inside a
 *   card**: a section inside a section is `plain`, and so is a section inside a dialog.
 * - `focusable` lets code move the keyboard to the heading (`focusHeading()`), for a page whose
 *   button went away with the row it deleted. Nothing else should be focusable on a heading.
 *
 * A block that loads its own data is an `app-async-section`.
 */
@Component({
  selector: 'app-section',
  imports: [Disclosure],
  template: `
    <section [attr.aria-labelledby]="isLandmark() ? headingId : null" [class]="classes()">
      <header class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div class="min-w-0 flex-1 basis-60">
          @if (level() === 3) {
            <h3
              #headingRef
              [id]="headingId"
              [attr.tabindex]="focusable() ? -1 : null"
              class="text-section-title"
            >
              {{ heading() }}
            </h3>
          } @else {
            <h2
              #headingRef
              [id]="headingId"
              [attr.tabindex]="focusable() ? -1 : null"
              class="text-section-title"
            >
              {{ heading() }}
            </h2>
          }
          @if (description()) {
            <p class="mt-1 text-sm text-muted">{{ description() }}</p>
          }
          <ng-content select="[sectionDescription]" />
        </div>
        <div class="flex flex-wrap items-center gap-2 empty:hidden">
          <ng-content select="[sectionAction]" />
        </div>
      </header>

      @if (help()) {
        <app-disclosure [summary]="helpTitle()">
          <div class="space-y-2 text-sm text-muted">
            <ng-content select="[sectionHelp]" />
          </div>
        </app-disclosure>
      }

      <ng-content />
    </section>
  `,
  host: { class: 'block' },
})
export class AppSection {
  /** The title: also the name of the region. */
  readonly heading = input.required<string>();
  /** One line on what the block shows. */
  readonly description = input<string>();
  /** 2 or 3, so `level="3"` works as an attribute. */
  readonly level = input<2 | 3, number | string>(2, {
    transform: (value) => (Number(value) === 3 ? 3 : 2),
  });
  /** `card` for a block of a page, `plain` for one inside a card. Level 3 is `plain` unless said. */
  readonly variant = input<SectionVariant>();
  /** The title of the disclosure that holds what is marked `sectionHelp`. */
  readonly helpTitle = input('How this works');
  /** The heading can take focus from code (`focusHeading()`). */
  readonly focusable = input(false, { transform: booleanAttribute });
  /** Whether the block is a named region. By default level 2 is, level 3 is not. */
  readonly landmark = input<boolean | undefined, boolean | string | undefined>(undefined, {
    transform: (value) => (value === undefined ? undefined : booleanAttribute(value)),
  });

  protected readonly help = contentChild(SectionHelp);
  private readonly headingRef = viewChild<ElementRef<HTMLElement>>('headingRef');

  protected readonly headingId = `section-heading-${++sections}`;
  protected readonly isLandmark = computed(() => this.landmark() ?? this.level() === 2);
  protected readonly classes = computed(() => {
    const variant = this.variant() ?? (this.level() === 3 ? 'plain' : 'card');
    return variant === 'card' ? 'card space-y-4' : 'space-y-4';
  });

  /** The heading element, for code that decides itself whether to focus it. */
  headingElement(): HTMLElement | null {
    return this.headingRef()?.nativeElement ?? null;
  }

  /** Puts the keyboard on the heading. The section has to be `focusable`. */
  focusHeading(): void {
    this.headingElement()?.focus();
  }
}
