/**
 * The buttons under a confirmation, which act on the STORED row (docs/DOMAIN.md, "The confirmation"):
 * Undo and Change date for a spending and an income, the closed-month confirmations, and what they do
 * when the row was edited or deleted on the web since, or the server restarted.
 */
import type { IncomeDto, SpendingsPage } from '@wallet/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { telegramEntries } from '../../db/schema';
import { FakeBotApi, callbackUpdate } from '../../testing/fake-bot-api';
import { addIncome, addSpending } from '../../testing/helpers';
import {
  type RecordingHarness,
  createRecordingHarness,
  screenOf,
} from '../../testing/telegram-flow-helpers';
import { TOKEN } from '../../testing/telegram-harness';
import { createTelegramBot } from './telegram.runtime';

const spendingsOf = async (h: RecordingHarness) =>
  ((await request(h.app).get('/api/spendings').expect(200)).body as SpendingsPage).items;
const incomesOf = async (h: RecordingHarness) =>
  (await request(h.app).get('/api/incomes').expect(200)).body as IncomeDto[];

/** `/spending` to the end: a spending of the budget, dated today (or tapped by its label). */
async function record(
  h: RecordingHarness,
  budget: RegExp,
  text: string,
  day: string | RegExp = 'Today',
) {
  await h.say('/spending');
  await h.tapButton(budget);
  await h.say(text);
  if (!h.screen().text.includes('When?')) await h.tapButton('Skip');
  await h.tapButton(day);
}

const buttonTexts = (h: RecordingHarness) =>
  h
    .screen()
    .rows.flat()
    .map((b) => b.text);

