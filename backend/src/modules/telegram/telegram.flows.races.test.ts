/**
 * The alert watcher and the bot's own confirmation (docs/DOMAIN.md, "No duplicates"): the level a
 * confirmation shows is recorded as notified BEFORE the confirmation is sent, because a check that
 * runs while the message is in flight (a scheduler tick, a debounced check) would otherwise send the
 * alert as well. These tests plug the REAL notifier into the bot and run a check from inside the
 * Telegram call.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { addSpending } from '../../testing/helpers';
import { type RecordingHarness, createRecordingHarness } from '../../testing/telegram-flow-helpers';
import { createTelegramNotify } from './telegram.notifications';
import type { TelegramNotify } from './telegram.notifications';

/** The bot with the real notifier. A check that runs sends through the same fake Bot API. */
async function withRealNotifier(options?: Parameters<typeof createRecordingHarness>[0]) {
  const h = await createRecordingHarness(options);
  const real: TelegramNotify = createTelegramNotify({
    db: h.db,
    clock: h.clock,
    config: { appUrl: undefined },
    status: () => ({ connection: 'running', problem: null, bot: null }),
    sendToLinked: h.tg.sendToLinked,
    log: h.tg.log,
    debounceMs: 1_000_000,
  });
  h.tg.notify = real;
  return { h, real };
}

/** The alert messages among them: they start with the mark (a confirmation starts with ✅ or 🗑). */
const alertsOf = (texts: readonly string[]) =>
  texts.filter((text) => text.startsWith('⚠️') || text.startsWith('🔴'));

/** Every text the bot put in front of the user (new messages and edits), in order. */
const shownTexts = (h: RecordingHarness) =>
  h.fake.calls
    .filter((call) => call.method === 'sendMessage' || call.method === 'editMessageText')
    .map((call) => String(call.payload['text']));

describe('a check that runs while the confirmation is in flight', () => {
  it('does not announce what a new confirmation shows', async () => {
    const { h, real } = await withRealNotifier();
    await h.say('250 shop'); // Groceries 300.00: 83%, a warning
    h.fake.answerOnce('editMessageText', async () => {
      await real.checkBudgetAlerts();
      return true;
    });
    await h.tapButton(/Groceries/);
    real.stop();
    expect(alertsOf(shownTexts(h))).toEqual([]); // no alert beside the confirmation
    expect(h.screen().text).toContain('✅ €250.00 · Groceries · shop');
    expect(h.screen().text).toContain('⚠️ Groceries');
  });

  it('does not announce what an Undo shows', async () => {
    const { h, real } = await withRealNotifier();
    await h.say('10 coffee');
    await h.tapButton(/Groceries/); // ok
    // 250.00 more arrives on the web: Groceries is at a warning, and nobody has been told yet.
    await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      amount: 25000,
      date: '2026-10-02',
    });
    h.fake.answerOnce('editMessageText', async () => {
      await real.checkBudgetAlerts();
      return true;
    });
    await h.tapButton('↩ Undo'); // the Removed message shows ⚠️ Groceries
    real.stop();
    expect(alertsOf(shownTexts(h))).toEqual([]);
    expect(h.screen().text).toContain('🗑 Removed €10.00');
    expect(h.screen().text).toContain('⚠️ Groceries');
  });

  it('does not announce what a Change date shows', async () => {
    const { h, real } = await withRealNotifier();
    await h.say('200 shop');
    await h.tapButton(/Groceries/); // 66%: ok
    await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      amount: 5000,
      date: '2026-10-02',
    });
    await h.tapButton('📅 Change date');
    h.fake.answerOnce('editMessageText', async () => {
      await real.checkBudgetAlerts();
      return true;
    });
    await h.tapButton('Yesterday'); // the rewritten confirmation shows ⚠️ (83%)
    real.stop();
    expect(alertsOf(shownTexts(h))).toEqual([]);
    expect(h.screen().text).toContain('Sun 4 Oct');
    expect(h.screen().text).toContain('⚠️ Groceries');
  });

  it('does not announce what a /recent delete shows', async () => {
    const { h, real } = await withRealNotifier();
    const row = await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      amount: 1000,
      date: '2026-10-02',
    });
    await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      amount: 25000,
      date: '2026-10-03',
    });
    await h.say('/recent');
    await h.tapButton('🗑 2'); // the older one: 10.00
    h.fake.answerOnce('editMessageText', async () => {
      await real.checkBudgetAlerts();
      return true;
    });
    await h.tapButton('Delete');
    real.stop();
    expect(row.id).toBeGreaterThan(0);
    expect(alertsOf(shownTexts(h))).toEqual([]);
    expect(h.screen().text).toContain('🗑 Removed €10.00');
    expect(h.screen().text).toContain('⚠️ Groceries');
  });

  it('records the level before it awaits anything: the dedupe row is there when the send starts', async () => {
    const { h, real } = await withRealNotifier();
    await h.say('250 shop');
    let rowsWhenSending = -1;
    h.fake.answerOnce('editMessageText', () => {
      rowsWhenSending = h.db.$client
        .prepare("select count(*) as n from telegram_notifications where kind = 'budget_alert'")
        .get() as unknown as number;
      return true;
    });
    await h.tapButton(/Groceries/);
    real.stop();
    expect(JSON.stringify(rowsWhenSending)).toContain('1');
  });

  it('still announces what the bot did NOT show: an alert for another budget crossing meanwhile', async () => {
    const { h, real } = await withRealNotifier();
    await h.say('10 coffee');
    // Eating out crosses its warning on the web; the confirmation below is about Groceries.
    await addSpending(h.app, {
      budgetId: h.budget('Eating out').id,
      amount: 17000,
      date: '2026-10-02',
    });
    h.fake.answerOnce('editMessageText', async () => {
      await real.checkBudgetAlerts();
      return true;
    });
    await h.tapButton(/Groceries/);
    real.stop();
    const alerts = alertsOf(shownTexts(h));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('Eating out');
  });
});

