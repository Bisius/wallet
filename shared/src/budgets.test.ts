import { describe } from 'vitest';
import {
  budgetArchiveSchema,
  budgetCreateSchema,
  budgetUpdateSchema,
  budgetVersionSchema,
  sortOrderSchema,
} from './budgets';
import { parseCases, schemaCases } from './test-utils';

const groceries = { name: 'Groceries', amount: 40000, incremental: false };

describe('budget schemas', () => {
  schemaCases(
    'sortOrderSchema',
    sortOrderSchema,
    [
      ['zero', 0],
      ['a position', 30],
      ['the maximum', 1_000_000],
    ],
    [
      ['negative', -1, ''],
      ['a fraction', 1.5, ''],
      ['above the maximum', 1_000_001, ''],
    ],
  );

  schemaCases(
    'budgetCreateSchema (POST /api/budgets)',
    budgetCreateSchema,
    [
      ['the required fields only', groceries],
      ['an incremental budget', { ...groceries, incremental: true }],
      ['a zero amount', { ...groceries, amount: 0 }],
      [
        'every field',
        {
          ...groceries,
          startMonth: '2026-10',
          color: '#3b82f6',
          icon: 'shopping-cart',
          sortOrder: 2,
          alertWarnPercent: 90,
          notes: 'Weekly shop',
        },
      ],
      [
        'nulls for the optional fields',
        { ...groceries, color: null, icon: null, alertWarnPercent: null, notes: null },
      ],
    ],
    [
      ['an empty body', {}, 'name'],
      ['a missing name', { amount: 100, incremental: false }, 'name'],
      ['a blank name', { ...groceries, name: ' ' }, 'name'],
      ['a missing amount', { name: 'x', incremental: false }, 'amount'],
      ['a negative amount', { ...groceries, amount: -1 }, 'amount'],
      ['a fractional amount', { ...groceries, amount: 99.9 }, 'amount'],
      ['a missing incremental', { name: 'x', amount: 100 }, 'incremental'],
      ['a non-boolean incremental', { ...groceries, incremental: 1 }, 'incremental'],
      ['a bad startMonth', { ...groceries, startMonth: '2026-10-01' }, 'startMonth'],
      ['a bad color', { ...groceries, color: 'blue' }, 'color'],
      ['an empty icon', { ...groceries, icon: '' }, 'icon'],
      ['a bad sortOrder', { ...groceries, sortOrder: -1 }, 'sortOrder'],
      ['a zero alert percent', { ...groceries, alertWarnPercent: 0 }, 'alertWarnPercent'],
      ['an alert percent above 100', { ...groceries, alertWarnPercent: 101 }, 'alertWarnPercent'],
      ['an endMonth (use archive)', { ...groceries, endMonth: '2026-12' }, ''],
      ['an unknown key', { ...groceries, id: 1 }, ''],
    ],
  );
  parseCases('budgetCreateSchema output', budgetCreateSchema, [
    [
      'trims, lower-cases, nulls blank notes',
      { ...groceries, name: ' Groceries ', color: '#3B82F6', notes: '  ' },
      { ...groceries, color: '#3b82f6', notes: null },
    ],
  ]);

  schemaCases(
    'budgetUpdateSchema (PATCH /api/budgets/:id)',
    budgetUpdateSchema,
    [
      ['a rename', { name: 'Food' }],
      ['a color', { color: '#112233' }],
      ['an icon', { icon: '🛒' }],
      ['a sortOrder', { sortOrder: 0 }],
      ['an alert percent', { alertWarnPercent: 95 }],
      ['notes', { notes: 'x' }],
      ['a startMonth', { startMonth: '2026-09' }],
      [
        'clearing every nullable field',
        { color: null, icon: null, alertWarnPercent: null, notes: null },
      ],
      ['empty notes (cleared)', { notes: '' }],
    ],
    [
      ['an empty body', {}, ''],
      ['a blank name', { name: '' }, 'name'],
      ['null name', { name: null }, 'name'],
      ['a bad color', { color: 'blue' }, 'color'],
      ['a bad alert percent', { alertWarnPercent: 0 }, 'alertWarnPercent'],
      ['a bad sortOrder', { sortOrder: -2 }, 'sortOrder'],
      ['a bad startMonth', { startMonth: '2026-13' }, 'startMonth'],
      ['null startMonth', { startMonth: null }, 'startMonth'],
      ['an amount (use versions)', { amount: 100 }, ''],
      ['incremental (use versions)', { incremental: true }, ''],
      ['an endMonth (use archive)', { endMonth: '2026-12' }, ''],
    ],
  );
  parseCases('budgetUpdateSchema output', budgetUpdateSchema, [
    ['keeps null (clear) apart from absent', { notes: null }, { notes: null }],
    ['turns empty notes into null', { notes: '' }, { notes: null }],
    ['does not invent keys', { name: 'Food' }, { name: 'Food' }],
  ]);

  schemaCases(
    'budgetVersionSchema (PUT /api/budgets/:id/versions/:month)',
    budgetVersionSchema,
    [
      ['an amount and mode', { amount: 45000, incremental: true }],
      ['a zero amount', { amount: 0, incremental: false }],
    ],
    [
      ['an empty body', {}, 'amount'],
      ['a missing amount', { incremental: true }, 'amount'],
      ['a missing incremental', { amount: 100 }, 'incremental'],
      ['a negative amount', { amount: -1, incremental: true }, 'amount'],
      ['a fractional amount', { amount: 1.5, incremental: true }, 'amount'],
      ['a non-boolean incremental', { amount: 100, incremental: 'true' }, 'incremental'],
      ['an unknown key', { amount: 100, incremental: true, name: 'x' }, ''],
    ],
  );

  schemaCases(
    'budgetArchiveSchema (POST /api/budgets/:id/archive)',
    budgetArchiveSchema,
    [
      ['an empty body (current month)', {}],
      ['an end month', { endMonth: '2026-12' }],
    ],
    [
      ['a bad end month', { endMonth: '2026-13' }, 'endMonth'],
      ['a date instead of a month', { endMonth: '2026-12-31' }, 'endMonth'],
      ['null', { endMonth: null }, 'endMonth'],
      ['an unknown key', { month: '2026-12' }, ''],
    ],
  );
});
