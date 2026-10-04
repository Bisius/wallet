import {
  afterNextRender,
  Component,
  computed,
  inject,
  Injector,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { GoalDto } from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import { SettingsStore } from '../../core/settings.store';
import { formatMoney } from '../../shared/money.pipe';
import { Button } from '../../shared/ui/button';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { Disclosure } from '../../shared/ui/disclosure';
import { Icon } from '../../shared/ui/icon';
import { AppSection } from '../../shared/ui/section';
import { EmptyState } from '../../shared/ui/states';
import { ToastService } from '../../shared/ui/toast.service';
import { GoalCard } from './goal-card';
import { GoalForm } from './goal-form';
import { GoalsApi } from './goals.api';
import { SavingsData } from './savings-data';

/** Asks the page to open a money dialog for a goal. */
export interface GoalMoneyRequest {
  kind: 'deposit' | 'withdrawal' | 'reallocation';
  goalId: number;
}

/**
 * The goals, as the savings overview lists them: cards for the ones in use, and the archived ones
 * folded away in a section of their own. Creating and editing happen in `GoalForm`; archiving
 * (and bringing back) and deleting are done here. Money into or out of a goal is the page's money
 * dialog, which this only asks for.
 */
@Component({
  selector: 'app-goals-section',
  imports: [AppSection, Button, Disclosure, EmptyState, GoalCard, GoalForm, Icon],
  templateUrl: './goals-section.html',
  host: { class: 'block' },
})
export class GoalsSection {
  private readonly data = inject(SavingsData);
  private readonly api = inject(GoalsApi);
  private readonly settings = inject(SettingsStore);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly section = viewChild(AppSection);

  /** The user wants to deposit to, or withdraw from, a goal. */
  readonly moveMoney = output<GoalMoneyRequest>();

  /** In the API's order: the goals in use first, the archived ones last (see `SavingsDto.goals`). */
  private readonly goals = computed<readonly GoalDto[]>(() => this.data.savings()?.goals ?? []);
  protected readonly inUse = computed(() => this.goals().filter((goal) => !goal.archived));
  protected readonly archived = computed(() => this.goals().filter((goal) => goal.archived));

  /** The form dialog: creating (`goal` unset) or editing. `null` while it is closed. */
  protected readonly form = signal<{ goal: GoalDto | undefined } | null>(null);
  /** A goal request (archive, delete) is out. */
  protected readonly busy = signal(false);

  protected openCreate(): void {
    this.form.set({ goal: undefined });
  }

  protected openEdit(goal: GoalDto): void {
    this.form.set({ goal });
  }

  protected closeForm(): void {
    this.form.set(null);
  }

  protected async reload(): Promise<void> {
    await this.data.reload();
  }

  protected async toggleArchive(goal: GoalDto): Promise<void> {
    if (this.busy()) return;
    const archive = !goal.archived;
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.update(goal.id, { archived: archive }));
      this.toast.success(
        archive
          ? `${goal.name} archived. It keeps its balance, and you can bring it back any time.`
          : `${goal.name} is active again.`,
      );
    } catch (error) {
      this.toast.error(parseApiError(error).message);
    }
    try {
      await this.data.reload();
    } finally {
      this.busy.set(false);
    }
    // The card that had focus moved to the other group, or is gone: go back to the heading.
    this.focusHeading();
  }

  protected async remove(goal: GoalDto): Promise<void> {
    if (this.busy()) return;
    const balance = formatMoney(goal.balance, this.settings.locale(), this.settings.currency());
    const confirmed = await this.confirm.confirm({
      title: `Delete "${goal.name}"?`,
      message:
        `The goal is removed. Its balance of ${balance} moves to your unassigned savings, so nothing is lost ` +
        `and your savings balance stays the same. Its past deposits and withdrawals stay in the history, as unassigned savings.`,
      confirmLabel: 'Delete goal',
      tone: 'danger',
    });
    if (!confirmed) return;

    this.busy.set(true);
    try {
      await firstValueFrom(this.api.remove(goal.id));
      this.toast.success(`${goal.name} deleted. ${balance} moved to unassigned savings.`);
    } catch (error) {
      this.toast.error(parseApiError(error).message);
    }
    try {
      await this.data.reload();
    } finally {
      this.busy.set(false);
    }
    this.focusHeading();
  }

  private focusHeading(): void {
    afterNextRender(() => this.section()?.focusHeading(), { injector: this.injector });
  }
}
