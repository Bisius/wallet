import {
  afterNextRender,
  Component,
  computed,
  inject,
  Injector,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { Cents, MonthKey, SalaryEntryDto } from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import { SettingsStore } from '../../core/settings.store';
import { formatMonth } from '../../shared/format';
import { ActionMenu, MenuItem } from '../../shared/ui/action-menu';
import { Amount } from '../../shared/ui/amount';
import { Badge } from '../../shared/ui/badge';
import { Button } from '../../shared/ui/button';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { Icon } from '../../shared/ui/icon';
import { AppList, ListRow } from '../../shared/ui/list';
import { AppSection } from '../../shared/ui/section';
import { EmptyState } from '../../shared/ui/states';
import { ToastService } from '../../shared/ui/toast.service';
import { SalaryApi } from './salary.api';
import { SalaryForm } from './salary-form';

/**
 * The salary history, and the button that opens the dialog to add or change an entry (`SalaryForm`).
 * A salary entry applies **from its month onward**; it never rewrites earlier months, and the dialog
 * says so. The amount shown for the selected month is the one the month view reports (`salary`
 * input), not a calculation of ours.
 */
@Component({
  selector: 'app-salary-section',
  imports: [
    ActionMenu,
    Amount,
    AppList,
    AppSection,
    Badge,
    Button,
    EmptyState,
    Icon,
    ListRow,
    MenuItem,
    SalaryForm,
  ],
  templateUrl: './salary-section.html',
  host: { class: 'block' },
})
export class SalarySection {
  private readonly api = inject(SalaryApi);
  private readonly settings = inject(SettingsStore);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly section = viewChild<AppSection>('section');

  /** The selected month. */
  readonly month = input.required<MonthKey>();
  /** Every salary change, ascending by month (`GET /api/salary`). */
  readonly entries = input.required<readonly SalaryEntryDto[]>();
  /** The salary in effect in the selected month, as the month view reports it. */
  readonly salary = input<Cents>();

  /** Something was saved or deleted: the page reloads what it shows. */
  readonly changed = output<void>();

  /** The dialog: changing from the selected month (`entry` unset) or an entry of the history. `null` while it is closed. */
  protected readonly form = signal<{ entry: SalaryEntryDto | undefined } | null>(null);

  protected readonly monthLabel = computed(() => this.label(this.month()));

  /**
   * Marks the entry that covers the selected month, as the contract describes it ("the entry with
   * the latest effectiveMonth <= M"). Only a marker: the amount shown comes from the month view.
   */
  protected readonly inEffectMonth = computed(
    () =>
      this.entries()
        .filter((entry) => entry.effectiveMonth <= this.month())
        .at(-1)?.effectiveMonth,
  );

  protected label(month: MonthKey): string {
    return formatMonth(month, this.settings.locale());
  }

  protected openChange(entry?: SalaryEntryDto): void {
    this.form.set({ entry });
  }

  protected closeForm(): void {
    this.form.set(null);
  }

  /** The salary was saved: the dialog closes (and gives focus back to what opened it), the page reloads. */
  protected onSaved(): void {
    this.form.set(null);
    this.changed.emit();
  }

  protected async remove(entry: SalaryEntryDto): Promise<void> {
    const from = this.label(entry.effectiveMonth);
    const confirmed = await this.confirm.confirm({
      title: 'Delete this salary change?',
      message:
        `The salary change from ${from} will be removed. Months from ${from} on use the previous ` +
        'salary entry instead; with none before it they have no salary.',
      confirmLabel: 'Delete salary change',
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      await firstValueFrom(this.api.remove(entry.effectiveMonth));
      this.toast.success(`Salary change from ${from} deleted.`);
      this.changed.emit();
      // The row that had focus is gone.
      afterNextRender(() => this.section()?.focusHeading(), { injector: this.injector });
    } catch (error) {
      this.toast.error(parseApiError(error).message);
    }
  }
}
