/**
 * Budget alerts (docs/DOMAIN.md, "Budget alerts"): the escalation rule, the baseline, `markNotified`,
 * the retry of a failed send, and the debounce and one-at-a-time rule of the watcher. The facts are
 * set up through the API of an app without a bot, and the checks run the real watcher against the
 * fake handle, so what is asserted is what would reach Telegram.
 */
import type { BudgetDto } from '@wallet/shared';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type NotifyHarness, createNotifyHarness } from '../../testing/telegram-notify-harness';
import { addBudget, addSpending, addTransfer, onboard } from '../../testing/helpers';
import { createSpending } from '../spendings/spendings.service';
import { createTelegramNotify } from './telegram.notifications';

const open: NotifyHarness[] = [];
async function harness(options: Parameters<typeof createNotifyHarness>[0] = {}) {
  const h = createNotifyHarness(options);
  open.push(h);
  return h;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(open.splice(0).map((h) => h.close()));
});

/** Groceries 300.00 and Eating out 200.00, from January, in March 2026 (the harness's now). */
async function twoBudgets(h: NotifyHarness) {
  await onboard(h.setup);
  const groceries = await addBudget(h.setup, {
    name: 'Groceries',
    amount: 30000,
    startMonth: '2026-01',
  });
  const eatingOut = await addBudget(h.setup, {
    name: 'Eating out',
    amount: 20000,
    startMonth: '2026-01',
  });
  return { groceries, eatingOut };
}

const spend = (h: NotifyHarness, budget: BudgetDto, amount: number, date = '2026-03-10') =>
  addSpending(h.setup, { budgetId: budget.id, amount, date, description: 'x' });

describe('the escalation rule', () => {
  it('sends nothing while every budget is ok', async () => {
    const h = await harness();
    const { groceries } = await twoBudgets(h);
    await spend(h, groceries, 10000);
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual([]);
    expect(h.log()).toEqual([]);
  });

  it('announces a warning and then over, one message each, writing the level after each send', async () => {
    const h = await harness();
    const { groceries } = await twoBudgets(h);

    await spend(h, groceries, 25200); // 84% of 300.00
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['⚠️ Groceries: 84% used, €48.00 left of €300.00']);
    expect(h.log()).toEqual([`budget_alert 2026-03:${groceries.id} warning`]);

    await spend(h, groceries, 3000); // 94%: still a warning, already announced
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toHaveLength(1);

    await spend(h, groceries, 3040); // 312.40 of 300.00
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual([
      '⚠️ Groceries: 84% used, €48.00 left of €300.00',
      '🔴 Groceries is over by €12.40',
    ]);
    expect(h.log()).toEqual([`budget_alert 2026-03:${groceries.id} over`]);
  });

  it('sends only the message for over when a budget goes straight from ok to over', async () => {
    const h = await harness();
    const { eatingOut } = await twoBudgets(h);
    await spend(h, eatingOut, 21240);
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Eating out is over by €12.40']);
  });

  it('repeats nothing on a second check, however often it runs', async () => {
    const h = await harness();
    const { eatingOut } = await twoBudgets(h);
    await spend(h, eatingOut, 21240);
    for (let i = 0; i < 4; i++) await h.notify.checkBudgetAlerts();
    expect(h.texts()).toHaveLength(1);
  });

  it('sends nothing for a refund (a lower level) or for a rise back to a level already announced', async () => {
    const h = await harness();
    const { groceries } = await twoBudgets(h);
    await spend(h, groceries, 31240); // over by 12.40
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Groceries is over by €12.40']);

    await spend(h, groceries, -8000); // a refund: 232.40, 77%, ok
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toHaveLength(1);
    expect(h.log()).toEqual([`budget_alert 2026-03:${groceries.id} over`]); // not lowered

    await spend(h, groceries, 5000); // 282.40: a warning again, which was announced as over before
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toHaveLength(1);

    await spend(h, groceries, 2000); // 302.40: over again
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toHaveLength(1);
  });

  it('sends one message for every budget that went up in the same check, in the order of the month view', async () => {
    const h = await harness();
    const { groceries, eatingOut } = await twoBudgets(h);
    await spend(h, eatingOut, 21000); // over by 10.00
    await spend(h, groceries, 25200); // warning
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual([
      '⚠️ Groceries: 84% used, €48.00 left of €300.00',
      '🔴 Eating out is over by €10.00',
    ]);
  });

  it('escapes the name of a budget for HTML', async () => {
    const h = await harness();
    await onboard(h.setup);
    const odd = await addBudget(h.setup, { name: '<b>&', amount: 10000, startMonth: '2026-01' });
    await spend(h, odd, 10100);
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 &lt;b&gt;&amp; is over by €1.00']);
  });

  it('only watches the current month: a spending in a closed month announces nothing', async () => {
    const h = await harness();
    const { groceries } = await twoBudgets(h);
    await spend(h, groceries, 99999, '2026-02-10'); // February is over by a lot, but it is closed
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual([]);
  });

  it('follows the currency and locale of Settings', async () => {
    const h = await harness();
    await onboard(h.setup, { currency: 'GBP', locale: 'en-GB' });
    const budget = await addBudget(h.setup, { name: 'Fuel', amount: 10000, startMonth: '2026-01' });
    await spend(h, budget, 12345);
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Fuel is over by £23.45']);
  });
});

