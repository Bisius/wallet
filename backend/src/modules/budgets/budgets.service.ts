import type {
  BudgetArchiveInput,
  BudgetCreateInput,
  BudgetDto,
  BudgetUpdateInput,
  BudgetVersionDto,
  BudgetVersionInput,
  Cents,
  IsoDate,
  MonthKey,
} from '@wallet/shared';
import { asc, eq, inArray, max, min, or } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { budgetTransfers, budgetVersions, budgets, spendings } from '../../db/schema';
import { type Deps, inTransaction } from '../../lib/deps';
import { hasHistory, notFound, ruleViolation } from '../../lib/errors';
import { currentMonthOf, monthOfDate, timestampOf } from '../../lib/today';
import {
  currentRow,
  firstRowRedate,
  isWithinActiveMonths,
  lifecycleStatus,
} from '../../lib/versioned';
import { requireSettings } from '../settings/settings.service';

type BudgetRow = typeof budgets.$inferSelect;
type VersionRow = typeof budgetVersions.$inferSelect;

/** New budgets are spaced like this so they can be reordered later by patching `sortOrder`. */
const SORT_ORDER_STEP = 10;
/** The largest `sortOrder` the contract accepts (`sortOrderSchema`). */
const SORT_ORDER_MAX = 1_000_000;

// -------------------------------------------------------------------------------------------------
// Reading
// -------------------------------------------------------------------------------------------------

const toVersionDto = (row: VersionRow): BudgetVersionDto => ({
  effectiveMonth: row.effectiveMonth,
  amount: row.amount,
  incremental: row.incremental,
});

/** Ids (among `ids`, or of all budgets) that have at least one spending or transfer. */
function idsWithHistory(db: DbOrTx, ids?: readonly number[]): Set<number> {
  const only = ids ? [...ids] : null;
  const found = new Set<number>();

  const spent = db
    .selectDistinct({ id: spendings.budgetId })
    .from(spendings)
    .where(only ? inArray(spendings.budgetId, only) : undefined)
    .all();
  for (const { id } of spent) found.add(id);

  for (const column of [budgetTransfers.fromBudgetId, budgetTransfers.toBudgetId]) {
    const moved = db
      .selectDistinct({ id: column })
      .from(budgetTransfers)
      .where(only ? inArray(column, only) : undefined)
      .all();
    for (const { id } of moved) if (id !== null) found.add(id);
  }
  return found;
}

/** The earliest and latest date of the budget's spendings and transfers (null when it has none). */
function activityDates(
  db: DbOrTx,
  budgetId: number,
): { first: IsoDate | null; last: IsoDate | null } {
  const spent = db
    .select({ first: min(spendings.date), last: max(spendings.date) })
    .from(spendings)
    .where(eq(spendings.budgetId, budgetId))
    .get();
  const moved = db
    .select({ first: min(budgetTransfers.date), last: max(budgetTransfers.date) })
    .from(budgetTransfers)
    .where(or(eq(budgetTransfers.fromBudgetId, budgetId), eq(budgetTransfers.toBudgetId, budgetId)))
    .get();

  const firsts = [spent?.first, moved?.first].filter((date): date is IsoDate => !!date);
  const lasts = [spent?.last, moved?.last].filter((date): date is IsoDate => !!date);
  return {
    first: firsts.length ? firsts.reduce((a, b) => (a < b ? a : b)) : null,
    last: lasts.length ? lasts.reduce((a, b) => (a > b ? a : b)) : null,
  };
}

/**
 * Budgets as DTOs, ascending by `sortOrder` then id: all of them, or only `ids`. Computed fresh from
 * the stored rows, so a response always shows exactly what is stored.
 */
