/**
 * The driver of the transfers fuzz. A run starts from a small world built through the public
 * endpoints, then executes a random sequence of operations (`transfers-fuzz-gen.ts`) against the
 * app and, in lock step, against an independent model: the Phase 2 model of the ledger
 * (`prop-model.ts`) and the Phase 4 model of savings (`savings-model.ts`), both written from
 * docs/DOMAIN.md alone, over a plain-data copy of every fact (`Sim`) that the driver keeps itself.
 *
 * For EVERY operation it asserts:
 *
 * - the answer is the one the doc and the shared contract demand: accepted, or refused with the
 *   status, code, rule and field of the FIRST rule broken in the documented order (the prediction
 *   is made from the request actually sent, not from what the operation meant to send);
 * - a refused request changed nothing: every table of the database is as it was;
 * - an accepted one changes the months as the model says: `GET /api/months` (every month) and the
 *   month views around the fact, `GET /api/savings`, and, now and then (every seventh step and at
 *   the end), every month view, the stored transfers (with the filters of their list), budgets,
 *   spendings, incomes and salary;
 * - on the numbers the API shows, without the model: the identities of the contract and invariant 1
 *   (`monthViolations`), invariant 2 (`chainViolations`: income = spent + paid + savings due + the
 *   change in what is held), invariant 8 and "a stored transfer is counted" (the lines'
 *   `transfersNet` and `totals.transfersNet` are the sums over the transfers `GET /api/transfers`
 *   lists, and every budget a stored transfer names has a line), and invariant 5 (a fact dated in
 *   month X leaves every month before X exactly as it was, the month list and the month before X
 *   in full);
 * - "delete restores": creating a transfer, a spending or an income and deleting it at once leaves
 *   the database, every month, the summaries, the savings and the budgets exactly as they were.
 *
 * Everything is deterministic: a clock that only the operations move, an in-memory database, and one
 * server per run. A failure names the step, the operation and the facts so far; fast-check prints
 * the seed and the shrunk sequence (see `testing/prop.ts` for how to replay it).
 */
import {
  type BudgetDto,
  type IncomeDto,
  MAX_CENTS,
  NOTES_MAX_LENGTH,
  type MonthSummary,
  type MonthView,
  type SalaryEntryDto,
  type SavingsDto,
  type SavingsTransactionDto,
  type SettingsDto,
  type SpendingDto,
  type SpendingsPage,
  type TransferDto,
} from '@wallet/shared';
import type { Server } from 'node:http';
import type {
  BudgetFact,
  Facts,
  SalaryChangeFact,
  SubscriptionFact,
  TransferFact,
} from '../domain/facts';
import type { Db } from '../db/client';
import { dumpDb } from './db-dump';
import { type MutableClock, mutableClock } from './helpers';
import { chainViolations, monthViolations } from './month-identities';
import { type coverage, diff, failIfAny } from './prop';
import { type Answer, type Method, call, send, serve, stop } from './prop-api';
import { type ModelMonth, daysInMonth, modelLedger, monthIndex, monthKey } from './prop-model';
import { addDays, firstDay, pickSettleMonth } from './savings-fuzz-gen';
import {
  type ModelRow,
  type Refusal,
  type Verdict,
  type World,
  expectedSavings,
  outstandingList,
  outstandingOf,
  predictMoveStart,
  predictSettle,
  predictUndo,
  settlementRowsOf,
} from './savings-model';
import { createTestApp } from './test-app';
import {
  type AmountSel,
  type Op,
  type Setup,
  type TransferFields,
  type When,
  cleanTransfer,
} from './transfers-fuzz-gen';

export type Coverage = ReturnType<typeof coverage<string>>;

// -------------------------------------------------------------------------------------------------
// The facts, as plain data
// -------------------------------------------------------------------------------------------------

interface SimTransfer {
  id: number;
  date: string;
  fromBudgetId: number | null;
  toBudgetId: number | null;
  amount: number;
  note: string | null;
}
interface SimSpending {
  id: number;
  budgetId: number;
  date: string;
  amount: number;
}
interface SimIncome {
  id: number;
  date: string;
  amount: number;
}

/** Every fact the ledger works from, and every savings row, as the driver believes the API holds them. */
interface Sim {
  /** `YYYY-MM-DD`, from the clock (the fuzz runs with TZ=UTC). */
  today: string;
  startMonth: string;
  salary: SalaryChangeFact[];
  incomes: SimIncome[];
  spendings: SimSpending[];
  transfers: SimTransfer[];
  budgets: BudgetFact[];
  subscriptions: SubscriptionFact[];
  rows: ModelRow[];
  /** Ids that existed and are gone, so that "a deleted one" and "one that never was" can be asked for. */
  goneBudgets: number[];
  goneTransfers: number[];
  /** Every outstanding amount shown for a month so far: "the figure the user saw". */
  seen: Map<string, Set<number>>;
  /** Names for the budgets the fuzz creates. */
  made: number;
}

const WARN_PERCENT = 80;

/** Every this many steps (and at the end) everything is read and compared, not only the window of the fact. */
const FULL_EVERY = 7;

const monthOf = (date: string): string => date.slice(0, 7);
const currentMonthOf = (sim: Sim): string => monthOf(sim.today);
const pad = (n: number): string => String(n).padStart(2, '0');

/** A day of `month` as two digits: the number asked for, or the month's last day. */
function dayOfMonth(month: string, day: number | 'last'): string {
  if (day !== 'last') return pad(day);
  return pad(daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7))));
}

const isActive = (item: { startMonth: string; endMonth: string | null }, month: string): boolean =>
  item.startMonth <= month && (item.endMonth === null || month <= item.endMonth);

/** The row of `rows` in effect at `month`: the latest one not after it. */
function rowAt<T extends { effectiveMonth: string }>(rows: readonly T[], month: string) {
  let best: T | undefined;
  for (const row of rows) {
    if (row.effectiveMonth <= month && (!best || row.effectiveMonth > best.effectiveMonth)) {
      best = row;
    }
  }
  return best;
}

const factsOf = (sim: Sim): Facts => ({
  startMonth: sim.startMonth,
  alertWarnPercent: WARN_PERCENT,
  salary: sim.salary,
  incomes: sim.incomes.map((income) => ({ month: monthOf(income.date), amount: income.amount })),
  subscriptions: sim.subscriptions,
  budgets: sim.budgets,
  spendings: sim.spendings.map((s) => ({
    budgetId: s.budgetId,
    month: monthOf(s.date),
    amount: s.amount,
  })),
  transfers: sim.transfers.map((t): TransferFact => ({
    month: monthOf(t.date),
    fromBudgetId: t.fromBudgetId,
    toBudgetId: t.toBudgetId,
    amount: t.amount,
  })),
});

const worldOf = (sim: Sim): World => ({
  today: sim.today,
  facts: factsOf(sim),
  goals: [],
  rows: sim.rows,
});

/** The months in which a budget has a spending or a transfer (on either side), ascending. */
function activityOf(sim: Sim, budgetId: number): string[] {
  return [
    ...sim.spendings.filter((s) => s.budgetId === budgetId).map((s) => monthOf(s.date)),
    ...sim.transfers
      .filter((t) => t.fromBudgetId === budgetId || t.toBudgetId === budgetId)
      .map((t) => monthOf(t.date)),
  ].sort();
}

/** The months in which a budget has a transfer, ascending. */
function transferMonthsOf(sim: Sim, budgetId: number): string[] {
  return sim.transfers
    .filter((t) => t.fromBudgetId === budgetId || t.toBudgetId === budgetId)
    .map((t) => monthOf(t.date))
    .sort();
}

const settledMonthsOf = (sim: Sim): string[] => [
  ...new Set(
    sim.rows.flatMap((row) => (row.kind === 'settlement' ? [row.settlesMonth ?? ''] : [])),
  ),
];

/** A budget id that no budget has ever had. */
const missingBudgetId = (sim: Sim, k: number): number =>
  Math.max(0, ...sim.budgets.map((b) => b.id), ...sim.goneBudgets) + 1 + k;

/** Moving a start month before the first row re-dates that first row, nothing else (docs/DOMAIN.md). */
function redateFirst<T extends { effectiveMonth: string }>(rows: T[], newStart: string): T[] {
  const sorted = [...rows].sort((a, b) => a.effectiveMonth.localeCompare(b.effectiveMonth));
  const first = sorted[0];
  if (!first || first.effectiveMonth <= newStart) return rows;
  return rows.map((row) => (row === first ? { ...row, effectiveMonth: newStart } : row));
}

function upsertRow<T extends { effectiveMonth: string }>(rows: T[], row: T): T[] {
  return [...rows.filter((r) => r.effectiveMonth !== row.effectiveMonth), row];
}

// -------------------------------------------------------------------------------------------------
// What the doc says about a request
// -------------------------------------------------------------------------------------------------

/** The status of an answer, and for an error its code, rule and field. */
interface Outcome {
  status: number;
  code?: string;
  rule?: string;
  field?: string;
  details?: unknown;
}

const accepted = (status = 200): Outcome => ({ status });
const invalid = (): Outcome => ({ status: 400, code: 'validation_error' });
const notFound = (): Outcome => ({ status: 404, code: 'not_found' });
const violation = (rule: string, field?: string): Outcome => ({
  status: 422,
  code: 'rule_violation',
  rule,
  ...(field === undefined ? {} : { field }),
});

const isRealDate = (value: unknown): boolean => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = [
    Number(value.slice(0, 4)),
    Number(value.slice(5, 7)),
    Number(value.slice(8)),
  ];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
};

