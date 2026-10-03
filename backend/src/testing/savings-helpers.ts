/**
 * Helpers for the savings and goals tests: typed shortcuts for the setup calls (each asserts the
 * status it expects), the world most scenarios start from, and `expectSavingsIdentities`, which
 * checks every identity of docs/DOMAIN.md ("Savings", invariants 6 and 7) against numbers it reads
 * from OTHER endpoints (the raw transactions, the month summaries and the month views), so a bug in
 * `GET /api/savings` cannot hide behind itself.
 */
import {
  type GoalCreateInput,
  type GoalDto,
  type MonthSummary,
  type MonthView,
  type Page,
  type SavingsDto,
  type SavingsSettleInput,
  type SavingsTransactionCreateInput,
  type SavingsTransactionDto,
  type SettingsDto,
  type TodayResponse,
  addMonths,
} from '@wallet/shared';
import type { Express } from 'express';
import request from 'supertest';
import { expect } from 'vitest';
import { createTestApp } from './test-app';
import { addBudget, addSpending, addSubscription, mutableClock, onboard } from './helpers';

export const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

// -------------------------------------------------------------------------------------------------
// Setup calls
// -------------------------------------------------------------------------------------------------

export async function getSavings(app: Express): Promise<SavingsDto> {
  return (await request(app).get('/api/savings').expect(200)).body as SavingsDto;
}

export async function addGoal(app: Express, body: Partial<GoalCreateInput> = {}): Promise<GoalDto> {
  const res = await request(app)
    .post('/api/goals')
    .send({ name: 'Holiday', targetAmount: 100000, ...body })
    .expect(201);
  return res.body as GoalDto;
}

/** POST /api/savings/settle/:month, not asserting the status. */
export const settle = (app: Express, month: string, body: object) =>
  request(app).post(`/api/savings/settle/${month}`).send(body);

/** POST /api/savings/settle/:month, which must answer 201. */
export async function settleOk(
  app: Express,
  month: string,
  body: SavingsSettleInput,
): Promise<SavingsTransactionDto[]> {
  const res = await settle(app, month, body).expect(201);
  return res.body as SavingsTransactionDto[];
}

/** DELETE /api/savings/settle/:month, which must answer 204. */
export async function undoSettlement(app: Express, month: string): Promise<void> {
  await request(app).delete(`/api/savings/settle/${month}`).expect(204);
}

/** POST /api/savings/transactions, not asserting the status. */
export const postTransaction = (app: Express, body: object) =>
  request(app).post('/api/savings/transactions').send(body);

/** POST /api/savings/transactions, which must answer 201. */
export async function addTransaction(
  app: Express,
  body: SavingsTransactionCreateInput,
): Promise<SavingsTransactionDto[]> {
  const res = await postTransaction(app, body).expect(201);
  return res.body as SavingsTransactionDto[];
}

/** Every savings transaction, newest first, read page by page. */
export async function allTransactions(app: Express): Promise<SavingsTransactionDto[]> {
  const rows: SavingsTransactionDto[] = [];
  for (let offset = 0; ; offset += 200) {
    const res = await request(app)
      .get(`/api/savings/transactions?limit=200&offset=${offset}`)
      .expect(200);
    const page = res.body as Page<SavingsTransactionDto>;
    rows.push(...page.items);
    if (offset + 200 >= page.total) return rows;
  }
}

// -------------------------------------------------------------------------------------------------
// The world most savings tests start from
// -------------------------------------------------------------------------------------------------

/**
 * Tracking since January 2026 and it is 15 March 2026, so January and February are closed. A salary
 * of 3,000.00 and an opening balance of 500.00. The facts, and what they add up to by hand:
 *
 * - Netflix, monthly, 12.99. Insurance, yearly, 120.00 renewing in June, from January and cancelled
 *   with `endMonth` February: its reserve is 20.00 in January, and it is released in February.
 * - Groceries, 400.00, not incremental. Spent: 310.00 in January and 450.00 in February.
 *
 * ```
 *                          2026-01     2026-02
 * income                  3,000.00    3,000.00
 * fixed costs                32.99       12.99      (Netflix 12.99 + insurance reserve 20.00 / 0)
 * allocated                 400.00      400.00
 * unallocated             2,567.01    2,587.01
 * Groceries remaining         90.00      -50.00      (toSavings, not incremental)
 * reserves released            0.00       20.00
 * savings due             2,657.01    2,557.01      (Σ 5,214.02)
 * ```
 *
 * In cents: January 265701 = 256701 + 9000 + 0, February 255701 = 258701 - 5000 + 2000.
 */
