/**
 * The guided `/spending` flow through `bot.handleUpdate()` with a fake Bot API that records every
 * call (docs/DOMAIN.md, "The `/spending` flow" and "The confirmation"): every step, Skip, Earlier,
 * every 422 path, the closed-month confirmation, midnight between steps, and the figures printed
 * against the month view.
 */
import { type SpendingsPage, parseCents } from '@wallet/shared';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { telegramEntries } from '../../db/schema';
import { OWNER } from '../../testing/fake-bot-api';
import { addSpending } from '../../testing/helpers';
import { type RecordingHarness, createRecordingHarness } from '../../testing/telegram-flow-helpers';
import { LONGEST_CALLBACK_DATA } from './telegram.callbacks';
import { formatMoney } from './telegram.format';

const FMT = { currency: 'EUR', locale: 'en-GB' };
const money = (cents: number) => formatMoney(cents, FMT);

const spendingsOf = async (h: RecordingHarness) =>
  ((await request(h.app).get('/api/spendings').expect(200)).body as SpendingsPage).items;

/** `/spending`, the budget, the amount (with or without a note). */
async function toDateStep(h: RecordingHarness, budget: string | RegExp, amountText: string) {
  await h.say('/spending');
  await h.tapButton(budget);
  await h.say(amountText);
}

