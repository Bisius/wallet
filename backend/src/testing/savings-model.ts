/**
 * An independent model of the Phase 4 savings rules, written from docs/DOMAIN.md alone ("Savings",
 * "Settling a month", "Manual money", "Opening balance", "Goals", "Start month" and invariants 6
 * and 7), for the operation fuzz (`savings-fuzz.ts`) and the Phase 4 stories.
 *
 * It shares no code with `domain/savings.ts`, `domain/ledger.ts` or the helpers of `@wallet/shared`
 * (only TYPES are imported). The savings due of each closed month comes from the Phase 2 model
 * (`prop-model.ts`, itself written from the doc), so the two models stack: this file adds what the
 * Phase 4 section of the doc says on top. The arithmetic is plain loops over rows, with BigInt for
 * the sums and for the two divisions, so it is exact whatever the amounts.
 *
 * The model has no I/O. A `World` is the whole state (today, the facts the ledger works from, the
 * goals and every savings row). `predict*` says what the doc demands of one request: the refusal
 * (status, code, rule, field) when a rule is broken, checked IN THE ORDER the doc lists, or the rows
 * the request must store. The caller applies the effect once the server has answered (the ids of new
 * rows come from the server). `savings-model.test.ts` pins the model to the worked examples of the
 * doc, so a disagreement with the API can be read as the API's.
 */
import type {
  GoalDto,
  MonthView,
  OutstandingMonthDto,
  Page,
  SavingsDto,
  SavingsOpeningDto,
  SavingsTransactionDto,
} from '@wallet/shared';
import type { Facts } from '../domain/facts';
import { modelLedger, monthIndex, monthKey } from './prop-model';

/** "Projections stop 120 months after the current month: a month ... beyond that horizon does not exist (404)." */
export const HORIZON_MONTHS = 120;

/** "MAX_START_MONTH_AGE_MONTHS (240, that is 20 years)". */
export const MAX_START_AGE_MONTHS = 240;

/** A savings row exactly as the API shows it. */
export type ModelRow = SavingsTransactionDto;

export interface ModelGoal {
  id: number;
  name: string;
  targetAmount: number;
  /** A date, of which only the month counts. */
  deadline: string | null;
  color: string | null;
  archived: boolean;
}

/** The whole state the savings rules depend on. `facts.startMonth` is `settings.startMonth`. */
export interface World {
  /** `YYYY-MM-DD`, from the clock in the server's time zone. */
  today: string;
  facts: Facts;
  /** In creation order. */
  goals: ModelGoal[];
  rows: ModelRow[];
}

// -------------------------------------------------------------------------------------------------
// Small exact helpers
// -------------------------------------------------------------------------------------------------

function toNumber(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`savings model: ${value} is not a safe integer`);
  return n;
}

/** The exact sum of `amount` over `items`. */
export const sumOf = (items: readonly { amount: number }[]): number =>
  toNumber(items.reduce((total, item) => total + BigInt(item.amount), 0n));

export const monthOf = (date: string): string => date.slice(0, 7);
export const currentMonthOf = (world: World): string => monthOf(world.today);
const firstDayOf = (month: string): string => `${month}-01`;

/** The months a request may name: `startMonth` to 120 months after the current month. */
export function isTrackedMonth(world: World, month: string): boolean {
  return (
    monthIndex(month) >= monthIndex(world.facts.startMonth) &&
    monthIndex(month) <= monthIndex(currentMonthOf(world)) + HORIZON_MONTHS
  );
}

// -------------------------------------------------------------------------------------------------
// Balances
// -------------------------------------------------------------------------------------------------

/** "goalBalance(G) = sum of the rows with goalId = G; unassigned = sum of the rows with goalId null." */
export const balanceOf = (world: World, goalId: number | null): number =>
  sumOf(world.rows.filter((row) => row.goalId === goalId));

/** "savingsBalance = sum of all savings_transactions". */
export const totalBalance = (world: World): number => sumOf(world.rows);

