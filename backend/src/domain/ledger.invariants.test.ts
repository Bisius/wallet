/**
 * The four invariants of docs/DOMAIN.md on hundreds of generated fact sets (a seeded loop, not a
 * property-testing library: those come later), plus the contract identities of shared/src/months.ts
 * on every month, an independent oracle, and a rough speed guard.
 *
 *  1. Per budget, per month: carriedIn + allocated + transfersNet - spent = carriedOut + toSavings.
 *  2. Conservation: income = spent + subscriptions paid + savings due + held in incremental
 *     budgets + held in yearly reserves, checked against an oracle that simulates the yearly
 *     reserves forward, computes the budgets' balances in closed form, and never looks at the
 *     ledger (testing/ledger-oracle.ts).
 *  3. Exact splits: the contributions of a renewal cycle sum exactly to the renewal price when the
 *     price does not change within it, and the reserve is exactly 0 after every renewal.
 *  4. Determinism: the same facts give the same ledger, in whatever order the rows come.
 *  5. Causality: a fact dated in month X never changes a month before X.
 *
 * Each test collects what is wrong across all seeds and asserts once, so a failure lists the seeds
 * (replay one with `randomScenario(seed)`) and the loops stay fast.
 */
import { type MonthKey, addMonths, monthRange } from '@wallet/shared';
import { describe, expect, it } from 'vitest';
import { createOracle, oracleDifferences } from '../testing/ledger-oracle';
import { chainViolations, monthViolations } from '../testing/month-identities';
import { prng, randomScenario, shuffledFacts } from '../testing/random-facts';
import type { BudgetFact, Facts, SubscriptionFact } from './facts';
import { computeLedger } from './ledger';

// 400 scenarios by default; `LEDGER_SEEDS=5000 npx vitest run src/domain/ledger.invariants.test.ts`
// runs a wider sweep (a failure names the seed, `randomScenario(seed)` replays it).
const SEED_COUNT = Number(process.env['LEDGER_SEEDS'] ?? 400);
const SEEDS = Array.from({ length: SEED_COUNT }, (_unused, index) => index + 1);
// ms: a loaded machine runs several packages' tests at once, and a wider sweep takes longer.
const SLOW = Math.max(30_000, SEED_COUNT * 60);