describe('/spending: the steps', () => {
  it('goes budget, amount, note, date and saves through the service', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    expect(h.screen().text).toBe('Which budget?');

    await h.tapButton('🛒 Groceries · €300.00');
    expect(h.screen().text).toBe(
      '🛒 Groceries\nHow much? You can add a note after the amount, like 12,50 lunch',
    );
    expect(h.screen().rows).toEqual([]);

    await h.say('23,40');
    expect(h.screen().text).toBe('€23.40 · Groceries\nA note?');
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['Skip']);

    await h.say('Lidl');
    expect(h.screen().text).toBe('€23.40 · Groceries · Lidl\nWhen?');
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['Today', 'Yesterday', 'Earlier…']);
    // Nothing is stored until the last step.
    expect(await spendingsOf(h)).toEqual([]);

    await h.tapButton('Today');
    expect(h.screen().text).toBe(
      '✅ €23.40 · Groceries · Lidl · Mon 5 Oct\nGroceries: €276.60 left of €300.00 (7% used)',
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
      amount: 2340,
      budgetId: h.budget('Groceries').id,
      description: 'Lidl',
      notes: null,
      tagIds: [],
    });
  });

  it('edits the message the button is on, and sends a new one only for what follows typed text', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    const sentBefore = h.fake.callsOf('sendMessage').length;
    await h.tapButton(/Groceries/);
    expect(h.fake.callsOf('editMessageText')).toHaveLength(1); // the budget message became the amount prompt
    expect(h.fake.callsOf('sendMessage')).toHaveLength(sentBefore);
    await h.say('5');
    expect(h.fake.callsOf('sendMessage')).toHaveLength(sentBefore + 1); // the note prompt
    await h.say('x');
    await h.tapButton('Today');
    // The confirmation replaced the date prompt: the last edit holds it, with its keyboard.
    const edit = h.fake.callsOf('editMessageText').at(-1);
    expect(String(edit?.payload['text'])).toContain('✅');
    expect(edit?.payload['parse_mode']).toBe('HTML');
    expect(h.fake.callsOf('answerCallbackQuery')).toHaveLength(2); // one per tap
  });

  it('answers every tap, and the keyboard of the note step goes when the note is typed', async () => {
    const h = await createRecordingHarness();
    await toDateStep(h, /Groceries/, '5');
    const mark = h.mark();
    await h.say('coffee');
    const strip = h.since(mark).find((call) => call.method === 'editMessageReplyMarkup');
    expect(strip?.payload['reply_markup']).toEqual({ inline_keyboard: [] });
  });

  it('saves a spending with the budget, the amount and the note it was given, as the web would', async () => {
    const h = await createRecordingHarness();
    await toDateStep(h, /Eating out/, '12,50 lunch');
    await h.tapButton('Yesterday');
    const [row] = await spendingsOf(h);
    expect(row).toMatchObject({
      date: '2026-10-04',
      amount: 1250,
      budgetId: h.budget('Eating out').id,
      description: 'lunch',
    });
  });

  it('records what the bot created, for /undo, in the same transaction as the spending', async () => {
    const h = await createRecordingHarness();
    await toDateStep(h, /Groceries/, '5 a');
    await h.tapButton('Today');
    const [row] = await spendingsOf(h);
    const entries = h.db.select().from(telegramEntries).all();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ spendingId: row?.id, incomeId: null });
  });

  it('tells the alert watcher what the confirmation showed, then asks for a check', async () => {
    const h = await createRecordingHarness();
    await toDateStep(h, /Groceries/, '5 a');
    await h.tapButton('Today');
    expect(h.notify.markNotified).toHaveBeenCalledTimes(1);
    expect(h.notify.markNotified).toHaveBeenCalledWith({
      month: '2026-10',
      budgetId: h.budget('Groceries').id,
      level: 'ok',
    });
    expect(h.notify.scheduleBudgetAlertCheck).toHaveBeenCalledTimes(1);
    const marked = h.notify.markNotified.mock.invocationCallOrder[0] ?? 0;
    const scheduled = h.notify.scheduleBudgetAlertCheck.mock.invocationCallOrder[0] ?? 0;
    expect(marked).toBeLessThan(scheduled);
  });

  it('tells the watcher the level a warning or an over confirmation showed', async () => {
    const h = await createRecordingHarness();
    // Eating out is 200.00: 160.00 is 80% (warning), then 50.00 more is over.
    await toDateStep(h, /Eating out/, '160 big dinner');
    await h.tapButton('Today');
    expect(h.screen().text).toBe(
      '✅ €160.00 · Eating out · big dinner · Mon 5 Oct\n' +
        '⚠️ Eating out: €40.00 left of €200.00 (80% used, warning at 80%)',
    );
    expect(h.notify.markNotified).toHaveBeenLastCalledWith({
      month: '2026-10',
      budgetId: h.budget('Eating out').id,
      level: 'warning',
    });

    await toDateStep(h, /Eating out/, '50 dessert');
    await h.tapButton('Today');
    expect(h.screen().text).toBe(
      '✅ €50.00 · Eating out · dessert · Mon 5 Oct\n' +
        '🔴 Eating out: over by €10.00 (105% of €200.00 used)',
    );
    expect(h.notify.markNotified).toHaveBeenLastCalledWith({
      month: '2026-10',
      budgetId: h.budget('Eating out').id,
      level: 'over',
    });
  });
});