describe('a new month', () => {
  it('starts with no record: a budget that goes over again in April is announced again', async () => {
    const h = await harness();
    const { groceries } = await twoBudgets(h);
    await spend(h, groceries, 31000);
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Groceries is over by €10.00']);

    h.clock.set('2026-04-02T10:00:00Z');
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toHaveLength(1); // April has just started: nothing is over

    await spend(h, groceries, 32000, '2026-04-02');
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Groceries is over by €10.00', '🔴 Groceries is over by €20.00']);
    expect(h.log()).toEqual([
      `budget_alert 2026-03:${groceries.id} over`,
      `budget_alert 2026-04:${groceries.id} over`,
    ]);
  });

  it('announces a budget that begins the month over (an incremental one that carried a deficit in) at the first check', async () => {
    const h = await harness();
    await onboard(h.setup);
    const fuel = await addBudget(h.setup, {
      name: 'Fuel',
      amount: 10000,
      incremental: true,
      startMonth: '2026-03',
    });
    await spend(h, fuel, 25000); // March: 100.00 available, 250.00 spent, so 150.00 over
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Fuel is over by €150.00']);

    // April: the deficit of 150.00 carries in, 100.00 is allocated, so -50.00 is available with
    // nothing spent yet. The budget is over from the first minute; it is announced once, at the first
    // check at or after the notify time (the next describe is about the hours before it).
    h.clock.set('2026-04-01T09:00:00Z');
    await h.notify.checkBudgetAlerts();
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Fuel is over by €150.00', '🔴 Fuel is over by €50.00']);
    expect(h.log()).toEqual([
      `budget_alert 2026-03:${fuel.id} over`,
      `budget_alert 2026-04:${fuel.id} over`,
    ]);
  });
});

/**
 * A budget that begins a month over because of what it carried in has no event behind its alert, so
 * it is announced at the notify time (09:00 by default) and not at 00:01 (docs/DOMAIN.md, "Budget
 * alerts"). Fuel is incremental, 100.00 a month from March, and ended March 150.00 over: in April it
 * has 100.00 allocated and -150.00 carried in, so -50.00 available with nothing spent.
 */
