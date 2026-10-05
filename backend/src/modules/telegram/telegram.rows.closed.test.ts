/**
 * The closed-month questions (docs/DOMAIN.md, "The `/spending` flow", step 5, and "The confirmation"):
 *
 * - worded by the budget's MODE in the closed month, read from the month view's line: savings due
 *   where it settles with savings, "what Fuel carries forward" where an incremental budget carries
 *   its remainder on (an entry in September changes October's Fuel, not September's savings due);
 * - for such a budget the confirmation also prints the CURRENT month's line, where the effect lands;
 * - a Change date inside one month asks nothing, because no figure of any month changes;
 * - a CONFIRMED tap works the closed months out again at the moment of the tap, and asks again about
 *   a month the question did not name (the clock moved on, or the row was moved on the web).
 */
import type { MonthBudgetLine, MonthView, SpendingsPage } from '@wallet/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { addSpending } from '../../testing/helpers';
import { type RecordingHarness, createRecordingHarness } from '../../testing/telegram-flow-helpers';

const spendingsOf = async (h: RecordingHarness) =>
  ((await request(h.app).get('/api/spendings').expect(200)).body as SpendingsPage).items;
const line = (view: MonthView, name: string): MonthBudgetLine => {
  const found = view.budgets.find((budget) => budget.name === name);
  if (!found) throw new Error(`no ${name} in ${view.month}`);
  return found;
};
const buttons = (h: RecordingHarness) =>
  h
    .screen()
    .rows.flat()
    .map((b) => b.text);

/** On 2 October: 25.00 of diesel for Fuel (incremental), dated Wednesday 30 September. Up to the question. */
async function askFuelInSeptember(h: RecordingHarness, note = 'diesel') {
  await h.say('/spending');
  await h.tapButton(/Fuel/);
  await h.say(`25 ${note}`);
  await h.tapButton('Earlier…');
  await h.tapButton('Wed 30');
}