describe('/spending: the budget step', () => {
  it('lists the budgets of the current month in the order of the month view, two per row, with a Cancel button', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    expect(h.screen().rows.map((row) => row.map((b) => b.text))).toEqual([
      ['🛒 Groceries · €300.00', '🍝 Eating out · €200.00'],
      ['⛽ Fuel · €1,000.00'],
      ['✖ Cancel'],
    ]);
  });

  it('shows what is left (remaining), which can be negative, and follows sortOrder', async () => {
    const h = await createRecordingHarness({
      budgets: [
        { name: 'Zeta', amount: 10000, incremental: false, startMonth: '2026-10', sortOrder: 2 },
        { name: 'Alpha', amount: 5000, incremental: false, startMonth: '2026-10', sortOrder: 1 },
      ],
    });
    await addSpending(h.app, { budgetId: h.budget('Alpha').id, amount: 7000, date: '2026-10-02' });
    await h.say('/spending');
    expect(h.screen().rows[0]?.map((b) => b.text)).toEqual(['Alpha · -€20.00', 'Zeta · €100.00']);
  });

  it('cuts a long name on the button, keeps it whole in the message, and escapes it', async () => {
    const name = '<b>Groceries & fresh</b> for the whole big family';
    const h = await createRecordingHarness({
      budgets: [{ name, amount: 30000, incremental: false, startMonth: '2026-10', icon: '🛒' }],
    });
    await h.say('/spending');
    const label = h.screen().rows[0]?.[0]?.text ?? '';
    // 23 characters of the name and an ellipsis: 24 in all (the icon and the amount come on top).
    expect(label).toBe('🛒 <b>Groceries & fresh</b… · €300.00');
    await h.tapButton(/Groceries/);
    expect(h.screen().text).toBe(
      `🛒 &lt;b&gt;Groceries &amp; fresh&lt;/b&gt; for the whole big family\nHow much? You can add a note after the amount, like 12,50 lunch`,
    );
  });

  it('answers "No active budgets this month" and starts no flow', async () => {
    const h = await createRecordingHarness({ budgets: [] });
    await h.say('/spending');
    expect(h.screen().text).toBe('No active budgets this month. Add one in the app.');
    expect(h.screen().rows).toEqual([]);
    await h.say('5');
    // No flow is waiting for an amount: this is a quick entry, and it finds no budget either.
    expect(h.screen().text).toBe('No active budgets this month. Add one in the app.');
  });

  it('does not list a budget that is not active this month (archived last month, or not started)', async () => {
    const h = await createRecordingHarness({
      budgets: [
        { name: 'Old', amount: 1000, incremental: false, startMonth: '2026-01' },
        { name: 'Live', amount: 1000, incremental: false, startMonth: '2026-01' },
        { name: 'Later', amount: 1000, incremental: false, startMonth: '2026-11' },
      ],
    });
    await request(h.app)
      .post(`/api/budgets/${h.budget('Old').id}/archive`)
      .send({ endMonth: '2026-09' })
      .expect(200);
    await h.say('/spending');
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['Live · €10.00', '✖ Cancel']);
  });

  it('puts the Cancel button first in line: it ends the flow and nothing is stored', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton('✖ Cancel');
    expect(h.screen().text).toBe('Cancelled.');
    expect(h.screen().rows).toEqual([]);
    expect(await spendingsOf(h)).toEqual([]);
  });

  it('sends a budget that was archived since the list was shown back to the list, with a notice', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await request(h.app)
      .post(`/api/budgets/${h.budget('Eating out').id}/archive`)
      .send({ endMonth: '2026-09' })
      .expect(200);
    await h.tapButton(/Eating out/);
    expect(h.screen().text).toBe(
      'That budget is no longer available. Pick another one.\n\nWhich budget?',
    );
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['🛒 Groceries · €300.00', '⛽ Fuel · €1,000.00', '✖ Cancel']);
  });
});

