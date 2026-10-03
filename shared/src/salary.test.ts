import { describe } from 'vitest';
import { salaryUpsertSchema } from './salary';
import { schemaCases } from './test-utils';

describe('salary schemas', () => {
  schemaCases(
    'salaryUpsertSchema (PUT /api/salary/:month)',
    salaryUpsertSchema,
    [
      ['a salary', { amount: 250000 }],
      ['a zero salary', { amount: 0 }],
    ],
    [
      ['an empty body', {}, 'amount'],
      ['a negative amount', { amount: -1 }, 'amount'],
      ['a fractional amount', { amount: 2500.5 }, 'amount'],
      ['a string amount', { amount: '2500' }, 'amount'],
      ['null', { amount: null }, 'amount'],
      ['an amount above the cap', { amount: 1_000_000_000_001 }, 'amount'],
      ['an unknown key', { amount: 100, effectiveMonth: '2026-10' }, ''],
    ],
  );
});
