import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BudgetDto } from '@wallet/shared';
import type { Db } from '../../db/client';
import { budgetVersions } from '../../db/schema';
import {
  type MutableClock,
  addBudget,
  addSpending,
  expectNotFound,
  expectRuleViolation,
  expectValidationError,
  insertTransfer,
  mutableClock,
  onboard,
  withTimeZone,
} from '../../testing/helpers';
import { createTestApp } from '../../testing/test-app';
import { expectApiError } from '../../testing/helpers';

let app: ReturnType<typeof createTestApp>['app'];
let db: Db;
let clock: MutableClock;

beforeEach(async () => {
  clock = mutableClock('2026-03-15T10:00:00Z');
  ({ app, db } = createTestApp(clock));
  await onboard(app, { startMonth: '2026-01' });
});

const list = async (): Promise<BudgetDto[]> =>
  (await request(app).get('/api/budgets').expect(200)).body;

describe('GET /api/budgets', () => {
  it('is an empty list when there are none', async () => {
    expect(await list()).toEqual([]);
  });

  it('is ascending by sortOrder, ties broken by id', async () => {
    const a = await addBudget(app, { name: 'A', sortOrder: 20 });
    const b = await addBudget(app, { name: 'B', sortOrder: 5 });
    const c = await addBudget(app, { name: 'C', sortOrder: 5 });
    const d = await addBudget(app, { name: 'D', sortOrder: 0 });
    expect((await list()).map((x) => x.id)).toEqual([d.id, b.id, c.id, a.id]);
  });

  it('returns budgets of every status', async () => {
    const active = await addBudget(app, { name: 'Active' });
    const upcoming = await addBudget(app, { name: 'Upcoming', startMonth: '2026-05' });
    const ended = await addBudget(app, { name: 'Ended', startMonth: '2026-01' });
    await request(app)
      .post(`/api/budgets/${ended.id}/archive`)
      .send({ endMonth: '2026-02' })
      .expect(200);

    const byId = new Map((await list()).map((b) => [b.id, b.status]));
    expect(byId.get(active.id)).toBe('active');
    expect(byId.get(upcoming.id)).toBe('upcoming');
    expect(byId.get(ended.id)).toBe('ended');
  });

  it('reflects a reorder made by patching sortOrder', async () => {
    const a = await addBudget(app, { name: 'A' });
    const b = await addBudget(app, { name: 'B' });
    const c = await addBudget(app, { name: 'C' });
    expect((await list()).map((x) => x.id)).toEqual([a.id, b.id, c.id]);
    await request(app).patch(`/api/budgets/${a.id}`).send({ sortOrder: 15 }).expect(200);
    expect((await list()).map((x) => x.id)).toEqual([b.id, a.id, c.id]);
  });
});