export async function setUpTwoClosedMonths() {
  const clock = mutableClock('2026-03-15T10:00:00Z');
  const { app, db } = createTestApp(clock);
  await onboard(app, { startMonth: '2026-01', salary: 300000, openingSavings: 50000 });
  const groceries = await addBudget(app, {
    name: 'Groceries',
    amount: 40000,
    incremental: false,
    startMonth: '2026-01',
  });
  await addSubscription(app, {
    name: 'Netflix',
    frequency: 'monthly',
    anchorDate: '2026-01-15',
    amount: 1299,
    startMonth: '2026-01',
  });
  const insurance = await addSubscription(app, {
    name: 'Insurance',
    frequency: 'yearly',
    anchorDate: '2026-06-15',
    amount: 12000,
    startMonth: '2026-01',
  });
  await request(app)
    .post(`/api/subscriptions/${insurance.id}/cancel`)
    .send({ endMonth: '2026-02' })
    .expect(200);
  await addSpending(app, { budgetId: groceries.id, date: '2026-01-12', amount: 31000 });
  await addSpending(app, { budgetId: groceries.id, date: '2026-02-12', amount: 45000 });
  return { app, db, clock, groceries };
}

// -------------------------------------------------------------------------------------------------
// Identities
// -------------------------------------------------------------------------------------------------

/**
 * Reads `GET /api/savings` and asserts every identity of docs/DOMAIN.md against numbers taken from
 * other endpoints, then returns it:
 *
 * - `balance` is the sum of every transaction, `unassigned` the sum of the rows with no goal, a
 *   goal's `balance` the sum of its rows, and so `balance = unassigned + Σ goal balances`;
 * - `outstandingTotal = Σ outstanding`, and `outstanding = savingsDue - settled` for each month;
 * - the list holds exactly the closed months whose `savingsDue - settled` is not 0, ascending, with
 *   the `savingsDue` and the `breakdown` of `GET /api/months/:month`, and `settled` is the sum of
 *   the settlement rows of that month;
 * - `Σ savingsDue over the closed months = Σ settled + Σ outstanding`;
 * - an `adjustment` month is one with settlement rows.
 */
export async function expectSavingsIdentities(app: Express): Promise<SavingsDto> {
  const savings = await getSavings(app);
  const rows = await allTransactions(app);
  const today = (await request(app).get('/api/today').expect(200)).body as TodayResponse;
  const settings = (await request(app).get('/api/settings').expect(200)).body as SettingsDto;

  // Balances: everything is a sum of rows.
  expect(savings.balance).toBe(sum(rows.map((row) => row.amount)));
  expect(savings.unassigned).toBe(
    sum(rows.filter((row) => row.goalId === null).map((row) => row.amount)),
  );
  for (const goal of savings.goals) {
    expect(goal.balance, `goal ${goal.id}`).toBe(
      sum(rows.filter((row) => row.goalId === goal.id).map((row) => row.amount)),
    );
  }
  expect(savings.balance).toBe(savings.unassigned + sum(savings.goals.map((goal) => goal.balance)));
  expect(savings.goals.map((goal) => goal.archived)).toEqual(
    savings.goals.map((goal) => goal.archived).sort(),
  );

  // The closed months, and what was settled in each, from other endpoints.
  const lastClosed = addMonths(today.month, -1);
  const summaries =
    settings.startMonth <= lastClosed
      ? ((
          await request(app)
            .get(`/api/months?from=${settings.startMonth}&to=${lastClosed}`)
            .expect(200)
        ).body as MonthSummary[])
      : [];
  const settledOf = (month: string) =>
    sum(
      rows
        .filter((row) => row.kind === 'settlement' && row.settlesMonth === month)
        .map((row) => row.amount),
    );
  const hasSettlement = (month: string) =>
    rows.some((row) => row.kind === 'settlement' && row.settlesMonth === month);

  // The list: exactly the closed months with something outstanding, ascending.
  const expectedMonths = summaries
    .filter((summary) => summary.savingsDue - settledOf(summary.month) !== 0)
    .map((summary) => summary.month);
  expect(savings.outstanding.map((entry) => entry.month)).toEqual(expectedMonths);

  for (const entry of savings.outstanding) {
    const view = (await request(app).get(`/api/months/${entry.month}`).expect(200))
      .body as MonthView;
    expect(view.status).toBe('closed');
    expect(entry.savingsDue, `${entry.month} savingsDue`).toBe(view.savingsDue.total);
    expect(entry.breakdown).toEqual({
      unallocated: view.savingsDue.unallocated,
      budgetsSettled: view.savingsDue.budgetsSettled,
      reservesReleased: view.savingsDue.reservesReleased,
    });
    expect(sum(Object.values(entry.breakdown))).toBe(entry.savingsDue);
    expect(entry.settled, `${entry.month} settled`).toBe(settledOf(entry.month));
    expect(entry.outstanding).toBe(entry.savingsDue - entry.settled);
    expect(entry.outstanding).not.toBe(0);
    expect(entry.direction).toBe(entry.outstanding > 0 ? 'move' : 'take');
    expect(entry.adjustment).toBe(hasSettlement(entry.month));
  }
  expect(savings.outstandingTotal).toBe(sum(savings.outstanding.map((entry) => entry.outstanding)));

  // Conservation of the money due: what the closed months produced is settled or outstanding.
  const settledInClosedMonths = sum(
    rows
      .filter((row) => row.kind === 'settlement' && (row.settlesMonth ?? '') < today.month)
      .map((row) => row.amount),
  );
  expect(sum(summaries.map((summary) => summary.savingsDue))).toBe(
    settledInClosedMonths + savings.outstandingTotal,
  );
  return savings;
}
