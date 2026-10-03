/**
 * Property-based tests (fast-check) of the ledger against docs/DOMAIN.md.
 *
 * Every property runs on generated, realistic facts (testing/prop-gen.ts) and is written against
 * the small independent model of the doc (testing/prop-model.ts) or against the doc's own
 * identities, never against the engine's code. `testing/ledger-oracle.ts` is deliberately not used.
 *
 *  - the ledger equals the model, every figure of every month (closed, current and future);
 *  - invariant 1: per budget, per month, carriedIn + allocated + transfersNet - spent = carriedOut + toSavings;
 *  - invariant 2: conservation of money from the start month to any month;
 *  - invariant 3: exact splits of a renewal cycle, and the reserve is 0 after a renewal;
 *  - invariant 4: determinism, and independence from row order and from ids;
 *  - the identities in the JSDoc of shared/src/months.ts, and a summary equals its view;
 *  - metamorphic properties the doc implies (today only labels, horizon independence, junk is
 *    ignored, entries add up, an earlier start month adds empty months, ...).
 *
 * Causality (invariant 5) is in ledger.causality.property.test.ts.
 */
import type { MonthView } from '@wallet/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonical, config, coverage, diff, failIfAny, SLOW } from '../testing/prop';
import { type Scenario, scenarioArb, shuffle, shuffleFacts, withJunk } from '../testing/prop-gen';
import { modelLedger, monthIndex, monthKey } from '../testing/prop-model';
import type { Facts } from './facts';
import {
  type Ledger,
  type LedgerMonth,
  computeLedger,
  toMonthSummary,
  toMonthView,
} from './ledger';

const big = (n: number) => BigInt(n);
const sum = (values: readonly number[]): bigint => values.reduce((a, b) => a + big(b), 0n);

/** The ledger and the model for a scenario, junk included. */
function run(scenario: Scenario, facts: Facts = withJunk(scenario)) {
  return {
    facts,
    ledger: computeLedger(facts, scenario.through, scenario.today),
    model: modelLedger(facts, scenario.through, scenario.today),
  };
}

/** A month row with the label that depends on today removed. */
const withoutStatus = (row: LedgerMonth) => ({ ...row, status: undefined });

// -------------------------------------------------------------------------------------------------
// The ledger equals the model
// -------------------------------------------------------------------------------------------------

