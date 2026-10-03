import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { IncomeDto, MonthKey } from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import type { LoadState } from '../../core/resource-state';
import { SettingsStore } from '../../core/settings.store';
import { formatDate, formatMonth } from '../../shared/format';
import { formatMoney } from '../../shared/money.pipe';
import { Amount } from '../../shared/ui/amount';
import { Button } from '../../shared/ui/button';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { Icon } from '../../shared/ui/icon';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/states';
import { ToastService } from '../../shared/ui/toast.service';
import { IncomeForm } from './income-form';
import { IncomesApi } from './incomes.api';

/**
 * The one-off incomes of the selected month (`incomes`, newest first): list, add, edit and delete.
 * Adding or editing happens in place with `IncomeForm`.
 */
@Component({
  selector: 'app-incomes-section',
  imports: [Amount, Button, Icon, EmptyState, ErrorState, LoadingState, IncomeForm],
  template: `
    <section aria-labelledby="incomes-heading" class="card space-y-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 #heading id="incomes-heading" tabindex="-1" class="text-lg font-semibold">
            One-off income in {{ monthLabel() }}
          </h2>
          <p class="text-sm text-muted">
            Bonuses, refunds and anything else that comes in besides your salary.
          </p>
        </div>
        @if (!adding()) {
          <button appButton (click)="startAdding()">
            <app-icon name="plus" />
            Add income
          </button>
        }
      </div>

      @if (adding()) {
        <app-income-form [month]="month()" (saved)="onSaved()" (cancelled)="stopAdding()" />
      }

      @switch (state()) {
        @case ('loading') {
          <app-loading-state label="Loading one-off income…" />
        }
        @case ('error') {
          <app-error-state
            title="Couldn't load one-off income"
            [error]="error()"
            (retry)="retry.emit()"
          />
        }
        @default {
          @if (list().length === 0) {
            @if (!adding()) {
              <app-empty-state
                [title]="'No one-off income in ' + monthLabel()"
                description="When money comes in besides your salary, add it here so the month's income is right."
              />
            }
          } @else {
            <ul class="divide-y divide-line rounded-card border border-line">
              @for (income of list(); track income.id) {
                <li class="p-3">
                  @if (editingId() === income.id) {
                    <app-income-form
                      [month]="month()"
                      [income]="income"
                      (saved)="onSaved(income.id)"
                      (cancelled)="stopEditing(income.id)"
                    />
                  } @else {
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <div class="min-w-0">
                        <p class="font-medium break-words">{{ income.description }}</p>
                        <p class="text-sm text-muted">{{ dateLabel(income.date) }}</p>
                      </div>
                      <div class="flex flex-wrap items-center gap-1">
                        <p class="mr-2 font-semibold">
                          <app-amount [cents]="income.amount" [signed]="true" />
                        </p>
                        <button
                          appButton
                          variant="ghost"
                          size="sm"
                          [attr.data-edit]="income.id"
                          [attr.aria-label]="'Edit ' + income.description"
                          (click)="startEditing(income.id)"
                        >
                          <app-icon name="pencil" />
                          Edit
                        </button>
                        <button
                          appButton
                          variant="ghost"
                          size="sm"
                          [attr.aria-label]="'Delete ' + income.description"
                          (click)="remove(income)"
                        >
                          <app-icon name="trash" />
                          Delete
                        </button>
                      </div>
                    </div>
                  }
                </li>
              }
            </ul>
          }
        }
      }
    </section>
  `,
  host: { class: 'block' },
})
export class IncomesSection {
  private readonly api = inject(IncomesApi);
  private readonly settings = inject(SettingsStore);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  /** The selected month. */
  readonly month = input.required<MonthKey>();
  /** The incomes of that month (`GET /api/incomes?month=`), once loaded. */
  readonly incomes = input<readonly IncomeDto[]>();
  /** Where loading the incomes stands. */
  readonly state = input.required<LoadState>();
  /** Why loading failed, while `state` is `error`. */
  readonly error = input<unknown>();

  /** The user wants to load the incomes again. */
  readonly retry = output<void>();

  /** Something was added, changed or deleted: the page reloads what it shows. */
  readonly changed = output<void>();

  protected readonly list = computed(() => this.incomes() ?? []);
  protected readonly adding = signal(false);
  protected readonly editingId = signal<number | null>(null);

  protected readonly monthLabel = computed(() => formatMonth(this.month(), this.settings.locale()));

  protected dateLabel(date: string): string {
    return formatDate(date, this.settings.locale(), 'full');
  }

  protected startAdding(): void {
    this.editingId.set(null);
    this.adding.set(true);
  }

  protected stopAdding(): void {
    this.adding.set(false);
    this.focus(() => this.host.nativeElement.querySelector<HTMLElement>('button'));
  }

  protected startEditing(id: number): void {
    this.adding.set(false);
    this.editingId.set(id);
  }

  protected stopEditing(id: number): void {
    this.editingId.set(null);
    this.focus(() => this.host.nativeElement.querySelector<HTMLElement>(`[data-edit="${id}"]`));
  }

  /** A form saved: close it and let the page reload. */
  protected onSaved(editedId?: number): void {
    this.adding.set(false);
    this.editingId.set(null);
    this.changed.emit();
    // The form that had focus is gone. After an edit go back to that row, else to the heading.
    this.focus(() =>
      editedId === undefined
        ? (this.heading()?.nativeElement ?? null)
        : this.host.nativeElement.querySelector<HTMLElement>(`[data-edit="${editedId}"]`),
    );
  }

  protected async remove(income: IncomeDto): Promise<void> {
    const amount = formatMoney(income.amount, this.settings.locale(), this.settings.currency());
    const confirmed = await this.confirm.confirm({
      title: 'Delete this income?',
      message: `"${income.description}" (${amount}, ${this.dateLabel(income.date)}) will no longer count towards the income of ${this.monthLabel()}.`,
      confirmLabel: 'Delete income',
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      await firstValueFrom(this.api.remove(income.id));
      this.toast.success('Income deleted.');
      this.changed.emit();
      // The row that had focus is gone.
      this.focus(() => this.heading()?.nativeElement ?? null);
    } catch (error) {
      this.toast.error(parseApiError(error).message);
    }
  }

  private focus(find: () => HTMLElement | null): void {
    afterNextRender(() => find()?.focus(), { injector: this.injector });
  }
}