describe('/spending: the amount step', () => {
  it.each([
    ['12.50', 1250],
    ['12,50', 1250],
    ['€12.50', 1250],
    ['12.50€', 1250],
    ['€ 12,50', 1250],
    ['12,50 €', 1250],
    ['12', 1200],
    ['0.5', 50],
    ['007', 700],
  ])('reads %j as %i cents', async (text, cents) => {
    const h = await createRecordingHarness();
    await toDateStep(h, /Groceries/, text);
    expect(h.screen().text).toBe(`${money(cents)} · Groceries\nA note?`);
  });

  it('reads -5 as a refund of 5.00 and says so', async () => {
    const h = await createRecordingHarness();
    await toDateStep(h, /Groceries/, '-5');
    expect(h.screen().text).toBe('↩ Refund €5.00 · Groceries\nA note?');
    await h.tapButton('Skip');
    await h.tapButton('Today');
    expect(h.screen().text).toBe(
      '↩ Refund €5.00 · Groceries · Mon 5 Oct\nGroceries: €305.00 left of €300.00 (0% used)',
    );
    const [row] = await spendingsOf(h);
    expect(row?.amount).toBe(-500);
  });

  it('takes the text after the number as the note and skips the note step', async () => {
    const h = await createRecordingHarness();
    await toDateStep(h, /Groceries/, '12,50 lunch with Anna');
    expect(h.screen().text).toBe('€12.50 · Groceries · lunch with Anna\nWhen?');
  });

  it.each([
    ['hello', 'not_an_amount'],
    ['coffee 4', 'not_an_amount'],
    ['12.345', 'not_an_amount'],
    ['12.50lunch', 'not_an_amount'],
    ['$12.50', 'not_an_amount'],
    ['1 234,50', 'not_an_amount'],
    ['', 'not_an_amount'],
    ['0', 'zero'],
    ['0,00 nothing', 'zero'],
    ['-0', 'zero'],
    ['10000000000.01', 'too_large'],
    ['99999999999999999999', 'too_large'],
    [`5 ${'x'.repeat(201)}`, 'note_too_long'],
  ])('re-prompts %j and stores nothing', async (text, problem) => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton(/Groceries/);
    const mark = h.mark();
    if (text === '') {
      // Telegram never sends an empty text: a space-only message reads the same way.
      await h.say('   ');
    } else {
      await h.say(text);
    }
    const reply = h.screen(mark).text;
    if (problem === 'not_an_amount') {
      expect(reply).toBe("I couldn't read an amount there. Try 12.50 or 12,50 lunch.");
    } else if (problem === 'zero') {
      expect(reply).toBe("The amount can't be 0. Try 12.50, or -5 for a refund.");
    } else if (problem === 'too_large') {
      expect(reply).toBe('That amount is too large: the most is €10,000,000,000.00.');
    } else {
      expect(reply).toBe('That note is too long: 200 characters at most.');
    }
    expect(await spendingsOf(h)).toEqual([]);

    // The flow still waits for the amount: a good one goes on.
    await h.say('3');
    expect(h.screen().text).toBe('€3.00 · Groceries\nA note?');
  });

  it('accepts the biggest amount the services accept, and refuses one cent more', async () => {
    const h = await createRecordingHarness();
    await toDateStep(h, /Groceries/, '10000000000.00');
    expect(h.screen().text).toBe('€10,000,000,000.00 · Groceries\nA note?');
  });

  it('accepts a note of exactly 200 characters and refuses 201, never cutting', async () => {
    const h = await createRecordingHarness();
    await toDateStep(h, /Groceries/, `5 ${'n'.repeat(200)}`);
    expect(h.screen().text).toBe(`€5.00 · Groceries · ${'n'.repeat(200)}\nWhen?`);
    await h.tapButton('Today');
    const [row] = await spendingsOf(h);
    expect(row?.description).toHaveLength(200);
  });

  it('accepts the symbol of the currency in Settings, and no other', async () => {
    const h = await createRecordingHarness({ locale: 'en-US' });
    // Switch the settings currency to USD through the web API.
    await request(h.app)
      .put('/api/settings')
      .send({
        currency: 'USD',
        locale: 'en-US',
        startMonth: '2026-01',
        theme: 'system',
        alertWarnPercent: 80,
      })
      .expect(200);
    await toDateStep(h, /Groceries/, '$12.50');
    expect(h.screen().text).toBe('$12.50 · Groceries\nA note?');
    await h.say('/spending');
    await h.tapButton(/Groceries/);
    await h.say('£12.50');
    expect(h.screen().text).toBe("I couldn't read an amount there. Try 12.50 or 12,50 lunch.");
    await h.say('€12.50'); // the euro sign is always accepted
    expect(h.screen().text).toBe('$12.50 · Groceries\nA note?');
  });
});

