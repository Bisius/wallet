import {
  DEFAULT_TELEGRAM_NOTIFICATIONS,
  type TelegramNotificationSettingsInput,
  type TelegramPairingDto,
  type TelegramStatusDto,
} from '@wallet/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { telegramNotifications, telegramPairing, telegramSettings } from '../../db/schema';
import { OWNER } from '../../testing/fake-bot-api';
import { createTelegramTestApp, linkTelegramAccount } from '../../testing/fake-telegram';
import { dumpDb } from '../../testing/db-dump';
import {
  expectApiError,
  expectValidationError,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import { createTestApp } from '../../testing/test-app';
import { PAIRING_CODE_ALPHABET } from './telegram.access';
import { NO_LONGER_LINKED_TEXT, WALLET_CONNECTED_TEXT } from './telegram.messages';
import { recordAlertBaseline } from './telegram.notifications';
import { TelegramSendError } from './telegram.types';

// The service calls the baseline of the alert watcher (T3's) when alerts are switched on: watch it.
vi.mock('./telegram.notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./telegram.notifications')>()),
  recordAlertBaseline: vi.fn(),
}));

const NOW = '2026-03-15T10:00:00Z';
const PREFS: TelegramNotificationSettingsInput = {
  budgetAlerts: false,
  renewalYearlyDays: 14,
  renewalMonthlyDays: 2,
  monthlyRecap: false,
  notifyAt: '07:30',
};

type Setup = ReturnType<typeof createTelegramTestApp>;
let s: Setup;
let clock: ReturnType<typeof mutableClock>;

async function setUp(status: Parameters<typeof createTelegramTestApp>[1] = {}): Promise<Setup> {
  clock = mutableClock(NOW);
  s = createTelegramTestApp(clock, status);
  await onboard(s.app);
  return s;
}

const get = async (app = s.app) =>
  (await request(app).get('/api/telegram').expect(200)).body as TelegramStatusDto;

beforeEach(async () => {
  vi.mocked(recordAlertBaseline).mockReset();
  await setUp();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/telegram', () => {
  it('with no bot (no token) says so, and still answers', async () => {
    const { app } = createTestApp(mutableClock(NOW));
    await onboard(app);
    expect(await get(app)).toEqual({
      configured: false,
      connection: 'off',
      problem: null,
      bot: null,
      link: null,
      pairing: null,
      notifications: DEFAULT_TELEGRAM_NOTIFICATIONS,
    });
  });

  it('with a running bot reports the bot, no link, no code and the default preferences', async () => {
    expect(await get()).toEqual({
      configured: true,
      connection: 'running',
      problem: null,
      bot: { username: 'wallet_test_bot' },
      link: null,
      pairing: null,
      notifications: { ...DEFAULT_TELEGRAM_NOTIFICATIONS },
    });
  });

  it.each([
    ['connecting', null, null],
    ['error', 'invalid_token', 'wallet_test_bot'],
    ['error', 'conflict', 'wallet_test_bot'],
    ['error', 'unreachable', 'wallet_test_bot'],
    ['error', 'blocked', 'wallet_test_bot'],
  ] as const)(
    'reports the connection %s with problem %s as the runtime says it',
    async (connection, problem, bot) => {
      s.telegram.setStatus({ connection, problem, bot: bot ? { username: bot } : null });
      const status = await get();
      expect(status).toMatchObject({ configured: true, connection, problem });
      expect(status.bot).toEqual(bot ? { username: bot } : null);
    },
  );

  it('reports the link as name, username and linkedAt, and nothing else of it', async () => {
    linkTelegramAccount(s.db, OWNER, '2026-03-10T08:15:00.000Z');
    const { link } = await get();
    expect(link).toEqual({
      name: 'Olivia',
      username: 'olivia',
      linkedAt: '2026-03-10T08:15:00.000Z',
    });
  });

  it('reports a null username for an account that has none', async () => {
    linkTelegramAccount(s.db, { id: 7, first_name: 'Sam' });
    expect((await get()).link).toEqual({
      name: 'Sam',
      username: null,
      linkedAt: '2026-03-01T08:00:00.000Z',
    });
  });

  it('still shows a link when the bot is off (a restored backup)', async () => {
    const { app, db } = createTestApp(mutableClock(NOW));
    await onboard(app);
    linkTelegramAccount(db, OWNER);
    expect(await get(app)).toMatchObject({ configured: false, link: { name: 'Olivia' } });
  });

  it('answers 409 not_onboarded before onboarding', async () => {
    const fresh = createTelegramTestApp(mutableClock(NOW));
    expectApiError(await request(fresh.app).get('/api/telegram'), 'not_onboarded');
  });
});