describe('a budget that carried its alert in', () => {
  async function fuelInApril(options: Parameters<typeof createNotifyHarness>[0] = {}) {
    const h = await harness(options);
    await onboard(h.setup);
    const fuel = await addBudget(h.setup, {
      name: 'Fuel',
      amount: 10000,
      incremental: true,
      startMonth: '2026-03',
    });
    await spend(h, fuel, 25000); // March: 150.00 over
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Fuel is over by €150.00']);
    h.clock.set('2026-04-01T00:01:00Z');
    return { h, fuel };
  }

  it('is not announced at 00:01, and no row is written for it', async () => {
    const { h, fuel } = await fuelInApril();
    for (const time of ['00:01', '03:30', '08:59']) {
      h.clock.set(`2026-04-01T${time}:00Z`);
      await h.notify.checkBudgetAlerts();
    }
    expect(h.texts()).toEqual(['🔴 Fuel is over by €150.00']); // March's, nothing since
    expect(h.log()).toEqual([`budget_alert 2026-03:${fuel.id} over`]);
  });

  it('is announced at the first check at or after the notify time, once', async () => {
    const { h, fuel } = await fuelInApril();
    h.clock.set('2026-04-01T08:59:59Z');
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toHaveLength(1);

    h.clock.set('2026-04-01T09:00:00Z');
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Fuel is over by €150.00', '🔴 Fuel is over by €50.00']);
    expect(h.log()).toContain(`budget_alert 2026-04:${fuel.id} over`);

    h.clock.set('2026-04-01T12:00:00Z');
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toHaveLength(2);
  });

  it('is announced at once when a spending dated in the month arrives before the notify time', async () => {
    const { h, fuel } = await fuelInApril();
    h.clock.set('2026-04-01T08:00:00Z');
    await spend(h, fuel, 1000, '2026-04-01'); // 10.00 more on top of the carried deficit
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Fuel is over by €150.00', '🔴 Fuel is over by €60.00']);
    expect(h.log()).toContain(`budget_alert 2026-04:${fuel.id} over`);
  });

  it('is announced at once when a refund dated in the month arrives, for it is a fact of the month', async () => {
    const { h, fuel } = await fuelInApril();
    h.clock.set('2026-04-01T08:00:00Z');
    await spend(h, fuel, -500, '2026-04-01'); // a refund of 5.00: still 45.00 over
    await h.notify.checkBudgetAlerts();
    expect(h.texts()[1]).toBe('🔴 Fuel is over by €45.00');
  });

  it('is announced at once when a transfer dated in the month arrives before the notify time', async () => {
    const { h, fuel } = await fuelInApril();
    h.clock.set('2026-04-01T08:00:00Z');
    // 5.00 from the pool into Fuel: still 45.00 over, but now something happened this month.
    await addTransfer(h.setup, {
      fromBudgetId: null,
      toBudgetId: fuel.id,
      amount: 500,
      date: '2026-04-01',
    });
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Fuel is over by €150.00', '🔴 Fuel is over by €45.00']);
  });

  it('is announced by the first tick after downtime, when the server was off at the notify time', async () => {
    const { h, fuel } = await fuelInApril();
    h.savePrefs({ monthlyRecap: false }); // March's recap would be sent by the same tick
    const scheduler = h.startScheduler();
    h.clock.set('2026-04-01T08:59:00Z');
    await scheduler.tick();
    expect(h.texts()).toHaveLength(1);

    // The server was off from 09:00 and comes back at 17:45.
    h.clock.set('2026-04-01T17:45:00Z');
    await scheduler.tick();
    expect(h.texts()).toEqual(['🔴 Fuel is over by €150.00', '🔴 Fuel is over by €50.00']);
    expect(h.log()).toContain(`budget_alert 2026-04:${fuel.id} over`);
  });

  /**
   * Fuel is incremental, 100.00 a month from September, and ended September 50.00 over, so October
   * begins with -50.00 carried in and 100.00 allocated: 50.00 available, ok.
   */
  async function fuelInOctober() {
    const h = await harness({ now: '2026-09-10T10:00:00Z', linkedAt: '2026-09-01T08:00:00.000Z' });
    await onboard(h.setup, { startMonth: '2026-09' });
    const fuel = await addBudget(h.setup, {
      name: 'Fuel',
      amount: 10000,
      incremental: true,
      startMonth: '2026-09',
    });
    await spend(h, fuel, 15000, '2026-09-10');
    h.clock.set('2026-10-01T07:30:00Z');
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual([]); // 50.00 available, nothing spent: ok
    return { h, fuel };
  }

  it('waits for the notify time too when an edit of the budget made it over, and is not lost', async () => {
    // The test is on the fields of the month: nothing spent and no transfer. It cannot tell a deficit
    // carried in from an edit of what the budget has, so lowering October's allocation to 30.00 at
    // 07:30 (-20.00 available) is held to 09:00 like the carry-in, and announced then.
    const { h, fuel } = await fuelInOctober();
    await request(h.setup)
      .put(`/api/budgets/${fuel.id}/versions/2026-10`)
      .send({ amount: 3000, incremental: true })
      .expect(200);
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual([]);
    expect(h.log()).toEqual([]); // no row for a line that is held

    h.clock.set('2026-10-01T08:59:59Z');
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual([]);

    h.clock.set('2026-10-01T09:00:00Z');
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Fuel is over by €20.00']);
    expect(h.log()).toEqual([`budget_alert 2026-10:${fuel.id} over`]);
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toHaveLength(1); // once
  });

  it('waits for the notify time too when a late spending in the month before made it over', async () => {
    const { h, fuel } = await fuelInOctober();
    await spend(h, fuel, 6000, '2026-09-20'); // September ends 110.00 over: October has -10.00 available
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual([]);

    h.clock.set('2026-10-01T09:00:00Z');
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Fuel is over by €10.00']);
  });

  it('announces at once when a spending dated in the month follows the edit', async () => {
    const { h, fuel } = await fuelInOctober();
    await request(h.setup)
      .put(`/api/budgets/${fuel.id}/versions/2026-10`)
      .send({ amount: 3000, incremental: true })
      .expect(200);
    await spend(h, fuel, 500, '2026-10-01'); // 5.00 spent on top: 25.00 over
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Fuel is over by €25.00']);
  });

  it('cannot be a warning: nothing spent never reaches the warning threshold, however little is available', async () => {
    // A warning needs 100 * spent >= warnPercent * available with available > 0 and warnPercent at
    // least 1, so with nothing spent it never holds. Fuel carries -99.99 in and has 100.00: 0.01 is
    // available, and the threshold is the lowest there is (1%).
    const h = await harness({ now: '2026-09-10T10:00:00Z', linkedAt: '2026-09-01T08:00:00.000Z' });
    await onboard(h.setup, { startMonth: '2026-09' });
    const fuel = await addBudget(h.setup, {
      name: 'Fuel',
      amount: 10000,
      incremental: true,
      startMonth: '2026-09',
      alertWarnPercent: 1,
    });
    await spend(h, fuel, 19999, '2026-09-10'); // 99.99 over
    h.clock.set('2026-10-01T00:01:00Z');
    const view = (await request(h.setup).get('/api/months/2026-10').expect(200)).body;
    const october = view.budgets.find((line: { id: number }) => line.id === fuel.id);
    expect(october).toMatchObject({ available: 1, spent: 0, alert: 'ok', warnPercent: 1 });
    h.clock.set('2026-10-01T09:00:00Z');
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual([]);
  });

  it('follows the saved notify time', async () => {
    const { h } = await fuelInApril();
    h.savePrefs({ notifyAt: '18:00' });
    h.clock.set('2026-04-01T17:59:00Z');
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toHaveLength(1);
    h.clock.set('2026-04-01T18:00:00Z');
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toHaveLength(2);
  });

  it('does not hold back a budget that was moved by a spending, announcing both as each is due', async () => {
    const { h, fuel } = await fuelInApril();
    const groceries = await addBudget(h.setup, {
      name: 'Groceries',
      amount: 30000,
      startMonth: '2026-03',
    });
    h.clock.set('2026-04-01T00:30:00Z');
    await spend(h, groceries, 31000, '2026-04-01'); // over by 10.00 at half past midnight
    await h.notify.checkBudgetAlerts();
    // Groceries has a cause and is announced; Fuel only carried its alert in and waits for 09:00.
    expect(h.texts()).toEqual(['🔴 Fuel is over by €150.00', '🔴 Groceries is over by €10.00']);

    h.clock.set('2026-04-01T09:00:00Z');
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual([
      '🔴 Fuel is over by €150.00',
      '🔴 Groceries is over by €10.00',
      '🔴 Fuel is over by €50.00',
    ]);
    expect(h.log()).toContain(`budget_alert 2026-04:${fuel.id} over`);
  });

  it('does not delay an ordinary alert: a spending at 00:30 is announced at once', async () => {
    const h = await harness({ now: '2026-03-16T00:30:00Z' });
    const { groceries } = await twoBudgets(h);
    await spend(h, groceries, 25200, '2026-03-16');
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['⚠️ Groceries: 84% used, €48.00 left of €300.00']);
  });
});

