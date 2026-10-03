/**
 * A model-based fuzz of the editing rules of docs/DOMAIN.md through HTTP.
 *
 * A generated scenario is entered through the public endpoints, then a random sequence of
 * operations is applied, valid ones and ones that break a rule (a spending outside its budget's
 * months, an archive before the last spending, a start month moved past the first fact, a renewal
 * month changed in history, ...). Each operation's outcome is PREDICTED from the doc ("Editing
 * rules", "Start month", "Versioned values") and compared with what the API answers, then:
 *  - a rejected operation must have changed nothing (every stored row read back is as before);
 *  - an accepted one must have changed exactly what the doc says: the targeted row and nothing
 *    else, no version or price row deleted by archive, cancel or a start move, the first row
 *    re-dated only when a start moves before it;
 *  - the month endpoints must show what the independent model computes from the stored rows.
 *
 * The predictions are written from the doc (not from the services), and the order in which several
 * broken rules are reported is the one documented in the shared contract.
 */
import fc from 'fast-check';
import { describe, it } from 'vitest';
import type {
  BudgetFact,
  Facts,
  SalaryChangeFact,
  SubscriptionFact,
  TransferFact,
} from '../../domain/facts';
import { mutableClock } from '../../testing/helpers';
import { config, coverage, diff, failIfAny, SLOW } from '../../testing/prop';
import {
  type Answer,
  type Method,
  type StoredState,
  byMonth,
  call,
  enterFacts,
  monthsProblems,
  readState,
  serve,
  stop,
} from '../../testing/prop-api';
import { scenarioArb, within } from '../../testing/prop-gen';
import { monthIndex, monthKey } from '../../testing/prop-model';
import { createTestApp } from '../../testing/test-app';

// -------------------------------------------------------------------------------------------------
// The world: the stored rows, as plain data, so that a predicted effect can be applied to a copy
// -------------------------------------------------------------------------------------------------

interface World {
  settings: { startMonth: string; alertWarnPercent: number };
  salary: SalaryChangeFact[];
  incomes: { id: number; date: string; amount: number }[];
  budgets: BudgetFact[];
  subscriptions: SubscriptionFact[];
  spendings: { id: number; budgetId: number; date: string; amount: number }[];
  transfers: TransferFact[];
}

const worldOf = (state: StoredState): World =>
  structuredClone({
    settings: {
      startMonth: state.settings.startMonth,
      alertWarnPercent: state.settings.alertWarnPercent,
    },
    salary: state.facts.salary,
    incomes: state.incomes.map(({ id, date, amount }) => ({ id, date, amount })),
    budgets: state.facts.budgets,
    subscriptions: state.facts.subscriptions,
    spendings: state.spendings.map(({ id, budgetId, date, amount }) => ({
      id,
      budgetId,
      date,
      amount,
    })),
    transfers: state.transfers,
  });

const factsOf = (world: World): Facts => ({
  startMonth: world.settings.startMonth,
  alertWarnPercent: world.settings.alertWarnPercent,
  salary: world.salary,
  incomes: world.incomes.map((income) => ({
    month: income.date.slice(0, 7),
    amount: income.amount,
  })),
  subscriptions: world.subscriptions,
  budgets: world.budgets,
  spendings: world.spendings.map((s) => ({
    budgetId: s.budgetId,
    month: s.date.slice(0, 7),
    amount: s.amount,
  })),
  transfers: world.transfers,
});

/** The world with every list in a fixed order, to compare two worlds. */
const normalized = (world: World): World => ({
  ...world,
  salary: [...world.salary].sort((a, b) => a.effectiveMonth.localeCompare(b.effectiveMonth)),
  incomes: [...world.incomes].sort((a, b) => a.id - b.id),
  budgets: [...world.budgets]
    .sort((a, b) => a.id - b.id)
    .map((b) => ({ ...b, versions: [...b.versions].sort(byMonth) })),
  subscriptions: [...world.subscriptions]
    .sort((a, b) => a.id - b.id)
    .map((s) => ({ ...s, prices: [...s.prices].sort(byMonth) })),
  spendings: [...world.spendings].sort((a, b) => a.id - b.id),
});

// -------------------------------------------------------------------------------------------------
// The operations and what the doc says about each
// -------------------------------------------------------------------------------------------------

