import type { BudgetAlert } from '@wallet/shared';

/** The most urgent first: over budget, then warning, then on track. */
const RANK: Record<BudgetAlert, number> = { over: 0, warning: 1, ok: 2 };

/**
 * The budgets of a month with the ones that need attention first: over budget, then in warning,
 * then the rest. Within a state the API's order (the user's own order of budgets) is kept. The state
 * of each line is the API's `alert`; nothing is worked out here. Returns a new array.
 */
export function sortByAlert<T extends { alert: BudgetAlert }>(lines: readonly T[]): T[] {
  return lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => RANK[a.line.alert] - RANK[b.line.alert] || a.index - b.index)
    .map(({ line }) => line);
}
