import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { SPENDING_SEARCH_MAX_LENGTH } from '@wallet/shared/limits';
import type { Cents } from '@wallet/shared/money';
import { debounceTime } from 'rxjs';
import { TagsStore } from '../../core/tags.store';
import { AppInput } from '../../shared/forms/app-input';
import { Field } from '../../shared/forms/field';
import { MoneyInput } from '../../shared/forms/money-input';
import { Badge } from '../../shared/ui/badge';
import { Button } from '../../shared/ui/button';
import { Icon } from '../../shared/ui/icon';
import { Segmented, type SegmentedOption } from '../../shared/ui/segmented';
import {
  activeCount,
  filtersProblem,
  NO_FILTERS,
  sameFilters,
  type SpendingFilters,
} from './spending-filters';
import { SpendingQuery } from './spending-query';

/** How long typing pauses before a search, or an amount, is applied. */
export const SEARCH_DEBOUNCE_MS = 300;

/** The most pushes to the address the bar remembers while it waits for them to come back. */
const MAX_PENDING = 8;

/** A budget the filter can pick. */
export interface BudgetOption {
  id: number;
  name: string;
}

let nextBarId = 0;

/**
 * The search and filters of the spendings list: text (description and notes), budget, tag, a range
 * of amounts, and whether to look in every month. They are not state of this component: they are
 * the URL (see `SpendingQuery`), and this only edits it.
 *
 * What is typed (the search, the amounts) is applied after a short pause, and replaces the history
 * entry instead of adding one per keystroke; Enter applies the search at once. What is chosen (a
 * budget, a tag, the scope) is applied straight away and is a history entry of its own. The amounts
 * are signed as stored, so a refund is negative, and a range whose minimum is above its maximum is
 * said so under the field and is not sent.
 *
 * It is a toolbar: the search box is always there, and a "Filters" button, which says in its name how
 * many filters are on ("Filters, 2 active"), unfolds a panel under it with the rest (the months to
 * look in, the budget, the tag and the range of amounts). The panel unfolds by itself when the page
 * arrives with one of those on, so a filter that is in use is never out of sight.
 */
@Component({
  selector: 'app-spending-filter-bar',
  imports: [ReactiveFormsModule, Field, AppInput, MoneyInput, Badge, Button, Icon, Segmented],
  templateUrl: './spending-filter-bar.html',
  host: { class: 'block' },
})
export class SpendingFilterBar {
  private readonly query = inject(SpendingQuery);
  private readonly tagStore = inject(TagsStore);

  /** The budgets to pick from (the page decides which: this month's, or all of them). */
  readonly budgets = input.required<readonly BudgetOption[]>();
  /** The selected month, as the first choice of the scope reads ("October 2026"). */
  readonly monthLabel = input('');
  /** The user wants every filter off. The page does it, and says where focus goes. */
  readonly clear = output<void>();

  private readonly id = nextBarId++;
  protected readonly panelId = `spending-filters-${this.id}`;
  protected readonly searchMaxLength = SPENDING_SEARCH_MAX_LENGTH;

  protected readonly filters = this.query.filters;
  protected readonly scopeOptions = computed<SegmentedOption[]>(() => [
    { value: 'month', label: this.monthLabel() || 'The selected month' },
    { value: 'all', label: 'All months' },
  ]);
  protected readonly count = computed(() => activeCount(this.filters()));
  /** What the button says to a screen reader: the count is in the name, as a badge says it to the eye. */
  protected readonly filtersLabel = computed(() =>
    this.count() > 0 ? `Filters, ${this.count()} active` : 'Filters',
  );
  /**
   * The panel is unfolded. It starts so when the page arrives with a filter on that is in the panel (the
   * search is not: it is always on screen).
   */
  protected readonly open = signal(this.count() - (this.filters().q === '' ? 0 : 1) > 0);

  protected readonly tagOptions = computed<readonly { id: number; name: string }[]>(() => {
    const tags = this.tagStore.tags().map((tag) => ({ id: tag.id, name: tag.name }));
    const wanted = this.filters().tagId;
    // A tag the list does not have (deleted, or still loading) stays visible, so the filter can be seen and removed.
    return wanted !== null && !tags.some((tag) => tag.id === wanted)
      ? [...tags, { id: wanted, name: `Tag ${wanted}` }]
      : tags;
  });

  /** What is typed. The URL gets it after a pause, so these hold the text in between. */
  protected readonly form = new FormGroup({
    q: new FormControl('', {
      nonNullable: true,
      validators: [Validators.maxLength(SPENDING_SEARCH_MAX_LENGTH)],
    }),
    minAmount: new FormControl<Cents | null>(null),
    maxAmount: new FormControl<Cents | null>(null),
  });
  private readonly draft = signal(this.form.getRawValue());