export function loadBudgetDtos({ db, clock }: Deps, ids?: readonly number[]): BudgetDto[] {
  if (ids && ids.length === 0) return [];
  const only = ids ? [...ids] : null;
  const currentMonth = currentMonthOf(clock);

  const rows = db
    .select()
    .from(budgets)
    .where(only ? inArray(budgets.id, only) : undefined)
    .orderBy(asc(budgets.sortOrder), asc(budgets.id))
    .all();
  const versionRows = db
    .select()
    .from(budgetVersions)
    .where(only ? inArray(budgetVersions.budgetId, only) : undefined)
    .orderBy(asc(budgetVersions.effectiveMonth))
    .all();
  const withHistory = idsWithHistory(db, ids);

  const versionsByBudget = new Map<number, BudgetVersionDto[]>();
  for (const row of versionRows) {
    const list = versionsByBudget.get(row.budgetId) ?? [];
    list.push(toVersionDto(row));
    versionsByBudget.set(row.budgetId, list);
  }

  return rows.map((row: BudgetRow): BudgetDto => {
    const versions = versionsByBudget.get(row.id) ?? [];
    return {
      id: row.id,
      name: row.name,
      color: row.color,
      icon: row.icon,
      sortOrder: row.sortOrder,
      startMonth: row.startMonth,
      endMonth: row.endMonth,
      alertWarnPercent: row.alertWarnPercent,
      notes: row.notes,
      versions,
      current: currentRow(versions, row.startMonth, row.endMonth, currentMonth),
      hasHistory: withHistory.has(row.id),
      status: lifecycleStatus(row.startMonth, row.endMonth, currentMonth),
    };
  });
}

/** One budget as a DTO, or 404. */
export function loadBudgetDto(deps: Deps, id: number): BudgetDto {
  const [dto] = loadBudgetDtos(deps, [id]);
  if (!dto) throw notFound('Budget');
  return dto;
}

function findBudget(db: DbOrTx, id: number): BudgetRow {
  const row = db.select().from(budgets).where(eq(budgets.id, id)).get();
  if (!row) throw notFound('Budget');
  return row;
}

function versionsOf(db: DbOrTx, budgetId: number): VersionRow[] {
  return db.select().from(budgetVersions).where(eq(budgetVersions.budgetId, budgetId)).all();
}

/** GET /api/budgets */
export function listBudgets(deps: Deps): BudgetDto[] {
  return loadBudgetDtos(deps);
}

// -------------------------------------------------------------------------------------------------
// Writing
// -------------------------------------------------------------------------------------------------

/** Where a budget created without a `sortOrder` goes: after the last one. */
function nextSortOrder(db: DbOrTx): number {
  const last = db
    .select({ v: max(budgets.sortOrder) })
    .from(budgets)
    .get()?.v;
  return last == null ? 0 : Math.min(last + SORT_ORDER_STEP, SORT_ORDER_MAX);
}

export interface NewBudget {
  name: string;
  amount: Cents;
  incremental: boolean;
  startMonth: MonthKey;
  color?: string | null | undefined;
  icon?: string | null | undefined;
  sortOrder?: number | undefined;
  alertWarnPercent?: number | null | undefined;
  notes?: string | null | undefined;
}

/**
 * Inserts a budget and its first version (effective exactly at `startMonth`) and returns its id.
 * Two statements: call it inside `inTransaction`. Rule checks are the caller's job.
 */
export function insertBudget({ db, clock }: Deps, input: NewBudget): number {
  const { id } = db
    .insert(budgets)
    .values({
      name: input.name,
      color: input.color ?? null,
      icon: input.icon ?? null,
      sortOrder: input.sortOrder ?? nextSortOrder(db),
      startMonth: input.startMonth,
      endMonth: null,
      alertWarnPercent: input.alertWarnPercent ?? null,
      notes: input.notes ?? null,
      createdAt: timestampOf(clock),
    })
    .returning({ id: budgets.id })
    .get();
  db.insert(budgetVersions)
    .values({
      budgetId: id,
      effectiveMonth: input.startMonth,
      amount: input.amount,
      incremental: input.incremental,
    })
    .run();
  return id;
}

/** POST /api/budgets: the budget and its first version, effective from `startMonth`. */
export function createBudget(deps: Deps, input: BudgetCreateInput): BudgetDto {
  return inTransaction(deps, (tx) => {
    const floor = requireSettings(tx.db).startMonth;
    const startMonth = input.startMonth ?? currentMonthOf(tx.clock);
    if (startMonth < floor) {
      throw ruleViolation(
        'before_start_month',
        `A budget cannot start in ${startMonth}, before the start month ${floor}`,
        'startMonth',
      );
    }
    const id = insertBudget(tx, { ...input, startMonth });
    return loadBudgetDto(tx, id);
  });
}

/**
 * Moves a budget's `startMonth` to `newStart` after checking the rules (in this order:
 * `before_start_month`, `end_before_start`, `start_after_activity`). No version is deleted: moving
 * the start EARLIER than the first version re-dates that version to the new start, so a version is
 * in effect at the start month, and moving it later changes no version (a version dated before the
 * start month may be the one in effect at it; docs/DOMAIN.md, "Versioned values").
 */
