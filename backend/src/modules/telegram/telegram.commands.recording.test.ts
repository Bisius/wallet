/**
 * `/status`, `/recent` and `/undo` (docs/DOMAIN.md, "The `/status` command" and "The `/recent` and
 * `/undo` commands"), through `bot.handleUpdate()` with a fake Bot API.
 */
import type { BudgetCreateInput, SpendingsPage } from '@wallet/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { telegramEntries } from '../../db/schema';
import { addIncome, addSpending } from '../../testing/helpers';
import { type RecordingHarness, createRecordingHarness } from '../../testing/telegram-flow-helpers';
import { MESSAGE_MAX_CHARS, visibleLength } from './telegram.messages';

const spendingsOf = async (h: RecordingHarness) =>
  ((await request(h.app).get('/api/spendings').expect(200)).body as SpendingsPage).items;

const sentSince = (h: RecordingHarness, from: number) =>
  h.since(from).filter((call) => call.method === 'sendMessage');

describe('/status', () => {
  it('prints one line per active budget and the footer', async () => {
    const h = await createRecordingHarness();
    await h.say('/status');
    expect(h.screen().text).toBe(
      [
        '🛒 Groceries · €300.00 left of €300.00 (0%)',
        '🍝 Eating out · €200.00 left of €200.00 (0%)',
        '⛽ Fuel · €1,000.00 left of €1,000.00 (0%)',
        '',
        '26 days left in October · Unallocated €2,400.00',
      ].join('\n'),
    );
    expect(h.screen().rows).toEqual([]);
  });

  it('marks a warning and an over budget, with "over by", and prints the month view’s figures', async () => {
    const h = await createRecordingHarness();
    await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      amount: 6000,
      date: '2026-10-01',
    });
    await addSpending(h.app, {
      budgetId: h.budget('Eating out').id,
      amount: 17000,
      date: '2026-10-02',
    });
    await addSpending(h.app, { budgetId: h.budget('Fuel').id, amount: 130000, date: '2026-10-03' });
    await h.say('/status');
    const view = await h.monthView('2026-10');
    expect(view.budgets.map((b) => b.alert)).toEqual(['ok', 'warning', 'over']);
    expect(h.screen().text).toBe(
      [
        '🛒 Groceries · €240.00 left of €300.00 (20%)',
        '🍝 Eating out · €30.00 left of €200.00 (85%) ⚠️',
        '⛽ Fuel · over by €300.00 of €1,000.00 (130%) 🔴',
        '',
        '26 days left in October · Unallocated €2,400.00',
      ].join('\n'),
    );
  });

  it('leaves the percentage out when nothing is available, and uses a bullet for a budget with no icon', async () => {
    const h = await createRecordingHarness({
      budgets: [{ name: 'Empty', amount: 0, incremental: false, startMonth: '2026-10' }],
    });
    await h.say('/status');
    expect(h.screen().text).toBe(
      '• Empty · €0.00 left of €0.00\n\n26 days left in October · Unallocated €3,000.00',
    );
    await addSpending(h.app, { budgetId: h.budget('Empty').id, amount: 500, date: '2026-10-02' });
    await h.say('/status');
    expect(h.screen().text).toContain('• Empty · over by €5.00 🔴');
  });

  it('counts the days left in the month from the clock: 26, 1 day, and the last day', async () => {
    const h = await createRecordingHarness();
    h.clock.set('2026-10-30T09:00:00Z');
    await h.say('/status');
    expect(h.screen().text.split('\n').at(-1)).toBe(
      '1 day left in October · Unallocated €2,400.00',
    );
    h.clock.set('2026-10-31T09:00:00Z');
    await h.say('/status');
    expect(h.screen().text.split('\n').at(-1)).toBe('Last day of October · Unallocated €2,400.00');
    h.clock.set('2026-11-01T09:00:00Z');
    await h.say('/status');
    expect(h.screen().text.split('\n').at(-1)).toBe(
      '29 days left in November · Unallocated €2,400.00',
    );
  });

  it('warns when the month is over-allocated', async () => {
    const h = await createRecordingHarness({ salary: 10000 });
    await h.say('/status');
    expect(h.screen().text.split('\n').at(-1)).toBe(
      '26 days left in October · ⚠️ Unallocated -€500.00',
    );
  });

  it('adds the link to the app when APP_URL is set, and none otherwise', async () => {
    const withUrl = await createRecordingHarness({
      appUrl: 'https://wallet.example.ts.net/?a=1&b=2',
    });
    await withUrl.say('/status');
    expect(withUrl.screen().text.split('\n').at(-1)).toBe(
      'Open Wallet: https://wallet.example.ts.net/?a=1&amp;b=2',
    );
    const call = withUrl.fake.callsOf('sendMessage').at(-1);
    expect(call?.payload['link_preview_options']).toEqual({ is_disabled: true });
    const without = await createRecordingHarness();
    await without.say('/status');
    expect(without.screen().text).not.toContain('Open Wallet');
  });

  it('says there is no active budget, and still gives the footer', async () => {
    const h = await createRecordingHarness({ budgets: [] });
    await h.say('/status');
    expect(h.screen().text).toBe(
      'No active budgets this month. Add one in the app.\n\n26 days left in October · Unallocated €3,000.00',
    );
  });

  it('shows only the budgets active this month, and escapes their names', async () => {
    const h = await createRecordingHarness({
      budgets: [
        {
          name: '<b>R&D</b>',
          amount: 10000,
          incremental: false,
          startMonth: '2026-01',
          icon: '🧪',
        },
        { name: 'Ended', amount: 10000, incremental: false, startMonth: '2026-01' },
        { name: 'Later', amount: 10000, incremental: false, startMonth: '2026-11' },
      ],
    });
    await request(h.app)
      .post(`/api/budgets/${h.budget('Ended').id}/archive`)
      .send({ endMonth: '2026-09' })
      .expect(200);
    await h.say('/status');
    expect(h.screen().text).toBe(
      '🧪 &lt;b&gt;R&amp;D&lt;/b&gt; · €100.00 left of €100.00 (0%)\n\n26 days left in October · Unallocated €2,900.00',
    );
  });

  it('splits a long list into messages under Telegram’s limit, with the footer at the end', async () => {
    const budgets: Partial<BudgetCreateInput>[] = Array.from({ length: 70 }, (_unused, index) => ({
      name: `Budget number ${String(index + 1).padStart(2, '0')} with a quite long name indeed`,
      amount: 100000,
      incremental: false,
      startMonth: '2026-10',
      icon: '🧾',
    }));
    const h = await createRecordingHarness({ budgets, salary: 10_000_000 });
    const mark = h.mark();
    await h.say('/status');
    const texts = sentSince(h, mark).map((call) => String(call.payload['text']));
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) expect(visibleLength(text)).toBeLessThanOrEqual(MESSAGE_MAX_CHARS);
    const all = texts.join('\n');
    for (let n = 1; n <= 70; n++)
      expect(all).toContain(`Budget number ${String(n).padStart(2, '0')} `);
    expect(texts.at(-1)).toMatch(/26 days left in October · Unallocated/);
    expect(texts.slice(0, -1).some((t) => t.includes('days left'))).toBe(false);
  }, 60_000);

  it('equals the month view line by line, to the cent', async () => {
    const h = await createRecordingHarness();
    await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      amount: 12345,
      date: '2026-10-01',
    });
    await addIncome(h.app, { amount: 5000, date: '2026-10-02' });
    await h.say('/status');
    const view = await h.monthView('2026-10');
    const lines = h.screen().text.split('\n');
    view.budgets.forEach((line, index) => {
      const cents = [...(lines[index] ?? '').matchAll(/€([\d,]+)\.(\d{2})/g)].map(
        (m) => Number((m[1] ?? '').replace(/,/g, '')) * 100 + Number(m[2]),
      );
      expect(cents).toEqual([line.remaining, line.available]);
      expect(lines[index]).toContain(`(${line.usagePercent}%)`);
    });
    const unallocated = /Unallocated €([\d,]+)\.(\d{2})/.exec(lines.at(-1) ?? '');
    expect(
      Number((unallocated?.[1] ?? '').replace(/,/g, '')) * 100 + Number(unallocated?.[2]),
    ).toBe(view.unallocated);
  });
});

