/**
 * The notification scheduler (docs/DOMAIN.md, "The scheduler"): the one-minute timer, the order of
 * the steps, a tick that never throws, a tick that is skipped while the previous one runs, and
 * `stop()`. The timers are faked where the cadence is the point; everything else uses real ones, and
 * never supertest under fake timers (it hangs there).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addBudget, addSpending, addSubscription, onboard } from '../../testing/helpers';
import { TOKEN } from '../../testing/telegram-harness';
import { type NotifyHarness, createNotifyHarness } from '../../testing/telegram-notify-harness';
import { createTelegramLog } from './telegram.log';
import { createTelegramNotify } from './telegram.notifications';
import { TELEGRAM_TICK_MS, startTelegramScheduler } from './telegram.scheduler';

const open: NotifyHarness[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((h) => h.close()));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wednesday 28 October 2026, 09:30, English (UK), linked in September, with all three notifications
 * due at once: Groceries is over (an alert), Netflix is billed tomorrow (a reminder) and September
 * has closed (the recap).
 */
async function everythingDue(options: Parameters<typeof createNotifyHarness>[0] = {}) {
  const h = createNotifyHarness({
    now: '2026-10-28T09:30:00Z',
    linkedAt: '2026-09-20T08:00:00.000Z',
    ...options,
  });
  open.push(h);
  await onboard(h.setup, {
    locale: 'en-GB',
    startMonth: '2026-08',
    salary: 300000,
    openingSavings: 0,
  });
  const groceries = await addBudget(h.setup, {
    name: 'Groceries',
    amount: 10000,
    startMonth: '2026-08',
  });
  await addSubscription(h.setup, {
    name: 'Netflix',
    anchorDate: '2026-08-29',
    amount: 1399,
    startMonth: '2026-08',
  });
  await addSpending(h.setup, { budgetId: groceries.id, amount: 11000, date: '2026-10-20' });
  return h;
}

const ALERT = '🔴 Groceries is over by €10.00';
const REMINDER = '🔔 Renewals\nNetflix · tomorrow (Thu 29 Oct) · €13.99';

describe('the timer', () => {
  it('ticks every minute, with no tick at start', async () => {
    const h = createNotifyHarness();
    open.push(h);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const checks = vi.spyOn(h.notify, 'checkBudgetAlerts');
    h.startScheduler(TELEGRAM_TICK_MS);
    expect(TELEGRAM_TICK_MS).toBe(60_000);

    expect(checks).not.toHaveBeenCalled(); // not at start: the bot is still connecting then
    await vi.advanceTimersByTimeAsync(59_999);
    expect(checks).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(checks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000 * 3);
    expect(checks).toHaveBeenCalledTimes(4);
  });

  it('does not keep the process alive', async () => {
    const h = createNotifyHarness();
    open.push(h);
    const spy = vi.spyOn(globalThis, 'setInterval');
    h.startScheduler();
    const timer = spy.mock.results[0]?.value as NodeJS.Timeout | undefined;
    expect(timer).toBeDefined();
    expect(timer?.hasRef()).toBe(false);
  });

  it('can be started with another cadence, for tests', async () => {
    const h = createNotifyHarness();
    open.push(h);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const checks = vi.spyOn(h.notify, 'checkBudgetAlerts');
    h.startScheduler(1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(checks).toHaveBeenCalledTimes(3);
  });
});

describe('one tick', () => {
  it('runs the alert check, then the renewal reminders, then the recap', async () => {
    const h = await everythingDue();
    await h.startScheduler().tick();
    const texts = h.texts();
    expect(texts).toHaveLength(3);
    expect(texts[0]).toBe(ALERT);
    expect(texts[1]).toBe(REMINDER);
    expect(texts[2]).toMatch(/^📅 September 2026 is closed\n/);
  });

  it('sends nothing on the next tick: everything is in the log', async () => {
    const h = await everythingDue();
    const scheduler = h.startScheduler();
    await scheduler.tick();
    await scheduler.tick();
    expect(h.texts()).toHaveLength(3);
    expect(
      h
        .log()
        .map((line) => line.split(' ')[0])
        .sort(),
    ).toEqual(['budget_alert', 'recap', 'renewal']);
  });

  it('is a safety net for the alert check: it announces what no write asked a check for', async () => {
    const h = await everythingDue();
    // No hook, no bot write: the only thing that looks is the tick.
    await h.startScheduler().tick();
    expect(h.texts()[0]).toBe(ALERT);
  });

  it('does nothing without a linked account or while the bot is not running', async () => {
    const h = await everythingDue({ linkedAt: null });
    await h.startScheduler().tick();
    expect(h.fake.attempts).toEqual([]);
    const h2 = await everythingDue({ status: { connection: 'connecting' } });
    await h2.startScheduler().tick();
    expect(h2.fake.attempts).toEqual([]);
  });
});

describe('a tick never throws', () => {
  it('logs a step that fails and still runs the steps after it', async () => {
    const h = await everythingDue();
    vi.spyOn(h.notify, 'checkBudgetAlerts').mockRejectedValueOnce(new Error('alerts are down'));
    const scheduler = h.startScheduler();
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(h.fake.logLines.join('\n')).toContain('the budget alert check failed');
    // The reminder and the recap went out; the alert waits for the next tick.
    expect(h.texts()).toHaveLength(2);
    expect(h.texts()[0]).toBe(REMINDER);

    await scheduler.tick();
    expect(h.texts()).toHaveLength(3);
    expect(h.texts()[2]).toBe(ALERT);
  });

  it('survives every step failing, and works again once the cause is gone', async () => {
    const h = await everythingDue();
    h.statusSpy.mockImplementation(() => {
      throw new Error('status is down');
    });
    const scheduler = h.startScheduler();
    await expect(scheduler.tick()).resolves.toBeUndefined();
    const lines = h.fake.logLines.join('\n');
    expect(lines).toContain('the budget alert check failed');
    expect(lines).toContain('the renewal reminders failed');
    expect(lines).toContain('the monthly recap failed');
    expect(h.fake.attempts).toEqual([]);

    h.statusSpy.mockImplementation(() => h.fake.status());
    await scheduler.tick();
    expect(h.texts()).toHaveLength(3);
  });

  it('never rejects even when the timer starts the tick', async () => {
    const h = await everythingDue();
    vi.spyOn(h.notify, 'checkBudgetAlerts').mockRejectedValue(new Error('boom'));
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const scheduler = h.startScheduler(5);
      await sleep(40);
      await scheduler.stop();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('logs through the redacting log: the token of the bot is in no line', async () => {
    const h = await everythingDue();
    const lines: string[] = [];
    const log = createTelegramLog(TOKEN, {
      log: (message: string) => lines.push(message),
      error: (message: string) => lines.push(message),
    });
    vi.spyOn(h.notify, 'checkBudgetAlerts').mockRejectedValueOnce(
      new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`),
    );
    const scheduler = startTelegramScheduler({
      db: h.db,
      clock: h.clock,
      config: { appUrl: undefined },
      telegram: h.telegram,
      log,
      tickEveryMs: 2_000_000_000,
    });
    await scheduler.tick();
    await scheduler.stop();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(lines.join('\n')).toContain('[redacted]');
  });

  it('logs a send that fails without the token either', async () => {
    const h = await everythingDue();
    const lines: string[] = [];
    const log = createTelegramLog(TOKEN, {
      log: (message: string) => lines.push(message),
      error: (message: string) => lines.push(message),
    });
    const notify = createTelegramNotify({
      db: h.db,
      clock: h.clock,
      config: { appUrl: undefined },
      status: () => h.fake.status(),
      sendToLinked: async () => {
        throw new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`);
      },
      log,
    });
    await notify.checkBudgetAlerts();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });
});

