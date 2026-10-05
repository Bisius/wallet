/**
 * The baseline as the platform calls it (docs/DOMAIN.md, "Baseline"): linking through the real
 * `/start <code>` handler of the bot, and switching alerts on through `PUT /api/telegram/notifications`.
 * Both are T1's wiring; the baseline they call is the real one.
 */
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app';
import { OWNER } from '../../testing/fake-bot-api';
import { addBudget, addSpending, onboard } from '../../testing/helpers';
import { createBotHarness } from '../../testing/telegram-harness';
import { type NotifyHarness, createNotifyHarness } from '../../testing/telegram-notify-harness';
import { createPairing } from './telegram.access';
import { createTelegramNotify } from './telegram.notifications';

const open: NotifyHarness[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
});

describe('linking an account', () => {
  async function unlinkedBot() {
    const h = createBotHarness({ now: '2026-03-15T10:00:00Z' }); // nobody is linked
    const notify = createTelegramNotify({
      db: h.db,
      clock: h.clock,
      config: { appUrl: undefined },
      status: () => ({ connection: 'running', problem: null, bot: null }),
      sendToLinked: (text, extra) => h.tg.sendToLinked(text, extra),
      log: h.tg.log,
    });
    h.tg.notify = notify; // the real watcher in place of the mock
    const app = createApp({
      db: h.db,
      clock: h.clock,
      config: { env: 'test', staticDir: undefined },
    });
    await onboard(app);
    const groceries = await addBudget(app, {
      name: 'Groceries',
      amount: 30000,
      startMonth: '2026-01',
    });
    const eatingOut = await addBudget(app, {
      name: 'Eating out',
      amount: 20000,
      startMonth: '2026-01',
    });
    return { h, notify, app, groceries, eatingOut };
  }

  it('records the baseline, so budgets that were already over are not announced', async () => {
    const { h, notify, app, groceries, eatingOut } = await unlinkedBot();
    await addSpending(app, { budgetId: groceries.id, amount: 31000, date: '2026-03-10' }); // over
    await addSpending(app, { budgetId: eatingOut.id, amount: 17000, date: '2026-03-10' }); // warning

    await notify.checkBudgetAlerts(); // nobody is linked yet: nothing to do
    expect(h.fake.sentTexts()).toEqual([]);

    const { code } = createPairing(h.tg);
    await h.say(`/start ${code}`, { from: OWNER });
    expect(h.fake.sentTexts()).toHaveLength(1);
    expect(h.fake.sentTexts()[0]).toContain('Linked to Wallet'); // the greeting, and nothing else

    await notify.checkBudgetAlerts();
    expect(h.fake.sentTexts()).toHaveLength(1); // no flood of what was already over

    await addSpending(app, { budgetId: eatingOut.id, amount: 4000, date: '2026-03-11' }); // over now
    await notify.checkBudgetAlerts();
    expect(h.fake.sentTexts()).toHaveLength(2);
    expect(h.fake.sentTexts()[1]).toBe('🔴 Eating out is over by €10.00');
  });

  it('records the baseline again when another account is linked', async () => {
    const { h, notify, app, eatingOut } = await unlinkedBot();
    const first = createPairing(h.tg);
    await h.say(`/start ${first.code}`, { from: OWNER });
    // Over, but no check ran before the next account links, so it was never announced ...
    await addSpending(app, { budgetId: eatingOut.id, amount: 21000, date: '2026-03-10' });

    const other = { id: 5151, first_name: 'Sam' };
    const second = createPairing(h.tg);
    await h.say(`/start ${second.code}`, { from: other });
    const before = h.fake.sentTexts().length;
    // ... and the baseline of the new link makes it old news.
    await notify.checkBudgetAlerts();
    expect(h.fake.sentTexts()).toHaveLength(before);
    expect(h.fake.sentTexts().join('\n')).not.toContain('🔴');
  });
});

describe('PUT /api/telegram/notifications', () => {
  const body = (budgetAlerts: boolean) => ({
    budgetAlerts,
    renewalYearlyDays: 7,
    renewalMonthlyDays: 1,
    monthlyRecap: true,
    notifyAt: '09:00',
  });

  async function scenario() {
    const h = createNotifyHarness();
    open.push(h);
    await onboard(h.setup);
    const groceries = await addBudget(h.setup, {
      name: 'Groceries',
      amount: 30000,
      startMonth: '2026-01',
    });
    return { h, groceries, app: h.appWithBot() };
  }

  it('records the baseline when alerts are switched on, and sends nothing for what was over', async () => {
    const { h, groceries, app } = await scenario();
    await request(app).put('/api/telegram/notifications').send(body(false)).expect(200);
    await addSpending(h.setup, { budgetId: groceries.id, amount: 31000, date: '2026-03-10' });
    expect(h.log()).toEqual([]);

    await request(app).put('/api/telegram/notifications').send(body(true)).expect(200);
    expect(h.log()).toEqual([`budget_alert 2026-03:${groceries.id} over`]);
    await h.notify.checkBudgetAlerts();
    expect(h.fake.attempts).toEqual([]);
  });

  it('records no baseline when the alerts stay off, or were on already', async () => {
    const { h, groceries, app } = await scenario();
    await addSpending(h.setup, { budgetId: groceries.id, amount: 31000, date: '2026-03-10' });
    await request(app).put('/api/telegram/notifications').send(body(true)).expect(200); // on, was on
    expect(h.log()).toEqual([]);
    await request(app).put('/api/telegram/notifications').send(body(false)).expect(200);
    await request(app).put('/api/telegram/notifications').send(body(false)).expect(200); // off, was off
    expect(h.log()).toEqual([]);
  });
});