interface RawOp {
  kind: number;
  a: number;
  b: number;
  c: number;
  amount: number;
  flag: boolean;
}

const rawOp: fc.Arbitrary<RawOp> = fc.record({
  // The operations that carry the rules (moves, archives, deletes, the renewal month, the settings)
  // come up more often than the plain adds and deletes.
  kind: fc.oneof(
    {
      weight: 3,
      arbitrary: fc.constantFrom(9, 10, 11, 11, 12, 14, 15, 15, 16, 17, 17, 19, 19, 22),
    },
    { weight: 2, arbitrary: fc.integer({ min: 0, max: 23 }) },
  ),
  a: fc.integer({ min: 0, max: 9_999 }),
  b: fc.integer({ min: 0, max: 9_999 }),
  c: fc.integer({ min: 0, max: 9_999 }),
  amount: fc.integer({ min: 1, max: 500_000 }),
  flag: fc.boolean(),
});

/** What the doc says an operation does: accepted (status), or rejected by a rule or an error code. */
interface Expected {
  status: number;
  rule?: string;
  code?: string;
}

interface Plan {
  label: string;
  method: Method;
  path: string;
  body?: object;
  expected: Expected;
  /** The world after the operation was accepted; `answer` is the response body (new ids come from it). */
  effect?: (world: World, answer: any) => void;
}

interface ClockPlan {
  label: string;
  clock: string;
}

const ok = (status = 200): Expected => ({ status });
const rule = (name: string): Expected => ({ status: 422, rule: name });

/** Moving a start month before the first row re-dates that row, nothing else (docs/DOMAIN.md). */
function redateFirst<T extends { effectiveMonth: string }>(rows: T[], newStart: string): T[] {
  const sorted = [...rows].sort(byMonth);
  const first = sorted[0];
  if (!first || first.effectiveMonth <= newStart) return rows;
  return rows.map((row) => (row === first ? { ...row, effectiveMonth: newStart } : row));
}

function upsertRow<T extends { effectiveMonth: string }>(rows: T[], row: T): T[] {
  return [...rows.filter((r) => r.effectiveMonth !== row.effectiveMonth), row].sort(byMonth);
}

const two = (n: number) => String(n).padStart(2, '0');

