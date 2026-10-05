/**
 * The runtime's connection state machine, with a fake Bot API (no network) and fake timers: start,
 * polling, `running`, 401, 404, 409, 429, network errors, `blocked`, the backoff, and `stop()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations } from '../../db/client';
import {
  FakeBotApi,
  OWNER,
  STRANGER,
  botApiError,
  messageUpdate,
  networkError,
} from '../../testing/fake-bot-api';
import { linkTelegramAccount } from '../../testing/fake-telegram';
import { mutableClock } from '../../testing/helpers';
import { TOKEN } from '../../testing/telegram-harness';
import { removeLink } from './telegram.access';
import { ALLOWED_UPDATES, DEFAULT_BACKOFF, createTelegramRuntime } from './telegram.runtime';
import { BOT_COMMANDS, helpText } from './telegram.messages';
import { type TelegramRuntime, TelegramSendError } from './telegram.types';

const SECOND = 1000;
const started: TelegramRuntime[] = [];

function makeRuntime(options: { linked?: boolean; apiRoot?: string } = {}) {
  const db = createDb(':memory:');
  runMigrations(db);
  if (options.linked) linkTelegramAccount(db, OWNER);
  const fake = new FakeBotApi();
  const lines: string[] = [];
  const runtime = createTelegramRuntime({
    db,
    clock: mutableClock('2026-03-15T10:00:00Z'),
    config: {
      telegramBotToken: TOKEN,
      telegramApiRoot: options.apiRoot ?? 'https://api.telegram.org',
      appUrl: undefined,
    },
    sink: { log: (m) => lines.push(m), error: (m) => lines.push(m) },
    transformer: fake.transformer,
  });
  started.push(runtime);
  return { db, fake, lines, runtime };
}

/** Lets every promise that can run, run. */
const settle = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const polls = (fake: FakeBotApi) => fake.callsOf('getUpdates');
/** The polls without a wait: the first one, and every try after a failure. A try that works is followed by a long poll. */
const probes = (fake: FakeBotApi) => polls(fake).filter((call) => call.payload['timeout'] === 0);
const methods = (fake: FakeBotApi) => fake.calls.map((call) => call.method);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await Promise.all(started.splice(0).map((runtime) => runtime.stop()));
  vi.useRealTimers();
});