describe('the baseline', () => {
  it('does not announce what was already over when the account is linked', async () => {
    const h = await harness();
    const { groceries, eatingOut } = await twoBudgets(h);
    await spend(h, groceries, 31000);
    await spend(h, eatingOut, 17000); // 85%: a warning

    h.notify.recordBaseline(); // what linking does
    expect(h.log()).toEqual([
      `budget_alert 2026-03:${groceries.id} over`,
      `budget_alert 2026-03:${eatingOut.id} warning`,
    ]);
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual([]);

    await spend(h, eatingOut, 4000); // 210.00: over
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Eating out is over by €10.00']);
  });

  it('records a budget that is ok too, so that the log shows the whole baseline', async () => {
    const h = await harness();
    const { groceries, eatingOut } = await twoBudgets(h);
    h.notify.recordBaseline();
    expect(h.log()).toEqual([
      `budget_alert 2026-03:${groceries.id} ok`,
      `budget_alert 2026-03:${eatingOut.id} ok`,
    ]);
  });

  it('never lowers a level that is already recorded', async () => {
    const h = await harness();
    const { groceries, eatingOut } = await twoBudgets(h);
    await spend(h, groceries, 31000);
    h.notify.recordBaseline();
    await spend(h, groceries, -20000); // ok again
    h.notify.recordBaseline();
    expect(h.log()).toEqual([
      `budget_alert 2026-03:${groceries.id} over`,
      `budget_alert 2026-03:${eatingOut.id} ok`,
    ]);
  });

  it('is taken when alerts are switched on, and not when they were on already', async () => {
    const h = await harness();
    const { groceries, eatingOut } = await twoBudgets(h);
    h.savePrefs({ budgetAlerts: false });
    await spend(h, groceries, 31000); // over while the alerts are off
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual([]);
    expect(h.log()).toEqual([]);

    h.savePrefs({ budgetAlerts: true }); // off to on: baseline
    expect(h.log()).toEqual([
      `budget_alert 2026-03:${groceries.id} over`,
      `budget_alert 2026-03:${eatingOut.id} ok`,
    ]);
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual([]);

    await spend(h, eatingOut, 21000);
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Eating out is over by €10.00']);
  });

  it('is not taken by a save that leaves the alerts on', async () => {
    const h = await harness();
    const { groceries } = await twoBudgets(h);
    await spend(h, groceries, 31000);
    h.savePrefs({ monthlyRecap: false }); // alerts were on (the default) and stay on
    expect(h.log()).toEqual([]);
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Groceries is over by €10.00']);
  });

  it('does nothing, and does not fail, before onboarding', async () => {
    const h = await harness();
    expect(() => h.notify.recordBaseline()).not.toThrow();
    await expect(h.notify.checkBudgetAlerts()).resolves.toBeUndefined();
    expect(h.log()).toEqual([]);
  });
});