/**
 * `POST /api/transfers` ("Transfers", "Creating one"): the shape first (400), then
 * `unknown_budget` (`fromBudgetId`, then `toBudgetId`), `before_start_month` (`date`), and
 * `outside_active_months` (`fromBudgetId`, then `toBudgetId`).
 */
function predictTransfer(sim: Sim, body: Record<string, unknown>): Outcome {
  const { date, amount, fromBudgetId: from, toBudgetId: to, note } = body;
  // A field the contract does not have, or one of the wrong type, is a 400.
  const allowed = new Set(['date', 'fromBudgetId', 'toBudgetId', 'amount', 'note']);
  if (Object.keys(body).some((key) => !allowed.has(key))) return invalid();
  const isId = (value: unknown) =>
    value === null || (Number.isInteger(value) && (value as number) > 0);
  if (('fromBudgetId' in body && !isId(from)) || ('toBudgetId' in body && !isId(to))) {
    return invalid();
  }
  // "Free text, up to 1000 characters": the length counts once trimmed.
  if (note !== undefined && note !== null) {
    if (typeof note !== 'string' || note.trim().length > NOTES_MAX_LENGTH) return invalid();
  }
  if (!isRealDate(date)) return invalid();
  if (!Number.isInteger(amount) || (amount as number) <= 0 || (amount as number) > MAX_CENTS) {
    return invalid();
  }
  // "Both side keys are present: an omitted side is an error and not the pool, null is the pool."
  if (!('fromBudgetId' in body) || !('toBudgetId' in body)) return invalid();
  // "At least one side is a budget, and the two sides are not the same budget."
  if (from === null && to === null) return invalid();
  if (from === to) return invalid();

  const sides = [
    ['fromBudgetId', from],
    ['toBudgetId', to],
  ] as const;
  for (const [field, id] of sides) {
    if (id !== null && !sim.budgets.some((b) => b.id === id)) {
      return violation('unknown_budget', field);
    }
  }
  const month = monthOf(date as string);
  if (month < sim.startMonth) return violation('before_start_month', 'date');
  for (const [field, id] of sides) {
    const budget = sim.budgets.find((b) => b.id === id);
    if (budget && !isActive(budget, month)) return violation('outside_active_months', field);
  }
  return accepted(201);
}

/** `POST /api/spendings`: `unknown_budget`, `before_start_month`, `outside_active_months`. */
function predictSpending(sim: Sim, body: Record<string, unknown>): Outcome {
  const { date, amount, budgetId } = body;
  if (!isRealDate(date)) return invalid();
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount as number) > MAX_CENTS) {
    return invalid();
  }
  const budget = sim.budgets.find((b) => b.id === budgetId);
  if (!budget) return violation('unknown_budget', 'budgetId');
  const month = monthOf(date as string);
  if (month < sim.startMonth) return violation('before_start_month', 'date');
  if (!isActive(budget, month)) return violation('outside_active_months', 'date');
  return accepted(201);
}

// -------------------------------------------------------------------------------------------------
// The run
// -------------------------------------------------------------------------------------------------

interface Ctx {
  server: Server;
  clock: MutableClock;
  db: Db;
  sim: Sim;
  cov: Coverage;
  /** Bumped on every change of the sim, so that the model can be remembered between two. */
  version: number;
  step: number;
  model?: { key: string; months: ModelMonth[] };
  /** `GET /api/transfers` as of the last time it was read. */
  transfers: TransferDto[];
}

/** How far ahead the API is asked for: the current month and two more. */
const through = (sim: Sim): string => monthKey(monthIndex(currentMonthOf(sim)) + 2);

/** The model of every month from the start month to four months after the current one. */
function modelOf(ctx: Ctx): ModelMonth[] {
  const key = `${ctx.version}|${ctx.sim.today}`;
  if (ctx.model?.key !== key) {
    const last = monthKey(monthIndex(currentMonthOf(ctx.sim)) + 4);
    ctx.model = { key, months: modelLedger(factsOf(ctx.sim), last, ctx.sim.today) };
  }
  return ctx.model.months;
}

const modelView = (ctx: Ctx, month: string): MonthView | undefined =>
  modelOf(ctx).find((candidate) => candidate.view.month === month)?.view;

const summaryOf = (view: MonthView): MonthSummary => ({
  month: view.month,
  status: view.status,
  income: view.income.total,
  fixedCosts: view.fixedCosts,
  allocated: view.totals.allocated,
  spent: view.totals.spent,
  unallocated: view.unallocated,
  savingsDue: view.savingsDue.total,
});

// -------------------------------------------------------------------------------------------------
// Months and amounts of an operation
// -------------------------------------------------------------------------------------------------

/** A month from a selector. `focus` is the budget an `edge` month is near. */
function pickMonth(sim: Sim, when: When, focus?: BudgetFact): string {
  const start = monthIndex(sim.startMonth);
  const current = monthIndex(currentMonthOf(sim));
  switch (when.k) {
    case 'start':
      return sim.startMonth;
    case 'current':
      return monthKey(current);
    case 'future':
      return monthKey(current + 1 + (when.i % 3));
    case 'closed':
      return current > start ? monthKey(start + (when.i % (current - start))) : monthKey(current);
    case 'settled': {
      const months = settledMonthsOf(sim);
      return months.length > 0
        ? months[when.i % months.length]!
        : pickMonth(sim, { k: 'closed', i: when.i });
    }
    case 'edge': {
      const anchors = focus
        ? [focus.startMonth, focus.endMonth ?? monthKey(current)]
        : [sim.startMonth, monthKey(current)];
      const anchor = anchors[when.i % anchors.length]!;
      return monthKey(monthIndex(anchor) + (Math.floor(when.i / 2) % 3) - 1);
    }
  }
}

const pick = <T>(items: readonly T[], i: number): T | undefined =>
  items.length === 0 ? undefined : items[i % items.length];

/** What the source of a transfer holds in `month` as the facts stand (the pool when `source` is null). */
function holdsIn(ctx: Ctx, month: string, source: number | null): number {
  const view = modelView(ctx, month);
  if (!view) return 0;
  return source === null
    ? view.unallocated
    : (view.budgets.find((line) => line.id === source)?.remaining ?? 0);
}

function amountFrom(sel: AmountSel, holds: number): number {
  const wanted = (() => {
    switch (sel.k) {
      case 'fixed':
        return sel.v;
      case 'all':
        return holds > 0 ? holds : 1;
      case 'over':
        return holds > 0 ? holds + 1 : 1;
      case 'half':
        return Math.max(1, Math.floor(holds / 2));
    }
  })();
  return Math.min(wanted, MAX_CENTS);
}

// -------------------------------------------------------------------------------------------------
// Plans: an operation resolved into a request, its predicted outcome and its effect
// -------------------------------------------------------------------------------------------------

interface Plan {
  label: string;
  method: Method;
  path: string;
  body?: object;
  outcome: Outcome;
  /** The first month the request changes when it is accepted (null: it changes no month). */
  x: string | null;
  /** Whether the stored transfers may have changed (the list is read again). */
  transfers: boolean;
  /** Applies the accepted request to the sim; `answer` is the response body. */
  apply: (sim: Sim, answer: any) => void;
  /** What else the answer must show, as problems. */
  check?: (answer: any) => string[];
  /** Coverage names to count when the request is accepted, and when it is refused. */
  accepted?: string[];
  refused?: string[];
}

