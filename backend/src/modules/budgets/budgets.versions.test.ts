/**
 * Budget versions and the start/end month rules (docs/DOMAIN.md, "Versioned values" and
 * "Editing rules"): versions are never deleted (archiving, or moving the start month, only changes
 * which months are active), only the first version is re-dated when the start month moves earlier
 * than it, a version is in effect at the start month, and the start/end month cannot cross the
 * budget's spendings and transfers.
 */
import type { BudgetDto, BudgetVersionDto, MonthView } from '@wallet/shared';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/client';
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
} from '../../testing/helpers';
import { fixedClock } from '../../lib/clock';
import { createTestApp } from '../../testing/test-app';

let app: ReturnType<typeof createTestApp>['app'];
let db: Db;
let clock: MutableClock;

beforeEach(async () => {
  clock = mutableClock('2026-03-15T10:00:00Z');
  ({ app, db } = createTestApp(clock));
  await onboard(app, { startMonth: '2026-01' });
});

const version = (
  effectiveMonth: string,
  amount: number,
  incremental = false,
): BudgetVersionDto => ({
  effectiveMonth,
  amount,
  incremental,
});

const putVersion = (id: number, month: string, amount: number, incremental = false) =>
  request(app).put(`/api/budgets/${id}/versions/${month}`).send({ amount, incremental });

/** A budget starting in January with versions 100 (Jan), 200 (Mar) and 300 (Jun). */
async function threeVersions(): Promise<BudgetDto> {
  const budget = await addBudget(app, { amount: 100, startMonth: '2026-01' });
  await putVersion(budget.id, '2026-03', 200).expect(200);
  await putVersion(budget.id, '2026-06', 300).expect(200);
  return budget;
}