describe('Undo', () => {
  it('deletes the spending and shows "Removed" with the budget’s new figure', async () => {
    const h = await createRecordingHarness();
    await record(h, /Groceries/, '23,40 Lidl');
    await h.tapButton('↩ Undo');
    expect(h.screen().text).toBe(
      '🗑 Removed €23.40 · Groceries · Lidl · Mon 5 Oct\nGroceries: €300.00 left of €300.00 (0% used)',
    );
    expect(h.screen().rows).toEqual([]);
    expect(await spendingsOf(h)).toEqual([]);
    expect(h.db.select().from(telegramEntries).all()).toEqual([]); // the entry went with it
    expect(h.notify.markNotified).toHaveBeenLastCalledWith({
      month: '2026-10',
      budgetId: h.budget('Groceries').id,
      level: 'ok',
    });
    expect(h.notify.scheduleBudgetAlertCheck).toHaveBeenCalledTimes(2); // the write, then the undo
  });

  it('removes exactly one row and leaves the others alone', async () => {
    const h = await createRecordingHarness();
    await record(h, /Groceries/, '1 first');
    await record(h, /Groceries/, '2 second');
    await record(h, /Groceries/, '3 third');
    expect(await spendingsOf(h)).toHaveLength(3);
    await h.tapButton('↩ Undo'); // the screen is the third confirmation
    expect((await spendingsOf(h)).map((s) => s.description)).toEqual(['second', 'first']);
    expect(h.db.select().from(telegramEntries).all()).toHaveLength(2);
  });

  it('answers "Already removed." when it was deleted on the web, and takes the buttons away', async () => {
    const h = await createRecordingHarness();
    await record(h, /Groceries/, '23,40 Lidl');
    const [row] = await spendingsOf(h);
    await request(h.app).delete(`/api/spendings/${row?.id}`).expect(204);
    const mark = h.mark();
    await h.tapButton('↩ Undo');
    expect(h.toast(mark)).toBe('Already removed.');
    expect(h.since(mark).some((c) => c.method === 'editMessageReplyMarkup')).toBe(true);
    expect(h.since(mark).some((c) => c.method === 'deleteMessage')).toBe(false);
  });

  it('answers "Already removed." on a second tap', async () => {
    const h = await createRecordingHarness();
    await record(h, /Groceries/, '5 a');
    const undo = h.screen().rows.flat()[0];
    await h.tap(undo?.data ?? '');
    const mark = h.mark();
    await h.tap(undo?.data ?? '');
    expect(h.toast(mark)).toBe('Already removed.');
  });

  it('deletes the spending as it is NOW when it was edited on the web, and shows its current values', async () => {
    const h = await createRecordingHarness();
    await record(h, /Groceries/, '23,40 Lidl');
    const [row] = await spendingsOf(h);
    await request(h.app)
      .patch(`/api/spendings/${row?.id}`)
      .send({
        amount: 5000,
        description: 'Edited on the web',
        budgetId: h.budget('Eating out').id,
        date: '2026-10-02',
      })
      .expect(200);
    await h.tapButton('↩ Undo');
    expect(h.screen().text).toBe(
      '🗑 Removed €50.00 · Eating out · Edited on the web · Fri 2 Oct\nEating out: €200.00 left of €200.00 (0% used)',
    );
    expect(await spendingsOf(h)).toEqual([]);
  });

  it('works for an income, and shows the month’s new income and unallocated', async () => {
    const h = await createRecordingHarness();
    await h.say('/income');
    await h.say('200 Bonus');
    await h.tapButton('Today');
    await h.tapButton('↩ Undo');
    expect(h.screen().text).toBe(
      '🗑 Removed Income €200.00 · Bonus · Mon 5 Oct\nOctober: income €3,000.00 · Unallocated €2,400.00',
    );
    expect(await incomesOf(h)).toEqual([]);
  });

  it('says "Already removed." for an income deleted on the web', async () => {
    const h = await createRecordingHarness();
    await h.say('/income');
    await h.say('200 Bonus');
    await h.tapButton('Today');
    const [income] = await incomesOf(h);
    await request(h.app).delete(`/api/incomes/${income?.id}`).expect(204);
    const mark = h.mark();
    await h.tapButton('↩ Undo');
    expect(h.toast(mark)).toBe('Already removed.');
  });

  it('asks first in a closed month, naming it, and Keep gives the confirmation back', async () => {
    const h = await createRecordingHarness();
    await record(h, /Groceries/, '40 receipt', 'Earlier…');
    // (the flow asked for Earlier…: pick September 30, confirm)
    await h.tapButton('Wed 30');
    await h.tapButton('Save');
    expect(h.screen().text).toContain('Groceries in September (closed)');

    await h.tapButton('↩ Undo');
    expect(h.screen().text).toBe(
      '€40.00 · Groceries · receipt · Wed 30 Sept\n' +
        'September is closed. Removing this changes what is due to savings for September.',
    );
    expect(buttonTexts(h)).toEqual(['Remove', 'Keep']);
    expect(await spendingsOf(h)).toHaveLength(1);

    await h.tapButton('Keep');
    expect(h.screen().text).toBe(
      '✅ €40.00 · Groceries · receipt · Wed 30 Sept\n' +
        'Groceries in September (closed): €260.00 left of €300.00 (13% used)',
    );
    expect(buttonTexts(h)).toEqual(['↩ Undo', '📅 Change date']);
    expect(await spendingsOf(h)).toHaveLength(1);

    await h.tapButton('↩ Undo');
    await h.tapButton('Remove');
    expect(h.screen().text).toBe(
      '🗑 Removed €40.00 · Groceries · receipt · Wed 30 Sept\n' +
        'Groceries in September (closed): €300.00 left of €300.00 (0% used)',
    );
    expect(await spendingsOf(h)).toEqual([]);
  });

  it('asks first in a closed month for an income too', async () => {
    const h = await createRecordingHarness();
    await h.say('/income');
    await h.say('100 Back pay');
    await h.tapButton('Earlier…');
    await h.tapButton('Wed 30');
    await h.tapButton('Save');
    await h.tapButton('↩ Undo');
    expect(h.screen().text).toBe(
      'Income €100.00 · Back pay · Wed 30 Sept\n' +
        'September is closed. Removing this changes what is due to savings for September.',
    );
    await h.tapButton('Remove');
    expect(h.screen().text).toContain('🗑 Removed Income €100.00 · Back pay · Wed 30 Sept');
    expect(await incomesOf(h)).toEqual([]);
  });

  it('still removes a refund, and says what it was', async () => {
    const h = await createRecordingHarness();
    await record(h, /Groceries/, '-5 returned');
    await h.tapButton('↩ Undo');
    expect(h.screen().text).toBe(
      '🗑 Removed ↩ Refund €5.00 · Groceries · returned · Mon 5 Oct\nGroceries: €300.00 left of €300.00 (0% used)',
    );
  });
});

