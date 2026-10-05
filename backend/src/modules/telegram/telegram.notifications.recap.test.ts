/**
 * The monthly recap (docs/DOMAIN.md, "Monthly recap"), driven by the scheduler's `tick()` with the
 * clock moved to the 1st. The scenario is worked out by hand, in English (UK), EUR:
 *
 *   Settings    tracking from August 2026, salary 3,000.00, opening savings 0
 *   Netflix     monthly 13.99, from August                      fixed costs 13.99 a month
 *   Budgets     Groceries 600.00 (settled with savings), Eating out 200.00 (settled),
 *               Fuel 150.00 (incremental: what is left carries over)    allocated 950.00 a month
 *   August      nothing spent, so Fuel carries 150.00 into September
 *   September   Groceries 520.00 (300.00 + 220.00), Eating out 242.00, Fuel 100.00
 *
 *   September per budget      remaining   carriedOut   toSavings
 *     Groceries (600.00)          80.00         0.00       80.00
 *     Eating out (200.00)        -42.00         0.00      -42.00     over by 42.00
 *     Fuel (150.00 + 150.00)     200.00       200.00        0.00
 *   spent 520.00 + 242.00 + 100.00 = 862.00      remaining 80.00 - 42.00 + 200.00 = 238.00
 *   unallocated 3,000.00 - 13.99 - 950.00 = 2,036.01
 *   due to savings 2,036.01 + (80.00 - 42.00 + 0.00) = 2,074.01
 *
 * The owner linked on 20 September, and the clock moves to 1 October at 09:00 (the notify time).
 */
import type { MonthView, SavingsDto } from '@wallet/shared';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { linkTelegramAccount } from '../../testing/fake-telegram';
import { addSpending, addSubscription, onboard, withTimeZone } from '../../testing/helpers';
import { type NotifyHarness, createNotifyHarness } from '../../testing/telegram-notify-harness';
import { TelegramSendError } from './telegram.types';

const open: NotifyHarness[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
});

const LINKED = '2026-09-20T08:00:00.000Z';

/**
 * What the runtime throws for a message that did not go out: a `TelegramSendError`, carrying the
 * `error_code` Telegram answered with (`telegramCode`), or none for a failure with no answer.
 */
function telegramError(code: number | undefined): TelegramSendError {
  return new TelegramSendError('refused', 'Telegram did not accept the message', code);
}

const SEPTEMBER_RECAP = [
  '📅 September 2026 is closed',
  'Spent €862.00 · €238.00 left over',
  '🔴 Over: Eating out by €42.00',
  '↪ Carried into October: €200.00',
  '💰 Due to savings: €2,074.01 · not settled yet',
].join('\n');

/** The scenario above, set up on 25 September. The clock is then moved to `moveTo`. */
async function september(
  options: Parameters<typeof createNotifyHarness>[0] & { moveTo?: string } = {},
) {
  const { moveTo = '2026-10-01T09:00:00Z', ...rest } = options;
  const h = createNotifyHarness({ now: '2026-09-25T10:00:00Z', linkedAt: LINKED, ...rest });
  open.push(h);
  const { budgets } = await onboard(h.setup, {
    locale: 'en-GB',
    startMonth: '2026-08',
    salary: 300000,
    openingSavings: 0,
    budgets: [
      { name: 'Groceries', amount: 60000, incremental: false },
      { name: 'Eating out', amount: 20000, incremental: false },
      { name: 'Fuel', amount: 15000, incremental: true },
    ],
  });
  await addSubscription(h.setup, {
    name: 'Netflix',
    frequency: 'monthly',
    anchorDate: '2026-08-15',
    amount: 1399,
    startMonth: '2026-08',
  });
  const [groceries, eatingOut, fuel] = budgets;
  for (const [budget, amount, date] of [
    [groceries, 30000, '2026-09-10'],
    [groceries, 22000, '2026-09-11'],
    [eatingOut, 24200, '2026-09-12'],
    [fuel, 10000, '2026-09-14'],
  ] as const) {
    await addSpending(h.setup, { budgetId: budget?.id as number, amount, date });
  }
  h.clock.set(moveTo);
  return { h, scheduler: h.startScheduler() };
}

