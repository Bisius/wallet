import {
  afterNextRender,
  Component,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  OnInit,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  type ValidatorFn,
  Validators,
} from '@angular/forms';
import type {
  Cents,
  MonthBudgetLine,
  MonthKey,
  SpendingDto,
  SpendingUpdateInput,
} from '@wallet/shared';
// Zod-free deep import: keeps zod out of this page's chunk.
import { DESCRIPTION_MAX_LENGTH, NOTES_MAX_LENGTH } from '@wallet/shared/limits';
import { firstValueFrom, type Observable } from 'rxjs';
import { type ParsedApiError, parseApiError } from '../../core/api-error';
import { SettingsStore } from '../../core/settings.store';
import { TagsStore } from '../../core/tags.store';
import { TodayStore } from '../../core/today.store';
import { clampDateToMonth, firstDayOf, lastDayOf } from '../../shared/format';
import { applyApiErrors, focusFirstInvalidOrSubmit } from '../../shared/forms/api-errors';
import { AppInput } from '../../shared/forms/app-input';
import { Field } from '../../shared/forms/field';
import { MoneyInput } from '../../shared/forms/money-input';
import { TagInput } from '../../shared/forms/tag-input';
import { Toggle } from '../../shared/forms/toggle';
import { dateInMonth } from '../../shared/forms/validators';
import { MoneyPipe } from '../../shared/money.pipe';
import { Button } from '../../shared/ui/button';
import { Icon } from '../../shared/ui/icon';
import { LastBudgetStore } from './last-budget.store';
import { SpendingsApi } from './spendings.api';

/**
 * The amount is typed without a sign: money going out is a plain number, and money coming back is
 * the Refund switch. A typed minus would be a second, conflicting way to say it.
 */
const spendingAmount: ValidatorFn = (control) => {
  const value: unknown = control.value;
  if (typeof value !== 'number') return null;
  if (value < 0) {
    return {
      amount: {
        message: 'Enter the amount without a minus sign. Turn on Refund for money coming back.',
      },
    };
  }
  return value === 0 ? { amount: { message: 'Enter an amount greater than zero.' } } : null;
};

/**
 * The API names a tag that is not one by its place (`tagIds.2`), while the form has one control for
 * all the tags: the message goes on that control.
 */
function onTagsControl(error: ParsedApiError): ParsedApiError {
  const fieldErrors: Record<string, string> = {};
  for (const [path, message] of Object.entries(error.fieldErrors)) {
    fieldErrors[path.startsWith('tagIds.') ? 'tagIds' : path] ??= message;
  }
  return { ...error, fieldErrors };
}