describe('an entry in a closed month of a budget that carries on', () => {
  it('asks about what the budget carries forward, not about savings due, which stay as they are', async () => {
    const h = await createRecordingHarness({ now: '2026-10-02T10:00:00Z' });
    const septemberBefore = await h.monthView('2026-09');
    const octoberBefore = await h.monthView('2026-10');
    await askFuelInSeptember(h);
    expect(h.screen().text).toBe(
      '€25.00 · Fuel · diesel · Wed 30 Sept\n' +
        'September is closed. Adding this changes what Fuel carries forward from September.',
    );
    await h.tapButton('Save');

    // The claim of the question, checked against the books: savings due do not move, October does.
    const septemberAfter = await h.monthView('2026-09');
    const octoberAfter = await h.monthView('2026-10');
    expect(septemberAfter.savingsDue.total).toBe(septemberBefore.savingsDue.total);
    expect(line(octoberBefore, 'Fuel').remaining - line(octoberAfter, 'Fuel').remaining).toBe(2500);

    expect(h.screen().text).toBe(
      '✅ €25.00 · Fuel · diesel · Wed 30 Sept\n' +
        'Fuel in September (closed): €875.00 left of €900.00 (2% used)\n' +
        'Fuel in October (this month): €975.00 left of €975.00 (0% used)',
    );
    // Both lines are fields of the month view of their month.
    expect(line(septemberAfter, 'Fuel')).toMatchObject({
      remaining: 87500,
      available: 90000,
      usagePercent: 2,
    });
    expect(line(octoberAfter, 'Fuel')).toMatchObject({
      remaining: 97500,
      available: 97500,
      usagePercent: 0,
    });
  });

  it('tells the alert watcher what BOTH lines showed', async () => {
    const h = await createRecordingHarness({ now: '2026-10-02T10:00:00Z' });
    await askFuelInSeptember(h);
    await h.tapButton('Save');
    const fuel = h.budget('Fuel').id;
    expect(h.notify.markNotified.mock.calls.map(([record]) => record)).toEqual([
      { month: '2026-09', budgetId: fuel, level: 'ok' },
      { month: '2026-10', budgetId: fuel, level: 'ok' },
    ]);
  });

  it('marks the current month’s line with its own alert', async () => {
    const h = await createRecordingHarness({ now: '2026-10-02T10:00:00Z' });
    // Fuel has 1,000.00 in October: 800.00 of it spent already puts it at a warning once 25.00 more is taken from it.
    await addSpending(h.app, { budgetId: h.budget('Fuel').id, amount: 80000, date: '2026-10-01' });
    await askFuelInSeptember(h);
    await h.tapButton('Save');
    expect(h.screen().text).toBe(
      '✅ €25.00 · Fuel · diesel · Wed 30 Sept\n' +
        'Fuel in September (closed): €875.00 left of €900.00 (2% used)\n' +
        '⚠️ Fuel in October (this month): €175.00 left of €975.00 (82% used, warning at 80%)',
    );
    expect(h.notify.markNotified).toHaveBeenLastCalledWith({
      month: '2026-10',
      budgetId: h.budget('Fuel').id,
      level: 'warning',
    });
  });

  it('words Undo, /recent and /undo the same way, and shows both lines after the removal', async () => {
    const h = await createRecordingHarness({ now: '2026-10-02T10:00:00Z' });
    await askFuelInSeptember(h);
    await h.tapButton('Save');

    await h.tapButton('↩ Undo');
    expect(h.screen().text).toBe(
      '€25.00 · Fuel · diesel · Wed 30 Sept\n' +
        'September is closed. Removing this changes what Fuel carries forward from September.',
    );
    await h.say('/recent');
    await h.tapButton('🗑 1');
    expect(h.screen().text).toBe(
      'Delete €25.00 · Fuel · diesel (Wed 30 Sept)?\n' +
        'September is closed. Removing this changes what Fuel carries forward from September.',
    );
    await h.say('/undo');
    expect(h.screen().text).toBe(
      'Remove €25.00 · Fuel · diesel (Wed 30 Sept)?\n' +
        'September is closed. Removing this changes what Fuel carries forward from September.',
    );
    await h.tapButton('Remove');
    expect(h.screen().text).toBe(
      '🗑 Removed €25.00 · Fuel · diesel · Wed 30 Sept\n' +
        'Fuel in September (closed): €900.00 left of €900.00 (0% used)\n' +
        'Fuel in October (this month): €1,000.00 left of €1,000.00 (0% used)',
    );
    expect(await spendingsOf(h)).toEqual([]);
  });

  it('escapes the budget’s name in the question', async () => {
    const h = await createRecordingHarness({
      now: '2026-10-02T10:00:00Z',
      budgets: [{ name: '<b>Fuel</b>', amount: 10000, incremental: true, startMonth: '2026-01' }],
    });
    await h.say('/spending');
    await h.tapButton(/Fuel/);
    await h.say('25 diesel');
    await h.tapButton('Earlier…');
    await h.tapButton('Wed 30');
    expect(h.screen().text).toContain(
      'changes what &lt;b&gt;Fuel&lt;/b&gt; carries forward from September.',
    );
  });
});

describe('an entry in a closed month of a budget that settles with savings', () => {
  it('keeps the savings wording and prints no line for the current month', async () => {
    const h = await createRecordingHarness({ now: '2026-10-02T10:00:00Z' });
    const before = await h.monthView('2026-09');
    await h.say('/spending');
    await h.tapButton(/Groceries/);
    await h.say('25 shop');
    await h.tapButton('Earlier…');
    await h.tapButton('Wed 30');
    expect(h.screen().text).toBe(
      '€25.00 · Groceries · shop · Wed 30 Sept\n' +
        'September is closed. Adding this changes what is due to savings for September.',
    );
    await h.tapButton('Save');
    expect(h.screen().text.split('\n')).toEqual([
      '✅ €25.00 · Groceries · shop · Wed 30 Sept',
      'Groceries in September (closed): €275.00 left of €300.00 (8% used)',
    ]);
    expect((await h.monthView('2026-09')).savingsDue.total).toBe(before.savingsDue.total - 2500);
  });

  it('an income only ever moves savings due', async () => {
    const h = await createRecordingHarness({ now: '2026-10-02T10:00:00Z' });
    await h.say('/income');
    await h.say('100 Back pay');
    await h.tapButton('Earlier…');
    await h.tapButton('Wed 30');
    expect(h.screen().text).toContain(
      'September is closed. Adding this changes what is due to savings for September.',
    );
  });
});