const viewOf = async (h: NotifyHarness, month: string): Promise<MonthView> =>
  (await request(h.setup).get(`/api/months/${month}`).expect(200)).body;

describe('what the recap says', () => {
  it('is the month view of the month that closed, worked out by hand to the cent', async () => {
    const { h, scheduler } = await september();
    await scheduler.tick();
    expect(h.texts()).toEqual([SEPTEMBER_RECAP]);
  });

  it('equals the fields of the month view and of the savings inbox', async () => {
    const { h, scheduler } = await september();
    const view = await viewOf(h, '2026-09');
    const savings: SavingsDto = (await request(h.setup).get('/api/savings').expect(200)).body;

    // The hand-worked figures are what the API says ...
    expect(view.totals.spent).toBe(86200);
    expect(view.totals.remaining).toBe(23800);
    expect(
      view.budgets.filter((b) => b.alert === 'over').map((b) => [b.name, -b.remaining]),
    ).toEqual([['Eating out', 4200]]);
    expect(view.budgets.reduce((sum, b) => sum + b.carriedOut, 0)).toBe(20000);
    expect(view.savingsDue.total).toBe(207401);
    expect(savings.outstanding.map((entry) => entry.month)).toContain('2026-09');

    // ... and the recap prints those fields, nothing else.
    await scheduler.tick();
    const text = h.texts()[0] ?? '';
    expect(text).toContain('Spent €862.00 · €238.00 left over');
    expect(text).toContain('Carried into October: €200.00');
    expect(text).toContain('Due to savings: €2,074.01');
  });

  it('names December and January across a year end, with the carried leftover of four months', async () => {
    const { h, scheduler } = await september({ moveTo: '2027-01-01T09:00:00Z' });
    await scheduler.tick();
    // December: nothing spent. Fuel carried 200.00 out of September, +150.00 in each of Oct, Nov
    // and Dec = 650.00 left. Remaining 600.00 + 200.00 + 650.00 = 1,450.00. Due 2,036.01 + 800.00.
    expect(h.texts()).toEqual([
      [
        '📅 December 2026 is closed',
        'Spent €0.00 · €1,450.00 left over',
        '↪ Carried into January: €650.00',
        '💰 Due to savings: €2,836.01 · not settled yet',
      ].join('\n'),
    ]);
  });

  it('escapes the name of a budget that is over for HTML', async () => {
    const h = createNotifyHarness({ now: '2026-09-25T10:00:00Z', linkedAt: LINKED });
    open.push(h);
    const { budgets } = await onboard(h.setup, {
      startMonth: '2026-08',
      salary: 100000,
      openingSavings: 0,
      budgets: [{ name: '<b>&', amount: 10000, incremental: false }],
    });
    await addSpending(h.setup, {
      budgetId: budgets[0]?.id as number,
      amount: 11000,
      date: '2026-09-10',
    });
    h.clock.set('2026-10-01T09:00:00Z');
    await h.startScheduler().tick();
    expect(h.texts()[0]).toContain('🔴 Over: &lt;b&gt;&amp; by €10.00');
  });
});

