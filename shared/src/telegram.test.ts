import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TELEGRAM_NOTIFICATIONS,
  TELEGRAM_CONNECTION_STATES,
  TELEGRAM_NOTIFY_AT_PATTERN,
  TELEGRAM_PROBLEMS,
  TELEGRAM_RENEWAL_DAYS_MAX,
  TELEGRAM_RENEWAL_DAYS_MIN,
  type TelegramStatusDto,
  telegramNotificationSettingsInputSchema,
  telegramNotifyAtSchema,
  telegramRenewalDaysSchema,
} from './telegram';
import { parseCases, schemaCases } from './test-utils';

const validBody = {
  budgetAlerts: true,
  renewalYearlyDays: 7,
  renewalMonthlyDays: 1,
  monthlyRecap: true,
  notifyAt: '09:00',
};

describe('telegramRenewalDaysSchema', () => {
  schemaCases(
    'days',
    telegramRenewalDaysSchema,
    [
      ['zero (the reminder is off)', 0],
      ['one', 1],
      ['the yearly default', 7],
      ['the maximum', 30],
    ],
    [
      ['below the minimum', -1, ''],
      ['above the maximum', 31, ''],
      ['far above the maximum', 365, ''],
      ['a fraction', 7.5, ''],
      ['a string', '7', ''],
      ['null', null, ''],
      ['not a number', Number.NaN, ''],
      ['infinity', Number.POSITIVE_INFINITY, ''],
      ['a boolean', true, ''],
    ],
  );

  it('has the documented bounds', () => {
    expect(TELEGRAM_RENEWAL_DAYS_MIN).toBe(0);
    expect(TELEGRAM_RENEWAL_DAYS_MAX).toBe(30);
  });
});

describe('telegramNotifyAtSchema', () => {
  schemaCases(
    'notifyAt',
    telegramNotifyAtSchema,
    [
      ['midnight', '00:00'],
      ['the default', '09:00'],
      ['noon', '12:00'],
      ['the last minute of the day', '23:59'],
      ['the last hour', '23:00'],
      ['the first hour', '01:05'],
      ['minute 59', '10:59'],
      ['hour 19', '19:30'],
    ],
    [
      ['an hour of 24', '24:00', ''],
      ['an hour above 24', '25:00', ''],
      ['a minute of 60', '09:60', ''],
      ['a minute above 60', '09:99', ''],
      ['a one-digit hour', '9:00', ''],
      ['a one-digit minute', '09:0', ''],
      ['no colon', '0900', ''],
      ['a dot for the colon', '09.00', ''],
      ['a dash for the colon', '09-00', ''],
      ['seconds', '09:00:00', ''],
      ['a 12-hour clock with PM', '9:00 PM', ''],
      ['a 12-hour clock with AM', '09:00 AM', ''],
      ['a space before it (it is not trimmed)', ' 09:00', ''],
      ['a space after it (it is not trimmed)', '09:00 ', ''],
      ['a line break after it', '09:00\n', ''],
      ['a negative hour', '-1:00', ''],
      ['an empty string', '', ''],
      ['a word', 'noon', ''],
      ['a full-width digit', '０９:００', ''],
      ['Arabic-Indic digits', '٠٩:٠٠', ''],
      ['an ISO date time', '2026-10-05T09:00', ''],
      ['a number', 900, ''],
      ['null', null, ''],
    ],
  );

  it('matches every minute of the day and nothing else', () => {
    let accepted = 0;
    for (let hour = 0; hour < 24; hour++) {
      for (let minute = 0; minute < 60; minute++) {
        const text = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        expect(TELEGRAM_NOTIFY_AT_PATTERN.test(text), text).toBe(true);
        accepted += 1;
      }
    }
    expect(accepted).toBe(24 * 60);
    // The two-digit hour and minute that are not on a clock.
    for (let hour = 24; hour < 100; hour++) {
      expect(TELEGRAM_NOTIFY_AT_PATTERN.test(`${hour}:00`), `${hour}:00`).toBe(false);
    }
    for (let minute = 60; minute < 100; minute++) {
      expect(TELEGRAM_NOTIFY_AT_PATTERN.test(`09:${minute}`), `09:${minute}`).toBe(false);
    }
  });
});