describe('a confirmation that never reached the user does not suppress its alert for good', () => {
  const bad = (code: number) => ({
    __botApiError: true,
    code,
    description: 'Bad Gateway',
    parameters: {},
  });

  it('announces the level once Telegram answers again, when nothing at all could be sent', async () => {
    const { h, real } = await withRealNotifier();
    await h.say('250 shop'); // Groceries 300.00: a warning
    h.fake.answerOnce('editMessageText', bad(502));
    h.fake.answerOnce('sendMessage', bad(502)); // the edit's fallback
    h.fake.answerOnce('sendMessage', bad(502)); // "Saved, but …"
    await h.tapButton(/Groceries/);
    expect((await request(h.app).get('/api/spendings').expect(200)).body.items).toHaveLength(1);
    expect(h.screen().text).not.toContain('✅'); // nothing reached the user

    const mark = h.mark(); // Telegram is back
    await real.checkBudgetAlerts();
    const sent = h
      .since(mark)
      .filter((call) => call.method === 'sendMessage')
      .map((call) => String(call.payload['text']));
    expect(alertsOf(sent)).toHaveLength(1);
    expect(alertsOf(sent)[0]).toContain('Groceries');
    await real.checkBudgetAlerts(); // and only once
    expect(
      alertsOf(
        h
          .since(mark)
          .filter((c) => c.method === 'sendMessage')
          .map((c) => String(c.payload['text'])),
      ),
    ).toHaveLength(1);
    real.stop();
  });

  it('does the same when only the "Saved, but …" text got through: it carries no level', async () => {
    const { h, real } = await withRealNotifier();
    await h.say('250 shop');
    h.fake.answerOnce('editMessageText', bad(502));
    h.fake.answerOnce('sendMessage', bad(502)); // the edit's fallback; the failure text goes through
    await h.tapButton(/Groceries/);
    expect(h.fake.sentTexts().at(-1)).toBe(
      "Saved, but I couldn't show the confirmation. /recent lists it.",
    );
    const mark = h.mark();
    await real.checkBudgetAlerts();
    real.stop();
    expect(
      alertsOf(
        h
          .since(mark)
          .filter((c) => c.method === 'sendMessage')
          .map((c) => String(c.payload['text'])),
      ),
    ).toHaveLength(1);
  });

  it('keeps the level when the confirmation was delivered: no alert beside it, ever', async () => {
    const { h, real } = await withRealNotifier();
    await h.say('250 shop');
    await h.tapButton(/Groceries/);
    const mark = h.mark();
    await real.checkBudgetAlerts();
    real.stop();
    expect(
      alertsOf(
        h
          .since(mark)
          .filter((c) => c.method === 'sendMessage')
          .map((c) => String(c.payload['text'])),
      ),
    ).toEqual([]);
  });

  it('does not touch a level that something else moved while the confirmation was in flight', async () => {
    const { h, real } = await withRealNotifier();
    await h.say('10 coffee'); // Groceries: ok
    // While it is in flight Groceries goes over on the web and a check announces that: the row is 'over'.
    h.fake.answerOnce('editMessageText', async () => {
      await addSpending(h.app, {
        budgetId: h.budget('Groceries').id,
        amount: 35000,
        date: '2026-10-02',
      });
      await real.checkBudgetAlerts(); // announces 'over' and records it
      h.fake.answerOnce('sendMessage', bad(502)); // then the edit's fallback fails ...
      h.fake.answerOnce('sendMessage', bad(502)); // ... and so does "Saved, but …"
      return bad(502);
    });
    await h.tapButton(/Groceries/);
    const mark = h.mark();
    await real.checkBudgetAlerts();
    real.stop();
    // The 'over' alert was announced by the check in flight, and is not announced again.
    expect(
      alertsOf(
        h
          .since(mark)
          .filter((c) => c.method === 'sendMessage')
          .map((c) => String(c.payload['text'])),
      ),
    ).toEqual([]);
  });
});

