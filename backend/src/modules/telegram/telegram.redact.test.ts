/**
 * The bot token appears in every Bot API URL, so no error, log line or API response may contain it
 * (docs/DOMAIN.md, "Security and privacy"). Unit tests of `redact()`, and an end-to-end check that
 * runs the real runtime through every kind of failure with the console spied.
 */
import { GrammyError, HttpError } from 'grammy';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app';
import { createDb, runMigrations } from '../../db/client';
import {
  FakeBotApi,
  OWNER,
  botApiError,
  messageUpdate,
  networkError,
} from '../../testing/fake-bot-api';
import { linkTelegramAccount } from '../../testing/fake-telegram';
import { mutableClock, onboard } from '../../testing/helpers';
import { TOKEN } from '../../testing/telegram-harness';
import { createTelegramLog, redact } from './telegram.log';
import { createTelegramRuntime } from './telegram.runtime';

const SECRET = TOKEN.split(':')[1] as string;
const URL_WITH_TOKEN = `https://api.telegram.org/bot${TOKEN}/getUpdates`;

describe('redact()', () => {
  it('replaces the token wherever it is in a string', () => {
    const out = redact(`request to ${URL_WITH_TOKEN} failed`, TOKEN);
    expect(out).toBe('request to https://api.telegram.org/bot[redacted]/getUpdates failed');
    expect(redact(`token=${TOKEN}; again ${TOKEN}`, TOKEN)).toBe(
      'token=[redacted]; again [redacted]',
    );
  });

  it('replaces the URL-encoded token too', () => {
    const out = redact(`https://x.test/?t=${encodeURIComponent(TOKEN)}`, TOKEN);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[redacted]');
  });

  it('describes an error with its name and message, and hides the token in it', () => {
    const out = redact(new Error(`could not reach ${URL_WITH_TOKEN}`), TOKEN);
    expect(out).toContain(
      'Error: could not reach https://api.telegram.org/bot[redacted]/getUpdates',
    );
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(SECRET);
  });

  it("follows grammY's HttpError into the network error that holds the URL", () => {
    const error = networkError('getUpdates', URL_WITH_TOKEN);
    expect(error).toBeInstanceOf(HttpError);
    const out = redact(error, TOKEN);
    expect(out).toContain("Network request for 'getUpdates' failed!");
    expect(out).toContain('ECONNREFUSED'); // the useful part survives
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(SECRET);
  });

  it('follows the cause chain, however deep', () => {
    const inner = new Error(`socket hang up (${URL_WITH_TOKEN})`);
    const middle = new Error('fetch failed', { cause: inner });
    const outer = new Error('polling failed', { cause: middle });
    const out = redact(outer, TOKEN);
    expect(out).toContain('polling failed');
    expect(out).toContain('fetch failed');
    expect(out).toContain('socket hang up');
    expect(out).not.toContain(SECRET);
  });

  it('survives a cause that points back at the error', () => {
    const error = new Error(`x ${TOKEN}`);
    (error as { cause?: unknown }).cause = error;
    expect(redact(error, TOKEN)).not.toContain(SECRET);
  });

  it('describes a GrammyError by what Telegram said', () => {
    const error = new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
      'sendMessage',
      { chat_id: 1, text: 'hi' },
    );
    expect(redact(error, TOKEN)).toContain('403: Forbidden: bot was blocked by the user');
  });

  it('keeps the top of the stack of a plain error, which is what finds a bug', () => {
    const out = redact(new TypeError('x is not a function'), TOKEN);
    expect(out).toContain('TypeError: x is not a function');
    expect(out).toMatch(/\n\s+at /);
  });

  it('hides the token in a stack as well', () => {
    const error = new Error('boom');
    error.stack = `Error: boom\n    at ${URL_WITH_TOKEN} (file.js:1:1)`;
    expect(redact(error, TOKEN)).not.toContain(SECRET);
  });

  it('describes things that are not errors, and hides the token in them', () => {
    expect(redact('plain text', TOKEN)).toBe('plain text');
    expect(redact(42, TOKEN)).toBe('42');
    expect(redact(null, TOKEN)).toBe('null');
    expect(redact(undefined, TOKEN)).toBe('undefined');
    expect(redact({ url: URL_WITH_TOKEN, token: TOKEN }, TOKEN)).not.toContain(SECRET);
    const circular: Record<string, unknown> = { token: TOKEN };
    circular['self'] = circular;
    expect(redact(circular, TOKEN)).not.toContain(SECRET); // JSON.stringify throws: String(...) is used
  });

  it('hides anything shaped like a token, also one it was not told about (another bot, an old token)', () => {
    const other = '987654321:BBOtherBotTokenAbcdefghijklmnop-_';
    expect(redact(`https://api.telegram.org/bot${other}/getMe`, TOKEN)).toBe(
      'https://api.telegram.org/bot[redacted]/getMe',
    );
    expect(redact(`leaked ${other} here`, TOKEN)).toBe('leaked [redacted] here');
    expect(redact(`leaked ${other} here`, undefined)).toBe('leaked [redacted] here');
  });

  it('hides a token that is malformed, in a URL, when it is the configured one', () => {
    expect(redact('GET https://api.telegram.org/botnotatoken/getMe', 'notatoken')).toBe(
      'GET https://api.telegram.org/bot[redacted]/getMe',
    );
  });

  it('does not mangle ordinary text: times, numbers and bot-like words', () => {
    const text = 'Spent 12:30 on 2026-03-15, 123456 items, /bots, /bother and chat 4242';
    expect(redact(text, TOKEN)).toBe(text);
  });
});

