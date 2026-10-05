/**
 * Quick entry (docs/DOMAIN.md, "Quick entry"): a message that reads as an amount, with no flow
 * waiting for text, asks for the budget (the suggested one first, with a star), and one tap saves
 * the spending dated TODAY by the clock at the moment of the tap.
 */
import type { BudgetCreateInput, SpendingsPage } from '@wallet/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { telegramEntries } from '../../db/schema';
import { addSpending } from '../../testing/helpers';
import { type RecordingHarness, createRecordingHarness } from '../../testing/telegram-flow-helpers';
import { UNKNOWN_INPUT_TEXT } from './telegram.messages';

const spendingsOf = async (h: RecordingHarness) =>
  ((await request(h.app).get('/api/spendings').expect(200)).body as SpendingsPage).items;

const labels = (h: RecordingHarness) => h.screen().rows.map((row) => row.map((b) => b.text));

describe('quick entry', () => {
  it('asks which budget, and one tap saves the spending dated today', async () => {
    const h = await createRecordingHarness();
    await h.say('4,50 coffee');
    expect(h.screen().text).toBe('€4.50 · coffee. Which budget?');
    expect(labels(h)).toEqual([
      ['🛒 Groceries · €300.00', '🍝 Eating out · €200.00'],
      ['⛽ Fuel · €1,000.00'],
      ['✖ Cancel'],
    ]);
    expect(await spendingsOf(h)).toEqual([]); // nothing is stored before the tap

    await h.tapButton(/Eating out/);
    expect(h.screen().text).toBe(
      '✅ €4.50 · Eating out · coffee · Mon 5 Oct\nEating out: €195.50 left of €200.00 (2% used)',
    );
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['↩ Undo', '📅 Change date']);
    const [row, ...rest] = await spendingsOf(h);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      date: '2026-10-05',
      amount: 450,
      budgetId: h.budget('Eating out').id,
      description: 'coffee',
    });
  });

  it('starts from a bare amount too, with no note, and from a refund', async () => {
    const h = await createRecordingHarness();
    await h.say('12.50');
    expect(h.screen().text).toBe('€12.50. Which budget?');
    await h.say('-5 returned jar');
    expect(h.screen().text).toBe('↩ Refund €5.00 · returned jar. Which budget?');
    await h.tapButton(/Groceries/);
    expect(h.screen().text).toBe(
      '↩ Refund €5.00 · Groceries · returned jar · Mon 5 Oct\nGroceries: €305.00 left of €300.00 (0% used)',
    );
    expect((await spendingsOf(h))[0]?.amount).toBe(-500);
  });

  it('escapes the note in the prompt and in the confirmation', async () => {
    const h = await createRecordingHarness();
    await h.say('3 <b>&');
    expect(h.screen().text).toBe('€3.00 · &lt;b&gt;&amp;. Which budget?');
    await h.tapButton(/Groceries/);
    expect(h.screen().text).toContain('€3.00 · Groceries · &lt;b&gt;&amp; · Mon 5 Oct');
  });

  it.each([
    '0 coffee',
    'coffee 4',
    'hello',
    '4,5,6 coffee',
    '12.345',
    '€',
    '1 234,50',
    '10000000000.01 x',
  ])('does not start on %j: the pointer to /help', async (text) => {
    const h = await createRecordingHarness();
    await h.say(text);
    expect(h.fake.sentTexts()).toEqual([UNKNOWN_INPUT_TEXT]);
    expect(h.screen().rows).toEqual([]);
  });

  it('does not start on a note over 200 characters', async () => {
    const h = await createRecordingHarness();
    await h.say(`5 ${'x'.repeat(201)}`);
    expect(h.fake.sentTexts()).toEqual([UNKNOWN_INPUT_TEXT]);
  });

  it('Cancel ends it and stores nothing', async () => {
    const h = await createRecordingHarness();
    await h.say('4 coffee');
    await h.tapButton('✖ Cancel');
    expect(h.screen().text).toBe('Cancelled.');
    expect(await spendingsOf(h)).toEqual([]);
  });

  it('answers "No active budgets this month" when there is none', async () => {
    const h = await createRecordingHarness({ budgets: [] });
    await h.say('4 coffee');
    expect(h.screen().text).toBe('No active budgets this month. Add one in the app.');
  });

  it('records the entry, and tells the alert watcher what the confirmation showed', async () => {
    const h = await createRecordingHarness();
    await h.say('190 dinner');
    await h.tapButton(/Eating out/);
    expect(h.screen().text).toContain(
      '⚠️ Eating out: €10.00 left of €200.00 (95% used, warning at 80%)',
    );
    expect(h.notify.markNotified).toHaveBeenCalledWith({
      month: '2026-10',
      budgetId: h.budget('Eating out').id,
      level: 'warning',
    });
    expect(h.notify.scheduleBudgetAlertCheck).toHaveBeenCalledTimes(1);
    const [row] = await spendingsOf(h);
    expect(h.db.select().from(telegramEntries).all()).toMatchObject([{ spendingId: row?.id }]);
  });
});

