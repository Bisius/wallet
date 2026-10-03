/**
 * Invariant 5 of docs/DOMAIN.md, "Causality", as properties: a fact dated in month X never changes
 * a month before X. Facts of every kind are added, edited, removed and moved on generated
 * scenarios (testing/prop-edits.ts), and the months outside the window each edit may change must
 * come out exactly as they were, field for field, with one documented exception: `alert` and
 * `warnPercent` of the budget lines. docs/DOMAIN.md ("Causality") says the warning threshold is not
 * dated, so changing `alertWarnPercent` (in the settings or per budget) relabels those two display
 * fields in every month, closed ones included, and they are excluded from invariant 5. Every money
 * figure stays in the comparison, `usagePercent` included. (None of the edits below touches a
 * threshold; the exclusion is explicit so that an edit that does would not be read as a violation.)
 *
 * On top of that, three consequences the doc spells out:
 *  - a forgotten spending lands in exactly one month's savings due: the month its budget next
 *    settles with savings (docs/DOMAIN.md, "Budgets" and "Savings");
 *  - an income lands in exactly its own month's savings due;
 *  - the three areas are independent: subscriptions come off the top of the income and budgets are
 *    fixed allocations, so a budget edit never moves a subscription line or the income, and an
 *    income or subscription edit never moves a budget line.
 */
import type { MonthBudgetLine } from '@wallet/shared';
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { config, coverage, diff, failIfAny, SLOW } from '../testing/prop';
import { type Edit, EDIT_KINDS, applyEdit, rawEditArb } from '../testing/prop-edits';
import { scenarioArb } from '../testing/prop-gen';
import { modelLedger, monthIndex } from '../testing/prop-model';
import { type LedgerMonth, computeLedger } from './ledger';

const compute = (facts: Parameters<typeof computeLedger>[0], through: string, today: string) =>
  computeLedger(facts, through, today).months;

/**
 * A month row as a string, for exact comparison, without `alert` and `warnPercent` of the budget
 * lines: the warning threshold is not dated (docs/DOMAIN.md, "Causality"), so those two display
 * fields are outside the causality guarantee. Every money figure is in.
 */
const figures = (row: LedgerMonth): string =>
  JSON.stringify({
    ...row,
    budgets: row.budgets.map(({ alert: _alert, warnPercent: _warnPercent, ...rest }) => rest),
  });

/** True when `month` is outside the months `edit` may change. */
const outsideWindow = (edit: Edit, month: string) =>
  month < edit.from || (edit.to !== null && month > edit.to);

describe('invariant 5: causality', () => {
  it(
    'a fact dated in month X never changes a month before X, whatever kind of fact it is and whether it is added, edited, removed or moved',
    { timeout: SLOW },
    () => {
      const seen = coverage<string>();
      fc.assert(
        fc.property(scenarioArb(), rawEditArb, (scenario, raw) => {
          const edit = applyEdit(scenario, raw);
          if (!edit) return;
          const base = compute(scenario.facts, scenario.through, scenario.today);
          const edited = compute(edit.facts, scenario.through, scenario.today);
          const problems: string[] = [];
          let changedInside = false;
          base.forEach((row, index) => {
            // The same code builds both rows, so equal rows are equal strings (and it is fast).
            const same = figures(row) === figures(edited[index]!);
            if (outsideWindow(edit, row.month)) {
              if (!same) {
                problems.push(
                  ...diff(
                    edited[index],
                    row,
                    `${row.month} (outside ${edit.from}..${edit.to ?? 'the end'})`,
                    3,
                  ),
                );
              }
            } else if (!same) changedInside = true;
          });
          failIfAny(problems, `${edit.kind}: a month outside its window changed`);
          seen.hit(edit.kind);
          if (changedInside) seen.hit(`${edit.kind}, and it changes something`);
        }),
        config(3000),
      );
      // Every kind of edit was applied often, and each one moves something (the property is not vacuous).
      const minimums: Record<string, number> = {};
      for (const kind of EDIT_KINDS) {
        minimums[kind] = 25;
        minimums[`${kind}, and it changes something`] = 8;
      }
      seen.expectAtLeast(minimums);
    },
  );

  it(
    'the months before X are exact for an edit dated X even when X is the current month or later: today does not matter',
    { timeout: SLOW },
    () => {
      fc.assert(
        fc.property(
          scenarioArb(),
          rawEditArb,
          fc.integer({ min: 0, max: 60 }),
          (scenario, raw, todayPick) => {
            const edit = applyEdit(scenario, raw);
            if (!edit) return;
            const span = monthIndex(scenario.through) - monthIndex(scenario.facts.startMonth) + 2;
            const start = monthIndex(scenario.facts.startMonth) + (todayPick % span);
            const today = `${String(Math.floor(start / 12)).padStart(4, '0')}-${String((start % 12) + 1).padStart(2, '0')}-10`;
            const base = compute(scenario.facts, scenario.through, today);
            const edited = compute(edit.facts, scenario.through, today);
            const problems: string[] = [];
            base.forEach((row, index) => {
              if (outsideWindow(edit, row.month) && figures(row) !== figures(edited[index]!)) {
                problems.push(...diff(edited[index], row, row.month, 3));
              }
            });
            failIfAny(problems, `${edit.kind} with today ${today}`);
          },
        ),
        config(1500),
      );
    },
  );
});

