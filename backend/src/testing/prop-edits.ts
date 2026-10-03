/**
 * Edits to a scenario's facts for the causality properties (docs/DOMAIN.md, "Causality"): every kind
 * of fact added, edited, removed or moved, each with the window of months it is allowed to change.
 *
 * An `Edit` carries `from` and `to`: the months OUTSIDE `from..to` (before `from`, after `to` when
 * `to` is not null) must come out exactly as they were. For a fact dated in month X that is
 * `from = X, to = null`: it moves X and what comes after it, never what comes before. The windows of
 * the explicit moves (an end month, a start month) are the exact ones the doc implies:
 *
 *  - an end month moved from E to E' changes `min(E, E')..max(E, E')` (to the end when one of them is
 *    "never"): before it the item is computed as if it went on, after it the item is not there in
 *    either version;
 *  - a start month moved from S to S' changes `min(S, S')` on. For a monthly subscription only up to
 *    `max(S, S') - 1`; for a yearly one only up to its first renewal on or after `max(S, S')`,
 *    because the reserve is exactly 0 after every renewal, whatever came before.
 *
 * `alertWarnPercent` (in the settings or per budget) is not an edit here on purpose: the warning
 * threshold is not dated, so changing it relabels `alert` and `warnPercent` in every month, and
 * those two fields are excluded from the causality guarantee (docs/DOMAIN.md, "Causality").
 *
 * The edits obey the rules the API enforces (a spending inside its budget's active months, an end
 * month not before the last spending or transfer, a start month not after the first one, the first
 * version or price re-dated when a start moves before it, ...), so each is something a user can do.
 */
import fc from 'fast-check';
import type { BudgetFact, Facts, SubscriptionFact } from '../domain/facts';
import { type Scenario, within } from './prop-gen';
import { monthIndex, monthKey } from './prop-model';

export interface RawEdit {
  kind: number;
  a: number;
  b: number;
  c: number;
  amount: number;
  flag: boolean;
}

export const rawEditArb: fc.Arbitrary<RawEdit> = fc.record({
  kind: fc.integer({ min: 0, max: 22 }),
  a: fc.integer({ min: 0, max: 9_999 }),
  b: fc.integer({ min: 0, max: 9_999 }),
  c: fc.integer({ min: 0, max: 9_999 }),
  amount: fc.oneof(
    { weight: 4, arbitrary: fc.integer({ min: 1, max: 5_000 }) },
    { weight: 4, arbitrary: fc.integer({ min: 1, max: 200_000 }) },
    { weight: 1, arbitrary: fc.integer({ min: 1, max: 5_000_000 }) },
  ),
  flag: fc.boolean(),
});

/** Which part of the ledger an edit may touch. */
export type EditArea = 'income' | 'budgets' | 'subscriptions';

export interface Edit {
  kind: string;
  area: EditArea;
  facts: Facts;
  /** The first month the edit may change. */
  from: string;
  /** The last month it may change; null: it has no upper bound. */
  to: string | null;
}

/** The names of the edit kinds, indexed by `RawEdit.kind`. */
export const EDIT_KINDS = [
  'a salary row added or replaced',
  'a salary row deleted',
  'an income added',
  'an income deleted',
  'an income changed or moved',
  'a spending added',
  'a spending deleted',
  'a spending changed',
  'a spending moved to another month',
  'a transfer added',
  'a transfer deleted',
  'a budget version added or replaced',
  'a budget version deleted',
  'a subscription price added or replaced',
  'a subscription price deleted',
  'a budget added',
  'a subscription added',
  'a subscription deleted',
  'a budget deleted',
  'a budget end month moved',
  'a subscription end month moved',
  'a budget start month moved',
  'a subscription start month moved',
] as const;

/** `rows` with the row of `month` replaced by `row`, or `row` added. */
function upsert<T extends { effectiveMonth: string }>(rows: readonly T[], row: T): T[] {
  return [...rows.filter((r) => r.effectiveMonth !== row.effectiveMonth), row];
}

/** Moving a start month before the first row re-dates that row, nothing else (docs/DOMAIN.md). */
function redateFirstRow<T extends { effectiveMonth: string }>(
  rows: readonly T[],
  newStart: number,
): T[] {
  const sorted = [...rows].sort(
    (a, b) => monthIndex(a.effectiveMonth) - monthIndex(b.effectiveMonth),
  );
  const first = sorted[0];
  if (!first || monthIndex(first.effectiveMonth) <= newStart) return [...rows];
  return rows.map((row) => (row === first ? { ...row, effectiveMonth: monthKey(newStart) } : row));
}

