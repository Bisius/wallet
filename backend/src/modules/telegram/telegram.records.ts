/**
 * What the bot does to the books, as plain functions over `(tg, input)`: the one place where the
 * conversations and the buttons touch the services (docs/DOMAIN.md, "It adds no money rule").
 *
 * - Every write goes through the same service as the HTTP endpoint (`createSpending`,
 *   `updateSpending`, `deleteSpending`, `createIncome`, `updateIncome`, `deleteIncome`), after the
 *   same zod schema the route parses with, so the bot can never store what the API would refuse with
 *   a 400, and every 422 rule applies unchanged. A write that creates something also records it in
 *   `telegram_entries`, in the same transaction.
 * - Every figure is read from `getMonthView` AFTER the write, and handed to the message builders as
 *   the fields of the month view. Nothing here computes a balance, a percentage or a carry-over.
 * - "Today" and the current month come from `tg.clock` (`lib/today.ts`), never from Telegram.
 */
import {
  type IsoDate,
  type MonthBudgetLine,
  type MonthKey,
  type MonthView,
  type RuleViolationDetails,
  addMonths,
  incomeCreateSchema,
  incomeUpdateSchema,
  spendingCreateSchema,
  spendingUpdateSchema,
} from '@wallet/shared';
import { inTransaction } from '../../lib/deps';
import { HttpError } from '../../lib/errors';
import { currentMonthOf, todayOf } from '../../lib/today';
import { loadBudgets, loadSuggester } from '../import/import.context';
import { normalizeText } from '../import/import.file';
import { createIncome, deleteIncome, updateIncome } from '../incomes/incomes.service';
import { getMonthView } from '../months/months.service';
import { requireSettings } from '../settings/settings.service';
import { createSpending, deleteSpending, updateSpending } from '../spendings/spendings.service';
import {
  type EntryRef,
  type StoredIncome,
  type StoredSpending,
  findIncome,
  findSpending,
  recordEntry,
} from './telegram.entries';
import type { MessageFormat } from './telegram.format';
import type { IncomeFigures } from './telegram.messages';
import type { TelegramContext } from './telegram.types';

/** The settings the messages need: how to format, and the first month Wallet tracks. */
export interface BotSettings extends MessageFormat {
  startMonth: MonthKey;
}

/** The settings, or a 409 `not_onboarded` (the handlers answer "Finish setting up Wallet"). */
export function botSettings(tg: TelegramContext): BotSettings {
  const { currency, locale, startMonth } = requireSettings(tg.db);
  return { currency, locale, startMonth };
}

/** Today from the clock (the server's time zone), and its month. */
export function todayNow(tg: TelegramContext): { date: IsoDate; month: MonthKey } {
  return { date: todayOf(tg.clock), month: currentMonthOf(tg.clock) };
}

/** A month before the current one is closed (docs/DOMAIN.md, "Month states"). */
export const isClosedMonth = (tg: TelegramContext, month: MonthKey): boolean =>
  month < currentMonthOf(tg.clock);

// --- Reading ----------------------------------------------------------------------------------

/**
 * The month view, or null when it cannot be read. It is read after a write that already happened,
 * so a failure must not look like a failed write: the message goes out without its figure, and the
 * problem is logged.
 */
export function readMonth(tg: TelegramContext, month: MonthKey): MonthView | null {
  try {
    return getMonthView(tg, month);
  } catch (error) {
    tg.log.error(`could not read the month view of ${month}`, error);
    return null;
  }
}

/** The budgets active in the current month, in the month view's order (`sortOrder`, then id). */
export function activeBudgets(tg: TelegramContext): { month: MonthKey; lines: MonthBudgetLine[] } {
  const month = currentMonthOf(tg.clock);
  return { month, lines: getMonthView(tg, month).budgets };
}

/**
 * The budget the import would suggest for `note` (docs/DOMAIN.md, "Suggested budget"): the one most
 * used by the stored spendings with the same normalized description, if it is active in `month`.
 * null with no note or no suggestion.
 */