describe('where a late edit lands', () => {
  it(
    "a forgotten spending lands in exactly one month's savings due: the month its budget next settles, and every month between carries it",
    { timeout: SLOW },
    () => {
      const seen = coverage<
        'settles in a later month' | 'settles in its own month' | 'never settles' | 'refund'
      >();
      fc.assert(
        fc.property(
          scenarioArb(),
          fc.integer({ min: 0, max: 9_999 }),
          fc.integer({ min: 0, max: 9_999 }),
          fc.integer({ min: 1, max: 300_000 }),
          fc.boolean(),
          (scenario, budgetPick, monthPick, amount, refund) => {
            const edit = applyEdit(scenario, {
              kind: 5,
              a: budgetPick,
              b: monthPick,
              c: 0,
              amount,
              flag: refund,
            });
            if (!edit) return;
            const added = edit.facts.spendings.at(-1)!;
            const s = BigInt(added.amount);
            const base = compute(scenario.facts, scenario.through, scenario.today);
            const edited = compute(edit.facts, scenario.through, scenario.today);
            // The model says where the money lands: the first month, from the spending's month on,
            // in which the budget's mode is non-incremental or the month is its end month.
            const model = modelLedger(scenario.facts, scenario.through, scenario.today);
            let settles: string | null = null;
            for (const row of model) {
              if (row.view.month < added.month) continue;
              const line = row.view.budgets.find((b) => b.id === added.budgetId);
              if (!line) break;
              if (!line.incremental || line.endsThisMonth) {
                settles = row.view.month;
                break;
              }
            }
            seen.hit(
              settles === null
                ? 'never settles'
                : settles === added.month
                  ? 'settles in its own month'
                  : 'settles in a later month',
            );
            if (added.amount < 0) seen.hit('refund');

            const problems: string[] = [];
            base.forEach((row, index) => {
              const after = edited[index]!;
              const inRange =
                row.month >= added.month && (settles === null || row.month <= settles);
              // Nothing outside the budget's line moves, in any month: the income, the fixed costs,
              // the subscriptions, the unallocated and every other budget.
              const expectedBudgets = row.budgets.map((b): MonthBudgetLine => {
                if (b.id !== added.budgetId || !inRange) return b;
                const carrying = row.month !== settles;
                const lands = row.month === settles;
                return {
                  ...b,
                  spent: b.spent + (row.month === added.month ? Number(s) : 0),
                  carriedIn: b.carriedIn - (row.month === added.month ? 0 : Number(s)),
                  available: b.available - (row.month === added.month ? 0 : Number(s)),
                  remaining: b.remaining - Number(s),
                  carriedOut:
                    carrying && b.incremental && !b.endsThisMonth
                      ? b.carriedOut - Number(s)
                      : b.carriedOut,
                  toSavings: lands ? b.toSavings - Number(s) : b.toSavings,
                };
              });
              const strip = (lines: readonly MonthBudgetLine[]) =>
                lines.map((b) => ({
                  ...b,
                  usagePercent: undefined,
                  alert: undefined,
                  warnPercent: undefined,
                }));
              problems.push(
                ...diff(strip(after.budgets), strip(expectedBudgets), `${row.month} budgets`),
              );
              const changesTotals =
                row.month === added.month || (inRange && row.month > added.month);
              problems.push(
                ...diff(
                  {
                    income: after.income,
                    fixedCosts: after.fixedCosts,
                    subscriptions: after.subscriptions,
                    unallocated: after.unallocated,
                    allocated: after.totals.allocated,
                    transfersNet: after.totals.transfersNet,
                    spent: after.totals.spent,
                    remaining: after.totals.remaining,
                    budgetsSettled: after.savingsDue.budgetsSettled,
                    total: after.savingsDue.total,
                    reservesReleased: after.savingsDue.reservesReleased,
                  },
                  {
                    income: row.income,
                    fixedCosts: row.fixedCosts,
                    subscriptions: row.subscriptions,
                    unallocated: row.unallocated,
                    allocated: row.totals.allocated,
                    transfersNet: row.totals.transfersNet,
                    spent: row.totals.spent + (row.month === added.month ? Number(s) : 0),
                    remaining: row.totals.remaining - (changesTotals ? Number(s) : 0),
                    budgetsSettled:
                      row.savingsDue.budgetsSettled - (row.month === settles ? Number(s) : 0),
                    total: row.savingsDue.total - (row.month === settles ? Number(s) : 0),
                    reservesReleased: row.savingsDue.reservesReleased,
                  },
                  `${row.month}`,
                ),
              );
            });
            // The usage and the alert are consistent with the new figures.
            for (const row of edited) {
              const line = row.budgets.find((b) => b.id === added.budgetId);
              if (!line) continue;
              const usage =
                line.available > 0
                  ? line.spent > 0
                    ? Number((100n * BigInt(line.spent)) / BigInt(line.available))
                    : 0
                  : null;
              if (line.usagePercent !== usage)
                problems.push(`${row.month}: usagePercent ${line.usagePercent}, expected ${usage}`);
              if ((line.alert === 'over') !== line.spent > line.available)
                problems.push(`${row.month}: alert ${line.alert}`);
            }
            failIfAny(
              problems,
              `a spending of ${added.amount} in ${added.month} on budget ${added.budgetId} (settles in ${settles})`,
            );
          },
        ),
        config(3000),
      );
      seen.expectAtLeast({
        'settles in a later month': 200,
        'settles in its own month': 200,
        'never settles': 200,
        refund: 200,
      });
    },
  );

  it(
    "an income lands in exactly its own month's savings due and moves nothing else",
    { timeout: SLOW },
    () => {
      fc.assert(
        fc.property(
          scenarioArb(),
          fc.integer({ min: 0, max: 9_999 }),
          fc.integer({ min: 1, max: 900_000 }),
          (scenario, monthPick, amount) => {
            const edit = applyEdit(scenario, {
              kind: 2,
              a: monthPick,
              b: 0,
              c: 0,
              amount,
              flag: false,
            });
            if (!edit) return;
            const month = edit.facts.incomes.at(-1)!.month;
            const base = compute(scenario.facts, scenario.through, scenario.today);
            const edited = compute(edit.facts, scenario.through, scenario.today);
            const expected = base.map((row) =>
              row.month !== month
                ? row
                : {
                    ...row,
                    income: {
                      ...row.income,
                      extra: row.income.extra + amount,
                      total: row.income.total + amount,
                    },
                    unallocated: row.unallocated + amount,
                    overAllocated: row.unallocated + amount < 0,
                    savingsDue: {
                      ...row.savingsDue,
                      unallocated: row.savingsDue.unallocated + amount,
                      total: row.savingsDue.total + amount,
                    },
                  },
            );
            failIfAny(diff(edited, expected), `an income of ${amount} in ${month}`);
          },
        ),
        config(1500),
      );
    },
  );
});