describe('the ledger equals the independent model of docs/DOMAIN.md', () => {
  it('on every figure of every month, closed, current and future', { timeout: SLOW }, () => {
    const seen = coverage<
      | 'month'
      | 'closed'
      | 'current'
      | 'future'
      | 'monthly line'
      | 'yearly line'
      | 'yearly renewal'
      | 'reserve released at a renewal'
      | 'reserve released at the end month'
      | 'carry forward'
      | 'deficit carried'
      | 'surplus settled'
      | 'deficit taken from savings'
      | 'archived with a balance'
      | 'mode switch with a balance'
      | 'counted pool transfer'
      | 'counted budget transfer'
      | 'over'
      | 'warning'
      | 'no usage figure'
      | 'refund'
      | 'over-allocated month'
      | 'older row in effect at the start'
      | 'inert row after the end'
      | 'ignored junk'
    >();
    fc.assert(
      fc.property(scenarioArb(), (scenario) => {
        const { facts, ledger, model } = run(scenario);
        const problems: string[] = [];
        if (ledger.startMonth !== facts.startMonth)
          problems.push(`startMonth ${ledger.startMonth}`);
        if (ledger.throughMonth !== scenario.through)
          problems.push(`throughMonth ${ledger.throughMonth}`);
        if (ledger.currentMonth !== scenario.today.slice(0, 7)) {
          problems.push(`currentMonth ${ledger.currentMonth}, today ${scenario.today}`);
        }
        if (ledger.months.length !== model.length) {
          problems.push(`${ledger.months.length} months, the model has ${model.length}`);
        }
        ledger.months.forEach((row, index) => {
          const expected = model[index];
          if (!expected) return;
          problems.push(...diff(toMonthView(row), expected.view, row.month));
          problems.push(
            ...diff(
              [row.subscriptionPayments, row.heldInBudgets, row.heldInReserves],
              [expected.subscriptionPayments, expected.heldInBudgets, expected.heldInReserves],
              `${row.month} [subscriptionPayments, heldInBudgets, heldInReserves]`,
            ),
          );
        });
        failIfAny(problems, `the ledger differs from the model (today ${scenario.today})`);

        // What the generated data covered.
        let previous: LedgerMonth | undefined;
        for (const row of ledger.months) {
          seen.hit('month');
          seen.hit(row.status);
          if (row.overAllocated) seen.hit('over-allocated month');
          for (const s of row.subscriptions) {
            if (s.frequency === 'monthly') seen.hit('monthly line');
            else {
              seen.hit('yearly line');
              if (s.renewalThisMonth) seen.hit('yearly renewal');
              if (s.reserveReleased > 0 && s.renewalThisMonth)
                seen.hit('reserve released at a renewal');
              if (s.reserveReleased > 0 && s.nextRenewalMonth === null) {
                seen.hit('reserve released at the end month');
              }
            }
          }
          for (const b of row.budgets) {
            if (b.incremental && !b.endsThisMonth && b.carriedOut > 0) seen.hit('carry forward');
            if (b.incremental && !b.endsThisMonth && b.carriedOut < 0) seen.hit('deficit carried');
            if (!b.incremental && b.toSavings > 0) seen.hit('surplus settled');
            if (!b.incremental && b.toSavings < 0) seen.hit('deficit taken from savings');
            if (b.endsThisMonth && b.carriedIn !== 0) seen.hit('archived with a balance');
            if (b.alert === 'over') seen.hit('over');
            if (b.alert === 'warning') seen.hit('warning');
            if (b.usagePercent === null) seen.hit('no usage figure');
            if (b.spent < 0) seen.hit('refund');
            const before = previous?.budgets.find((p) => p.id === b.id);
            if (before?.incremental && !b.incremental && before.carriedOut !== 0) {
              seen.hit('mode switch with a balance');
            }
          }
          previous = row;
        }
        for (const t of facts.transfers) {
          const counted = ledger.months
            .find((m) => m.month === t.month)
            ?.budgets.some((b) => b.transfersNet !== 0);
          if (!counted) continue;
          seen.hit(
            t.fromBudgetId === null || t.toBudgetId === null
              ? 'counted pool transfer'
              : 'counted budget transfer',
          );
        }
        for (const b of facts.budgets) {
          if (
            b.versions.every((v) => v.effectiveMonth < b.startMonth) ||
            (b.versions.some((v) => v.effectiveMonth < b.startMonth) &&
              !b.versions.some((v) => v.effectiveMonth === b.startMonth))
          ) {
            seen.hit('older row in effect at the start');
          }
          if (b.endMonth !== null && b.versions.some((v) => v.effectiveMonth > b.endMonth!)) {
            seen.hit('inert row after the end');
          }
        }
        seen.hit('ignored junk', scenario.junk.spendings.length + scenario.junk.transfers.length);
      }),
      config(1500),
    );
    seen.expectAtLeast({
      month: 20000,
      closed: 4000,
      current: 500,
      future: 4000,
      'monthly line': 3000,
      'yearly line': 3000,
      'yearly renewal': 400,
      'reserve released at a renewal': 40,
      'reserve released at the end month': 40,
      'carry forward': 1000,
      'deficit carried': 300,
      'surplus settled': 1000,
      'deficit taken from savings': 300,
      'archived with a balance': 100,
      'mode switch with a balance': 40,
      'counted pool transfer': 100,
      'counted budget transfer': 50,
      over: 500,
      warning: 300,
      'no usage figure': 100,
      refund: 300,
      'over-allocated month': 300,
      'older row in effect at the start': 100,
      'inert row after the end': 100,
      'ignored junk': 500,
    });
  });
});

// -------------------------------------------------------------------------------------------------
// Invariant 1
// -------------------------------------------------------------------------------------------------

describe('invariant 1: per budget, per month', () => {
  it(
    'carriedIn + allocated + transfersNet - spent = carriedOut + toSavings, in closed, current and future months',
    { timeout: SLOW },
    () => {
      fc.assert(
        fc.property(scenarioArb(), (scenario) => {
          const { ledger } = run(scenario);
          const problems: string[] = [];
          for (const row of ledger.months) {
            for (const b of row.budgets) {
              const left = big(b.carriedIn) + big(b.allocated) + big(b.transfersNet) - big(b.spent);
              const right = big(b.carriedOut) + big(b.toSavings);
              if (left !== right) {
                problems.push(`${row.month} budget ${b.id} (${row.status}): ${left} != ${right}`);
              }
            }
          }
          failIfAny(problems, 'invariant 1 broken');
        }),
        config(1500),
      );
    },
  );
});

// -------------------------------------------------------------------------------------------------
// Invariant 2
// -------------------------------------------------------------------------------------------------