/** The request for a transfer; `forcedMonth` dates it in that month whatever `f.when` says. */
function transferPlan(
  ctx: Ctx,
  f: TransferFields,
  forcedMonth?: string,
  /** A budget the transfer must name, whatever the selectors say. */
  forcedBudget?: number,
): Plan {
  const { sim } = ctx;
  const focus = pick(sim.budgets, f.a);
  const month = forcedMonth ?? pickMonth(sim, f.when, focus);
  const active = sim.budgets.filter((b) => isActive(b, month));
  const pool = active.length > 0 ? active : sim.budgets;
  const modeIn = (b: BudgetFact) => rowAt(b.versions, month)?.incremental ?? false;

  let from: number | null = null;
  let to: number | null = null;
  if (f.kind === 'pb') {
    to = pick(pool, f.a)?.id ?? null;
  } else if (f.kind === 'bp') {
    from = pick(pool, f.a)?.id ?? null;
  } else {
    let first = pick(pool, f.a);
    let second: BudgetFact | undefined;
    if (f.kind === 'bbCross') {
      const incremental = active.filter(modeIn);
      const plain = active.filter((b) => !modeIn(b));
      if (incremental.length > 0 && plain.length > 0) {
        const [a, b] = f.a % 2 === 0 ? [incremental, plain] : [plain, incremental];
        first = pick(a, f.a);
        second = pick(b, f.b);
      }
    }
    if (second === undefined) {
      const others = (active.length > 1 ? active : sim.budgets).filter((b) => b.id !== first?.id);
      second = pick(others, f.b);
    }
    from = first?.id ?? null;
    to = second?.id ?? null;
  }
  if (forcedBudget !== undefined && from !== forcedBudget && to !== forcedBudget) {
    if (f.kind === 'pb') to = forcedBudget;
    else if (f.kind === 'bp') from = forcedBudget;
    else from = forcedBudget;
    if (from !== null && from === to) to = null;
  }

  const holds = holdsIn(ctx, month, from);
  const amount = amountFrom(f.amount, holds);
  const day = (m: string) => dayOfMonth(m, f.day);
  const body: Record<string, unknown> = {
    date: `${month}-${day(month)}`,
    fromBudgetId: from,
    toBudgetId: to,
    amount,
  };
  if (f.note === 'text') body['note'] = '  memo ';
  if (f.note === 'blank') body['note'] = '   ';
  if (f.note === 'null') body['note'] = null;

  // Shape faults (400).
  switch (f.shape) {
    case 'bothPool':
      body['fromBudgetId'] = null;
      body['toBudgetId'] = null;
      break;
    case 'same': {
      const id = from ?? to ?? pick(sim.budgets, f.a)?.id ?? null;
      body['fromBudgetId'] = id;
      body['toBudgetId'] = id;
      break;
    }
    case 'zero':
      body['amount'] = 0;
      break;
    case 'negative':
      body['amount'] = -amount;
      break;
    case 'omitFrom':
      delete body['fromBudgetId'];
      break;
    case 'omitTo':
      delete body['toBudgetId'];
      break;
    case 'badDate':
      body['date'] = `${month}-32`;
      break;
    case 'fraction':
      body['amount'] = amount + 0.5;
      break;
    case 'textAmount':
      body['amount'] = String(amount);
      break;
    case 'textId':
      body['toBudgetId'] = String(to ?? from ?? 1);
      break;
    case 'extra':
      body['surprise'] = true;
      break;
    case 'longNote':
      body['note'] = 'x'.repeat(NOTES_MAX_LENGTH + 1);
      break;
    case 'ok':
      break;
  }
  // Rule faults (422), independent of each other.
  if (f.unknownFrom) body['fromBudgetId'] = missingBudgetId(sim, 0);
  if (f.unknownTo) body['toBudgetId'] = missingBudgetId(sim, 1);
  if (f.unknownBoth) {
    body['fromBudgetId'] = missingBudgetId(sim, 0);
    body['toBudgetId'] = missingBudgetId(sim, 1);
  }
  if (f.beforeStart) {
    const early = monthKey(monthIndex(sim.startMonth) - 1 - (f.a % 3));
    body['date'] = `${early}-${day(early)}`;
  }
  if (f.outside) {
    // A month in which one of the budgets it names is not active (and which is not before the start).
    const named = [body['fromBudgetId'], body['toBudgetId']]
      .map((id) => sim.budgets.find((b) => b.id === id))
      .filter((b): b is BudgetFact => b !== undefined);
    const budget = pick(named, f.b);
    if (budget) {
      const before = monthIndex(budget.startMonth) - 1;
      const candidates = [
        ...(before >= monthIndex(sim.startMonth) ? [monthKey(before)] : []),
        ...(budget.endMonth === null ? [] : [monthKey(monthIndex(budget.endMonth) + 1)]),
      ];
      const outside = pick(candidates, f.a);
      if (outside !== undefined) body['date'] = `${outside}-${day(outside)}`;
    }
  }

  if (f.outsideBoth) {
    // A month, from the start month to three months ahead, in which none of the budgets it names is active.
    const named = [body['fromBudgetId'], body['toBudgetId']]
      .map((id) => sim.budgets.find((b) => b.id === id))
      .filter((b): b is BudgetFact => b !== undefined);
    const months: string[] = [];
    for (let m = monthIndex(sim.startMonth); m <= monthIndex(currentMonthOf(sim)) + 3; m++) {
      if (named.length > 0 && named.every((b) => !isActive(b, monthKey(m))))
        months.push(monthKey(m));
    }
    const outside = pick(months, f.b);
    if (outside !== undefined) body['date'] = `${outside}-${day(outside)}`;
  }

  return transferPlanOf(ctx, body, holds);
}

/**
 * The plan for a `POST /api/transfers` with this `body`, whatever it holds: the doc says what the
 * answer is (`predictTransfer`) and what an accepted one does to the sim. `holds` is what the
 * source holds in the month of the date, for the count of transfers over it (null: not asked).
 */
function transferPlanOf(ctx: Ctx, body: Record<string, unknown>, holds: number | null): Plan {
  const { sim } = ctx;
  const outcome = predictTransfer(sim, body);
  const made = outcome.status === 201;
  const date = body['date'] as string;
  const noteWanted = body['note'];
  const note =
    typeof noteWanted === 'string' && noteWanted.trim() !== '' ? noteWanted.trim() : null;
  const fromId = body['fromBudgetId'] as number | null;
  const toId = body['toBudgetId'] as number | null;

  const names = [fromId === null ? 'pool' : 'budget', toId === null ? 'pool' : 'budget'].join('->');
  const when =
    monthOf(date) < currentMonthOf(sim)
      ? 'closed'
      : monthOf(date) === currentMonthOf(sim)
        ? 'current'
        : 'future';
  const fromBudget = sim.budgets.find((b) => b.id === fromId);
  const toBudget = sim.budgets.find((b) => b.id === toId);
  const cross =
    fromBudget !== undefined &&
    toBudget !== undefined &&
    (rowAt(fromBudget.versions, monthOf(date))?.incremental ?? false) !==
      (rowAt(toBudget.versions, monthOf(date))?.incremental ?? false);
  const over = holds !== null && typeof body['amount'] === 'number' && body['amount'] > holds;
  const intoSettled = settledMonthsOf(sim).includes(monthOf(date));
  const endsThere = [fromBudget, toBudget].some((b) => b?.endMonth === monthOf(date));

  return {
    label: `transfer ${JSON.stringify(body)}`,
    method: 'post',
    path: '/api/transfers',
    body,
    outcome,
    x: made ? monthOf(date) : null,
    transfers: true,
    apply: (s, answer) => {
      s.transfers.push({
        id: answer.id,
        date,
        fromBudgetId: fromId,
        toBudgetId: toId,
        amount: body['amount'] as number,
        note,
      });
    },
    check: (answer) =>
      diff(
        answer,
        {
          id: answer?.id,
          date,
          fromBudgetId: fromId,
          toBudgetId: toId,
          amount: body['amount'],
          note,
        },
        'the transfer stored',
      ),
    accepted: made
      ? [
          `transfer accepted ${names} ${when}`,
          `transfer accepted ${names}`,
          `transfer accepted in a ${when} month`,
          ...(cross ? ['transfer accepted across modes'] : []),
          ...(over ? ['transfer accepted over what the source holds'] : []),
          ...(intoSettled ? ['transfer accepted into a settled month'] : []),
          ...(endsThere ? ["transfer accepted in a budget's last month"] : []),
          ...(note !== null ? ['transfer accepted with a note'] : []),
        ]
      : [],
    refused: made
      ? []
      : [
          `transfer refused ${outcome.rule ?? outcome.code}`,
          ...(outcome.rule !== undefined && outcome.field !== undefined
            ? [`transfer refused ${outcome.rule} at ${outcome.field}`]
            : []),
          // The doc names the source when both sides break the same rule.
          ...(outcome.rule === 'outside_active_months' &&
          fromBudget !== undefined &&
          toBudget !== undefined &&
          !isActive(fromBudget, monthOf(date)) &&
          !isActive(toBudget, monthOf(date))
            ? ['transfer refused outside_active_months, both sides']
            : []),
          ...(outcome.rule === 'unknown_budget' &&
          fromId !== null &&
          toId !== null &&
          fromBudget === undefined &&
          toBudget === undefined
            ? ['transfer refused unknown_budget, both sides']
            : []),
        ],
  };
}

function spendingPlan(ctx: Ctx, op: Extract<Op, { t: 'spending' }>): Plan {
  const { sim } = ctx;
  const focus = pick(sim.budgets, op.budget);
  const month = pickMonth(sim, op.when, focus);
  const active = sim.budgets.filter((b) => isActive(b, month));
  const budget = pick(active.length > 0 ? active : sim.budgets, op.budget);
  const day = (m: string) => dayOfMonth(m, op.day);
  const body: Record<string, unknown> = {
    date: `${month}-${day(month)}`,
    amount: op.refund ? -op.amount : op.amount,
    budgetId: budget?.id ?? missingBudgetId(sim, 0),
    description: 'fuzz',
  };
  if (op.unknownBudget) body['budgetId'] = missingBudgetId(sim, 0);
  if (op.beforeStart) {
    const early = monthKey(monthIndex(sim.startMonth) - 1);
    body['date'] = `${early}-${day(early)}`;
  }
  if (op.outside && budget) {
    const before = monthIndex(budget.startMonth) - 1;
    const candidates = [
      ...(before >= monthIndex(sim.startMonth) ? [monthKey(before)] : []),
      ...(budget.endMonth === null ? [] : [monthKey(monthIndex(budget.endMonth) + 1)]),
    ];
    const outside = pick(candidates, op.day === 'last' ? 0 : op.day);
    if (outside !== undefined) body['date'] = `${outside}-${day(outside)}`;
  }
  const outcome = predictSpending(sim, body);
  const made = outcome.status === 201;
  return {
    label: `spending ${JSON.stringify(body)}`,
    method: 'post',
    path: '/api/spendings',
    body,
    outcome,
    x: made ? monthOf(body['date'] as string) : null,
    transfers: false,
    apply: (s, answer) => {
      s.spendings.push({
        id: answer.id,
        budgetId: body['budgetId'] as number,
        date: body['date'] as string,
        amount: body['amount'] as number,
      });
    },
    check: (answer) =>
      diff(
        answer,
        {
          id: answer?.id,
          date: body['date'],
          amount: body['amount'],
          budgetId: body['budgetId'],
          description: 'fuzz',
          notes: null,
          tagIds: [],
        },
        'the spending stored',
      ),
    accepted: made ? ['spending accepted'] : [],
    refused: made ? [] : [`spending refused ${outcome.rule ?? outcome.code}`],
  };
}