// -------------------------------------------------------------------------------------------------
// Goals
// -------------------------------------------------------------------------------------------------

/**
 * The figures of a goal ("Goals"):
 *
 *     progressPercent = max(0, floor(100 x balance / targetAmount))
 *     remaining       = max(0, targetAmount - balance)
 *     reached         = balance >= targetAmount
 *     monthsLeft      = max(1, monthDiff(current month, deadlineMonth) + 1)
 *     monthlyNeeded   = ceilDiv(remaining, monthsLeft)   (null without a deadline, once reached, archived)
 *     status          = the first that applies: archived, reached, overdue, active
 */
export function goalFigures(goal: ModelGoal, balance: number, currentMonth: string): GoalDto {
  const target = BigInt(goal.targetAmount);
  const held = BigInt(balance);
  const reached = held >= target;
  const remaining = reached ? 0n : target - held;
  const progress = held <= 0n ? 0n : (100n * held) / target;

  const deadlineMonth = goal.deadline === null ? null : monthOf(goal.deadline);
  // "overdue (it has a deadline and the deadline's month is before the current month)"
  const overdue = deadlineMonth !== null && monthIndex(deadlineMonth) < monthIndex(currentMonth);
  const status = goal.archived ? 'archived' : reached ? 'reached' : overdue ? 'overdue' : 'active';

  let monthlyNeeded: number | null = null;
  if (deadlineMonth !== null && (status === 'active' || status === 'overdue')) {
    // "the current month and the deadline's month both count" and "stays at 1" once it has passed.
    const monthsLeft = BigInt(
      Math.max(1, monthIndex(deadlineMonth) - monthIndex(currentMonth) + 1),
    );
    monthlyNeeded = toNumber((remaining + monthsLeft - 1n) / monthsLeft); // ceilDiv, remaining >= 0
  }
  return {
    id: goal.id,
    name: goal.name,
    targetAmount: goal.targetAmount,
    deadline: goal.deadline,
    color: goal.color,
    archived: goal.archived,
    balance,
    progressPercent: toNumber(progress),
    remaining: toNumber(remaining),
    reached,
    monthlyNeeded,
    status,
  };
}

/** `GET /api/goals`: "archived goals last, each group in creation order". */
export function expectedGoals(world: World): GoalDto[] {
  const current = currentMonthOf(world);
  const figures = (goal: ModelGoal) => goalFigures(goal, balanceOf(world, goal.id), current);
  return [
    ...world.goals.filter((goal) => !goal.archived).map(figures),
    ...world.goals.filter((goal) => goal.archived).map(figures),
  ];
}

// -------------------------------------------------------------------------------------------------
// Savings due and the outstanding months
// -------------------------------------------------------------------------------------------------

/** The three lines of a month's savings due, and their sum. */
export type DueLines = MonthView['savingsDue'];

/**
 * `savingsDue` of every closed month, `startMonth <= M < current month`, ascending. It is the Phase 2
 * model's figure for each month ("savingsDue(M) = unallocated(M) + sum of remaining of budgets
 * settled to savings in M + sum of subscription reserves released in M").
 */
export function dueByMonth(world: World): Map<string, DueLines> {
  // A run asks for the same figures many times between two edits: remember the last answer. The key
  // is the whole input (facts and current month), so the memo can never be stale.
  const key = `${currentMonthOf(world)}|${JSON.stringify(world.facts)}`;
  if (memo?.key === key) return memo.due;
  const due = new Map<string, DueLines>();
  const last = monthIndex(currentMonthOf(world)) - 1;
  if (last >= monthIndex(world.facts.startMonth)) {
    for (const { view } of modelLedger(world.facts, monthKey(last), world.today)) {
      due.set(view.month, view.savingsDue);
    }
  }
  memo = { key, due };
  return due;
}

let memo: { key: string; due: Map<string, DueLines> } | undefined;

