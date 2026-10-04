import type { MonthBudgetLine } from '@wallet/shared';
import { ALERT_LABELS } from '../budgets/budget-utils';

/** What was just added: the budget it went to and the signed amount (negative is a refund). */
export interface Added {
  budgetId: number;
  amount: number;
}

/**
 * What the app says after a spending is added, in a sentence or two, with the budget's figures as the
 * month view reports them (`line`, loaded after the spending was saved). Nothing here is calculated:
 * only the sign is turned around to say "over budget by". `money` formats cents. The Spendings page
 * shows it under its form and the shell's Add spending shows it in a toast.
 */
export function addedConfirmation(
  added: Added,
  line: MonthBudgetLine | undefined,
  money: (cents: number) => string,
): string {
  const name = line?.name ?? 'the budget';
  const parts = [
    added.amount < 0
      ? `Refund of ${money(-added.amount)} added to ${name}.`
      : `Added ${money(added.amount)} to ${name}.`,
  ];
  if (line && line.remaining < 0) {
    const used = line.usagePercent === null ? '' : ` (${line.usagePercent}% used)`;
    parts.push(`Over budget by ${money(-line.remaining)}${used}.`);
  } else if (line) {
    parts.push(`${money(line.remaining)} left of ${money(line.available)}.`);
    if (line.alert === 'warning' && line.usagePercent !== null) {
      parts.push(`${ALERT_LABELS.warning}: ${line.usagePercent}% used.`);
    }
  }
  return parts.join(' ');
}