describe('invariant 2: conservation of money', () => {
  it(
    'income = spendings + subscription charges paid + savings due + held in incremental budgets + held in reserves, from the start month to any month',
    { timeout: SLOW },
    () => {
      fc.assert(
        fc.property(scenarioArb(), (scenario) => {
          const { facts, ledger, model } = run(scenario);
          const problems: string[] = [];
          let income = 0n;
          let spendings = 0n;
          let paid = 0n;
          let savingsDue = 0n;
          ledger.months.forEach((row, index) => {
            const month = monthIndex(row.month);
            // The income, straight from the facts: the latest salary row at or before the month,
            // plus the incomes dated in it.
            const rows = facts.salary.filter((s) => monthIndex(s.effectiveMonth) <= month);
            const latest = rows.reduce<(typeof rows)[number] | undefined>(
              (best, s) =>
                best === undefined || monthIndex(s.effectiveMonth) > monthIndex(best.effectiveMonth)
                  ? s
                  : best,
              undefined,
            );
            income += big(latest?.amount ?? 0);
            income += sum(
              facts.incomes.filter((i) => monthIndex(i.month) === month).map((i) => i.amount),
            );
            // The spendings the ledger counts: those of a budget in a month it is active.
            for (const budget of facts.budgets) {
              const active =
                monthIndex(budget.startMonth) <= month &&
                (budget.endMonth === null || month <= monthIndex(budget.endMonth));
              if (!active) continue;
              spendings += sum(
                facts.spendings
                  .filter((s) => s.budgetId === budget.id && monthIndex(s.month) === month)
                  .map((s) => s.amount),
              );
            }
            // What was paid to the providers and what is held come from the model; the savings due
            // is the engine's own figure, which is what this property is about.
            paid += big(model[index]!.subscriptionPayments);
            savingsDue += big(row.savingsDue.total);
            const held = big(model[index]!.heldInBudgets) + big(model[index]!.heldInReserves);
            const accountedFor = spendings + paid + savingsDue + held;
            if (income !== accountedFor) {
              problems.push(
                `through ${row.month}: income ${income} != spent ${spendings} + paid ${paid} + due ${savingsDue} + held ${held} (= ${accountedFor})`,
              );
            }
          });
          failIfAny(problems, 'money is not conserved');
        }),
        config(1500),
      );
    },
  );

  it(
    "the engine's own sums of what was paid and what is held agree with the model",
    { timeout: SLOW },
    () => {
      fc.assert(
        fc.property(scenarioArb(), (scenario) => {
          const { ledger, model } = run(scenario);
          const problems: string[] = [];
          ledger.months.forEach((row, index) => {
            const expected = model[index]!;
            if (row.subscriptionPayments !== expected.subscriptionPayments) {
              problems.push(
                `${row.month} paid ${row.subscriptionPayments}, expected ${expected.subscriptionPayments}`,
              );
            }
            if (row.heldInBudgets !== expected.heldInBudgets) {
              problems.push(
                `${row.month} heldInBudgets ${row.heldInBudgets}, expected ${expected.heldInBudgets}`,
              );
            }
            if (row.heldInReserves !== expected.heldInReserves) {
              problems.push(
                `${row.month} heldInReserves ${row.heldInReserves}, expected ${expected.heldInReserves}`,
              );
            }
          });
          failIfAny(problems, 'engine sums differ from the model');
        }),
        config(1000),
      );
    },
  );
});

// -------------------------------------------------------------------------------------------------
// Invariant 3
// -------------------------------------------------------------------------------------------------

describe('invariant 3: exact splits of a renewal cycle', () => {
  it(
    'the reserve is 0 after every renewal, a cycle sets aside the renewal paid plus what is released, and a constant price splits exactly',
    { timeout: SLOW },
    () => {
      const seen = coverage<
        'renewal' | 'renewal at a constant price' | 'renewal after a price change' | 'ended cycle'
      >();
      fc.assert(
        fc.property(scenarioArb(), (scenario) => {
          const { facts, ledger } = run(scenario);
          const problems: string[] = [];
          for (const subscription of facts.subscriptions) {
            if (subscription.frequency !== 'yearly') continue;
            let cycle = 0n; // what was set aside since the last renewal (the reserve is 0 where it starts)
            const prices = new Set<number>(); // the prices in effect during the cycle, from the facts
            for (const row of ledger.months) {
              const line = row.subscriptions.find((s) => s.id === subscription.id);
              if (!line) continue;
              const where = `${row.month} subscription ${line.id}`;
              const month = monthIndex(row.month);
              // The price from the facts: the row with the latest month not after this one.
              const rows = subscription.prices.filter((p) => monthIndex(p.effectiveMonth) <= month);
              const inEffect = rows.reduce<(typeof rows)[number] | undefined>(
                (best, p) =>
                  best === undefined ||
                  monthIndex(p.effectiveMonth) > monthIndex(best.effectiveMonth)
                    ? p
                    : best,
                undefined,
              );
              prices.add(inEffect?.amount ?? 0);
              cycle += big(line.charge);
              if (line.reserveBalance < 0)
                problems.push(`${where}: negative reserve ${line.reserveBalance}`);

              if (line.renewalThisMonth) {
                seen.hit('renewal');
                // "In every case the reserve is exactly 0 after a renewal: what a cycle sets aside
                // is the renewal paid plus what is released."
                if (line.reserveBalance !== 0)
                  problems.push(`${where}: reserve ${line.reserveBalance} after the renewal`);
                if (cycle !== big(line.price) + big(line.reserveReleased)) {
                  problems.push(
                    `${where}: set aside ${cycle} != renewal ${line.price} + released ${line.reserveReleased}`,
                  );
                }
                if (prices.size === 1) {
                  // "With a constant price the contributions of a cycle add up to the price exactly."
                  seen.hit('renewal at a constant price');
                  if (cycle !== big(line.price)) {
                    problems.push(
                      `${where}: constant price ${line.price}, contributions add up to ${cycle}`,
                    );
                  }
                  if (line.reserveReleased !== 0) {
                    problems.push(`${where}: constant price but released ${line.reserveReleased}`);
                  }
                } else seen.hit('renewal after a price change');
                cycle = 0n;
                prices.clear();
              } else if (line.nextRenewalMonth === null) {
                // The end month with the next renewal after it: nothing more is set aside, and
                // everything set aside before is released. Nothing is lost.
                seen.hit('ended cycle');
                if (line.charge !== 0)
                  problems.push(`${where}: sets aside ${line.charge} with no renewal left`);
                if (line.reserveBalance !== 0)
                  problems.push(`${where}: still holds ${line.reserveBalance}`);
                if (cycle !== big(line.reserveReleased)) {
                  problems.push(
                    `${where}: set aside ${cycle} but released ${line.reserveReleased}`,
                  );
                }
                cycle = 0n;
                prices.clear();
              }
            }
          }
          failIfAny(problems, 'invariant 3 broken');
        }),
        config(2000),
      );
      seen.expectAtLeast({
        renewal: 1000,
        'renewal at a constant price': 500,
        'renewal after a price change': 200,
        'ended cycle': 200,
      });
    },
  );
});