describe('overlapping ticks', () => {
  it('skips a tick that finds the previous one still running', async () => {
    const h = await everythingDue();
    const checks = vi.spyOn(h.notify, 'checkBudgetAlerts');
    const scheduler = h.startScheduler();
    const release = h.blockSends(); // Telegram is slow: the alert is held

    const first = scheduler.tick();
    await sleep(10);
    expect(checks).toHaveBeenCalledTimes(1);
    expect(h.fake.attempts).toEqual([]); // still waiting for Telegram

    await expect(scheduler.tick()).resolves.toBeUndefined(); // skipped: it did not wait either
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(checks).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(h.texts()).toHaveLength(3); // each notification exactly once

    await scheduler.tick(); // and the next tick runs normally
    expect(checks).toHaveBeenCalledTimes(2);
    expect(h.texts()).toHaveLength(3);
  });
});

describe('stop', () => {
  it('clears the timer: no tick follows', async () => {
    const h = createNotifyHarness();
    open.push(h);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const checks = vi.spyOn(h.notify, 'checkBudgetAlerts');
    const scheduler = h.startScheduler(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(checks).toHaveBeenCalledTimes(1);

    await scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(checks).toHaveBeenCalledTimes(1);
    await scheduler.tick(); // an explicit tick after stop does nothing either
    expect(checks).toHaveBeenCalledTimes(1);
  });

  it('waits for the tick in flight', async () => {
    const h = await everythingDue();
    const scheduler = h.startScheduler();
    const release = h.blockSends();
    const tick = scheduler.tick();
    await sleep(10);

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await sleep(30);
    expect(stopped).toBe(false); // the tick is waiting for Telegram

    release();
    await stopping;
    expect(stopped).toBe(true);
    await tick;
    expect(h.texts()).toHaveLength(3); // the tick ended before stop did, and wrote its rows
    expect(h.log()).toHaveLength(3);
  });

  it('waits for an alert check that a write started, and drops one that has not started', async () => {
    const h = await everythingDue({ debounceMs: 5 });
    const scheduler = h.startScheduler();
    const release = h.blockSends();

    h.notify.scheduleBudgetAlertCheck();
    await sleep(40); // the check started and is waiting for Telegram
    expect(h.statusSpy).toHaveBeenCalled();

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await sleep(30);
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(h.log()).toEqual([expect.stringMatching(/^budget_alert 2026-10:\d+ over$/)]); // the row was written

    // A request that arrives after the stop is dropped.
    const before = h.fake.attempts.length;
    h.notify.scheduleBudgetAlertCheck();
    await sleep(40);
    expect(h.fake.attempts).toHaveLength(before);
  });

  it('drops a debounced check that is still waiting', async () => {
    const h = await everythingDue({ debounceMs: 30 });
    const scheduler = h.startScheduler();
    h.notify.scheduleBudgetAlertCheck();
    await scheduler.stop();
    await sleep(80);
    expect(h.fake.attempts).toEqual([]);
  });

  it('never rejects, and can be called twice', async () => {
    const h = createNotifyHarness();
    open.push(h);
    const scheduler = h.startScheduler();
    vi.spyOn(h.notify, 'stop').mockImplementationOnce(() => {
      throw new Error('stop failed');
    });
    await expect(scheduler.stop()).resolves.toBeUndefined();
    expect(h.fake.logLines.join('\n')).toContain('could not stop the notifications cleanly');
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });
});