describe('PUT /api/budgets/:id/versions/:month', () => {
  it('adds a version and answers 200 with the whole budget, versions ascending', async () => {
    const budget = await addBudget(app, {
      amount: 40000,
      incremental: false,
      startMonth: '2026-01',
    });
    await putVersion(budget.id, '2026-09', 70000, true).expect(200);
    const res = await putVersion(budget.id, '2026-05', 50000, true).expect(200);
    expect(res.body.versions).toEqual([
      version('2026-01', 40000, false),
      version('2026-05', 50000, true),
      version('2026-09', 70000, true),
    ]);
    expect(res.body.id).toBe(budget.id);
  });

  it('replaces the version of exactly that month instead of adding another', async () => {
    const budget = await addBudget(app, { amount: 100, incremental: false, startMonth: '2026-01' });
    await putVersion(budget.id, '2026-04', 200, false).expect(200);
    const res = await putVersion(budget.id, '2026-04', 250, true).expect(200);
    expect(res.body.versions).toEqual([
      version('2026-01', 100, false),
      version('2026-04', 250, true),
    ]);
  });

  it('replaces the first version when given the start month', async () => {
    const budget = await addBudget(app, { amount: 100, startMonth: '2026-02' });
    const res = await putVersion(budget.id, '2026-02', 111, true).expect(200);
    expect(res.body.versions).toEqual([version('2026-02', 111, true)]);
  });

  it('accepts a zero amount', async () => {
    const budget = await addBudget(app, { startMonth: '2026-01' });
    const res = await putVersion(budget.id, '2026-04', 0).expect(200);
    expect(res.body.versions[1]).toEqual(version('2026-04', 0));
  });

  it('allows a backdated version when asked for explicitly (a past month within the range)', async () => {
    const budget = await addBudget(app, { amount: 100, startMonth: '2026-01' });
    const res = await putVersion(budget.id, '2026-02', 150).expect(200);
    expect(res.body.versions).toEqual([version('2026-01', 100), version('2026-02', 150)]);
    expect(res.body.current).toEqual(version('2026-02', 150));
  });

  it('does not touch the budget itself or other budgets', async () => {
    const budget = await addBudget(app, { name: 'A', amount: 100, startMonth: '2026-01' });
    const other = await addBudget(app, { name: 'B', amount: 900, startMonth: '2026-01' });
    await putVersion(budget.id, '2026-04', 200).expect(200);
    const list = (await request(app).get('/api/budgets')).body as BudgetDto[];
    expect(list.find((b) => b.id === other.id)?.versions).toEqual(other.versions);
  });

  describe('outside_active_months (422)', () => {
    it('refuses a month before the budget starts', async () => {
      const budget = await addBudget(app, { startMonth: '2026-03' });
      expectRuleViolation(
        await putVersion(budget.id, '2026-02', 5),
        'outside_active_months',
        'month',
      );
    });

    it('reports a month before settings.startMonth the same way (the budget cannot reach back there)', async () => {
      const budget = await addBudget(app, { startMonth: '2026-01' });
      expectRuleViolation(
        await putVersion(budget.id, '2025-12', 5),
        'outside_active_months',
        'month',
      );
    });

    it('refuses a month after the end month, and accepts the end month itself', async () => {
      const budget = await addBudget(app, { startMonth: '2026-01' });
      await request(app)
        .post(`/api/budgets/${budget.id}/archive`)
        .send({ endMonth: '2026-05' })
        .expect(200);
      expectRuleViolation(
        await putVersion(budget.id, '2026-06', 5),
        'outside_active_months',
        'month',
      );
      await putVersion(budget.id, '2026-05', 5).expect(200);
    });

    it('leaves the versions unchanged when refused', async () => {
      const budget = await addBudget(app, { startMonth: '2026-03' });
      await putVersion(budget.id, '2026-01', 5).expect(422);
      const [stored] = (await request(app).get('/api/budgets')).body as BudgetDto[];
      expect(stored?.versions).toEqual(budget.versions);
    });
  });

  it('is a 404 for an unknown budget', async () => {
    expectNotFound(await putVersion(99, '2026-04', 5));
  });

  describe('validation (400)', () => {
    it.each([
      ['a bad month', '2026-13', { amount: 5, incremental: true }, 'month'],
      ['a full date as month', '2026-04-01', { amount: 5, incremental: true }, 'month'],
      ['an empty body', '2026-04', {}, 'amount'],
      ['a missing incremental', '2026-04', { amount: 5 }, 'incremental'],
      ['a missing amount', '2026-04', { incremental: true }, 'amount'],
      ['a negative amount', '2026-04', { amount: -1, incremental: true }, 'amount'],
      ['a fractional amount', '2026-04', { amount: 1.5, incremental: true }, 'amount'],
      ['a text incremental', '2026-04', { amount: 5, incremental: 'true' }, 'incremental'],
      ['an unknown key', '2026-04', { amount: 5, incremental: true, name: 'x' }, ''],
    ])('rejects %s', async (_label, month, body, path) => {
      const budget = await addBudget(app, { startMonth: '2026-01' });
      expectValidationError(
        await request(app).put(`/api/budgets/${budget.id}/versions/${month}`).send(body),
        path,
      );
    });

    it('rejects a bad id', async () => {
      expectValidationError(await putVersion(0, '2026-04', 5), 'id');
    });
  });
});