const spentMonths = (facts: Facts, budgetId: number): number[] =>
  facts.spendings.filter((s) => s.budgetId === budgetId).map((s) => monthIndex(s.month));
const transferMonths = (facts: Facts, budgetId: number): number[] =>
  facts.transfers
    .filter((t) => t.fromBudgetId === budgetId || t.toBudgetId === budgetId)
    .map((t) => monthIndex(t.month));

/** The first renewal month at or after `month`, for an anchor in `renewalMonthOfYear` (1 to 12). */
const firstRenewalFrom = (month: number, renewalMonthOfYear: number): number =>
  month + ((renewalMonthOfYear - ((month % 12) + 1) + 12) % 12);

/**
 * Applies the edit `raw` describes to the scenario's facts, or returns null when the scenario has
 * nothing the edit could apply to (no budget to spend on, no income to delete, ...).
 */
export function applyEdit(scenario: Scenario, raw: RawEdit): Edit | null {
  const { facts } = scenario;
  const first = monthIndex(facts.startMonth);
  const last = monthIndex(scenario.through);
  const kind = EDIT_KINDS[raw.kind] ?? EDIT_KINDS[0];
  const month = (selector: number, low = first, high = last): number => within(selector, low, high);
  const edit = (
    area: EditArea,
    changes: Partial<Facts>,
    from: number,
    to: number | null,
  ): Edit => ({
    kind,
    area,
    facts: { ...facts, ...changes },
    from: monthKey(from),
    to: to === null ? null : monthKey(to),
  });
  const pick = <T>(items: readonly T[], selector: number): [T, number] | null =>
    items.length === 0 ? null : [items[selector % items.length]!, selector % items.length];
  const signed = (amount: number) => (raw.flag ? -(1 + (amount % 5_000)) : amount);
  const withoutIndex = <T>(items: readonly T[], index: number): T[] =>
    items.filter((_, i) => i !== index);
  const lastActive = (item: { endMonth: string | null }) =>
    item.endMonth === null ? last : monthIndex(item.endMonth);
  const activeAt = (item: BudgetFact, m: number) =>
    monthIndex(item.startMonth) <= m && (item.endMonth === null || m <= monthIndex(item.endMonth));
  const replaceBudget = (old: BudgetFact, next: BudgetFact) =>
    facts.budgets.map((b) => (b === old ? next : b));
  const replaceSubscription = (old: SubscriptionFact, next: SubscriptionFact) =>
    facts.subscriptions.map((s) => (s === old ? next : s));

  switch (raw.kind) {
    case 0: {
      const x = month(raw.a);
      const row = { effectiveMonth: monthKey(x), amount: raw.flag ? 0 : raw.amount };
      return edit('income', { salary: upsert(facts.salary, row) }, x, null);
    }
    case 1: {
      const found = pick(facts.salary, raw.a);
      if (!found) return null;
      return edit(
        'income',
        { salary: withoutIndex(facts.salary, found[1]) },
        monthIndex(found[0].effectiveMonth),
        null,
      );
    }
    case 2: {
      const x = month(raw.a);
      return edit(
        'income',
        { incomes: [...facts.incomes, { month: monthKey(x), amount: raw.amount }] },
        x,
        null,
      );
    }
    case 3: {
      const found = pick(facts.incomes, raw.a);
      if (!found) return null;
      return edit(
        'income',
        { incomes: withoutIndex(facts.incomes, found[1]) },
        monthIndex(found[0].month),
        null,
      );
    }
    case 4: {
      const found = pick(facts.incomes, raw.a);
      if (!found) return null;
      const old = monthIndex(found[0].month);
      const moved = raw.flag ? month(raw.b) : old;
      const incomes = facts.incomes.map((i, index) =>
        index === found[1] ? { month: monthKey(moved), amount: raw.amount } : i,
      );
      return edit('income', { incomes }, Math.min(old, moved), null);
    }
    case 5: {
      const found = pick(facts.budgets, raw.a);
      if (!found) return null;
      const budget = found[0];
      const x = month(raw.b, monthIndex(budget.startMonth), lastActive(budget));
      const spendings = [
        ...facts.spendings,
        { budgetId: budget.id, month: monthKey(x), amount: signed(raw.amount) },
      ];
      return edit('budgets', { spendings }, x, null);
    }
    case 6: {
      const found = pick(facts.spendings, raw.a);
      if (!found) return null;
      return edit(
        'budgets',
        { spendings: withoutIndex(facts.spendings, found[1]) },
        monthIndex(found[0].month),
        null,
      );
    }
    case 7: {
      const found = pick(facts.spendings, raw.a);
      if (!found) return null;
      const spendings = facts.spendings.map((s, index) =>
        index === found[1] ? { ...s, amount: signed(raw.amount) } : s,
      );
      return edit('budgets', { spendings }, monthIndex(found[0].month), null);
    }
    case 8: {
      const found = pick(facts.spendings, raw.a);
      if (!found) return null;
      const budget = facts.budgets.find((b) => b.id === found[0].budgetId);
      if (!budget) return null;
      const old = monthIndex(found[0].month);
      const moved = month(raw.b, monthIndex(budget.startMonth), lastActive(budget));
      const spendings = facts.spendings.map((s, index) =>
        index === found[1] ? { ...s, month: monthKey(moved) } : s,
      );
      return edit('budgets', { spendings }, Math.min(old, moved), null);
    }
    case 9: {
      const x = month(raw.a);
      const active = facts.budgets.filter((b) => activeAt(b, x));
      if (active.length === 0) return null;
      const from = active[raw.b % active.length]!;
      const others = active.filter((b) => b.id !== from.id);
      const sides =
        raw.c % 3 === 0 || others.length === 0
          ? { fromBudgetId: null, toBudgetId: from.id }
          : raw.c % 3 === 1
            ? { fromBudgetId: from.id, toBudgetId: null }
            : { fromBudgetId: from.id, toBudgetId: others[raw.a % others.length]!.id };
      const transfers = [...facts.transfers, { month: monthKey(x), amount: raw.amount, ...sides }];
      return edit('budgets', { transfers }, x, null);
    }
    case 10: {
      const found = pick(facts.transfers, raw.a);
      if (!found) return null;
      return edit(
        'budgets',
        { transfers: withoutIndex(facts.transfers, found[1]) },
        monthIndex(found[0].month),
        null,
      );
    }
    case 11: {
      const found = pick(facts.budgets, raw.a);
      if (!found) return null;
      const budget = found[0];
      const x = month(raw.b, monthIndex(budget.startMonth), lastActive(budget));
      const row = {
        effectiveMonth: monthKey(x),
        amount: raw.flag ? 0 : raw.amount,
        incremental: raw.c % 2 === 0,
      };
      return edit(
        'budgets',
        { budgets: replaceBudget(budget, { ...budget, versions: upsert(budget.versions, row) }) },
        x,
        null,
      );
    }
    case 12: {
      const candidates = facts.budgets.flatMap((b) =>
        b.versions
          .filter((v) => monthIndex(v.effectiveMonth) > monthIndex(b.startMonth))
          .map((v) => [b, v] as const),
      );
      const found = pick(candidates, raw.a);
      if (!found) return null;
      const [budget, version] = found[0];
      return edit(
        'budgets',
        {
          budgets: replaceBudget(budget, {
            ...budget,
            versions: budget.versions.filter((v) => v !== version),
          }),
        },
        monthIndex(version.effectiveMonth),
        null,
      );
    }
    case 13: {
      const found = pick(facts.subscriptions, raw.a);
      if (!found) return null;
      const subscription = found[0];
      const x = month(raw.b, monthIndex(subscription.startMonth), lastActive(subscription));
      const row = { effectiveMonth: monthKey(x), amount: Math.max(1, raw.amount) };
      return edit(
        'subscriptions',
        {
          subscriptions: replaceSubscription(subscription, {
            ...subscription,
            prices: upsert(subscription.prices, row),
          }),
        },
        x,
        null,
      );
    }
    case 14: {
      const candidates = facts.subscriptions.flatMap((s) =>
        s.prices
          .filter((p) => monthIndex(p.effectiveMonth) > monthIndex(s.startMonth))
          .map((p) => [s, p] as const),
      );
      const found = pick(candidates, raw.a);
      if (!found) return null;
      const [subscription, price] = found[0];
      return edit(
        'subscriptions',
        {
          subscriptions: replaceSubscription(subscription, {
            ...subscription,
            prices: subscription.prices.filter((p) => p !== price),
          }),
        },
        monthIndex(price.effectiveMonth),
        null,
      );
    }
    case 15: {
      const x = month(raw.a);
      const budget: BudgetFact = {
        id: 1 + Math.max(0, ...facts.budgets.map((b) => b.id)),
        name: 'Added budget',
        color: '#fffff0',
        icon: null,
        sortOrder: (raw.c % 4) * 10,
        startMonth: monthKey(x),
        endMonth: null,
        alertWarnPercent: null,
        versions: [{ effectiveMonth: monthKey(x), amount: raw.amount, incremental: raw.flag }],
      };
      return edit('budgets', { budgets: [...facts.budgets, budget] }, x, null);
    }
    case 16: {
      const x = month(raw.a);
      const subscription: SubscriptionFact = {
        id: 1 + Math.max(0, ...facts.subscriptions.map((s) => s.id)),
        name: 'Added subscription',
        color: '#fffff1',
        frequency: raw.flag ? 'yearly' : 'monthly',
        anchorDate: `2025-${String(within(raw.b, 1, 12)).padStart(2, '0')}-15`,
        startMonth: monthKey(x),
        endMonth: null,
        prices: [{ effectiveMonth: monthKey(x), amount: raw.amount }],
      };
      return edit(
        'subscriptions',
        { subscriptions: [...facts.subscriptions, subscription] },
        x,
        null,
      );
    }
    case 17: {
      const found = pick(facts.subscriptions, raw.a);
      if (!found) return null;
      return edit(
        'subscriptions',
        { subscriptions: withoutIndex(facts.subscriptions, found[1]) },
        monthIndex(found[0].startMonth),
        null,
      );
    }
    case 18: {
      // A budget can only be deleted without history: no spendings, no transfers.
      const deletable = facts.budgets.filter(
        (b) => spentMonths(facts, b.id).length === 0 && transferMonths(facts, b.id).length === 0,
      );
      const found = pick(deletable, raw.a);
      if (!found) return null;
      return edit(
        'budgets',
        { budgets: facts.budgets.filter((b) => b !== found[0]) },
        monthIndex(found[0].startMonth),
        null,
      );
    }
    case 19: {
      const found = pick(facts.budgets, raw.a);
      if (!found) return null;
      const budget = found[0];
      // "An endMonth can't be before the budget's startMonth or before its latest spending or transfer."
      const lowest = Math.max(
        monthIndex(budget.startMonth),
        ...spentMonths(facts, budget.id),
        ...transferMonths(facts, budget.id),
      );
      const end = month(raw.b, lowest, Math.max(lowest, last));
      const old = budget.endMonth === null ? null : monthIndex(budget.endMonth);
      return edit(
        'budgets',
        { budgets: replaceBudget(budget, { ...budget, endMonth: monthKey(end) }) },
        old === null ? end : Math.min(old, end),
        old === null ? null : Math.max(old, end),
      );
    }
    case 20: {
      const found = pick(facts.subscriptions, raw.a);
      if (!found) return null;
      const subscription = found[0];
      const end = month(raw.b, monthIndex(subscription.startMonth), last);
      const old = subscription.endMonth === null ? null : monthIndex(subscription.endMonth);
      return edit(
        'subscriptions',
        {
          subscriptions: replaceSubscription(subscription, {
            ...subscription,
            endMonth: monthKey(end),
          }),
        },
        old === null ? end : Math.min(old, end),
        old === null ? null : Math.max(old, end),
      );
    }
    case 21: {
      const found = pick(facts.budgets, raw.a);
      if (!found) return null;
      const budget = found[0];
      // "A budget's startMonth can't be moved past its earliest spending or transfer, or its endMonth."
      const highest = Math.min(
        lastActive(budget),
        ...spentMonths(facts, budget.id),
        ...transferMonths(facts, budget.id),
      );
      const start = month(raw.b, first, Math.max(first, highest));
      const old = monthIndex(budget.startMonth);
      return edit(
        'budgets',
        {
          budgets: replaceBudget(budget, {
            ...budget,
            startMonth: monthKey(start),
            versions: redateFirstRow(budget.versions, start),
          }),
        },
        Math.min(old, start),
        null,
      );
    }
    default: {
      const found = pick(facts.subscriptions, raw.a);
      if (!found) return null;
      const subscription = found[0];
      const start = month(raw.b, first, lastActive(subscription));
      const old = monthIndex(subscription.startMonth);
      const later = Math.max(old, start);
      const end = subscription.endMonth === null ? null : monthIndex(subscription.endMonth);
      // Monthly: identical from the later start on. Yearly: identical after the first renewal at or
      // after the later start (the reserve is 0 there whatever came before), or after the end month.
      const upTo =
        subscription.frequency === 'monthly'
          ? later - 1
          : Math.min(
              firstRenewalFrom(later, Number(subscription.anchorDate.slice(5, 7))),
              end ?? Number.POSITIVE_INFINITY,
            );
      return edit(
        'subscriptions',
        {
          subscriptions: replaceSubscription(subscription, {
            ...subscription,
            startMonth: monthKey(start),
            prices: redateFirstRow(subscription.prices, start),
          }),
        },
        Math.min(old, start),
        Number.isFinite(upTo) ? upTo : null,
      );
    }
  }
}
