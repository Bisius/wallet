import { describe, expect, it } from 'vitest';
import {
  AT_LEAST_ONE_FIELD,
  DESCRIPTION_MAX_LENGTH,
  ICON_MAX_LENGTH,
  MAX_CENTS,
  NAME_MAX_LENGTH,
  NOTES_MAX_LENGTH,
  centsSchema,
  colorSchema,
  descriptionSchema,
  hasAnyKey,
  iconSchema,
  idMonthParamsSchema,
  idParamsSchema,
  idRefSchema,
  idSchema,
  isoDateSchema,
  monthKeySchema,
  monthParamsSchema,
  nameSchema,
  nonNegativeCentsSchema,
  nonZeroCentsSchema,
  notesSchema,
  positiveCentsSchema,
  queryCentsSchema,
} from './schemas';
import { chars, parseCases, schemaCases } from './test-utils';

describe('money primitives', () => {
  schemaCases(
    'centsSchema',
    centsSchema,
    [
      ['zero', 0],
      ['positive', 12345],
      ['negative', -1],
      ['the cap', MAX_CENTS],
      ['minus the cap', -MAX_CENTS],
    ],
    [
      ['a fraction', 1.5, ''],
      ['NaN', Number.NaN, ''],
      ['Infinity', Number.POSITIVE_INFINITY, ''],
      ['a numeric string', '100', ''],
      ['null', null, ''],
      ['above the cap', MAX_CENTS + 1, ''],
      ['below minus the cap', -MAX_CENTS - 1, ''],
      ['an unsafe integer', Number.MAX_SAFE_INTEGER + 2, ''],
    ],
  );

  schemaCases(
    'positiveCentsSchema',
    positiveCentsSchema,
    [['one cent', 1]],
    [
      ['zero', 0, ''],
      ['negative', -1, ''],
    ],
  );

  schemaCases(
    'nonNegativeCentsSchema',
    nonNegativeCentsSchema,
    [
      ['zero', 0],
      ['one cent', 1],
    ],
    [['negative', -1, '']],
  );

  schemaCases(
    'nonZeroCentsSchema',
    nonZeroCentsSchema,
    [
      ['a spending', 1],
      ['a refund', -1],
    ],
    [['zero', 0, '']],
  );

  schemaCases(
    'queryCentsSchema (signed cents from a query string)',
    queryCentsSchema,
    [
      ['zero', '0'],
      ['a positive amount', '1250'],
      ['a negative amount', '-500'],
      ['one cent', '1'],
      ['minus one cent', '-1'],
      ['the cap', String(MAX_CENTS)],
      ['minus the cap', String(-MAX_CENTS)],
      ['a number as it is', -500],
      ['the number zero', 0],
    ],
    [
      ['an empty string (not 0)', '', ''],
      ['spaces (not 0)', '  ', ''],
      ['text', 'cheap', ''],
      ['a decimal', '12.50', ''],
      ['a fractional number', 12.5, ''],
      ['an exponent', '1e3', ''],
      ['a hex number', '0x10', ''],
      ['a plus sign', '+5', ''],
      ['leading zeros', '007', ''],
      ['negative zero', '-0', ''],
      ['spaces around the digits', ' 5 ', ''],
      ['a lone minus sign', '-', ''],
      ['a thousands separator', '1,250', ''],
      ['null (not 0)', null, ''],
      ['a boolean (not 1)', true, ''],
      ['an array', ['1'], ''],
      ['above the cap', String(MAX_CENTS + 1), ''],
      ['below minus the cap', String(-MAX_CENTS - 1), ''],
      ['a string too long for a safe integer', '9'.repeat(40), ''],
    ],
  );
  parseCases('queryCentsSchema output', queryCentsSchema, [
    ['reads digits as a number', '1250', 1250],
    ['reads a minus sign', '-500', -500],
    ['reads zero as +0, so it is a bound that can be told from no bound', '0', 0],
  ]);
});

describe('month and date primitives', () => {
  schemaCases(
    'monthKeySchema',
    monthKeySchema,
    [
      ['a month', '2026-10'],
      ['january', '2026-01'],
    ],
    [
      ['month 13', '2026-13', ''],
      ['month 00', '2026-00', ''],
      ['one digit month', '2026-1', ''],
      ['a slash', '2026/10', ''],
      ['a full date', '2026-10-01', ''],
      ['empty', '', ''],
      ['a number', 202610, ''],
    ],
  );

  schemaCases(
    'isoDateSchema',
    isoDateSchema,
    [
      ['a date', '2026-10-02'],
      ['a leap day', '2024-02-29'],
      ['a month end', '2026-04-30'],
    ],
    [
      ['Feb 30', '2026-02-30', ''],
      ['a leap day in a common year', '2026-02-29', ''],
      ['April 31', '2026-04-31', ''],
      ['one digit day', '2026-10-2', ''],
      ['a datetime', '2026-10-02T10:00:00Z', ''],
      ['a US date', '10/02/2026', ''],
      ['empty', '', ''],
    ],
  );
});