describe('quick entry: the suggested budget', () => {
  /** Eating out: 2 coffees; Groceries: 1 coffee. */
  async function withHistory(h: RecordingHarness) {
    const eating = h.budget('Eating out').id;
    const groceries = h.budget('Groceries').id;
    await addSpending(h.app, { budgetId: eating, description: 'Coffee', date: '2026-09-02' });
    await addSpending(h.app, { budgetId: eating, description: 'coffee', date: '2026-09-09' });
    await addSpending(h.app, { budgetId: groceries, description: 'coffee', date: '2026-09-12' });
  }

  it('puts the budget most used for that description first, marked with a star', async () => {
    const h = await createRecordingHarness();
    await withHistory(h);
    await h.say('4,50 coffee');
    expect(labels(h)).toEqual([
      ['⭐ 🍝 Eating out · €200.00', '🛒 Groceries · €300.00'],
      ['⛽ Fuel · €1,000.00'],
      ['✖ Cancel'],
    ]);
  });

  it('matches the description ignoring case, spacing and notes of other texts', async () => {
    const h = await createRecordingHarness();
    await withHistory(h);
    await h.say('4,50   COFFEE ');
    expect(labels(h)[0]?.[0]).toBe('⭐ 🍝 Eating out · €200.00');
    await h.say('4,50 coffee shop'); // a different description: no suggestion
    expect(labels(h)[0]).toEqual(['🛒 Groceries · €300.00', '🍝 Eating out · €200.00']);
  });

  it('keeps the usual order with no note, with an unknown note, and when the suggestion is not active', async () => {
    const h = await createRecordingHarness();
    await withHistory(h);
    const usual = [
      ['🛒 Groceries · €300.00', '🍝 Eating out · €200.00'],
      ['⛽ Fuel · €1,000.00'],
      ['✖ Cancel'],
    ];
    await h.say('4,50');
    expect(labels(h)).toEqual(usual);
    await h.say('4,50 something new');
    expect(labels(h)).toEqual(usual);

    // Eating out ends last month: it is not active now, so it is neither listed nor suggested.
    await request(h.app)
      .post(`/api/budgets/${h.budget('Eating out').id}/archive`)
      .send({ endMonth: '2026-09' })
      .expect(200);
    await h.say('4,50 coffee');
    expect(labels(h)).toEqual([['🛒 Groceries · €300.00', '⛽ Fuel · €1,000.00'], ['✖ Cancel']]);
  });

  it('is the imports rule: ties go to the most recent use, and a spending of another description is nobody’s evidence', async () => {
    const h = await createRecordingHarness();
    await addSpending(h.app, {
      budgetId: h.budget('Fuel').id,
      description: 'Shell',
      date: '2026-09-01',
    });
    await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      description: 'Shell',
      date: '2026-09-20',
    });
    await h.say('40 shell');
    expect(labels(h)[0]?.[0]).toBe('⭐ 🛒 Groceries · €300.00');
  });

  it('saves into the suggested budget with one tap', async () => {
    const h = await createRecordingHarness();
    await withHistory(h);
    await h.say('4,50 coffee');
    await h.tapButton(/⭐/);
    expect((await spendingsOf(h))[0]).toMatchObject({
      budgetId: h.budget('Eating out').id,
      amount: 450,
      description: 'coffee',
      date: '2026-10-05',
    });
  });
});

describe('quick entry: dated by the clock at the tap', () => {
  it('saves the day of the tap, not the day of the message (midnight between the two)', async () => {
    const h = await createRecordingHarness({ now: '2026-10-05T23:58:00Z' });
    await h.say('4 late coffee');
    h.clock.set('2026-10-06T00:02:00Z');
    await h.tapButton(/Groceries/);
    expect((await spendingsOf(h))[0]?.date).toBe('2026-10-06');
    expect(h.screen().text).toContain('Tue 6 Oct');
  });

  it('follows the clock across a month end: a tap after midnight on the 1st saves in the new month', async () => {
    const h = await createRecordingHarness({ now: '2026-10-31T23:59:30Z' });
    await h.say('4 late coffee');
    h.clock.set('2026-11-01T00:00:30Z');
    await h.tapButton(/Groceries/);
    expect((await spendingsOf(h))[0]?.date).toBe('2026-11-01');
    // November's figure, not October's: the budget line of the month of the spending.
    expect(h.screen().text).toContain('Groceries: €296.00 left of €300.00');
  });

  it('is fixed by Change date, which is one tap away', async () => {
    const h = await createRecordingHarness();
    await h.say('4 coffee');
    await h.tapButton(/Groceries/);
    await h.tapButton('📅 Change date');
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['Today', 'Yesterday', 'Sat 3', 'Fri 2', 'Thu 1', 'Wed 30', 'Tue 29', '‹ Back']);
  });
});