  /** The range in the boxes (not in the URL), so the problem shows as it is typed. */
  protected readonly rangeError = computed(() => {
    const { minAmount, maxAmount } = this.draft();
    return filtersProblem({ ...NO_FILTERS, minAmount, maxAmount });
  });

  /**
   * What this bar sent to the URL and has not seen come back yet, oldest first. A navigation takes a
   * moment, and the person may type on meanwhile: the URL then says what was typed a moment ago, and
   * putting that back in the box would undo the latest keystrokes. Whatever comes back that is in this
   * list is the bar's own doing; anything else is the person (or the browser) changing the address.
   */
  private readonly pending: Pick<SpendingFilters, 'q' | 'minAmount' | 'maxAmount'>[] = [];
  /** The filters of the address the boxes were last brought in line with. */
  private seen = this.query.filters();
  private clearedSeen = this.query.cleared();

  constructor() {
    const { q, minAmount, maxAmount } = this.filters();
    this.form.setValue({ q, minAmount, maxAmount }, { emitEvent: false });
    this.draft.set(this.form.getRawValue());

    this.form.valueChanges
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.draft.set(this.form.getRawValue()));
    this.form.valueChanges
      .pipe(debounceTime(SEARCH_DEBOUNCE_MS), takeUntilDestroyed())
      .subscribe(() => this.apply());

    // The URL changed under us (Back, Forward, a link, "Clear filters"): the boxes follow it.
    effect(() => {
      const filters = this.filters();
      untracked(() => this.follow(filters));
    });
    effect(() => {
      const cleared = this.query.cleared();
      untracked(() => {
        if (cleared === this.clearedSeen) return;
        this.clearedSeen = cleared;
        this.empty();
      });
    });
  }

  protected toggle(): void {
    this.open.update((open) => !open);
  }

  protected onBudget(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    void this.query.update({ budgetId: value === '' ? null : Number(value) });
  }

  protected onTag(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    void this.query.update({ tagId: value === '' ? null : Number(value) });
  }

  protected setScope(allMonths: boolean): void {
    void this.query.update({ allMonths });
  }

  /** Enter in the search box: do not wait for the pause. */
  protected applyNow(event: Event): void {
    event.preventDefault();
    this.apply();
  }

  /**
   * Sends what is typed to the URL, unless it is not a filter yet: a box with text that is not an
   * amount keeps the amount the URL has, and a range the API would refuse is not sent. What is typed
   * is compared with the address as it will be once the pushes still under way have arrived.
   */
  private apply(): void {
    const { q, minAmount, maxAmount } = this.form.controls;
    const intended: SpendingFilters = { ...this.filters(), ...this.pending.at(-1) };
    const next = {
      q: q.invalid ? intended.q : q.value.trim(),
      minAmount: minAmount.invalid ? intended.minAmount : minAmount.value,
      maxAmount: maxAmount.invalid ? intended.maxAmount : maxAmount.value,
    };
    const merged = { ...intended, ...next };
    if (filtersProblem(merged) !== null || sameFilters(merged, intended)) return;

    this.pending.push(next);
    // A navigation that never arrives (it was replaced by another) must not pile up.
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    void this.query.update(next, { replace: true }).then((arrived) => {
      // A push that changed nothing (the address already said it) or was cancelled comes back as
      // nothing, and would otherwise pass a later change of the address for the bar's own.
      const index = this.pending.indexOf(next);
      if (!arrived && index >= 0) this.pending.splice(index, 1);
    });
  }

  /**
   * Puts what the URL says into the boxes, for the filters whose address changed, unless the URL
   * only says what this bar sent (see `pending`). A box the address did not change is left alone,
   * whatever it holds: text that was typed a moment ago and not sent, or an amount that is not valid
   * yet, must not be wiped because someone chose a tag. The boxes announce a change like any other
   * (their field shows or drops its error with it); what that sends to `apply` is nothing, because by
   * then the boxes and the URL agree.
   */
  private follow(filters: SpendingFilters): void {
    const before = this.seen;
    this.seen = filters;

    const sent = this.pending.findIndex(
      (push) =>
        push.q === filters.q &&
        push.minAmount === filters.minAmount &&
        push.maxAmount === filters.maxAmount,
    );
    if (sent >= 0) {
      // It is ours, and so is everything sent before it.
      this.pending.splice(0, sent + 1);
      return;
    }
    this.pending.length = 0;

    const { q, minAmount, maxAmount } = this.form.controls;
    if (filters.q !== before.q && filters.q !== q.value.trim()) q.setValue(filters.q);
    if (filters.minAmount !== before.minAmount && filters.minAmount !== minAmount.value) {
      minAmount.setValue(filters.minAmount);
    }
    if (filters.maxAmount !== before.maxAmount && filters.maxAmount !== maxAmount.value) {
      maxAmount.setValue(filters.maxAmount);
    }
  }

  private empty(): void {
    this.pending.length = 0;
    this.form.reset({ q: '', minAmount: null, maxAmount: null });
  }
}