function moveStartMonth({ db }: Deps, budget: BudgetRow, newStart: MonthKey): void {
  const floor = requireSettings(db).startMonth;
  if (newStart < floor) {
    throw ruleViolation(
      'before_start_month',
      `A budget cannot start in ${newStart}, before the start month ${floor}`,
      'startMonth',
    );
  }
  if (budget.endMonth !== null && newStart > budget.endMonth) {
    throw ruleViolation(
      'end_before_start',
      `The start month ${newStart} is after the budget's end month ${budget.endMonth}`,
      'startMonth',
    );
  }
  const { first } = activityDates(db, budget.id);
  if (first !== null && newStart > monthOfDate(first)) {
    throw ruleViolation(
      'start_after_activity',
      `The start month ${newStart} is after the budget's earliest spending or transfer (${first})`,
      'startMonth',
    );
  }

  const redate = firstRowRedate(versionsOf(db, budget.id), newStart);
  if (redate) {
    db.update(budgetVersions)
      .set({ effectiveMonth: redate.to })
      .where(eq(budgetVersions.id, redate.id))
      .run();
  }
}

/** PATCH /api/budgets/:id. Amount and mode are not here: they are versions. */
export function updateBudget(deps: Deps, id: number, input: BudgetUpdateInput): BudgetDto {
  return inTransaction(deps, (tx) => {
    const budget = findBudget(tx.db, id);
    if (input.startMonth !== undefined) moveStartMonth(tx, budget, input.startMonth);
    tx.db.update(budgets).set(input).where(eq(budgets.id, id)).run();
    return loadBudgetDto(tx, id);
  });
}

/** PUT /api/budgets/:id/versions/:month: upserts the amount and mode effective from `month`. */
export function upsertBudgetVersion(
  deps: Deps,
  id: number,
  month: MonthKey,
  input: BudgetVersionInput,
): BudgetDto {
  const budget = findBudget(deps.db, id);
  if (!isWithinActiveMonths(budget.startMonth, budget.endMonth, month)) {
    throw ruleViolation(
      'outside_active_months',
      `${month} is outside the budget's active months ` +
        `(${budget.startMonth} to ${budget.endMonth ?? 'no end'})`,
      'month',
    );
  }
  deps.db
    .insert(budgetVersions)
    .values({
      budgetId: id,
      effectiveMonth: month,
      amount: input.amount,
      incremental: input.incremental,
    })
    .onConflictDoUpdate({
      target: [budgetVersions.budgetId, budgetVersions.effectiveMonth],
      set: { amount: input.amount, incremental: input.incremental },
    })
    .run();
  return loadBudgetDto(deps, id);
}

/**
 * POST /api/budgets/:id/archive: `endMonth` (default: the current month) becomes the last active
 * month. Archiving again moves the end month, earlier or later. No version is deleted: those
 * effective after the end month are inert (only the active months are ever computed) and apply
 * again if the end month moves later (docs/DOMAIN.md, "Versioned values").
 */
export function archiveBudget(deps: Deps, id: number, input: BudgetArchiveInput): BudgetDto {
  return inTransaction(deps, (tx) => {
    const budget = findBudget(tx.db, id);
    const endMonth = input.endMonth ?? currentMonthOf(tx.clock);
    if (endMonth < budget.startMonth) {
      throw ruleViolation(
        'end_before_start',
        `The end month ${endMonth} is before the budget's start month ${budget.startMonth}`,
        'endMonth',
      );
    }
    const { last } = activityDates(tx.db, id);
    if (last !== null && endMonth < monthOfDate(last)) {
      throw ruleViolation(
        'end_before_activity',
        `The end month ${endMonth} is before the budget's latest spending or transfer (${last})`,
        'endMonth',
      );
    }

    tx.db.update(budgets).set({ endMonth }).where(eq(budgets.id, id)).run();
    return loadBudgetDto(tx, id);
  });
}

/** DELETE /api/budgets/:id: only a budget without spendings or transfers; its versions go with it. */
export function deleteBudget(deps: Deps, id: number): void {
  inTransaction(deps, ({ db }) => {
    findBudget(db, id);
    if (idsWithHistory(db, [id]).has(id)) throw hasHistory('This budget');
    db.delete(budgets).where(eq(budgets.id, id)).run();
  });
}