describe('/spending: the note step', () => {
  it('Skip stores an empty description', async () => {
    const h = await createRecordingHarness();
    await toDateStep(h, /Groceries/, '9');
    await h.tapButton('Skip');
    expect(h.screen().text).toBe('€9.00 · Groceries\nWhen?');
    await h.tapButton('Today');
    expect(h.screen().text).toBe(
      '✅ €9.00 · Groceries · Mon 5 Oct\nGroceries: €291.00 left of €300.00 (3% used)',
    );
    const [row] = await spendingsOf(h);
    expect(row?.description).toBe('');
  });

  it('collapses the whitespace of a typed note, and escapes it in messages', async () => {
    const h = await createRecordingHarness();
    await toDateStep(h, /Groceries/, '9');
    await h.say('  <b>Lidl</b>   &\n Co ');
    expect(h.screen().text).toBe('€9.00 · Groceries · &lt;b&gt;Lidl&lt;/b&gt; &amp; Co\nWhen?');
    await h.tapButton('Today');
    expect(h.screen().text).toContain('&lt;b&gt;Lidl&lt;/b&gt; &amp; Co');
    const [row] = await spendingsOf(h);
    expect(row?.description).toBe('<b>Lidl</b> & Co'); // stored as typed, never escaped
  });

  it('refuses a note over 200 characters, and keeps waiting for one', async () => {
    const h = await createRecordingHarness();
    await toDateStep(h, /Groceries/, '9');
    await h.say('n'.repeat(201));
    expect(h.screen().text).toBe('That note is too long: 200 characters at most.');
    await h.say('short');
    expect(h.screen().text).toBe('€9.00 · Groceries · short\nWhen?');
  });
});

describe('/spending: the date step', () => {
  it('offers Today and Yesterday with their explicit dates, and Earlier…', async () => {
    const h = await createRecordingHarness();
    await toDateStep(h, /Groceries/, '9 a');
    expect(h.screen().rows.flat()).toEqual([
      { text: 'Today', data: expect.stringMatching(/^f:[0-9a-z]+:d:2026-10-05$/) },
      { text: 'Yesterday', data: expect.stringMatching(/^f:[0-9a-z]+:d:2026-10-04$/) },
      { text: 'Earlier…', data: expect.stringMatching(/^f:[0-9a-z]+:e$/) },
    ]);
  });

  it('Earlier… swaps in one button per day from 2 to 6 days ago, each with its date', async () => {
    const h = await createRecordingHarness();
    await toDateStep(h, /Groceries/, '9 a');
    await h.tapButton('Earlier…');
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => [b.text, b.data.split(':').slice(2).join(':')]),
    ).toEqual([
      ['Sat 3', 'd:2026-10-03'],
      ['Fri 2', 'd:2026-10-02'],
      ['Thu 1', 'd:2026-10-01'],
      ['Wed 30', 'd:2026-09-30'],
      ['Tue 29', 'd:2026-09-29'],
    ]);
    // Same message, so the keyboard was edited, not a new message sent.
    expect(h.fake.callsOf('editMessageReplyMarkup').at(-1)?.payload['reply_markup']).toBeDefined();
  });

  it('saves the day of the button that was tapped', async () => {
    const h = await createRecordingHarness();
    await toDateStep(h, /Groceries/, '9 a');
    await h.tapButton('Earlier…');
    await h.tapButton('Fri 2');
    expect(h.screen().text).toContain('Fri 2 Oct');
    const [row] = await spendingsOf(h);
    expect(row?.date).toBe('2026-10-02');
  });

  it('does not offer a day before the start month', async () => {
    const h = await createRecordingHarness({
      now: '2026-01-03T10:00:00Z',
      startMonth: '2026-01',
      budgets: [{ name: 'Groceries', amount: 30000, incremental: false, startMonth: '2026-01' }],
    });
    await toDateStep(h, /Groceries/, '9 a');
    // Today (3 Jan), Yesterday (2 Jan); 1 Jan is the earliest day offered; 31 Dec is not.
    await h.tapButton('Earlier…');
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['Thu 1']);
  });

  it('offers no Earlier… when every earlier day is before the start month', async () => {
    const h = await createRecordingHarness({
      now: '2026-01-02T10:00:00Z',
      startMonth: '2026-01',
      budgets: [{ name: 'Groceries', amount: 30000, incremental: false, startMonth: '2026-01' }],
    });
    await toDateStep(h, /Groceries/, '9 a');
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['Today', 'Yesterday']);
  });

  it('offers only Today on the first day of the start month', async () => {
    const h = await createRecordingHarness({
      now: '2026-01-01T10:00:00Z',
      startMonth: '2026-01',
      budgets: [{ name: 'Groceries', amount: 30000, incremental: false, startMonth: '2026-01' }],
    });
    await toDateStep(h, /Groceries/, '9 a');
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['Today']);
  });

  it('saves the date the button showed when it is tapped after midnight', async () => {
    const h = await createRecordingHarness({ now: '2026-10-05T23:58:00Z' });
    await toDateStep(h, /Groceries/, '9 a');
    h.clock.set('2026-10-06T00:03:00Z'); // midnight passed while the keyboard was on screen
    await h.tapButton('Today');
    const [row] = await spendingsOf(h);
    expect(row?.date).toBe('2026-10-05');
    expect(h.screen().text).toContain('Mon 5 Oct');
  });

  it('keeps a month boundary right: Today tapped after midnight on the last day of a month', async () => {
    const h = await createRecordingHarness({ now: '2026-10-31T23:59:00Z' });
    await toDateStep(h, /Groceries/, '9 a');
    h.clock.set('2026-11-01T00:01:00Z');
    await h.tapButton('Today');
    // The date it showed is still the one it saves, but October is closed now: it asks first.
    expect(h.screen().text).toBe(
      '€9.00 · Groceries · a · Sat 31 Oct\n' +
        'October is closed. Adding this changes what is due to savings for October.',
    );
    await h.tapButton('Save');
    const [row] = await spendingsOf(h);
    expect(row?.date).toBe('2026-10-31');
    expect(h.screen().text).toContain('Groceries in October (closed)');
  });
});