/** Whether two lists hold the same ids, whatever their order. */
function sameIds(a: readonly number[], b: readonly number[]): boolean {
  const sorted = (ids: readonly number[]) => [...ids].sort((x, y) => x - y);
  const left = sorted(a);
  const right = sorted(b);
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Adds a spending, or edits one when `spending` is given.
 *
 * Built for a phone: the date starts as today (the server's, inside the shown month) and the budget
 * as the one used last, so a typical entry is an amount and a tap. The API wants a negative amount
 * for a refund; the person types it as a plain number and turns on Refund. After an add the form
 * clears the amount, description, tags and Refund switch and keeps the budget and date, ready for the
 * next entry, with focus back on the amount.
 *
 * Tags are optional and out of the way: a new spending shows an "Add tags" button that brings up the
 * tag field (and it stays up for the next entry), while the edit dialog always has the field.
 *
 * `saved` carries what the API stored. The page reloads what it shows and confirms.
 */
@Component({
  selector: 'app-spending-form',
  imports: [
    ReactiveFormsModule,
    Field,
    AppInput,
    MoneyInput,
    TagInput,
    Toggle,
    Button,
    Icon,
    MoneyPipe,
  ],
  templateUrl: './spending-form.html',
  host: { class: 'block' },
})
export class SpendingForm implements OnInit {
  private readonly api = inject(SpendingsApi);
  private readonly settings = inject(SettingsStore);
  private readonly today = inject(TodayStore);
  private readonly lastBudget = inject(LastBudgetStore);
  private readonly tags = inject(TagsStore);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly amountField = viewChild<unknown, ElementRef<HTMLElement>>('amountField', {
    read: ElementRef,
  });
  private readonly tagInput = viewChild(TagInput);

  /** The month the page shows: the date has to stay inside it. */
  readonly month = input.required<MonthKey>();
  /** The budgets that exist in that month (`MonthView.budgets`), as the choices. */
  readonly budgets = input.required<readonly MonthBudgetLine[]>();
  /** The spending to edit. Leave unset to add a new one. */
  readonly spending = input<SpendingDto>();

  readonly saved = output<SpendingDto>();
  readonly cancelled = output<void>();

  protected readonly descriptionMaxLength = DESCRIPTION_MAX_LENGTH;
  protected readonly notesMaxLength = NOTES_MAX_LENGTH;
  /** True while a request is out. A dialog around the form keeps Escape from closing it then. */
  readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);
  /** The tag field is up. A new spending starts without it; the edit dialog always has it. */
  protected readonly tagsOpen = signal(false);

  protected firstDay = () => firstDayOf(this.month());
  protected lastDay = () => lastDayOf(this.month());

  protected readonly form = new FormGroup({
    amount: new FormControl<Cents | null>(null, [Validators.required, spendingAmount]),
    refund: new FormControl(false, { nonNullable: true }),
    budgetId: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    date: new FormControl('', {
      nonNullable: true,
      validators: [
        Validators.required,
        dateInMonth(
          () => this.month(),
          () => this.settings.locale(),
        ),
      ],
    }),
    description: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(DESCRIPTION_MAX_LENGTH)],
    }),
    notes: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(NOTES_MAX_LENGTH)],
    }),
    /** The ids of the tags. At most `MAX_TAGS_PER_SPENDING`, which the tag field enforces. */
    tagIds: new FormControl<number[]>([], { nonNullable: true }),
  });

  protected readonly isRefund = toSignal(this.form.controls.refund.valueChanges, {
    initialValue: false,
  });

  constructor() {
    // The month can change while the form is open (the month switcher is always there): keep the
    // date inside it.
    effect(() => {
      const month = this.month();
      untracked(() => {
        const date = this.form.controls.date;
        if (date.value) date.setValue(clampDateToMonth(date.value, month));
      });
    });

    // The budgets of another month may not include the one chosen: fall back to the one used last,
    // else the first. (When editing, the spending's own budget is always there.)
    effect(() => {
      const budgets = this.budgets();
      untracked(() => {
        const control = this.form.controls.budgetId;
        if (budgets.some((line) => String(line.id) === control.value)) return;
        const last = this.lastBudget.get();
        const wanted = budgets.find((line) => line.id === last) ?? budgets[0];
        control.setValue(wanted ? String(wanted.id) : '');
      });
    });
  }

  ngOnInit(): void {
    const spending = this.spending();
    if (spending) {
      this.form.setValue({
        amount: Math.abs(spending.amount),
        refund: spending.amount < 0,
        budgetId: String(spending.budgetId),
        date: spending.date,
        description: spending.description,
        notes: spending.notes ?? '',
        tagIds: [...spending.tagIds],
      });
    } else {
      // The default is today according to the server, never the browser clock.
      const today = this.today.date() ?? firstDayOf(this.month());
      this.form.controls.date.setValue(clampDateToMonth(today, this.month()));
    }
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.form.markAllAsTouched();
    const value = this.form.getRawValue();
    if (this.form.invalid || value.amount === null) {
      this.focusInvalidAfterRender();
      return;
    }

    const budgetId = Number(value.budgetId);
    // Integer negation: a refund is the same number, negative.
    const amount: Cents = value.refund ? -value.amount : value.amount;
    const description = value.description.trim();

    const editing = this.spending();
    let request: Observable<SpendingDto>;
    if (editing) {
      const changes: SpendingUpdateInput = {};
      if (value.date !== editing.date) changes.date = value.date;
      if (amount !== editing.amount) changes.amount = amount;
      if (budgetId !== editing.budgetId) changes.budgetId = budgetId;
      if (description !== editing.description) changes.description = description;
      const notes = value.notes.trim() || null;
      if (notes !== editing.notes) changes.notes = notes;
      // The tags replace the whole set, so they are only sent when the set is not the stored one.
      if (!sameIds(value.tagIds, editing.tagIds)) changes.tagIds = [...value.tagIds];
      if (Object.keys(changes).length === 0) {
        this.cancelled.emit();
        return;
      }
      request = this.api.update(editing.id, changes);
    } else {
      request = this.api.create({
        date: value.date,
        amount,
        budgetId,
        ...(description ? { description } : {}),
        ...(value.tagIds.length > 0 ? { tagIds: [...value.tagIds] } : {}),
      });
    }

    this.saving.set(true);
    this.formError.set(null);
    try {
      const saved = await firstValueFrom(request);
      if (!editing) {
        this.lastBudget.set(budgetId);
        this.resetForNextEntry();
      }
      this.saved.emit(saved);
    } catch (error) {
      const parsed = parseApiError(error);
      if (parsed.rule === 'unknown_tag') {
        await this.dropUnknownTags();
        this.formError.set(
          'A tag you chose no longer exists, so it was taken off. Check the tags, then save again.',
        );
      } else {
        this.formError.set(applyApiErrors(this.form, onTagsControl(parsed)));
      }
      this.focusInvalidAfterRender();
    } finally {
      this.saving.set(false);
    }
  }

  /** Puts the cursor on the amount, where an entry starts. */
  focusAmount(): void {
    afterNextRender(
      () => this.amountField()?.nativeElement.querySelector<HTMLElement>('input')?.focus(),
      { injector: this.injector },
    );
  }

  /** Brings up the tag field and puts the cursor in it. */
  protected revealTags(): void {
    this.tagsOpen.set(true);
    afterNextRender(() => this.tagInput()?.focus(), { injector: this.injector });
  }

  /** A tag was deleted meanwhile (the API said `unknown_tag`): take off the ones the list no longer has. */
  private async dropUnknownTags(): Promise<void> {
    await this.tags.reload();
    const known = this.tags.byId();
    const control = this.form.controls.tagIds;
    control.setValue(control.value.filter((id) => known.has(id)));
  }

  /** Keeps the budget and the date, clears the rest, and puts the cursor on the amount. */
  private resetForNextEntry(): void {
    const { amount, refund, description, tagIds } = this.form.controls;
    amount.reset(null);
    refund.reset(false);
    description.reset('');
    tagIds.reset([]);
    this.form.controls.date.markAsUntouched();
    this.form.controls.budgetId.markAsUntouched();
    this.focusAmount();
  }

  private focusInvalidAfterRender(): void {
    afterNextRender(() => focusFirstInvalidOrSubmit(this.host.nativeElement), {
      injector: this.injector,
    });
  }
}