describe('quick entry: when the budget cannot take the spending any more', () => {
  it('a budget that ended with the month goes back to the list, for the new month', async () => {
    const h = await createRecordingHarness({ now: '2026-10-31T23:58:00Z' });
    await h.say('4 coffee');
    await request(h.app)
      .post(`/api/budgets/${h.budget('Eating out').id}/archive`)
      .send({ endMonth: '2026-10' })
      .expect(200);
    h.clock.set('2026-11-01T00:02:00Z');
    await h.tapButton(/Eating out/);
    expect(h.screen().text).toBe(
      'That budget is no longer available. Pick another one.\n\n€4.00 · coffee. Which budget?',
    );
    expect(labels(h)).toEqual([
      ['🛒 Groceries · €300.00', '⛽ Fuel · €1,100.00'], // November: October's 100.00 carried in
      ['✖ Cancel'],
    ]);
    expect(await spendingsOf(h)).toEqual([]);
    await h.tapButton(/Groceries/);
    expect((await spendingsOf(h))[0]).toMatchObject({ date: '2026-11-01', description: 'coffee' });
  });

  it('a budget deleted since the list was shown goes back to the list', async () => {
    const h = await createRecordingHarness();
    await h.say('4 coffee');
    await request(h.app)
      .delete(`/api/budgets/${h.budget('Fuel').id}`)
      .expect(204);
    await h.tapButton(/Fuel/);
    expect(h.screen().text).toContain('That budget is no longer available.');
    expect(await spendingsOf(h)).toEqual([]);
  });
});

describe('quick entry: many budgets', () => {
  const many = (count: number): Partial<BudgetCreateInput>[] =>
    Array.from({ length: count }, (_unused, index) => ({
      name: `Budget ${String(index + 1).padStart(3, '0')}`,
      amount: 1000 + index,
      incremental: false,
      startMonth: '2026-10',
    }));

  it('lists 40 budgets two per row, in the order of the month view, with Cancel last', async () => {
    const h = await createRecordingHarness({ budgets: many(40) });
    await h.say('4 coffee');
    const rows = h.screen().rows;
    expect(rows).toHaveLength(21);
    expect(rows.slice(0, 20).every((row) => row.length === 2)).toBe(true);
    expect(rows[0]?.[0]?.text).toBe('Budget 001 · €10.00');
    expect(rows[19]?.[1]?.text).toBe('Budget 040 · €10.39');
    expect(rows[20]?.map((b) => b.text)).toEqual(['✖ Cancel']);
  });

  it('keeps to Telegram’s 100 buttons: 99 budgets and Cancel', async () => {
    const h = await createRecordingHarness({ budgets: many(120) });
    await h.say('4 coffee');
    const buttons = h.screen().rows.flat();
    expect(buttons).toHaveLength(100);
    expect(buttons.at(-1)?.text).toBe('✖ Cancel');
    expect(buttons[98]?.text).toBe('Budget 099 · €10.98');
    expect(Math.max(...h.screen().rows.map((row) => row.length))).toBeLessThanOrEqual(8);
  }, 60_000);

  it('still puts the suggested budget first, even when it is beyond the cut', async () => {
    const h = await createRecordingHarness({ budgets: many(120) });
    await addSpending(h.app, {
      budgetId: h.budget('Budget 120').id,
      description: 'rent',
      amount: 100,
      date: '2026-10-01',
    });
    await h.say('4 rent');
    expect(h.screen().rows[0]?.[0]?.text).toBe('⭐ Budget 120 · €10.19');
    expect(h.screen().rows.flat()).toHaveLength(100);
  }, 60_000);

  it('cuts every name on its button to 24 characters, and keeps every id in the callback data', async () => {
    const long = 'A very long budget name that goes on and on';
    const h = await createRecordingHarness({
      budgets: [{ name: long, amount: 5000, incremental: false, startMonth: '2026-10' }],
    });
    await h.say('4 coffee');
    const [button] = h.screen().rows.flat();
    expect(button?.text).toBe('A very long budget name… · €50.00');
    await h.tap(button?.data ?? '');
    expect(h.screen().text).toContain(`€4.00 · ${long} · coffee`);
  });
});