function planOperation(world: World, today: string, raw: RawOp): Plan | ClockPlan | null {
  const current = today.slice(0, 7);
  const start = world.settings.startMonth;
  const low = monthIndex(start) - 2;
  const high = monthIndex(current) + 6;
  /** A month near the tracked ones: some before the start month, some after today. */
  const month = (selector: number) => monthKey(within(selector, low, high));
  /**
   * A month for an operation: two times in three right at one of `anchors` (a start, an end, the
   * first or last activity, the current month), one before, on or one after it, because that is where
   * the rules change; otherwise the uniformly chosen month `fallback`.
   */
  const near = (
    selector: number,
    anchors: readonly (string | null | undefined)[],
    fallback: string,
  ): string => {
    const found = anchors.filter((m): m is string => typeof m === 'string');
    if (selector % 3 === 0 || found.length === 0) return fallback;
    return monthKey(monthIndex(found[selector % found.length]!) + within(selector, 0, 2) - 1);
  };
  const dateIn = (m: string, selector: number) => `${m}-${two(within(selector, 1, 28))}`;
  const signed = raw.flag ? -raw.amount : raw.amount; // never 0
  const pick = <T>(items: readonly T[], selector: number): T | undefined =>
    items.length === 0 ? undefined : items[selector % items.length];
  const inRange = (item: { startMonth: string; endMonth: string | null }, m: string) =>
    item.startMonth <= m && (item.endMonth === null || m <= item.endMonth);
  const activity = (budgetId: number): string[] =>
    [
      ...world.spendings.filter((s) => s.budgetId === budgetId).map((s) => s.date.slice(0, 7)),
      ...world.transfers
        .filter((t) => t.fromBudgetId === budgetId || t.toBudgetId === budgetId)
        .map((t) => t.month),
    ].sort();
  const earliestFact = (): string | null => {
    const months = [
      ...world.salary.map((s) => s.effectiveMonth),
      ...world.subscriptions.map((s) => s.startMonth),
      ...world.budgets.map((b) => b.startMonth),
      ...world.incomes.map((i) => i.date.slice(0, 7)),
      ...world.spendings.map((s) => s.date.slice(0, 7)),
      ...world.transfers.map((t) => t.month),
    ].sort();
    return months[0] ?? null;
  };
  /** The documented order: unknown_budget, before_start_month, outside_active_months. */
  const spendingOutcome = (budgetId: number, date: string): Expected => {
    const budget = world.budgets.find((b) => b.id === budgetId);
    if (!budget) return rule('unknown_budget');
    if (date.slice(0, 7) < start) return rule('before_start_month');
    if (!inRange(budget, date.slice(0, 7))) return rule('outside_active_months');
    return ok();
  };

  switch (raw.kind) {
    case 0: {
      // POST /api/spendings, sometimes for a budget that does not exist
      const budget = raw.flag && raw.c % 5 === 0 ? undefined : pick(world.budgets, raw.a);
      const budgetId = budget?.id ?? 9_999;
      const date = dateIn(
        near(raw.c, [budget?.startMonth, budget?.endMonth, start], month(raw.b)),
        raw.a,
      );
      const expected = spendingOutcome(budgetId, date);
      return {
        label: `add a spending of ${signed} on budget ${budgetId} dated ${date}`,
        method: 'post',
        path: '/api/spendings',
        body: { date, amount: signed, budgetId },
        expected: expected.status === 200 ? ok(201) : expected,
        effect: (w, answer) => w.spendings.push({ id: answer.id, budgetId, date, amount: signed }),
      };
    }
    case 1: {
      // PATCH /api/spendings/:id: a new date, budget or amount, checked as a whole
      const row = pick(world.spendings, raw.a);
      if (!row) return null;
      const change: { date?: string; budgetId?: number; amount?: number } = {};
      if (raw.c % 3 === 0) change.budgetId = pick(world.budgets, raw.b)?.id;
      const aimed = world.budgets.find((b) => b.id === (change.budgetId ?? row.budgetId));
      if (raw.flag) {
        change.date = dateIn(
          near(raw.c, [aimed?.startMonth, aimed?.endMonth, start], month(raw.b)),
          raw.a,
        );
      }
      if (raw.c % 2 === 0 || Object.values(change).every((v) => v === undefined))
        change.amount = signed;
      const expected = spendingOutcome(change.budgetId ?? row.budgetId, change.date ?? row.date);
      return {
        label: `change spending ${row.id} (${JSON.stringify(change)})`,
        method: 'patch',
        path: `/api/spendings/${row.id}`,
        body: change,
        expected,
        effect: (w) => {
          const target = w.spendings.find((s) => s.id === row.id)!;
          Object.assign(
            target,
            Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)),
          );
        },
      };
    }
    case 2: {
      const row = pick(world.spendings, raw.a);
      if (!row) return null;
      return {
        label: `delete spending ${row.id}`,
        method: 'delete',
        path: `/api/spendings/${row.id}`,
        expected: ok(204),
        effect: (w) => {
          w.spendings = w.spendings.filter((s) => s.id !== row.id);
        },
      };
    }
    case 3: {
      const date = dateIn(near(raw.c, [start], month(raw.b)), raw.a);
      return {
        label: `add an income of ${raw.amount} dated ${date}`,
        method: 'post',
        path: '/api/incomes',
        body: { date, amount: raw.amount, description: 'Income' },
        expected: date.slice(0, 7) < start ? rule('before_start_month') : ok(201),
        effect: (w, answer) => w.incomes.push({ id: answer.id, date, amount: raw.amount }),
      };
    }
    case 4: {
      const row = pick(world.incomes, raw.a);
      if (!row) return null;
      const change: { date?: string; amount?: number } = raw.flag
        ? { date: dateIn(near(raw.c, [start], month(raw.b)), raw.a) }
        : { amount: raw.amount };
      const resulting = change.date ?? row.date;
      return {
        label: `change income ${row.id} (${JSON.stringify(change)})`,
        method: 'patch',
        path: `/api/incomes/${row.id}`,
        body: change,
        expected: resulting.slice(0, 7) < start ? rule('before_start_month') : ok(),
        effect: (w) =>
          Object.assign(
            w.incomes.find((i) => i.id === row.id)!,
            change,
          ),
      };
    }
    case 5: {
      const row = pick(world.incomes, raw.a);
      if (!row) return null;
      return {
        label: `delete income ${row.id}`,
        method: 'delete',
        path: `/api/incomes/${row.id}`,
        expected: ok(204),
        effect: (w) => {
          w.incomes = w.incomes.filter((i) => i.id !== row.id);
        },
      };
    }
    case 6: {
      const m = near(raw.c, [start], month(raw.b));
      const amount = raw.flag ? 0 : raw.amount;
      return {
        label: `put the salary ${amount} from ${m}`,
        method: 'put',
        path: `/api/salary/${m}`,
        body: { amount },
        expected: m < start ? rule('before_start_month') : ok(),
        effect: (w) => {
          w.salary = upsertRow(w.salary, { effectiveMonth: m, amount });
        },
      };
    }
    case 7: {
      const existing = raw.flag ? pick(world.salary, raw.a) : undefined;
      const m = existing?.effectiveMonth ?? month(raw.b);
      const has = world.salary.some((s) => s.effectiveMonth === m);
      return {
        label: `delete the salary entry of ${m}`,
        method: 'delete',
        path: `/api/salary/${m}`,
        expected: has ? ok(204) : { status: 404, code: 'not_found' },
        effect: (w) => {
          w.salary = w.salary.filter((s) => s.effectiveMonth !== m);
        },
      };
    }
    case 8: {
      // POST /api/budgets, with or without a start month (then: the current month)
      const startMonth = raw.flag ? near(raw.c, [start, current], month(raw.b)) : current;
      const body = {
        name: `New budget ${raw.a}`,
        amount: raw.c % 4 === 0 ? 0 : raw.amount,
        incremental: raw.c % 2 === 0,
        ...(raw.flag ? { startMonth } : {}),
      };
      return {
        label: `add a budget starting ${startMonth}${raw.flag ? '' : ' (the default)'}`,
        method: 'post',
        path: '/api/budgets',
        body,
        expected: startMonth < start ? rule('before_start_month') : ok(201),
        effect: (w, answer) =>
          w.budgets.push({
            id: answer.id,
            name: body.name,
            color: null,
            icon: null,
            sortOrder: answer.sortOrder, // "after the last one": the API's choice
            startMonth,
            endMonth: null,
            alertWarnPercent: null,
            versions: [
              { effectiveMonth: startMonth, amount: body.amount, incremental: body.incremental },
            ],
          }),
      };
    }
    case 9: {
      // PATCH /api/budgets/:id { startMonth }: before_start_month, end_before_start, start_after_activity
      const budget = pick(world.budgets, raw.a);
      if (!budget) return null;
      const first = activity(budget.id)[0];
      const newStart = near(
        raw.c,
        [budget.startMonth, budget.endMonth, first, start],
        month(raw.b),
      );
      const expected =
        newStart < start
          ? rule('before_start_month')
          : budget.endMonth !== null && newStart > budget.endMonth
            ? rule('end_before_start')
            : first !== undefined && newStart > first
              ? rule('start_after_activity')
              : ok();
      return {
        label: `move the start of budget ${budget.id} (${budget.startMonth}..${budget.endMonth}) to ${newStart}`,
        method: 'patch',
        path: `/api/budgets/${budget.id}`,
        body: { startMonth: newStart },
        expected,
        effect: (w) => {
          const target = w.budgets.find((b) => b.id === budget.id)!;
          target.startMonth = newStart;
          target.versions = redateFirst(target.versions, newStart);
        },
      };
    }
    case 10: {
      // PUT /api/budgets/:id/versions/:month
      const budget = pick(world.budgets, raw.a);
      if (!budget) return null;
      const m = near(raw.c, [budget.startMonth, budget.endMonth], month(raw.b));
      const row = {
        effectiveMonth: m,
        amount: raw.c % 4 === 0 ? 0 : raw.amount,
        incremental: raw.flag,
      };
      return {
        label: `put a version of budget ${budget.id} (${budget.startMonth}..${budget.endMonth}) at ${m}`,
        method: 'put',
        path: `/api/budgets/${budget.id}/versions/${m}`,
        body: { amount: row.amount, incremental: row.incremental },
        expected: inRange(budget, m) ? ok() : rule('outside_active_months'),
        effect: (w) => {
          const target = w.budgets.find((b) => b.id === budget.id)!;
          target.versions = upsertRow(target.versions, row);
        },
      };
    }
    case 11: {
      // POST /api/budgets/:id/archive, an end month or the default (the current month)
      const budget = pick(world.budgets, raw.a);
      if (!budget) return null;
      const last = activity(budget.id).at(-1);
      // An end month just before the latest version leaves that version after the end (inert).
      const latestVersion = budget.versions
        .map((v) => v.effectiveMonth)
        .sort()
        .at(-1);
      const end = raw.flag
        ? raw.c % 2 === 1 && latestVersion
          ? monthKey(monthIndex(latestVersion) - 1)
          : near(
              raw.c,
              [budget.startMonth, last, current, ...budget.versions.map((v) => v.effectiveMonth)],
              month(raw.b),
            )
        : current;
      const expected =
        end < budget.startMonth
          ? rule('end_before_start')
          : last !== undefined && end < last
            ? rule('end_before_activity')
            : ok();
      return {
        label: `archive budget ${budget.id} (${budget.startMonth}..${budget.endMonth}) with end ${end}`,
        method: 'post',
        path: `/api/budgets/${budget.id}/archive`,
        body: raw.flag ? { endMonth: end } : {},
        expected,
        effect: (w) => {
          w.budgets.find((b) => b.id === budget.id)!.endMonth = end;
        },
      };
    }
    case 12: {
      const budget = pick(world.budgets, raw.a);
      if (!budget) return null;
      const hasHistory = activity(budget.id).length > 0;
      return {
        label: `delete budget ${budget.id}`,
        method: 'delete',
        path: `/api/budgets/${budget.id}`,
        expected: hasHistory ? { status: 409, code: 'has_history' } : ok(204),
        effect: (w) => {
          w.budgets = w.budgets.filter((b) => b.id !== budget.id);
        },
      };
    }
    case 13: {
      // POST /api/subscriptions
      const startMonth = raw.flag ? near(raw.c, [start, current], month(raw.b)) : current;
      const yearly = raw.c % 2 === 0;
      const body = {
        name: `New subscription ${raw.a}`,
        frequency: yearly ? 'yearly' : 'monthly',
        anchorDate: `2026-${two(within(raw.b, 1, 12))}-${two(within(raw.c, 1, 28))}`,
        amount: raw.amount,
        ...(raw.flag ? { startMonth } : {}),
      };
      return {
        label: `add a ${body.frequency} subscription starting ${startMonth}`,
        method: 'post',
        path: '/api/subscriptions',
        body,
        expected: startMonth < start ? rule('before_start_month') : ok(201),
        effect: (w, answer) =>
          w.subscriptions.push({
            id: answer.id,
            name: body.name,
            color: null,
            frequency: yearly ? 'yearly' : 'monthly',
            anchorDate: body.anchorDate,
            startMonth,
            endMonth: null,
            prices: [{ effectiveMonth: startMonth, amount: body.amount }],
          }),
      };
    }
    case 14: {
      // PATCH /api/subscriptions/:id { startMonth }: before_start_month, end_before_start
      const subscription = pick(world.subscriptions, raw.a);
      if (!subscription) return null;
      const newStart = near(
        raw.c,
        [subscription.startMonth, subscription.endMonth, start],
        month(raw.b),
      );
      const expected =
        newStart < start
          ? rule('before_start_month')
          : subscription.endMonth !== null && newStart > subscription.endMonth
            ? rule('end_before_start')
            : ok();
      return {
        label: `move the start of subscription ${subscription.id} (${subscription.startMonth}..${subscription.endMonth}) to ${newStart}`,
        method: 'patch',
        path: `/api/subscriptions/${subscription.id}`,
        body: { startMonth: newStart },
        expected,
        effect: (w) => {
          const target = w.subscriptions.find((s) => s.id === subscription.id)!;
          target.startMonth = newStart;
          target.prices = redateFirst(target.prices, newStart);
        },
      };
    }
    case 15: {
      // PATCH /api/subscriptions/:id { anchorDate }: the renewal month cannot change in history
      const subscription = pick(world.subscriptions, raw.a);
      if (!subscription) return null;
      const oldMonth = Number(subscription.anchorDate.slice(5, 7));
      const newMonth = raw.flag && raw.c % 3 === 0 ? oldMonth : within(raw.b, 1, 12); // sometimes only the day changes
      const anchorDate = `2027-${two(newMonth)}-${two(within(raw.c, 1, 28))}`;
      const refused =
        subscription.frequency === 'yearly' &&
        newMonth !== oldMonth &&
        subscription.startMonth < current;
      return {
        label: `change the anchor of subscription ${subscription.id} (${subscription.frequency}, ${subscription.anchorDate}) to ${anchorDate}`,
        method: 'patch',
        path: `/api/subscriptions/${subscription.id}`,
        body: { anchorDate },
        expected: refused ? rule('renewal_month_in_history') : ok(),
        effect: (w) => {
          w.subscriptions.find((s) => s.id === subscription.id)!.anchorDate = anchorDate;
        },
      };
    }
    case 16: {
      // PUT /api/subscriptions/:id/prices/:month
      const subscription = pick(world.subscriptions, raw.a);
      if (!subscription) return null;
      const m = near(raw.c, [subscription.startMonth, subscription.endMonth], month(raw.b));
      return {
        label: `put a price of subscription ${subscription.id} (${subscription.startMonth}..${subscription.endMonth}) at ${m}`,
        method: 'put',
        path: `/api/subscriptions/${subscription.id}/prices/${m}`,
        body: { amount: raw.amount },
        expected: inRange(subscription, m) ? ok() : rule('outside_active_months'),
        effect: (w) => {
          const target = w.subscriptions.find((s) => s.id === subscription.id)!;
          target.prices = upsertRow(target.prices, { effectiveMonth: m, amount: raw.amount });
        },
      };
    }
    case 17: {
      // POST /api/subscriptions/:id/cancel
      const subscription = pick(world.subscriptions, raw.a);
      if (!subscription) return null;
      // An end month just before the latest price leaves that price after the end (inert).
      const latestPrice = subscription.prices
        .map((p) => p.effectiveMonth)
        .sort()
        .at(-1);
      const end = raw.flag
        ? raw.c % 2 === 1 && latestPrice
          ? monthKey(monthIndex(latestPrice) - 1)
          : near(
              raw.c,
              [
                subscription.startMonth,
                current,
                ...subscription.prices.map((p) => p.effectiveMonth),
              ],
              month(raw.b),
            )
        : current;
      return {
        label: `cancel subscription ${subscription.id} (${subscription.startMonth}..${subscription.endMonth}) with end ${end}`,
        method: 'post',
        path: `/api/subscriptions/${subscription.id}/cancel`,
        body: raw.flag ? { endMonth: end } : {},
        expected: end < subscription.startMonth ? rule('end_before_start') : ok(),
        effect: (w) => {
          w.subscriptions.find((s) => s.id === subscription.id)!.endMonth = end;
        },
      };
    }
    case 18: {
      const subscription = pick(world.subscriptions, raw.a);
      if (!subscription) return null;
      return {
        label: `delete subscription ${subscription.id}`,
        method: 'delete',
        path: `/api/subscriptions/${subscription.id}`,
        expected: ok(204),
        effect: (w) => {
          w.subscriptions = w.subscriptions.filter((s) => s.id !== subscription.id);
        },
      };
    }
    case 19: {
      // PUT /api/settings: start_month_in_future, start_month_after_facts
      const earliest = earliestFact();
      const newStart = near(raw.c, [earliest, start, current], month(raw.b));
      const percent = within(raw.c, 1, 100);
      const expected =
        newStart > current
          ? rule('start_month_in_future')
          : newStart > start && earliest !== null && earliest < newStart
            ? rule('start_month_after_facts')
            : ok();
      return {
        label: `put the settings with start ${newStart} (from ${start}) and warning ${percent}%`,
        method: 'put',
        path: '/api/settings',
        body: {
          currency: 'EUR',
          locale: 'en-US',
          startMonth: newStart,
          theme: 'system',
          alertWarnPercent: percent,
        },
        expected,
        effect: (w) => {
          w.settings = { startMonth: newStart, alertWarnPercent: percent };
        },
      };
    }
    case 20: {
      // The clock moves on, by up to about two months
      const next = new Date(`${today}T12:00:00Z`);
      next.setUTCDate(next.getUTCDate() + within(raw.b, 1, 70));
      return {
        label: `the clock moves to ${next.toISOString().slice(0, 10)}`,
        clock: next.toISOString(),
      };
    }
    case 21: {
      // PATCH /api/budgets/:id: order, name and the warning threshold (labels, never money)
      const budget = pick(world.budgets, raw.a);
      if (!budget) return null;
      const change = {
        sortOrder: within(raw.b, 0, 50),
        alertWarnPercent: raw.flag ? null : within(raw.c, 1, 100),
        name: `Renamed ${raw.a}`,
      };
      return {
        label: `patch budget ${budget.id} (${JSON.stringify(change)})`,
        method: 'patch',
        path: `/api/budgets/${budget.id}`,
        body: change,
        expected: ok(),
        effect: (w) =>
          Object.assign(
            w.budgets.find((b) => b.id === budget.id)!,
            change,
          ),
      };
    }
    case 22: {
      // PATCH /api/subscriptions/:id { startMonth, anchorDate } in ONE request. The rules run in the
      // documented order, and the renewal rule looks at the subscription as stored: moving the start
      // month in the same request does not lift it.
      const subscription = pick(world.subscriptions, raw.a);
      if (!subscription) return null;
      const newStart = near(
        raw.c,
        [subscription.startMonth, subscription.endMonth, current],
        month(raw.b),
      );
      const oldMonth = Number(subscription.anchorDate.slice(5, 7));
      const newMonth = within(raw.b, 1, 12);
      const anchorDate = `2027-${two(newMonth)}-${two(within(raw.c, 1, 28))}`;
      const expected =
        newStart < start
          ? rule('before_start_month')
          : subscription.endMonth !== null && newStart > subscription.endMonth
            ? rule('end_before_start')
            : subscription.frequency === 'yearly' &&
                newMonth !== oldMonth &&
                subscription.startMonth < current
              ? rule('renewal_month_in_history')
              : ok();
      return {
        label: `move subscription ${subscription.id} (${subscription.frequency}, ${subscription.startMonth}..${subscription.endMonth}, ${subscription.anchorDate}) to start ${newStart} with anchor ${anchorDate}`,
        method: 'patch',
        path: `/api/subscriptions/${subscription.id}`,
        body: { startMonth: newStart, anchorDate },
        expected,
        effect: (w) => {
          const target = w.subscriptions.find((s) => s.id === subscription.id)!;
          target.startMonth = newStart;
          target.prices = redateFirst(target.prices, newStart);
          target.anchorDate = anchorDate;
        },
      };
    }
    default: {
      const subscription = pick(world.subscriptions, raw.a);
      if (!subscription) return null;
      const change = { name: `Renamed ${raw.a % 5}` };
      return {
        label: `rename subscription ${subscription.id}`,
        method: 'patch',
        path: `/api/subscriptions/${subscription.id}`,
        body: change,
        expected: ok(),
        effect: (w) =>
          Object.assign(
            w.subscriptions.find((s) => s.id === subscription.id)!,
            change,
          ),
      };
    }
  }
}

