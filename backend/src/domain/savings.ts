/**
 * The savings rules of docs/DOMAIN.md as PURE functions: the "move to savings" list of a ledger and
 * the figures of a goal. Nothing here reads a clock, a database or the environment, and nothing
 * about outstanding amounts or goal progress is stored: it is all derived from the ledger, the
 * sums `loadSavingsFacts` reads (savings-facts.ts) and the current month.
 *
 * All the arithmetic is exact integer arithmetic: `ceilDiv` for the monthly amount a goal needs,
 * and BigInt for the progress percentage (`100 * balance` could leave the safe-integer range for
 * absurd sums, and a float quotient is never used).
 */
import {
  type Cents,
  type GoalDto,
  type GoalStatus,
  type IsoDate,
  type MonthKey,
  type OutstandingMonthDto,
  ceilDiv,
  monthDiff,
} from '@wallet/shared';
import type { Ledger, LedgerMonth } from './ledger';
import type { SettlementFact } from './savings-facts';

// -------------------------------------------------------------------------------------------------
// Outstanding months ("move to savings")
// -------------------------------------------------------------------------------------------------

/**
 * The month's entry of the "move to savings" list, or null when its outstanding is 0 (settled
 * exactly, or nothing was due: such a month is not listed):
 *
 *   outstanding(M) = savingsDue(M) - settled(M)
 *
 * `settlement` is the month's `settlement` rows (undefined: none). `adjustment` is whether it has
 * any: the month was settled before and later edits moved its `savingsDue`, so what is outstanding
 * corrects the earlier settlement. It is normally the same as `settled !== 0` and differs only when
 * earlier settlements netted to 0.
 */
export function outstandingOf(
  row: LedgerMonth,
  settlement: SettlementFact | undefined,
): OutstandingMonthDto | null {
  const savingsDue = row.savingsDue.total;
  const settled = settlement?.settled ?? 0;
  const outstanding = savingsDue - settled;
  if (outstanding === 0) return null;

  const { unallocated, budgetsSettled, reservesReleased } = row.savingsDue;
  return {
    month: row.month,
    savingsDue,
    settled,
    outstanding,
    direction: outstanding > 0 ? 'move' : 'take',
    breakdown: { unallocated, budgetsSettled, reservesReleased },
    adjustment: (settlement?.rows ?? 0) > 0,
  };
}

/**
 * The `GET /api/savings` list: one entry for every CLOSED month of the ledger whose outstanding is
 * not 0, ascending by month. A settlement of a month that is not closed (the server clock moved
 * backwards) is not looked at here: it only counts in the balances.
 */
export function outstandingMonths(
  ledger: Ledger,
  settlements: ReadonlyMap<MonthKey, SettlementFact>,
): OutstandingMonthDto[] {
  const list: OutstandingMonthDto[] = [];
  for (const row of ledger.months) {
    if (row.status !== 'closed') continue;
    const entry = outstandingOf(row, settlements.get(row.month));
    if (entry) list.push(entry);
  }
  return list;
}

// -------------------------------------------------------------------------------------------------
// Goals
// -------------------------------------------------------------------------------------------------

/** What a goal row stores: everything in `GoalDto` that is not derived. */
export interface GoalFacts {
  id: number;
  name: string;
  targetAmount: Cents;
  deadline: IsoDate | null;
  color: string | null;
  archived: boolean;
}

/**
 * `max(0, floor(100 * balance / target))`, not capped (150 means 50% over). It rounds down on
 * purpose, so a displayed 100 always means reached. `target` is positive.
 */
export function progressPercentOf(balance: Cents, target: Cents): number {
  if (balance <= 0) return 0;
  return Number((100n * BigInt(balance)) / BigInt(target));
}

/**
 * The months a goal with a deadline has to save in: from the current month to the deadline's
 * month, both included, and at least 1. Once the deadline's month has passed it stays at 1.
 */
export function monthsLeftFor(deadline: IsoDate, currentMonth: MonthKey): number {
  return Math.max(1, monthDiff(currentMonth, deadline.slice(0, 7)) + 1);
}

/**
 * A goal's `GoalDto`, derived from its row, its balance (the sum of its savings transactions,
 * which can be negative) and the current month:
 *
 *   remaining     = max(0, target - balance)
 *   reached       = balance >= target
 *   status        = archived, else reached, else overdue (the deadline's month is before the
 *                   current month), else active
 *   monthlyNeeded = ceilDiv(remaining, monthsLeft), for an active or an overdue goal with a deadline
 */
export function goalFigures(goal: GoalFacts, balance: Cents, currentMonth: MonthKey): GoalDto {
  const remaining = Math.max(0, goal.targetAmount - balance);
  const reached = balance >= goal.targetAmount;
  const overdue = goal.deadline !== null && goal.deadline.slice(0, 7) < currentMonth;
  const status: GoalStatus = goal.archived
    ? 'archived'
    : reached
      ? 'reached'
      : overdue
        ? 'overdue'
        : 'active';
  const monthlyNeeded =
    goal.deadline !== null && (status === 'active' || status === 'overdue')
      ? ceilDiv(remaining, monthsLeftFor(goal.deadline, currentMonth))
      : null;

  return {
    id: goal.id,
    name: goal.name,
    targetAmount: goal.targetAmount,
    deadline: goal.deadline,
    color: goal.color,
    archived: goal.archived,
    balance,
    progressPercent: progressPercentOf(balance, goal.targetAmount),
    remaining,
    reached,
    monthlyNeeded,
    status,
  };
}