describe('telegramNotificationSettingsInputSchema (PUT /api/telegram/notifications)', () => {
  schemaCases(
    'body',
    telegramNotificationSettingsInputSchema,
    [
      ['the defaults', validBody],
      [
        'everything off',
        {
          budgetAlerts: false,
          renewalYearlyDays: 0,
          renewalMonthlyDays: 0,
          monthlyRecap: false,
          notifyAt: '00:00',
        },
      ],
      [
        'the largest values',
        {
          budgetAlerts: true,
          renewalYearlyDays: 30,
          renewalMonthlyDays: 30,
          monthlyRecap: true,
          notifyAt: '23:59',
        },
      ],
      ['a monthly lead longer than the yearly one', { ...validBody, renewalMonthlyDays: 14 }],
      ['alerts on and the recap off', { ...validBody, monthlyRecap: false }],
    ],
    [
      ['an empty body', {}, 'budgetAlerts'],
      ['a missing budgetAlerts', { ...validBody, budgetAlerts: undefined }, 'budgetAlerts'],
      [
        'a missing renewalYearlyDays',
        { ...validBody, renewalYearlyDays: undefined },
        'renewalYearlyDays',
      ],
      [
        'a missing renewalMonthlyDays',
        { ...validBody, renewalMonthlyDays: undefined },
        'renewalMonthlyDays',
      ],
      ['a missing monthlyRecap', { ...validBody, monthlyRecap: undefined }, 'monthlyRecap'],
      ['a missing notifyAt', { ...validBody, notifyAt: undefined }, 'notifyAt'],
      ['budgetAlerts as a string', { ...validBody, budgetAlerts: 'true' }, 'budgetAlerts'],
      ['budgetAlerts as a number', { ...validBody, budgetAlerts: 1 }, 'budgetAlerts'],
      ['budgetAlerts as null', { ...validBody, budgetAlerts: null }, 'budgetAlerts'],
      ['monthlyRecap as a string', { ...validBody, monthlyRecap: 'false' }, 'monthlyRecap'],
      ['monthlyRecap as 0', { ...validBody, monthlyRecap: 0 }, 'monthlyRecap'],
      ['yearly days below 0', { ...validBody, renewalYearlyDays: -1 }, 'renewalYearlyDays'],
      ['yearly days above 30', { ...validBody, renewalYearlyDays: 31 }, 'renewalYearlyDays'],
      ['monthly days below 0', { ...validBody, renewalMonthlyDays: -1 }, 'renewalMonthlyDays'],
      ['monthly days above 30', { ...validBody, renewalMonthlyDays: 31 }, 'renewalMonthlyDays'],
      ['yearly days as a fraction', { ...validBody, renewalYearlyDays: 6.5 }, 'renewalYearlyDays'],
      ['monthly days as a string', { ...validBody, renewalMonthlyDays: '1' }, 'renewalMonthlyDays'],
      ['notifyAt 24:00', { ...validBody, notifyAt: '24:00' }, 'notifyAt'],
      ['notifyAt 9:00', { ...validBody, notifyAt: '9:00' }, 'notifyAt'],
      ['notifyAt with seconds', { ...validBody, notifyAt: '09:00:00' }, 'notifyAt'],
      ['notifyAt 09:60', { ...validBody, notifyAt: '09:60' }, 'notifyAt'],
      ['notifyAt as a number', { ...validBody, notifyAt: 900 }, 'notifyAt'],
      ['an unknown key', { ...validBody, timezone: 'UTC' }, ''],
      ['an id in the body', { ...validBody, id: 1 }, ''],
      ['an array', [validBody], ''],
      ['null', null, ''],
    ],
  );

  parseCases('output', telegramNotificationSettingsInputSchema, [
    ['keeps every value as it was sent', validBody, validBody],
    [
      'does not coerce, trim or round anything',
      { ...validBody, notifyAt: '23:59', renewalYearlyDays: 30, renewalMonthlyDays: 0 },
      { ...validBody, notifyAt: '23:59', renewalYearlyDays: 30, renewalMonthlyDays: 0 },
    ],
  ]);
});