describe('Change date', () => {
  it('asks nothing inside one month, closed or not, because no figure of any month changes', async () => {
    const h = await createRecordingHarness({ now: '2026-10-02T10:00:00Z' });
    await askFuelInSeptember(h);
    await h.tapButton('Save');
    const septemberBefore = await h.monthView('2026-09');
    await h.tapButton('📅 Change date');
    await h.tapButton('Tue 29'); // 29 September: the same closed month
    expect(h.screen().text).toBe(
      '✅ €25.00 · Fuel · diesel · Tue 29 Sept\n' +
        'Fuel in September (closed): €875.00 left of €900.00 (2% used)\n' +
        'Fuel in October (this month): €975.00 left of €975.00 (0% used)',
    );
    expect((await spendingsOf(h))[0]?.date).toBe('2026-09-29');
    expect(await h.monthView('2026-09')).toEqual(septemberBefore); // not a figure moved
  });

  it('asks for a move out of a closed month, worded by the budget, and the result is the new month’s figure', async () => {
    const h = await createRecordingHarness({ now: '2026-10-02T10:00:00Z' });
    await askFuelInSeptember(h);
    await h.tapButton('Save');
    await h.tapButton('📅 Change date');
    await h.tapButton('Yesterday'); // 1 October: the current month
    expect(h.screen().text).toBe(
      '€25.00 · Fuel · diesel · Wed 30 Sept\nNew date: Thu 1 Oct\n' +
        'September is closed. Moving this changes what Fuel carries forward from September.',
    );
    await h.tapButton('Save');
    expect(h.screen().text).toBe(
      '✅ €25.00 · Fuel · diesel · Thu 1 Oct\nFuel: €975.00 left of €1,000.00 (2% used)',
    );
  });

  it('names where each closed month settles: both settle with savings in September', async () => {
    const h = await createRecordingHarness({ now: '2026-10-02T10:00:00Z' });
    // Fuel carries on until August and settles with savings from September.
    await request(h.app)
      .put(`/api/budgets/${h.budget('Fuel').id}/versions/2026-09`)
      .send({ amount: 10000, incremental: false })
      .expect(200);
    const row = await addSpending(h.app, {
      budgetId: h.budget('Fuel').id,
      amount: 2500,
      date: '2026-08-15',
      description: 'diesel',
    });
    await h.tap(`c:s:${row.id}:${h.fp('s', row.id)}:2026-09-30`);
    expect(h.screen().text).toBe(
      '€25.00 · Fuel · diesel · Sat 15 Aug\nNew date: Wed 30 Sept\n' +
        'August and September are closed. Moving this changes what is due to savings for September.',
    );
  });
});