describe('POST /api/budgets', () => {
  it('creates a budget with its first version and answers 201 with the full DTO', async () => {
    const res = await request(app)
      .post('/api/budgets')
      .send({ name: 'Groceries', amount: 40000, incremental: false })
      .expect(201);
    expect(res.body).toEqual({
      id: 1,
      name: 'Groceries',
      color: null,
      icon: null,
      sortOrder: 0,
      startMonth: '2026-03',
      endMonth: null,
      alertWarnPercent: null,
      notes: null,
      versions: [{ effectiveMonth: '2026-03', amount: 40000, incremental: false }],
      current: { effectiveMonth: '2026-03', amount: 40000, incremental: false },
      hasHistory: false,
      status: 'active',
    });
    expect(await list()).toEqual([res.body]);
  });

  it('stores every optional field, normalizing them', async () => {
    const res = await request(app)
      .post('/api/budgets')
      .send({
        name: '  Fun  ',
        amount: 15000,
        incremental: true,
        startMonth: '2026-02',
        color: '#3B82F6',
        icon: '🎬',
        sortOrder: 7,
        alertWarnPercent: 95,
        notes: '  Cinema and games  ',
      })
      .expect(201);
    expect(res.body).toMatchObject({
      name: 'Fun',
      color: '#3b82f6',
      icon: '🎬',
      sortOrder: 7,
      startMonth: '2026-02',
      alertWarnPercent: 95,
      notes: 'Cinema and games',
      versions: [{ effectiveMonth: '2026-02', amount: 15000, incremental: true }],
    });
  });

  it('accepts nulls and blank notes as "not set"', async () => {
    const res = await request(app)
      .post('/api/budgets')
      .send({
        name: 'X',
        amount: 0,
        incremental: false,
        color: null,
        icon: null,
        alertWarnPercent: null,
        notes: ' ',
      })
      .expect(201);
    expect(res.body).toMatchObject({
      color: null,
      icon: null,
      alertWarnPercent: null,
      notes: null,
    });
    expect(res.body.versions).toEqual([
      { effectiveMonth: '2026-03', amount: 0, incremental: false },
    ]);
  });

  it('puts a budget without a sortOrder after the last one, in steps of 10', async () => {
    const a = await addBudget(app, { name: 'A' });
    const b = await addBudget(app, { name: 'B' });
    const c = await addBudget(app, { name: 'C', sortOrder: 3 });
    const d = await addBudget(app, { name: 'D' });
    // D goes after the highest sortOrder (B's 10), not after C that was placed by hand.
    expect([a.sortOrder, b.sortOrder, c.sortOrder, d.sortOrder]).toEqual([0, 10, 3, 20]);
    expect((await list()).map((x) => x.name)).toEqual(['A', 'C', 'B', 'D']);
  });

  it('never exceeds the largest sortOrder the contract accepts', async () => {
    await addBudget(app, { name: 'Last', sortOrder: 1_000_000 });
    const next = await addBudget(app, { name: 'After' });
    expect(next.sortOrder).toBe(1_000_000);
    // Tied on sortOrder, the later id still comes last.
    expect((await list()).map((x) => x.name)).toEqual(['Last', 'After']);
  });

  it('starts in a past month (from settings.startMonth on) and is active', async () => {
    const budget = await addBudget(app, { startMonth: '2026-01' });
    expect(budget.versions).toEqual([
      { effectiveMonth: '2026-01', amount: 40000, incremental: false },
    ]);
    expect(budget.status).toBe('active');
    expect(budget.current).toEqual(budget.versions[0]);
  });

  it('starts in a future month: upcoming, with no current version yet', async () => {
    const budget = await addBudget(app, { startMonth: '2026-05' });
    expect(budget.status).toBe('upcoming');
    expect(budget.current).toBeNull();
    expect(budget.versions).toEqual([
      { effectiveMonth: '2026-05', amount: 40000, incremental: false },
    ]);
  });

  describe('before_start_month (422)', () => {
    it('refuses a start month before settings.startMonth and stores nothing', async () => {
      const res = await request(app)
        .post('/api/budgets')
        .send({ name: 'Old', amount: 1, incremental: false, startMonth: '2025-12' });
      expectRuleViolation(res, 'before_start_month', 'startMonth');
      expect(await list()).toEqual([]);
      expect(db.select().from(budgetVersions).all()).toEqual([]);
    });

    it('accepts settings.startMonth itself (the boundary)', async () => {
      await addBudget(app, { startMonth: '2026-01' });
    });
  });

  describe('validation (400)', () => {
    it.each([
      ['an empty body', {}, 'name'],
      ['a missing name', { amount: 1, incremental: false }, 'name'],
      ['a blank name', { name: ' ', amount: 1, incremental: false }, 'name'],
      [
        'a name over 60 characters',
        { name: 'x'.repeat(61), amount: 1, incremental: false },
        'name',
      ],
      ['a missing amount', { name: 'x', incremental: false }, 'amount'],
      ['a negative amount', { name: 'x', amount: -1, incremental: false }, 'amount'],
      ['a fractional amount', { name: 'x', amount: 9.99, incremental: false }, 'amount'],
      ['a string amount', { name: 'x', amount: '10', incremental: false }, 'amount'],
      ['a missing incremental', { name: 'x', amount: 1 }, 'incremental'],
      ['a numeric incremental', { name: 'x', amount: 1, incremental: 1 }, 'incremental'],
      [
        'a bad startMonth',
        { name: 'x', amount: 1, incremental: false, startMonth: '2026-3' },
        'startMonth',
      ],
      ['a bad color', { name: 'x', amount: 1, incremental: false, color: 'blue' }, 'color'],
      ['an empty icon', { name: 'x', amount: 1, incremental: false, icon: '' }, 'icon'],
      [
        'a negative sortOrder',
        { name: 'x', amount: 1, incremental: false, sortOrder: -1 },
        'sortOrder',
      ],
      [
        'an alert percent of 0',
        { name: 'x', amount: 1, incremental: false, alertWarnPercent: 0 },
        'alertWarnPercent',
      ],
      [
        'an alert percent of 101',
        { name: 'x', amount: 1, incremental: false, alertWarnPercent: 101 },
        'alertWarnPercent',
      ],
      [
        'an endMonth (use archive)',
        { name: 'x', amount: 1, incremental: false, endMonth: '2026-06' },
        '',
      ],
      ['an unknown key', { name: 'x', amount: 1, incremental: false, id: 5 }, ''],
    ])('rejects %s', async (_label, body, path) => {
      const res = await request(app).post('/api/budgets').send(body);
      expectValidationError(res, path);
      expect(await list()).toEqual([]);
    });
  });
});