export function suggestedBudgetId(
  tg: TelegramContext,
  note: string,
  month: MonthKey,
): number | null {
  if (note === '') return null;
  return loadSuggester(tg.db, loadBudgets(tg.db)).suggest(normalizeText(note), month);
}

/** The name of a budget now, whatever its months (a spending can sit outside them only by edits of the past). */
export function budgetName(tg: TelegramContext, budgetId: number): string {
  return loadBudgets(tg.db).get(budgetId)?.name ?? 'Unknown budget';
}

/**
 * Whether a budget line carries its `remaining` into the next month (docs/DOMAIN.md, "Budgets": an
 * incremental budget in a month that is not its `endMonth`), as opposed to settling it with savings.
 * It reads the line's own `incremental` and `endsThisMonth`, the fields that rule is written on.
 */
export const carriesOn = (line: MonthBudgetLine | null): boolean =>
  line !== null && line.incremental && !line.endsThisMonth;

/**
 * The longest carry the bot follows month by month: 5 years. Every step reads one month view, and an
 * entry that old is reachable only through an old button. Past it the carry is taken to reach the
 * current month, which is what happens whenever the budget keeps carrying.
 */
export const CARRY_WALK_MAX_MONTHS = 60;

/** Where an entry of a closed month whose budget carries on ends up. */
export interface CarryLanding {
  /** The first month after the entry's whose budget line does NOT carry, or the current month. */
  month: MonthKey;
  /**
   * true: `month` is a closed month where the carried money settles (the budget is not incremental
   * there, or it ends there, or it has no line), so ITS savings due move. false: the carry reaches
   * the current month, whose line changes (a month still in progress has no savings due yet).
   */
  settles: boolean;
  /** The budget's line of the settling month (null when it has none, and when `settles` is false). */
  line: MonthBudgetLine | null;
}

/**
 * Follows the carry of an entry in `from`, a closed month whose line carries (`carriesOn`): the carry
 * goes from month to month for as long as the budget's line of each month carries on, and stops at
 * the first one that does not, which is where the money settles (docs/DOMAIN.md, "Budgets": the
 * remainder of a month that does not carry goes to `toSavings`, so that month's `savingsDue` moves).
 * If every month up to the one before the current month carries, it reaches the current month.
 * Fields only: each step is the budget's line of that month's view.
 */
export function carryLanding(tg: TelegramContext, budgetId: number, from: MonthKey): CarryLanding {
  const current = currentMonthOf(tg.clock);
  let month = addMonths(from, 1);
  for (let step = 0; month < current && step < CARRY_WALK_MAX_MONTHS; step++) {
    const line = lineOf(readMonth(tg, month), budgetId);
    if (!carriesOn(line)) return { month, settles: true, line };
    month = addMonths(month, 1);
  }
  return { month: current, settles: false, line: null };
}

/** A closed month that an action touches, and which month's savings due the action moves. */
export interface ClosedMonth {
  month: MonthKey;
  /**
   * The closed month whose savings due the action moves: `month` itself where the budget settles
   * with savings (or for an income), a later closed month where a carry settles, and null where the
   * carry reaches the current month (nothing closed moves except what the budget carries forward).
   */
  settlesIn: MonthKey | null;
}

/**
 * The closed months among `months` (each once, ascending), each with where the effect settles, read
 * from the budget's lines of the month views. `budgetId` null is an income, which only ever moves
 * its own month's savings due. The clock decides what is closed, at the moment of the call.
 */
export function closedMonthsOf(
  tg: TelegramContext,
  months: readonly MonthKey[],
  budgetId: number | null,
): ClosedMonth[] {
  return [...new Set(months)]
    .filter((month) => isClosedMonth(tg, month))
    .sort()
    .map((month): ClosedMonth => {
      if (budgetId === null || !carriesOn(lineOf(readMonth(tg, month), budgetId))) {
        return { month, settlesIn: month };
      }
      const landing = carryLanding(tg, budgetId, month);
      return { month, settlesIn: landing.settles ? landing.month : null };
    });
}