/** "settled(M) = sum of the savings_transactions with kind settlement and settlesMonth = M". */
export const settlementRowsOf = (world: World, month: string): ModelRow[] =>
  world.rows.filter((row) => row.kind === 'settlement' && row.settlesMonth === month);

/**
 * "outstanding(M) = savingsDue(M) - settled(M)" for a closed, tracked month; undefined for any other
 * month (a settlement row of a month that is not closed counts in the balances only).
 */
export function outstandingOf(world: World, month: string): number | undefined {
  const due = dueByMonth(world).get(month);
  return due === undefined ? undefined : due.total - sumOf(settlementRowsOf(world, month));
}

/** "the list has one entry for every closed month whose outstanding is not 0, ascending by month". */
export function outstandingList(world: World): OutstandingMonthDto[] {
  const list: OutstandingMonthDto[] = [];
  for (const [month, due] of dueByMonth(world)) {
    const rows = settlementRowsOf(world, month);
    const settled = sumOf(rows);
    const outstanding = due.total - settled;
    if (outstanding === 0) continue;
    list.push({
      month,
      savingsDue: due.total,
      settled,
      outstanding,
      direction: outstanding > 0 ? 'move' : 'take',
      breakdown: {
        unallocated: due.unallocated,
        budgetsSettled: due.budgetsSettled,
        reservesReleased: due.reservesReleased,
      },
      // "adjustment is true when M has at least one settlement row"
      adjustment: rows.length > 0,
    });
  }
  return list;
}

/** `GET /api/savings`. */
export function expectedSavings(world: World): SavingsDto {
  const outstanding = outstandingList(world);
  return {
    balance: totalBalance(world),
    unassigned: balanceOf(world, null),
    goals: expectedGoals(world),
    outstanding,
    outstandingTotal: sumOf(outstanding.map((entry) => ({ amount: entry.outstanding }))),
  };
}

/** `GET /api/savings/opening`: the amount of the `opening` row (0 without one), dated the 1st of the start month. */
export function expectedOpening(world: World): SavingsOpeningDto {
  const row = world.rows.find((candidate) => candidate.kind === 'opening');
  return { amount: row?.amount ?? 0, date: firstDayOf(world.facts.startMonth) };
}

export interface TransactionQuery {
  goalId?: number;
  unassigned?: boolean;
  kind?: ModelRow['kind'];
  limit: number;
  offset: number;
}

/** `GET /api/savings/transactions`: "newest first (date, then id, descending), as a Page", filters AND-ed. */
export function expectedPage(world: World, query: TransactionQuery): Page<ModelRow> {
  const matching = world.rows
    .filter(
      (row) =>
        (query.goalId === undefined || row.goalId === query.goalId) &&
        (query.unassigned !== true || row.goalId === null) &&
        (query.kind === undefined || row.kind === query.kind),
    )
    .sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1));
  return {
    items: matching.slice(query.offset, query.offset + query.limit),
    total: matching.length,
    limit: query.limit,
    offset: query.offset,
  };
}

// -------------------------------------------------------------------------------------------------
// What the doc demands of a request
// -------------------------------------------------------------------------------------------------

/** A refused request: the status, the `error.code`, and for a 422 the rule and the field it names. */
export interface Refusal {
  status: 400 | 404 | 409 | 422;
  code:
    | 'validation_error'
    | 'not_found'
    | 'nothing_to_settle'
    | 'outstanding_changed'
    | 'not_deletable'
    | 'rule_violation';
  rule?: string;
  field?: string;
  details?: unknown;
}

export type Verdict<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

const accept = <T>(value: T): Verdict<T> => ({ ok: true, value });
const refuse = (refusal: Refusal): Verdict<never> => ({ ok: false, refusal });
const invalid = (): Verdict<never> => refuse({ status: 400, code: 'validation_error' });
const missing = (): Verdict<never> => refuse({ status: 404, code: 'not_found' });
const violation = (rule: string, field: string): Verdict<never> =>
  refuse({ status: 422, code: 'rule_violation', rule, field });