describe('POST /api/telegram/pairing', () => {
  it('makes a code of 8 characters without 0, O, 1 and I, valid for 10 minutes', async () => {
    const res = await request(s.app).post('/api/telegram/pairing').expect(201);
    const body = res.body as TelegramPairingDto;
    expect(Object.keys(body).sort()).toEqual(['code', 'deepLink', 'expiresAt']);
    expect(body.code).toMatch(new RegExp(`^[${PAIRING_CODE_ALPHABET}]{8}$`));
    expect(body.code).not.toMatch(/[01OI]/);
    expect(body.expiresAt).toBe('2026-03-15T10:10:00.000Z');
    expect(body.deepLink).toBe(`https://t.me/wallet_test_bot?start=${body.code}`);
  });

  it('is then reported as pending by GET, the same code', async () => {
    const made = (await request(s.app).post('/api/telegram/pairing').expect(201)).body;
    expect((await get()).pairing).toEqual(made);
  });

  it('has a null deepLink until the bot has told its username', async () => {
    s.telegram.setStatus({ connection: 'connecting', bot: null });
    const made = (await request(s.app).post('/api/telegram/pairing').expect(201)).body;
    expect(made.deepLink).toBeNull();
    expect((await get()).pairing).toMatchObject({ code: made.code, deepLink: null });
    s.telegram.setStatus({ connection: 'running', bot: { username: 'wallet_test_bot' } });
    expect((await get()).pairing?.deepLink).toBe(`https://t.me/wallet_test_bot?start=${made.code}`);
  });

  it('replaces a pending code: one row, with a new code, a new expiry and no failed tries', async () => {
    const first = (await request(s.app).post('/api/telegram/pairing').expect(201)).body;
    s.db.update(telegramPairing).set({ failedAttempts: 3 }).run();
    clock.set('2026-03-15T10:04:00Z');
    const second = (await request(s.app).post('/api/telegram/pairing').expect(201)).body;
    expect(second.code).not.toBe(first.code);
    expect(second.expiresAt).toBe('2026-03-15T10:14:00.000Z');
    const rows = s.db.select().from(telegramPairing).all();
    expect(rows).toEqual([
      { id: 1, code: second.code, expiresAt: '2026-03-15T10:14:00.000Z', failedAttempts: 0 },
    ]);
    expect((await get()).pairing?.code).toBe(second.code);
  });

  it('draws different codes', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      codes.add((await request(s.app).post('/api/telegram/pairing').expect(201)).body.code);
    }
    expect(codes.size).toBeGreaterThan(15);
  });

  it('is not pending any more once it has expired, by the clock, to the millisecond', async () => {
    await request(s.app).post('/api/telegram/pairing').expect(201);
    clock.set('2026-03-15T10:09:59.999Z');
    expect((await get()).pairing).not.toBeNull();
    clock.set('2026-03-15T10:10:00.000Z');
    expect((await get()).pairing).toBeNull();
    clock.set('2026-03-16T10:00:00Z');
    expect((await get()).pairing).toBeNull();
  });

  it('answers 409 telegram_not_configured without a token, and stores nothing', async () => {
    const { app, db } = createTestApp(mutableClock(NOW));
    await onboard(app);
    const before = dumpDb(db);
    expectApiError(await request(app).post('/api/telegram/pairing'), 'telegram_not_configured');
    expect(dumpDb(db)).toBe(before);
  });

  it('works while the bot has a problem: only a missing token refuses', async () => {
    s.telegram.setStatus({ connection: 'error', problem: 'invalid_token' });
    await request(s.app).post('/api/telegram/pairing').expect(201);
  });

  it('answers 409 not_onboarded before onboarding', async () => {
    const fresh = createTelegramTestApp(mutableClock(NOW));
    expectApiError(await request(fresh.app).post('/api/telegram/pairing'), 'not_onboarded');
  });
});

