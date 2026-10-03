import {
  afterRenderEffect,
  Component,
  computed,
  effect,
  ElementRef,
  forwardRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  type ControlValueAccessor,
  NG_VALIDATORS,
  NG_VALUE_ACCESSOR,
  type ValidationErrors,
  type Validator,
} from '@angular/forms';
import type { TagDto } from '@wallet/shared';
import { MAX_TAGS_PER_SPENDING, TAG_NAME_MAX_LENGTH } from '@wallet/shared/limits';
import { aliveFlag } from '../../core/alive';
import { hasApiErrorCode, parseApiError } from '../../core/api-error';
import { sameTagName, TagsStore } from '../../core/tags.store';
import { Icon } from '../ui/icon';
import { TagChip } from '../ui/tag-chip';
import { AppInput } from './app-input';

let nextTagInputId = 0;

/** What the list offers: an existing tag, or creating the typed name. */
type Option =
  { key: string; kind: 'tag'; tag: TagDto } | { key: 'create'; kind: 'create'; name: string };

/** A chip: the tag, or a stand-in for an id the list does not know (yet). */
interface Chip {
  id: number;
  name: string;
  color: string | null;
}

/** Lower case without accents, so "cafe" suggests "Café". Only suggestions are matched this loosely. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

const LIMIT_MESSAGE = `A spending can have up to ${MAX_TAGS_PER_SPENDING} tags. Remove one to add another.`;

/**
 * The tags of a spending as a form control that holds **tag ids** (`number[]`): the chosen tags as
 * chips with a remove button each, and under them a text box that finds a tag as you type, or creates
 * one. It follows the combobox pattern, so it works with a keyboard and a screen reader:
 *
 * - the box is a `combobox` that controls a `listbox` of `option`s, and `aria-activedescendant` names
 *   the highlighted one, so focus never leaves the box;
 * - typing opens the list and highlights its first entry; Arrow keys move, Enter chooses, Escape
 *   closes it (and only it: a dialog around the field stays open);
 * - Backspace in an empty box takes off the last chip;
 * - a name no existing tag has (ignoring case, like the API) is offered as "Create tag 'name'".
 *
 * Creating calls `POST /api/tags` straight away. If the API says the name is taken (the tag appeared
 * meanwhile) the list is loaded again and that tag is chosen instead. At most
 * `MAX_TAGS_PER_SPENDING` tags are taken, and the field says so when it is reached. What happens is
 * said to screen readers in a live region.
 *
 * Text left in the box is not a tag yet. Rather than drop it without a word when the form is sent, the
 * control is invalid while the box holds text, and says to press Enter or to clear the box.
 *
 *     <app-field label="Tags" [optional]="true">
 *       <app-tag-input formControlName="tagIds" />
 *     </app-field>
 */