/** What a stored row looks like before the server gives it an id (and a `groupId` to a reallocation). */
export type NewRow = Omit<ModelRow, 'id' | 'groupId'>;

// --- Settling a month ----------------------------------------------------------------------------

export interface SettleBody {
  amount: number;
  allocations?: { goalId: number | null; amount: number }[];
}

/**
 * `POST /api/savings/settle/:month`. "A request that is not well formed" comes first (400): the
 * amounts are never 0, there is at least one allocation, and no goal (nor unassigned) appears twice.
 * Then the doc's order: 1. the month exists (404) and is closed (422 `month_not_closed`, field
 * "month"); 2. its outstanding is not 0 (409 `nothing_to_settle`); 3. `amount` equals the outstanding
 * (409 `outstanding_changed`, details `{ month, outstanding }`); 4. the allocations have the sign of
 * the amount and add up to it (422 `allocation_mismatch`, field "allocations"), and every goal exists
 * and is not archived (422 `unknown_goal` / `goal_archived`, field "allocations.<i>.goalId", the
 * first offending allocation decides).
 */
export function predictSettle(world: World, month: string, body: SettleBody): Verdict<NewRow[]> {
  if (body.amount === 0) return invalid();
  if (body.allocations !== undefined) {
    if (body.allocations.length === 0) return invalid();
    if (body.allocations.some((allocation) => allocation.amount === 0)) return invalid();
    const places = new Set<number | null>();
    for (const { goalId } of body.allocations) {
      if (places.has(goalId)) return invalid(); // "No goal appears twice (400)"
      places.add(goalId);
    }
  }

  if (!isTrackedMonth(world, month)) return missing();
  if (monthIndex(month) >= monthIndex(currentMonthOf(world))) {
    return violation('month_not_closed', 'month');
  }
  const outstanding = outstandingOf(world, month);
  if (outstanding === undefined) throw new Error(`savings model: no savings due for ${month}`);
  if (outstanding === 0) return refuse({ status: 409, code: 'nothing_to_settle' });
  if (body.amount !== outstanding) {
    return refuse({
      status: 409,
      code: 'outstanding_changed',
      details: { month, outstanding },
    });
  }

  // "Omitted allocations mean one allocation of the whole amount to unassigned savings."
  const allocations = body.allocations ?? [{ goalId: null, amount: body.amount }];
  const sign = Math.sign(body.amount);
  if (
    allocations.some((allocation) => Math.sign(allocation.amount) !== sign) ||
    sumOf(allocations) !== body.amount
  ) {
    return violation('allocation_mismatch', 'allocations');
  }
  for (const [index, { goalId }] of allocations.entries()) {
    if (goalId === null) continue;
    const goal = world.goals.find((candidate) => candidate.id === goalId);
    if (!goal) return violation('unknown_goal', `allocations.${index}.goalId`);
    if (goal.archived) return violation('goal_archived', `allocations.${index}.goalId`);
  }
  return accept(
    allocations.map(({ goalId, amount }) => ({
      date: world.today, // "dated today (the server clock)"
      kind: 'settlement' as const,
      amount,
      goalId,
      settlesMonth: month,
      note: null, // "with no note"
    })),
  );
}

/** `DELETE /api/savings/settle/:month`: "204, or 404 when M has none". */
export function predictUndo(world: World, month: string): Verdict<number[]> {
  const rows = settlementRowsOf(world, month);
  return rows.length === 0 ? missing() : accept(rows.map((row) => row.id));
}

// --- Manual money --------------------------------------------------------------------------------

interface ManualCommon {
  amount: number;
  date?: string;
  note?: string | null;
}

export type ManualBody =
  | (ManualCommon & { kind: 'deposit'; goalId?: number | null })
  | (ManualCommon & { kind: 'withdrawal'; goalId?: number | null })
  | (ManualCommon & { kind: 'reallocation'; fromGoalId: number | null; toGoalId: number | null });