describe('PATCH /api/budgets/:id: moving startMonth', () => {
  const move = (id: number, startMonth: string) =>
    request(app).patch(`/api/budgets/${id}`).send({ startMonth });

  it.each([
    // [label, new start month]: no version is deleted or re-dated when the start moves later
    ['to the same month: nothing changes', '2026-01'],
    ['later but before the second version', '2026-02'],
    ['later, exactly to the second version', '2026-03'],
    ['later, between versions', '2026-04'],
    ['later, exactly to the last version', '2026-06'],
    ['later than every version', '2026-09'],
  ])('%s: every version stays where it is', async (_label, newStart) => {
    const budget = await threeVersions();
    const res = await move(budget.id, newStart).expect(200);
    expect(res.body.startMonth).toBe(newStart);
    expect(res.body.versions).toEqual([
      version('2026-01', 100),
      version('2026-03', 200),
      version('2026-06', 300),
    ]);
  });

  it('earlier than the first version: only that one is re-dated, even after the start had moved later', async () => {
    // The first version is dated January; the start was moved to February (nothing re-dated). The
    // tracking then starts earlier (settings), and the budget's start goes back before January.
    const budget = await addBudget(app, { amount: 100, incremental: true, startMonth: '2026-01' });
    await putVersion(budget.id, '2026-03', 200, false).expect(200);
    await move(budget.id, '2026-02').expect(200);
    await request(app)
      .put('/api/settings')
      .send({
        currency: 'EUR',
        locale: 'en-US',
        startMonth: '2025-10',
        theme: 'system',
        alertWarnPercent: 80,
      })
      .expect(200);

    const res = await move(budget.id, '2025-11').expect(200);
    expect(res.body.startMonth).toBe('2025-11');
    expect(res.body.versions).toEqual([
      version('2025-11', 100, true),
      version('2026-03', 200, false),
    ]);
    // A move that stays at or after the first version changes nothing.
    const again = await move(budget.id, '2026-02').expect(200);
    expect(again.body.versions).toEqual([
      version('2025-11', 100, true),
      version('2026-03', 200, false),
    ]);
  });

  it('later: the version in effect at the new start month, even an older one, is the one used from then on', async () => {
    const budget = await threeVersions(); // 100 from January, 200 from March, 300 from June
    await move(budget.id, '2026-04').expect(200);
    const months = await Promise.all(
      ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07'].map(
        async (m) =>
          ((await request(app).get(`/api/months/${m}`).expect(200)).body as MonthView).budgets,
      ),
    );
    // Not computed before April; April and May take the March version (200), June on the June one.
    expect(months.map((lines) => lines.map((l) => l.allocated))).toEqual([
      [],
      [200],
      [200],
      [300],
      [300],
    ]);
  });

  it('earlier: re-dates only the first version to the new month and keeps its values', async () => {
    const budget = await addBudget(app, { amount: 100, incremental: true, startMonth: '2026-03' });
    await putVersion(budget.id, '2026-06', 300, false).expect(200);
    const res = await move(budget.id, '2026-01').expect(200);
    expect(res.body.versions).toEqual([
      version('2026-01', 100, true),
      version('2026-06', 300, false),
    ]);
  });

  it('later: changes no version, and the budget is upcoming with no current one while April is ahead', async () => {
    const budget = await addBudget(app, { amount: 100, incremental: false, startMonth: '2026-01' });
    await putVersion(budget.id, '2026-03', 250, true).expect(200);
    const res = await move(budget.id, '2026-04').expect(200);
    expect(res.body.versions).toEqual([
      version('2026-01', 100, false),
      version('2026-03', 250, true),
    ]);
    // April is still ahead of the clock (15 March), so nothing is current yet, though the older
    // version is the one that will be in effect in April.
    expect(res.body).toMatchObject({ status: 'upcoming', current: null });
  });

  it('later and back again: no version changes and every month keeps its figures', async () => {
    const budget = await threeVersions();
    const monthsOf = async () =>
      Promise.all(
        ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'].map(
          async (m) =>
            (
              (await request(app).get(`/api/months/${m}`).expect(200)).body as MonthView
            ).budgets.map((l) => [l.allocated, l.incremental]),
        ),
      );
    const before = await monthsOf();
    await move(budget.id, '2026-06').expect(200);
    const res = await move(budget.id, '2026-01').expect(200);
    expect(res.body.versions).toEqual([
      version('2026-01', 100),
      version('2026-03', 200),
      version('2026-06', 300),
    ]);
    expect(await monthsOf()).toEqual(before);
  });

  it('keeps the current version consistent with the clock after the move', async () => {
    const budget = await threeVersions();
    clock.set('2026-07-01T00:00:00Z');
    const res = await move(budget.id, '2026-04').expect(200);
    expect(res.body.current).toEqual(version('2026-06', 300));
    expect(res.body.status).toBe('active');
  });

  it('turns an active budget into an upcoming one when moved past the current month', async () => {
    const budget = await addBudget(app, { startMonth: '2026-01' });
    const res = await move(budget.id, '2026-05').expect(200);
    expect(res.body).toMatchObject({ status: 'upcoming', current: null, startMonth: '2026-05' });
  });

  it('can change startMonth together with other fields', async () => {
    const budget = await addBudget(app, { startMonth: '2026-01' });
    const res = await request(app)
      .patch(`/api/budgets/${budget.id}`)
      .send({ name: 'Renamed', startMonth: '2026-02' })
      .expect(200);
    expect(res.body).toMatchObject({ name: 'Renamed', startMonth: '2026-02' });
    // Moving the start later leaves the first version where it was, in effect at the new start.
    expect(res.body.versions).toEqual([version('2026-01', 40000)]);
  });

  describe('before_start_month (422)', () => {
    it('refuses a start month before settings.startMonth and changes nothing', async () => {
      const budget = await addBudget(app, { startMonth: '2026-02' });
      expectRuleViolation(await move(budget.id, '2025-12'), 'before_start_month', 'startMonth');
      expect(((await request(app).get('/api/budgets')).body as BudgetDto[])[0]).toEqual(budget);
    });

    it('accepts settings.startMonth itself (the boundary)', async () => {
      const budget = await addBudget(app, { startMonth: '2026-02' });
      await move(budget.id, '2026-01').expect(200);
    });
  });

  describe('end_before_start (422)', () => {
    it('refuses a start month after the end month, and accepts the end month itself', async () => {
      const budget = await addBudget(app, { startMonth: '2026-01' });
      await request(app)
        .post(`/api/budgets/${budget.id}/archive`)
        .send({ endMonth: '2026-04' })
        .expect(200);
      expectRuleViolation(await move(budget.id, '2026-05'), 'end_before_start', 'startMonth');
      const res = await move(budget.id, '2026-04').expect(200);
      expect(res.body).toMatchObject({ startMonth: '2026-04', endMonth: '2026-04' });
      expect(res.body.versions).toEqual([version('2026-01', 40000)]);
    });
  });

  describe('start_after_activity (422)', () => {
    it("refuses a start month after the earliest spending, and accepts that spending's month", async () => {
      const budget = await addBudget(app, { startMonth: '2026-01' });
      await addSpending(app, { budgetId: budget.id, date: '2026-02-28' });
      await addSpending(app, { budgetId: budget.id, date: '2026-03-10' });
      expectRuleViolation(await move(budget.id, '2026-03'), 'start_after_activity', 'startMonth');
      // The earliest spending is on the last day of February: February is still fine.
      await move(budget.id, '2026-02').expect(200);
    });

    it('also counts transfers into and out of the budget', async () => {
      const budget = await addBudget(app, { startMonth: '2026-01' });
      const other = await addBudget(app, { name: 'Other', startMonth: '2026-01' });
      insertTransfer(db, { date: '2026-02-01', fromBudgetId: budget.id, toBudgetId: other.id });
      expectRuleViolation(await move(budget.id, '2026-03'), 'start_after_activity', 'startMonth');
      expectRuleViolation(await move(other.id, '2026-03'), 'start_after_activity', 'startMonth');
      await move(budget.id, '2026-02').expect(200);
    });

    it('uses the earliest of its spendings AND its transfers, whichever comes first', async () => {
      const budget = await addBudget(app, { startMonth: '2026-01' });
      const other = await addBudget(app, { name: 'Other', startMonth: '2026-01' });
      // A spending in March and a transfer in February: February is the earliest activity.
      await addSpending(app, { budgetId: budget.id, date: '2026-03-10' });
      insertTransfer(db, { date: '2026-02-05', toBudgetId: budget.id });
      expectRuleViolation(await move(budget.id, '2026-03'), 'start_after_activity', 'startMonth');
      await move(budget.id, '2026-02').expect(200);

      // And the other way round: a spending in February and a transfer in March.
      await addSpending(app, { budgetId: other.id, date: '2026-02-20' });
      insertTransfer(db, { date: '2026-03-02', fromBudgetId: other.id });
      expectRuleViolation(await move(other.id, '2026-03'), 'start_after_activity', 'startMonth');
      await move(other.id, '2026-02').expect(200);
    });

    it('is not affected by spendings of other budgets', async () => {
      const budget = await addBudget(app, { startMonth: '2026-01' });
      const other = await addBudget(app, { name: 'Other', startMonth: '2026-01' });
      await addSpending(app, { budgetId: other.id, date: '2026-01-10' });
      await move(budget.id, '2026-03').expect(200);
    });

    it('leaves the versions untouched when refused', async () => {
      const budget = await threeVersions();
      await addSpending(app, { budgetId: budget.id, date: '2026-02-10' });
      await move(budget.id, '2026-04').expect(422);
      const [stored] = (await request(app).get('/api/budgets')).body as BudgetDto[];
      expect(stored?.versions).toEqual([
        version('2026-01', 100),
        version('2026-03', 200),
        version('2026-06', 300),
      ]);
      expect(stored?.startMonth).toBe('2026-01');
    });
  });

  it('checks the rules in the documented order: before_start_month, end_before_start, start_after_activity', async () => {
    // Ends in March with a spending in March: moving the start to April breaks both
    // end_before_start and start_after_activity, and end_before_start is listed first.
    const budget = await addBudget(app, { startMonth: '2026-01' });
    await addSpending(app, { budgetId: budget.id, date: '2026-03-10' });
    await request(app)
      .post(`/api/budgets/${budget.id}/archive`)
      .send({ endMonth: '2026-03' })
      .expect(200);
    expectRuleViolation(await move(budget.id, '2026-04'), 'end_before_start', 'startMonth');
  });
});