describe('/recent', () => {
  async function tenSpendings(h: RecordingHarness) {
    const ids: number[] = [];
    for (let day = 1; day <= 12; day++) {
      const row = await addSpending(h.app, {
        budgetId: h.budget(day % 2 === 0 ? 'Eating out' : 'Groceries').id,
        amount: 100 * day,
        description: `n${day}`,
        date: `2026-10-${String(day).padStart(2, '0')}`,
      });
      ids.push(row.id);
    }
    return ids;
  }

  it('lists the last 10 spendings from any source, newest first, numbered, with a delete button each', async () => {
    const h = await createRecordingHarness();
    const ids = await tenSpendings(h);
    await h.say('/recent');
    expect(h.screen().text).toBe(
      [
        'Last spendings',
        '1. €12.00 · Eating out · n12 · Mon 12 Oct',
        '2. €11.00 · Groceries · n11 · Sun 11 Oct',
        '3. €10.00 · Eating out · n10 · Sat 10 Oct',
        '4. €9.00 · Groceries · n9 · Fri 9 Oct',
        '5. €8.00 · Eating out · n8 · Thu 8 Oct',
        '6. €7.00 · Groceries · n7 · Wed 7 Oct',
        '7. €6.00 · Eating out · n6 · Tue 6 Oct',
        '8. €5.00 · Groceries · n5 · Mon 5 Oct',
        '9. €4.00 · Eating out · n4 · Sun 4 Oct',
        '10. €3.00 · Groceries · n3 · Sat 3 Oct',
      ].join('\n'),
    );
    expect(h.screen().rows.map((row) => row.map((b) => b.text))).toEqual([
      ['🗑 1', '🗑 2', '🗑 3', '🗑 4', '🗑 5'],
      ['🗑 6', '🗑 7', '🗑 8', '🗑 9', '🗑 10'],
    ]);
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.data),
    ).toEqual(
      ids
        .slice(2)
        .reverse()
        .map((id) => `d:s:${id}:${h.fp('s', id)}`),
    );
  });

  it('lists fewer than 10 as they are, with as many buttons, and a refund as a refund', async () => {
    const h = await createRecordingHarness();
    await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      amount: -500,
      description: 'back',
      date: '2026-10-02',
    });
    await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      amount: 1250,
      description: '',
      date: '2026-10-03',
    });
    await h.say('/recent');
    expect(h.screen().text).toBe(
      'Last spendings\n1. €12.50 · Groceries · Sat 3 Oct\n2. ↩ Refund €5.00 · Groceries · back · Fri 2 Oct',
    );
    expect(h.screen().rows.map((row) => row.map((b) => b.text))).toEqual([['🗑 1', '🗑 2']]);
  });

  it('says so when there is nothing, with no buttons', async () => {
    const h = await createRecordingHarness();
    await h.say('/recent');
    expect(h.screen().text).toBe('No spendings yet.');
    expect(h.screen().rows).toEqual([]);
  });

  it('escapes names and notes in the list', async () => {
    const h = await createRecordingHarness({
      budgets: [{ name: '<i>Fun</i>', amount: 10000, incremental: false, startMonth: '2026-10' }],
    });
    await addSpending(h.app, {
      budgetId: h.budget('<i>Fun</i>').id,
      description: '<b>&',
      amount: 100,
      date: '2026-10-02',
    });
    await h.say('/recent');
    expect(h.screen().text).toContain(
      '€1.00 · &lt;i&gt;Fun&lt;/i&gt; · &lt;b&gt;&amp; · Fri 2 Oct',
    );
  });

  it('stays under Telegram’s limit with ten spendings of the longest notes and names', async () => {
    const h = await createRecordingHarness({
      budgets: [{ name: 'N'.repeat(60), amount: 10000, incremental: false, startMonth: '2026-10' }],
    });
    for (let i = 0; i < 10; i++) {
      await addSpending(h.app, {
        budgetId: h.budget('N'.repeat(60)).id,
        description: '&'.repeat(200),
        amount: 10_000_000_00 + i,
        date: '2026-10-02',
      });
    }
    const mark = h.mark();
    await h.say('/recent');
    expect(sentSince(h, mark)).toHaveLength(1);
    expect(visibleLength(h.screen().text)).toBeLessThanOrEqual(MESSAGE_MAX_CHARS);
  });

  it('asks before deleting, and Delete removes that row and shows the budget’s new figure', async () => {
    const h = await createRecordingHarness();
    await tenSpendings(h);
    await h.say('/recent');
    await h.tapButton('🗑 1');
    expect(h.screen().text).toBe('Delete €12.00 · Eating out · n12 (Mon 12 Oct)?');
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['Delete', 'Keep']);
    expect(await spendingsOf(h)).toHaveLength(12); // asking deletes nothing

    await h.tapButton('Delete');
    // Eating out keeps n2, n4, n6, n8 and n10: 30.00 of 200.00 spent.
    const eating = (await h.monthView('2026-10')).budgets.find((b) => b.name === 'Eating out');
    expect(eating).toMatchObject({ spent: 3000, remaining: 17000, usagePercent: 15 });
    expect(h.screen().text).toBe(
      '🗑 Removed €12.00 · Eating out · n12 · Mon 12 Oct\n' +
        'Eating out: €170.00 left of €200.00 (15% used)',
    );
    expect((await spendingsOf(h)).map((s) => s.description)).not.toContain('n12');
    expect(h.notify.scheduleBudgetAlertCheck).toHaveBeenCalledTimes(1);
  });

  it('Keep changes nothing', async () => {
    const h = await createRecordingHarness();
    await tenSpendings(h);
    await h.say('/recent');
    await h.tapButton('🗑 3');
    await h.tapButton('Keep');
    expect(h.screen().text).toBe('Kept.');
    expect(h.screen().rows).toEqual([]);
    expect(await spendingsOf(h)).toHaveLength(12);
  });

  it('deletes a spending that did not come from Telegram, and says nothing of /undo’s entries', async () => {
    const h = await createRecordingHarness();
    await tenSpendings(h);
    await h.say('/recent');
    await h.tapButton('🗑 2');
    await h.tapButton('Delete');
    expect(await spendingsOf(h)).toHaveLength(11);
    expect(h.db.select().from(telegramEntries).all()).toEqual([]);
  });

  it('answers "Already removed." for a spending deleted since, at either tap', async () => {
    const h = await createRecordingHarness();
    const ids = await tenSpendings(h);
    await h.say('/recent');
    const buttons = h.screen().rows.flat();
    await request(h.app).delete(`/api/spendings/${ids[11]}`).expect(204);
    const mark = h.mark();
    await h.tap(buttons[0]?.data ?? '');
    expect(h.toast(mark)).toBe('Already removed.');
    // Asked, then deleted on the web before the tap on Delete.
    await h.tap(buttons[1]?.data ?? '');
    const confirm = h.screen().rows.flat()[0];
    await request(h.app).delete(`/api/spendings/${ids[10]}`).expect(204);
    const mark2 = h.mark();
    await h.tap(confirm?.data ?? '');
    expect(h.toast(mark2)).toBe('Already removed.');
  });

  it('a list that has gone stale never deletes another row', async () => {
    const h = await createRecordingHarness();
    await tenSpendings(h);
    await h.say('/recent');
    const buttons = h.screen().rows.flat();
    // Five new spendings push everything down the list.
    for (let i = 0; i < 5; i++)
      await addSpending(h.app, {
        budgetId: h.budget('Fuel').id,
        description: `new${i}`,
        date: '2026-10-04',
      });
    await h.tap(buttons[0]?.data ?? ''); // "🗑 1" of the old list is still the spending n12
    expect(h.screen().text).toBe('Delete €12.00 · Eating out · n12 (Mon 12 Oct)?');
    await h.tapButton('Delete');
    const left = (await spendingsOf(h)).map((s) => s.description);
    expect(left).not.toContain('n12');
    expect(left.filter((d) => d.startsWith('new'))).toHaveLength(5);
    expect(left).toHaveLength(16);
  });

  it('names the closed month in the question, and the figure after is that month’s', async () => {
    const h = await createRecordingHarness();
    await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      amount: 4000,
      description: 'old',
      date: '2026-09-15',
    });
    await h.say('/recent');
    await h.tapButton('🗑 1');
    expect(h.screen().text).toBe(
      'Delete €40.00 · Groceries · old (Tue 15 Sept)?\n' +
        'September is closed. Removing this changes what is due to savings for September.',
    );
    await h.tapButton('Delete');
    expect(h.screen().text).toBe(
      '🗑 Removed €40.00 · Groceries · old · Tue 15 Sept\n' +
        'Groceries in September (closed): €300.00 left of €300.00 (0% used)',
    );
  });

  it('writes the year of a month that is not this year’s', async () => {
    const h = await createRecordingHarness({
      startMonth: '2025-01',
      budgets: [{ name: 'Groceries', amount: 30000, incremental: false, startMonth: '2025-01' }],
    });
    await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      amount: 4000,
      description: 'old',
      date: '2025-12-15',
    });
    await h.say('/recent');
    await h.tapButton('🗑 1');
    expect(h.screen().text).toContain(
      'December 2025 is closed. Removing this changes what is due to savings for December 2025.',
    );
  });

  it('works for a spending in a budget that is not active now', async () => {
    const h = await createRecordingHarness();
    await addSpending(h.app, {
      budgetId: h.budget('Eating out').id,
      amount: 4000,
      description: 'old',
      date: '2026-08-15',
    });
    await request(h.app)
      .post(`/api/budgets/${h.budget('Eating out').id}/archive`)
      .send({ endMonth: '2026-08' })
      .expect(200);
    await h.say('/recent');
    expect(h.screen().text).toContain('€40.00 · Eating out · old · Sat 15 Aug');
  });
});

