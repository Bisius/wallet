/**
 * A household over six months, end to end through the HTTP API: set up, add spendings, move the
 * clock forward (once across a month boundary that only exists in the server's local time zone),
 * change amounts and prices, archive and cancel, and check at every step what the API reports, to
 * the cent. The month engine is Phase 2; this pins the Phase 1 facts it will be computed from.
 */
import type {
  BudgetDto,
  IncomeDto,
  SalaryEntryDto,
  SpendingsPage,
  SubscriptionDto,
} from '@wallet/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  addIncome,
  addSpending,
  addSubscription,
  expectApiError,
  expectRuleViolation,
  mutableClock,
  onboard,
  withTimeZone,
} from './testing/helpers';
import { createTestApp } from './testing/test-app';

describe('Phase 1 scenario: January to July', () => {
  it('keeps every fact, status and total right as the months pass', async () => {
    const clock = mutableClock('2026-01-10T09:00:00Z');
    const { app } = createTestApp(clock);
    const get = async <T>(path: string): Promise<T> =>
      (await request(app).get(path).expect(200)).body;
    const budgets = () => get<BudgetDto[]>('/api/budgets');
    const subscriptions = () => get<SubscriptionDto[]>('/api/subscriptions');
    const spendingsOf = (query: string) => get<SpendingsPage>(`/api/spendings?${query}`);

    // --- January: set up -------------------------------------------------------------------
    const done = await onboard(app, {
      startMonth: '2026-01',
      salary: 250000,
      openingSavings: 100000,
      budgets: [
        { name: 'Groceries', amount: 40000, incremental: false },
        { name: 'Holiday', amount: 15000, incremental: true },
      ],
    });
    const [groceries, holiday] = done.budgets as [BudgetDto, BudgetDto];
    const netflix = await addSubscription(app, {
      name: 'Netflix',
      amount: 1299,
      startMonth: '2026-01',
    });
    const domain = await addSubscription(app, {
      name: 'Domain',
      frequency: 'yearly',
      anchorDate: '2025-03-14',
      amount: 12000,
      startMonth: '2026-01',
    });
    expect(domain.monthlyEquivalent).toBe(1000);

    await addSpending(app, { budgetId: groceries.id, date: '2026-01-03', amount: 8450 });
    await addSpending(app, { budgetId: groceries.id, date: '2026-01-09', amount: 12075 });
    await addSpending(app, { budgetId: holiday.id, date: '2026-01-08', amount: 5000 });
    expect(await spendingsOf('month=2026-01')).toMatchObject({ total: 3, totalAmount: 25525 });
    expect(await spendingsOf(`month=2026-01&budgetId=${groceries.id}`)).toMatchObject({
      total: 2,
      totalAmount: 20525,
    });

    // --- February: a refund, an extra income, a raise announced for March -------------------
    clock.set('2026-02-02T09:00:00Z');
    await addSpending(app, { budgetId: groceries.id, date: '2026-02-01', amount: 40100 }); // over budget: allowed
    await addSpending(app, { budgetId: groceries.id, date: '2026-02-02', amount: -2500 }); // refund
    await addSpending(app, { budgetId: holiday.id, date: '2026-02-01', amount: 7000 });
    await addIncome(app, { date: '2026-02-14', amount: 50000, description: 'Bonus' });
    await request(app).put('/api/salary/2026-03').send({ amount: 260000 }).expect(200);

    expect(await spendingsOf('month=2026-02')).toMatchObject({ total: 3, totalAmount: 44600 });
    expect(await spendingsOf(`month=2026-02&budgetId=${groceries.id}`)).toMatchObject({
      totalAmount: 37600,
    });
    expect(await get<IncomeDto[]>('/api/incomes?month=2026-02')).toMatchObject([{ amount: 50000 }]);
    expect(await get<SalaryEntryDto[]>('/api/salary')).toEqual([
      { effectiveMonth: '2026-01', amount: 250000 },
      { effectiveMonth: '2026-03', amount: 260000 },
    ]);

    // --- Late March: planned changes for April ---------------------------------------------
    // 22:30 UTC on 31 March is already 00:30 on 1 April for a server in Rome.
    clock.set('2026-03-31T22:30:00Z');
    await request(app)
      .put(`/api/subscriptions/${netflix.id}/prices/2026-04`)
      .send({ amount: 1399 })
      .expect(200);
    await request(app)
      .put(`/api/budgets/${groceries.id}/versions/2026-05`)
      .send({ amount: 42000, incremental: false })
      .expect(200);
    await request(app)
      .post('/api/spendings')
      .send({
        date: '2026-03-30',
        amount: 6000,
        budgetId: groceries.id,
        description: 'Easter shop',
      })
      .expect(201);

    // In UTC it is still March: the new price is not current yet...
    expect((await subscriptions()).find((s) => s.id === netflix.id)).toMatchObject({
      currentPrice: 1299,
      monthlyEquivalent: 1299,
    });
    // ...but in Rome it is April, so it is.
    const inRome = await withTimeZone('Europe/Rome', subscriptions);
    expect(inRome.find((s) => s.id === netflix.id)).toMatchObject({
      currentPrice: 1399,
      monthlyEquivalent: 1399,
    });
    expect(inRome.find((s) => s.id === domain.id)).toMatchObject({
      currentPrice: 12000,
      monthlyEquivalent: 1000,
    });

    // --- April: Holiday is archived (from the Rome side of midnight) ------------------------
    const archived = await withTimeZone(
      'Europe/Rome',
      async () =>
        (await request(app).post(`/api/budgets/${holiday.id}/archive`).send({}).expect(200))
          .body as BudgetDto,
    );
    expect(archived).toMatchObject({ endMonth: '2026-04', status: 'active' });

    clock.set('2026-04-20T09:00:00Z');
    await addSpending(app, { budgetId: holiday.id, date: '2026-04-30', amount: 3000 }); // its last month
    expectRuleViolation(
      await request(app)
        .post('/api/spendings')
        .send({ date: '2026-05-01', amount: 100, budgetId: holiday.id }),
      'outside_active_months',
      'date',
    );
    // It can no longer be deleted: it has spendings. It can still be archived further out.
    expectApiError(await request(app).delete(`/api/budgets/${holiday.id}`), 'has_history');
    expect(await spendingsOf(`budgetId=${holiday.id}`)).toMatchObject({
      total: 3,
      totalAmount: 15000,
    });

    // --- May: Holiday has ended, Groceries goes up, Netflix is cancelled for the summer -----
    clock.set('2026-05-15T09:00:00Z');
    const may = await budgets();
    expect(may.find((b) => b.id === holiday.id)).toMatchObject({
      status: 'ended',
      current: { effectiveMonth: '2026-01', amount: 15000, incremental: true },
    });
    expect(may.find((b) => b.id === groceries.id)).toMatchObject({
      status: 'active',
      current: { effectiveMonth: '2026-05', amount: 42000, incremental: false },
      hasHistory: true,
    });
    await request(app)
      .post(`/api/subscriptions/${netflix.id}/cancel`)
      .send({ endMonth: '2026-06' })
      .expect(200);

    // --- June 30th and July 1st: the end of the last charged month ---------------------------
    clock.set('2026-06-30T23:59:59Z');
    expect((await subscriptions()).find((s) => s.id === netflix.id)).toMatchObject({
      status: 'active',
      endMonth: '2026-06',
      currentPrice: 1399,
    });
    clock.set('2026-07-01T00:00:00Z');
    expect((await subscriptions()).find((s) => s.id === netflix.id)).toMatchObject({
      status: 'cancelled',
      currentPrice: 1399,
    });

    // --- The whole story, to the cent ---------------------------------------------------------
    const all = await spendingsOf('limit=200');
    expect(all.total).toBe(8); // 3 in January, 3 in February, 1 in March, 1 in April
    // 8450 + 12075 + 5000 + 40100 - 2500 + 7000 + 6000 + 3000 = 79125
    expect(all.totalAmount).toBe(79125);
    expect(all.items.map((s) => s.date)).toEqual(
      [...all.items.map((s) => s.date)].sort().reverse(),
    );

    const perMonth = await Promise.all(
      ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'].map(
        async (m) => (await spendingsOf(`month=${m}`)).totalAmount,
      ),
    );
    expect(perMonth).toEqual([25525, 44600, 6000, 3000, 0]);
    expect(perMonth.reduce((a, b) => a + b, 0)).toBe(all.totalAmount);

    const finalBudgets = await budgets();
    expect(
      finalBudgets.map((b) => [
        b.name,
        b.status,
        b.versions.map((v) => `${v.effectiveMonth}:${v.amount}`),
      ]),
    ).toEqual([
      ['Groceries', 'active', ['2026-01:40000', '2026-05:42000']],
      ['Holiday', 'ended', ['2026-01:15000']],
    ]);

    // A hard delete of a subscription leaves every other fact alone.
    await request(app).delete(`/api/subscriptions/${domain.id}`).expect(204);
    expect((await subscriptions()).map((s) => s.name)).toEqual(['Netflix']);
    expect((await spendingsOf('')).totalAmount).toBe(79125);
  });
});