describe('the three areas are independent', () => {
  it(
    'a budget, spending or transfer edit never moves the income, the fixed costs or a subscription line; an income or subscription edit never moves a budget line',
    { timeout: SLOW },
    () => {
      fc.assert(
        fc.property(scenarioArb(), rawEditArb, (scenario, raw) => {
          const edit = applyEdit(scenario, raw);
          if (!edit) return;
          const base = compute(scenario.facts, scenario.through, scenario.today);
          const edited = compute(edit.facts, scenario.through, scenario.today);
          const problems: string[] = [];
          base.forEach((row, index) => {
            const after = edited[index]!;
            if (edit.area === 'budgets') {
              problems.push(
                ...diff(
                  {
                    income: after.income,
                    fixedCosts: after.fixedCosts,
                    subscriptions: after.subscriptions,
                    paid: after.subscriptionPayments,
                    held: after.heldInReserves,
                  },
                  {
                    income: row.income,
                    fixedCosts: row.fixedCosts,
                    subscriptions: row.subscriptions,
                    paid: row.subscriptionPayments,
                    held: row.heldInReserves,
                  },
                  row.month,
                ),
              );
            } else {
              // A budget line is a function of its own allocation, spendings and transfers only.
              // (Adding or deleting a budget is the budgets area, so the lines may differ there.)
              problems.push(
                ...diff(
                  {
                    budgets: after.budgets,
                    totals: after.totals,
                    settled: after.savingsDue.budgetsSettled,
                    held: after.heldInBudgets,
                  },
                  {
                    budgets: row.budgets,
                    totals: row.totals,
                    settled: row.savingsDue.budgetsSettled,
                    held: row.heldInBudgets,
                  },
                  row.month,
                ),
              );
            }
          });
          failIfAny(problems, `${edit.kind} (area ${edit.area}) moved a line of another area`);
        }),
        config(3000),
      );
    },
  );
});