describe('where the carry of a closed month really ends up', () => {
  const fuelSettlesFrom = (h: RecordingHarness, month: string) =>
    request(h.app)
      .put(`/api/budgets/${h.budget('Fuel').id}/versions/${month}`)
      .send({ amount: 10000, incremental: false })
      .expect(200);

  /** 25.00 of diesel for Fuel, recorded through the bot on `day` of the clock; returns its Undo button. */
  async function recordDiesel(h: RecordingHarness) {
    await h.say('/spending');
    await h.tapButton(/Fuel/);
    await h.say('25 diesel');
    await h.tapButton('Today');
    return (
      h
        .screen()
        .rows.flat()
        .find((b) => b.text === '↩ Undo')?.data ?? ''
    );
  }

  it('a budget that stopped carrying in September: the question names September’s savings, and its line follows', async () => {
    const h = await createRecordingHarness({ now: '2026-08-28T10:00:00Z' });
    const undo = await recordDiesel(h);
    await fuelSettlesFrom(h, '2026-09');
    h.clock.set('2026-10-05T10:00:00Z');
    const septemberBefore = await h.monthView('2026-09');
    const octoberBefore = await h.monthView('2026-10');

    await h.tap(undo);
    expect(h.screen().text).toBe(
      '€25.00 · Fuel · diesel · Fri 28 Aug\n' +
        'August is closed. Removing this changes what is due to savings for September.',
    );
    await h.tapButton('Remove');

    // The claim of the question, checked against the books: September's savings due move, October's Fuel does not.
    const septemberAfter = await h.monthView('2026-09');
    const octoberAfter = await h.monthView('2026-10');
    expect(septemberAfter.savingsDue.total - septemberBefore.savingsDue.total).toBe(2500);
    expect(line(octoberAfter, 'Fuel')).toEqual(line(octoberBefore, 'Fuel'));
    expect(line(septemberAfter, 'Fuel')).toMatchObject({
      remaining: 90000,
      available: 90000,
      usagePercent: 0,
    });
    expect(h.screen().text).toBe(
      '🗑 Removed €25.00 · Fuel · diesel · Fri 28 Aug\n' +
        'Fuel in August (closed): €800.00 left of €800.00 (0% used)\n' +
        'Fuel in September (closed): €900.00 left of €900.00 (0% used)',
    );
  });

  it('a budget archived with its last month in September: the same', async () => {
    const h = await createRecordingHarness({ now: '2026-08-28T10:00:00Z' });
    const undo = await recordDiesel(h);
    h.clock.set('2026-09-10T10:00:00Z');
    await request(h.app)
      .post(`/api/budgets/${h.budget('Fuel').id}/archive`)
      .send({ endMonth: '2026-09' })
      .expect(200);
    h.clock.set('2026-10-05T10:00:00Z');
    const septemberBefore = await h.monthView('2026-09');
    await h.tap(undo);
    expect(h.screen().text).toBe(
      '€25.00 · Fuel · diesel · Fri 28 Aug\n' +
        'August is closed. Removing this changes what is due to savings for September.',
    );
    await h.tapButton('Remove');
    const septemberAfter = await h.monthView('2026-09');
    expect(septemberAfter.savingsDue.total - septemberBefore.savingsDue.total).toBe(2500);
    expect(h.screen().text).toBe(
      '🗑 Removed €25.00 · Fuel · diesel · Fri 28 Aug\n' +
        'Fuel in August (closed): €800.00 left of €800.00 (0% used)\n' +
        'Fuel in September (closed): €900.00 left of €900.00 (0% used)',
    );
    // There is no line for October (the budget is archived): nothing is printed for it.
    expect(h.screen().text).not.toContain('this month');
  });

  it('a chain that carries twice and then settles: the question names where it settles, and so does the line', async () => {
    const h = await createRecordingHarness({ now: '2026-07-15T10:00:00Z' });
    const undo = await recordDiesel(h); // July
    await fuelSettlesFrom(h, '2026-09'); // July and August carry, September settles
    h.clock.set('2026-10-05T10:00:00Z');
    const septemberBefore = await h.monthView('2026-09');
    const augustBefore = await h.monthView('2026-08');
    await h.tap(undo);
    expect(h.screen().text).toBe(
      '€25.00 · Fuel · diesel · Wed 15 Jul\n' +
        'July is closed. Removing this changes what is due to savings for September.',
    );
    await h.tapButton('Remove');
    const septemberAfter = await h.monthView('2026-09');
    expect(septemberAfter.savingsDue.total - septemberBefore.savingsDue.total).toBe(2500);
    expect(
      line(await h.monthView('2026-08'), 'Fuel').remaining - line(augustBefore, 'Fuel').remaining,
    ).toBe(2500); // it passed through August
    expect(h.screen().text).toBe(
      '🗑 Removed €25.00 · Fuel · diesel · Wed 15 Jul\n' +
        'Fuel in July (closed): €700.00 left of €700.00 (0% used)\n' +
        'Fuel in September (closed): €900.00 left of €900.00 (0% used)',
    );
  });

  it('a budget that carries all the way: the carry reaches the current month, as before', async () => {
    const h = await createRecordingHarness({ now: '2026-08-28T10:00:00Z' });
    const undo = await recordDiesel(h);
    h.clock.set('2026-10-05T10:00:00Z');
    const septemberBefore = await h.monthView('2026-09');
    const octoberBefore = await h.monthView('2026-10');
    await h.tap(undo);
    expect(h.screen().text).toBe(
      '€25.00 · Fuel · diesel · Fri 28 Aug\n' +
        'August is closed. Removing this changes what Fuel carries forward from August.',
    );
    await h.tapButton('Remove');
    expect((await h.monthView('2026-09')).savingsDue.total).toBe(septemberBefore.savingsDue.total);
    expect(
      line(await h.monthView('2026-10'), 'Fuel').remaining - line(octoberBefore, 'Fuel').remaining,
    ).toBe(2500);
    expect(h.screen().text).toBe(
      '🗑 Removed €25.00 · Fuel · diesel · Fri 28 Aug\n' +
        'Fuel in August (closed): €800.00 left of €800.00 (0% used)\n' +
        'Fuel in October (this month): €1,000.00 left of €1,000.00 (0% used)',
    );
  });

  it('the previous month, which carries into the current one, is unchanged', async () => {
    const h = await createRecordingHarness({ now: '2026-10-02T10:00:00Z' });
    await askFuelInSeptember(h);
    expect(h.screen().text).toContain('changes what Fuel carries forward from September.');
    await h.tapButton('Save');
    expect(h.screen().text.split('\n')).toHaveLength(3);
    expect(h.screen().text).toContain('Fuel in October (this month): €975.00');
  });

  it('tells the alert watcher the level of the line where the carry lands, in its own month', async () => {
    const h = await createRecordingHarness({ now: '2026-08-28T10:00:00Z' });
    const undo = await recordDiesel(h);
    await fuelSettlesFrom(h, '2026-09');
    h.clock.set('2026-10-05T10:00:00Z');
    h.notify.markNotified.mockClear();
    await h.tap(undo);
    await h.tapButton('Remove');
    const fuel = h.budget('Fuel').id;
    expect(h.notify.markNotified.mock.calls.map(([record]) => record)).toEqual([
      { month: '2026-08', budgetId: fuel, level: 'ok' },
      { month: '2026-09', budgetId: fuel, level: 'ok' },
    ]);
  });

  it('adding to a closed month that stopped carrying is worded for where it settles', async () => {
    const h = await createRecordingHarness({ now: '2026-10-02T10:00:00Z' });
    await fuelSettlesFrom(h, '2026-09');
    await askFuelInSeptember(h);
    // September itself settles with savings: its own wording.
    expect(h.screen().text).toContain(
      'September is closed. Adding this changes what is due to savings for September.',
    );
  });
});