describe('PATCH /api/budgets/:id', () => {
  it('renames and restyles a budget, leaving its versions alone', async () => {
    const budget = await addBudget(app, { name: 'Groceries' });
    const res = await request(app)
      .patch(`/api/budgets/${budget.id}`)
      .send({ name: 'Food', color: '#AABBCC', icon: 'cart', alertWarnPercent: 90, notes: 'Weekly' })
      .expect(200);
    expect(res.body).toEqual({
      ...budget,
      name: 'Food',
      color: '#aabbcc',
      icon: 'cart',
      alertWarnPercent: 90,
      notes: 'Weekly',
    });
    expect(await list()).toEqual([res.body]);
  });

  it('clears color, icon, alertWarnPercent and notes with null', async () => {
    const budget = await addBudget(app, {
      color: '#112233',
      icon: 'x',
      alertWarnPercent: 70,
      notes: 'n',
    });
    const res = await request(app)
      .patch(`/api/budgets/${budget.id}`)
      .send({ color: null, icon: null, alertWarnPercent: null, notes: null })
      .expect(200);
    expect(res.body).toMatchObject({
      color: null,
      icon: null,
      alertWarnPercent: null,
      notes: null,
    });
  });

  it('turns blank notes into null', async () => {
    const budget = await addBudget(app, { notes: 'n' });
    const res = await request(app)
      .patch(`/api/budgets/${budget.id}`)
      .send({ notes: '   ' })
      .expect(200);
    expect(res.body.notes).toBeNull();
  });

  it('changes one field and keeps the others', async () => {
    const budget = await addBudget(app, { color: '#112233', notes: 'keep me' });
    const res = await request(app)
      .patch(`/api/budgets/${budget.id}`)
      .send({ sortOrder: 40 })
      .expect(200);
    expect(res.body).toEqual({ ...budget, sortOrder: 40 });
  });

  it('is a 404 for an unknown id', async () => {
    expectNotFound(await request(app).patch('/api/budgets/99').send({ name: 'x' }));
  });

  describe('validation (400)', () => {
    it.each([
      ['an empty body', {}, ''],
      ['a blank name', { name: '' }, 'name'],
      ['a null name', { name: null }, 'name'],
      ['a bad color', { color: 'red' }, 'color'],
      ['a bad alert percent', { alertWarnPercent: 150 }, 'alertWarnPercent'],
      ['a bad sortOrder', { sortOrder: -3 }, 'sortOrder'],
      ['a bad startMonth', { startMonth: '2026-00' }, 'startMonth'],
      ['a null startMonth', { startMonth: null }, 'startMonth'],
      ['an amount (use versions)', { amount: 100 }, ''],
      ['incremental (use versions)', { incremental: true }, ''],
      ['an endMonth (use archive)', { endMonth: '2026-06' }, ''],
    ])('rejects %s', async (_label, body, path) => {
      const budget = await addBudget(app);
      expectValidationError(await request(app).patch(`/api/budgets/${budget.id}`).send(body), path);
      expect(await list()).toEqual([budget]);
    });

    it.each(['abc', '0', '-2', '1.5', '99999999999999999999999'])(
      'rejects the id %j',
      async (id) => {
        expectValidationError(
          await request(app).patch(`/api/budgets/${id}`).send({ name: 'x' }),
          'id',
        );
      },
    );

    it('checks the body before looking the budget up', async () => {
      expectValidationError(await request(app).patch('/api/budgets/99').send({}), '');
    });
  });
});