/** "Free text ... Blank becomes null" (trimmed). */
export const normalizeNote = (note: string | null | undefined): string | null => {
  const trimmed = (note ?? '').trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * `POST /api/savings/transactions`. Not well formed (400): `amount` is positive, and a reallocation's
 * two places differ. Then "the checks run in this order: date, goals (for a reallocation:
 * `fromGoalId` exists, `toGoalId` exists, `toGoalId` is not archived), balance": the date is not
 * before the first day of the start month (422 `before_start_month`) nor after today (422
 * `date_in_future`), field "date"; a goal must exist (422 `unknown_goal`) and, when money goes INTO
 * it, not be archived (422 `goal_archived`); a withdrawal or reallocation can't take more than its
 * source holds now (422 `insufficient_balance`, field "amount").
 */
export function predictManual(world: World, body: ManualBody): Verdict<NewRow[]> {
  if (!(body.amount > 0)) return invalid();
  if (body.kind === 'reallocation' && body.fromGoalId === body.toGoalId) return invalid();

  const date = body.date ?? world.today;
  const note = normalizeNote(body.note);
  if (monthIndex(monthOf(date)) < monthIndex(world.facts.startMonth)) {
    return violation('before_start_month', 'date');
  }
  if (date > world.today) return violation('date_in_future', 'date');

  const find = (goalId: number) => world.goals.find((goal) => goal.id === goalId);
  const row = (kind: ModelRow['kind'], amount: number, goalId: number | null): NewRow => ({
    date,
    kind,
    amount,
    goalId,
    settlesMonth: null,
    note,
  });

  if (body.kind === 'deposit') {
    const goalId = body.goalId ?? null;
    if (goalId !== null) {
      const goal = find(goalId);
      if (!goal) return violation('unknown_goal', 'goalId');
      if (goal.archived) return violation('goal_archived', 'goalId'); // "can't receive money"
    }
    return accept([row('deposit', body.amount, goalId)]);
  }

  if (body.kind === 'withdrawal') {
    const goalId = body.goalId ?? null;
    // An archived goal is a valid source: "the money left in an archived goal must never be frozen".
    if (goalId !== null && !find(goalId)) return violation('unknown_goal', 'goalId');
    if (balanceOf(world, goalId) < body.amount) return violation('insufficient_balance', 'amount');
    return accept([row('withdrawal', -body.amount, goalId)]);
  }

  const { fromGoalId, toGoalId } = body;
  if (fromGoalId !== null && !find(fromGoalId)) return violation('unknown_goal', 'fromGoalId');
  if (toGoalId !== null) {
    const destination = find(toGoalId);
    if (!destination) return violation('unknown_goal', 'toGoalId');
    if (destination.archived) return violation('goal_archived', 'toGoalId');
  }
  if (balanceOf(world, fromGoalId) < body.amount)
    return violation('insufficient_balance', 'amount');
  // "two rows with a shared groupId: -amount for fromGoalId, then +amount for toGoalId"
  return accept([
    row('reallocation', -body.amount, fromGoalId),
    row('reallocation', body.amount, toGoalId),
  ]);
}

/**
 * `DELETE /api/savings/transactions/:id`: an unknown id is 404; an `opening` or a `settlement` row is
 * 409 `not_deletable`; otherwise the row goes, with its partner when it is a reallocation ("both
 * rows, whichever row's id is given"). The value is the ids that go.
 */
export function predictDeleteRow(world: World, id: number): Verdict<number[]> {
  const row = world.rows.find((candidate) => candidate.id === id);
  if (!row) return missing();
  if (row.kind === 'opening' || row.kind === 'settlement') {
    return refuse({ status: 409, code: 'not_deletable' });
  }
  if (row.groupId === null) return accept([row.id]);
  return accept(
    world.rows.filter((other) => other.groupId === row.groupId).map((other) => other.id),
  );
}