describe('/undo', () => {
  it('says there is nothing to undo when the bot created nothing', async () => {
    const h = await createRecordingHarness();
    await h.say('/undo');
    expect(h.screen().text).toBe('Nothing to undo.');
    expect(h.screen().rows).toEqual([]);
  });

  it('takes the latest spending the bot created, shows it, and always asks', async () => {
    const h = await createRecordingHarness();
    await h.say('4,50 coffee');
    await h.tapButton(/Eating out/);
    await h.say('12 lunch');
    await h.tapButton(/Groceries/);
    await h.say('/undo');
    expect(h.screen().text).toBe('Remove €12.00 · Groceries · lunch (Mon 5 Oct)?');
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['Remove', 'Keep']);
    expect(await spendingsOf(h)).toHaveLength(2); // it only asked

    await h.tapButton('Remove');
    expect(h.screen().text).toBe(
      '🗑 Removed €12.00 · Groceries · lunch · Mon 5 Oct\nGroceries: €300.00 left of €300.00 (0% used)',
    );
    expect((await spendingsOf(h)).map((s) => s.description)).toEqual(['coffee']);
  });

  it('repeating it takes the next latest', async () => {
    const h = await createRecordingHarness();
    for (const text of ['1 first', '2 second', '3 third']) {
      await h.say(text);
      await h.tapButton(/Groceries/);
    }
    await h.say('/undo');
    expect(h.screen().text).toContain('€3.00 · Groceries · third');
    await h.tapButton('Remove');
    await h.say('/undo');
    expect(h.screen().text).toContain('€2.00 · Groceries · second');
    await h.tapButton('Remove');
    await h.say('/undo');
    expect(h.screen().text).toContain('€1.00 · Groceries · first');
    await h.tapButton('Remove');
    await h.say('/undo');
    expect(h.screen().text).toBe('Nothing to undo.');
    expect(await spendingsOf(h)).toEqual([]);
  });

  it('Keep leaves it, and asking again shows the same one', async () => {
    const h = await createRecordingHarness();
    await h.say('5 a');
    await h.tapButton(/Groceries/);
    await h.say('/undo');
    await h.tapButton('Keep');
    expect(h.screen().text).toBe('Kept.');
    await h.say('/undo');
    expect(h.screen().text).toBe('Remove €5.00 · Groceries · a (Mon 5 Oct)?');
    expect(await spendingsOf(h)).toHaveLength(1);
  });

  it('includes incomes, in the order they were created with the spendings', async () => {
    const h = await createRecordingHarness();
    await h.say('5 a');
    await h.tapButton(/Groceries/);
    await h.say('/income');
    await h.say('200 Bonus');
    await h.tapButton('Today');
    await h.say('/undo');
    expect(h.screen().text).toBe('Remove Income €200.00 · Bonus (Mon 5 Oct)?');
    await h.tapButton('Remove');
    expect(h.screen().text).toBe(
      '🗑 Removed Income €200.00 · Bonus · Mon 5 Oct\nOctober: income €3,000.00 · Unallocated €2,400.00',
    );
    await h.say('/undo');
    expect(h.screen().text).toBe('Remove €5.00 · Groceries · a (Mon 5 Oct)?');
  });

  it('skips what was deleted on the web, and never touches what the web created', async () => {
    const h = await createRecordingHarness();
    await h.say('1 first');
    await h.tapButton(/Groceries/);
    await h.say('2 second');
    await h.tapButton(/Groceries/);
    const rows = await spendingsOf(h);
    await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      description: 'web',
      date: '2026-10-05',
    });
    await request(h.app).delete(`/api/spendings/${rows[0]?.id}`).expect(204); // "second" is gone
    await h.say('/undo');
    expect(h.screen().text).toBe('Remove €1.00 · Groceries · first (Mon 5 Oct)?');
  });

  it('still asks for a row that was edited on the web, and shows its current values', async () => {
    const h = await createRecordingHarness();
    await h.say('5 a');
    await h.tapButton(/Groceries/);
    const [row] = await spendingsOf(h);
    await request(h.app)
      .patch(`/api/spendings/${row?.id}`)
      .send({ amount: 700, description: 'edited' })
      .expect(200);
    await h.say('/undo');
    expect(h.screen().text).toBe('Remove €7.00 · Groceries · edited (Mon 5 Oct)?');
  });

  it('names a closed month in the question', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton(/Groceries/);
    await h.say('40 old');
    await h.tapButton('Earlier…');
    await h.tapButton('Wed 30');
    await h.tapButton('Save');
    await h.say('/undo');
    expect(h.screen().text).toBe(
      'Remove €40.00 · Groceries · old (Wed 30 Sept)?\n' +
        'September is closed. Removing this changes what is due to savings for September.',
    );
  });

  it('is gone from the table once removed, and the stale Remove button is "Already removed."', async () => {
    const h = await createRecordingHarness();
    await h.say('5 a');
    await h.tapButton(/Groceries/);
    await h.say('/undo');
    const remove = h.screen().rows.flat()[0];
    await h.tap(remove?.data ?? '');
    expect(h.db.select().from(telegramEntries).all()).toEqual([]);
    const mark = h.mark();
    await h.tap(remove?.data ?? '');
    expect(h.toast(mark)).toBe('Already removed.');
  });
});