function incomePlan(ctx: Ctx, op: Extract<Op, { t: 'income' }>): Plan {
  const { sim } = ctx;
  const month = pickMonth(sim, op.when);
  const early = monthKey(monthIndex(sim.startMonth) - 1);
  const date = op.beforeStart
    ? `${early}-${dayOfMonth(early, op.day)}`
    : `${month}-${dayOfMonth(month, op.day)}`;
  const body = { date, amount: op.amount, description: 'Income' };
  const made = monthOf(date) >= sim.startMonth;
  return {
    label: `income ${JSON.stringify(body)}`,
    method: 'post',
    path: '/api/incomes',
    body,
    outcome: made ? accepted(201) : violation('before_start_month', 'date'),
    x: made ? monthOf(date) : null,
    transfers: false,
    apply: (s, answer) => {
      s.incomes.push({ id: answer.id, date, amount: op.amount });
    },
    check: (answer) =>
      diff(
        answer,
        { id: answer?.id, date, amount: op.amount, description: 'Income' },
        'the income stored',
      ),
    accepted: made ? ['income accepted'] : [],
    refused: made ? [] : ['income refused before_start_month'],
  };
}

/** `DELETE /api/transfers/:id`: 204 for a stored transfer, 404 for any other id. */
function deleteTransferPlan(sim: Sim, id: number): Plan {
  const stored = sim.transfers.find((t) => t.id === id);
  return {
    label: `delete transfer ${id}`,
    method: 'delete',
    path: `/api/transfers/${id}`,
    outcome: stored ? accepted(204) : notFound(),
    x: stored ? monthOf(stored.date) : null,
    transfers: true,
    apply: (s) => {
      s.transfers = s.transfers.filter((t) => t.id !== id);
      s.goneTransfers.push(id);
    },
    accepted: ['transfer deleted'],
    refused: ['transfer delete refused not_found'],
  };
}

/** `POST /api/savings/settle/:month`, predicted by the savings model. */
function settlePlan(ctx: Ctx, month: string, body: { amount: number }): Plan {
  const { sim } = ctx;
  const verdict = predictSettle(worldOf(sim), month, body);
  const outcome = verdict.ok ? accepted(201) : outcomeOfRefusal(verdict.refusal);
  const adjustment = verdict.ok && settlementRowsOf(worldOf(sim), month).length > 0;
  return {
    label: `settle ${month} ${JSON.stringify(body)}`,
    method: 'post',
    path: `/api/savings/settle/${month}`,
    body,
    outcome,
    x: null,
    transfers: false,
    apply: (s, rows: SavingsTransactionDto[]) => {
      s.rows.push(...rows);
    },
    check: (rows: SavingsTransactionDto[]) =>
      verdict.ok
        ? diff(
            rows.map(({ id: _id, groupId: _groupId, ...rest }) => rest),
            verdict.value,
            'the settlement rows',
          )
        : [],
    accepted: [
      'settle accepted',
      ...(adjustment ? ['settle accepted, an adjustment'] : []),
      ...(body.amount < 0 ? ['settle accepted, negative'] : []),
    ],
    refused: [`settle refused ${outcome.rule ?? outcome.code}`],
  };
}

/** `POST /api/budgets/:id/archive` with the end month `end` (an empty body when it is not `explicit`). */
function archivePlan(sim: Sim, budget: BudgetFact, end: string, explicit: boolean): Plan {
  const last = activityOf(sim, budget.id).at(-1);
  const transferLast = transferMonthsOf(sim, budget.id).at(-1);
  // "end_before_start" is reported before "end_before_activity".
  const outcome =
    end < budget.startMonth
      ? violation('end_before_start')
      : last !== undefined && end < last
        ? violation('end_before_activity')
        : accepted(200);
  const made = outcome.status === 200;
  const old = budget.endMonth;
  return {
    label: `archive budget ${budget.id} (${budget.startMonth}..${budget.endMonth}) with end ${end}${explicit ? '' : ' (the default)'}`,
    method: 'post',
    path: `/api/budgets/${budget.id}/archive`,
    body: explicit ? { endMonth: end } : {},
    outcome,
    x: made ? (old === null || end < old ? end : old) : null,
    transfers: true,
    apply: (s) => {
      s.budgets.find((b) => b.id === budget.id)!.endMonth = end;
    },
    check: (answer) => diff(answer?.endMonth, end, 'endMonth'),
    accepted: [
      'budget archived',
      ...(transferMonthsOf(sim, budget.id).includes(end)
        ? ["budget archived in a transfer's month"]
        : []),
    ],
    refused: [
      `budget archive refused ${outcome.rule}`,
      ...(outcome.rule === 'end_before_activity' &&
      transferLast !== undefined &&
      end < transferLast &&
      (activityOf(sim, budget.id)
        .filter((m) => !transferMonthsOf(sim, budget.id).includes(m))
        .at(-1) ?? '') <= end
        ? ['budget archive refused because of a transfer']
        : []),
    ],
  };
}

/** `PATCH /api/budgets/:id` moving the start month to `start`. */
function startPlan(sim: Sim, budget: BudgetFact, start: string): Plan {
  const first = activityOf(sim, budget.id)[0];
  const transferFirst = transferMonthsOf(sim, budget.id)[0];
  // The documented order: before_start_month, end_before_start, start_after_activity.
  const outcome =
    start < sim.startMonth
      ? violation('before_start_month')
      : budget.endMonth !== null && start > budget.endMonth
        ? violation('end_before_start')
        : first !== undefined && start > first
          ? violation('start_after_activity')
          : accepted(200);
  const made = outcome.status === 200;
  const old = budget.startMonth;
  return {
    label: `move the start of budget ${budget.id} (${budget.startMonth}..${budget.endMonth}) to ${start}`,
    method: 'patch',
    path: `/api/budgets/${budget.id}`,
    body: { startMonth: start },
    outcome,
    x: made ? (start < old ? start : old) : null,
    transfers: true,
    apply: (s) => {
      const target = s.budgets.find((b) => b.id === budget.id)!;
      target.startMonth = start;
      target.versions = redateFirst(target.versions, start);
    },
    check: (answer) => diff(answer?.startMonth, start, 'startMonth'),
    accepted: ['budget start moved'],
    refused: [
      `budget start refused ${outcome.rule}`,
      ...(outcome.rule === 'start_after_activity' &&
      transferFirst !== undefined &&
      transferFirst <= (first ?? transferFirst)
        ? ['budget start refused because of a transfer']
        : []),
    ],
  };
}