describe('/spending: a closed month asks first', () => {
  const toSeptember = async (h: RecordingHarness) => {
    await toDateStep(h, /Groceries/, '40 receipt');
    await h.tapButton('Earlier…');
    await h.tapButton('Wed 30');
  };

  it('asks before saving a date in a closed month, and Save stores it', async () => {
    const h = await createRecordingHarness();
    await toSeptember(h);
    expect(h.screen().text).toBe(
      '€40.00 · Groceries · receipt · Wed 30 Sept\n' +
        'September is closed. Adding this changes what is due to savings for September.',
    );
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['Save', 'Other date']);
    expect(await spendingsOf(h)).toEqual([]);

    await h.tapButton('Save');
    expect(h.screen().text).toBe(
      '✅ €40.00 · Groceries · receipt · Wed 30 Sept\n' +
        'Groceries in September (closed): €260.00 left of €300.00 (13% used)',
    );
    const [row] = await spendingsOf(h);
    expect(row?.date).toBe('2026-09-30');
  });

  it('Other date goes back to the date step, with nothing stored', async () => {
    const h = await createRecordingHarness();
    await toSeptember(h);
    await h.tapButton('Other date');
    expect(h.screen().text).toBe('€40.00 · Groceries · receipt\nWhen?');
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['Today', 'Yesterday', 'Earlier…']);
    expect(await spendingsOf(h)).toEqual([]);
    await h.tapButton('Today');
    const [row] = await spendingsOf(h);
    expect(row?.date).toBe('2026-10-05');
  });

  it('does not ask for a date in the current month, even the first of it', async () => {
    const h = await createRecordingHarness({ now: '2026-10-03T10:00:00Z' });
    await toDateStep(h, /Groceries/, '40 receipt');
    await h.tapButton('Earlier…');
    await h.tapButton('Thu 1');
    expect(h.screen().text).toContain('✅');
  });

  it('does not ask twice: a second tap of Save is a stale button', async () => {
    const h = await createRecordingHarness();
    await toSeptember(h);
    const save = h
      .screen()
      .rows.flat()
      .find((b) => b.text === 'Save');
    await h.tap(save?.data ?? '');
    await h.tap(save?.data ?? '');
    expect(await spendingsOf(h)).toHaveLength(1);
    expect(h.toast()).toBe('This entry expired, start again with /spending');
  });
});

