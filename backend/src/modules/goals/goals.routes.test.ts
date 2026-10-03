import { MAX_CENTS, NAME_MAX_LENGTH, type GoalDto } from '@wallet/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/client';
import { savingsGoals, savingsTransactions } from '../../db/schema';
import { fixedClock } from '../../lib/clock';
import {
  expectApiError,
  expectNotFound,
  expectValidationError,
  onboard,
} from '../../testing/helpers';
import { addGoal, addTransaction, getSavings } from '../../testing/savings-helpers';
import { createTestApp } from '../../testing/test-app';

let app: ReturnType<typeof createTestApp>['app'];
let db: Db;

beforeEach(async () => {
  ({ app, db } = createTestApp(fixedClock('2026-03-15T10:00:00Z')));
  await onboard(app, { startMonth: '2026-01', salary: 0, openingSavings: 0 });
});

const list = async () => (await request(app).get('/api/goals').expect(200)).body as GoalDto[];

describe('GET /api/goals', () => {
  it('is an empty list before any goal exists', async () => {
    expect(await list()).toEqual([]);
  });

  it('returns exactly the documented fields of a new goal, every figure derived', async () => {
    await addGoal(app, { name: 'Holiday', targetAmount: 100000 });
    const [goal] = await list();
    expect(goal).toEqual({
      id: 1,
      name: 'Holiday',
      targetAmount: 100000,
      deadline: null,
      color: null,
      archived: false,
      balance: 0,
      progressPercent: 0,
      remaining: 100000,
      reached: false,
      monthlyNeeded: null,
      status: 'active',
    });
  });

  it('lists archived goals last, each group in creation order', async () => {
    const [a, b, c, d] = [
      await addGoal(app, { name: 'A' }),
      await addGoal(app, { name: 'B' }),
      await addGoal(app, { name: 'C' }),
      await addGoal(app, { name: 'D' }),
    ];
    await request(app).patch(`/api/goals/${a.id}`).send({ archived: true }).expect(200);
    await request(app).patch(`/api/goals/${c.id}`).send({ archived: true }).expect(200);
    expect((await list()).map((goal) => goal.name)).toEqual(['B', 'D', 'A', 'C']);
    // Bringing one back puts it among the others again, by creation order.
    await request(app).patch(`/api/goals/${a.id}`).send({ archived: false }).expect(200);
    expect((await list()).map((goal) => goal.name)).toEqual(['A', 'B', 'D', 'C']);
    expect([a.id, b.id, c.id, d.id]).toEqual([1, 2, 3, 4]);
  });

  it('derives the balance and the progress from the savings transactions', async () => {
    const goal = await addGoal(app, { targetAmount: 100000 });
    await addTransaction(app, { kind: 'deposit', amount: 25000, goalId: goal.id });
    expect((await list())[0]).toMatchObject({
      balance: 25000,
      progressPercent: 25,
      remaining: 75000,
      reached: false,
      status: 'active',
    });
  });

  it('is the same list as the goals of GET /api/savings', async () => {
    const holiday = await addGoal(app, { name: 'Holiday' });
    await addGoal(app, { name: 'Car', deadline: '2026-12-31', color: '#ff0000' });
    await addTransaction(app, { kind: 'deposit', amount: 500, goalId: holiday.id });
    await request(app).patch('/api/goals/2').send({ archived: true }).expect(200);
    expect((await getSavings(app)).goals).toEqual(await list());
  });
});