describe('POST /api/budgets/:id/archive', () => {
  const archive = (id: number, body?: object) => {
    const req = request(app).post(`/api/budgets/${id}/archive`);
    return body === undefined ? req : req.send(body);
  };

  it('defaults to the current month, with no body at all', async () => {
    const budget = await addBudget(app, { startMonth: '2026-01' });
    const res = await archive(budget.id).expect(200);
    expect(res.body).toMatchObject({ id: budget.id, endMonth: '2026-03', status: 'active' });
  });

  it('also accepts an empty object', async () => {
    const budget = await addBudget(app, { startMonth: '2026-01' });
    const res = await archive(budget.id, {}).expect(200);
    expect(res.body.endMonth).toBe('2026-03');
  });

  it('takes an explicit end month, in the past or in the future', async () => {
    const past = await addBudget(app, { name: 'Past', startMonth: '2026-01' });
    const future = await addBudget(app, { name: 'Future', startMonth: '2026-01' });
    expect((await archive(past.id, { endMonth: '2026-02' }).expect(200)).body).toMatchObject({
      endMonth: '2026-02',
      status: 'ended',
    });
    expect((await archive(future.id, { endMonth: '2026-08' }).expect(200)).body).toMatchObject({
      endMonth: '2026-08',
      status: 'active',
    });
  });

  it('accepts the start month as end month (a one-month budget)', async () => {
    const budget = await addBudget(app, { startMonth: '2026-02' });
    const res = await archive(budget.id, { endMonth: '2026-02' }).expect(200);
    expect(res.body).toMatchObject({ startMonth: '2026-02', endMonth: '2026-02' });
  });

  it('deletes no version: those after the end month are inert, and apply again when the end month moves later', async () => {
    const budget = await addBudget(app, { amount: 100, startMonth: '2026-01' });
    for (const [month, amount] of [
      ['2026-03', 200],
      ['2026-06', 300],
      ['2026-09', 400],
    ] as const) {
      await putVersion(budget.id, month, amount).expect(200);
    }
    const all = [
      version('2026-01', 100),
      version('2026-03', 200),
      version('2026-06', 300),
      version('2026-09', 400),
    ];
    let res = await archive(budget.id, { endMonth: '2026-04' }).expect(200);
    expect(res.body.versions).toEqual(all);

    // Archiving again further out brings the planned changes back into effect.
    res = await archive(budget.id, { endMonth: '2026-12' }).expect(200);
    expect(res.body.endMonth).toBe('2026-12');
    expect(res.body.versions).toEqual(all);
    const august = (await request(app).get('/api/months/2026-08').expect(200)).body as MonthView;
    expect(august.budgets[0]).toMatchObject({ allocated: 300 });
    const september = (await request(app).get('/api/months/2026-09').expect(200)).body as MonthView;
    expect(september.budgets[0]).toMatchObject({ allocated: 400 });
  });

  it('re-archiving later restores the closed months it had', async () => {
    const { app } = createTestApp(fixedClock('2026-10-15T12:00:00Z'));
    await onboard(app, { startMonth: '2026-01' });
    const b = await addBudget(app, { startMonth: '2026-01', amount: 40000, incremental: true });
    await request(app)
      .put(`/api/budgets/${b.id}/versions/2026-06`)
      .send({ amount: 50000, incremental: false })
      .expect(200);
    await request(app)
      .post(`/api/budgets/${b.id}/archive`)
      .send({ endMonth: '2026-03' })
      .expect(200);
    const res = await request(app)
      .post(`/api/budgets/${b.id}/archive`)
      .send({ endMonth: '2026-10' })
      .expect(200);
    expect(res.body.versions).toEqual([
      { effectiveMonth: '2026-01', amount: 40000, incremental: true },
      { effectiveMonth: '2026-06', amount: 50000, incremental: false },
    ]);
  });

  it('re-archiving later brings the closed months back with their figures (GET /api/months)', async () => {
    const { app } = createTestApp(fixedClock('2026-10-15T12:00:00Z'));
    await onboard(app, { startMonth: '2026-01' });
    const b = await addBudget(app, { startMonth: '2026-01', amount: 40000, incremental: true });
    await request(app)
      .put(`/api/budgets/${b.id}/versions/2026-06`)
      .send({ amount: 50000, incremental: false })
      .expect(200);
    const linesOf = async (months: string[]) =>
      Promise.all(
        months.map(
          async (m) =>
            ((await request(app).get(`/api/months/${m}`).expect(200)).body as MonthView).budgets,
        ),
      );
    const summer = ['2026-06', '2026-07', '2026-08', '2026-09'];
    const original = await linesOf(summer);
    expect(original.map((lines) => lines.map((l) => [l.allocated, l.incremental]))).toEqual(
      Array(4).fill([[50000, false]]),
    );

    // Archived "too early": the summer months have no line for it at all...
    await request(app)
      .post(`/api/budgets/${b.id}/archive`)
      .send({ endMonth: '2026-03' })
      .expect(200);
    expect(await linesOf(summer)).toEqual([[], [], [], []]);

    // ...and archiving again with a later end month brings every one of them back, as they were
    // (50.00 a month from June, no longer incremental).
    await request(app)
      .post(`/api/budgets/${b.id}/archive`)
      .send({ endMonth: '2026-10' })
      .expect(200);
    expect(await linesOf(summer)).toEqual(original);
    expect(
      (await linesOf(summer)).map((lines) => lines.map((l) => [l.allocated, l.incremental])),
    ).toEqual(Array(4).fill([[50000, false]]));
  });

  it('shows the version in effect in the end month as current, never an inert later one', async () => {
    const budget = await threeVersions(); // 100 from January, 200 from March, 300 from June
    await archive(budget.id, { endMonth: '2026-04' }).expect(200);
    clock.set('2026-12-01T00:00:00Z'); // long after the end: June's version is inert
    const stored = ((await request(app).get('/api/budgets')).body as BudgetDto[])[0];
    expect(stored).toMatchObject({ status: 'ended', current: version('2026-03', 200) });
    expect(stored?.versions).toHaveLength(3);
  });

  it('keeps a version effective exactly in the end month', async () => {
    const budget = await threeVersions();
    const res = await archive(budget.id, { endMonth: '2026-06' }).expect(200);
    expect(res.body.versions).toEqual([
      version('2026-01', 100),
      version('2026-03', 200),
      version('2026-06', 300),
    ]);
  });

  it('moves the end month when archived again, earlier or later', async () => {
    const budget = await addBudget(app, { startMonth: '2026-01' });
    await archive(budget.id, { endMonth: '2026-06' }).expect(200);
    expect((await archive(budget.id, { endMonth: '2026-04' }).expect(200)).body.endMonth).toBe(
      '2026-04',
    );
    expect((await archive(budget.id, { endMonth: '2026-09' }).expect(200)).body.endMonth).toBe(
      '2026-09',
    );
  });

  it('turns ended at the first instant after the end month', async () => {
    const budget = await addBudget(app, { startMonth: '2026-01' });
    await archive(budget.id).expect(200); // end month: March
    clock.set('2026-04-01T00:00:00Z');
    expect(((await request(app).get('/api/budgets')).body as BudgetDto[])[0]?.status).toBe('ended');
  });

  it('is a 404 for an unknown budget', async () => {
    expectNotFound(await archive(99));
  });

  describe('end_before_start (422)', () => {
    it('refuses an end month before the start month and accepts the start month itself', async () => {
      const budget = await addBudget(app, { startMonth: '2026-02' });
      expectRuleViolation(
        await archive(budget.id, { endMonth: '2026-01' }),
        'end_before_start',
        'endMonth',
      );
      await archive(budget.id, { endMonth: '2026-02' }).expect(200);
    });

    it('applies to the default end month too: an upcoming budget cannot be archived "now"', async () => {
      const budget = await addBudget(app, { startMonth: '2026-05' });
      expectRuleViolation(await archive(budget.id), 'end_before_start', 'endMonth');
      const [stored] = (await request(app).get('/api/budgets')).body as BudgetDto[];
      expect(stored?.endMonth).toBeNull();
    });
  });

  describe('end_before_activity (422)', () => {
    it("refuses an end month before the latest spending and accepts that spending's month", async () => {
      const budget = await addBudget(app, { startMonth: '2026-01' });
      await addSpending(app, { budgetId: budget.id, date: '2026-02-03' });
      await addSpending(app, { budgetId: budget.id, date: '2026-03-01' });
      expectRuleViolation(
        await archive(budget.id, { endMonth: '2026-02' }),
        'end_before_activity',
        'endMonth',
      );
      await archive(budget.id, { endMonth: '2026-03' }).expect(200);
    });

    it('uses the latest of its spendings AND its transfers, whichever comes last', async () => {
      const budget = await addBudget(app, { startMonth: '2026-01' });
      const other = await addBudget(app, { name: 'Other', startMonth: '2026-01' });
      // A spending in February and a transfer in April: April is the latest activity.
      await addSpending(app, { budgetId: budget.id, date: '2026-02-10' });
      insertTransfer(db, { date: '2026-04-05', fromBudgetId: budget.id });
      expectRuleViolation(
        await archive(budget.id, { endMonth: '2026-03' }),
        'end_before_activity',
        'endMonth',
      );
      await archive(budget.id, { endMonth: '2026-04' }).expect(200);

      // And the other way round: a transfer in February and a spending in April.
      insertTransfer(db, { date: '2026-02-20', toBudgetId: other.id });
      await addSpending(app, { budgetId: other.id, date: '2026-04-20' });
      expectRuleViolation(
        await archive(other.id, { endMonth: '2026-03' }),
        'end_before_activity',
        'endMonth',
      );
      await archive(other.id, { endMonth: '2026-04' }).expect(200);
    });

    it('also counts transfers, and leaves the budget unchanged when refused', async () => {
      const budget = await addBudget(app, { startMonth: '2026-01' });
      insertTransfer(db, { date: '2026-03-31', toBudgetId: budget.id });
      expectRuleViolation(
        await archive(budget.id, { endMonth: '2026-02' }),
        'end_before_activity',
        'endMonth',
      );
      const [stored] = (await request(app).get('/api/budgets')).body as BudgetDto[];
      expect(stored?.endMonth).toBeNull();
    });

    it('is checked after end_before_start', async () => {
      const budget = await addBudget(app, { startMonth: '2026-02' });
      await addSpending(app, { budgetId: budget.id, date: '2026-03-10' });
      // January is before the start (February) and before the spending (March): the start wins.
      expectRuleViolation(
        await archive(budget.id, { endMonth: '2026-01' }),
        'end_before_start',
        'endMonth',
      );
    });
  });

  describe('validation (400)', () => {
    it.each([
      ['a bad end month', { endMonth: '2026-13' }, 'endMonth'],
      ['a date as end month', { endMonth: '2026-06-30' }, 'endMonth'],
      ['a null end month', { endMonth: null }, 'endMonth'],
      ['an unknown key', { month: '2026-06' }, ''],
    ])('rejects %s', async (_label, body, path) => {
      const budget = await addBudget(app, { startMonth: '2026-01' });
      expectValidationError(await archive(budget.id, body), path);
    });

    it('rejects a bad id', async () => {
      expectValidationError(await archive(0, {}), 'id');
    });
  });
});

