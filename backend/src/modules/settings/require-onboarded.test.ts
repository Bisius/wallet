import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../lib/clock';
import { expectApiError, onboard } from '../../testing/helpers';
import { createTestApp } from '../../testing/test-app';

/** Every guarded endpoint: method, path and a body that would be valid (or, for 'bad', invalid). */
const GUARDED: [string, string, string, object?][] = [
  ['GET', '/api/salary', 'ok'],
  ['PUT', '/api/salary/2026-03', 'ok', { amount: 100 }],
  ['DELETE', '/api/salary/2026-03', 'ok'],
  ['GET', '/api/incomes', 'ok'],
  ['POST', '/api/incomes', 'ok', { date: '2026-03-01', amount: 100, description: 'x' }],
  ['PATCH', '/api/incomes/1', 'ok', { amount: 5 }],
  ['DELETE', '/api/incomes/1', 'ok'],
  ['GET', '/api/budgets', 'ok'],
  ['POST', '/api/budgets', 'ok', { name: 'x', amount: 1, incremental: false }],
  ['PATCH', '/api/budgets/1', 'ok', { name: 'y' }],
  ['PUT', '/api/budgets/1/versions/2026-03', 'ok', { amount: 1, incremental: true }],
  ['POST', '/api/budgets/1/archive', 'ok', {}],
  ['DELETE', '/api/budgets/1', 'ok'],
  ['GET', '/api/subscriptions', 'ok'],
  [
    'POST',
    '/api/subscriptions',
    'ok',
    { name: 'x', frequency: 'monthly', anchorDate: '2026-03-01', amount: 1 },
  ],
  ['PATCH', '/api/subscriptions/1', 'ok', { name: 'y' }],
  ['PUT', '/api/subscriptions/1/prices/2026-03', 'ok', { amount: 1 }],
  ['POST', '/api/subscriptions/1/cancel', 'ok', {}],
  ['DELETE', '/api/subscriptions/1', 'ok'],
  ['GET', '/api/spendings', 'ok'],
  ['POST', '/api/spendings', 'ok', { date: '2026-03-01', amount: 1, budgetId: 1 }],
  ['PATCH', '/api/spendings/1', 'ok', { amount: 5 }],
  ['DELETE', '/api/spendings/1', 'ok'],
  ['GET', '/api/savings', 'ok'],
  ['POST', '/api/savings/settle/2026-02', 'ok', { amount: 100 }],
  ['DELETE', '/api/savings/settle/2026-02', 'ok'],
  ['GET', '/api/savings/transactions', 'ok'],
  ['POST', '/api/savings/transactions', 'ok', { kind: 'deposit', amount: 100 }],
  ['DELETE', '/api/savings/transactions/1', 'ok'],
  ['GET', '/api/savings/opening', 'ok'],
  ['PUT', '/api/savings/opening', 'ok', { amount: 100 }],
  ['GET', '/api/goals', 'ok'],
  ['POST', '/api/goals', 'ok', { name: 'Holiday', targetAmount: 100000 }],
  ['PATCH', '/api/goals/1', 'ok', { name: 'Trip' }],
  ['DELETE', '/api/goals/1', 'ok'],
  ['GET', '/api/transfers', 'ok'],
  [
    'POST',
    '/api/transfers',
    'ok',
    { date: '2026-03-01', fromBudgetId: 1, toBudgetId: null, amount: 100 },
  ],
  ['DELETE', '/api/transfers/1', 'ok'],
  ['GET', '/api/tags', 'ok'],
  ['POST', '/api/tags', 'ok', { name: 'Groceries' }],
  ['PATCH', '/api/tags/1', 'ok', { name: 'Food' }],
  ['DELETE', '/api/tags/1', 'ok'],
  ['GET', '/api/telegram', 'ok'],
  ['POST', '/api/telegram/pairing', 'ok', {}],
  ['DELETE', '/api/telegram/pairing', 'ok'],
  ['DELETE', '/api/telegram/link', 'ok'],
  [
    'PUT',
    '/api/telegram/notifications',
    'ok',
    {
      budgetAlerts: true,
      renewalYearlyDays: 7,
      renewalMonthlyDays: 1,
      monthlyRecap: true,
      notifyAt: '09:00',
    },
  ],
  ['POST', '/api/telegram/test', 'ok', {}],
  // The guard runs before validation: an invalid request is still a 409, not a 400.
  ['POST', '/api/budgets', 'bad', {}],
  ['GET', '/api/spendings?limit=0', 'bad'],
  ['PUT', '/api/salary/not-a-month', 'bad', { amount: -1 }],
  ['DELETE', '/api/budgets/abc', 'bad'],
  ['POST', '/api/savings/settle/not-a-month', 'bad', {}],
  ['POST', '/api/savings/transactions', 'bad', { kind: 'transfer' }],
  ['GET', '/api/savings/transactions?limit=0', 'bad'],
  ['PUT', '/api/savings/opening', 'bad', { amount: -1 }],
  ['POST', '/api/goals', 'bad', {}],
  ['PATCH', '/api/goals/abc', 'bad', {}],
  ['POST', '/api/transfers', 'bad', {}],
  ['GET', '/api/transfers?month=nope', 'bad'],
  ['DELETE', '/api/transfers/abc', 'bad'],
  ['GET', '/api/spendings?minAmount=2&maxAmount=1', 'bad'],
  ['GET', '/api/spendings?q=%20', 'bad'],
  ['POST', '/api/tags', 'bad', {}],
  ['PATCH', '/api/tags/abc', 'bad', {}],
  ['PUT', '/api/telegram/notifications', 'bad', {}],
];