describe('DEFAULT_TELEGRAM_NOTIFICATIONS', () => {
  it('are the documented defaults', () => {
    expect(DEFAULT_TELEGRAM_NOTIFICATIONS).toEqual({
      budgetAlerts: true,
      renewalYearlyDays: 7,
      renewalMonthlyDays: 1,
      monthlyRecap: true,
      notifyAt: '09:00',
    });
  });

  it('are a valid body of PUT /api/telegram/notifications', () => {
    const result = telegramNotificationSettingsInputSchema.safeParse(
      DEFAULT_TELEGRAM_NOTIFICATIONS,
    );
    expect(result.error?.issues).toBeUndefined();
    expect(result.data).toEqual(DEFAULT_TELEGRAM_NOTIFICATIONS);
  });

  it('are frozen, so no caller can change the defaults of the process', () => {
    expect(Object.isFrozen(DEFAULT_TELEGRAM_NOTIFICATIONS)).toBe(true);
    const copy = { ...DEFAULT_TELEGRAM_NOTIFICATIONS, renewalYearlyDays: 14 };
    expect(copy.renewalYearlyDays).toBe(14);
    expect(DEFAULT_TELEGRAM_NOTIFICATIONS.renewalYearlyDays).toBe(7);
  });
});

describe('the status vocabulary', () => {
  it('lists the connection states of the plan, in order', () => {
    expect([...TELEGRAM_CONNECTION_STATES]).toEqual(['off', 'connecting', 'running', 'error']);
  });

  it('lists the problems of the plan, in order', () => {
    expect([...TELEGRAM_PROBLEMS]).toEqual(['invalid_token', 'conflict', 'unreachable', 'blocked']);
  });
});

describe('TelegramStatusDto, the states Settings shows', () => {
  // These are type-checked examples as much as runtime ones: each object must satisfy the DTO.
  const notConfigured = {
    configured: false,
    connection: 'off',
    problem: null,
    bot: null,
    link: null,
    pairing: null,
    notifications: DEFAULT_TELEGRAM_NOTIFICATIONS,
  } satisfies TelegramStatusDto;

  const wrongToken = {
    ...notConfigured,
    configured: true,
    connection: 'error',
    problem: 'invalid_token',
  } satisfies TelegramStatusDto;

  const waitingForTheCode = {
    configured: true,
    connection: 'running',
    problem: null,
    bot: { username: 'my_wallet_bot' },
    link: null,
    pairing: {
      code: 'K7M2QX9P',
      expiresAt: '2026-10-05T10:10:00.000Z',
      deepLink: 'https://t.me/my_wallet_bot?start=K7M2QX9P',
    },
    notifications: DEFAULT_TELEGRAM_NOTIFICATIONS,
  } satisfies TelegramStatusDto;

  const linked = {
    configured: true,
    connection: 'running',
    problem: null,
    bot: { username: 'my_wallet_bot' },
    link: { name: 'Anna', username: null, linkedAt: '2026-10-05T10:04:12.000Z' },
    pairing: null,
    notifications: { ...DEFAULT_TELEGRAM_NOTIFICATIONS, renewalYearlyDays: 14 },
  } satisfies TelegramStatusDto;

  it('has a problem exactly when the connection is in error', () => {
    for (const status of [notConfigured, wrongToken, waitingForTheCode, linked] as const) {
      expect(status.problem !== null).toBe(status.connection === 'error');
    }
  });

  it('never carries the bot token: no field of it is named like one', () => {
    // `problem: 'invalid_token'` is a value and is fine; a key that could hold the secret is not.
    const keysOf = (value: unknown): string[] =>
      value !== null && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)])
        : [];
    for (const status of [notConfigured, wrongToken, waitingForTheCode, linked]) {
      expect(keysOf(status).filter((key) => /token|secret/i.test(key))).toEqual([]);
    }
  });

  it('keeps the deep link next to the code it carries', () => {
    expect(waitingForTheCode.pairing.deepLink).toContain(waitingForTheCode.pairing.code);
  });
});