// -------------------------------------------------------------------------------------------------
// Invariant 4
// -------------------------------------------------------------------------------------------------

describe('invariant 4: determinism and independence from the order of rows and from ids', () => {
  it('computing twice from the same facts gives the same ledger', { timeout: SLOW }, () => {
    fc.assert(
      fc.property(scenarioArb(), (scenario) => {
        const { facts, ledger } = run(scenario);
        const again = computeLedger(facts, scenario.through, scenario.today);
        failIfAny(diff(again, ledger), 'a second computation differs');
      }),
      config(500),
    );
  });

  it(
    'does not depend on the order of any fact list, nor of the version and price rows',
    { timeout: SLOW },
    () => {
      fc.assert(
        fc.property(scenarioArb(), fc.integer({ min: 1, max: 2 ** 31 - 1 }), (scenario, seed) => {
          const { facts, ledger } = run(scenario);
          const shuffled = computeLedger(
            shuffleFacts(facts, seed),
            scenario.through,
            scenario.today,
          );
          failIfAny(diff(shuffled, ledger), 'shuffled facts give another ledger');
          // Also fully reversed, the one order a random shuffle may never hit on short lists.
          const reversed: Facts = {
            ...facts,
            salary: [...facts.salary].reverse(),
            incomes: [...facts.incomes].reverse(),
            subscriptions: [...facts.subscriptions]
              .reverse()
              .map((s) => ({ ...s, prices: [...s.prices].reverse() })),
            budgets: [...facts.budgets]
              .reverse()
              .map((b) => ({ ...b, versions: [...b.versions].reverse() })),
            spendings: [...facts.spendings].reverse(),
            transfers: [...facts.transfers].reverse(),
          };
          failIfAny(
            diff(computeLedger(reversed, scenario.through, scenario.today), ledger),
            'reversed facts give another ledger',
          );
        }),
        config(1000),
      );
    },
  );

  it(
    'treats ids as labels: renumbering the budgets and subscriptions changes no figure, only ties',
    { timeout: SLOW },
    () => {
      fc.assert(
        fc.property(scenarioArb(), fc.integer({ min: 1, max: 2 ** 31 - 1 }), (scenario, seed) => {
          const { facts, ledger } = run(scenario);
          // A random bijection of the ids, onto numbers that collide with none of the old ones.
          const budgetIds = new Map(
            facts.budgets.map((b, i) => [
              b.id,
              1000 +
                shuffle(
                  facts.budgets.map((_, k) => k),
                  seed,
                )[i]!,
            ]),
          );
          const subscriptionIds = new Map(
            facts.subscriptions.map((s, i) => [
              s.id,
              1000 +
                shuffle(
                  facts.subscriptions.map((_, k) => k),
                  seed + 7,
                )[i]!,
            ]),
          );
          const renumbered: Facts = {
            ...facts,
            budgets: facts.budgets.map((b) => ({ ...b, id: budgetIds.get(b.id)! })),
            subscriptions: facts.subscriptions.map((s) => ({
              ...s,
              id: subscriptionIds.get(s.id)!,
            })),
            spendings: withJunk(scenario).spendings.map((s) => ({
              ...s,
              budgetId: budgetIds.get(s.budgetId) ?? s.budgetId,
            })),
            transfers: withJunk(scenario).transfers.map((t) => ({
              ...t,
              fromBudgetId:
                t.fromBudgetId === null ? null : (budgetIds.get(t.fromBudgetId) ?? t.fromBudgetId),
              toBudgetId:
                t.toBudgetId === null ? null : (budgetIds.get(t.toBudgetId) ?? t.toBudgetId),
            })),
          };
          const other = computeLedger(renumbered, scenario.through, scenario.today);
          const sortOrderOf = new Map(facts.budgets.map((b) => [b.color, b.sortOrder]));
          const nameOf = new Map(facts.subscriptions.map((s) => [s.color, s.name.toLowerCase()]));
          const problems: string[] = [];
          ledger.months.forEach((row, index) => {
            const twin = other.months[index]!;
            // The lines, followed by their colour tag, equal but for the id.
            const byTag = <T extends { color: string | null }>(lines: readonly T[]) =>
              new Map(lines.map((l) => [l.color, l]));
            const sameWithoutId = (
              a: Map<string | null, { id: number }>,
              b: Map<string | null, { id: number }>,
              what: string,
            ) => {
              if (a.size !== b.size)
                problems.push(`${row.month} ${what}: ${a.size} lines, ${b.size} after`);
              for (const [color, line] of a) {
                const { id: _a, ...left } = line;
                const { id: _b, ...right } = (b.get(color) ?? { id: 0 }) as { id: number };
                problems.push(...diff(right, left, `${row.month} ${what} ${color}`));
              }
            };
            sameWithoutId(byTag(row.budgets), byTag(twin.budgets), 'budget');
            sameWithoutId(byTag(row.subscriptions), byTag(twin.subscriptions), 'subscription');
            // The order follows the doc's sort keys with the new ids.
            const budgetKeys = twin.budgets.map((b) => [sortOrderOf.get(b.color) ?? 0, b.id]);
            const sortedBudgets = [...budgetKeys].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
            if (canonical(budgetKeys) !== canonical(sortedBudgets)) {
              problems.push(`${row.month}: budgets not ordered by sortOrder then id`);
            }
            const subscriptionKeys = twin.subscriptions.map(
              (s) => [nameOf.get(s.color) ?? '', s.id] as const,
            );
            const sortedSubscriptions = [...subscriptionKeys].sort((a, b) =>
              a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1],
            );
            if (canonical(subscriptionKeys) !== canonical(sortedSubscriptions)) {
              problems.push(`${row.month}: subscriptions not ordered by name then id`);
            }
            // Everything that is not a line is identical.
            problems.push(
              ...diff(
                { ...twin, budgets: undefined, subscriptions: undefined },
                { ...row, budgets: undefined, subscriptions: undefined },
                `${row.month}`,
              ),
            );
          });
          failIfAny(problems, 'renumbering the ids changed a figure');
        }),
        config(800),
      );
    },
  );
});