describe('starting', () => {
  it('is connecting until Telegram has answered, then running, and reports the bot', async () => {
    const { runtime, fake } = makeRuntime();
    expect(runtime.status()).toEqual({ connection: 'connecting', problem: null, bot: null });
    runtime.start();
    expect(runtime.status().connection).toBe('connecting');
    await settle();
    expect(runtime.status()).toEqual({
      connection: 'running',
      problem: null,
      bot: { username: 'wallet_test_bot' },
    });
    expect(fake.callsOf('getMe')).toHaveLength(1);
  });

  it('removes any webhook, asks who it is, registers the commands, then polls', async () => {
    const { runtime, fake } = makeRuntime();
    runtime.start();
    await settle();
    expect(methods(fake).slice(0, 5)).toEqual([
      'deleteWebhook',
      'getMe',
      'setMyCommands',
      'getUpdates',
      'getUpdates',
    ]);
    expect(fake.callsOf('setMyCommands')[0]?.payload['commands']).toEqual(BOT_COMMANDS);
  });

  it('asks for messages and button taps only, always', async () => {
    const { runtime, fake } = makeRuntime();
    runtime.start();
    await settle();
    expect([...ALLOWED_UPDATES]).toEqual(['message', 'callback_query']);
    for (const call of polls(fake)) {
      expect(call.payload['allowed_updates']).toEqual(['message', 'callback_query']);
    }
  });

  it('polls once without waiting (so a working connection shows at once), then for 30 seconds', async () => {
    const { runtime, fake } = makeRuntime();
    runtime.start();
    await settle();
    expect(polls(fake).map((call) => call.payload['timeout'])).toEqual([0, 30]);
  });

  it('does nothing when started twice', async () => {
    const { runtime, fake } = makeRuntime();
    runtime.start();
    runtime.start();
    await settle();
    expect(fake.callsOf('deleteWebhook')).toHaveLength(1);
    expect(fake.callsOf('getMe')).toHaveLength(1);
  });

  it('is a startup error to build it without a token', () => {
    const db = createDb(':memory:');
    expect(() =>
      createTelegramRuntime({
        db,
        clock: mutableClock('2026-03-15T10:00:00Z'),
        config: { telegramBotToken: undefined, telegramApiRoot: 'x', appUrl: undefined },
      }),
    ).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});

describe('updates', () => {
  it('handles what Telegram delivers, and confirms it with the next offset', async () => {
    const { runtime, fake } = makeRuntime({ linked: true });
    runtime.start();
    await settle();
    const update = messageUpdate('/help', { from: OWNER });
    fake.push(update);
    await settle();
    expect(fake.sentTexts()).toEqual([helpText()]);
    expect(polls(fake).at(-1)?.payload['offset']).toBe(update.update_id + 1);
    expect(fake.confirmedThrough).toBe(update.update_id);
  });

  it('answers nobody but the linked user', async () => {
    const { runtime, fake } = makeRuntime({ linked: true });
    runtime.start();
    await settle();
    fake.push(messageUpdate('/help', { from: STRANGER }));
    await settle();
    expect(fake.callsOf('sendMessage')).toEqual([]);
  });

  it('skips an update that fails, logs it, and goes on with the next', async () => {
    const { runtime, fake, lines } = makeRuntime({ linked: true });
    runtime.start();
    await settle();
    fake.answerOnce('sendMessage', botApiError(500, 'Internal Server Error'));
    const bad = messageUpdate('/help', { from: OWNER });
    const good = messageUpdate('/help', { from: OWNER });
    fake.push(bad, good);
    await settle();
    expect(lines.some((line) => line.includes(`could not handle update ${bad.update_id}`))).toBe(
      true,
    );
    expect(fake.sentTexts()).toEqual([helpText(), helpText()]); // the failed attempt, then the next update
    expect(fake.confirmedThrough).toBe(good.update_id); // the failed one is not delivered again
    expect(runtime.status().connection).toBe('running');
  });
});

describe('a 401: the token is wrong', () => {
  it('stops with invalid_token and never retries, until the server restarts', async () => {
    const { runtime, fake, lines } = makeRuntime();
    fake.answerOnce('getMe', botApiError(401, 'Unauthorized'));
    runtime.start();
    await settle();
    expect(runtime.status()).toMatchObject({ connection: 'error', problem: 'invalid_token' });
    const callsSoFar = fake.calls.length;
    await advance(60 * 60 * SECOND);
    expect(fake.calls).toHaveLength(callsSoFar);
    expect(runtime.status()).toMatchObject({ connection: 'error', problem: 'invalid_token' });
    expect(lines.some((line) => /refused the token.*restarts/.test(line))).toBe(true);
  });

  it('also stops when the token is revoked while polling', async () => {
    const { runtime, fake } = makeRuntime();
    runtime.start();
    await settle();
    expect(runtime.status().connection).toBe('running');
    fake.answerOnce('getUpdates', botApiError(401, 'Unauthorized'));
    fake.push(messageUpdate('x', { from: OWNER })); // wakes the long poll, which then answers 401
    await settle();
    expect(runtime.status()).toMatchObject({ connection: 'error', problem: 'invalid_token' });
    const callsSoFar = fake.calls.length;
    await advance(10 * 60 * SECOND);
    expect(fake.calls).toHaveLength(callsSoFar);
  });

  it('is the same for a 404, which Telegram answers to a token that is not even well formed', async () => {
    const { runtime, fake } = makeRuntime();
    fake.answerOnce('deleteWebhook', botApiError(404, 'Not Found'));
    runtime.start();
    await settle();
    expect(runtime.status()).toMatchObject({ connection: 'error', problem: 'invalid_token' });
    await advance(60 * 60 * SECOND);
    expect(fake.callsOf('deleteWebhook')).toHaveLength(1);
  });

  it('refuses every send, with a safe error', async () => {
    const { runtime, fake } = makeRuntime({ linked: true });
    fake.answerOnce('getMe', botApiError(401, 'Unauthorized'));
    runtime.start();
    await settle();
    await expect(runtime.sendToLinked('hi')).rejects.toMatchObject({ reason: 'not_running' });
    expect(fake.callsOf('sendMessage')).toEqual([]);
  });

  it('can still be stopped', async () => {
    const { runtime, fake } = makeRuntime();
    fake.answerOnce('getMe', botApiError(401, 'Unauthorized'));
    runtime.start();
    await settle();
    await runtime.stop();
    expect(runtime.status().connection).toBe('off');
  });
});

describe('a 409: another program polls with this bot', () => {
  it('shows conflict and retries after 30 s, 60 s, 2 min, 4 min, then every 5 min', async () => {
    const { runtime, fake } = makeRuntime();
    for (let i = 0; i < 6; i++)
      fake.answerOnce(
        'getUpdates',
        botApiError(409, 'Conflict: terminated by other getUpdates request'),
      );
    runtime.start();
    await settle();
    expect(runtime.status()).toMatchObject({ connection: 'error', problem: 'conflict' });
    expect(probes(fake)).toHaveLength(1);

    let calls = 1;
    for (const seconds of [30, 60, 120, 240, 300, 300]) {
      await advance(seconds * SECOND - 1);
      expect(probes(fake), `still waiting ${seconds} s`).toHaveLength(calls);
      await advance(1);
      calls += 1;
      expect(probes(fake), `after ${seconds} s`).toHaveLength(calls);
    }
    // The 7th call is answered: back to running.
    expect(runtime.status()).toMatchObject({ connection: 'running', problem: null });
    expect(DEFAULT_BACKOFF).toEqual({ initialMs: 30_000, maxMs: 300_000 });
  });

  it('starts again at 30 s after a success', async () => {
    const { runtime, fake } = makeRuntime();
    fake.answerOnce('getUpdates', botApiError(409, 'Conflict'));
    fake.answerOnce('getUpdates', botApiError(409, 'Conflict'));
    runtime.start();
    await settle();
    await advance(30 * SECOND); // 2nd call: 409 again
    await advance(60 * SECOND); // 3rd call: succeeds
    expect(runtime.status().connection).toBe('running');

    fake.answerOnce('getUpdates', botApiError(409, 'Conflict'));
    fake.push(messageUpdate('x', { from: OWNER })); // the long poll answers with the 409 queued above
    await settle();
    expect(runtime.status()).toMatchObject({ problem: 'conflict' });
    const calls = probes(fake).length;
    await advance(30 * SECOND - 1);
    expect(probes(fake)).toHaveLength(calls);
    await advance(1);
    expect(probes(fake)).toHaveLength(calls + 1);
  });

  it('polls with no wait after a failure, so recovery shows at once', async () => {
    const { runtime, fake } = makeRuntime();
    fake.answerOnce('getUpdates', botApiError(409, 'Conflict'));
    runtime.start();
    await settle();
    await advance(30 * SECOND);
    expect(polls(fake).map((call) => call.payload['timeout'])).toEqual([0, 0, 30]);
  });
});

describe('a network error', () => {
  it('shows unreachable, retries with the same growing delay, and recovers', async () => {
    const { runtime, fake } = makeRuntime();
    const down = () => {
      throw networkError('getUpdates', `https://api.telegram.org/bot${TOKEN}/getUpdates`);
    };
    fake.answerOnce('getUpdates', down);
    fake.answerOnce('getUpdates', down);
    runtime.start();
    await settle();
    expect(runtime.status()).toMatchObject({ connection: 'error', problem: 'unreachable' });
    expect(runtime.status().bot).toEqual({ username: 'wallet_test_bot' }); // known from getMe
    await advance(30 * SECOND);
    expect(probes(fake)).toHaveLength(2);
    expect(runtime.status().problem).toBe('unreachable');
    await advance(59 * SECOND);
    expect(probes(fake)).toHaveLength(2);
    await advance(SECOND);
    expect(probes(fake)).toHaveLength(3);
    expect(runtime.status()).toMatchObject({ connection: 'running', problem: null });
  });

  it('when the start itself fails, repeats the whole start, and runs once it works', async () => {
    const { runtime, fake } = makeRuntime();
    fake.answerOnce('deleteWebhook', () => {
      throw networkError('deleteWebhook', `https://api.telegram.org/bot${TOKEN}/deleteWebhook`);
    });
    runtime.start();
    await settle();
    expect(runtime.status()).toMatchObject({
      connection: 'error',
      problem: 'unreachable',
      bot: null,
    });
    expect(fake.callsOf('getMe')).toEqual([]);
    await advance(30 * SECOND);
    expect(runtime.status()).toMatchObject({
      connection: 'running',
      bot: { username: 'wallet_test_bot' },
    });
    expect(methods(fake).slice(0, 4)).toEqual([
      'deleteWebhook',
      'deleteWebhook',
      'getMe',
      'setMyCommands',
    ]);
  });

  it('treats an error answer from Telegram that is not 401, 404 or 409 as unreachable (a 502, say)', async () => {
    const { runtime, fake } = makeRuntime();
    fake.answerOnce('getUpdates', botApiError(502, 'Bad Gateway'));
    runtime.start();
    await settle();
    expect(runtime.status()).toMatchObject({ connection: 'error', problem: 'unreachable' });
    await advance(30 * SECOND);
    expect(runtime.status().connection).toBe('running');
  });

  it('honours a 429 that asks for a longer wait than the backoff', async () => {
    const { runtime, fake } = makeRuntime();
    fake.answerOnce(
      'getUpdates',
      botApiError(429, 'Too Many Requests: retry after 100', { retry_after: 100 }),
    );
    runtime.start();
    await settle();
    await advance(99 * SECOND);
    expect(probes(fake)).toHaveLength(1);
    await advance(SECOND);
    expect(probes(fake)).toHaveLength(2);
  });
});

describe('blocked: the owner blocked the bot', () => {
  it('shows blocked on a 403 to the linked chat, keeps polling, and clears at the next send that works', async () => {
    const { runtime, fake } = makeRuntime({ linked: true });
    runtime.start();
    await settle();
    fake.answerOnce('sendMessage', botApiError(403, 'Forbidden: bot was blocked by the user'));
    await expect(runtime.sendToLinked('hello')).rejects.toBeInstanceOf(TelegramSendError);
    expect(runtime.status()).toMatchObject({ connection: 'error', problem: 'blocked' });

    // Polling goes on, and a send is still tried while blocked.
    await runtime.sendToLinked('hello again');
    expect(runtime.status()).toMatchObject({ connection: 'running', problem: null });
  });

  it('clears when the owner writes to the bot and the reply goes through', async () => {
    const { runtime, fake } = makeRuntime({ linked: true });
    runtime.start();
    await settle();
    fake.answerOnce('sendMessage', botApiError(403, 'Forbidden: bot was blocked by the user'));
    await expect(runtime.sendToLinked('x')).rejects.toBeInstanceOf(TelegramSendError);
    expect(runtime.status().problem).toBe('blocked');
    fake.push(messageUpdate('/help', { from: OWNER })); // they unblocked and wrote
    await settle();
    expect(runtime.status()).toMatchObject({ connection: 'running', problem: null });
  });

  it('is gone when the link is removed: with no linked chat there is nothing to be blocked', async () => {
    const { runtime, fake, db } = makeRuntime({ linked: true });
    runtime.start();
    await settle();
    fake.answerOnce('sendMessage', botApiError(403, 'Forbidden: bot was blocked by the user'));
    await expect(runtime.sendToLinked('x')).rejects.toBeInstanceOf(TelegramSendError);
    expect(runtime.status().problem).toBe('blocked');
    removeLink(db);
    expect(runtime.status()).toMatchObject({ connection: 'running', problem: null });
  });

  it('is not caused by a 403 to some other chat', async () => {
    const { runtime, fake } = makeRuntime({ linked: true });
    runtime.start();
    await settle();
    fake.answerOnce('sendMessage', botApiError(403, 'Forbidden: bot was blocked by the user'));
    await expect(runtime.sendMessage(STRANGER.id, 'x')).rejects.toBeInstanceOf(TelegramSendError);
    expect(runtime.status()).toMatchObject({ connection: 'running', problem: null });
  });

  it('is not hidden by a network problem: the problem of the poll wins while it lasts', async () => {
    const { runtime, fake } = makeRuntime({ linked: true });
    runtime.start();
    await settle();
    fake.answerOnce('sendMessage', botApiError(403, 'Forbidden'));
    await expect(runtime.sendToLinked('x')).rejects.toBeInstanceOf(TelegramSendError);
    fake.answerOnce('getUpdates', botApiError(409, 'Conflict'));
    fake.push(messageUpdate('x', { from: STRANGER }));
    await settle();
    expect(runtime.status()).toMatchObject({ connection: 'error', problem: 'conflict' });
  });
});

describe('sending', () => {
  it('sends to a chat and to the linked chat once running, as HTML', async () => {
    const { runtime, fake } = makeRuntime({ linked: true });
    runtime.start();
    await settle();
    await runtime.sendMessage(STRANGER.id, 'to someone');
    await runtime.sendToLinked('<b>to the owner</b>');
    const [first, second] = fake.callsOf('sendMessage');
    expect(first?.payload).toMatchObject({
      chat_id: STRANGER.id,
      text: 'to someone',
      parse_mode: 'HTML',
    });
    expect(second?.payload).toMatchObject({
      chat_id: OWNER.id,
      text: '<b>to the owner</b>',
      parse_mode: 'HTML',
    });
  });

  it('refuses before the bot runs, with reason not_running, and does not call Telegram', async () => {
    const { runtime, fake } = makeRuntime({ linked: true });
    await expect(runtime.sendToLinked('x')).rejects.toMatchObject({ reason: 'not_running' });
    runtime.start();
    expect(fake.callsOf('sendMessage')).toEqual([]);
  });

  it('refuses with reason not_linked when nobody is linked', async () => {
    const { runtime } = makeRuntime();
    runtime.start();
    await settle();
    await expect(runtime.sendToLinked('x')).rejects.toMatchObject({ reason: 'not_linked' });
  });

  it('rejects with a TelegramSendError, never the raw error, and keeps no cause', async () => {
    const { runtime, fake } = makeRuntime({ linked: true });
    runtime.start();
    await settle();
    fake.answerOnce('sendMessage', () => {
      throw networkError('sendMessage', `https://api.telegram.org/bot${TOKEN}/sendMessage`);
    });
    const error = await runtime.sendToLinked('x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramSendError);
    expect((error as TelegramSendError).reason).toBe('refused');
    expect((error as TelegramSendError).cause).toBeUndefined();
    expect((error as Error).message).not.toContain(TOKEN);
  });
});

describe('stop()', () => {
  it('aborts the long poll and resolves, leaving nothing running', async () => {
    const { runtime, fake } = makeRuntime();
    runtime.start();
    await settle();
    const callsBefore = fake.calls.length;
    await runtime.stop();
    expect(runtime.status().connection).toBe('off');
    await advance(10 * 60 * SECOND);
    expect(fake.calls).toHaveLength(callsBefore); // no update was handled, so nothing to confirm either
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves while it waits to retry, without waiting out the delay', async () => {
    const { runtime, fake } = makeRuntime();
    fake.answerOnce('getUpdates', botApiError(409, 'Conflict'));
    runtime.start();
    await settle();
    expect(runtime.status().problem).toBe('conflict');
    await runtime.stop(); // no timers were advanced: the 30 s wait ended by itself
    expect(polls(fake)).toHaveLength(1);
    await advance(10 * 60 * SECOND);
    expect(polls(fake)).toHaveLength(1);
  });

  it('can be called twice, and before start', async () => {
    const { runtime, fake } = makeRuntime();
    await runtime.stop();
    await runtime.stop();
    runtime.start(); // too late: stopped
    await settle();
    expect(fake.calls).toEqual([]);
  });

  it('waits for the update in progress, drops the rest of the batch, and confirms only what was handled', async () => {
    const { runtime, fake } = makeRuntime({ linked: true });
    runtime.start();
    await settle();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.answerOnce('sendMessage', async () => {
      await held;
      return { message_id: 1, date: 0, chat: { id: OWNER.id, type: 'private' } };
    });
    const first = messageUpdate('/help', { from: OWNER });
    const second = messageUpdate('/help', { from: OWNER });
    fake.push(first, second);
    await settle(); // the first update is being handled: its reply is held

    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false); // it waits for the update in progress

    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(fake.callsOf('sendMessage')).toHaveLength(1); // the second update was not handled
    expect(fake.confirmedThrough).toBe(first.update_id); // and is delivered again at the next start
    expect(runtime.status().connection).toBe('off');
  });

  it('does not wait for Telegram forever to confirm the last update', async () => {
    const { runtime, fake } = makeRuntime({ linked: true });
    runtime.start();
    await settle();
    fake.push(messageUpdate('/help', { from: OWNER }));
    await settle();
    // The confirming call is refused: stop() still resolves.
    fake.answerOnce('getUpdates', () => {
      throw networkError('getUpdates', `https://api.telegram.org/bot${TOKEN}/getUpdates`);
    });
    // The long poll that is in flight is aborted by stop(); the confirming call is the next one.
    await runtime.stop();
    expect(runtime.status().connection).toBe('off');
  });
});