describe('a budget through its whole life', () => {
  it('start, mode switch, raise, backdated start, archive, and the status as the months pass', async () => {
    clock.set('2026-01-10T10:00:00Z');
    const budget = await addBudget(app, {
      name: 'Holidays',
      amount: 15000,
      incremental: true,
      startMonth: '2026-01',
    });
    expect(budget).toMatchObject({ status: 'active', current: version('2026-01', 15000, true) });

    // From April on: a bigger amount, no longer incremental.
    await putVersion(budget.id, '2026-04', 20000, false).expect(200);
    // Realised it really began in February.
    const moved = (
      await request(app).patch(`/api/budgets/${budget.id}`).send({ startMonth: '2026-02' })
    ).body;
    // Moving the start later deletes nothing: the January version is simply in effect in February.
    expect(moved.startMonth).toBe('2026-02');
    expect(moved.versions).toEqual([
      version('2026-01', 15000, true),
      version('2026-04', 20000, false),
    ]);

    clock.set('2026-04-02T10:00:00Z');
    expect(((await request(app).get('/api/budgets')).body as BudgetDto[])[0]?.current).toEqual(
      version('2026-04', 20000, false),
    );

    // Archive in June: the version planned for September stays stored but is inert.
    await putVersion(budget.id, '2026-09', 99999).expect(200);
    const archived = (
      await request(app).post(`/api/budgets/${budget.id}/archive`).send({ endMonth: '2026-06' })
    ).body;
    expect(archived.versions).toEqual([
      version('2026-01', 15000, true),
      version('2026-04', 20000, false),
      version('2026-09', 99999, false),
    ]);
    expect(archived.status).toBe('active');

    clock.set('2026-06-30T23:59:59Z');
    expect(((await request(app).get('/api/budgets')).body as BudgetDto[])[0]?.status).toBe(
      'active',
    );
    clock.set('2026-07-01T00:00:00Z');
    expect(((await request(app).get('/api/budgets')).body as BudgetDto[])[0]).toMatchObject({
      status: 'ended',
      current: version('2026-04', 20000, false),
    });
  });
});