describe('the savings marker', () => {
  it('says "not settled yet" while the month is in the savings inbox', async () => {
    const { h, scheduler } = await september();
    await scheduler.tick();
    expect(h.texts()[0]).toMatch(/Due to savings: €2,074\.01 · not settled yet$/);
  });

  it('says "settled" once the month was settled', async () => {
    const { h, scheduler } = await september();
    await request(h.setup).post('/api/savings/settle/2026-09').send({ amount: 207401 }).expect(201);
    await scheduler.tick();
    expect(h.texts()[0]).toMatch(/Due to savings: €2,074\.01 · settled$/);
  });

  it('words a correction after the settlement: what was settled, and what is taken back', async () => {
    // September is settled for 2,074.01. Then a forgotten 30.00 spending dated in September is added
    // to Groceries (remaining 80.00 becomes 50.00): 2,044.01 is due now, so 30.00 must be taken back.
    const { h, scheduler } = await september();
    await request(h.setup).post('/api/savings/settle/2026-09').send({ amount: 207401 }).expect(201);
    await addSpending(h.setup, { budgetId: 1, amount: 3000, date: '2026-09-20' });

    // The hand-worked figures are what the API says ...
    const view = await viewOf(h, '2026-09');
    expect(view.savingsDue.total).toBe(204401);
    const savings: SavingsDto = (await request(h.setup).get('/api/savings').expect(200)).body;
    expect(savings.outstanding.find((entry) => entry.month === '2026-09')).toMatchObject({
      savingsDue: 204401,
      settled: 207401,
      outstanding: -3000,
      direction: 'take',
      adjustment: true,
    });

    // ... and the recap does not say "not settled yet" over a total that was already moved.
    await scheduler.tick();
    expect(h.texts()).toEqual([
      [
        '📅 September 2026 is closed',
        'Spent €892.00 · €208.00 left over',
        '🔴 Over: Eating out by €42.00',
        '↪ Carried into October: €200.00',
        '💰 Due to savings: €2,044.01 · €2,074.01 already moved to savings, take €30.00 more from savings',
      ].join('\n'),
    ]);
  });

  it('words a correction that moves more to savings after a refund was added', async () => {
    const { h, scheduler } = await september();
    await request(h.setup).post('/api/savings/settle/2026-09').send({ amount: 207401 }).expect(201);
    await addSpending(h.setup, { budgetId: 1, amount: -3000, date: '2026-09-20' }); // a refund of 30.00
    await scheduler.tick();
    expect(h.texts()[0]).toMatch(
      /Spent €832\.00 · €268\.00 left over\n.*\n.*\n💰 Due to savings: €2,104\.01 · €2,074\.01 already moved to savings, move €30\.00 more to savings$/s,
    );
  });

  it('is "not settled yet" again, as for a first settlement, once the settlement is undone', async () => {
    const { h, scheduler } = await september();
    await request(h.setup).post('/api/savings/settle/2026-09').send({ amount: 207401 }).expect(201);
    await addSpending(h.setup, { budgetId: 1, amount: 3000, date: '2026-09-20' });
    await request(h.setup).delete('/api/savings/settle/2026-09').expect(204);
    await scheduler.tick();
    expect(h.texts()[0]).toMatch(/Due to savings: €2,044\.01 · not settled yet$/);
  });

  it('says in words, with no sign, that money was already taken from savings', async () => {
    // Salary 1,000.00 all allocated to Groceries and 1,150.00 spent: 150.00 is due to be taken from
    // savings, and it is taken (a settlement of -150.00). Then a forgotten 30.00 spending dated in
    // September: 180.00 is due now, so 30.00 more is to be taken.
    const h = createNotifyHarness({ now: '2026-09-25T10:00:00Z', linkedAt: LINKED });
    open.push(h);
    const { budgets } = await onboard(h.setup, {
      locale: 'en-GB',
      startMonth: '2026-08',
      salary: 100000,
      openingSavings: 0,
      budgets: [{ name: 'Groceries', amount: 100000, incremental: false }],
    });
    const groceries = budgets[0]?.id as number;
    await addSpending(h.setup, { budgetId: groceries, amount: 115000, date: '2026-09-10' });
    h.clock.set('2026-10-01T09:00:00Z');
    await request(h.setup).post('/api/savings/settle/2026-09').send({ amount: -15000 }).expect(201);
    await addSpending(h.setup, { budgetId: groceries, amount: 3000, date: '2026-09-20' });

    const savings: SavingsDto = (await request(h.setup).get('/api/savings').expect(200)).body;
    expect(savings.outstanding.find((entry) => entry.month === '2026-09')).toMatchObject({
      savingsDue: -18000,
      settled: -15000,
      outstanding: -3000,
      direction: 'take',
      adjustment: true,
    });

    await h.startScheduler().tick();
    expect(h.texts()).toEqual([
      [
        '📅 September 2026 is closed',
        'Spent €1,180.00 · €180.00 over',
        '🔴 Over: Groceries by €180.00',
        '↪ Carried into October: €0.00',
        '💰 To take from savings: €180.00 · €150.00 already taken from savings, take €30.00 more from savings',
      ].join('\n'),
    ]);
  });

  it('says it is a correction when earlier settlements cancel out, as the inbox does', async () => {
    // Salary 1,000.00 = Netflix 13.99 + Groceries 986.01. Groceries spent 956.01: 30.00 is due.
    // It is settled (+30.00); a forgotten 30.00 spending makes it due 0, which is settled (-30.00);
    // a 30.00 refund makes it due 30.00 again. Net settled is 0, but the month has settlement rows.
    const h = createNotifyHarness({ now: '2026-09-25T10:00:00Z', linkedAt: LINKED });
    open.push(h);
    const { budgets } = await onboard(h.setup, {
      locale: 'en-GB',
      startMonth: '2026-08',
      salary: 100000,
      openingSavings: 0,
      budgets: [{ name: 'Groceries', amount: 98601, incremental: false }],
    });
    await addSubscription(h.setup, {
      name: 'Netflix',
      anchorDate: '2026-08-15',
      amount: 1399,
      startMonth: '2026-08',
    });
    const groceries = budgets[0]?.id as number;
    await addSpending(h.setup, { budgetId: groceries, amount: 95601, date: '2026-09-10' });
    h.clock.set('2026-10-01T09:00:00Z');
    const settle = (amount: number) =>
      request(h.setup).post('/api/savings/settle/2026-09').send({ amount }).expect(201);
    await settle(3000);
    await addSpending(h.setup, { budgetId: groceries, amount: 3000, date: '2026-09-20' });
    await settle(-3000);
    await addSpending(h.setup, { budgetId: groceries, amount: -3000, date: '2026-09-21' });

    const savings: SavingsDto = (await request(h.setup).get('/api/savings').expect(200)).body;
    expect(savings.outstanding.find((entry) => entry.month === '2026-09')).toMatchObject({
      savingsDue: 3000,
      settled: 0,
      outstanding: 3000,
      direction: 'move',
      adjustment: true, // so the inbox shows a "Correction", and so does the recap
    });

    await h.startScheduler().tick();
    expect(h.texts()).toEqual([
      [
        '📅 September 2026 is closed',
        'Spent €956.01 · €30.00 left over',
        '↪ Carried into October: €0.00',
        '💰 Due to savings: €30.00 · settled before, move €30.00 more to savings',
      ].join('\n'),
    ]);
  });

  it('says nothing when the month moves nothing to savings, and leaves the Over line out when no budget is over', async () => {
    // Salary 1,000.00 = Netflix 13.99 + Groceries 986.01, all of it spent: nothing is left anywhere.
    const h = createNotifyHarness({ now: '2026-09-25T10:00:00Z', linkedAt: LINKED });
    open.push(h);
    const { budgets } = await onboard(h.setup, {
      locale: 'en-GB',
      startMonth: '2026-08',
      salary: 100000,
      openingSavings: 0,
      budgets: [{ name: 'Groceries', amount: 98601, incremental: false }],
    });
    await addSubscription(h.setup, {
      name: 'Netflix',
      anchorDate: '2026-08-15',
      amount: 1399,
      startMonth: '2026-08',
    });
    await addSpending(h.setup, {
      budgetId: budgets[0]?.id as number,
      amount: 98601,
      date: '2026-09-10',
    });
    h.clock.set('2026-10-01T09:00:00Z');
    await h.startScheduler().tick();
    expect(h.texts()).toEqual([
      [
        '📅 September 2026 is closed',
        'Spent €986.01 · €0.00 left over',
        '↪ Carried into October: €0.00',
        '💰 Due to savings: €0.00',
      ].join('\n'),
    ]);
  });

  it('reads a negative total as money to take from savings, and a total overspend as "over"', async () => {
    // Salary 1,000.00 all allocated to Groceries, and 1,150.00 spent: 150.00 is taken from savings.
    const h = createNotifyHarness({ now: '2026-09-25T10:00:00Z', linkedAt: LINKED });
    open.push(h);
    const { budgets } = await onboard(h.setup, {
      locale: 'en-GB',
      startMonth: '2026-08',
      salary: 100000,
      openingSavings: 0,
      budgets: [{ name: 'Groceries', amount: 100000, incremental: false }],
    });
    await addSpending(h.setup, {
      budgetId: budgets[0]?.id as number,
      amount: 115000,
      date: '2026-09-10',
    });
    h.clock.set('2026-10-01T09:00:00Z');
    await h.startScheduler().tick();
    expect(h.texts()).toEqual([
      [
        '📅 September 2026 is closed',
        'Spent €1,150.00 · €150.00 over',
        '🔴 Over: Groceries by €150.00',
        '↪ Carried into October: €0.00',
        '💰 To take from savings: €150.00 · not settled yet',
      ].join('\n'),
    ]);
  });
});