describe('the ledger on generated facts', () => {
  it(
    'satisfies the contract identities and the chain identities on every month',
    { timeout: SLOW },
    () => {
      const problems: string[] = [];
      for (const seed of SEEDS) {
        const { facts, through, today } = randomScenario(seed);
        const ledger = computeLedger(facts, through, today);
        const found = [
          ...ledger.months.flatMap((m) => monthViolations(m)),
          ...chainViolations(ledger.months, { startsAtLedgerStart: true }),
        ];
        if (found.length > 0) problems.push(`seed ${seed}: ${found.slice(0, 3).join('; ')}`);
      }
      expect(problems).toEqual([]);
    },
  );

  it(
    'agrees with the independent oracle on every figure it can derive, of every month',
    { timeout: SLOW },
    () => {
      // Per month: income, spent, paid to providers, held in budgets and reserves, fixed costs,
      // reserves released, savings due, and each yearly line's charge, reserve, release, renewal
      // month and price. The engine's own sums (what it reports as held and paid) are compared too.
      const problems: string[] = [];
      let checked = 0;
      let yearlyLines = 0;
      for (const seed of SEEDS) {
        const { facts, through, today } = randomScenario(seed);
        const ledger = computeLedger(facts, through, today);
        const oracle = createOracle(facts);
        for (const m of ledger.months) {
          checked++;
          yearlyLines += m.subscriptions.filter((s) => s.frequency === 'yearly').length;
          const found = oracleDifferences(m, oracle, m.subscriptionPayments);
          if (m.heldInBudgets !== oracle.heldInBudgets(m.month))
            found.push(`${m.month} engine heldInBudgets`);
          if (m.heldInReserves !== oracle.heldInReserves(m.month))
            found.push(`${m.month} engine heldInReserves`);
          for (const difference of found) problems.push(`seed ${seed}: ${difference}`);
        }
      }
      expect(problems.slice(0, 5)).toEqual([]);
      expect(checked).toBeGreaterThan(5000);
      expect(yearlyLines).toBeGreaterThan(1000);
    },
  );

  it('conserves money from the start month to any month (invariant 2)', { timeout: SLOW }, () => {
    const problems: string[] = [];
    for (const seed of SEEDS) {
      const { facts, through, today } = randomScenario(seed);
      const ledger = computeLedger(facts, through, today);
      const oracle = createOracle(facts);
      let income = 0;
      let accountedFor = 0;
      for (const m of ledger.months) {
        income += m.income.total;
        accountedFor += m.totals.spent + m.subscriptionPayments + m.savingsDue.total;
        // Every cent of income is spent, paid, sent to savings, or still held.
        const held = oracle.heldInBudgets(m.month) + oracle.heldInReserves(m.month);
        if (income !== accountedFor + held) {
          problems.push(
            `seed ${seed}, through ${m.month}: income ${income} != ${accountedFor} + ${held} held`,
          );
        }
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it(
    'splits every renewal cycle exactly (invariant 3), and the reserve is empty after each renewal',
    { timeout: SLOW },
    () => {
      const problems: string[] = [];
      const seen = { renewals: 0, constantPrice: 0, priceChanged: 0, released: 0 };
      for (const seed of SEEDS) {
        const { facts, through, today } = randomScenario(seed);
        const ledger = computeLedger(facts, through, today);
        for (const sub of facts.subscriptions.filter((s) => s.frequency === 'yearly')) {
          let cycle = 0; // contributions since the last renewal (the reserve is 0 where it starts)
          const prices = new Set<number>(); // the prices in effect during the cycle
          for (const m of ledger.months) {
            const line = m.subscriptions.find((s) => s.id === sub.id);
            if (!line) continue;
            cycle += line.charge;
            prices.add(line.price);
            if (!line.renewalThisMonth) continue;
            seen.renewals++;
            const where = `seed ${seed}, subscription ${sub.id}, ${m.month}`;
            // In every case the reserve is exactly 0 after a renewal, and what went in is what was
            // paid plus what was released.
            if (line.reserveBalance !== 0)
              problems.push(`${where}: reserve ${line.reserveBalance}`);
            if (cycle !== line.price + line.reserveReleased) {
              problems.push(
                `${where}: cycle ${cycle} != price ${line.price} + released ${line.reserveReleased}`,
              );
            }
            if (prices.size === 1) {
              // With a constant price the cycle lands exactly on it: nothing is left to release.
              seen.constantPrice++;
              if (cycle !== line.price || line.reserveReleased !== 0) {
                problems.push(
                  `${where}: constant price ${line.price} but cycle ${cycle}, released ${line.reserveReleased}`,
                );
              }
            } else seen.priceChanged++;
            if (line.reserveReleased > 0) seen.released++;
            cycle = 0;
            prices.clear();
          }
        }
      }
      expect(problems.slice(0, 5)).toEqual([]);
      expect(seen.renewals).toBeGreaterThan(100);
      expect(seen.constantPrice).toBeGreaterThan(50);
      expect(seen.priceChanged).toBeGreaterThan(10);
      expect(seen.released).toBeGreaterThan(5);
    },
  );

  it(
    'releases a reserve only after a price drop at a renewal, or in the last month with no renewal left',
    { timeout: SLOW },
    () => {
      // docs/DOMAIN.md: a leftover after a renewal and the whole reserve at the end month are the
      // only two ways money comes back from a reserve. Both happen in the generated data.
      const problems: string[] = [];
      const seen = { atRenewal: 0, atEnd: 0 };
      for (const seed of SEEDS) {
        const { facts, through, today } = randomScenario(seed);
        for (const m of computeLedger(facts, through, today).months) {
          for (const line of m.subscriptions) {
            if (line.reserveReleased === 0) continue;
            if (line.renewalThisMonth) seen.atRenewal++;
            else if (line.nextRenewalMonth === null && line.endsThisMonth) seen.atEnd++;
            else problems.push(`seed ${seed}, ${m.month}, subscription ${line.id}`);
          }
        }
      }
      expect(problems).toEqual([]);
      expect(seen.atRenewal).toBeGreaterThan(5);
      expect(seen.atEnd).toBeGreaterThan(5);
    },
  );

  it(
    'gives the same ledger however the rows are ordered (invariant 4), and when asked twice',
    { timeout: SLOW },
    () => {
      const problems: string[] = [];
      for (const seed of SEEDS) {
        const { facts, through, today } = randomScenario(seed);
        const first = JSON.stringify(computeLedger(facts, through, today));
        if (JSON.stringify(computeLedger(facts, through, today)) !== first) {
          problems.push(`seed ${seed}: asked twice`);
        }
        for (const shuffleSeed of [1, 2, 3]) {
          const shuffled = shuffledFacts(facts, seed * 10 + shuffleSeed);
          if (JSON.stringify(computeLedger(shuffled, through, today)) !== first) {
            problems.push(`seed ${seed}: shuffled ${shuffleSeed}`);
          }
        }
      }
      expect(problems).toEqual([]);
      // A fixed case, with a readable diff if the engine ever starts to depend on the order.
      const { facts, through, today } = randomScenario(7);
      expect(computeLedger(shuffledFacts(facts, 99), through, today)).toEqual(
        computeLedger(facts, through, today),
      );
    },
  );

  it('computes any month the same alone as inside a longer run (no month depends on the horizon)', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const { facts, through, today } = randomScenario(seed);
      const full = computeLedger(facts, through, today);
      const half = computeLedger(
        facts,
        addMonths(facts.startMonth, Math.floor(full.months.length / 2)),
        today,
      );
      expect(full.months.slice(0, half.months.length)).toEqual(half.months);
    }
  });

  it('exercises what it claims to: the generated data covers every kind of line', () => {
    const seen = {
      incrementalCarry: 0,
      deficitCarry: 0,
      settledSurplus: 0,
      settledDeficit: 0,
      archivedSettle: 0,
      modeSwitch: 0,
      refund: 0,
      yearly: 0,
      monthly: 0,
      poolTransfer: 0,
      budgetTransfer: 0,
      overAllocated: 0,
      warning: 0,
      over: 0,
      future: 0,
      closed: 0,
      current: 0,
      reserveReleasedAtRenewal: 0,
      reserveReleasedAtEnd: 0,
      yearlyEndsBeforeRenewal: 0,
      versionOlderThanStart: 0,
      priceOlderThanStart: 0,
      versionAfterEnd: 0,
      priceAfterEnd: 0,
    };
    for (const seed of SEEDS) {
      const { facts, through, today } = randomScenario(seed);
      const ledger = computeLedger(facts, through, today);
      for (const t of facts.transfers) {
        if (t.fromBudgetId === null || t.toBudgetId === null) seen.poolTransfer++;
        else seen.budgetTransfer++;
      }
      for (const b of facts.budgets) {
        if (b.versions.some((v) => v.effectiveMonth < b.startMonth)) seen.versionOlderThanStart++;
        if (b.endMonth && b.versions.some((v) => v.effectiveMonth > b.endMonth!))
          seen.versionAfterEnd++;
      }
      for (const sub of facts.subscriptions) {
        if (sub.prices.some((p) => p.effectiveMonth < sub.startMonth)) seen.priceOlderThanStart++;
        if (sub.endMonth && sub.prices.some((p) => p.effectiveMonth > sub.endMonth!))
          seen.priceAfterEnd++;
      }
      ledger.months.forEach((m, index) => {
        seen[m.status]++;
        if (m.overAllocated) seen.overAllocated++;
        for (const s of m.subscriptions) {
          seen[s.frequency]++;
          if (s.reserveReleased > 0 && s.renewalThisMonth) seen.reserveReleasedAtRenewal++;
          if (s.reserveReleased > 0 && s.nextRenewalMonth === null) seen.reserveReleasedAtEnd++;
          if (s.frequency === 'yearly' && s.endsThisMonth && s.nextRenewalMonth === null) {
            seen.yearlyEndsBeforeRenewal++;
          }
        }
        for (const b of m.budgets) {
          if (b.incremental && !b.endsThisMonth && b.carriedOut > 0) seen.incrementalCarry++;
          if (b.incremental && !b.endsThisMonth && b.carriedOut < 0) seen.deficitCarry++;
          if (!b.incremental && b.toSavings > 0) seen.settledSurplus++;
          if (!b.incremental && b.toSavings < 0) seen.settledDeficit++;
          if (b.endsThisMonth && b.carriedIn !== 0) seen.archivedSettle++;
          if (b.spent < 0) seen.refund++;
          if (b.alert === 'warning') seen.warning++;
          if (b.alert === 'over') seen.over++;
          const before = ledger.months[index - 1]?.budgets.find((p) => p.id === b.id);
          if (before && before.incremental && !b.incremental && before.carriedOut !== 0)
            seen.modeSwitch++;
        }
      });
    }
    for (const [what, count] of Object.entries(seen)) {
      expect(count, `no generated scenario has: ${what}`).toBeGreaterThan(10);
    }
  });
});

describe('causality (invariant 5)', () => {
  /** A change to the facts, and the first month it is allowed to change. */
  interface Edit {
    label: string;
    facts: Facts;
    from: MonthKey;
  }

  const upsert = <T extends { effectiveMonth: MonthKey }>(rows: readonly T[], row: T): T[] => [
    ...rows.filter((existing) => existing.effectiveMonth !== row.effectiveMonth),
    row,
  ];
  const activeIn = (
    item: { startMonth: MonthKey; endMonth: MonthKey | null },
    months: readonly MonthKey[],
  ) => months.filter((m) => m >= item.startMonth && (item.endMonth === null || m <= item.endMonth));

  /**
   * One edit of every kind the API can make, each dated somewhere in the ledger's range and valid
   * (a spending inside its budget's active months, a version inside the active range, ...). `from`
   * is the first month that edit may change: its own month, or for an end month or a start month
   * the earlier of the old and the new one.
   */
  function editsFor(facts: Facts, through: MonthKey, seed: number): Edit[] {
    const r = prng(seed * 7919 + 13);
    const months = monthRange(facts.startMonth, through);
    const edits: Edit[] = [];
    const add = (label: string, from: MonthKey, changes: Partial<Facts>) =>
      edits.push({ label: `${label} (from ${from})`, from, facts: { ...facts, ...changes } });
    const withBudget = (old: BudgetFact, next: BudgetFact) =>
      facts.budgets.map((b) => (b === old ? next : b));
    const withSubscription = (old: SubscriptionFact, next: SubscriptionFact) =>
      facts.subscriptions.map((s) => (s === old ? next : s));

    const x = r.pick(months);
    add('a salary change', x, {
      salary: upsert(facts.salary, { effectiveMonth: x, amount: r.int(0, 500000) }),
    });
    const y = r.pick(months);
    add('an income', y, { incomes: [...facts.incomes, { month: y, amount: r.int(1, 100000) }] });

    const budget = facts.budgets.length > 0 ? r.pick(facts.budgets) : undefined;
    if (budget) {
      const active = activeIn(budget, months);
      if (active.length > 0) {
        const m = r.pick(active);
        add(`a spending in budget ${budget.id}`, m, {
          spendings: [
            ...facts.spendings,
            { budgetId: budget.id, month: m, amount: r.int(-5000, 40000) },
          ],
        });
        const t = r.pick(active);
        add(`a transfer into budget ${budget.id}`, t, {
          transfers: [
            ...facts.transfers,
            { month: t, fromBudgetId: null, toBudgetId: budget.id, amount: r.int(1, 15000) },
          ],
        });
        const v = r.pick(active);
        add(`a version of budget ${budget.id}`, v, {
          budgets: withBudget(budget, {
            ...budget,
            versions: upsert(budget.versions, {
              effectiveMonth: v,
              amount: r.int(0, 60000),
              incremental: r.chance(0.5),
            }),
          }),
        });
      }
      // Archive (or move the end month of) the budget, never before its last spending or transfer.
      const lastActivity = [
        ...facts.spendings.filter((sp) => sp.budgetId === budget.id).map((sp) => sp.month),
        ...facts.transfers
          .filter((t) => t.fromBudgetId === budget.id || t.toBudgetId === budget.id)
          .map((t) => t.month),
      ].sort();
      const earliestEnd = [budget.startMonth, lastActivity.at(-1) ?? budget.startMonth]
        .sort()
        .at(-1)!;
      const ends = months.filter((m) => m >= earliestEnd);
      if (ends.length > 0) {
        const end = r.pick(ends);
        add(`budget ${budget.id} ends in ${end}`, [budget.endMonth ?? end, end].sort()[0]!, {
          budgets: withBudget(budget, { ...budget, endMonth: end }),
        });
      }
      // Move the start month earlier (the first version follows), or later, up to its first activity.
      const firstActivity = [
        ...facts.spendings.filter((sp) => sp.budgetId === budget.id).map((sp) => sp.month),
        ...facts.transfers
          .filter((t) => t.fromBudgetId === budget.id || t.toBudgetId === budget.id)
          .map((t) => t.month),
      ].sort()[0];
      const starts = months.filter(
        (m) =>
          m !== budget.startMonth &&
          (budget.endMonth === null || m <= budget.endMonth) &&
          (m < budget.startMonth || firstActivity === undefined || m <= firstActivity),
      );
      if (starts.length > 0) {
        const start = r.pick(starts);
        const firstRow = [...budget.versions].sort((a, b) =>
          a.effectiveMonth.localeCompare(b.effectiveMonth),
        )[0]!;
        add(`budget ${budget.id} starts in ${start}`, [budget.startMonth, start].sort()[0]!, {
          budgets: withBudget(budget, {
            ...budget,
            startMonth: start,
            // The API re-dates the first row only when the start moves before it.
            versions: budget.versions.map((v) =>
              v === firstRow && start < v.effectiveMonth ? { ...v, effectiveMonth: start } : v,
            ),
          }),
        });
      }
    }

    const sub = facts.subscriptions.length > 0 ? r.pick(facts.subscriptions) : undefined;
    if (sub) {
      const active = activeIn(sub, months);
      if (active.length > 0) {
        const p = r.pick(active);
        add(`a price of subscription ${sub.id}`, p, {
          subscriptions: withSubscription(sub, {
            ...sub,
            prices: upsert(sub.prices, { effectiveMonth: p, amount: r.int(100, 30000) }),
          }),
        });
      }
      const ends = months.filter((m) => m >= sub.startMonth);
      if (ends.length > 0) {
        const end = r.pick(ends);
        add(`subscription ${sub.id} ends in ${end}`, [sub.endMonth ?? end, end].sort()[0]!, {
          subscriptions: withSubscription(sub, { ...sub, endMonth: end }),
        });
      }
      const starts = months.filter(
        (m) => m !== sub.startMonth && (sub.endMonth === null || m <= sub.endMonth),
      );
      if (starts.length > 0) {
        const start = r.pick(starts);
        const firstRow = [...sub.prices].sort((a, b) =>
          a.effectiveMonth.localeCompare(b.effectiveMonth),
        )[0]!;
        add(`subscription ${sub.id} starts in ${start}`, [sub.startMonth, start].sort()[0]!, {
          subscriptions: withSubscription(sub, {
            ...sub,
            startMonth: start,
            prices: sub.prices.map((row) =>
              row === firstRow && start < row.effectiveMonth
                ? { ...row, effectiveMonth: start }
                : row,
            ),
          }),
        });
      }
    }

    const z = r.pick(months);
    add('a new subscription', z, {
      subscriptions: [
        ...facts.subscriptions,
        {
          id: 100,
          name: 'New',
          color: null,
          frequency: r.chance(0.6) ? 'yearly' : 'monthly',
          anchorDate: `2025-${String(r.int(1, 12)).padStart(2, '0')}-10`,
          startMonth: z,
          endMonth: null,
          prices: [{ effectiveMonth: z, amount: r.int(100, 30000) }],
        },
      ],
    });
    const w = r.pick(months);
    add('a new budget', w, {
      budgets: [
        ...facts.budgets,
        {
          id: 100,
          name: 'New',
          color: null,
          icon: null,
          sortOrder: 0,
          startMonth: w,
          endMonth: null,
          alertWarnPercent: null,
          versions: [{ effectiveMonth: w, amount: r.int(0, 60000), incremental: r.chance(0.5) }],
        },
      ],
    });
    return edits;
  }

  it(
    'a fact dated in month X never changes a month before X, whatever kind of fact it is',
    { timeout: SLOW },
    () => {
      const problems: string[] = [];
      let compared = 0;
      let changedAfter = 0;
      for (const seed of SEEDS) {
        const { facts, through, today } = randomScenario(seed);
        const base = computeLedger(facts, through, today).months;
        for (const edit of editsFor(facts, through, seed)) {
          const edited = computeLedger(edit.facts, through, today).months;
          const before = base.findIndex((m) => m.month >= edit.from);
          const untouched = before === -1 ? base.length : before;
          for (let i = 0; i < untouched; i++) {
            compared++;
            if (JSON.stringify(edited[i]) !== JSON.stringify(base[i])) {
              problems.push(`seed ${seed}, ${edit.label}: ${base[i]!.month} changed`);
            }
          }
          // Not vacuous: the edits do change the months from X on.
          if (
            base
              .slice(untouched)
              .some((m, i) => JSON.stringify(m) !== JSON.stringify(edited[untouched + i]))
          ) {
            changedAfter++;
          }
        }
      }
      expect(problems.slice(0, 5)).toEqual([]);
      expect(compared).toBeGreaterThan(20_000);
      expect(changedAfter).toBeGreaterThan(1000);
    },
  );

  it('catching up: the ledger through a month is the same prefix of every longer ledger (nothing looks ahead)', () => {
    // A month computed with the horizon cut at M equals the same month of a longer run. This is the
    // same property seen from the other side: no month reads a later one.
    for (const seed of SEEDS.slice(0, 100)) {
      const { facts, through, today } = randomScenario(seed);
      const full = computeLedger(facts, through, today).months;
      for (const cut of [0, Math.floor(full.length / 3), full.length - 1]) {
        const month = full[cut]?.month;
        if (!month) continue;
        expect(JSON.stringify(computeLedger(facts, month, today).months)).toBe(
          JSON.stringify(full.slice(0, cut + 1)),
        );
      }
    }
  });
});

describe('speed', () => {
  it(
    'computes 120 months x 30 budgets x 20 subscriptions well under 100 ms',
    { timeout: SLOW },
    () => {
      // Built by hand: 30 budgets with 4 versions and spendings in every month, 20 subscriptions
      // (half yearly) with price changes, transfers, salary changes, incomes.
      const startMonth = '2026-01';
      const through = addMonths(startMonth, 119);
      const months = Array.from({ length: 120 }, (_unused, i) => addMonths(startMonth, i));
      const budgetEnd = (i: number) => (i % 5 === 0 ? months[90 + i]! : null);
      const facts = {
        startMonth,
        alertWarnPercent: 80,
        salary: [0, 24, 48, 72].map((i) => ({
          effectiveMonth: months[i]!,
          amount: 300000 + i * 1000,
        })),
        incomes: months.filter((_m, i) => i % 5 === 0).map((month) => ({ month, amount: 12345 })),
        subscriptions: Array.from({ length: 20 }, (_unused, i) => ({
          id: i + 1,
          name: `Subscription ${i}`,
          color: null,
          frequency: i % 2 === 0 ? ('yearly' as const) : ('monthly' as const),
          anchorDate: `2025-${String((i % 12) + 1).padStart(2, '0')}-15`,
          startMonth: months[i]!,
          endMonth: i % 4 === 0 ? months[100 + i]! : null,
          prices: [0, 30, 60].map((offset) => ({
            effectiveMonth: months[i + offset]!,
            amount: 1000 + 37 * i + offset * 10,
          })),
        })),
        budgets: Array.from({ length: 30 }, (_unused, i) => ({
          id: i + 1,
          name: `Budget ${i}`,
          color: null,
          icon: null,
          sortOrder: i * 10,
          startMonth: months[i]!,
          endMonth: budgetEnd(i),
          alertWarnPercent: null,
          versions: [0, 20, 40, 60].map((offset) => ({
            effectiveMonth: months[i + offset]!,
            amount: 10000 + 100 * i + offset * 50,
            incremental: (offset / 20) % 2 === 0,
          })),
        })),
        spendings: months.flatMap((month, mi) =>
          Array.from({ length: 30 }, (_unused, i) => ({
            budgetId: i + 1,
            month,
            amount: 5000 + ((mi * 31 + i * 17) % 9000),
          })).filter((s) => {
            const end = budgetEnd(s.budgetId - 1);
            return month >= months[s.budgetId - 1]! && (end === null || month <= end);
          }),
        ),
        transfers: months
          .filter((_m, i) => i % 3 === 0 && i >= 30 && i <= 90)
          .map((month) => ({
            month,
            fromBudgetId: 1 as number | null,
            toBudgetId: null as number | null,
            amount: 500,
          })),
      };
      const today = '2030-06-15';

      computeLedger(facts, through, today); // warm up
      const times: number[] = [];
      for (let attempt = 0; attempt < 7; attempt++) {
        const t0 = performance.now();
        const ledger = computeLedger(facts, through, today);
        times.push(performance.now() - t0);
        expect(ledger.months).toHaveLength(120);
      }
      const best = Math.min(...times);
      expect(best, `best of 7 runs: ${best.toFixed(1)} ms`).toBeLessThan(100);

      // And the result is still right at this size (the oracle is slow, so it checks every 10th month).
      const oracle = createOracle(facts);
      const ledger = computeLedger(facts, through, today);
      expect(ledger.months.flatMap((m) => monthViolations(m))).toEqual([]);
      expect(chainViolations(ledger.months, { startsAtLedgerStart: true })).toEqual([]);
      const sampled = ledger.months.filter((_m, i) => i % 10 === 0 || i === 119);
      expect(sampled.filter((m) => m.savingsDue.total !== oracle.savingsDue(m.month))).toEqual([]);
    },
  );
});
