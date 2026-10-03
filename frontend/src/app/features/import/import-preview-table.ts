import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  viewChild,
} from '@angular/core';
import type { ImportPreviewRow, ImportRowErrorCode } from '@wallet/shared';
import { SettingsStore } from '../../core/settings.store';
import { formatDate, formatMonth } from '../../shared/format';
import { AppInput } from '../../shared/forms/app-input';
import { Amount } from '../../shared/ui/amount';
import { Button } from '../../shared/ui/button';
import { Icon } from '../../shared/ui/icon';
import { REJECTION_TEXT, ROW_ERROR_TEXT } from './import-text';
import { isSelectable, PAGE_SIZE, ImportReviewStore } from './import-review.store';

/**
 * The rows of the preview, one page at a time (files go up to 10,000 rows): a checkbox, the date and
 * line, the description with its badges, the amount in spending sign and the budget. Everything shown
 * about a row is what the server judged; the badges say in words why a row cannot be imported
 * (duplicate, an error) or needs a decision (a credit). A row that cannot be imported has a disabled
 * checkbox. The table scrolls sideways inside its own box on a narrow screen, never the page.
 */
@Component({
  selector: 'app-import-preview-table',
  imports: [AppInput, Amount, Button, Icon],
  template: `
    <!-- "relative": the sr-only spans of the cells are absolute, and without it they are not clipped by this scroller, so the columns scrolled out of view widen the whole page on a phone. -->
    <div
      #region
      role="region"
      aria-label="Rows of the file"
      tabindex="0"
      class="relative overflow-x-auto rounded-card border border-line"
    >
      <table class="w-full min-w-[40rem] border-collapse text-left text-sm">
        <caption class="sr-only">
          Rows of the file: tick the ones to import and check the budget of each
        </caption>
        <thead class="bg-subtle">
          <tr>
            <th scope="col" class="w-10 px-3 py-2"><span class="sr-only">Import</span></th>
            <th scope="col" class="px-3 py-2 font-semibold">Date</th>
            <th scope="col" class="px-3 py-2 font-semibold">Description</th>
            <th scope="col" class="px-3 py-2 text-right font-semibold">Amount</th>
            <th scope="col" class="px-3 py-2 font-semibold">Budget</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-line">
          @for (row of review.pageRows(); track row.line) {
            <tr [class.bg-subtle]="!selectable(row)">
              <td class="px-3 py-2 align-top">
                <input
                  type="checkbox"
                  class="size-6 accent-accent"
                  [attr.aria-label]="'Import line ' + row.line"
                  [checked]="review.isChecked(row.line)"
                  [disabled]="!selectable(row)"
                  (change)="onCheck(row, $event)"
                />
              </td>
              <td class="px-3 py-2 align-top whitespace-nowrap">
                @if (row.date !== null) {
                  <span class="block">{{ dateText(row.date) }}</span>
                } @else {
                  <span class="block">{{ row.raw.date || 'No date' }}</span>
                }
                <span class="block text-xs text-muted">Line {{ row.line }}</span>
              </td>
              <td class="min-w-48 px-3 py-2 align-top">
                @if (row.description !== '') {
                  <span class="block break-words">{{ row.description }}</span>
                } @else {
                  <span class="block text-muted">No description</span>
                }
                <span class="mt-1 flex flex-wrap gap-1">
                  @if (row.duplicate) {
                    <span class="badge border-line-strong bg-surface">
                      <app-icon name="check-circle" />
                      Already imported
                    </span>
                  }
                  @if (row.credit) {
                    <span class="badge border-line-strong bg-surface">
                      <app-icon name="arrow-down" />
                      Credit: money in
                    </span>
                  }
                  @for (code of row.errors; track code) {
                    <span class="badge border-negative bg-negative-soft">
                      <app-icon name="alert" />
                      {{ errorText(row, code) }}
                    </span>
                  }
                  @if (rejectedCodes(row.line); as codes) {
                    <span class="badge border-negative bg-negative-soft">
                      <app-icon name="ban" />
                      Refused by the server: {{ rejectedText(codes) }}
                    </span>
                  }
                </span>
              </td>
              <td class="px-3 py-2 text-right align-top whitespace-nowrap">
                @if (row.amount !== null) {
                  <app-amount [cents]="row.amount" [plain]="true" />
                } @else {
                  <span aria-hidden="true">–</span>
                  <span class="sr-only">No amount</span>
                }
              </td>
              <td class="min-w-44 px-3 py-2 align-top">
                @if (selectable(row)) {
                  @let options = review.optionsFor(row);
                  @let budget = review.budgetFor(row);
                  <select
                    appInput
                    data-budget
                    [attr.aria-label]="'Budget for line ' + row.line"
                    [disabled]="options.length === 0"
                    (change)="onBudget(row, $event)"
                  >
                    @if (options.length === 0) {
                      <option value="" selected>No budget is active in {{ monthName(row) }}</option>
                    } @else {
                      <option value="" [selected]="budget === null">Choose a budget</option>
                      @for (option of options; track option.id) {
                        <option [value]="option.id" [selected]="option.id === budget">
                          {{ option.name }}
                        </option>
                      }
                    }
                  </select>
                } @else {
                  <span aria-hidden="true">–</span>
                  <span class="sr-only">Not imported</span>
                }
              </td>
            </tr>
          } @empty {
            <tr>
              <td colspan="5" class="px-3 py-6 text-center text-muted">No rows match this filter.</td>
            </tr>
          }
        </tbody>
      </table>
    </div>

    <nav aria-label="Pages of rows" class="mt-3 flex flex-wrap items-center justify-between gap-3">
      <p aria-live="polite" class="text-sm text-muted">{{ rangeText() }}</p>
      @if (review.pageCount() > 1) {
        <div class="flex gap-2">
          <button
            appButton
            variant="secondary"
            size="sm"
            [disabled]="review.page() === 0"
            (click)="move(-1)"
          >
            Previous {{ pageSize }}
          </button>
          <button
            appButton
            variant="secondary"
            size="sm"
            [disabled]="review.page() >= review.pageCount() - 1"
            (click)="move(1)"
          >
            Next {{ pageSize }}
          </button>
        </div>
      }
    </nav>
  `,
  host: { class: 'block' },
})
export class ImportPreviewTable {
  protected readonly review = inject(ImportReviewStore);
  private readonly settings = inject(SettingsStore);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly region = viewChild.required<ElementRef<HTMLElement>>('region');