/** How an answer reads: its status, and the rule or error code when it is an error. */
const outcomeOf = (answer: Answer): Expected => ({
  status: answer.status,
  ...(answer.body?.error?.details?.rule ? { rule: answer.body.error.details.rule } : {}),
  ...(answer.body?.error?.code && answer.status !== 422 ? { code: answer.body.error.code } : {}),
});

/** The name of each kind of operation, for the coverage report. */
const KIND_NAMES = [
  'add a spending',
  'change a spending',
  'delete a spending',
  'add an income',
  'change an income',
  'delete an income',
  'put a salary',
  'delete a salary',
  'add a budget',
  'move a budget start',
  'put a budget version',
  'archive a budget',
  'delete a budget',
  'add a subscription',
  'move a subscription start',
  'change an anchor',
  'put a price',
  'cancel a subscription',
  'delete a subscription',
  'put the settings',
  'move the clock',
  'patch a budget',
  'move a subscription start and anchor',
  'rename a subscription',
];

/** How often each outcome must have been generated (calibrated with `FC_COVERAGE=1`). */
const MINIMUM_OUTCOMES: Record<string, number> = {
  // Every rule the doc names for these operations is hit (the seed is fixed, so these counts are
  // stable), and most operations are accepted, so the stored-row and month checks have work to do.
  'outcome before_start_month': 1,
  'outcome outside_active_months': 1,
  'outcome end_before_start': 3,
  'outcome start_after_activity': 1,
  'outcome end_before_activity': 1,
  'outcome start_month_in_future': 3,
  'outcome start_month_after_facts': 1,
  'outcome renewal_month_in_history': 1,
  'outcome unknown_budget': 1,
  'outcome has_history': 3,
  'outcome not_found': 1,
  'outcome accepted': 60,
};