/** The request an operation stands for, or null when there is nothing for it to act on. */
function planOf(
  ctx: Ctx,
  op: Exclude<
    Op,
    {
      t:
        | 'advance'
        | 'settle'
        | 'undo'
        | 'roundTrip'
        | 'lateTransfer'
        | 'edgeProbe'
        | 'finalMonth'
        | 'sideProbe';
    }
  >,
): Plan | null {
  const { sim } = ctx;
  const current = currentMonthOf(sim);
  switch (op.t) {
    case 'transfer':
      return transferPlan(ctx, op);

    case 'transferDelete': {
      const newestFirst = [...sim.transfers].sort((a, b) =>
        a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1,
      );
      let target: SimTransfer | undefined;
      if (op.k === 'newest') target = newestFirst[0];
      else if (op.k === 'oldest') target = newestFirst.at(-1);
      else if (op.k === 'any') target = pick(newestFirst, op.i);
      const gone = sim.goneTransfers.length > 0 ? pick(sim.goneTransfers, op.i) : undefined;
      const unknown =
        Math.max(0, ...sim.transfers.map((t) => t.id), ...sim.goneTransfers) + 1 + (op.i % 3);
      return deleteTransferPlan(
        sim,
        target?.id ?? (op.k === 'gone' && gone !== undefined ? gone : unknown),
      );
    }

    case 'spending':
      return spendingPlan(ctx, op);

    case 'spendingDelete': {
      const target = pick(sim.spendings, op.i);
      if (!target) return null;
      return {
        label: `delete spending ${target.id}`,
        method: 'delete',
        path: `/api/spendings/${target.id}`,
        outcome: accepted(204),
        x: monthOf(target.date),
        transfers: false,
        apply: (s) => {
          s.spendings = s.spendings.filter((x) => x.id !== target.id);
        },
        accepted: ['spending deleted'],
      };
    }

    case 'income':
      return incomePlan(ctx, op);

    case 'incomeDelete': {
      const target = pick(sim.incomes, op.i);
      if (!target) return null;
      return {
        label: `delete income ${target.id}`,
        method: 'delete',
        path: `/api/incomes/${target.id}`,
        outcome: accepted(204),
        x: monthOf(target.date),
        transfers: false,
        apply: (s) => {
          s.incomes = s.incomes.filter((x) => x.id !== target.id);
        },
        accepted: ['income deleted'],
      };
    }

    case 'salary': {
      const month = pickMonth(sim, op.when);
      const made = month >= sim.startMonth;
      return {
        label: `salary ${op.amount} from ${month}`,
        method: 'put',
        path: `/api/salary/${month}`,
        body: { amount: op.amount },
        outcome: made ? accepted(200) : violation('before_start_month'),
        x: made ? month : null,
        transfers: false,
        apply: (s) => {
          s.salary = upsertRow(s.salary, { effectiveMonth: month, amount: op.amount });
        },
        accepted: ['salary put'],
        refused: ['salary refused before_start_month'],
      };
    }

    case 'budgetCreate': {
      const month = pickMonth(sim, op.when);
      const name = `Fuzz ${++sim.made}`;
      const body = { name, amount: op.amount, incremental: op.incremental, startMonth: month };
      const made = month >= sim.startMonth;
      return {
        label: `create budget ${JSON.stringify(body)}`,
        method: 'post',
        path: '/api/budgets',
        body,
        outcome: made ? accepted(201) : violation('before_start_month'),
        x: made ? month : null,
        transfers: false,
        apply: (s, answer) => {
          s.budgets.push({
            id: answer.id,
            name,
            color: null,
            icon: null,
            sortOrder: answer.sortOrder, // "after the last budget": the API's choice
            startMonth: month,
            endMonth: null,
            alertWarnPercent: null,
            versions: [{ effectiveMonth: month, amount: op.amount, incremental: op.incremental }],
          });
        },
        accepted: ['budget created'],
        refused: ['budget create refused before_start_month'],
      };
    }

    case 'budgetVersion': {
      const budget = pick(sim.budgets, op.budget);
      if (!budget) return null;
      const month = pickMonth(sim, op.when, budget);
      const made = isActive(budget, month);
      return {
        label: `version of budget ${budget.id} (${budget.startMonth}..${budget.endMonth}) at ${month}`,
        method: 'put',
        path: `/api/budgets/${budget.id}/versions/${month}`,
        body: { amount: op.amount, incremental: op.incremental },
        outcome: made ? accepted(200) : violation('outside_active_months'),
        x: made ? month : null,
        transfers: false,
        apply: (s) => {
          const target = s.budgets.find((b) => b.id === budget.id)!;
          target.versions = upsertRow(target.versions, {
            effectiveMonth: month,
            amount: op.amount,
            incremental: op.incremental,
          });
        },
        accepted: ['budget version put'],
        refused: ['budget version refused outside_active_months'],
      };
    }

    case 'budgetArchive': {
      const budget = pick(sim.budgets, op.budget);
      if (!budget) return null;
      const last = activityOf(sim, budget.id).at(-1);
      const start = monthIndex(budget.startMonth);
      let end: string;
      let explicit = true;
      switch (op.end) {
        case 'default':
          end = current;
          explicit = false;
          break;
        case 'current':
          end = current;
          break;
        case 'beforeActivity':
          end = monthKey(monthIndex(last ?? budget.startMonth) - 1);
          break;
        case 'atActivity':
          end = last ?? budget.startMonth;
          break;
        case 'beforeStart':
          end = monthKey(start - 1);
          break;
        case 'start':
          end = budget.startMonth;
          break;
        case 'later':
          end = monthKey(monthIndex(current) + 1 + (op.i % 3));
          break;
        case 'closed':
          end = pickMonth(sim, { k: 'closed', i: op.i });
          break;
      }
      return archivePlan(sim, budget, end, explicit);
    }

    case 'budgetStart': {
      const budget = pick(sim.budgets, op.budget);
      if (!budget) return null;
      const first = activityOf(sim, budget.id)[0];
      const startIndex = monthIndex(budget.startMonth);
      let start: string;
      switch (op.start) {
        case 'earlier':
          start = monthKey(startIndex - 1 - (op.i % 3));
          break;
        case 'later':
          start = monthKey(startIndex + 1 + (op.i % 3));
          break;
        case 'atActivity':
          start = first ?? budget.startMonth;
          break;
        case 'pastActivity':
          start = monthKey(monthIndex(first ?? budget.startMonth) + 1);
          break;
        case 'beforeStart':
          start = monthKey(monthIndex(sim.startMonth) - 1);
          break;
        case 'pastEnd':
          start = monthKey(monthIndex(budget.endMonth ?? currentMonthOf(sim)) + 1);
          break;
      }
      return startPlan(sim, budget, start);
    }

    case 'budgetDelete': {
      const budget = pick(sim.budgets, op.budget);
      if (!budget) return null;
      const hasHistory = activityOf(sim, budget.id).length > 0;
      const onlyTransfers = hasHistory && !sim.spendings.some((s) => s.budgetId === budget.id);
      return {
        label: `delete budget ${budget.id}`,
        method: 'delete',
        path: `/api/budgets/${budget.id}`,
        outcome: hasHistory ? { status: 409, code: 'has_history' } : accepted(204),
        x: hasHistory ? null : budget.startMonth,
        transfers: true,
        apply: (s) => {
          s.budgets = s.budgets.filter((b) => b.id !== budget.id);
          s.goneBudgets.push(budget.id);
        },
        accepted: ['budget deleted'],
        refused: [
          'budget delete refused has_history',
          ...(onlyTransfers ? ['budget delete refused because of a transfer only'] : []),
        ],
      };
    }

    case 'moveStart': {
      const target = monthKey(monthIndex(sim.startMonth) + op.delta);
      const verdict = predictMoveStart(worldOf(sim), target);
      const outcome = verdict.ok ? accepted(200) : outcomeOfRefusal(verdict.refusal);
      return {
        label: `move the start month from ${sim.startMonth} to ${target}`,
        method: 'put',
        path: '/api/settings',
        body: {
          currency: 'EUR',
          locale: 'en-US',
          startMonth: target,
          theme: 'system',
          alertWarnPercent: WARN_PERCENT,
        },
        outcome,
        x: null,
        transfers: true,
        apply: (s) => {
          s.startMonth = target;
          for (const row of s.rows) if (row.kind === 'opening') row.date = firstDay(target);
        },
        accepted: [op.delta < 0 ? 'start month moved earlier' : 'start month moved later'],
        refused: [`start month move refused ${outcome.rule ?? outcome.code}`],
      };
    }
  }
}

const outcomeOfRefusal = (refusal: Refusal): Outcome => ({
  status: refusal.status,
  code: refusal.code,
  ...(refusal.rule === undefined ? {} : { rule: refusal.rule }),
  ...(refusal.field === undefined ? {} : { field: refusal.field }),
  ...(refusal.details === undefined ? {} : { details: refusal.details }),
});

// -------------------------------------------------------------------------------------------------
// Reading the API and checking it
// -------------------------------------------------------------------------------------------------

const get = (ctx: Ctx, path: string) => send(ctx.server, 'get', path);

/** What differs between an answer and what was predicted for the request. */
function answerProblems(what: string, answer: Answer, want: Outcome): string[] {
  const problems: string[] = [];
  const error = answer.body?.error;
  if (answer.status !== want.status)
    problems.push(`status ${answer.status}, expected ${want.status}`);
  if (want.code !== undefined && error?.code !== want.code) {
    problems.push(`error.code ${String(error?.code)}, expected ${want.code}`);
  }
  if (want.rule !== undefined && error?.details?.rule !== want.rule) {
    problems.push(`rule ${String(error?.details?.rule)}, expected ${want.rule}`);
  }
  if (want.field !== undefined && error?.details?.field !== want.field) {
    problems.push(`field ${String(error?.details?.field)}, expected ${want.field}`);
  }
  if (want.details !== undefined) problems.push(...diff(error?.details, want.details, 'details'));
  if (want.status === 400 && !(Array.isArray(error?.details) && error.details.length > 0)) {
    problems.push('no validation issues');
  }
  return problems.length === 0
    ? []
    : [
        `${what}: ${problems.join('; ')} (answered ${answer.status} ${JSON.stringify(answer.body)})`,
      ];
}

/**
 * "A stored transfer is counted" and invariant 8, from the transfers `GET /api/transfers` lists (not
 * from the model): every budget line's `transfersNet` is what came in minus what went out of it that
 * month, every budget a stored transfer names has a line, and `totals.transfersNet` is the transfers
 * from the pool into budgets minus the transfers from budgets into the pool.
 */
function countedProblems(view: MonthView, transfers: readonly TransferDto[]): string[] {
  const problems: string[] = [];
  const net = new Map<number, number>();
  let pool = 0;
  for (const t of transfers) {
    if (monthOf(t.date) !== view.month) continue;
    if (t.fromBudgetId === null) pool += t.amount;
    else net.set(t.fromBudgetId, (net.get(t.fromBudgetId) ?? 0) - t.amount);
    if (t.toBudgetId === null) pool -= t.amount;
    else net.set(t.toBudgetId, (net.get(t.toBudgetId) ?? 0) + t.amount);
  }
  for (const [id, expected] of net) {
    const line = view.budgets.find((b) => b.id === id);
    if (!line)
      problems.push(`${view.month}: a stored transfer names budget ${id}, which has no line`);
    else if (line.transfersNet !== expected) {
      problems.push(
        `${view.month} budget ${id}: transfersNet ${line.transfersNet}, the stored transfers give ${expected}`,
      );
    }
  }
  for (const line of view.budgets) {
    if (!net.has(line.id) && line.transfersNet !== 0) {
      problems.push(
        `${view.month} budget ${line.id}: transfersNet ${line.transfersNet} with no stored transfer`,
      );
    }
  }
  if (view.totals.transfersNet !== pool) {
    problems.push(
      `${view.month}: totals.transfersNet ${view.totals.transfersNet}, the stored pool legs give ${pool}`,
    );
  }
  return problems;
}