describe('createTelegramLog', () => {
  it('writes one redacted line per call, with a prefix, to the sink, as a string', () => {
    const sink = { log: vi.fn(), error: vi.fn() };
    const log = createTelegramLog(TOKEN, sink);
    log.info(`connecting with ${TOKEN}`);
    log.error('could not poll', networkError('getUpdates', URL_WITH_TOKEN));
    log.error('no error object');
    expect(sink.log).toHaveBeenCalledWith('Telegram: connecting with [redacted]');
    const [line] = sink.error.mock.calls[0] ?? [];
    expect(typeof line).toBe('string');
    expect(line).toMatch(/^Telegram: could not poll: HttpError: /);
    expect(line).not.toContain(SECRET);
    expect(sink.error).toHaveBeenLastCalledWith('Telegram: no error object');
    for (const [args] of [...sink.log.mock.calls, ...sink.error.mock.calls]) {
      expect(JSON.stringify(args)).not.toContain(SECRET);
    }
  });

  it('writes to the console by default', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const logger = createTelegramLog(TOKEN);
      logger.info('hello');
      logger.error('failed', new Error(TOKEN));
      expect(log).toHaveBeenCalledWith('Telegram: hello');
      expect(JSON.stringify(error.mock.calls)).not.toContain(SECRET);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe('the whole runtime, through every kind of failure', () => {
  const CONSOLE_METHODS = ['log', 'error', 'warn', 'info', 'debug'] as const;
  let spies: Record<(typeof CONSOLE_METHODS)[number], ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    spies = Object.fromEntries(
      CONSOLE_METHODS.map((method) => [
        method,
        vi.spyOn(console, method).mockImplementation(() => undefined),
      ]),
    ) as typeof spies;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Everything the console was given, as one string. */
  const consoleOutput = () =>
    CONSOLE_METHODS.flatMap((method) =>
      spies[method].mock.calls.map((args: unknown[]) => JSON.stringify(args)),
    ).join('\n');

  /** Real timers (supertest needs them) and a retry delay of a few milliseconds. */
  const eventually = (check: () => void) => vi.waitFor(check, { timeout: 3000, interval: 5 });

  function setUp() {
    const db = createDb(':memory:');
    runMigrations(db);
    const clock = mutableClock('2026-03-15T10:00:00Z');
    linkTelegramAccount(db, OWNER);
    const fake = new FakeBotApi();
    const runtime = createTelegramRuntime({
      db,
      clock,
      // No sink: the runtime logs to the console, which is spied on above.
      config: {
        telegramBotToken: TOKEN,
        telegramApiRoot: 'https://api.telegram.org',
        appUrl: undefined,
      },
      transformer: fake.transformer,
      backoff: { initialMs: 5, maxMs: 20 },
    });
    const app = createApp({
      db,
      clock,
      config: { env: 'test', staticDir: undefined },
      telegram: runtime,
    });
    return { db, fake, runtime, app };
  }

  it('logs and answers nothing that contains the token', async () => {
    const { fake, runtime, app } = setUp();
    await onboard(app);
    const bodies: string[] = [];
    const record = (res: request.Response) => bodies.push(res.text + JSON.stringify(res.headers));

    // A network error whose message holds the URL; a handler that throws an error carrying the token;
    // failed sends (a network error, a 403 whose text holds the token); a 409; another network error.
    fake.answerOnce('deleteWebhook', () => {
      throw networkError('deleteWebhook', `https://api.telegram.org/bot${TOKEN}/deleteWebhook`);
    });
    runtime.start();
    await eventually(() => expect(runtime.status().problem).toBe('unreachable'));
    record(await request(app).get('/api/telegram'));
    await eventually(() => expect(runtime.status().connection).toBe('running'));

    fake.answerOnce('sendMessage', () => {
      throw new Error(`handler blew up while calling ${URL_WITH_TOKEN} with ${TOKEN}`);
    });
    fake.push(messageUpdate('/help', { from: OWNER }));
    await eventually(() => expect(consoleOutput()).toContain('could not handle update'));

    fake.answerOnce('sendMessage', () => {
      throw networkError('sendMessage', `https://api.telegram.org/bot${TOKEN}/sendMessage`);
    });
    record(await request(app).post('/api/telegram/test'));

    fake.answerOnce(
      'sendMessage',
      botApiError(403, `Forbidden: bot was blocked by the user (${TOKEN})`),
    );
    record(await request(app).post('/api/telegram/test'));
    record(await request(app).get('/api/telegram'));
    expect(runtime.status().problem).toBe('blocked');

    fake.answerOnce(
      'getUpdates',
      botApiError(409, `Conflict: terminated by other getUpdates (${TOKEN})`),
    );
    fake.push(messageUpdate('hello', { from: OWNER }));
    await eventually(() => expect(consoleOutput()).toContain('another program is polling'));
    record(await request(app).get('/api/telegram'));
    await eventually(() => expect(runtime.status().connection).not.toBe('connecting'));

    fake.answerOnce('getUpdates', () => {
      throw networkError('getUpdates', URL_WITH_TOKEN);
    });
    fake.push(messageUpdate('hello', { from: OWNER }));
    await eventually(() => expect(consoleOutput()).toContain('cannot be reached'));
    record(await request(app).get('/api/telegram'));

    record(await request(app).post('/api/telegram/pairing'));
    record(await request(app).put('/api/telegram/notifications').send({ budgetAlerts: true }));
    record(await request(app).delete('/api/telegram/link'));
    record(await request(app).delete('/api/telegram/pairing'));

    await runtime.stop();

    // The failures really were logged...
    const output = consoleOutput();
    expect(output).toContain('Telegram: ');
    expect(output).toContain('ECONNREFUSED');
    expect(output).toContain('could not handle update');
    expect(output).toContain('[redacted]');
    // ...and neither they nor any response contain the token, or its secret half, or any form of it.
    for (const text of [output, ...bodies]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(encodeURIComponent(TOKEN));
      expect(text).not.toMatch(/\d{5,}:[A-Za-z0-9_-]{20,}/);
    }
  });

  it('keeps the token out of the error response of a failing test message', async () => {
    const { fake, runtime, app } = setUp();
    await onboard(app);
    runtime.start();
    await eventually(() => expect(runtime.status().connection).toBe('running'));
    fake.answerOnce('sendMessage', () => {
      throw networkError('sendMessage', `https://api.telegram.org/bot${TOKEN}/sendMessage`);
    });
    const res = await request(app).post('/api/telegram/test');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: { code: 'telegram_unavailable', message: 'Telegram did not accept the message' },
    });
    await runtime.stop();
  });
});