function send(app: Parameters<typeof request>[0], method: string, path: string, body?: object) {
  const req =
    request(app)[method.toLowerCase() as 'get' | 'put' | 'post' | 'patch' | 'delete'](path);
  return body === undefined ? req : req.send(body);
}

describe('the not_onboarded guard', () => {
  it.each(GUARDED)(
    '%s %s (%s request) answers 409 until onboarded',
    async (method, path, _kind, body) => {
      const { app } = createTestApp(fixedClock('2026-03-15T10:00:00Z'));
      expectApiError(await send(app, method, path, body), 'not_onboarded');
    },
  );

  it('lets health, today, settings and onboarding through', async () => {
    const { app } = createTestApp(fixedClock('2026-03-15T10:00:00Z'));
    await request(app).get('/api/health').expect(200);
    await request(app).get('/api/today').expect(200);
    // GET /api/settings is a plain 404 (not a 409) until the settings exist.
    expectApiError(await request(app).get('/api/settings'), 'not_found');
    await request(app)
      .put('/api/settings')
      .send({
        currency: 'EUR',
        locale: 'en-US',
        startMonth: '2026-01',
        theme: 'system',
        alertWarnPercent: 80,
      })
      .expect(200);
  });

  it('lets onboarding through, which then unlocks the rest', async () => {
    const { app } = createTestApp(fixedClock('2026-03-15T10:00:00Z'));
    expectApiError(await request(app).get('/api/budgets'), 'not_onboarded');
    await onboard(app);
    await request(app).get('/api/budgets').expect(200);
  });

  it('is unlocked by the first PUT /api/settings too ("onboarded" just means the settings exist)', async () => {
    const { app } = createTestApp(fixedClock('2026-03-15T10:00:00Z'));
    await request(app)
      .put('/api/settings')
      .send({
        currency: 'EUR',
        locale: 'en-US',
        startMonth: '2026-01',
        theme: 'system',
        alertWarnPercent: 80,
      })
      .expect(200);
    for (const [method, path, , body] of GUARDED.filter(([m, , k]) => m === 'GET' && k === 'ok')) {
      const res = await send(app, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(200);
    }
  });

  it('leaves unknown routes a plain 404', async () => {
    const { app } = createTestApp(fixedClock('2026-03-15T10:00:00Z'));
    expectApiError(await request(app).get('/api/nope'), 'not_found');
  });
});