describe('after a write that went through, the user is never told that nothing was changed', () => {
  const tooMany = () => ({ retry_after: 3 });
  const refuse = (h: RecordingHarness, method: string) =>
    h.fake.answerOnce(method, {
      __botApiError: true,
      code: 429,
      description: 'Too Many Requests: retry after 3',
      parameters: tooMany(),
    });

  it('says it was saved when Telegram refuses the edit and the new message', async () => {
    const h = await createRecordingHarness();
    await h.say('12 coffee');
    refuse(h, 'editMessageText');
    refuse(h, 'sendMessage');
    await h.tapButton(/Eating out/);
    const items = (await request(h.app).get('/api/spendings').expect(200)).body.items as unknown[];
    expect(items).toHaveLength(1);
    expect(h.fake.sentTexts().at(-1)).toBe(
      "Saved, but I couldn't show the confirmation. /recent lists it.",
    );
    expect(h.fake.sentTexts().join('\n')).not.toContain('Nothing was changed');
    // One check was asked for by the write, and one after the level was taken back.
    expect(h.notify.scheduleBudgetAlertCheck).toHaveBeenCalledTimes(2);
  });

  it('says so for an income, a move and a removal too', async () => {
    const h = await createRecordingHarness();
    await h.say('/income');
    await h.say('100 Gift');
    refuse(h, 'editMessageText');
    refuse(h, 'sendMessage');
    await h.tapButton('Today');
    expect(h.fake.sentTexts().at(-1)).toBe(
      "Saved, but I couldn't show the confirmation. /undo takes it back.",
    );
    expect(((await request(h.app).get('/api/incomes').expect(200)).body as unknown[]).length).toBe(
      1,
    );

    await h.say('5 a');
    await h.tapButton(/Groceries/);
    await h.tapButton('📅 Change date');
    refuse(h, 'editMessageText');
    refuse(h, 'sendMessage');
    await h.tapButton('Yesterday');
    expect(h.fake.sentTexts().at(-1)).toBe("Moved, but I couldn't show the result.");
    const spendings = (await request(h.app).get('/api/spendings').expect(200)).body.items as {
      date: string;
    }[];
    expect(spendings[0]?.date).toBe('2026-10-04');

    await h.say('/undo');
    refuse(h, 'editMessageText');
    refuse(h, 'sendMessage');
    await h.tapButton('Remove');
    expect(h.fake.sentTexts().at(-1)).toBe("Removed, but I couldn't show the result.");
    expect(
      ((await request(h.app).get('/api/spendings').expect(200)).body.items as unknown[]).length,
    ).toBe(0);
    expect(h.fake.sentTexts().join('\n')).not.toContain('Nothing was changed');
  });

  it('logs it, redacted, and does not throw, when even that message cannot be sent', async () => {
    const h = await createRecordingHarness();
    await h.say('12 coffee');
    h.fake.answerAlways('editMessageText', {
      __botApiError: true,
      code: 429,
      description: 'Too Many Requests',
      parameters: tooMany(),
    });
    h.fake.answerAlways('sendMessage', {
      __botApiError: true,
      code: 429,
      description: 'Too Many Requests',
      parameters: tooMany(),
    });
    await h.tapButton(/Eating out/);
    expect((await request(h.app).get('/api/spendings').expect(200)).body.items).toHaveLength(1);
    expect(h.logged.join('\n')).toContain('could not tell the user about it either');
  });

  it('still says nothing was changed when the failure is BEFORE the write', async () => {
    const h = await createRecordingHarness();
    await h.say('12 coffee');
    h.db.run((await import('drizzle-orm')).sql`drop table telegram_entries`);
    await h.tapButton(/Eating out/);
    expect(h.fake.sentTexts().at(-1)).toBe('Something went wrong. Nothing was changed.');
    expect((await request(h.app).get('/api/spendings').expect(200)).body.items).toHaveLength(0);
  });
});