describe('DELETE /api/budgets/:id', () => {
  it('deletes a budget without history (204, no body), versions included', async () => {
    const budget = await addBudget(app);
    await request(app)
      .put(`/api/budgets/${budget.id}/versions/2026-06`)
      .send({ amount: 5, incremental: true })
      .expect(200);
    expect(db.select().from(budgetVersions).all()).toHaveLength(2);

    const res = await request(app).delete(`/api/budgets/${budget.id}`).expect(204);
    expect(res.text).toBe('');
    expect(await list()).toEqual([]);
    expect(db.select().from(budgetVersions).all()).toEqual([]);
  });

  it('is a 404 for an unknown id and for a second delete', async () => {
    const budget = await addBudget(app);
    expectNotFound(await request(app).delete('/api/budgets/99'));
    await request(app).delete(`/api/budgets/${budget.id}`).expect(204);
    expectNotFound(await request(app).delete(`/api/budgets/${budget.id}`));
  });

  it('rejects a bad id (400)', async () => {
    expectValidationError(await request(app).delete('/api/budgets/abc'), 'id');
  });

  it('refuses a budget with a spending (409 has_history) and keeps everything', async () => {
    const budget = await addBudget(app);
    await addSpending(app, { budgetId: budget.id });
    const res = await request(app).delete(`/api/budgets/${budget.id}`);
    expectApiError(res, 'has_history');
    expect((await list())[0]).toMatchObject({ id: budget.id, hasHistory: true });
  });

  it('refuses a budget with a transfer into it', async () => {
    const budget = await addBudget(app);
    insertTransfer(db, { date: '2026-03-02', toBudgetId: budget.id });
    expectApiError(await request(app).delete(`/api/budgets/${budget.id}`), 'has_history');
  });

  it('refuses a budget with a transfer out of it', async () => {
    const budget = await addBudget(app);
    const other = await addBudget(app, { name: 'Other' });
    insertTransfer(db, { date: '2026-03-02', fromBudgetId: budget.id, toBudgetId: other.id });
    expectApiError(await request(app).delete(`/api/budgets/${budget.id}`), 'has_history');
    expectApiError(await request(app).delete(`/api/budgets/${other.id}`), 'has_history');
  });

  it('refuses an archived budget with history too: it can only stay archived', async () => {
    const budget = await addBudget(app);
    await addSpending(app, { budgetId: budget.id });
    await request(app).post(`/api/budgets/${budget.id}/archive`).send({}).expect(200);
    expectApiError(await request(app).delete(`/api/budgets/${budget.id}`), 'has_history');
  });

  it('allows the delete again once the last spending is gone', async () => {
    const budget = await addBudget(app);
    const spending = await addSpending(app, { budgetId: budget.id });
    expectApiError(await request(app).delete(`/api/budgets/${budget.id}`), 'has_history');
    await request(app).delete(`/api/spendings/${spending.id}`).expect(204);
    await request(app).delete(`/api/budgets/${budget.id}`).expect(204);
  });
});

