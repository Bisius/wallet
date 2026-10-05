/**
 * The one-minute tick of the notifications (docs/DOMAIN.md, "The scheduler"). OWNED BY T3. T1 wired
 * `startTelegramScheduler` into `index.ts` (started after `listen`, only when the bot runs, stopped
 * in `shutdown()` before the database closes). It follows `backups.scheduler.ts`: an `unref`'d
 * timer, a tick that never throws, `tick()` for tests and `stop()` for shutdown.
 *
 * Each tick runs, in this order: the alert check (the safety net for what the write hook and the
 * bot's writes missed, such as a change of the warning threshold), the renewal reminders and the
 * monthly recap. Each of them looks at the clock and the dedupe log itself, so a tick is cheap and
 * a missed minute, hour or day is made up at the next one. A step that fails is logged and does not
 * stop the next. A tick that finds the previous one still running is skipped (a tick waiting on a
 * slow Telegram must not pile up).
 *
 * There is no tick at start: right after `start()` the bot is still `connecting`, and a tick would
 * find it unable to send anything. The first one runs one interval later.
 */
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import type { Clock } from '../../lib/clock';
import {
  type TelegramNotifyOptions,
  sendMonthlyRecap,
  sendRenewalReminders,
} from './telegram.notifications';
import type { TelegramHandle, TelegramLog } from './telegram.types';

/** One tick a minute. */
export const TELEGRAM_TICK_MS = 60_000;

export interface TelegramSchedulerOptions {
  db: Db;
  /** The only source of "now". */
  clock: Clock;
  config: Pick<Config, 'appUrl'>;
  /** Sends through it (`telegram.sendToLinked`), asks it for its `status()` and logs with `telegram.log`. */
  telegram: TelegramHandle;
  /** Defaults to `telegram.log`. */
  log?: TelegramLog;
  /** How often to tick (default: every minute, `TELEGRAM_TICK_MS`). */
  tickEveryMs?: number;
}

export interface TelegramScheduler {
  /** Runs one tick now, as the timer does. Never rejects. For tests. */
  tick(): Promise<void>;
  /** Stops ticking and resolves once the tick in progress has finished. Never rejects. */
  stop(): Promise<void>;
}

/**
 * Starts the timer. `createApp` and the tests never call it: only `index.ts` does, and only with a
 * bot.
 */
export function startTelegramScheduler({
  db,
  clock,
  config,
  telegram,
  log = telegram.log,
  tickEveryMs = TELEGRAM_TICK_MS,
}: TelegramSchedulerOptions): TelegramScheduler {
  const options: TelegramNotifyOptions = {
    db,
    clock,
    config,
    status: () => telegram.status(),
    sendToLinked: (text, extra) => telegram.sendToLinked(text, extra),
    log,
  };
  let stopped = false;
  let running: Promise<void> | undefined;

  const step = async (what: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      log.error(`${what} failed, it is tried again at the next tick`, error);
    }
  };

  const pass = async (): Promise<void> => {
    // The alert check is the watcher's own, so that it shares its one-at-a-time rule with the
    // debounced checks of the write hook.
    await step('the budget alert check', () => telegram.notify.checkBudgetAlerts());
    await step('the renewal reminders', () => sendRenewalReminders(options));
    await step('the monthly recap', () => sendMonthlyRecap(options));
  };

  const tick = (): Promise<void> => {
    if (stopped || running) return Promise.resolve();
    running = pass().finally(() => {
      running = undefined;
    });
    return running;
  };

  const timer = setInterval(() => void tick(), tickEveryMs);
  timer.unref();

  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      try {
        telegram.notify.stop(); // drop a debounced check that has not started
        await running;
        await telegram.notify.whenIdle?.(); // and wait for one that has
      } catch (error) {
        log.error('could not stop the notifications cleanly', error);
      }
    },
  };
}