describe('id primitives', () => {
  schemaCases(
    'idSchema (path and query)',
    idSchema,
    [
      ['a numeric string', '12'],
      ['a number', 12],
    ],
    [
      ['zero', '0', ''],
      ['negative', '-1', ''],
      ['a fraction', '1.5', ''],
      ['text', 'abc', ''],
      ['empty', '', ''],
    ],
  );

  schemaCases(
    'idRefSchema (body)',
    idRefSchema,
    [
      ['one', 1],
      ['many', 42],
    ],
    [
      ['zero', 0, ''],
      ['negative', -3, ''],
      ['a fraction', 1.5, ''],
      ['a string', '3', ''],
      ['true (would coerce to 1)', true, ''],
      ['null', null, ''],
    ],
  );

  schemaCases(
    'idParamsSchema',
    idParamsSchema,
    [['an id', { id: '7' }]],
    [
      ['a bad id', { id: 'x' }, 'id'],
      ['a missing id', {}, 'id'],
      ['an extra key', { id: '7', other: '1' }, ''],
    ],
  );

  schemaCases(
    'monthParamsSchema',
    monthParamsSchema,
    [['a month', { month: '2026-10' }]],
    [
      ['a bad month', { month: '2026-13' }, 'month'],
      ['a missing month', {}, 'month'],
    ],
  );

  schemaCases(
    'idMonthParamsSchema',
    idMonthParamsSchema,
    [['an id and a month', { id: '3', month: '2026-10' }]],
    [
      ['a bad id', { id: '0', month: '2026-10' }, 'id'],
      ['a bad month', { id: '3', month: 'x' }, 'month'],
    ],
  );
});

describe('text primitives', () => {
  schemaCases(
    'nameSchema',
    nameSchema,
    [
      ['a name', 'Groceries'],
      ['the longest name', chars(NAME_MAX_LENGTH)],
    ],
    [
      ['empty', '', ''],
      ['blank', '   ', ''],
      ['too long', chars(NAME_MAX_LENGTH + 1), ''],
      ['a number', 5, ''],
    ],
  );
  parseCases('nameSchema output', nameSchema, [['trims', '  Groceries  ', 'Groceries']]);

  schemaCases(
    'descriptionSchema',
    descriptionSchema,
    [
      ['empty', ''],
      ['the longest', chars(DESCRIPTION_MAX_LENGTH)],
    ],
    [['too long', chars(DESCRIPTION_MAX_LENGTH + 1), '']],
  );
  parseCases('descriptionSchema output', descriptionSchema, [
    ['trims', ' coffee ', 'coffee'],
    ['keeps empty', '   ', ''],
  ]);

  schemaCases(
    'notesSchema',
    notesSchema,
    [
      ['text', 'a note'],
      ['the longest', chars(NOTES_MAX_LENGTH)],
    ],
    [['too long', chars(NOTES_MAX_LENGTH + 1), '']],
  );
  parseCases('notesSchema output', notesSchema, [
    ['trims', ' a note ', 'a note'],
    ['empty becomes null', '', null],
    ['blank becomes null', '   ', null],
  ]);

  schemaCases(
    'colorSchema',
    colorSchema,
    [
      ['lower case hex', '#3b82f6'],
      ['upper case hex', '#3B82F6'],
    ],
    [
      ['a color name', 'red', ''],
      ['short hex', '#abc', ''],
      ['non hex digits', '#gggggg', ''],
      ['missing #', '3b82f6', ''],
      ['with alpha', '#3b82f6ff', ''],
      ['empty', '', ''],
    ],
  );
  parseCases('colorSchema output', colorSchema, [['lower-cases', '#3B82F6', '#3b82f6']]);

  schemaCases(
    'iconSchema',
    iconSchema,
    [
      ['a key', 'shopping-cart'],
      ['an emoji', '🛒'],
      ['the longest', chars(ICON_MAX_LENGTH)],
    ],
    [
      ['empty', '', ''],
      ['blank', '  ', ''],
      ['too long', chars(ICON_MAX_LENGTH + 1), ''],
    ],
  );
});

describe('PATCH helper', () => {
  it.each([
    ['empty object', {}, false],
    ['one key', { a: 1 }, true],
    ['a null value', { a: null }, true],
  ])('hasAnyKey: %s', (_label, value, expected) => {
    expect(hasAnyKey(value)).toBe(expected);
  });

  it('has a human message', () => {
    expect(AT_LEAST_ONE_FIELD).toBe('At least one field is required');
  });
});