describe('DELETE /api/telegram/pairing', () => {
  it('cancels the pending code with a 204', async () => {
    await request(s.app).post('/api/telegram/pairing').expect(201);
    await request(s.app).delete('/api/telegram/pairing').expect(204);
    expect((await get()).pairing).toBeNull();
    expect(s.db.select().from(telegramPairing).all()).toEqual([]);
  });

  it('answers 204 again, and when there never was a code', async () => {
    await request(s.app).delete('/api/telegram/pairing').expect(204);
    await request(s.app).post('/api/telegram/pairing').expect(201);
    await request(s.app).delete('/api/telegram/pairing').expect(204);
    await request(s.app).delete('/api/telegram/pairing').expect(204);
  });

  it('answers 204 with no token as well', async () => {
    const { app } = createTestApp(mutableClock(NOW));
    await onboard(app);
    await request(app).delete('/api/telegram/pairing').expect(204);
  });

  it('answers 409 not_onboarded before onboarding', async () => {
    const fresh = createTelegramTestApp(mutableClock(NOW));
    expectApiError(await request(fresh.app).delete('/api/telegram/pairing'), 'not_onboarded');
  });
});

describe('DELETE /api/telegram/link', () => {
  it('answers 404 not_found when nothing is linked', async () => {
    expectApiError(await request(s.app).delete('/api/telegram/link'), 'not_found');
    expect(s.telegram.attempts).toEqual([]);
  });

  it('removes the link with a 204, and tells the old chat, best effort', async () => {
    linkTelegramAccount(s.db, OWNER);
    await request(s.app).delete('/api/telegram/link').expect(204);
    expect((await get()).link).toBeNull();
    expect(s.telegram.sent).toEqual([
      { chatId: OWNER.id, text: NO_LONGER_LINKED_TEXT, extra: undefined },
    ]);
  });

  it('answers 404 the second time', async () => {
    linkTelegramAccount(s.db, OWNER);
    await request(s.app).delete('/api/telegram/link').expect(204);
    expectApiError(await request(s.app).delete('/api/telegram/link'), 'not_found');
    expect(s.telegram.attempts).toHaveLength(1);
  });

  it('is a 204 even when the notice cannot be sent', async () => {
    linkTelegramAccount(s.db, OWNER);
    s.telegram.failNextSend(new TelegramSendError('refused', 'Forbidden: bot was blocked'));
    await request(s.app).delete('/api/telegram/link').expect(204);
    expect((await get()).link).toBeNull();
    expect(s.telegram.sent).toEqual([]);
    expect(s.telegram.attempts).toHaveLength(1);
  });

  it('is a 204 when the bot is not running or off, and sends nothing', async () => {
    s.telegram.setStatus({ connection: 'error', problem: 'unreachable' });
    linkTelegramAccount(s.db, OWNER);
    await request(s.app).delete('/api/telegram/link').expect(204);

    const { app, db } = createTestApp(mutableClock(NOW));
    await onboard(app);
    linkTelegramAccount(db, OWNER);
    await request(app).delete('/api/telegram/link').expect(204);
  });

  it('keeps the notification preferences, and a pending code', async () => {
    await request(s.app).put('/api/telegram/notifications').send(PREFS).expect(200);
    const code = (await request(s.app).post('/api/telegram/pairing').expect(201)).body.code;
    linkTelegramAccount(s.db, OWNER);
    await request(s.app).delete('/api/telegram/link').expect(204);
    const status = await get();
    expect(status.notifications).toEqual(PREFS);
    expect(status.pairing?.code).toBe(code);
  });

  it('answers 409 not_onboarded before onboarding', async () => {
    const fresh = createTelegramTestApp(mutableClock(NOW));
    expectApiError(await request(fresh.app).delete('/api/telegram/link'), 'not_onboarded');
  });
});