describe('the editing rules of docs/DOMAIN.md, through HTTP', () => {
  it(
    'every operation is accepted or refused as the doc says, a refusal changes nothing, an acceptance changes exactly the targeted rows, and the months follow the model',
    { timeout: SLOW },
    async () => {
      const seen = coverage<string>();
      await fc.assert(
        fc.asyncProperty(
          scenarioArb({ sequentialIds: true, maxMonths: 8, maxBudgets: 3, maxSubscriptions: 3 }),
          fc.array(rawOp, { minLength: 4, maxLength: 12 }),
          async (scenario, operations) => {
            const clock = mutableClock(`${scenario.today}T12:00:00Z`);
            const { app: express, db } = createTestApp(clock);
            const app = await serve(express);
            try {
              await enterFacts(app, db, scenario.facts);
              let today = scenario.today;
              let state = await readState(app, scenario.facts.transfers);
              const done: string[] = [];

              // The month list is always compared; whole views only at the end and on every other step.
              const monthsOf = async (world: World, thorough: boolean) => {
                const through = monthKey(monthIndex(today.slice(0, 7)) + 6);
                const facts = factsOf(world);
                const now = monthIndex(today.slice(0, 7)) - monthIndex(facts.startMonth);
                return monthsProblems(
                  app,
                  facts,
                  through,
                  today,
                  thorough ? [0, now, Number.MAX_SAFE_INTEGER] : [now],
                );
              };
              const fail = (problems: string[], what: string) =>
                failIfAny(problems, `${what}\n  after: ${done.join(' | ') || '(nothing yet)'}`);

              let step = 0;
              for (const raw of operations) {
                step++;
                const before = worldOf(state);
                const plan = planOperation(before, today, raw);
                if (!plan) continue;
                if ('clock' in plan) {
                  clock.set(plan.clock);
                  today = plan.clock.slice(0, 10);
                  done.push(plan.label);
                  fail(
                    await monthsOf(before, true),
                    `${plan.label}: the months differ from the model`,
                  );
                  continue;
                }
                const answer = await call(app, plan.method, plan.path, plan.body);
                const got = outcomeOf(answer);
                if (JSON.stringify(got) !== JSON.stringify(plan.expected)) {
                  throw new Error(
                    `${plan.label}: the doc says ${JSON.stringify(plan.expected)}, the API answered ${answer.status} ${JSON.stringify(answer.body)}\n  after: ${done.join(' | ') || '(nothing yet)'}`,
                  );
                }
                done.push(`${plan.label} -> ${answer.status}`);
                seen.hit(
                  `${KIND_NAMES[raw.kind % KIND_NAMES.length]}: ${got.rule ?? got.code ?? 'accepted'}`,
                );
                seen.hit(`outcome ${got.rule ?? got.code ?? 'accepted'}`);
                const after = await readState(app, scenario.facts.transfers);
                const actual = normalized(worldOf(after));
                if (answer.status >= 400) {
                  // A refusal changes nothing.
                  fail(
                    diff(actual, normalized(before), 'stored rows'),
                    `${plan.label}: a refused operation changed the stored rows`,
                  );
                } else {
                  // An acceptance changes exactly what it should: the predicted rows, and nothing else.
                  const predicted = structuredClone(before);
                  plan.effect?.(predicted, answer.body);
                  fail(
                    diff(actual, normalized(predicted), 'stored rows'),
                    `${plan.label}: the stored rows are not what the doc predicts`,
                  );
                  fail(
                    await monthsOf(worldOf(after), step % 2 === 0),
                    `${plan.label}: the months differ from the model`,
                  );
                }
                state = after;
              }
              fail(
                await monthsOf(worldOf(state), true),
                'at the end: the months differ from the model',
              );
            } finally {
              await stop(app);
            }
          },
        ),
        config(45),
      );
      seen.expectAtLeast(MINIMUM_OUTCOMES);
    },
  );
});