describe('Change date', () => {
  it('offers the last 7 days in one keyboard, with Back, and Back gives the confirmation its buttons', async () => {
    const h = await createRecordingHarness();
    await record(h, /Groceries/, '23,40 Lidl');
    const confirmation = h.screen().text;
    await h.tapButton('📅 Change date');
    expect(buttonTexts(h)).toEqual([
      'Today',
      'Yesterday',
      'Sat 3',
      'Fri 2',
      'Thu 1',
      'Wed 30',
      'Tue 29',
      '‹ Back',
    ]);
    expect(h.screen().rows.map((row) => row.length)).toEqual([3, 3, 2]);
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.data.split(':').slice(4).join(':')),
    ).toEqual([
      '2026-10-05',
      '2026-10-04',
      '2026-10-03',
      '2026-10-02',
      '2026-10-01',
      '2026-09-30',
      '2026-09-29',
      '',
    ]);
    await h.tapButton('‹ Back');
    expect(h.screen().text).toBe(confirmation);
    expect(buttonTexts(h)).toEqual(['↩ Undo', '📅 Change date']);
  });

  it('moves the spending with updateSpending and rewrites the confirmation with the new figures', async () => {
    const h = await createRecordingHarness();
    await record(h, /Groceries/, '23,40 Lidl');
    await h.tapButton('📅 Change date');
    await h.tapButton('Fri 2');
    expect(h.screen().text).toBe(
      '✅ €23.40 · Groceries · Lidl · Fri 2 Oct\nGroceries: €276.60 left of €300.00 (7% used)',
    );
    expect(buttonTexts(h)).toEqual(['↩ Undo', '📅 Change date']);
    const [row] = await spendingsOf(h);
    expect(row).toMatchObject({ date: '2026-10-02', amount: 2340, description: 'Lidl' });
    // The message was edited, not sent again.
    expect(h.fake.callsOf('editMessageText').length).toBeGreaterThanOrEqual(2);
    expect(h.notify.markNotified).toHaveBeenLastCalledWith({
      month: '2026-10',
      budgetId: h.budget('Groceries').id,
      level: 'ok',
    });
  });

  it('says it is dated that day already, and changes nothing', async () => {
    const h = await createRecordingHarness();
    await record(h, /Groceries/, '23,40 Lidl');
    await h.tapButton('📅 Change date');
    const mark = h.mark();
    await h.tapButton('Today');
    expect(h.toast(mark)).toBe('It is dated that day already.');
    expect(buttonTexts(h)).toContain('‹ Back');
  });

  it('asks first when the NEW date is in a closed month, and Save moves it', async () => {
    const h = await createRecordingHarness();
    await record(h, /Groceries/, '23,40 Lidl');
    await h.tapButton('📅 Change date');
    await h.tapButton('Wed 30');
    expect(h.screen().text).toBe(
      '€23.40 · Groceries · Lidl · Mon 5 Oct\n' +
        'New date: Wed 30 Sept\n' +
        'September is closed. Moving this changes what is due to savings for September.',
    );
    expect(buttonTexts(h)).toEqual(['Save', 'Other date']);
    expect((await spendingsOf(h))[0]?.date).toBe('2026-10-05'); // not moved yet

    await h.tapButton('Save');
    expect(h.screen().text).toBe(
      '✅ €23.40 · Groceries · Lidl · Wed 30 Sept\n' +
        'Groceries in September (closed): €276.60 left of €300.00 (7% used)',
    );
    expect((await spendingsOf(h))[0]?.date).toBe('2026-09-30');
    // October lost it, September has it: the figures follow the date.
    expect((await h.monthView('2026-10')).budgets[0]?.spent).toBe(0);
    expect((await h.monthView('2026-09')).budgets[0]?.spent).toBe(2340);
  });

  it('asks first when the OLD date is in a closed month (the spending would leave it)', async () => {
    const h = await createRecordingHarness();
    await record(h, /Groceries/, '40 receipt', 'Earlier…');
    await h.tapButton('Wed 30');
    await h.tapButton('Save');
    await h.tapButton('📅 Change date');
    await h.tapButton('Today');
    expect(h.screen().text).toBe(
      '€40.00 · Groceries · receipt · Wed 30 Sept\n' +
        'New date: Mon 5 Oct\n' +
        'September is closed. Moving this changes what is due to savings for September.',
    );
    await h.tapButton('Save');
    expect((await spendingsOf(h))[0]?.date).toBe('2026-10-05');
    expect(h.screen().text).toBe(
      '✅ €40.00 · Groceries · receipt · Mon 5 Oct\nGroceries: €260.00 left of €300.00 (13% used)',
    );
  });

  it('names both months when both the old and the new date are in closed months', async () => {
    const h = await createRecordingHarness({ now: '2026-11-03T10:00:00Z' });
    // A spending dated in September on the web; its buttons are stateless, so a tap can reach it.
    const row = await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      amount: 4000,
      date: '2026-09-15',
      description: 'receipt',
    });
    await h.tap(`c:s:${row.id}:${h.fp('s', row.id)}`);
    await h.tapButton('Sat 31');
    expect(h.screen().text).toBe(
      '€40.00 · Groceries · receipt · Tue 15 Sept\n' +
        'New date: Sat 31 Oct\n' +
        'September and October are closed. Moving this changes what is due to savings for September and October.',
    );
  });

  it('Other date goes back to the days, with the row as it is', async () => {
    const h = await createRecordingHarness();
    await record(h, /Groceries/, '23,40 Lidl');
    await h.tapButton('📅 Change date');
    await h.tapButton('Wed 30');
    await h.tapButton('Other date');
    expect(h.screen().text).toBe(
      '✅ €23.40 · Groceries · Lidl · Mon 5 Oct\nGroceries: €276.60 left of €300.00 (7% used)',
    );
    expect(buttonTexts(h)).toContain('Wed 30');
    expect((await spendingsOf(h))[0]?.date).toBe('2026-10-05');
  });

  it('turns an outside_active_months refusal into a sentence, and the days are offered again', async () => {
    const h = await createRecordingHarness({
      budgets: [
        { name: 'Groceries', amount: 30000, incremental: false, startMonth: '2026-10', icon: '🛒' },
      ],
    });
    await record(h, /Groceries/, '23,40 Lidl');
    await h.tapButton('📅 Change date');
    await h.tapButton('Wed 30');
    await h.tapButton('Save');
    expect(h.screen().text).toBe(
      "Groceries isn't active in September. Pick another date.\n\n" +
        '✅ €23.40 · Groceries · Lidl · Mon 5 Oct\nGroceries: €276.60 left of €300.00 (7% used)',
    );
    expect(buttonTexts(h)).toContain('Wed 30');
    expect((await spendingsOf(h))[0]?.date).toBe('2026-10-05');
    await h.tapButton('Fri 2');
    expect((await spendingsOf(h))[0]?.date).toBe('2026-10-02');
  });

  it('shows the current values and moves the row as it is now when it was edited on the web', async () => {
    const h = await createRecordingHarness();
    await record(h, /Groceries/, '23,40 Lidl');
    const [row] = await spendingsOf(h);
    await request(h.app)
      .patch(`/api/spendings/${row?.id}`)
      .send({ amount: 9900, budgetId: h.budget('Fuel').id })
      .expect(200);
    await h.tapButton('📅 Change date');
    expect(h.screen().text).toContain('✅ €99.00 · Fuel · Lidl · Mon 5 Oct');
    await h.tapButton('Fri 2');
    expect(h.screen().text).toBe(
      '✅ €99.00 · Fuel · Lidl · Fri 2 Oct\nFuel: €901.00 left of €1,000.00 (9% used)',
    );
  });

  it('says "Already removed." when the spending was deleted on the web, at either tap', async () => {
    const h = await createRecordingHarness();
    await record(h, /Groceries/, '23,40 Lidl');
    await h.tapButton('📅 Change date');
    const [row] = await spendingsOf(h);
    const fp = h.fp('s', row?.id ?? 0);
    await request(h.app).delete(`/api/spendings/${row?.id}`).expect(204);
    const mark = h.mark();
    await h.tapButton('Fri 2');
    expect(h.toast(mark)).toBe('Already removed.');
    const mark2 = h.mark();
    await h.tap(`c:s:${row?.id}:${fp}`);
    expect(h.toast(mark2)).toBe('Already removed.');
  });

  it('moves an income, with the same confirmations', async () => {
    const h = await createRecordingHarness();
    await h.say('/income');
    await h.say('200 Bonus');
    await h.tapButton('Today');
    await h.tapButton('📅 Change date');
    await h.tapButton('Fri 2');
    expect(h.screen().text).toBe(
      '✅ Income €200.00 · Bonus · Fri 2 Oct\nOctober: income €3,200.00 · Unallocated €2,600.00',
    );
    expect(await incomesOf(h)).toMatchObject([{ date: '2026-10-02' }]);

    await h.tapButton('📅 Change date');
    await h.tapButton('Wed 30');
    expect(h.screen().text).toBe(
      'Income €200.00 · Bonus · Fri 2 Oct\nNew date: Wed 30 Sept\n' +
        'September is closed. Moving this changes what is due to savings for September.',
    );
    await h.tapButton('Save');
    expect(h.screen().text).toBe(
      '✅ Income €200.00 · Bonus · Wed 30 Sept\nSeptember (closed): income €3,200.00 · Unallocated €2,600.00',
    );
  });

  it('does not offer a day before the start month', async () => {
    const h = await createRecordingHarness({
      now: '2026-01-03T10:00:00Z',
      budgets: [{ name: 'Groceries', amount: 30000, incremental: false, startMonth: '2026-01' }],
    });
    await record(h, /Groceries/, '5 a');
    await h.tapButton('📅 Change date');
    expect(buttonTexts(h)).toEqual(['Today', 'Yesterday', 'Thu 1', '‹ Back']);
  });
});