describe('POST /api/goals', () => {
  it('creates a goal with the defaults and answers 201 with its DTO', async () => {
    const res = await request(app)
      .post('/api/goals')
      .send({ name: 'Holiday', targetAmount: 100000 })
      .expect(201);
    expect(res.body).toEqual({
      id: 1,
      name: 'Holiday',
      targetAmount: 100000,
      deadline: null,
      color: null,
      archived: false,
      balance: 0,
      progressPercent: 0,
      remaining: 100000,
      reached: false,
      monthlyNeeded: null,
      status: 'active',
    });
    expect(db.select().from(savingsGoals).get()?.createdAt).toBe('2026-03-15T10:00:00.000Z');
  });

  it('trims the name, lower-cases the color and works out the monthly amount of a deadline', async () => {
    // Today is 2026-03-15: March to August is 6 months, and ceilDiv(100000, 6) is 16667.
    const res = await request(app)
      .post('/api/goals')
      .send({ name: '  Holiday  ', targetAmount: 100000, deadline: '2026-08-20', color: '#3B82F6' })
      .expect(201);
    expect(res.body).toMatchObject({
      name: 'Holiday',
      deadline: '2026-08-20',
      color: '#3b82f6',
      monthlyNeeded: 16667,
      status: 'active',
    });
  });

  it('accepts a null deadline and color like omitting them', async () => {
    const res = await request(app)
      .post('/api/goals')
      .send({ name: 'Car', targetAmount: 5000, deadline: null, color: null })
      .expect(201);
    expect(res.body).toMatchObject({ deadline: null, color: null, monthlyNeeded: null });
  });

  it('accepts a deadline in the past: the goal is overdue at once and needs all of it now', async () => {
    const res = await request(app)
      .post('/api/goals')
      .send({ name: 'Late', targetAmount: 100000, deadline: '2026-02-28' })
      .expect(201);
    expect(res.body).toMatchObject({ status: 'overdue', remaining: 100000, monthlyNeeded: 100000 });
  });

  it('accepts the largest target', async () => {
    await request(app)
      .post('/api/goals')
      .send({ name: 'Big', targetAmount: MAX_CENTS })
      .expect(201);
  });

  it('shows the new goal in GET /api/goals and GET /api/savings', async () => {
    const goal = await addGoal(app);
    expect(await list()).toEqual([goal]);
    expect((await getSavings(app)).goals).toEqual([goal]);
  });

  describe('validation (400)', () => {
    const OK = { name: 'Holiday', targetAmount: 100000 };
    it.each([
      ['an empty body', {}, 'name'],
      ['a missing name', { targetAmount: 1 }, 'name'],
      ['an empty name', { ...OK, name: '' }, 'name'],
      ['a blank name', { ...OK, name: '   ' }, 'name'],
      ['a name that is too long', { ...OK, name: 'x'.repeat(NAME_MAX_LENGTH + 1) }, 'name'],
      ['a missing target', { name: 'x' }, 'targetAmount'],
      ['a zero target', { ...OK, targetAmount: 0 }, 'targetAmount'],
      ['a negative target', { ...OK, targetAmount: -1 }, 'targetAmount'],
      ['a fractional target', { ...OK, targetAmount: 10.5 }, 'targetAmount'],
      ['a text target', { ...OK, targetAmount: '1000' }, 'targetAmount'],
      ['a target above the cap', { ...OK, targetAmount: MAX_CENTS + 1 }, 'targetAmount'],
      ['a deadline that is not a date', { ...OK, deadline: '2026-02-30' }, 'deadline'],
      ['a month as the deadline', { ...OK, deadline: '2026-08' }, 'deadline'],
      ['a color that is not a hex color', { ...OK, color: 'red' }, 'color'],
      ['a short hex color', { ...OK, color: '#fff' }, 'color'],
      ['archived (a new goal is never archived)', { ...OK, archived: true }, ''],
      ['an unknown key', { ...OK, balance: 5 }, ''],
    ])('rejects %s and stores nothing', async (_label, body, path) => {
      expectValidationError(await request(app).post('/api/goals').send(body), path);
      expect(db.select().from(savingsGoals).all()).toEqual([]);
    });

    it('rejects a body that is not JSON', async () => {
      const res = await request(app)
        .post('/api/goals')
        .set('Content-Type', 'application/json')
        .send('{"name":');
      expectApiError(res, 'invalid_json');
    });

    it('rejects a request with no body at all', async () => {
      expectValidationError(await request(app).post('/api/goals'), '');
    });
  });
});