// -------------------------------------------------------------------------------------------------
// The identities of the contract (the JSDoc of shared/src/months.ts)
// -------------------------------------------------------------------------------------------------

/** What is wrong with one month, from the JSDoc of `MonthView` and its lines, in exact arithmetic. */
function identityProblems(view: MonthView, today: string): string[] {
  const problems: string[] = [];
  const m = view.month;
  const check = (actual: unknown, expected: unknown, what: string) => {
    if (!Object.is(actual, expected))
      problems.push(`${m} ${what}: ${String(actual)}, expected ${String(expected)}`);
  };
  const current = today.slice(0, 7);
  check(view.status, m < current ? 'closed' : m === current ? 'current' : 'future', 'status');

  check(big(view.income.total), big(view.income.salary) + big(view.income.extra), 'income.total');
  check(big(view.fixedCosts), sum(view.subscriptions.map((s) => s.charge)), 'fixedCosts');
  for (const field of ['allocated', 'spent', 'remaining', 'transfersNet'] as const) {
    check(big(view.totals[field]), sum(view.budgets.map((b) => b[field])), `totals.${field}`);
  }
  const unallocated =
    big(view.income.total) -
    big(view.fixedCosts) -
    big(view.totals.allocated) -
    big(view.totals.transfersNet);
  check(big(view.unallocated), unallocated, 'unallocated');
  check(view.overAllocated, unallocated < 0n, 'overAllocated');
  check(big(view.savingsDue.unallocated), unallocated, 'savingsDue.unallocated');
  check(
    big(view.savingsDue.budgetsSettled),
    sum(view.budgets.map((b) => b.toSavings)),
    'savingsDue.budgetsSettled',
  );
  check(
    big(view.savingsDue.reservesReleased),
    sum(view.subscriptions.map((s) => s.reserveReleased)),
    'savingsDue.reservesReleased',
  );
  check(
    big(view.savingsDue.total),
    big(view.savingsDue.unallocated) +
      big(view.savingsDue.budgetsSettled) +
      big(view.savingsDue.reservesReleased),
    'savingsDue.total',
  );

  for (const b of view.budgets) {
    const w = `budget ${b.id}`;
    check(
      big(b.available),
      big(b.carriedIn) + big(b.allocated) + big(b.transfersNet),
      `${w} available`,
    );
    check(big(b.remaining), big(b.available) - big(b.spent), `${w} remaining`);
    check(
      big(b.remaining),
      big(b.carriedOut) + big(b.toSavings),
      `${w} remaining = carriedOut + toSavings`,
    );
    check(
      big(b.carriedOut),
      b.incremental && !b.endsThisMonth ? big(b.remaining) : 0n,
      `${w} carriedOut`,
    );
    check(
      b.usagePercent,
      b.available > 0 ? (b.spent > 0 ? Number((100n * big(b.spent)) / big(b.available)) : 0) : null,
      `${w} usagePercent`,
    );
    const warns = b.available > 0 && 100n * big(b.spent) >= big(b.warnPercent) * big(b.available);
    check(b.alert, b.spent > b.available ? 'over' : warns ? 'warning' : 'ok', `${w} alert`);
    check(b.alert === 'over', b.remaining < 0, `${w} over <=> remaining < 0`);
  }

  for (const s of view.subscriptions) {
    const w = `subscription ${s.id}`;
    if (s.frequency === 'monthly') {
      check(s.charge, s.price, `${w} monthly charge`);
      check(
        canonical([
          s.reserveBalance,
          s.renewalThisMonth,
          s.nextRenewalMonth,
          s.nextRenewalPrice,
          s.reserveReleased,
        ]),
        canonical([0, false, null, null, 0]),
        `${w} monthly has no reserve and no renewal`,
      );
      continue;
    }
    check(
      s.nextRenewalMonth === null,
      s.nextRenewalPrice === null,
      `${w} renewal month and price are null together`,
    );
    if (s.nextRenewalPrice !== null)
      check(s.nextRenewalPrice, s.price, `${w} saves towards the price in effect`);
    check(
      s.renewalThisMonth,
      s.nextRenewalMonth === m,
      `${w} renewalThisMonth <=> the next renewal is this month`,
    );
    if (s.renewalThisMonth) check(s.reserveBalance, 0, `${w} reserve after a renewal`);
    if (s.nextRenewalMonth !== null) {
      const ahead = monthIndex(s.nextRenewalMonth) - monthIndex(m);
      if (ahead < 0 || ahead > 11)
        problems.push(`${m} ${w}: next renewal ${s.nextRenewalMonth} is ${ahead} months ahead`);
    } else {
      check(s.endsThisMonth, true, `${w} has no renewal left only in its end month`);
      check(s.charge, 0, `${w} charge with no renewal left`);
      check(s.reserveBalance, 0, `${w} reserve with no renewal left`);
    }
    if (s.reserveBalance < 0) problems.push(`${m} ${w}: negative reserve`);
    if (s.reserveReleased !== 0 && !s.renewalThisMonth && s.nextRenewalMonth !== null) {
      problems.push(`${m} ${w}: releases outside a renewal month and the end month`);
    }
  }
  return problems;
}