describe('the button', () => {
  it('opens the savings page of APP_URL', async () => {
    const { h, scheduler } = await september({ appUrl: 'https://wallet.example.ts.net' });
    await scheduler.tick();
    expect(h.fake.sent).toHaveLength(1);
    expect(h.fake.sent[0]?.text).toBe(SEPTEMBER_RECAP);
    expect(h.fake.sent[0]?.extra).toEqual({
      reply_markup: {
        inline_keyboard: [[{ text: 'Open savings', url: 'https://wallet.example.ts.net/savings' }]],
      },
    });
  });

  it('is left out without APP_URL', async () => {
    const { h, scheduler } = await september();
    await scheduler.tick();
    expect(h.fake.sent[0]?.extra).toBeUndefined();
  });

  it('is dropped, not the recap, when Telegram answers 400 to the message with it, and only once', async () => {
    const { h, scheduler } = await september({ appUrl: 'http://localhost:3400' });
    h.failSendsWith(telegramError(400), 1); // Telegram does not accept a link to localhost in a button
    await scheduler.tick();
    expect(h.fake.attempts).toHaveLength(2);
    expect(h.fake.attempts[0]?.extra).toBeDefined();
    expect(h.fake.attempts[1]?.extra).toBeUndefined();
    expect(h.texts()).toEqual([SEPTEMBER_RECAP]);
    expect(h.log()).toEqual(['recap 2026-09']);
    await scheduler.tick();
    expect(h.texts()).toHaveLength(1);
  });

  it('is not sent a second time after a timeout, which may have gone out: it waits for the next tick', async () => {
    const { h, scheduler } = await september({ appUrl: 'https://wallet.example.ts.net' });
    // No answer from Telegram at all: nobody knows whether the first message was accepted.
    h.failSendsWith(telegramError(undefined), 1);
    await scheduler.tick();
    expect(h.fake.attempts).toHaveLength(1);
    expect(h.texts()).toEqual([]);
    expect(h.log()).toEqual([]); // no row, so it is tried again

    await scheduler.tick();
    expect(h.fake.attempts).toHaveLength(2);
    expect(h.texts()).toEqual([SEPTEMBER_RECAP]);
    expect(h.fake.sent[0]?.extra).toBeDefined(); // with the button: it was not the button
    expect(h.log()).toEqual(['recap 2026-09']);
  });

  it.each([403, 429, 500, 502, 503])(
    'is not sent a second time after an answer of %i, which says nothing about the button',
    async (code) => {
      const { h, scheduler } = await september({ appUrl: 'https://wallet.example.ts.net' });
      h.failSendsWith(telegramError(code), 1);
      await scheduler.tick();
      expect(h.fake.attempts).toHaveLength(1);
      expect(h.log()).toEqual([]);
    },
  );

  it('is not sent a second time when the failure is not a send error at all', async () => {
    const { h, scheduler } = await september({ appUrl: 'https://wallet.example.ts.net' });
    h.failSendsWith(new Error('socket hang up'), 1);
    await scheduler.tick();
    expect(h.fake.attempts).toHaveLength(1);
    expect(h.log()).toEqual([]);
  });

  it('is tried again at the next tick, with the button, when the message without it is refused too', async () => {
    const { h, scheduler } = await september({ appUrl: 'https://wallet.example.ts.net' });
    h.failSendsWith(telegramError(400), 1, 2);
    await scheduler.tick();
    expect(h.fake.attempts).toHaveLength(2);
    expect(h.texts()).toEqual([]);
    expect(h.log()).toEqual([]);

    await scheduler.tick();
    expect(h.fake.attempts).toHaveLength(3);
    expect(h.texts()).toEqual([SEPTEMBER_RECAP]);
    expect(h.fake.sent[0]?.extra).toBeDefined();
  });

  it('is not sent a second time after a 400 when there was no button to drop', async () => {
    const { h, scheduler } = await september(); // no APP_URL
    h.failSendsWith(telegramError(400), 1);
    await scheduler.tick();
    expect(h.fake.attempts).toHaveLength(1);
    expect(h.log()).toEqual([]);
  });
});

