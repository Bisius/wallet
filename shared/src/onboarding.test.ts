import { describe, expect, it } from 'vitest';
import { MAX_ONBOARDING_BUDGETS, onboardingBudgetSchema, onboardingSchema } from './onboarding';
import { chars, schemaCases } from './test-utils';

const minimal = {
  currency: 'EUR',
  locale: 'en-US',
  startMonth: '2026-10',
  salary: 250000,
  openingSavings: 0,
};

const groceries = { name: 'Groceries', amount: 40000, incremental: false };

describe('onboarding schemas', () => {
  schemaCases(
    'onboardingBudgetSchema',
    onboardingBudgetSchema,
    [
      ['a monthly budget', groceries],
      ['an incremental budget', { name: 'Holidays', amount: 15000, incremental: true }],
      ['a zero amount', { name: 'Parked', amount: 0, incremental: false }],
    ],
    [
      ['a missing name', { amount: 100, incremental: false }, 'name'],
      ['a blank name', { ...groceries, name: '  ' }, 'name'],
      ['a missing amount', { name: 'x', incremental: false }, 'amount'],
      ['a negative amount', { ...groceries, amount: -1 }, 'amount'],
      ['a fractional amount', { ...groceries, amount: 10.5 }, 'amount'],
      ['a missing incremental', { name: 'x', amount: 100 }, 'incremental'],
      ['a non-boolean incremental', { ...groceries, incremental: 'yes' }, 'incremental'],
      ['an unknown key', { ...groceries, color: '#ffffff' }, ''],
    ],
  );

  schemaCases(
    'onboardingSchema (POST /api/onboarding)',
    onboardingSchema,
    [
      ['the required fields only', minimal],
      ['a zero salary and savings', { ...minimal, salary: 0, openingSavings: 0 }],
      [
        'all optional fields',
        { ...minimal, theme: 'dark', alertWarnPercent: 90, budgets: [groceries] },
      ],
      ['an empty budget list', { ...minimal, budgets: [] }],
      [
        'the most budgets',
        { ...minimal, budgets: Array.from({ length: MAX_ONBOARDING_BUDGETS }, () => groceries) },
      ],
    ],
    [
      ['an empty body', {}, 'currency'],
      ['a missing currency', { ...minimal, currency: undefined }, 'currency'],
      ['a bad currency', { ...minimal, currency: 'eu' }, 'currency'],
      ['a missing locale', { ...minimal, locale: undefined }, 'locale'],
      ['a bad locale', { ...minimal, locale: 'en_US' }, 'locale'],
      ['a missing startMonth', { ...minimal, startMonth: undefined }, 'startMonth'],
      ['a bad startMonth', { ...minimal, startMonth: '2026-10-01' }, 'startMonth'],
      ['a bad theme', { ...minimal, theme: 'neon' }, 'theme'],
      ['a bad percent', { ...minimal, alertWarnPercent: 101 }, 'alertWarnPercent'],
      ['a missing salary', { ...minimal, salary: undefined }, 'salary'],
      ['a negative salary', { ...minimal, salary: -1 }, 'salary'],
      ['a fractional salary', { ...minimal, salary: 2500.5 }, 'salary'],
      ['a missing openingSavings', { ...minimal, openingSavings: undefined }, 'openingSavings'],
      ['negative openingSavings', { ...minimal, openingSavings: -100 }, 'openingSavings'],
      ['budgets that is not a list', { ...minimal, budgets: groceries }, 'budgets'],
      [
        'a bad budget',
        { ...minimal, budgets: [groceries, { ...groceries, amount: -5 }] },
        'budgets.1.amount',
      ],
      [
        'too many budgets',
        {
          ...minimal,
          budgets: Array.from({ length: MAX_ONBOARDING_BUDGETS + 1 }, () => groceries),
        },
        'budgets',
      ],
      ['an unknown key', { ...minimal, extra: 1 }, ''],
      ['a nested settings object', { ...minimal, settings: { currency: 'EUR' } }, ''],
    ],
  );

  it('does not fill in defaults: the server applies them', () => {
    expect(onboardingSchema.parse(minimal)).toEqual(minimal);
  });

  it('keeps long budget names within the limit', () => {
    expect(onboardingBudgetSchema.safeParse({ ...groceries, name: chars(61) }).success).toBe(false);
  });
});