describe('PUT /api/telegram/notifications', () => {
  it('replaces the five preferences, answers them and keeps them', async () => {
    const res = await request(s.app).put('/api/telegram/notifications').send(PREFS).expect(200);
    expect(res.body).toEqual(PREFS);
    expect((await get()).notifications).toEqual(PREFS);
    const next = { ...PREFS, budgetAlerts: true, renewalYearlyDays: 0, notifyAt: '23:59' };
    expect(
      (await request(s.app).put('/api/telegram/notifications').send(next).expect(200)).body,
    ).toEqual(next);
    expect((await get()).notifications).toEqual(next);
    expect(s.db.select().from(telegramSettings).all()).toHaveLength(1);
  });

  it.each([
    [0, 0],
    [30, 30],
    [7, 1],
  ])('accepts yearly %i and monthly %i days', async (renewalYearlyDays, renewalMonthlyDays) => {
    const body = { ...PREFS, renewalYearlyDays, renewalMonthlyDays };
    expect(
      (await request(s.app).put('/api/telegram/notifications').send(body).expect(200)).body,
    ).toEqual(body);
  });

  it.each(['00:00', '09:00', '23:59'])('accepts the time %s', async (notifyAt) => {
    await request(s.app)
      .put('/api/telegram/notifications')
      .send({ ...PREFS, notifyAt })
      .expect(200);
  });

  it('needs neither a link nor a token', async () => {
    const { app } = createTestApp(mutableClock(NOW));
    await onboard(app);
    await request(app).put('/api/telegram/notifications').send(PREFS).expect(200);
    expect((await get(app)).notifications).toEqual(PREFS);
  });

  describe('validation (400)', () => {
    const missing = (key: keyof TelegramNotificationSettingsInput) => {
      const { [key]: _omitted, ...rest } = PREFS;
      return rest;
    };

    it.each([
      ['an empty body', {}, 'budgetAlerts'],
      ['no budgetAlerts', missing('budgetAlerts'), 'budgetAlerts'],
      ['no renewalYearlyDays', missing('renewalYearlyDays'), 'renewalYearlyDays'],
      ['no renewalMonthlyDays', missing('renewalMonthlyDays'), 'renewalMonthlyDays'],
      ['no monthlyRecap', missing('monthlyRecap'), 'monthlyRecap'],
      ['no notifyAt', missing('notifyAt'), 'notifyAt'],
      ['an unknown key', { ...PREFS, extra: 1 }, ''],
      ['a link smuggled in', { ...PREFS, chatId: 5 }, ''],
      ['a string for budgetAlerts', { ...PREFS, budgetAlerts: 'yes' }, 'budgetAlerts'],
      ['a number for monthlyRecap', { ...PREFS, monthlyRecap: 1 }, 'monthlyRecap'],
      ['negative yearly days', { ...PREFS, renewalYearlyDays: -1 }, 'renewalYearlyDays'],
      ['yearly days above 30', { ...PREFS, renewalYearlyDays: 31 }, 'renewalYearlyDays'],
      ['negative monthly days', { ...PREFS, renewalMonthlyDays: -1 }, 'renewalMonthlyDays'],
      ['monthly days above 30', { ...PREFS, renewalMonthlyDays: 31 }, 'renewalMonthlyDays'],
      ['fractional days', { ...PREFS, renewalMonthlyDays: 1.5 }, 'renewalMonthlyDays'],
      ['days as text', { ...PREFS, renewalYearlyDays: '7' }, 'renewalYearlyDays'],
      ['null days', { ...PREFS, renewalYearlyDays: null }, 'renewalYearlyDays'],
      ['a time without the leading zero', { ...PREFS, notifyAt: '9:00' }, 'notifyAt'],
      ['24:00', { ...PREFS, notifyAt: '24:00' }, 'notifyAt'],
      ['minute 60', { ...PREFS, notifyAt: '09:60' }, 'notifyAt'],
      ['a time with seconds', { ...PREFS, notifyAt: '09:00:00' }, 'notifyAt'],
      ['a 12-hour time', { ...PREFS, notifyAt: '9:00 PM' }, 'notifyAt'],
      ['a time with spaces around it', { ...PREFS, notifyAt: ' 09:00 ' }, 'notifyAt'],
      ['a time with a line break', { ...PREFS, notifyAt: '09:00\n' }, 'notifyAt'],
      ['an empty time', { ...PREFS, notifyAt: '' }, 'notifyAt'],
      ['a time that is a number', { ...PREFS, notifyAt: 900 }, 'notifyAt'],
    ])('rejects %s', async (_label, body, path) => {
      await request(s.app).put('/api/telegram/notifications').send(PREFS).expect(200);
      const before = dumpDb(s.db);
      expectValidationError(
        await request(s.app).put('/api/telegram/notifications').send(body),
        path,
      );
      expect(dumpDb(s.db)).toBe(before); // nothing was stored
      expect(vi.mocked(recordAlertBaseline)).not.toHaveBeenCalled();
    });

    it('rejects a body that is not JSON', async () => {
      const res = await request(s.app)
        .put('/api/telegram/notifications')
        .set('Content-Type', 'application/json')
        .send('{"budgetAlerts":');
      expectApiError(res, 'invalid_json');
    });
  });

  describe('the baseline of the alert levels', () => {
    const put = (budgetAlerts: boolean) =>
      request(s.app)
        .put('/api/telegram/notifications')
        .send({ ...PREFS, budgetAlerts })
        .expect(200);

    it('is recorded when alerts are switched on from off, in the same call', async () => {
      await put(false);
      expect(recordAlertBaseline).not.toHaveBeenCalled();
      await put(true);
      expect(recordAlertBaseline).toHaveBeenCalledTimes(1);
    });

    it('is not recorded when alerts stay on, stay off, or are switched off', async () => {
      await put(true); // on from the default (on)
      await put(true);
      await put(false);
      await put(false);
      expect(recordAlertBaseline).not.toHaveBeenCalled();
    });

    it('is recorded again at the next switch on, and with no bot at all', async () => {
      await put(false);
      await put(true);
      await put(false);
      await put(true);
      expect(recordAlertBaseline).toHaveBeenCalledTimes(2);

      const { app } = createTestApp(mutableClock(NOW));
      await onboard(app);
      await request(app)
        .put('/api/telegram/notifications')
        .send({ ...PREFS, budgetAlerts: false })
        .expect(200);
      await request(app)
        .put('/api/telegram/notifications')
        .send({ ...PREFS, budgetAlerts: true })
        .expect(200);
      expect(recordAlertBaseline).toHaveBeenCalledTimes(3);
    });

    it('is undone with the preferences when the baseline fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined); // the 500 is logged
      await put(false);
      vi.mocked(recordAlertBaseline).mockImplementationOnce(() => {
        throw new Error('disk is full');
      });
      const before = dumpDb(s.db);
      await request(s.app)
        .put('/api/telegram/notifications')
        .send({ ...PREFS, budgetAlerts: true })
        .expect(500);
      expect(dumpDb(s.db)).toBe(before);
    });
  });

  it('answers 409 not_onboarded before onboarding, even for an invalid body', async () => {
    const fresh = createTelegramTestApp(mutableClock(NOW));
    expectApiError(
      await request(fresh.app).put('/api/telegram/notifications').send({}),
      'not_onboarded',
    );
  });
});