describe('/spending: a refusal of the service becomes a sentence and a way back', () => {
  it('outside_active_months goes back to the date step and names the month', async () => {
    const h = await createRecordingHarness({
      budgets: [{ name: 'Groceries', amount: 30000, incremental: false, startMonth: '2026-10' }],
    });
    await toDateStep(h, /Groceries/, '40 receipt');
    await h.tapButton('Earlier…');
    await h.tapButton('Wed 30');
    await h.tapButton('Save'); // closed month: confirmed, then the service refuses
    expect(h.screen().text).toBe(
      "Groceries isn't active in September. Pick another date.\n\n€40.00 · Groceries · receipt\nWhen?",
    );
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['Today', 'Yesterday', 'Earlier…']);
    expect(await spendingsOf(h)).toEqual([]);

    await h.tapButton('Today'); // the way back works: the flow is alive and keeps the amount and note
    expect(h.screen().text).toContain('✅ €40.00 · Groceries · receipt · Mon 5 Oct');
    expect(await spendingsOf(h)).toHaveLength(1);
  });

  it('unknown_budget (deleted meanwhile) goes back to step 1 and then straight on to the date', async () => {
    const h = await createRecordingHarness();
    await toDateStep(h, /Eating out/, '15 pizza');
    await request(h.app)
      .delete(`/api/budgets/${h.budget('Eating out').id}`)
      .expect(204);
    await h.tapButton('Today');
    expect(h.screen().text).toBe(
      'That budget is no longer available. Pick another one.\n\nWhich budget?',
    );
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['🛒 Groceries · €300.00', '⛽ Fuel · €1,000.00', '✖ Cancel']);
    expect(await spendingsOf(h)).toEqual([]);

    await h.tapButton(/Groceries/);
    // The amount and the note were kept: it asks for the date again.
    expect(h.screen().text).toBe('€15.00 · Groceries · pizza\nWhen?');
    await h.tapButton('Today');
    const [row] = await spendingsOf(h);
    expect(row).toMatchObject({
      amount: 1500,
      description: 'pizza',
      budgetId: h.budget('Groceries').id,
    });
  });

  it('unknown_budget with no budget left says so and ends the flow', async () => {
    const h = await createRecordingHarness({
      budgets: [{ name: 'Only', amount: 1000, incremental: false, startMonth: '2026-01' }],
    });
    await toDateStep(h, /Only/, '1 a');
    await request(h.app)
      .delete(`/api/budgets/${h.budget('Only').id}`)
      .expect(204);
    await h.tapButton('Today');
    expect(h.screen().text).toBe('No active budgets this month. Add one in the app.');
    expect(h.screen().rows).toEqual([]);
  });

  it('before_start_month goes back to the date step', async () => {
    const h = await createRecordingHarness();
    await toDateStep(h, /Groceries/, '40 receipt');
    await h.tapButton('Earlier…');
    await h.tapButton('Wed 30');
    // The start month moves to October behind the bot's back (the API would refuse: facts before it).
    h.db.run(sql`update settings set start_month = '2026-10'`);
    await h.tapButton('Save');
    expect(h.screen().text).toBe(
      'That date is before the first month Wallet tracks (October 2026). Pick another date.\n\n' +
        '€40.00 · Groceries · receipt\nWhen?',
    );
    // And the buttons no longer offer September.
    await h.tapButton('Earlier…');
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['Sat 3', 'Fri 2', 'Thu 1']);
  });
});

