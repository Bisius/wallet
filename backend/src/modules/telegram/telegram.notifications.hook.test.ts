/**
 * The `/api` write hook of the budget alerts (docs/DOMAIN.md, "Budget alerts": "After every
 * successful mutating /api request ... debounced by 2 seconds, so that a CSV import commit sends one
 * message"). The hook itself is unit-tested with a fake request and response, and then through the
 * real app with supertest on real timers and a tiny debounce (supertest hangs under fake timers).
 */
import type { Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app';
import { createDb, runMigrations } from '../../db/client';
import { fakeTelegram } from '../../testing/fake-telegram';
import { addBudget, addSpending, onboard } from '../../testing/helpers';
import { BANK_MAPPING, allToBudget, bankFile } from '../../testing/import-helpers';
import { type NotifyHarness, createNotifyHarness } from '../../testing/telegram-notify-harness';
import { budgetAlertWriteHook } from './telegram.notifications';

// Call through to the real hook, but let a test see whether `createApp` asked for one.
vi.mock('./telegram.notifications', async (importOriginal) => {
  const original = await importOriginal<typeof import('./telegram.notifications')>();
  return { ...original, budgetAlertWriteHook: vi.fn(original.budgetAlertWriteHook) };
});

const open: NotifyHarness[] = [];
afterEach(async () => {
  vi.mocked(budgetAlertWriteHook).mockClear();
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((h) => h.close()));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- The hook on its own ----------------------------------------------------------------------

/** Runs the hook for one request and finishes it with `status`. Returns what was asked for. */
function runHook(
  method: string,
  path: string,
  status: number,
  notify = { scheduleBudgetAlertCheck: vi.fn() },
) {
  const hook = budgetAlertWriteHook(notify);
  const res = Object.assign(new EventEmitter(), { statusCode: 200 }) as unknown as Response;
  const next = vi.fn();
  hook({ method, path } as Request, res, next);
  expect(next).toHaveBeenCalledTimes(1); // it never answers or holds back a request
  expect(notify.scheduleBudgetAlertCheck).not.toHaveBeenCalled(); // nothing before the response is done
  (res as unknown as { statusCode: number }).statusCode = status; // set once the route has answered
  res.emit('finish');
  return notify.scheduleBudgetAlertCheck;
}

describe('the hook', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'asks for a check after a %s that succeeded',
    (method) => {
      expect(runHook(method, '/spendings', 200)).toHaveBeenCalledTimes(1);
    },
  );

  it.each([200, 201, 204, 302, 399])('counts a status of %i as a success', (status) => {
    expect(runHook('POST', '/spendings', status)).toHaveBeenCalledTimes(1);
  });

  it.each([400, 404, 409, 422, 500, 503])('asks for nothing after a %i', (status) => {
    expect(runHook('POST', '/spendings', status)).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('asks for nothing after a %s', (method) => {
    expect(runHook(method, '/spendings', 200)).not.toHaveBeenCalled();
  });

  it.each([
    '/telegram',
    '/telegram/',
    '/telegram/pairing',
    '/telegram/notifications',
    '/telegram/test',
  ])('leaves out the routes of the bot itself (%s)', (path) => {
    expect(runHook('PUT', path, 200)).not.toHaveBeenCalled();
    expect(runHook('POST', path, 204)).not.toHaveBeenCalled();
    expect(runHook('DELETE', path, 204)).not.toHaveBeenCalled();
  });

  it.each([
    '/spendings',
    '/spendings/5',
    '/import/commit',
    '/budgets/3/versions/2026-03',
    '/telegrams',
    '/telegram-x',
  ])('covers every other route (%s)', (path) => {
    expect(runHook('POST', path, 201)).toHaveBeenCalledTimes(1);
  });

  it('asks once per request, whatever the response does afterwards', () => {
    const notify = { scheduleBudgetAlertCheck: vi.fn() };
    const hook = budgetAlertWriteHook(notify);
    const res = Object.assign(new EventEmitter(), { statusCode: 201 }) as unknown as Response;
    hook({ method: 'POST', path: '/spendings' } as Request, res, vi.fn());
    res.emit('finish');
    res.emit('finish');
    expect(notify.scheduleBudgetAlertCheck).toHaveBeenCalledTimes(1);
  });

  it('never lets a failure to ask take the process down', () => {
    const notify = {
      scheduleBudgetAlertCheck: vi.fn(() => {
        throw new Error('boom');
      }),
    };
    expect(() => runHook('POST', '/spendings', 201, notify)).not.toThrow();
    expect(notify.scheduleBudgetAlertCheck).toHaveBeenCalledTimes(1);
  });
});

// --- Mounted in the app -----------------------------------------------------------------------

describe('createApp', () => {
  it('mounts no hook without a bot, and starts no timer with one', () => {
    const db = createDb(':memory:');
    runMigrations(db);
    const config = { env: 'test' as const, staticDir: undefined };
    const interval = vi.spyOn(globalThis, 'setInterval');
    const timeout = vi.spyOn(globalThis, 'setTimeout');

    createApp({ db, config });
    expect(budgetAlertWriteHook).not.toHaveBeenCalled();

    const telegram = fakeTelegram(db);
    createApp({ db, config, telegram });
    expect(budgetAlertWriteHook).toHaveBeenCalledTimes(1);
    expect(budgetAlertWriteHook).toHaveBeenCalledWith(telegram.notify);

    expect(interval).not.toHaveBeenCalled(); // no tick: only index.ts starts the scheduler
    expect(timeout).not.toHaveBeenCalled();
  });

  it('does not ask for a check on a write when there is no bot', async () => {
    const h = createNotifyHarness();
    open.push(h);
    await onboard(h.setup);
    const budget = await addBudget(h.setup, {
      name: 'Groceries',
      amount: 10000,
      startMonth: '2026-01',
    });
    await addSpending(h.setup, { budgetId: budget.id, amount: 20000 }); // over, and nobody looks
    await sleep(60);
    expect(h.fake.attempts).toEqual([]);
    expect(h.statusSpy).not.toHaveBeenCalled();
  });
});

describe('through the app', () => {
  /** An app wired to the real watcher, with a short debounce so the tests need not wait 2 seconds. */
  async function wired(debounceMs = 40) {
    const h = createNotifyHarness({ debounceMs });
    open.push(h);
    await onboard(h.setup);
    const groceries = await addBudget(h.setup, {
      name: 'Groceries',
      amount: 10000,
      startMonth: '2026-01',
    });
    return { h, groceries, app: h.appWithBot() };
  }

  const post = (app: ReturnType<NotifyHarness['appWithBot']>, budgetId: number, amount: number) =>
    request(app)
      .post('/api/spendings')
      .send({ budgetId, amount, date: '2026-03-10', description: 'x' });

  it('announces an alert after a spending entered through the API, once the debounce has passed', async () => {
    const { h, groceries, app } = await wired();
    await post(app, groceries.id, 11000).expect(201);
    expect(h.fake.attempts).toEqual([]); // not at once
    await vi.waitFor(() => expect(h.texts()).toEqual(['🔴 Groceries is over by €10.00']));
  });

  it('turns several quick writes into one check and one message', async () => {
    const { h, groceries, app } = await wired(250); // the three requests must fall inside one window
    const schedule = vi.spyOn(h.notify, 'scheduleBudgetAlertCheck');
    await post(app, groceries.id, 4000).expect(201);
    await post(app, groceries.id, 4000).expect(201);
    await post(app, groceries.id, 4000).expect(201); // 120.00 of 100.00
    await vi.waitFor(() => expect(h.texts()).toHaveLength(1));
    await sleep(400);
    expect(schedule).toHaveBeenCalledTimes(3);
    expect(h.statusSpy).toHaveBeenCalledTimes(1); // one check for the three writes
    expect(h.texts()).toEqual(['🔴 Groceries is over by €20.00']);
  });

  it('produces one message for a CSV import commit that adds many spendings', async () => {
    const { h, groceries, app } = await wired();
    const rows = Array.from(
      { length: 8 },
      (_, i) => `2026-03-${String(i + 1).padStart(2, '0')},-30.00,Lidl ${i + 1}`,
    );
    const csv = bankFile(rows);
    const res = await request(app)
      .post('/api/import/commit')
      .send({
        csv,
        mapping: BANK_MAPPING,
        rows: allToBudget(
          rows.map((_, i) => i + 2),
          groceries.id,
        ),
      })
      .expect(201);
    expect(res.body.created).toBe(8);

    await vi.waitFor(() => expect(h.texts()).toHaveLength(1));
    await sleep(150);
    expect(h.texts()).toEqual(['🔴 Groceries is over by €140.00']); // 8 x 30.00 = 240.00 of 100.00
    expect(h.statusSpy).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing after a request that failed, or one that only reads', async () => {
    const { h, groceries, app } = await wired();
    const schedule = vi.spyOn(h.notify, 'scheduleBudgetAlertCheck');
    await request(app).get('/api/months/2026-03').expect(200);
    await request(app).post('/api/spendings').send({ budgetId: groceries.id }).expect(400);
    await request(app).delete('/api/spendings/9999').expect(404);
    await request(app).get('/api/spendings').expect(200);
    await sleep(30);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('asks for nothing after a write to /api/telegram itself', async () => {
    const { h, app } = await wired();
    const schedule = vi.spyOn(h.notify, 'scheduleBudgetAlertCheck');
    await request(app)
      .put('/api/telegram/notifications')
      .send({
        budgetAlerts: true,
        renewalYearlyDays: 7,
        renewalMonthlyDays: 1,
        monthlyRecap: true,
        notifyAt: '09:00',
      })
      .expect(200);
    await request(app).post('/api/telegram/test').expect(204);
    await request(app).post('/api/telegram/pairing').expect(201);
    await request(app).delete('/api/telegram/pairing').expect(204);
    await sleep(30);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('asks for a check after every kind of write that changes a figure', async () => {
    const { h, groceries, app } = await wired();
    const schedule = vi
      .spyOn(h.notify, 'scheduleBudgetAlertCheck')
      .mockImplementation(() => undefined);
    let expected = 0;
    // `finish` fires as the response is flushed, a moment before the client reads it.
    const asked = async () => {
      expected += 1;
      await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(expected));
    };

    const created = await post(app, groceries.id, 100).expect(201);
    await asked();
    await request(app).patch(`/api/spendings/${created.body.id}`).send({ amount: 200 }).expect(200);
    await asked();
    await request(app).delete(`/api/spendings/${created.body.id}`).expect(204);
    await asked();
    await request(app)
      .post('/api/incomes')
      .send({ date: '2026-03-05', amount: 5000, description: 'Bonus' })
      .expect(201);
    await asked();
    await request(app)
      .put(`/api/budgets/${groceries.id}/versions/2026-03`)
      .send({ amount: 5000, incremental: false })
      .expect(200);
    await asked();
    // The warning threshold decides the alert level, and the settings routes are reachable before
    // onboarding, so the hook has to sit in front of them too.
    const settings = await request(app).get('/api/settings').expect(200);
    await request(app)
      .put('/api/settings')
      .send({ ...settings.body, alertWarnPercent: 70 })
      .expect(200);
    await asked();
  });
});