describe('the identities of the contract (shared/src/months.ts)', () => {
  it(
    'hold on every generated month, and the lines are the active items in the documented order',
    { timeout: SLOW },
    () => {
      fc.assert(
        fc.property(scenarioArb(), (scenario) => {
          const { facts, ledger } = run(scenario);
          const problems: string[] = [];
          const previousOf = new Map<number, { carriedOut: number; reserve: number }>();
          const budgetsBefore = new Map<number, number>();
          const reservesBefore = new Map<number, number>();
          ledger.months.forEach((row, index) => {
            const view = toMonthView(row);
            problems.push(...identityProblems(view, scenario.today));
            // A line for every active item, and for no other.
            const month = monthIndex(row.month);
            const active = <T extends { startMonth: string; endMonth: string | null }>(item: T) =>
              monthIndex(item.startMonth) <= month &&
              (item.endMonth === null || month <= monthIndex(item.endMonth));
            const wantedBudgets = facts.budgets
              .filter(active)
              .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
              .map((b) => b.id);
            if (canonical(row.budgets.map((b) => b.id)) !== canonical(wantedBudgets)) {
              problems.push(
                `${row.month}: budget lines ${row.budgets.map((b) => b.id)}, wanted ${wantedBudgets}`,
              );
            }
            const wantedSubscriptions = facts.subscriptions
              .filter(active)
              .sort((a, b) => {
                const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
                return x < y ? -1 : x > y ? 1 : a.id - b.id;
              })
              .map((s) => s.id);
            if (canonical(row.subscriptions.map((s) => s.id)) !== canonical(wantedSubscriptions)) {
              problems.push(
                `${row.month}: subscription lines ${row.subscriptions.map((s) => s.id)}, wanted ${wantedSubscriptions}`,
              );
            }
            // Consecutive months tie together.
            for (const b of row.budgets) {
              const before = index === 0 ? undefined : budgetsBefore.get(b.id);
              if (b.carriedIn !== (before ?? 0)) {
                problems.push(
                  `${row.month} budget ${b.id}: carriedIn ${b.carriedIn}, the month before carried out ${before ?? 0}`,
                );
              }
            }
            for (const s of row.subscriptions) {
              if (s.frequency !== 'yearly') continue;
              const before = reservesBefore.get(s.id) ?? 0;
              const expected =
                before + s.charge - (s.renewalThisMonth ? s.price : 0) - s.reserveReleased;
              if (s.reserveBalance !== expected) {
                problems.push(
                  `${row.month} subscription ${s.id}: reserve ${s.reserveBalance}, expected ${expected}`,
                );
              }
            }
            budgetsBefore.clear();
            reservesBefore.clear();
            for (const b of row.budgets) budgetsBefore.set(b.id, b.carriedOut);
            for (const s of row.subscriptions) reservesBefore.set(s.id, s.reserveBalance);
            previousOf.clear();
          });
          failIfAny(problems, 'a documented identity is broken');
        }),
        config(1000),
      );
    },
  );

  it('a MonthSummary equals the matching fields of its MonthView', { timeout: SLOW }, () => {
    fc.assert(
      fc.property(scenarioArb(), (scenario) => {
        const { ledger } = run(scenario);
        const problems: string[] = [];
        for (const row of ledger.months) {
          const view = toMonthView(row);
          problems.push(
            ...diff(
              toMonthSummary(row),
              {
                month: view.month,
                status: view.status,
                income: view.income.total,
                fixedCosts: view.fixedCosts,
                allocated: view.totals.allocated,
                spent: view.totals.spent,
                unallocated: view.unallocated,
                savingsDue: view.savingsDue.total,
              },
              row.month,
            ),
          );
          // The view carries nothing of the engine-only sums.
          if (
            Object.keys(view).includes('heldInBudgets') ||
            Object.keys(view).includes('subscriptionPayments')
          ) {
            problems.push(`${row.month}: the view leaks an engine-only sum`);
          }
        }
        failIfAny(problems, 'a summary differs from its view');
      }),
      config(500),
    );
  });
});