describe('the buttons act on the stored row, not on a flow', () => {
  it('keep working while another flow is in progress, and after the 15-minute timeout', async () => {
    const h = await createRecordingHarness();
    await record(h, /Groceries/, '23,40 Lidl');
    const undo = h.screen().rows.flat()[0];
    await h.say('/spending'); // a flow is running now
    h.clock.set('2026-10-05T11:00:00Z'); // and an hour has passed
    await h.tap(undo?.data ?? '');
    expect(await spendingsOf(h)).toEqual([]);
    expect(h.screen().text).toContain('🗑 Removed €23.40');
  });

  it('keep working after a restart: a new bot over the same database', async () => {
    const h = await createRecordingHarness();
    await record(h, /Groceries/, '23,40 Lidl');
    const rows = h.screen().rows.flat();
    const undo = rows[0];
    const change = rows[1];

    const fake = new FakeBotApi();
    const restarted = createTelegramBot(h.tg, {
      token: TOKEN,
      botInfo: fake.me,
      transformer: fake.transformer,
    });
    await restarted.handleUpdate(callbackUpdate(change?.data ?? ''));
    expect(
      screenOf(fake.calls)
        .rows.flat()
        .map((b) => b.text),
    ).toContain('Wed 30');
    await restarted.handleUpdate(callbackUpdate(undo?.data ?? ''));
    expect(screenOf(fake.calls).text).toContain('🗑 Removed €23.40');
    expect(await spendingsOf(h)).toEqual([]);
  });

  it('can never act on another row: ids are not reused after a delete', async () => {
    const h = await createRecordingHarness();
    await record(h, /Groceries/, '1 first');
    const undoFirst = h.screen().rows.flat()[0];
    await h.tap(undoFirst?.data ?? '');
    await record(h, /Groceries/, '2 second');
    const mark = h.mark();
    await h.tap(undoFirst?.data ?? ''); // the first confirmation's button, long after
    expect(h.toast(mark)).toBe('Already removed.');
    expect(await spendingsOf(h)).toHaveLength(1);
  });

  it('answers a made-up id with "Already removed." and an unknown row kind as stale', async () => {
    const h = await createRecordingHarness();
    const mark = h.mark();
    await h.tap('u:s:424242:abc');
    expect(h.toast(mark)).toBe('Already removed.');
    await h.tap('u:x:1:abc');
    expect(h.toast()).toBe('This entry expired, start again with /spending');
    // A button of before the fingerprint (no fp) is not ours any more: stale.
    await h.tap('u:s:1');
    expect(h.toast()).toBe('This entry expired, start again with /spending');
  });
});

describe('a spending or an income typed on the web is no business of /undo', () => {
  it('never lists or removes what the bot did not create', async () => {
    const h = await createRecordingHarness();
    await addSpending(h.app, { budgetId: h.budget('Groceries').id });
    await addIncome(h.app);
    await h.say('/undo');
    expect(h.screen().text).toBe('Nothing to undo.');
  });
});