// --- Goals ---------------------------------------------------------------------------------------

export interface GoalPatch {
  name?: string;
  targetAmount?: number;
  deadline?: string | null;
  color?: string | null;
  archived?: boolean;
}

/** "PATCH /api/goals/:id": 404 for an unknown id, otherwise the goal with the fields changed. */
export function predictGoalPatch(world: World, id: number, patch: GoalPatch): Verdict<ModelGoal> {
  const goal = world.goals.find((candidate) => candidate.id === id);
  if (!goal) return missing();
  return accept({
    ...goal,
    ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
    ...(patch.targetAmount === undefined ? {} : { targetAmount: patch.targetAmount }),
    ...(patch.deadline === undefined ? {} : { deadline: patch.deadline }),
    ...(patch.color === undefined
      ? {}
      : { color: patch.color === null ? null : patch.color.toLowerCase() }),
    ...(patch.archived === undefined ? {} : { archived: patch.archived }),
  });
}

/** "Deleting a goal moves its balance to unassigned savings (its rows get goalId null)." */
export function withoutGoal(world: World, id: number): void {
  world.goals = world.goals.filter((goal) => goal.id !== id);
  for (const row of world.rows) if (row.goalId === id) row.goalId = null;
}

// --- Start month ---------------------------------------------------------------------------------

/**
 * The earliest month of any fact ("a fact is anything with a date or an effective month: salary
 * changes, incomes, subscriptions (their start month), budgets (their start month), spendings,
 * transfers, and savings transactions other than opening"). A settlement has a date (the day it was
 * made) and a month it settles; both are read as the "date or effective month" the doc names, so a
 * settled month can't be left before the start.
 */
export function earliestFact(world: World): string | null {
  const { facts } = world;
  const months = [
    ...facts.salary.map((row) => row.effectiveMonth),
    ...facts.incomes.map((income) => income.month),
    ...facts.subscriptions.map((subscription) => subscription.startMonth),
    ...facts.budgets.map((budget) => budget.startMonth),
    ...facts.spendings.map((spending) => spending.month),
    ...facts.transfers.map((transfer) => transfer.month),
    ...world.rows.filter((row) => row.kind !== 'opening').map((row) => monthOf(row.date)),
    ...world.rows.flatMap((row) => (row.kind === 'settlement' ? [row.settlesMonth ?? ''] : [])),
  ].filter((month) => month !== '');
  return months.reduce<string | null>(
    (earliest, month) =>
      earliest === null || monthIndex(month) < monthIndex(earliest) ? month : earliest,
    null,
  );
}

/**
 * `PUT /api/settings` with a new `startMonth`: 422 `start_month_in_future` after the current month;
 * 422 `start_month_too_old` more than 240 months before it (only when the value changes); and
 * 422 `start_month_after_facts` when moving it LATER while a fact is dated before the new month.
 */
export function predictMoveStart(world: World, startMonth: string): Verdict<null> {
  const current = monthIndex(currentMonthOf(world));
  const old = monthIndex(world.facts.startMonth);
  const wanted = monthIndex(startMonth);
  if (wanted > current) return violation('start_month_in_future', 'startMonth');
  if (wanted !== old && current - wanted > MAX_START_AGE_MONTHS) {
    return violation('start_month_too_old', 'startMonth');
  }
  if (wanted > old) {
    const earliest = earliestFact(world);
    if (earliest !== null && monthIndex(earliest) < wanted) {
      return violation('start_month_after_facts', 'startMonth');
    }
  }
  return accept(null);
}

/** "The opening transaction follows startMonth: its date is the 1st of that month, its amount does not change." */
export function moveStart(world: World, startMonth: string): void {
  world.facts.startMonth = startMonth;
  for (const row of world.rows) if (row.kind === 'opening') row.date = firstDayOf(startMonth);
}