/** The views against the model, the identities of the contract, and the stored transfers. */
function viewProblems(ctx: Ctx, views: readonly MonthView[]): string[] {
  const problems: string[] = [];
  for (const view of views) {
    const expected = modelView(ctx, view.month);
    problems.push(...diff(view, expected, `GET /api/months/${view.month}`));
    problems.push(...monthViolations(view));
    problems.push(...countedProblems(view, ctx.transfers));
  }
  // Consecutive months chain: carried in = carried out, and conservation of money (invariant 2).
  let run: MonthView[] = [];
  const flush = () => {
    if (run.length > 0) {
      problems.push(
        ...chainViolations(run, { startsAtLedgerStart: run[0]!.month === ctx.sim.startMonth }),
      );
    }
    run = [];
  };
  for (const view of views) {
    const last = run.at(-1);
    if (last && monthIndex(view.month) !== monthIndex(last.month) + 1) flush();
    run.push(view);
  }
  flush();
  return problems;
}

async function readViews(ctx: Ctx, months: readonly string[]): Promise<MonthView[]> {
  const views: MonthView[] = [];
  for (const month of months) views.push((await get(ctx, `/api/months/${month}`)) as MonthView);
  return views;
}

const allMonths = (sim: Sim): string[] => {
  const months: string[] = [];
  for (let m = monthIndex(sim.startMonth); m <= monthIndex(through(sim)); m++)
    months.push(monthKey(m));
  return months;
};

/** What the API says about every month, the savings and the stored transfers, for before-and-after. */
interface Reading {
  views: MonthView[];
  summaries: MonthSummary[];
  savings: SavingsDto;
  budgets: BudgetDto[];
  transfers: TransferDto[];
  dump: string;
}

async function readAll(ctx: Ctx): Promise<Reading> {
  const { sim } = ctx;
  return {
    views: await readViews(ctx, allMonths(sim)),
    summaries: (await get(
      ctx,
      `/api/months?from=${sim.startMonth}&to=${through(sim)}`,
    )) as MonthSummary[],
    savings: (await get(ctx, '/api/savings')) as SavingsDto,
    budgets: (await get(ctx, '/api/budgets')) as BudgetDto[],
    transfers: (await get(ctx, '/api/transfers')) as TransferDto[],
    dump: dumpDb(ctx.db),
  };
}

/** What `GET /api/budgets`, `/spendings`, `/incomes` and `/salary` say against the sim. */
async function storedProblems(ctx: Ctx): Promise<string[]> {
  const { sim } = ctx;
  const problems: string[] = [];

  const budgets = (await get(ctx, '/api/budgets')) as BudgetDto[];
  const ofBudget = (
    b: Pick<BudgetDto, 'id' | 'startMonth' | 'endMonth' | 'sortOrder' | 'versions'>,
  ) => ({
    id: b.id,
    startMonth: b.startMonth,
    endMonth: b.endMonth,
    sortOrder: b.sortOrder,
    versions: [...b.versions]
      .map(({ effectiveMonth, amount, incremental }) => ({ effectiveMonth, amount, incremental }))
      .sort((a, c) => a.effectiveMonth.localeCompare(c.effectiveMonth)),
  });
  problems.push(
    ...diff(
      budgets.map(ofBudget).sort((a, b) => a.id - b.id),
      sim.budgets.map(ofBudget).sort((a, b) => a.id - b.id),
      'GET /api/budgets',
    ),
  );
  for (const budget of budgets) {
    const history = activityOf(sim, budget.id).length > 0;
    if (budget.hasHistory !== history) {
      problems.push(`budget ${budget.id}: hasHistory ${budget.hasHistory}, expected ${history}`);
    }
  }

  const transfers = (await get(ctx, '/api/transfers')) as TransferDto[];
  ctx.transfers = transfers;
  problems.push(
    ...diff(
      transfers,
      [...sim.transfers]
        .sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1))
        .map((t) => ({ ...t })),
      'GET /api/transfers',
    ),
  );

  // The filters of the list: a month, a range of dates, a budget (out of OR into it), and together.
  const newestFirst = [...sim.transfers].sort((a, b) =>
    a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1,
  );
  const anchor = pick(newestFirst, ctx.step);
  const month = anchor ? monthOf(anchor.date) : currentMonthOf(sim);
  const budget = pick(sim.budgets, ctx.step);
  const budgetId = budget?.id ?? missingBudgetId(sim, 0);
  const from = addDays(anchor?.date ?? firstDay(month), -(ctx.step % 5));
  const to = addDays(anchor?.date ?? firstDay(month), ctx.step % 7);
  const filtered: [string, (t: SimTransfer) => boolean][] = [
    [`month=${month}`, (t) => monthOf(t.date) === month],
    [`budgetId=${budgetId}`, (t) => t.fromBudgetId === budgetId || t.toBudgetId === budgetId],
    [`from=${from}&to=${to}`, (t) => t.date >= from && t.date <= to],
    [
      `month=${month}&budgetId=${budgetId}`,
      (t) =>
        monthOf(t.date) === month && (t.fromBudgetId === budgetId || t.toBudgetId === budgetId),
    ],
    [`budgetId=${missingBudgetId(sim, 3)}`, () => false],
  ];
  for (const [query, keeps] of filtered) {
    problems.push(
      ...diff(
        await get(ctx, `/api/transfers?${query}`),
        newestFirst.filter(keeps).map((t) => ({ ...t })),
        `GET /api/transfers?${query}`,
      ),
    );
  }

  const spendings: SpendingDto[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = (await get(ctx, `/api/spendings?limit=200&offset=${offset}`)) as SpendingsPage;
    spendings.push(...page.items);
    if (offset + 200 >= page.total) break;
  }
  const simple = (rows: { id: number; date: string; amount: number; budgetId?: number }[]) =>
    rows
      .map(({ id, date, amount, budgetId }) => ({ id, date, amount, budgetId }))
      .sort((a, b) => a.id - b.id);
  problems.push(...diff(simple(spendings), simple(sim.spendings), 'GET /api/spendings'));

  const incomes = (await get(ctx, '/api/incomes')) as IncomeDto[];
  problems.push(
    ...diff(
      incomes.map(({ id, date, amount }) => ({ id, date, amount })).sort((a, b) => a.id - b.id),
      sim.incomes.map(({ id, date, amount }) => ({ id, date, amount })).sort((a, b) => a.id - b.id),
      'GET /api/incomes',
    ),
  );

  const salary = (await get(ctx, '/api/salary')) as SalaryEntryDto[];
  problems.push(
    ...diff(
      salary,
      [...sim.salary].sort((a, b) => a.effectiveMonth.localeCompare(b.effectiveMonth)),
      'GET /api/salary',
    ),
  );
  return problems;
}

interface FinishOptions {
  /** The first month the operation changed, if it was a fact dated in a month. */
  x: string | null;
  /** The months whose model view the operation changed: all of them are read and checked. */
  changed?: readonly string[];
  /** Read every month and every stored row, not only the months the operation changed. */
  full: boolean;
  /** Read `GET /api/transfers` again. */
  transfers: boolean;
  /** Read `GET /api/savings` (it is skipped when the model says the operation cannot have moved it). */
  savings: boolean;
  /** What was read about the months before `x` before the operation (invariant 5). */
  before?: { summaries: MonthSummary[]; views: Map<string, MonthView> };
}

/** The state is read back after a step: it must be the model's, and the identities must hold. */
async function finish(ctx: Ctx, options: FinishOptions): Promise<void> {
  const { sim } = ctx;
  const problems: string[] = [];
  const model = modelOf(ctx);
  const last = through(sim);
  const start = monthIndex(sim.startMonth);

  if (options.transfers || options.full) {
    ctx.transfers = (await get(ctx, '/api/transfers')) as TransferDto[];
  }

  // Every month, at the level of the month list.
  const summaries = (await get(
    ctx,
    `/api/months?from=${sim.startMonth}&to=${last}`,
  )) as MonthSummary[];
  problems.push(
    ...diff(
      summaries,
      model.filter((m) => m.view.month <= last).map((m) => summaryOf(m.view)),
      'GET /api/months',
    ),
  );

  // The views: all of them now and then; otherwise every month the model says the operation changed
  // (so invariants 1, 2 and 8 are checked on all of them after every step), the month of the fact and
  // the one before it (causality), and the last.
  let months: string[];
  if (options.full) {
    months = allMonths(sim);
  } else {
    const wanted = new Set<string>([last, ...(options.changed ?? [])]);
    const around = options.x ?? currentMonthOf(sim);
    wanted.add(around);
    wanted.add(monthKey(monthIndex(around) - 1));
    months = [...wanted].filter((m) => monthIndex(m) >= start && m <= last).sort();
  }
  const views = await readViews(ctx, months);
  problems.push(...viewProblems(ctx, views));

  // Invariant 5: a fact dated in month X leaves every month before X as it was.
  if (options.before && options.x !== null) {
    const x = options.x;
    problems.push(
      ...diff(
        summaries.filter((row) => row.month < x),
        options.before.summaries.filter((row) => row.month < x),
        `the month list before ${x} (causality)`,
      ),
    );
    for (const view of views) {
      const old = options.before.views.get(view.month);
      if (old && view.month < x)
        problems.push(...diff(view, old, `${view.month} before ${x} (causality)`));
    }
  }

  // Savings: the list of months to settle, the balance.
  if (options.savings || options.full) {
    const savings = (await get(ctx, '/api/savings')) as SavingsDto;
    problems.push(...diff(savings, expectedSavings(worldOf(sim)), 'GET /api/savings'));
    for (const entry of savings.outstanding) {
      sim.seen.set(entry.month, new Set([...(sim.seen.get(entry.month) ?? []), entry.outstanding]));
    }
  }

  if (options.full) {
    problems.push(...(await storedProblems(ctx)));
    ctx.cov.hit('everything was compared');
  }
  failIfAny(problems, 'the API differs from the model or breaks an identity');
}

