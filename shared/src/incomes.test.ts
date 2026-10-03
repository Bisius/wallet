import { describe } from 'vitest';
import { incomeCreateSchema, incomeListQuerySchema, incomeUpdateSchema } from './incomes';
import { chars, parseCases, schemaCases } from './test-utils';

const bonus = { date: '2026-10-02', amount: 50000, description: 'Bonus' };

describe('income schemas', () => {
  schemaCases(
    'incomeCreateSchema (POST /api/incomes)',
    incomeCreateSchema,
    [
      ['a full body', bonus],
      ['one cent', { ...bonus, amount: 1 }],
      ['the longest description', { ...bonus, description: chars(200) }],
    ],
    [
      ['an empty body', {}, 'date'],
      ['a missing date', { ...bonus, date: undefined }, 'date'],
      ['a bad date', { ...bonus, date: '2026-02-30' }, 'date'],
      ['a month instead of a date', { ...bonus, date: '2026-10' }, 'date'],
      ['a missing amount', { ...bonus, amount: undefined }, 'amount'],
      ['a zero amount', { ...bonus, amount: 0 }, 'amount'],
      ['a negative amount', { ...bonus, amount: -100 }, 'amount'],
      ['a fractional amount', { ...bonus, amount: 10.5 }, 'amount'],
      ['a missing description', { ...bonus, description: undefined }, 'description'],
      ['an empty description', { ...bonus, description: '' }, 'description'],
      ['a blank description', { ...bonus, description: '   ' }, 'description'],
      ['a too long description', { ...bonus, description: chars(201) }, 'description'],
      ['an unknown key', { ...bonus, id: 4 }, ''],
    ],
  );
  parseCases('incomeCreateSchema output', incomeCreateSchema, [
    ['trims the description', { ...bonus, description: '  Bonus ' }, bonus],
  ]);

  schemaCases(
    'incomeUpdateSchema (PATCH /api/incomes/:id)',
    incomeUpdateSchema,
    [
      ['only the date', { date: '2026-10-03' }],
      ['only the amount', { amount: 100 }],
      ['only the description', { description: 'Gift' }],
      ['every field', bonus],
    ],
    [
      ['an empty body', {}, ''],
      ['a bad date', { date: 'tomorrow' }, 'date'],
      ['a zero amount', { amount: 0 }, 'amount'],
      ['an empty description', { description: '' }, 'description'],
      ['null', { description: null }, 'description'],
      ['an unknown key', { date: '2026-10-03', id: 1 }, ''],
    ],
  );

  schemaCases(
    'incomeListQuerySchema (GET /api/incomes)',
    incomeListQuerySchema,
    [
      ['no filter', {}],
      ['a month', { month: '2026-10' }],
    ],
    [
      ['a bad month', { month: '2026-13' }, 'month'],
      ['a date instead of a month', { month: '2026-10-01' }, 'month'],
      ['an unknown filter', { year: '2026' }, ''],
    ],
  );
});