describe('when nothing may be sent', () => {
  it('sends nothing and records nothing while the alerts are off', async () => {
    const h = await harness();
    const { groceries } = await twoBudgets(h);
    h.savePrefs({ budgetAlerts: false });
    await spend(h, groceries, 31000);
    await h.notify.checkBudgetAlerts();
    expect(h.fake.attempts).toEqual([]);
    expect(h.log()).toEqual([]);
  });

  it('sends nothing while no account is linked, and the alert is not lost', async () => {
    const h = await harness({ linkedAt: null });
    const { groceries } = await twoBudgets(h);
    await spend(h, groceries, 31000);
    await h.notify.checkBudgetAlerts();
    expect(h.fake.attempts).toEqual([]);
    expect(h.log()).toEqual([]);
  });

  it.each(['connecting', 'error', 'off'] as const)(
    'sends nothing while the bot is %s, and sends the alert once it runs',
    async (connection) => {
      const h = await harness({ status: { connection } });
      const { groceries } = await twoBudgets(h);
      await spend(h, groceries, 31000);
      await h.notify.checkBudgetAlerts();
      expect(h.fake.attempts).toEqual([]);
      expect(h.log()).toEqual([]);

      h.fake.setStatus({ connection: 'running' });
      await h.notify.checkBudgetAlerts();
      expect(h.texts()).toEqual(['🔴 Groceries is over by €10.00']);
    },
  );
});