// -------------------------------------------------------------------------------------------------
// Executing
// -------------------------------------------------------------------------------------------------

/** The model's view of every month as text, to tell which months an operation changed. */
function modelMonths(ctx: Ctx): Map<string, string> {
  return new Map(modelOf(ctx).map(({ view }) => [view.month, JSON.stringify(view)]));
}

/** The months whose view is not the same in the two maps (a month in only one of them counts). */
function changedMonths(before: Map<string, string>, after: Map<string, string>): string[] {
  const months = new Set([...before.keys(), ...after.keys()]);
  return [...months].filter((month) => before.get(month) !== after.get(month)).sort();
}

/**
 * Sends `plan`, checks the answer against the prediction, and: a refusal must leave the database
 * as it was; an acceptance is applied to the sim and the state read back. Returns the answer body
 * when it was accepted.
 */
async function perform(ctx: Ctx, plan: Plan): Promise<any | undefined> {
  const { sim } = ctx;
  const made = plan.outcome.status < 300;
  const dumpBefore = made ? undefined : dumpDb(ctx.db);

  // Invariant 5, the part that needs the months as they were: those before the change.
  let before: FinishOptions['before'];
  if (made && plan.x !== null && monthIndex(plan.x) > monthIndex(sim.startMonth)) {
    const x = monthKey(monthIndex(plan.x) - 1);
    const summaries = (await get(
      ctx,
      `/api/months?from=${sim.startMonth}&to=${through(sim)}`,
    )) as MonthSummary[];
    const views = new Map<string, MonthView>();
    for (const view of await readViews(ctx, [x])) views.set(view.month, view);
    before = { summaries, views };
  }

  const savingsBefore = made ? JSON.stringify(expectedSavings(worldOf(sim))) : '';
  const monthsBefore = made ? modelMonths(ctx) : new Map<string, string>();
  const answer = await call(ctx.server, plan.method, plan.path, plan.body);
  failIfAny(
    answerProblems(plan.label, answer, plan.outcome),
    'the answer is not the predicted one',
  );

  if (!made) {
    failIfAny(
      dumpDb(ctx.db) === dumpBefore ? [] : [`${plan.label}: the database changed`],
      'a refused request changed something',
    );
    for (const name of plan.refused ?? []) ctx.cov.hit(name);
    return undefined;
  }

  failIfAny(plan.check?.(answer.body) ?? [], `${plan.label}: the answer`);
  plan.apply(sim, answer.body);
  ctx.version++;
  for (const name of plan.accepted ?? []) ctx.cov.hit(name);
  await finish(ctx, {
    x: plan.x,
    changed: changedMonths(monthsBefore, modelMonths(ctx)),
    full: ctx.step % FULL_EVERY === 0,
    transfers: plan.transfers,
    // The savings are read when the model says they moved, and now and then when it says they did not.
    savings: JSON.stringify(expectedSavings(worldOf(sim))) !== savingsBefore || ctx.step % 3 === 0,
    ...(before ? { before } : {}),
  });
  return answer.body;
}

/** `DELETE /api/savings/settle/:month`, predicted by the savings model. */
function undoPlan(sim: Sim, month: string): Plan {
  const verdict: Verdict<number[]> = predictUndo(worldOf(sim), month);
  return {
    label: `undo the settlement of ${month}`,
    method: 'delete',
    path: `/api/savings/settle/${month}`,
    outcome: verdict.ok ? accepted(204) : outcomeOfRefusal(verdict.refusal),
    x: null,
    transfers: false,
    apply: (s) => {
      s.rows = s.rows.filter((row) => !(row.kind === 'settlement' && row.settlesMonth === month));
    },
    accepted: ['undo accepted'],
    refused: ['undo refused not_found'],
  };
}

/** A body of settle, from the outstanding amount of the month, the figures seen before and the operation. */
function settleBody(sim: Sim, month: string, op: Extract<Op, { t: 'settle' }>): { amount: number } {
  const exact = outstandingOf(worldOf(sim), month) ?? op.delta;
  const base = exact === 0 ? op.delta : exact;
  const stale = [...(sim.seen.get(month) ?? [])].reverse().find((value) => value !== exact);
  switch (op.amount) {
    case 'exact':
      return { amount: base };
    case 'stale':
      return { amount: stale ?? base + op.delta };
    case 'off':
      return { amount: base + op.delta };
  }
}