/** The names of all budgets by id (for the lists that show spendings of any budget). */
export function budgetNames(tg: TelegramContext): ReadonlyMap<number, string> {
  return new Map([...loadBudgets(tg.db)].map(([id, budget]) => [id, budget.name]));
}

/** The budget's line in a month view, if the month has one. */
export const lineOf = (view: MonthView | null, budgetId: number): MonthBudgetLine | null =>
  view?.budgets.find((line) => line.id === budgetId) ?? null;

/** The income figures of a month view, as the message prints them. */
export const incomeFiguresOf = (view: MonthView | null): IncomeFigures | null =>
  view
    ? {
        total: view.income.total,
        unallocated: view.unallocated,
        overAllocated: view.overAllocated,
      }
    : null;

// --- Writing ----------------------------------------------------------------------------------

export interface SpendingDraftInput {
  date: IsoDate;
  /** Signed cents. */
  amount: number;
  budgetId: number;
  note: string;
}

/** The row as it is stored (with its `createdAt`, which the buttons' fingerprint is made of). */
function storedSpending(tg: TelegramContext, id: number): StoredSpending {
  const row = findSpending(tg.db, id);
  if (!row) throw new Error(`spending ${id} is not there after its write`);
  return row;
}

function storedIncome(tg: TelegramContext, id: number): StoredIncome {
  const row = findIncome(tg.db, id);
  if (!row) throw new Error(`income ${id} is not there after its write`);
  return row;
}

/** `createSpending`, and the entry for `/undo`, in one transaction. */
export function addSpending(tg: TelegramContext, draft: SpendingDraftInput): StoredSpending {
  const input = spendingCreateSchema.parse({
    date: draft.date,
    amount: draft.amount,
    budgetId: draft.budgetId,
    description: draft.note,
  });
  const id = inTransaction(tg, (deps) => {
    const created = createSpending(deps, input);
    recordEntry(deps.db, deps.clock, { kind: 's', id: created.id });
    return created.id;
  });
  return storedSpending(tg, id);
}

export interface IncomeDraftInput {
  date: IsoDate;
  amount: number;
  description: string;
}

/** `createIncome`, and the entry for `/undo`, in one transaction. */
export function addIncome(tg: TelegramContext, draft: IncomeDraftInput): StoredIncome {
  const input = incomeCreateSchema.parse(draft);
  const id = inTransaction(tg, (deps) => {
    const created = createIncome(deps, input);
    recordEntry(deps.db, deps.clock, { kind: 'i', id: created.id });
    return created.id;
  });
  return storedIncome(tg, id);
}

/** `updateSpending({ date })`: Change date. */
export function moveSpending(tg: TelegramContext, id: number, date: IsoDate): StoredSpending {
  updateSpending(tg, id, spendingUpdateSchema.parse({ date }));
  return storedSpending(tg, id);
}

/** `updateIncome({ date })`: Change date. */
export function moveIncome(tg: TelegramContext, id: number, date: IsoDate): StoredIncome {
  updateIncome(tg, id, incomeUpdateSchema.parse({ date }));
  return storedIncome(tg, id);
}

/** `deleteSpending` or `deleteIncome`: its entry goes with it (foreign key cascade). */
export function removeEntry(tg: TelegramContext, ref: EntryRef): void {
  if (ref.kind === 's') deleteSpending(tg, ref.id);
  else deleteIncome(tg, ref.id);
}

// --- What a refused write was ----------------------------------------------------------------

/** Why a service refused a write, as the flows react to it. */
export type WriteProblem =
  | 'unknown_budget'
  | 'before_start_month'
  | 'outside_active_months'
  /** 404: the spending or income is gone (deleted on the web). */
  | 'gone';

/** The reason a service refused, or null for any other error (which the caller rethrows). */
export function writeProblemOf(error: unknown): WriteProblem | null {
  if (!(error instanceof HttpError)) return null;
  if (error.code === 'not_found') return 'gone';
  if (error.code !== 'rule_violation') return null;
  const rule = (error.details as RuleViolationDetails | undefined)?.rule;
  return rule === 'unknown_budget' ||
    rule === 'before_start_month' ||
    rule === 'outside_active_months'
    ? rule
    : null;
}
