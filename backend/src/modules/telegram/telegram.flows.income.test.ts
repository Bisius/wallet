/**
 * `/income` (docs/DOMAIN.md, "The `/income` command"): amount (positive only), description
 * (required), date with the same buttons and the same closed-month confirmation, then `createIncome`.
 */
import { type IncomeDto, parseCents } from '@wallet/shared';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { telegramEntries } from '../../db/schema';
import { type RecordingHarness, createRecordingHarness } from '../../testing/telegram-flow-helpers';

const incomesOf = async (h: RecordingHarness) =>
  (await request(h.app).get('/api/incomes').expect(200)).body as IncomeDto[];

describe('/income', () => {
  it('goes amount, description, date, and stores the income through the service', async () => {
    const h = await createRecordingHarness();
    await h.say('/income');
    expect(h.screen().text).toBe(
      'How much was the income? You can add a description after the amount, like 200 Bonus',
    );
    await h.say('200');
    expect(h.screen().text).toBe('Income €200.00\nWhat was it? A description, like Bonus');
    expect(h.screen().rows).toEqual([]); // required: there is no Skip
    await h.say('Bonus');
    expect(h.screen().text).toBe('Income €200.00 · Bonus\nWhen?');
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['Today', 'Yesterday', 'Earlier…']);
    expect(await incomesOf(h)).toEqual([]);

    await h.tapButton('Today');
    expect(h.screen().text).toBe(
      '✅ Income €200.00 · Bonus · Mon 5 Oct\nOctober: income €3,200.00 · Unallocated €2,600.00',
    );
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['↩ Undo', '📅 Change date']);
    expect(await incomesOf(h)).toMatchObject([
      { date: '2026-10-05', amount: 20000, description: 'Bonus' },
    ]);
  });

  it('takes the text after the amount as the description and skips that step', async () => {
    const h = await createRecordingHarness();
    await h.say('/income');
    await h.say('€200,50 Tax refund');
    expect(h.screen().text).toBe('Income €200.50 · Tax refund\nWhen?');
    await h.tapButton('Yesterday');
    expect(h.screen().text).toContain('✅ Income €200.50 · Tax refund · Sun 4 Oct');
    expect(await incomesOf(h)).toMatchObject([{ date: '2026-10-04', amount: 20050 }]);
  });

  it.each([
    ['-5 refund', 'An income is a positive amount. Try 200 Bonus.'],
    ['0 nothing', "The amount can't be 0. Try 200 Bonus."],
    ['hello', "I couldn't read an amount there. Try 200 or 200 Bonus."],
    ['10000000000.01 x', 'That amount is too large: the most is €10,000,000,000.00.'],
    [`5 ${'x'.repeat(201)}`, 'That description is too long: 200 characters at most.'],
  ])('re-prompts %j', async (text, reply) => {
    const h = await createRecordingHarness();
    await h.say('/income');
    await h.say(text);
    expect(h.screen().text).toBe(reply);
    expect(await incomesOf(h)).toEqual([]);
    await h.say('5 ok'); // still waiting for the amount
    expect(h.screen().text).toBe('Income €5.00 · ok\nWhen?');
  });

  it('requires a description of 1 to 200 characters, and never cuts it', async () => {
    const h = await createRecordingHarness();
    await h.say('/income');
    await h.say('50');
    await h.say('x'.repeat(201));
    expect(h.screen().text).toBe('That description is too long: 200 characters at most.');
    await h.say('x'.repeat(200));
    expect(h.screen().text).toBe(`Income €50.00 · ${'x'.repeat(200)}\nWhen?`);
    await h.tapButton('Today');
    expect((await incomesOf(h))[0]?.description).toHaveLength(200);
  });

  it('treats the word Skip as a description, not as a button', async () => {
    const h = await createRecordingHarness();
    await h.say('/income');
    await h.say('50');
    await h.say('Skip');
    expect(h.screen().text).toBe('Income €50.00 · Skip\nWhen?');
  });

  it('escapes the description, and stores it as typed', async () => {
    const h = await createRecordingHarness();
    await h.say('/income');
    await h.say('50 <b>Gift</b> & co');
    expect(h.screen().text).toBe('Income €50.00 · &lt;b&gt;Gift&lt;/b&gt; &amp; co\nWhen?');
    await h.tapButton('Today');
    expect(h.screen().text).toContain(
      '✅ Income €50.00 · &lt;b&gt;Gift&lt;/b&gt; &amp; co · Mon 5 Oct',
    );
    expect((await incomesOf(h))[0]?.description).toBe('<b>Gift</b> & co');
  });

  it('prints the income and the unallocated of the month view, to the cent, read after the write', async () => {
    const h = await createRecordingHarness();
    await h.say('/income');
    await h.say('123,45 Gift');
    await h.tapButton('Today');
    const view = await h.monthView('2026-10');
    const money = [...h.screen().text.matchAll(/€([\d,]+\.\d{2})/g)].map((m) =>
      parseCents((m[1] ?? '').replace(/,/g, '')),
    );
    expect(money).toEqual([12345, view.income.total, view.unallocated]);
    expect(view.income.extra).toBe(12345);
  });

  it('marks an over-allocated month with the warning sign', async () => {
    const h = await createRecordingHarness({ salary: 10000 }); // 100.00 a month, 600.00 allocated
    await h.say('/income');
    await h.say('200 Gift');
    await h.tapButton('Today');
    expect(h.screen().text).toBe(
      '✅ Income €200.00 · Gift · Mon 5 Oct\nOctober: income €300.00 · ⚠️ Unallocated -€300.00',
    );
    expect((await h.monthView('2026-10')).overAllocated).toBe(true);
  });

  it('records the entry for /undo, and asks for an alert check without a budget level', async () => {
    const h = await createRecordingHarness();
    await h.say('/income');
    await h.say('10 x');
    await h.tapButton('Today');
    const [income] = await incomesOf(h);
    expect(h.db.select().from(telegramEntries).all()).toMatchObject([
      { incomeId: income?.id, spendingId: null },
    ]);
    expect(h.notify.markNotified).not.toHaveBeenCalled(); // an income shows no budget level
    expect(h.notify.scheduleBudgetAlertCheck).toHaveBeenCalledTimes(1);
  });
});

