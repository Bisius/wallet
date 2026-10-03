import { describe } from 'vitest';
import {
  subscriptionCancelSchema,
  subscriptionCreateSchema,
  subscriptionPriceSchema,
  subscriptionUpdateSchema,
} from './subscriptions';
import { parseCases, schemaCases } from './test-utils';

const netflix = {
  name: 'Netflix',
  frequency: 'monthly',
  anchorDate: '2026-10-15',
  amount: 1299,
};

describe('subscription schemas', () => {
  schemaCases(
    'subscriptionCreateSchema (POST /api/subscriptions)',
    subscriptionCreateSchema,
    [
      ['a monthly subscription', netflix],
      ['a yearly subscription', { ...netflix, name: 'Domain', frequency: 'yearly', amount: 12000 }],
      ['a day 31 anchor', { ...netflix, anchorDate: '2026-01-31' }],
      [
        'every field',
        { ...netflix, startMonth: '2026-09', color: '#e50914', notes: 'Family plan' },
      ],
      ['nulls for the optional fields', { ...netflix, color: null, notes: null }],
    ],
    [
      ['an empty body', {}, 'name'],
      ['a blank name', { ...netflix, name: ' ' }, 'name'],
      ['a missing frequency', { ...netflix, frequency: undefined }, 'frequency'],
      ['an unknown frequency', { ...netflix, frequency: 'weekly' }, 'frequency'],
      ['a missing anchorDate', { ...netflix, anchorDate: undefined }, 'anchorDate'],
      ['an impossible anchorDate', { ...netflix, anchorDate: '2026-02-30' }, 'anchorDate'],
      ['a month as anchorDate', { ...netflix, anchorDate: '2026-10' }, 'anchorDate'],
      ['a missing amount', { ...netflix, amount: undefined }, 'amount'],
      ['a zero amount', { ...netflix, amount: 0 }, 'amount'],
      ['a negative amount', { ...netflix, amount: -5 }, 'amount'],
      ['a fractional amount', { ...netflix, amount: 12.99 }, 'amount'],
      ['a bad startMonth', { ...netflix, startMonth: '2026-9' }, 'startMonth'],
      ['a bad color', { ...netflix, color: 'red' }, 'color'],
      ['an endMonth (use cancel)', { ...netflix, endMonth: '2026-12' }, ''],
      ['a price field', { ...netflix, price: 1299 }, ''],
    ],
  );
  parseCases('subscriptionCreateSchema output', subscriptionCreateSchema, [
    [
      'trims and normalizes',
      { ...netflix, name: ' Netflix ', color: '#E50914', notes: '' },
      { ...netflix, color: '#e50914', notes: null },
    ],
  ]);

  schemaCases(
    'subscriptionUpdateSchema (PATCH /api/subscriptions/:id)',
    subscriptionUpdateSchema,
    [
      ['a rename', { name: 'Netflix HD' }],
      ['an anchor date', { anchorDate: '2026-11-01' }],
      ['a start month', { startMonth: '2026-08' }],
      ['a color', { color: '#000000' }],
      ['notes', { notes: 'x' }],
      ['clearing color and notes', { color: null, notes: null }],
    ],
    [
      ['an empty body', {}, ''],
      ['a blank name', { name: '' }, 'name'],
      ['a bad anchor date', { anchorDate: '15/10/2026' }, 'anchorDate'],
      ['a bad startMonth', { startMonth: '2026-00' }, 'startMonth'],
      ['a frequency change', { frequency: 'yearly' }, ''],
      ['an endMonth (use cancel)', { endMonth: '2026-12' }, ''],
      ['an amount (use prices)', { amount: 100 }, ''],
    ],
  );
  parseCases('subscriptionUpdateSchema output', subscriptionUpdateSchema, [
    ['keeps null apart from absent', { color: null }, { color: null }],
  ]);

  schemaCases(
    'subscriptionPriceSchema (PUT /api/subscriptions/:id/prices/:month)',
    subscriptionPriceSchema,
    [['a price', { amount: 1499 }]],
    [
      ['an empty body', {}, 'amount'],
      ['a zero price', { amount: 0 }, 'amount'],
      ['a negative price', { amount: -1 }, 'amount'],
      ['a fractional price', { amount: 14.99 }, 'amount'],
      ['a string price', { amount: '1499' }, 'amount'],
      ['an unknown key', { amount: 100, month: '2026-10' }, ''],
    ],
  );

  schemaCases(
    'subscriptionCancelSchema (POST /api/subscriptions/:id/cancel)',
    subscriptionCancelSchema,
    [
      ['an empty body (current month)', {}],
      ['an end month', { endMonth: '2027-03' }],
    ],
    [
      ['a bad end month', { endMonth: '2027-13' }, 'endMonth'],
      ['null', { endMonth: null }, 'endMonth'],
      ['an unknown key', { reason: 'too expensive' }, ''],
    ],
  );
});