describe('POST /api/telegram/test', () => {
  const link = () => linkTelegramAccount(s.db, OWNER);

  it('sends "Wallet is connected" to the linked chat and answers 204 once Telegram accepted it', async () => {
    link();
    const res = await request(s.app).post('/api/telegram/test').expect(204);
    expect(res.text).toBe('');
    expect(s.telegram.sent).toEqual([
      { chatId: OWNER.id, text: WALLET_CONNECTED_TEXT, extra: undefined },
    ]);
    expect(WALLET_CONNECTED_TEXT).toContain('Wallet is connected');
  });

  it('answers 409 telegram_not_configured without a token', async () => {
    const { app } = createTestApp(mutableClock(NOW));
    await onboard(app);
    expectApiError(await request(app).post('/api/telegram/test'), 'telegram_not_configured');
  });

  it('answers 409 telegram_not_linked when nobody is linked, and sends nothing', async () => {
    expectApiError(await request(s.app).post('/api/telegram/test'), 'telegram_not_linked');
    expect(s.telegram.attempts).toEqual([]);
  });

  it('checks in the documented order: no token, then no link, then the bot', async () => {
    // Not linked beats a bot that is down.
    s.telegram.setStatus({ connection: 'error', problem: 'unreachable' });
    expectApiError(await request(s.app).post('/api/telegram/test'), 'telegram_not_linked');
    // No token beats everything.
    const { app, db } = createTestApp(mutableClock(NOW));
    await onboard(app);
    linkTelegramAccount(db, OWNER);
    expectApiError(await request(app).post('/api/telegram/test'), 'telegram_not_configured');
  });

  it.each([
    ['connecting', null],
    ['error', 'invalid_token'],
    ['error', 'conflict'],
    ['error', 'unreachable'],
    ['off', null],
  ] as const)(
    'answers 503 telegram_unavailable while the bot is %s (%s), without trying',
    async (connection, problem) => {
      link();
      s.telegram.setStatus({ connection, problem });
      expectApiError(await request(s.app).post('/api/telegram/test'), 'telegram_unavailable');
      expect(s.telegram.attempts).toEqual([]);
    },
  );

  it('answers 503 telegram_unavailable when Telegram refuses the message', async () => {
    link();
    s.telegram.failNextSend();
    expectApiError(await request(s.app).post('/api/telegram/test'), 'telegram_unavailable');
    await request(s.app).post('/api/telegram/test').expect(204); // and works again afterwards
  });

  it('never passes on what the failure said', async () => {
    link();
    s.telegram.failNextSend(
      new Error('GrammyError 403 on https://api.telegram.org/bot123456:SECRET/sendMessage'),
    );
    const res = await request(s.app).post('/api/telegram/test');
    expectApiError(res, 'telegram_unavailable');
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET|api\.telegram\.org|403/);
  });

  it('still tries while the bot is blocked: a send that goes through is how it finds out', async () => {
    link();
    s.telegram.setStatus({ connection: 'error', problem: 'blocked' });
    await request(s.app).post('/api/telegram/test').expect(204);
    expect(s.telegram.sent).toHaveLength(1);
    s.telegram.failNextSend();
    expectApiError(await request(s.app).post('/api/telegram/test'), 'telegram_unavailable');
  });

  it('answers 409 telegram_not_linked when the link vanishes before the send', async () => {
    link();
    s.telegram.failNextSend(new TelegramSendError('not_linked', 'No Telegram account is linked'));
    expectApiError(await request(s.app).post('/api/telegram/test'), 'telegram_not_linked');
  });

  it('answers 409 not_onboarded before onboarding', async () => {
    const fresh = createTelegramTestApp(mutableClock(NOW));
    expectApiError(await request(fresh.app).post('/api/telegram/test'), 'not_onboarded');
  });
});

describe('the tables of the bot', () => {
  it('start empty on a new database: nothing is created until something is saved', async () => {
    expect(s.db.select().from(telegramSettings).all()).toEqual([]);
    expect(s.db.select().from(telegramPairing).all()).toEqual([]);
    expect(s.db.select().from(telegramNotifications).all()).toEqual([]);
    await get();
    expect(s.db.select().from(telegramSettings).all()).toEqual([]); // reading does not write
  });

  it('is never touched by a refused request', async () => {
    const before = dumpDb(s.db);
    await request(s.app).put('/api/telegram/notifications').send({ nope: true }).expect(400);
    await request(s.app).delete('/api/telegram/link').expect(404);
    expect(dumpDb(s.db)).toBe(before);
  });
});
