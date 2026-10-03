import type { BudgetDto } from '@wallet/shared';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { budgets as budgetsTable, spendings } from '../db/schema';
import { HttpError } from '../lib/errors';
import {
  addIncome,
  addSpending,
  addSubscription,
  insertTransfer,
  mutableClock,
  onboard,
} from '../testing/helpers';
import { createTestApp } from '../testing/test-app';
import { loadFacts } from './facts';

describe('loadFacts', () => {
  it('throws the 409 not_onboarded error before the settings exist', () => {
    const { db } = createTestApp();
    let error: unknown;
    try {
      loadFacts(db);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 409, code: 'not_onboarded' });
  });

  it('reads the settings, the history rows and the facts summed per month', async () => {
    const { app, db } = createTestApp(mutableClock('2026-03-15T10:00:00Z'));
    const done = await onboard(app, {
      startMonth: '2026-01',
      alertWarnPercent: 75,
      salary: 250000,
      budgets: [
        { name: 'Groceries', amount: 40000, incremental: false },
        { name: 'Holiday', amount: 15000, incremental: true },
      ],
    });
    const [groceries, holiday] = done.budgets as [BudgetDto, BudgetDto];
    await request(app).put('/api/salary/2026-03').send({ amount: 260000 }).expect(200);
    await request(app)
      .put(`/api/budgets/${holiday.id}/versions/2026-02`)
      .send({ amount: 18000, incremental: false })
      .expect(200);
    await request(app)
      .patch(`/api/budgets/${holiday.id}`)
      .send({ alertWarnPercent: 60 })
      .expect(200);
    const netflix = await addSubscription(app, {
      name: 'Netflix',
      amount: 1299,
      startMonth: '2026-01',
    });
    await request(app)
      .put(`/api/subscriptions/${netflix.id}/prices/2026-03`)
      .send({ amount: 1399 })
      .expect(200);
    const domain = await addSubscription(app, {
      name: 'Domain',
      frequency: 'yearly',
      anchorDate: '2025-06-30',
      amount: 12000,
      startMonth: '2026-02',
    });
    await request(app)
      .post(`/api/subscriptions/${domain.id}/cancel`)
      .send({ endMonth: '2026-09' })
      .expect(200);

    // Spendings and incomes: several in a month add up, a refund subtracts, month ends belong to their month.
    await addSpending(app, { budgetId: groceries.id, date: '2026-01-31', amount: 1000 });
    await addSpending(app, { budgetId: groceries.id, date: '2026-01-02', amount: 2500 });
    await addSpending(app, { budgetId: groceries.id, date: '2026-02-01', amount: 4000 });
    await addSpending(app, { budgetId: groceries.id, date: '2026-02-10', amount: -1500 });
    await addSpending(app, { budgetId: holiday.id, date: '2026-02-28', amount: 700 });
    await addIncome(app, { date: '2026-02-14', amount: 50000 });
    await addIncome(app, { date: '2026-02-20', amount: 2500 });
    await addIncome(app, { date: '2026-03-01', amount: 100 });
    insertTransfer(db, { date: '2026-02-05', amount: 300, toBudgetId: groceries.id });
    insertTransfer(db, { date: '2026-02-06', amount: 200, toBudgetId: groceries.id });
    insertTransfer(db, {
      date: '2026-02-07',
      amount: 900,
      fromBudgetId: groceries.id,
      toBudgetId: holiday.id,
    });
    insertTransfer(db, { date: '2026-03-31', amount: 50, fromBudgetId: holiday.id });

    const facts = loadFacts(db);
    const byMonth = <T extends { month: string }>(rows: T[]) =>
      [...rows].sort((a, b) => a.month.localeCompare(b.month));

    expect(facts.startMonth).toBe('2026-01');
    expect(facts.alertWarnPercent).toBe(75);
    expect(
      [...facts.salary].sort((a, b) => a.effectiveMonth.localeCompare(b.effectiveMonth)),
    ).toEqual([
      { effectiveMonth: '2026-01', amount: 250000 },
      { effectiveMonth: '2026-03', amount: 260000 },
    ]);
    expect(byMonth(facts.incomes)).toEqual([
      { month: '2026-02', amount: 52500 },
      { month: '2026-03', amount: 100 },
    ]);

    const sortedBudgets = [...facts.budgets].sort((a, b) => a.id - b.id);
    expect(sortedBudgets).toEqual([
      {
        id: groceries.id,
        name: 'Groceries',
        color: null,
        icon: null,
        sortOrder: 0,
        startMonth: '2026-01',
        endMonth: null,
        alertWarnPercent: null,
        versions: [{ effectiveMonth: '2026-01', amount: 40000, incremental: false }],
      },
      {
        id: holiday.id,
        name: 'Holiday',
        color: null,
        icon: null,
        sortOrder: 10,
        startMonth: '2026-01',
        endMonth: null,
        alertWarnPercent: 60,
        versions: expect.arrayContaining([
          { effectiveMonth: '2026-01', amount: 15000, incremental: true },
          { effectiveMonth: '2026-02', amount: 18000, incremental: false },
        ]),
      },
    ]);
    expect(sortedBudgets[1]?.versions).toHaveLength(2);

    const subscriptions = [...facts.subscriptions].sort((a, b) => a.id - b.id);
    expect(subscriptions).toMatchObject([
      {
        id: netflix.id,
        name: 'Netflix',
        frequency: 'monthly',
        startMonth: '2026-01',
        endMonth: null,
        prices: expect.arrayContaining([
          { effectiveMonth: '2026-01', amount: 1299 },
          { effectiveMonth: '2026-03', amount: 1399 },
        ]),
      },
      {
        id: domain.id,
        name: 'Domain',
        frequency: 'yearly',
        anchorDate: '2025-06-30',
        startMonth: '2026-02',
        endMonth: '2026-09',
        prices: [{ effectiveMonth: '2026-02', amount: 12000 }],
      },
    ]);
    expect(subscriptions[0]?.prices).toHaveLength(2);

    const sortKey = (s: { budgetId: number; month: string }) => `${s.budgetId}|${s.month}`;
    expect([...facts.spendings].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))).toEqual([
      { budgetId: groceries.id, month: '2026-01', amount: 3500 },
      { budgetId: groceries.id, month: '2026-02', amount: 2500 },
      { budgetId: holiday.id, month: '2026-02', amount: 700 },
    ]);

    // The two pool-to-budget transfers of February share a key and are summed; the others stay apart.
    expect(
      [...facts.transfers].sort((a, b) =>
        `${a.month}${a.amount}`.localeCompare(`${b.month}${b.amount}`),
      ),
    ).toEqual([
      { month: '2026-02', fromBudgetId: null, toBudgetId: groceries.id, amount: 500 },
      { month: '2026-02', fromBudgetId: groceries.id, toBudgetId: holiday.id, amount: 900 },
      { month: '2026-03', fromBudgetId: holiday.id, toBudgetId: null, amount: 50 },
    ]);
  });

  it('works inside a transaction', async () => {
    const { app, db } = createTestApp();
    await onboard(app, { startMonth: '2026-01' });
    const inside = db.transaction((tx) => loadFacts(tx));
    expect(inside).toEqual(loadFacts(db));
  });

  it('runs a fixed number of queries, however much data there is', async () => {
    const countQueries = async (budgetCount: number, spendingCount: number) => {
      const { app, db } = createTestApp(mutableClock('2026-03-15T10:00:00Z'));
      await onboard(app, { startMonth: '2026-01' });
      if (budgetCount > 0) {
        db.insert(budgetsTable)
          .values(
            Array.from({ length: budgetCount }, (_unused, i) => ({
              name: `B${i}`,
              sortOrder: i,
              startMonth: '2026-01',
            })),
          )
          .run();
      }
      const ids = db.select({ id: budgetsTable.id }).from(budgetsTable).all();
      for (let i = 0; i < spendingCount; i += 200) {
        db.insert(spendings)
          .values(
            Array.from({ length: Math.min(200, spendingCount - i) }, (_unused, k) => ({
              date: `2026-0${1 + ((i + k) % 3)}-1${k % 9}`,
              amount: 100 + k,
              budgetId: ids[(i + k) % ids.length]!.id,
              description: '',
            })),
          )
          .run();
      }
      for (let k = 0; k < 20; k++)
        await addSubscription(app, { name: `S${k}`, startMonth: '2026-01' });

      const prepare = vi.spyOn(db.$client, 'prepare');
      loadFacts(db);
      const count = prepare.mock.calls.length;
      prepare.mockRestore();
      return count;
    };

    const small = await countQueries(1, 1);
    const large = await countQueries(40, 2000);
    expect(large).toBe(small);
    expect(large).toBeLessThanOrEqual(10);
  });
});