describe('hasHistory', () => {
  it('follows the spendings and transfers of each budget separately', async () => {
    const withSpending = await addBudget(app, { name: 'Spent' });
    const withTransferIn = await addBudget(app, { name: 'In' });
    const withTransferOut = await addBudget(app, { name: 'Out' });
    await addBudget(app, { name: 'Untouched' });
    await addSpending(app, { budgetId: withSpending.id });
    insertTransfer(db, {
      date: '2026-03-02',
      fromBudgetId: withTransferOut.id,
      toBudgetId: withTransferIn.id,
    });

    const flags = Object.fromEntries((await list()).map((b) => [b.name, b.hasHistory]));
    expect(flags).toEqual({ Spent: true, In: true, Out: true, Untouched: false });
  });

  it('is the same in the DTO of a single-budget response', async () => {
    const budget = await addBudget(app);
    await addSpending(app, { budgetId: budget.id });
    const res = await request(app)
      .patch(`/api/budgets/${budget.id}`)
      .send({ name: 'Renamed' })
      .expect(200);
    expect(res.body.hasHistory).toBe(true);
  });
});

describe('status and current around month boundaries', () => {
  it('turns upcoming into active in the first instant of the start month', async () => {
    clock.set('2026-03-31T23:59:59Z');
    const budget = await addBudget(app, { startMonth: '2026-04' });
    expect(budget).toMatchObject({ status: 'upcoming', current: null });

    clock.set('2026-04-01T00:00:00Z');
    expect((await list())[0]).toMatchObject({
      status: 'active',
      current: { effectiveMonth: '2026-04', amount: 40000, incremental: false },
    });
  });

  it('keeps a budget archived with this month as end month active until the month is over', async () => {
    clock.set('2026-03-15T10:00:00Z');
    const budget = await addBudget(app, { startMonth: '2026-01' });
    await request(app)
      .post(`/api/budgets/${budget.id}/archive`)
      .send({ endMonth: '2026-03' })
      .expect(200);
    expect((await list())[0]).toMatchObject({ status: 'active', endMonth: '2026-03' });

    clock.set('2026-03-31T23:59:59Z');
    expect((await list())[0]?.status).toBe('active');

    clock.set('2026-04-01T00:00:00Z');
    expect((await list())[0]).toMatchObject({
      status: 'ended',
      // An ended budget still reports the version that was in effect when it ended.
      current: { effectiveMonth: '2026-01', amount: 40000, incremental: false },
    });
  });

  it('has the current version follow a version scheduled for a later month', async () => {
    const budget = await addBudget(app, { startMonth: '2026-01', amount: 40000 });
    await request(app)
      .put(`/api/budgets/${budget.id}/versions/2026-05`)
      .send({ amount: 50000, incremental: true })
      .expect(200);
    expect((await list())[0]?.current).toEqual({
      effectiveMonth: '2026-01',
      amount: 40000,
      incremental: false,
    });

    clock.set('2026-04-30T23:59:59Z');
    expect((await list())[0]?.current?.amount).toBe(40000);
    clock.set('2026-05-01T00:00:00Z');
    expect((await list())[0]?.current).toEqual({
      effectiveMonth: '2026-05',
      amount: 50000,
      incremental: true,
    });
  });

  it('uses the server-local month, so Rome flips a few hours before UTC does', async () => {
    clock.set('2026-03-31T23:30:00Z');
    await addBudget(app, { name: 'April', startMonth: '2026-04' });
    expect((await list())[0]?.status).toBe('upcoming');
    const inRome = await withTimeZone('Europe/Rome', list);
    expect(inRome[0]).toMatchObject({ status: 'active', current: { effectiveMonth: '2026-04' } });
  });

  it('flips at New Year', async () => {
    const other = createTestApp(mutableClock('2026-12-31T23:59:59Z'));
    await onboard(other.app, { startMonth: '2026-01' });
    const budget = await addBudget(other.app, { startMonth: '2027-01' });
    expect(budget.status).toBe('upcoming');
    const res = await withTimeZone('Asia/Tokyo', () => request(other.app).get('/api/budgets'));
    expect(res.body[0].status).toBe('active');
  });
});

it('every response is JSON', async () => {
  const res = await request(app).get('/api/budgets');
  expect(res.headers['content-type']).toMatch(/application\/json/);
});