describe('when it is sent', () => {
  it('goes out at the first tick at or after the notify time on the 1st, and only once', async () => {
    const { h, scheduler } = await september({ moveTo: '2026-10-01T08:59:00Z' });
    await scheduler.tick();
    expect(h.fake.attempts).toEqual([]);
    h.clock.set('2026-10-01T09:00:00Z');
    await scheduler.tick();
    expect(h.texts()).toEqual([SEPTEMBER_RECAP]);
    expect(h.log()).toEqual(['recap 2026-09']);

    await scheduler.tick();
    h.clock.set('2026-10-01T23:59:00Z');
    await scheduler.tick();
    h.clock.set('2026-10-02T09:00:00Z');
    await scheduler.tick();
    expect(h.texts()).toHaveLength(1);
  });

  it('follows the saved time of day', async () => {
    const { h, scheduler } = await september({ moveTo: '2026-10-01T18:29:00Z' });
    h.savePrefs({ notifyAt: '18:30' });
    await scheduler.tick();
    expect(h.fake.attempts).toEqual([]);
    h.clock.set('2026-10-01T18:30:00Z');
    await scheduler.tick();
    expect(h.texts()).toHaveLength(1);
  });

  it('does not repeat after a restart', async () => {
    const { h, scheduler } = await september();
    await scheduler.tick();
    const restarted = h.startScheduler();
    await restarted.tick();
    expect(h.texts()).toHaveLength(1);
  });

  it('catches up on a later day of the month when the server was off on the 1st', async () => {
    const { h, scheduler } = await september({ moveTo: '2026-10-17T14:00:00Z' });
    await scheduler.tick();
    expect(h.texts()).toEqual([SEPTEMBER_RECAP]);
  });

  it('never recaps a month that is over: after a whole month off it recaps the one that just closed', async () => {
    const { h, scheduler } = await september({ moveTo: '2026-10-20T09:00:00Z' });
    // The server was off from the 1st of October to the 1st of November.
    h.clock.set('2026-11-01T09:00:00Z');
    await scheduler.tick();
    expect(h.texts()).toHaveLength(1);
    expect(h.texts()[0]).toMatch(/^📅 October 2026 is closed\n/);
    expect(h.log()).toEqual(['recap 2026-10']);
  });

  it('sends a recap for each month that closes, one a month', async () => {
    const { h, scheduler } = await september();
    await scheduler.tick();
    h.clock.set('2026-11-01T09:00:00Z');
    await scheduler.tick();
    h.clock.set('2026-12-01T09:00:00Z');
    await scheduler.tick();
    expect(h.texts().map((text) => text.split('\n')[0])).toEqual([
      '📅 September 2026 is closed',
      '📅 October 2026 is closed',
      '📅 November 2026 is closed',
    ]);
    expect(h.log()).toEqual(['recap 2026-09', 'recap 2026-10', 'recap 2026-11']);
  });

  it('is sent after a failed send at the next tick, and never lost', async () => {
    const { h, scheduler } = await september();
    h.failSends(1);
    await scheduler.tick();
    expect(h.texts()).toEqual([]);
    expect(h.log()).toEqual([]);
    await scheduler.tick();
    expect(h.texts()).toEqual([SEPTEMBER_RECAP]);
    expect(h.log()).toEqual(['recap 2026-09']);
  });
});