@Component({
  selector: 'app-tag-input',
  imports: [AppInput, Icon, TagChip],
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => TagInput), multi: true },
    { provide: NG_VALIDATORS, useExisting: forwardRef(() => TagInput), multi: true },
  ],
  template: `
    @if (chips().length > 0) {
      <ul class="mb-2 flex flex-wrap gap-1.5" aria-label="Selected tags">
        @for (chip of chips(); track chip.id) {
          <li class="inline-flex max-w-full">
            <app-tag-chip [name]="chip.name" [color]="chip.color" size="md">
              <button
                type="button"
                class="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-subtle hover:text-ink disabled:opacity-60"
                [attr.aria-label]="'Remove tag ' + chip.name"
                [disabled]="disabled()"
                (click)="remove(chip.id)"
              >
                <app-icon name="x" />
              </button>
            </app-tag-chip>
          </li>
        }
      </ul>
    }

    <input
      #input
      appInput
      type="text"
      role="combobox"
      autocomplete="off"
      autocapitalize="none"
      spellcheck="false"
      enterkeyhint="done"
      aria-autocomplete="list"
      placeholder="Find or create a tag"
      [attr.aria-expanded]="expanded()"
      [attr.aria-controls]="listboxId"
      [attr.aria-activedescendant]="activeId()"
      [attr.maxlength]="nameMaxLength"
      [extraDescribedBy]="message() ? messageId : null"
      [disabled]="disabled()"
      [value]="text()"
      (input)="onInput($event)"
      (keydown)="onKeydown($event)"
      (click)="onClick()"
      (blur)="onBlur()"
    />

    <!--
      tabindex -1: a list that scrolls is a tab stop of its own in Chromium (it makes scrollers
      keyboard focusable), and it is hidden as soon as the box loses focus, so Tab from the box would
      land on it and then drop focus to the page. The options are reached with the arrow keys.
    -->
    <ul
      [id]="listboxId"
      role="listbox"
      aria-label="Tag suggestions"
      tabindex="-1"
      [hidden]="!expanded()"
      class="mt-1 max-h-56 overflow-y-auto rounded-control border border-line-strong bg-surface py-1 shadow-md"
      (mousedown)="$event.preventDefault()"
    >
      @for (option of options(); track option.key; let index = $index) {
        <li
          role="option"
          class="flex min-h-11 cursor-pointer items-center gap-2 px-3 py-2 text-sm text-ink hover:bg-subtle aria-selected:bg-accent-soft aria-selected:font-semibold aria-selected:outline-2 aria-selected:-outline-offset-2 aria-selected:outline-focus"
          [id]="optionId(index)"
          [attr.aria-selected]="index === active()"
          (click)="choose(index)"
        >
          @if (option.kind === 'tag') {
            @if (option.tag.color; as color) {
              <span
                aria-hidden="true"
                class="size-2.5 shrink-0 rounded-full ring-1 ring-line-strong"
                [style.background-color]="color"
              ></span>
            } @else {
              <app-icon name="tag" class="text-muted" />
            }
            <span class="min-w-0 break-words">{{ option.tag.name }}</span>
          } @else {
            <app-icon name="plus" />
            <span class="min-w-0 break-words">Create tag '{{ option.name }}'</span>
          }
        </li>
      }
    </ul>

    @if (message(); as text) {
      <p [id]="messageId" class="mt-1.5 text-sm text-muted">{{ text }}</p>
    }
    @if (error(); as text) {
      <p role="alert" class="mt-1.5 flex items-start gap-1.5 text-sm font-medium text-negative">
        <app-icon name="alert" class="mt-0.5" />
        <span>{{ text }}</span>
      </p>
    }
    <p class="sr-only" aria-live="polite">{{ announcement() }}</p>
  `,
  host: { class: 'block' },
})
export class TagInput implements ControlValueAccessor, Validator {
  private readonly store = inject(TagsStore);
  private readonly alive = aliveFlag();
  private readonly input = viewChild.required<ElementRef<HTMLInputElement>>('input');

  private readonly id = nextTagInputId++;
  protected readonly listboxId = `tag-input-${this.id}-listbox`;
  protected readonly messageId = `tag-input-${this.id}-message`;
  protected readonly nameMaxLength = TAG_NAME_MAX_LENGTH;

  /** The chosen tag ids, in the order they were chosen. */
  private readonly value = signal<readonly number[]>([]);
  protected readonly text = signal('');
  protected readonly disabled = signal(false);
  private readonly open = signal(false);
  private readonly activeIndex = signal(-1);
  protected readonly announcement = signal('');
  protected readonly error = signal<string | null>(null);
  private readonly creating = signal(false);

  /** The text without the spaces around it, which is the name that would be searched or created. */
  private readonly query = computed(() => this.text().trim());
  private readonly atLimit = computed(() => this.value().length >= MAX_TAGS_PER_SPENDING);

  protected readonly chips = computed<Chip[]>(() => {
    const known = this.store.byId();
    return this.value().map((id) => {
      const tag = known.get(id);
      return { id, name: tag?.name ?? `Tag ${id}`, color: tag?.color ?? null };
    });
  });

  /** The name could be created: no tag has it, as the API compares names. */
  private readonly canCreate = computed(() => {
    const name = this.query();
    return name !== '' && !this.store.tags().some((tag) => sameTagName(tag.name, name));
  });