async function execute(ctx: Ctx, op: Op): Promise<void> {
  const { sim } = ctx;
  ctx.cov.hit(`op ${op.t}`);

  switch (op.t) {
    case 'advance': {
      const current = monthIndex(currentMonthOf(sim));
      let next: string;
      let time = '12:00:00';
      if (op.mode === 'days') next = addDays(sim.today, op.n);
      else if (op.mode === 'monthEnd') {
        next = addDays(firstDay(monthKey(current + 1)), -1);
        time = '23:59:59';
      } else if (op.mode === 'monthStart') {
        next = firstDay(monthKey(current + 1));
        time = '00:00:00';
      } else {
        next = `${monthKey(current + 1 + (op.n % 2))}-${pad(Math.min(28, Number(sim.today.slice(8, 10))))}`;
      }
      if (monthOf(next) !== currentMonthOf(sim)) ctx.cov.hit('the clock crossed a month boundary');
      const monthsBefore = modelMonths(ctx);
      ctx.clock.set(`${next}T${time}Z`);
      sim.today = next;
      ctx.version++;
      await finish(ctx, {
        x: null,
        changed: changedMonths(monthsBefore, modelMonths(ctx)),
        full: ctx.step % FULL_EVERY === 0,
        transfers: false,
        savings: true,
      });
      return;
    }

    case 'settle': {
      const month = pickSettleMonth(worldOf(sim), op.month, op.mi);
      await perform(ctx, settlePlan(ctx, month, settleBody(sim, month, op)));
      return;
    }

    case 'lateTransfer': {
      // The story of a late edit to a settled month, from start to finish: a month is settled, a
      // transfer is dated in it (it shows up as an adjustment), the adjustment is settled, the
      // transfer is deleted (the month owes the other way) and that is settled too. Every step is
      // checked like any other operation.
      const open = outstandingList(worldOf(sim)).filter((entry) => !entry.adjustment);
      const month = pick(open, op.mi)?.month;
      if (month === undefined) {
        ctx.cov.hit('lateTransfer skipped (no month to settle)');
        return;
      }
      const settleWhatIsOwed = async (what: string): Promise<boolean> => {
        const owed = outstandingOf(worldOf(sim), month);
        if (!owed) return false;
        await perform(ctx, settlePlan(ctx, month, { amount: owed }));
        ctx.cov.hit(what);
        return true;
      };
      await settleWhatIsOwed('late transfer: the month is settled');
      const plan = transferPlan(ctx, cleanTransfer(op.transfer), month);
      const created = await perform(ctx, plan);
      if (!created) return; // refused (no budget is active in that month): nothing more to do
      if (await settleWhatIsOwed('late transfer: the adjustment is settled')) {
        ctx.cov.hit('late transfer: the month showed an adjustment');
      }
      await perform(ctx, deleteTransferPlan(sim, created.id));
      await settleWhatIsOwed('late transfer: the deletion is settled');
      // And, when asked, the whole story is taken back: the settlement rows of the month go.
      if (op.undoAfter && settledMonthsOf(sim).includes(month)) {
        await perform(ctx, undoPlan(sim, month));
      }
      return;
    }

    case 'edgeProbe': {
      // The four requests on either side of the edges of the months of a budget that has a spending
      // or a transfer: its start month just past the first one (refused) and at it (allowed), its
      // end month just before the last one (refused) and at it (allowed). The doc says which, and
      // each is predicted, so an off-by-one in a bound shows up as a wrong answer.
      const budget = pick(
        sim.budgets.filter((b) => activityOf(sim, b.id).length > 0),
        op.budget,
      );
      if (!budget) {
        ctx.cov.hit('edgeProbe skipped (no budget has activity)');
        return;
      }
      const activity = activityOf(sim, budget.id);
      const first = activity[0]!;
      const last = activity.at(-1)!;
      await perform(ctx, startPlan(sim, budget, monthKey(monthIndex(first) + 1)));
      await perform(ctx, archivePlan(sim, budget, monthKey(monthIndex(last) - 1), true));
      await perform(ctx, startPlan(sim, budget, first));
      await perform(ctx, archivePlan(sim, budget, last, true));
      ctx.cov.hit('edge probe');
      return;
    }

    case 'finalMonth': {
      // A budget's last month, from start to finish: it is archived, a transfer that names it is
      // dated in that month (counted, and the budget's leftover goes to savings), and one dated in
      // the month after is refused. Each step is predicted like any other request.
      const budget = pick(sim.budgets, op.budget);
      if (!budget) {
        ctx.cov.hit('finalMonth skipped (no budget)');
        return;
      }
      const current = currentMonthOf(sim);
      const end = op.later ? monthKey(monthIndex(current) + 1 + (op.i % 2)) : current;
      await perform(ctx, archivePlan(sim, budget, end, true));
      const fields = cleanTransfer(op.transfer);
      await perform(ctx, transferPlan(ctx, fields, end, budget.id));
      await perform(ctx, transferPlan(ctx, fields, monthKey(monthIndex(end) + 1), budget.id));
      ctx.cov.hit("a budget's last month");
      return;
    }

    case 'sideProbe': {
      // Which side of a refused transfer the doc names ("`fromBudgetId`, then `toBudgetId`"), probed
      // where both sides can be made to fail: two budgets that begin after today are made, so that
      // neither is active in the current month, and requests dated in it break the same rule on both
      // sides, on one of them, or several rules at once. Each is predicted by `predictTransfer` from
      // the doc, so a check made in the other order is a wrong `field`. Every one is refused and
      // changes nothing.
      const current = currentMonthOf(sim);
      const begins = [op.i, op.j].map((n) => ({ k: 'future', i: n }) as const);
      const made: number[] = [];
      for (const [index, when] of begins.entries()) {
        const created = await perform(
          ctx,
          planOf(ctx, {
            t: 'budgetCreate',
            when,
            amount: 20000 + index,
            incremental: index === 0 ? op.incremental : !op.incremental,
          }) as Plan,
        );
        if (created) made.push(created.id);
      }
      const [first, second] = made;
      if (first === undefined || second === undefined) {
        ctx.cov.hit('sideProbe skipped (the budgets were refused)');
        return;
      }
      const old = pick(
        sim.budgets.filter((b) => !made.includes(b.id)),
        op.i,
      )?.id;
      const missing = [missingBudgetId(sim, 0), missingBudgetId(sim, 1)] as const;
      const early = monthKey(monthIndex(sim.startMonth) - 1);
      const there = `${current}-${dayOfMonth(current, op.day)}`;
      const before = `${early}-${dayOfMonth(early, op.day)}`;
      const requests: [number | null, number | null, string][] = [
        [first, second, there], // both outside: the source
        [second, first, there],
        [null, first, there], // the pool and an outside budget
        [second, null, there],
        [old ?? null, first, there], // an old budget, active or not, and an outside one
        [first, old ?? null, there],
        [missing[0], missing[1], there], // both unknown: the source
        [missing[1], missing[0], there],
        [missing[0], first, there], // unknown before outside, whichever side
        [first, missing[1], there],
        [first, second, before], // before the start month before outside
      ];
      for (const [from, to, date] of requests) {
        if (from === to) continue; // the pool twice, or one budget twice: a 400, not what this is about
        await perform(
          ctx,
          transferPlanOf(ctx, { date, fromBudgetId: from, toBudgetId: to, amount: 1000 }, null),
        );
      }
      ctx.cov.hit('side probe');
      return;
    }

    case 'undo': {
      // A month that has settlement rows, when the operation asks for one and there is one.
      const month =
        op.mode === 'rows' && settledMonthsOf(sim).length > 0
          ? pick(settledMonthsOf(sim), op.mi)!
          : pickSettleMonth(worldOf(sim), op.mode === 'rows' ? 'out' : op.mode, op.mi);
      await perform(ctx, undoPlan(sim, month));
      return;
    }

    case 'roundTrip': {
      let plan: Plan | null;
      if (op.what === 'transfer') {
        plan = transferPlan(ctx, cleanTransfer(op.transfer));
      } else if (op.what === 'spending') {
        const when: When = { k: op.r % 2 === 0 ? 'closed' : 'current', i: op.r };
        plan = spendingPlan(ctx, {
          t: 'spending',
          budget: op.r,
          when,
          day: 1 + (op.r % 28),
          amount: 1234 + op.r,
          refund: op.r % 5 === 0,
          unknownBudget: false,
          beforeStart: false,
          outside: false,
        });
      } else {
        plan = incomePlan(ctx, {
          t: 'income',
          when: { k: op.r % 2 === 0 ? 'closed' : 'future', i: op.r },
          day: 1 + (op.r % 28),
          amount: 4321 + op.r,
          beforeStart: false,
        });
      }
      // Something that is refused anyway is just a refusal (nothing to take back).
      if (plan.outcome.status >= 300) {
        await perform(ctx, plan);
        return;
      }
      const before = await readAll(ctx);
      const body = await perform(ctx, plan);
      const path =
        op.what === 'transfer' ? 'transfers' : op.what === 'spending' ? 'spendings' : 'incomes';
      await send(ctx.server, 'delete', `/api/${path}/${body.id}`, undefined, 204);
      if (op.what === 'transfer') sim.transfers = sim.transfers.filter((t) => t.id !== body.id);
      else if (op.what === 'spending')
        sim.spendings = sim.spendings.filter((s) => s.id !== body.id);
      else sim.incomes = sim.incomes.filter((i) => i.id !== body.id);
      ctx.version++;
      const after = await readAll(ctx);
      failIfAny(
        [
          ...diff(after.views, before.views, 'the month views'),
          ...diff(after.summaries, before.summaries, 'the month list'),
          ...diff(after.savings, before.savings, 'the savings'),
          ...diff(after.budgets, before.budgets, 'the budgets'),
          ...diff(after.transfers, before.transfers, 'the transfers'),
          ...(after.dump === before.dump ? [] : ['the database is not as it was']),
        ],
        `${op.what}: created and deleted again, it did not restore everything`,
      );
      ctx.transfers = after.transfers;
      ctx.cov.hit(`round trip of ${op.what === 'income' ? 'an income' : `a ${op.what}`}`);
      return;
    }

    default: {
      const plan = planOf(ctx, op);
      if (!plan) {
        ctx.cov.hit(`${op.t} skipped (nothing to act on)`);
        return;
      }
      await perform(ctx, plan);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// A run
// -------------------------------------------------------------------------------------------------

/** Builds the world of `setup` through the public endpoints, and the sim of it. */
async function createContext(setup: Setup, cov: Coverage): Promise<Ctx> {
  const startIndex = monthIndex('2025-06') + setup.startOffset;
  const start = monthKey(startIndex);
  const today = `${monthKey(startIndex + setup.closed)}-${pad(setup.day)}`;
  const clock = mutableClock(`${today}T12:00:00Z`);
  const { app, db } = createTestApp(clock);
  const server = await serve(app);
  try {
    const done = await send(
      server,
      'post',
      '/api/onboarding',
      {
        currency: 'EUR',
        locale: 'en-US',
        startMonth: start,
        alertWarnPercent: WARN_PERCENT,
        salary: setup.salary,
        openingSavings: setup.opening,
        budgets: setup.budgets.map((budget, index) => ({
          name: `Budget ${index}`,
          amount: budget.amount,
          incremental: budget.incremental,
        })),
      },
      201,
    );
    const budgets: BudgetFact[] = (done.budgets as BudgetDto[]).map((b) => ({
      id: b.id,
      name: b.name,
      color: b.color,
      icon: b.icon,
      sortOrder: b.sortOrder,
      startMonth: b.startMonth,
      endMonth: b.endMonth,
      alertWarnPercent: b.alertWarnPercent,
      versions: b.versions.map(({ effectiveMonth, amount, incremental }) => ({
        effectiveMonth,
        amount,
        incremental,
      })),
    }));
    const subscriptions: SubscriptionFact[] = [];
    for (const input of [
      {
        name: 'Netflix',
        frequency: 'monthly',
        anchorDate: `${start}-15`,
        amount: setup.monthlySub,
      },
      {
        name: 'Insurance',
        frequency: 'yearly',
        anchorDate: `2026-${pad(setup.yearlyMonth)}-15`,
        amount: setup.yearlySub,
      },
    ] as const) {
      const created = await send(
        server,
        'post',
        '/api/subscriptions',
        { ...input, startMonth: start },
        201,
      );
      subscriptions.push({
        id: created.id,
        name: input.name,
        color: created.color ?? null,
        frequency: input.frequency,
        anchorDate: input.anchorDate,
        startMonth: start,
        endMonth: null,
        prices: [{ effectiveMonth: start, amount: input.amount }],
      });
    }
    const opening = (await send(server, 'get', '/api/savings/transactions?kind=opening'))
      .items[0] as SavingsTransactionDto;

    const sim: Sim = {
      today,
      startMonth: start,
      salary: [{ effectiveMonth: start, amount: setup.salary }],
      incomes: [],
      spendings: [],
      transfers: [],
      budgets,
      subscriptions,
      rows: [opening],
      goneBudgets: [],
      goneTransfers: [],
      seen: new Map(),
      made: 0,
    };
    const ctx: Ctx = { server, clock, db, sim, cov, version: 0, step: 0, transfers: [] };
    const settings = (await send(server, 'get', '/api/settings')) as SettingsDto;
    failIfAny(diff(settings.startMonth, start, 'startMonth'), 'onboarding');
    await finish(ctx, { x: null, full: true, transfers: true, savings: true });
    return ctx;
  } catch (error) {
    await stop(server);
    throw error;
  }
}

/** Runs `ops` from the world of `setup`, checking everything after every operation. */
export async function runSequence(setup: Setup, ops: readonly Op[], cov: Coverage): Promise<void> {
  const ctx = await createContext(setup, cov);
  try {
    for (const [index, op] of ops.entries()) {
      ctx.step = index + 1;
      try {
        await execute(ctx, op);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `step ${ctx.step} of ${ops.length}, ${JSON.stringify(op)} (today ${ctx.sim.today}, start ${ctx.sim.startMonth}): ${message}`,
          { cause: error },
        );
      }
    }
    // Whatever the last operation was, end with everything read and compared.
    await finish(ctx, { x: null, full: true, transfers: true, savings: true });
  } finally {
    await stop(ctx.server);
  }
}