// -------------------------------------------------------------------------------------------------
// What the doc implies, seen from the outside (metamorphic properties)
// -------------------------------------------------------------------------------------------------

describe('what the doc implies about the shape of the computation', () => {
  it(
    'today only labels the months: every figure is the same whatever "today" is',
    { timeout: SLOW },
    () => {
      fc.assert(
        fc.property(scenarioArb(), fc.integer({ min: 0, max: 80 }), (scenario, other) => {
          const { facts, ledger } = run(scenario);
          // "The rules above apply to every month the same way; the status only labels it."
          const start = monthIndex(facts.startMonth);
          const today2 = `${monthKey(start + (other % (monthIndex(scenario.through) - start + 2)))}-15`;
          const moved = computeLedger(facts, scenario.through, today2);
          failIfAny(
            diff(moved.months.map(withoutStatus), ledger.months.map(withoutStatus)),
            `moving today from ${scenario.today} to ${today2} changed a figure`,
          );
          const labels = moved.months.map((m) => m.status);
          const expected = moved.months.map((m) =>
            m.month < today2.slice(0, 7)
              ? 'closed'
              : m.month === today2.slice(0, 7)
                ? 'current'
                : 'future',
          );
          failIfAny(diff(labels, expected), 'labels do not follow the month of today');
        }),
        config(1000),
      );
    },
  );

  it(
    'does not look at the horizon: a ledger through any month is the start of a longer one',
    { timeout: SLOW },
    () => {
      fc.assert(
        fc.property(scenarioArb(), fc.integer({ min: 0, max: 100 }), (scenario, cut) => {
          const { facts, ledger } = run(scenario);
          const count = ledger.months.length;
          const shorter = monthKey(monthIndex(facts.startMonth) + (cut % count));
          const prefix = computeLedger(facts, shorter, scenario.today);
          failIfAny(
            diff(prefix.months, ledger.months.slice(0, prefix.months.length)),
            `the ledger through ${shorter} is not a prefix of the one through ${scenario.through}`,
          );
        }),
        config(1000),
      );
    },
  );

  it(
    "ignores the day and the year of a yearly subscription's anchor date: only its month matters",
    { timeout: SLOW },
    () => {
      fc.assert(
        fc.property(scenarioArb(), fc.integer({ min: 0, max: 9_999 }), (scenario, pick) => {
          const { facts, ledger } = run(scenario);
          // The same month of the year, with another valid day and year (29 to 31 and Feb 29 included).
          const days = [1, 28, 29, 30, 31];
          const years = [1999, 2000, 2023, 2024, 2100];
          const moved: Facts = {
            ...facts,
            subscriptions: facts.subscriptions.map((s, i) => {
              const month = s.anchorDate.slice(5, 7);
              const year = years[(pick + i) % years.length]!;
              const lengths = [
                31,
                year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
                31,
                30,
                31,
                30,
                31,
                31,
                30,
                31,
                30,
                31,
              ];
              const day = Math.min(
                days[(pick + 3 * i) % days.length]!,
                lengths[Number(month) - 1]!,
              );
              return {
                ...s,
                anchorDate: `${String(year).padStart(4, '0')}-${month}-${String(day).padStart(2, '0')}`,
              };
            }),
          };
          failIfAny(
            diff(computeLedger(moved, scenario.through, scenario.today), ledger),
            'changing the day or the year of an anchor date changed a figure',
          );
        }),
        config(1000),
      );
    },
  );

  it(
    'shows nowhere what the doc says is shown nowhere: spendings outside the active months, unknown budgets, transfers that name an inactive budget, a budget to itself, pool to pool',
    { timeout: SLOW },
    () => {
      fc.assert(
        fc.property(scenarioArb(), (scenario) => {
          const clean = computeLedger(scenario.facts, scenario.through, scenario.today);
          const dirty = computeLedger(withJunk(scenario), scenario.through, scenario.today);
          failIfAny(diff(dirty, clean), 'a fact the ledger must ignore changed a figure');
        }),
        config(1000),
      );
    },
  );

  it(
    'adds up the entries of a month: one entry or several give the same figures',
    { timeout: SLOW },
    () => {
      fc.assert(
        fc.property(scenarioArb(), fc.integer({ min: 1, max: 2 ** 31 - 1 }), (scenario, seed) => {
          const { facts, ledger } = run(scenario);
          // Split every spending, income and transfer into two entries that add up to it.
          const split = <T extends { amount: number }>(
            entries: readonly T[],
            offset: number,
          ): T[] =>
            entries.flatMap((entry, i) => {
              const part = Math.trunc((entry.amount * (((seed + offset + i) % 7) + 1)) / 9);
              return [
                { ...entry, amount: part },
                { ...entry, amount: entry.amount - part },
              ];
            });
          const rewritten: Facts = {
            ...facts,
            incomes: split(facts.incomes, 1),
            spendings: split(facts.spendings, 2),
            transfers: split(facts.transfers, 3),
          };
          failIfAny(
            diff(
              computeLedger(shuffleFacts(rewritten, seed), scenario.through, scenario.today),
              ledger,
            ),
            'splitting an entry changed a figure',
          );
        }),
        config(800),
      );
    },
  );

  it(
    'adds empty months when the start month moves earlier, and changes nothing else',
    { timeout: SLOW },
    () => {
      fc.assert(
        fc.property(scenarioArb(), fc.integer({ min: 1, max: 30 }), (scenario, earlier) => {
          const { facts, ledger } = run(scenario);
          // "Moving startMonth earlier is always allowed. The added months are simply empty."
          const start = monthIndex(facts.startMonth);
          const moved = computeLedger(
            { ...facts, startMonth: monthKey(start - earlier) },
            scenario.through,
            scenario.today,
          );
          const empty = moved.months.slice(0, earlier);
          const problems: string[] = [];
          empty.forEach((row) => {
            if (
              row.income.total !== 0 ||
              row.fixedCosts !== 0 ||
              row.budgets.length !== 0 ||
              row.subscriptions.length !== 0 ||
              row.savingsDue.total !== 0 ||
              row.unallocated !== 0
            ) {
              problems.push(`${row.month} is not empty: ${JSON.stringify(row)}`);
            }
          });
          problems.push(...diff(moved.months.slice(earlier), ledger.months, 'later months'));
          failIfAny(problems, `moving the start month ${earlier} months earlier`);
        }),
        config(800),
      );
    },
  );

  it(
    'keeps every sum of money identical when only the alert thresholds change (they are not dated: docs/DOMAIN.md, Causality)',
    { timeout: SLOW },
    () => {
      fc.assert(
        fc.property(scenarioArb(), fc.integer({ min: 1, max: 100 }), (scenario, percent) => {
          const { facts, ledger } = run(scenario);
          const moved = computeLedger(
            {
              ...facts,
              alertWarnPercent: percent,
              budgets: facts.budgets.map((b, i) => ({
                ...b,
                alertWarnPercent: i % 2 === 0 ? null : ((percent + i * 17) % 100) + 1,
              })),
            },
            scenario.through,
            scenario.today,
          );
          const strip = (rows: readonly LedgerMonth[]) =>
            rows.map((row) => ({
              ...row,
              budgets: row.budgets.map((b) => ({ ...b, warnPercent: undefined, alert: undefined })),
            }));
          failIfAny(
            diff(strip(moved.months), strip(ledger.months)),
            'a threshold changed a money figure',
          );
          // And "over" does not depend on the threshold at all.
          const overs = (l: Ledger) =>
            l.months.flatMap((m) => m.budgets.map((b) => b.alert === 'over'));
          failIfAny(diff(overs(moved), overs(ledger)), '"over" depends on the threshold');
        }),
        config(800),
      );
    },
  );
});
