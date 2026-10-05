/**
 * What the real runtime throws for a message that did not go out (`TelegramSendError.telegramCode`),
 * and what the recap makes of it (docs/DOMAIN.md, "Monthly recap"): only a 400 from Telegram sends
 * the recap again without its button; a network error, a timeout, a 403, a 429 and a 5xx wait for the
 * next tick, because the message may have gone out. The runtime runs against the fake Bot API, with
 * no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app';
import { createDb, runMigrations } from '../../db/client';
import { telegramNotifications } from '../../db/schema';
import { FakeBotApi, OWNER, botApiError, networkError } from '../../testing/fake-bot-api';
import { linkTelegramAccount } from '../../testing/fake-telegram';
import { mutableClock, onboard } from '../../testing/helpers';
import { TOKEN } from '../../testing/telegram-harness';
import { type TelegramNotifyOptions, sendMonthlyRecap } from './telegram.notifications';
import { createTelegramRuntime } from './telegram.runtime';
import { type TelegramRuntime, TelegramSendError } from './telegram.types';

const started: TelegramRuntime[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((runtime) => runtime.stop()));
});

const APP_URL = 'https://wallet.example.ts.net';

/** The recap of September is due: linked on 20 September, now 1 October at 09:00. */
async function recapDue() {
  const db = createDb(':memory:');
  runMigrations(db);
  const clock = mutableClock('2026-09-25T10:00:00Z');
  const app = createApp({ db, clock, config: { env: 'test', staticDir: undefined } });
  await onboard(app, { startMonth: '2026-08', salary: 100000, openingSavings: 0 });
  linkTelegramAccount(db, OWNER, '2026-09-20T08:00:00.000Z');
  clock.set('2026-10-01T09:00:00Z');

  const fake = new FakeBotApi();
  const runtime = createTelegramRuntime({
    db,
    clock,
    config: {
      telegramBotToken: TOKEN,
      telegramApiRoot: 'https://api.telegram.org',
      appUrl: APP_URL,
    },
    sink: { log: () => undefined, error: () => undefined },
    transformer: fake.transformer,
  });
  started.push(runtime);
  runtime.start();
  await vi.waitFor(() => expect(runtime.status().connection).toBe('running'));

  const options: TelegramNotifyOptions = {
    db,
    clock,
    config: { appUrl: APP_URL },
    status: () => runtime.status(),
    sendToLinked: (text, extra) => runtime.sendToLinked(text, extra),
    log: runtime.log,
  };
  const recapSends = () =>
    fake
      .callsOf('sendMessage')
      .filter((call) => String(call.payload['text']).includes('is closed'));
  const rows = () =>
    db
      .select()
      .from(telegramNotifications)
      .all()
      .map((row) => row.key);
  return { fake, options, recapSends, rows };
}

describe('the recap against the real runtime', () => {
  it('sends again without the button when Telegram answers 400 to the message with it', async () => {
    const { fake, options, recapSends, rows } = await recapDue();
    fake.answerOnce('sendMessage', botApiError(400, 'Bad Request: wrong HTTP URL specified'));
    await sendMonthlyRecap(options);
    const sends = recapSends();
    expect(sends).toHaveLength(2);
    expect(sends[0]?.payload['reply_markup']).toBeDefined();
    expect(sends[1]?.payload['reply_markup']).toBeUndefined();
    expect(rows()).toEqual(['2026-09']);
  });

  it('does not send again after a network error or a timeout', async () => {
    const { fake, options, recapSends, rows } = await recapDue();
    fake.answerOnce('sendMessage', () => {
      throw networkError('sendMessage', `https://api.telegram.org/bot${TOKEN}/sendMessage`);
    });
    await sendMonthlyRecap(options);
    expect(recapSends()).toHaveLength(1);
    expect(rows()).toEqual([]);

    await sendMonthlyRecap(options); // the next tick: with the button, once
    expect(recapSends()).toHaveLength(2);
    expect(recapSends()[1]?.payload['reply_markup']).toBeDefined();
    expect(rows()).toEqual(['2026-09']);
  });

  it.each([
    [403, 'Forbidden: bot was blocked by the user'],
    [429, 'Too Many Requests: retry after 5'],
    [500, 'Internal Server Error'],
    [502, 'Bad Gateway'],
  ])('does not send again after a %i', async (code, description) => {
    const { fake, options, recapSends, rows } = await recapDue();
    fake.answerOnce('sendMessage', botApiError(code, description));
    await sendMonthlyRecap(options);
    expect(recapSends()).toHaveLength(1);
    expect(rows()).toEqual([]);
  });

  it('takes the code from the answer of Telegram, not from words in its description', async () => {
    const { fake, options, recapSends } = await recapDue();
    fake.answerOnce('sendMessage', botApiError(500, 'Internal Server Error: it failed! (400: x)'));
    await sendMonthlyRecap(options);
    expect(recapSends()).toHaveLength(1); // a 500 is never taken for a refusal of the message
  });
});

describe('what the runtime throws', () => {
  it('carries the error code of Telegram, and none for a failure with no answer', async () => {
    const { fake, options } = await recapDue();
    const failure = async (answer: unknown) => {
      fake.answerOnce('sendMessage', answer);
      return options.sendToLinked('x').catch((error: unknown) => error);
    };

    const refused = await failure(botApiError(400, 'Bad Request: wrong HTTP URL specified'));
    expect(refused).toBeInstanceOf(TelegramSendError);
    expect((refused as TelegramSendError).telegramCode).toBe(400);

    const busy = await failure(botApiError(429, 'Too Many Requests', { retry_after: 5 }));
    expect((busy as TelegramSendError).telegramCode).toBe(429);

    const down = await failure(() => {
      throw networkError('sendMessage', 'https://api.telegram.org/bot123/sendMessage');
    });
    expect(down).toBeInstanceOf(TelegramSendError);
    expect((down as TelegramSendError).telegramCode).toBeUndefined();
  });
});