describe('when it is not sent', () => {
  it('is not sent for a month that began before the account was linked', async () => {
    // Linked on 10 October: October began before that, so there is no recap of September, on the
    // 10th or any day of October ...
    const { h, scheduler } = await september({
      linkedAt: '2026-10-10T08:00:00.000Z',
      moveTo: '2026-10-10T09:00:00Z',
    });
    for (const day of ['2026-10-10T09:30:00Z', '2026-10-11T09:00:00Z', '2026-10-31T23:59:00Z']) {
      h.clock.set(day);
      await scheduler.tick();
    }
    expect(h.fake.attempts).toEqual([]);
    // ... but on 1 November the account was linked before November began, so October is recapped.
    h.clock.set('2026-11-01T09:00:00Z');
    await scheduler.tick();
    expect(h.texts()).toHaveLength(1);
    expect(h.texts()[0]).toMatch(/^📅 October 2026 is closed\n/);
  });

  it('is sent when the account was linked on the last day before the month began', async () => {
    const { h, scheduler } = await september({ linkedAt: '2026-09-30T23:59:59.999Z' });
    await scheduler.tick();
    expect(h.texts()).toEqual([SEPTEMBER_RECAP]);
  });

  it('is not sent when the account was linked at the very instant the month began', async () => {
    const { h, scheduler } = await september({ linkedAt: '2026-10-01T00:00:00.000Z' });
    await scheduler.tick();
    expect(h.fake.attempts).toEqual([]);
  });

  it('measures "before the month began" in the time zone of the server', async () => {
    // 22:30 UTC on 30 September is already 1 October in Rome (UTC+2 until 25 October): linked after
    // October began there, so no recap of September.
    const { h, scheduler } = await september({ linkedAt: '2026-09-30T22:30:00.000Z' });
    await withTimeZone('Europe/Rome', async () => {
      h.clock.set('2026-10-01T09:00:00Z');
      await scheduler.tick();
    });
    expect(h.fake.attempts).toEqual([]);
  });

  it('starts again when another account is linked: its own link time counts', async () => {
    const { h, scheduler } = await september();
    // Another account links on 5 October, replacing the first. The first one was linked before the
    // 1st, but the link now is the new one, made after October began.
    linkTelegramAccount(h.db, { id: 777, first_name: 'Other' }, '2026-10-05T08:00:00.000Z');
    h.clock.set('2026-10-05T09:00:00Z');
    await scheduler.tick();
    expect(h.fake.attempts).toEqual([]);
  });

  it('is not sent for a month before the start month', async () => {
    const h = createNotifyHarness({ now: '2026-10-01T09:00:00Z', linkedAt: LINKED });
    open.push(h);
    await onboard(h.setup, { startMonth: '2026-10', salary: 100000, openingSavings: 0 });
    await h.startScheduler().tick(); // September is before the start month
    expect(h.fake.attempts).toEqual([]);

    h.clock.set('2026-11-01T09:00:00Z'); // October is the first month tracked
    await h.startScheduler().tick();
    expect(h.texts()).toHaveLength(1);
    expect(h.texts()[0]).toMatch(/^📅 October 2026 is closed\n/);
  });

  it('is not sent when the recap is switched off, and goes out on a later day once it is switched on', async () => {
    const { h, scheduler } = await september();
    h.savePrefs({ monthlyRecap: false });
    await scheduler.tick();
    expect(h.fake.attempts).toEqual([]);
    expect(h.log()).toEqual([]);

    h.clock.set('2026-10-09T09:00:00Z');
    h.savePrefs({ monthlyRecap: true });
    await scheduler.tick();
    expect(h.texts()).toEqual([SEPTEMBER_RECAP]);
  });

  it('is not sent while no account is linked', async () => {
    const { h, scheduler } = await september({ linkedAt: null });
    await scheduler.tick();
    expect(h.fake.attempts).toEqual([]);
  });

  it('is not sent while the bot is not running, and goes out once it does', async () => {
    const { h, scheduler } = await september({ status: { connection: 'connecting' } });
    await scheduler.tick();
    expect(h.fake.attempts).toEqual([]);
    expect(h.log()).toEqual([]);

    h.fake.setStatus({ connection: 'running' });
    await scheduler.tick();
    expect(h.texts()).toEqual([SEPTEMBER_RECAP]);
  });
});