  protected readonly options = computed<Option[]>(() => {
    if (this.atLimit()) return [];
    const query = this.query();
    const wanted = fold(query);
    const chosen = new Set(this.value());
    // The tag that is exactly the text first, then the ones that start with it, then the rest.
    const rank = (tag: TagDto) =>
      sameTagName(tag.name, query) ? 0 : fold(tag.name).startsWith(wanted) ? 1 : 2;
    const tags = this.store
      .tags()
      .filter((tag) => !chosen.has(tag.id) && fold(tag.name).includes(wanted))
      .sort((a, b) => rank(a) - rank(b));
    const options: Option[] = tags.map((tag) => ({ key: `tag-${tag.id}`, kind: 'tag', tag }));
    if (this.canCreate()) options.push({ key: 'create', kind: 'create', name: query });
    return options;
  });

  protected readonly expanded = computed(() => this.open() && this.options().length > 0);
  /** The highlighted option, or -1. */
  protected readonly active = computed(() => {
    const index = this.activeIndex();
    return index >= 0 && index < this.options().length ? index : -1;
  });
  protected readonly activeId = computed(() =>
    this.expanded() && this.active() >= 0 ? this.optionId(this.active()) : null,
  );

  /** Said under the box when there is something to know: the limit, or a tag already added. */
  protected readonly message = computed(() => {
    if (this.atLimit()) return LIMIT_MESSAGE;
    const query = this.query();
    if (query === '') return '';
    const chosen = this.chips().find((chip) => sameTagName(chip.name, query));
    return chosen ? `${chosen.name} is already added.` : '';
  });

  private onChange: (value: number[]) => void = () => undefined;
  private onTouched: () => void = () => undefined;
  private onValidatorChange: () => void = () => undefined;

  constructor() {
    // Whether the box holds text that was never taken is part of what the form checks.
    effect(() => {
      this.text();
      untracked(() => this.onValidatorChange());
    });

    // `aria-activedescendant` moves the highlight, not the scroll position: with more entries than
    // fit, the highlighted one would leave the list. Keep it in view, moving the least possible.
    afterRenderEffect(() => {
      const id = this.activeId();
      if (id === null) return;
      this.input().nativeElement.ownerDocument.getElementById(id)?.scrollIntoView({
        block: 'nearest',
      });
    });
  }

  /** Puts the cursor in the box. */
  focus(): void {
    this.input().nativeElement.focus();
  }

  protected optionId(index: number): string {
    return `${this.listboxId}-option-${index}`;
  }

  // --- ControlValueAccessor ----------------------------------------------------------------------

  writeValue(value: readonly number[] | null): void {
    this.value.set(value ? [...value] : []);
    this.announcement.set('');
    this.error.set(null);
  }