describe('/spending: the figure is the month view, to the cent', () => {
  it('prints remaining, available and the percentage of the budget line of the month of the spending', async () => {
    const h = await createRecordingHarness();
    await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      amount: 12345,
      date: '2026-10-01',
    });
    await toDateStep(h, /Groceries/, '23,40 Lidl');
    await h.tapButton('Today');
    const view = await h.monthView('2026-10');
    const line = view.budgets.find((b) => b.name === 'Groceries');
    expect(line).toBeDefined();
    const tokens = [...h.screen().text.matchAll(/€([\d,]+\.\d{2})/g)].map((m) =>
      parseCents((m[1] ?? '').replace(/,/g, '')),
    );
    // The amount, then what is left and what is available: all taken from the line.
    expect(tokens).toEqual([2340, line?.remaining, line?.available]);
    expect(h.screen().text).toContain(`(${line?.usagePercent}% used)`);
    expect(line?.spent).toBe(12345 + 2340);
  });

  it('says nothing about a percentage when the budget has nothing available', async () => {
    const h = await createRecordingHarness({
      budgets: [{ name: 'Empty', amount: 0, incremental: false, startMonth: '2026-10' }],
    });
    await toDateStep(h, /Empty/, '5 a');
    await h.tapButton('Today');
    expect(h.screen().text).toBe('✅ €5.00 · Empty · a · Mon 5 Oct\n🔴 Empty: over by €5.00');
  });

  it('prints the figure of a budget at 0 available and 0 spent without a percentage', async () => {
    const h = await createRecordingHarness({
      budgets: [{ name: 'Empty', amount: 0, incremental: false, startMonth: '2026-10' }],
    });
    await toDateStep(h, /Empty/, '-5 refund');
    await h.tapButton('Today');
    expect(h.screen().text).toBe(
      '↩ Refund €5.00 · Empty · refund · Mon 5 Oct\nEmpty: €5.00 left of €0.00',
    );
  });
});

describe('/spending: the buttons fit Telegram', () => {
  it('has callback data of at most 64 bytes, the longest possible one included', () => {
    expect(new TextEncoder().encode(LONGEST_CALLBACK_DATA).length).toBeLessThanOrEqual(64);
  });

  it('never sends a button over 64 bytes, whatever the budget ids', async () => {
    const h = await createRecordingHarness();
    h.db.run(sql`update sqlite_sequence set seq = 9007199254740000 where name = 'budgets'`);
    const created = await request(h.app)
      .post('/api/budgets')
      .send({ name: 'Big id', amount: 100, incremental: false })
      .expect(201);
    expect(created.body.id).toBeGreaterThan(9007199254740000);
    await h.say('/spending');
    for (const button of h.screen().rows.flat()) {
      expect(new TextEncoder().encode(button.data).length).toBeLessThanOrEqual(64);
    }
    await h.tapButton(/Big id/);
    await h.say('1 a');
    await h.tapButton('Today');
    for (const button of h.screen().rows.flat()) {
      expect(new TextEncoder().encode(button.data).length).toBeLessThanOrEqual(64);
    }
    expect(h.screen().text).toContain('✅ €1.00 · Big id');
  });
});

describe('/spending: only the owner', () => {
  it('ignores a stranger in the middle of the owner’s flow, and the flow goes on', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    const mark = h.mark();
    await h.say('/spending', { from: { id: 666, first_name: 'Mallory' } });
    await h.say('12,50 x', { from: { id: 666, first_name: 'Mallory' } });
    expect(h.since(mark)).toEqual([]);
    await h.tapButton(/Groceries/);
    expect(h.screen().text).toContain('How much?');
    expect(OWNER.id).not.toBe(666);
  });
});