  protected readonly pageSize = PAGE_SIZE;
  protected readonly selectable = isSelectable;

  /** The refused rows by line, with their codes (a commit that was answered 422). */
  private readonly refused = computed(
    () => new Map(this.review.rejected().map((row) => [row.line, row.codes] as const)),
  );

  /** "Rows 101 to 200 of 1,203". */
  protected readonly rangeText = computed(() => {
    const total = this.review.filteredRows().length;
    if (total === 0) return 'No rows';
    const from = this.review.page() * PAGE_SIZE + 1;
    const to = Math.min(total, from + PAGE_SIZE - 1);
    const number = new Intl.NumberFormat(this.settings.locale());
    return `Rows ${number.format(from)} to ${number.format(to)} of ${number.format(total)}`;
  });

  protected dateText(date: string): string {
    return formatDate(date, this.settings.locale(), 'medium');
  }

  protected monthName(row: ImportPreviewRow): string {
    return row.date === null ? 'that month' : formatMonth(row.date.slice(0, 7), this.settings.locale());
  }

  /** An error in words, with what the file says where it matters: the date or amount as written. */
  protected errorText(row: ImportPreviewRow, code: ImportRowErrorCode): string {
    const text = ROW_ERROR_TEXT[code];
    switch (code) {
      case 'invalid_date':
        return row.raw.date === '' ? text : `${text}: "${row.raw.date}"`;
      case 'invalid_amount':
      case 'amount_too_large':
      case 'zero_amount':
        return row.raw.amount === '' ? text : `${text}: "${row.raw.amount}"`;
      default:
        return text;
    }
  }

  protected rejectedCodes(line: number): readonly string[] | null {
    return this.refused().get(line) ?? null;
  }

  protected rejectedText(codes: readonly string[]): string {
    return codes
      .map((code) => REJECTION_TEXT[code as keyof typeof REJECTION_TEXT] ?? code)
      .join('; ');
  }

  protected onCheck(row: ImportPreviewRow, event: Event): void {
    this.review.toggle(row.line, (event.target as HTMLInputElement).checked);
  }

  /**
   * Picks a row's budget. In the "Needs a budget" filter the row then leaves the list, taking the
   * focused select with it: focus goes to the select that now sits where it was, so a keyboard user
   * can keep going down the list.
   */
  protected onBudget(row: ImportPreviewRow, event: Event): void {
    const select = event.target as HTMLSelectElement;
    const value = select.value;
    const index = this.review.pageRows().findIndex((candidate) => candidate.line === row.line);
    this.review.setBudget(row.line, value === '' ? null : Number(value));
    afterNextRender(
      () => {
        if (select.isConnected) return;
        const selects = this.host.nativeElement.querySelectorAll<HTMLElement>('select[data-budget]');
        const next = selects[Math.min(Math.max(index, 0), selects.length - 1)];
        (next ?? this.region().nativeElement).focus();
      },
      { injector: this.injector },
    );
  }

  /** Moves to another page of rows and puts focus on the table, so the new page is read from its top. */
  protected move(by: number): void {
    this.review.goToPage(this.review.page() + by);
    afterNextRender(
      () => {
        const region = this.region().nativeElement;
        region.focus();
        region.scrollIntoView({ block: 'nearest' });
      },
      { injector: this.injector },
    );
  }
}