describe('a confirmed tap asks again about a month the question did not name', () => {
  it('Remove of /undo, tapped after midnight on the 1st, asks about the month that has just closed', async () => {
    const h = await createRecordingHarness({ now: '2026-10-31T23:58:00Z' });
    await h.say('12 coffee');
    await h.tapButton(/Eating out/);
    await h.say('/undo');
    expect(h.screen().text).toBe('Remove €12.00 · Eating out · coffee (Sat 31 Oct)?');
    h.clock.set('2026-11-01T00:01:00Z');
    await h.tapButton('Remove');
    expect(h.screen().text).toBe(
      '€12.00 · Eating out · coffee · Sat 31 Oct\n' +
        'October is closed. Removing this changes what is due to savings for October.',
    );
    expect(await spendingsOf(h)).toHaveLength(1); // not deleted yet
    expect(buttons(h)).toEqual(['Remove', 'Keep']);
    await h.tapButton('Remove'); // now it is named: this one goes through
    expect(h.screen().text).toContain('🗑 Removed €12.00 · Eating out · coffee · Sat 31 Oct');
    expect(await spendingsOf(h)).toEqual([]);
  });

  it('Delete of /recent asks again too, and Keep leaves the spending', async () => {
    const h = await createRecordingHarness({ now: '2026-10-31T23:58:00Z' });
    await h.say('12 coffee');
    await h.tapButton(/Eating out/);
    await h.say('/recent');
    await h.tapButton('🗑 1');
    expect(h.screen().text).toBe('Delete €12.00 · Eating out · coffee (Sat 31 Oct)?');
    h.clock.set('2026-11-01T00:01:00Z');
    await h.tapButton('Delete');
    expect(h.screen().text).toContain(
      'October is closed. Removing this changes what is due to savings for October.',
    );
    await h.tapButton('Keep');
    expect(h.screen().text).toBe('Kept.');
    expect(await spendingsOf(h)).toHaveLength(1);
  });

  it('does not ask again when the question already named every closed month', async () => {
    const h = await createRecordingHarness({ now: '2026-10-02T10:00:00Z' });
    await askFuelInSeptember(h);
    await h.tapButton('Save');
    await h.say('/undo'); // names September
    h.clock.set('2026-10-02T10:30:00Z'); // time passes, no month closes
    await h.tapButton('Remove');
    expect(h.screen().text).toContain('🗑 Removed €25.00');
  });

  it('asks again when the spending was moved into a closed month on the web in between', async () => {
    const h = await createRecordingHarness({ now: '2026-10-05T10:00:00Z' });
    await h.say('12 coffee');
    await h.tapButton(/Eating out/);
    await h.say('/undo');
    expect(h.screen().text).toBe('Remove €12.00 · Eating out · coffee (Mon 5 Oct)?');
    const [row] = await spendingsOf(h);
    await request(h.app)
      .patch(`/api/spendings/${row?.id}`)
      .send({ date: '2026-09-20' })
      .expect(200);
    await h.tapButton('Remove');
    expect(h.screen().text).toContain(
      'September is closed. Removing this changes what is due to savings for September.',
    );
    expect(await spendingsOf(h)).toHaveLength(1);
  });

  it('Save of a Change date asks again when more months are closed by then', async () => {
    const h = await createRecordingHarness({ now: '2026-10-03T10:00:00Z' });
    await h.say('12 coffee');
    await h.tapButton(/Eating out/); // dated 3 October, the current month
    await h.tapButton('📅 Change date');
    await h.tapButton('Wed 30'); // 30 September: names September
    expect(h.screen().text).toContain('September is closed. Moving this');
    h.clock.set('2026-11-01T00:01:00Z'); // and October closes before Save is tapped
    await h.tapButton('Save');
    expect(h.screen().text).toBe(
      '€12.00 · Eating out · coffee · Sat 3 Oct\nNew date: Wed 30 Sept\n' +
        'September and October are closed. Moving this changes what is due to savings for September and October.',
    );
    expect((await spendingsOf(h))[0]?.date).toBe('2026-10-03'); // not moved yet
    await h.tapButton('Save');
    expect((await spendingsOf(h))[0]?.date).toBe('2026-09-30');
  });

  it('a confirmed tap with nothing newly closed goes straight through (a /recent question that named none)', async () => {
    const h = await createRecordingHarness();
    await h.say('12 coffee');
    await h.tapButton(/Eating out/);
    await h.say('/recent');
    await h.tapButton('🗑 1');
    await h.tapButton('Delete');
    expect(h.screen().text).toContain('🗑 Removed €12.00');
  });
});