describe('/income: the date step', () => {
  it('saves the date of the button, even tapped after midnight', async () => {
    const h = await createRecordingHarness({ now: '2026-10-05T23:59:00Z' });
    await h.say('/income');
    await h.say('10 x');
    h.clock.set('2026-10-06T00:01:00Z');
    await h.tapButton('Today');
    expect((await incomesOf(h))[0]?.date).toBe('2026-10-05');
  });

  it('asks before an income in a closed month, and Save stores it', async () => {
    const h = await createRecordingHarness();
    await h.say('/income');
    await h.say('100 Back pay');
    await h.tapButton('Earlier…');
    await h.tapButton('Wed 30');
    expect(h.screen().text).toBe(
      'Income €100.00 · Back pay · Wed 30 Sept\n' +
        'September is closed. Adding this changes what is due to savings for September.',
    );
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['Save', 'Other date']);
    expect(await incomesOf(h)).toEqual([]);

    await h.tapButton('Save');
    expect(h.screen().text).toBe(
      '✅ Income €100.00 · Back pay · Wed 30 Sept\nSeptember (closed): income €3,100.00 · Unallocated €2,500.00',
    );
    expect((await incomesOf(h))[0]?.date).toBe('2026-09-30');
  });

  it('Other date goes back to the date step', async () => {
    const h = await createRecordingHarness();
    await h.say('/income');
    await h.say('100 Back pay');
    await h.tapButton('Earlier…');
    await h.tapButton('Wed 30');
    await h.tapButton('Other date');
    expect(h.screen().text).toBe('Income €100.00 · Back pay\nWhen?');
    expect(await incomesOf(h)).toEqual([]);
  });

  it('before_start_month goes back to the date step with a sentence', async () => {
    const h = await createRecordingHarness();
    await h.say('/income');
    await h.say('100 Back pay');
    await h.tapButton('Earlier…');
    await h.tapButton('Wed 30');
    h.db.run(sql`update settings set start_month = '2026-10'`);
    await h.tapButton('Save');
    expect(h.screen().text).toBe(
      'That date is before the first month Wallet tracks (October 2026). Pick another date.\n\n' +
        'Income €100.00 · Back pay\nWhen?',
    );
    await h.tapButton('Today');
    expect(await incomesOf(h)).toMatchObject([{ date: '2026-10-05' }]);
  });
});