describe('markNotified', () => {
  it('suppresses the alert for a level the bot confirmation already showed', async () => {
    const h = await harness();
    const { groceries } = await twoBudgets(h);
    await spend(h, groceries, 25200); // the bot's confirmation showed the warning
    h.notify.markNotified({ month: '2026-03', budgetId: groceries.id, level: 'warning' });
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual([]);
    expect(h.log()).toEqual([`budget_alert 2026-03:${groceries.id} warning`]);

    await spend(h, groceries, 6000); // a higher level is still announced
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Groceries is over by €12.00']);
  });

  it('writes its row at once and never lowers a level', async () => {
    const h = await harness();
    const { groceries } = await twoBudgets(h);
    const mark = (level: 'ok' | 'warning' | 'over') =>
      h.notify.markNotified({ month: '2026-03', budgetId: groceries.id, level });
    mark('over');
    mark('warning');
    mark('ok');
    expect(h.log()).toEqual([`budget_alert 2026-03:${groceries.id} over`]);
    expect(h.fake.attempts).toEqual([]); // nothing was sent
  });

  it('never throws: a failure is logged', async () => {
    const h = await harness();
    h.db.$client.close();
    expect(() =>
      h.notify.markNotified({ month: '2026-03', budgetId: 1, level: 'over' }),
    ).not.toThrow();
    expect(h.fake.logLines.join('\n')).toContain('could not record an alert level');
  });
});

describe('a failed send', () => {
  it('writes no row, is retried at the next check and is never lost', async () => {
    const h = await harness();
    const { groceries } = await twoBudgets(h);
    await spend(h, groceries, 31000);

    h.failSends(1);
    await h.notify.checkBudgetAlerts();
    expect(h.fake.attempts).toHaveLength(1);
    expect(h.texts()).toEqual([]);
    expect(h.log()).toEqual([]);
    expect(h.fake.logLines.join('\n')).toContain('could not send the alert of budget');

    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Groceries is over by €10.00']);
    expect(h.log()).toEqual([`budget_alert 2026-03:${groceries.id} over`]);

    await h.notify.checkBudgetAlerts(); // and a sent one is never repeated
    expect(h.texts()).toHaveLength(1);
  });

  it('stops at the first failure, and the next check sends what is left without repeating what went', async () => {
    const h = await harness();
    const { groceries, eatingOut } = await twoBudgets(h);
    await spend(h, groceries, 31000);
    await spend(h, eatingOut, 21000);

    h.failSends(2); // Groceries goes, Eating out fails
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Groceries is over by €10.00']);
    expect(h.log()).toEqual([`budget_alert 2026-03:${groceries.id} over`]);

    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual([
      '🔴 Groceries is over by €10.00',
      '🔴 Eating out is over by €10.00',
    ]);
  });

  it('is logged without the token of the bot', async () => {
    const h = await harness();
    const { groceries } = await twoBudgets(h);
    await spend(h, groceries, 31000);
    h.failSends(1);
    await h.notify.checkBudgetAlerts();
    expect(h.fake.logLines.join('\n')).not.toMatch(/\d{6,}:[A-Za-z0-9_-]{20,}/);
  });
});

describe('a restart', () => {
  it('does not repeat an alert: a new watcher on the same database starts from the log', async () => {
    const h = await harness();
    const { groceries } = await twoBudgets(h);
    await spend(h, groceries, 31000);
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toHaveLength(1);

    const restarted = createTelegramNotify({
      db: h.db,
      clock: h.clock,
      config: { appUrl: undefined },
      status: () => h.fake.status(),
      sendToLinked: (text, extra) => h.fake.sendToLinked(text, extra),
      log: h.fake.log,
    });
    await restarted.checkBudgetAlerts();
    expect(h.texts()).toHaveLength(1);

    await spend(h, groceries, -20000);
    await spend(h, groceries, 25000); // back over, which was announced
    await restarted.checkBudgetAlerts();
    expect(h.texts()).toHaveLength(1);
  });
});

describe('a check that cannot work', () => {
  it('never rejects: it logs and the next check runs normally', async () => {
    const h = await harness();
    const { groceries } = await twoBudgets(h);
    await spend(h, groceries, 31000);
    h.statusSpy.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(h.notify.checkBudgetAlerts()).resolves.toBeUndefined();
    expect(h.fake.logLines.join('\n')).toContain('the budget alert check failed');
    await h.notify.checkBudgetAlerts();
    expect(h.texts()).toEqual(['🔴 Groceries is over by €10.00']);
  });
});

