import { describe, expect, it } from 'vitest';
import {
  MAX_START_MONTH_AGE_MONTHS,
  alertWarnPercentSchema,
  currencySchema,
  localeSchema,
  settingsInputSchema,
  themeSchema,
} from './settings';
import { chars, schemaCases } from './test-utils';

const validSettings = {
  currency: 'EUR',
  locale: 'it-IT',
  startMonth: '2026-10',
  theme: 'system',
  alertWarnPercent: 80,
};

describe('settings schemas', () => {
  schemaCases(
    'currencySchema',
    currencySchema,
    [
      ['euro', 'EUR'],
      ['dollar', 'USD'],
    ],
    [
      ['lower case', 'eur', ''],
      ['two letters', 'EU', ''],
      ['four letters', 'EURO', ''],
      ['a digit', 'E1R', ''],
      ['empty', '', ''],
      ['a number', 978, ''],
    ],
  );

  schemaCases(
    'localeSchema',
    localeSchema,
    [
      ['language and region', 'en-US'],
      ['language only', 'it'],
      ['with a script', 'zh-Hant-TW'],
      ['with an extension', 'de-CH-u-nu-latn'],
    ],
    [
      ['an underscore', 'en_US', ''],
      ['empty', '', ''],
      ['free text', 'not a locale', ''],
      ['a one-letter language', 'x', ''],
      ['a list', 'en-US,it-IT', ''],
      ['the wildcard', '*', ''],
      ['too long', `en-${chars(40)}`, ''],
      ['a number', 5, ''],
    ],
  );

  schemaCases(
    'themeSchema',
    themeSchema,
    [
      ['system', 'system'],
      ['light', 'light'],
      ['dark', 'dark'],
    ],
    [
      ['an unknown theme', 'blue', ''],
      ['wrong case', 'Dark', ''],
    ],
  );

  schemaCases(
    'alertWarnPercentSchema',
    alertWarnPercentSchema,
    [
      ['the minimum', 1],
      ['the default', 80],
      ['the maximum', 100],
    ],
    [
      ['zero', 0, ''],
      ['above 100', 101, ''],
      ['a fraction', 79.5, ''],
      ['a string', '80', ''],
      ['negative', -5, ''],
    ],
  );

  schemaCases(
    'settingsInputSchema (PUT /api/settings)',
    settingsInputSchema,
    [
      ['a full body', validSettings],
      ['other values', { ...validSettings, currency: 'USD', locale: 'en-US', theme: 'dark' }],
    ],
    [
      ['an empty body', {}, 'currency'],
      ['a missing currency', { ...validSettings, currency: undefined }, 'currency'],
      ['a missing locale', { ...validSettings, locale: undefined }, 'locale'],
      ['a missing startMonth', { ...validSettings, startMonth: undefined }, 'startMonth'],
      ['a missing theme', { ...validSettings, theme: undefined }, 'theme'],
      [
        'a missing alertWarnPercent',
        { ...validSettings, alertWarnPercent: undefined },
        'alertWarnPercent',
      ],
      ['a bad currency', { ...validSettings, currency: 'euro' }, 'currency'],
      ['a bad locale', { ...validSettings, locale: 'it_IT' }, 'locale'],
      ['a bad startMonth', { ...validSettings, startMonth: '2026-13' }, 'startMonth'],
      ['a bad theme', { ...validSettings, theme: 'neon' }, 'theme'],
      ['a bad percent', { ...validSettings, alertWarnPercent: 0 }, 'alertWarnPercent'],
      ['an unknown key', { ...validSettings, id: 1 }, ''],
    ],
  );

  it('allows a start month at most 20 years back', () => {
    expect(MAX_START_MONTH_AGE_MONTHS).toBe(240);
  });
});