  registerOnChange(fn: (value: number[]) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  registerOnValidatorChange(fn: () => void): void {
    this.onValidatorChange = fn;
  }

  /** Text in the box that was not taken as a tag: the form says so instead of leaving it out silently. */
  validate(): ValidationErrors | null {
    const query = this.query();
    if (query === '') return null;
    // The words do not quote the text: it is in the box right above, and a message that changes with
    // every character typed would be read out again for each one (the field's error is a live region).
    const chosen = this.chips().some((chip) => sameTagName(chip.name, query));
    const message = chosen
      ? 'That tag is already added. Clear the box.'
      : this.atLimit()
        ? `Clear the box: a spending can have up to ${MAX_TAGS_PER_SPENDING} tags.`
        : "The text in the box isn't added yet. Press Enter to add it, or clear the box.";
    return { pendingTag: { message } };
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  // --- the box -------------------------------------------------------------------------------------

  protected onInput(event: Event): void {
    this.text.set((event.target as HTMLInputElement).value);
    this.error.set(null);
    this.open.set(true);
    // The first suggestion is highlighted, so typing a name and pressing Enter takes it.
    this.activeIndex.set(this.options().length > 0 ? 0 : -1);
  }

  protected onClick(): void {
    // Tapping the box shows the tags there are, so one can be taken without typing.
    if (!this.disabled()) this.open.set(true);
  }

  protected onBlur(): void {
    this.open.set(false);
    this.onTouched();
  }

  protected onKeydown(event: KeyboardEvent): void {
    // A key that is part of composing text (an IME) is not ours.
    if (event.isComposing) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.step(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.step(-1);
        break;
      case 'Enter':
        this.onEnter(event);
        break;
      case 'Escape':
        // Only the list: a dialog around this field must not close under the person's hands.
        if (this.expanded()) {
          event.preventDefault();
          event.stopPropagation();
          this.open.set(false);
        }
        break;
      case 'Backspace':
        if (this.text() === '' && this.value().length > 0) {
          event.preventDefault();
          this.remove(this.value()[this.value().length - 1]);
        }
        break;
    }
  }

  private step(delta: 1 | -1): void {
    const count = this.options().length;
    if (count === 0) return;
    if (!this.expanded()) {
      this.open.set(true);
      this.activeIndex.set(delta > 0 ? 0 : count - 1);
      return;
    }
    const current = this.active();
    this.activeIndex.set(
      current < 0 ? (delta > 0 ? 0 : count - 1) : (current + delta + count) % count,
    );
  }

  private onEnter(event: KeyboardEvent): void {
    // An empty box lets Enter do what it does in any field: send the form.
    if (this.query() === '') return;

    // Text in the box is never sent off with the form by accident.
    event.preventDefault();
    if (this.options().length === 0) {
      // Nothing can be taken: the limit is reached, or the tag is chosen already.
      this.announce(this.message() || `No tag to add for ${this.query()}.`);
      return;
    }
    // The entry that is highlighted, else the first, whether or not the list is open. The message under
    // the box says "Press Enter to add it", and it shows when the list is closed (after Escape, and
    // after a form was not sent because of this text), so Enter has to do it then as well.
    this.choose(this.active() >= 0 ? this.active() : 0);
  }

  // --- choosing and removing -------------------------------------------------------------------------

  protected choose(index: number): void {
    const option = this.options()[index];
    if (!option) return;
    if (option.kind === 'tag') this.add(option.tag);
    else void this.create(option.name);
    this.focus();
  }

  private add(tag: Pick<TagDto, 'id' | 'name'>, note = ''): void {
    if (this.value().includes(tag.id)) return;
    if (this.atLimit()) {
      this.announce(LIMIT_MESSAGE);
      return;
    }
    const next = [...this.value(), tag.id];
    // The box is emptied first, so the control is never checked with the text of the tag it just took.
    this.text.set('');
    this.commit(next);
    this.open.set(false);
    this.activeIndex.set(-1);
    const count = next.length;
    this.announce(
      `${note}Tag ${tag.name} added. ${count} ${count === 1 ? 'tag' : 'tags'} chosen.` +
        (count >= MAX_TAGS_PER_SPENDING ? ` ${LIMIT_MESSAGE}` : ''),
    );
  }

  protected remove(id: number): void {
    if (this.disabled()) return;
    const name = this.chips().find((chip) => chip.id === id)?.name ?? `Tag ${id}`;
    this.commit(this.value().filter((chosen) => chosen !== id));
    this.announce(`Tag ${name} removed.`);
    // The button that had focus is gone: the box is where the person was working.
    this.focus();
  }

  private async create(name: string): Promise<void> {
    if (this.creating()) return;
    this.creating.set(true);
    this.error.set(null);
    this.announce(`Creating tag ${name}.`);
    try {
      const created = await this.store.create({ name });
      if (this.alive()) this.add(created);
    } catch (error) {
      if (!this.alive()) return;
      if (hasApiErrorCode(error, 'tag_name_taken')) {
        // It was created meanwhile (another tab, or a double tap): use that one.
        await this.store.reload();
        const existing = this.store.tags().find((tag) => sameTagName(tag.name, name));
        if (existing && this.alive()) {
          this.add(existing, `${existing.name} already existed. `);
          return;
        }
      }
      this.error.set(`Couldn't create the tag. ${parseApiError(error).message}`);
    } finally {
      this.creating.set(false);
    }
  }

  private commit(next: number[]): void {
    this.value.set(next);
    this.onChange(next);
  }

  private announce(message: string): void {
    this.announcement.set(message);
  }
}