describe('one check at a time', () => {
  it('does not start a second check while one runs, and runs one more afterwards', async () => {
    const h = await harness();
    const { groceries, eatingOut } = await twoBudgets(h);
    await spend(h, groceries, 31000);
    const release = h.blockSends();

    const first = h.notify.checkBudgetAlerts(); // sends Groceries' alert, held by Telegram
    expect(h.statusSpy).toHaveBeenCalledTimes(1);

    await spend(h, eatingOut, 21000); // a write while the check is running
    const second = h.notify.checkBudgetAlerts();
    expect(h.statusSpy).toHaveBeenCalledTimes(1); // no concurrent second check
    expect(second).toBe(first); // it joins the one that runs

    release();
    await second;
    expect(h.statusSpy).toHaveBeenCalledTimes(2); // exactly one more run
    expect(h.texts()).toEqual([
      '🔴 Groceries is over by €10.00',
      '🔴 Eating out is over by €10.00', // which the write that came in between raised
    ]);
  });

  it('runs once more only once, however many requests arrive during the run', async () => {
    const h = await harness();
    const { groceries } = await twoBudgets(h);
    await spend(h, groceries, 31000);
    const release = h.blockSends();
    const first = h.notify.checkBudgetAlerts();
    for (let i = 0; i < 5; i++) void h.notify.checkBudgetAlerts();
    release();
    await first;
    expect(h.statusSpy).toHaveBeenCalledTimes(2);
  });
});

describe('the debounce', () => {
  async function withFakeTimers() {
    const h = await harness();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    return h;
  }

  it('waits 2 seconds, then runs one check', async () => {
    const h = await withFakeTimers();
    h.notify.scheduleBudgetAlertCheck();
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.statusSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.statusSpy).toHaveBeenCalledTimes(1);
  });

  it('turns several writes within 2 seconds of each other into one check, 2 seconds after the last', async () => {
    const h = await withFakeTimers();
    h.notify.scheduleBudgetAlertCheck(); // t = 0
    await vi.advanceTimersByTimeAsync(500);
    h.notify.scheduleBudgetAlertCheck(); // t = 500
    await vi.advanceTimersByTimeAsync(1000);
    h.notify.scheduleBudgetAlertCheck(); // t = 1500
    await vi.advanceTimersByTimeAsync(1999); // t = 3499
    expect(h.statusSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); // t = 3500
    expect(h.statusSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.statusSpy).toHaveBeenCalledTimes(1);
  });

  it('runs a check for each burst of writes', async () => {
    const h = await withFakeTimers();
    h.notify.scheduleBudgetAlertCheck();
    await vi.advanceTimersByTimeAsync(2000);
    h.notify.scheduleBudgetAlertCheck();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.statusSpy).toHaveBeenCalledTimes(2);
  });

  it('drops a pending check on stop and refuses new ones', async () => {
    const h = await withFakeTimers();
    h.notify.scheduleBudgetAlertCheck();
    h.notify.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.statusSpy).not.toHaveBeenCalled();
    h.notify.scheduleBudgetAlertCheck();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.statusSpy).not.toHaveBeenCalled();
    await h.notify.checkBudgetAlerts(); // and an explicit check does nothing either
    expect(h.statusSpy).not.toHaveBeenCalled();
  });

  it('does not keep the process alive', async () => {
    const h = await harness();
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(timer);
    h.notify.scheduleBudgetAlertCheck();
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 2000);
    expect(timer.unref).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('runs a check that the timer starts while another is running only after it', async () => {
    const h = await harness();
    const { groceries, eatingOut } = await twoBudgets(h);
    await spend(h, groceries, 31000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); // after the setup: supertest hangs under them
    const release = h.blockSends();

    h.notify.scheduleBudgetAlertCheck();
    await vi.advanceTimersByTimeAsync(2000); // the check runs and waits for Telegram
    expect(h.statusSpy).toHaveBeenCalledTimes(1);

    createSpending(h, {
      budgetId: eatingOut.id,
      amount: 21000,
      date: '2026-03-10',
      description: 'x',
    });
    h.notify.scheduleBudgetAlertCheck();
    await vi.advanceTimersByTimeAsync(2000); // asked for again while the first one runs
    expect(h.statusSpy).toHaveBeenCalledTimes(1);

    release();
    await h.notify.whenIdle?.();
    expect(h.statusSpy).toHaveBeenCalledTimes(2);
    expect(h.texts()).toEqual([
      '🔴 Groceries is over by €10.00',
      '🔴 Eating out is over by €10.00',
    ]);
  });
});