describe('PATCH /api/goals/:id', () => {
  it('changes any subset of the fields and answers 200 with the DTO', async () => {
    const goal = await addGoal(app, { name: 'Holiday', targetAmount: 100000 });
    await addTransaction(app, { kind: 'deposit', amount: 30000, goalId: goal.id });

    const renamed = await request(app).patch(`/api/goals/${goal.id}`).send({ name: ' Trip ' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Trip', targetAmount: 100000, balance: 30000 });

    // A new target changes every derived figure: 30000 of 60000 is 50%.
    const retargeted = await request(app)
      .patch(`/api/goals/${goal.id}`)
      .send({ targetAmount: 60000 })
      .expect(200);
    expect(retargeted.body).toMatchObject({
      targetAmount: 60000,
      progressPercent: 50,
      remaining: 30000,
      reached: false,
    });

    // 30000 of 30000 is reached.
    const reached = await request(app)
      .patch(`/api/goals/${goal.id}`)
      .send({ targetAmount: 30000 })
      .expect(200);
    expect(reached.body).toMatchObject({
      progressPercent: 100,
      remaining: 0,
      reached: true,
      status: 'reached',
      monthlyNeeded: null,
    });

    const colored = await request(app)
      .patch(`/api/goals/${goal.id}`)
      .send({ color: '#ABCDEF', deadline: '2026-05-31' })
      .expect(200);
    expect(colored.body).toMatchObject({ color: '#abcdef', deadline: '2026-05-31' });
    expect(await list()).toEqual([colored.body]);
  });

  it('clears the deadline and the color with null', async () => {
    const goal = await addGoal(app, { deadline: '2026-08-20', color: '#3b82f6' });
    expect(goal.monthlyNeeded).toBe(16667);
    const res = await request(app)
      .patch(`/api/goals/${goal.id}`)
      .send({ deadline: null, color: null })
      .expect(200);
    expect(res.body).toMatchObject({ deadline: null, color: null, monthlyNeeded: null });
  });

  it('archives a goal and brings it back, keeping its balance in both states', async () => {
    const goal = await addGoal(app, { deadline: '2026-08-20' });
    await addTransaction(app, { kind: 'deposit', amount: 40000, goalId: goal.id });

    const archived = await request(app)
      .patch(`/api/goals/${goal.id}`)
      .send({ archived: true })
      .expect(200);
    expect(archived.body).toMatchObject({
      archived: true,
      status: 'archived',
      balance: 40000,
      monthlyNeeded: null,
    });
    // The money still counts in the savings balance, and not in the unassigned savings.
    expect(await getSavings(app)).toMatchObject({ balance: 40000, unassigned: 0 });

    const back = await request(app)
      .patch(`/api/goals/${goal.id}`)
      .send({ archived: false })
      .expect(200);
    // 60000 is still missing, and March to August is 6 months: ceilDiv(60000, 6) is 10000.
    expect(back.body).toMatchObject({
      archived: false,
      status: 'active',
      balance: 40000,
      monthlyNeeded: 10000,
    });
  });

  it('archives with the time of the clock and keeps it when archiving again', async () => {
    const goal = await addGoal(app);
    await request(app).patch(`/api/goals/${goal.id}`).send({ archived: true }).expect(200);
    expect(db.select().from(savingsGoals).get()?.archivedAt).toBe('2026-03-15T10:00:00.000Z');
    await request(app).patch(`/api/goals/${goal.id}`).send({ archived: true }).expect(200);
    expect(db.select().from(savingsGoals).get()?.archivedAt).toBe('2026-03-15T10:00:00.000Z');
    await request(app).patch(`/api/goals/${goal.id}`).send({ archived: false }).expect(200);
    expect(db.select().from(savingsGoals).get()?.archivedAt).toBeNull();
  });

  it('a change that sends only unknown-to-it fields (a name equal to the old one) is still a 200', async () => {
    const goal = await addGoal(app, { name: 'Same' });
    const res = await request(app)
      .patch(`/api/goals/${goal.id}`)
      .send({ name: 'Same' })
      .expect(200);
    expect(res.body).toEqual(goal);
  });

  it('answers 404 for an unknown id', async () => {
    expectNotFound(await request(app).patch('/api/goals/999').send({ name: 'x' }));
  });

  describe('validation (400)', () => {
    it.each([
      ['an empty body', {}, ''],
      ['an unknown key', { balance: 1 }, ''],
      ['an empty name', { name: '' }, 'name'],
      ['a zero target', { targetAmount: 0 }, 'targetAmount'],
      ['a fractional target', { targetAmount: 1.5 }, 'targetAmount'],
      ['a null name', { name: null }, 'name'],
      ['a null target', { targetAmount: null }, 'targetAmount'],
      ['a bad deadline', { deadline: '2026-13-01' }, 'deadline'],
      ['a bad color', { color: 'blue' }, 'color'],
      ['a null archived', { archived: null }, 'archived'],
      ['a text archived', { archived: 'yes' }, 'archived'],
    ])('rejects %s and changes nothing', async (_label, body, path) => {
      const goal = await addGoal(app);
      expectValidationError(await request(app).patch(`/api/goals/${goal.id}`).send(body), path);
      expect(await list()).toEqual([goal]);
    });

    it.each(['abc', '0', '-1', '1.5'])('rejects the id %s', async (id) => {
      expectValidationError(await request(app).patch(`/api/goals/${id}`).send({ name: 'x' }), 'id');
    });

    it('validates before it looks the goal up: a bad body for an unknown id is a 400', async () => {
      expectValidationError(await request(app).patch('/api/goals/999').send({}), '');
    });
  });
});

describe('DELETE /api/goals/:id', () => {
  it('deletes the goal and answers 204 with no body', async () => {
    const goal = await addGoal(app);
    const res = await request(app).delete(`/api/goals/${goal.id}`).expect(204);
    expect(res.text).toBe('');
    expect(await list()).toEqual([]);
    expect(db.select().from(savingsGoals).all()).toEqual([]);
  });

  it("moves the goal's money to unassigned savings and loses none of it", async () => {
    const goal = await addGoal(app);
    await addTransaction(app, { kind: 'deposit', amount: 25000, goalId: goal.id });
    await addTransaction(app, { kind: 'deposit', amount: 700 });
    expect(await getSavings(app)).toMatchObject({ balance: 25700, unassigned: 700 });

    await request(app).delete(`/api/goals/${goal.id}`).expect(204);
    expect(await getSavings(app)).toMatchObject({ balance: 25700, unassigned: 25700, goals: [] });
    // The rows are still there, now with no goal.
    expect(
      db
        .select()
        .from(savingsTransactions)
        .where(eq(savingsTransactions.kind, 'deposit'))
        .all()
        .map((row) => [row.amount, row.goalId]),
    ).toEqual([
      [25000, null],
      [700, null],
    ]);
  });

  it('answers 404 for an unknown id, and for a goal that was deleted already', async () => {
    expectNotFound(await request(app).delete('/api/goals/999'));
    const goal = await addGoal(app);
    await request(app).delete(`/api/goals/${goal.id}`).expect(204);
    expectNotFound(await request(app).delete(`/api/goals/${goal.id}`));
  });

  it.each(['abc', '0', '-3'])('rejects the id %s with a 400', async (id) => {
    expectValidationError(await request(app).delete(`/api/goals/${id}`), 'id');
  });

  it('does not touch the other goals', async () => {
    const a = await addGoal(app, { name: 'A' });
    const b = await addGoal(app, { name: 'B' });
    await addTransaction(app, { kind: 'deposit', amount: 100, goalId: a.id });
    await addTransaction(app, { kind: 'deposit', amount: 200, goalId: b.id });
    await request(app).delete(`/api/goals/${a.id}`).expect(204);
    const savings = await getSavings(app);
    expect(savings.goals.map((goal) => [goal.name, goal.balance])).toEqual([['B', 200]]);
    expect(savings.unassigned).toBe(100);
  });
});
