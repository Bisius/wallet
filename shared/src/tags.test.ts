import { describe, expect, it } from 'vitest';
import { TAG_NAME_MAX_LENGTH, tagCreateSchema, tagNameSchema, tagUpdateSchema } from './tags';
import { chars, parseCases, schemaCases } from './test-utils';

describe('tagNameSchema', () => {
  schemaCases(
    'name',
    tagNameSchema,
    [
      ['one character', 'a'],
      ['an ordinary name', 'Groceries'],
      ['spaces inside', 'eating out'],
      ['non-ASCII letters', 'Café'],
      ['the longest name', chars(TAG_NAME_MAX_LENGTH)],
      [
        'the longest name with spaces around it (they are trimmed first)',
        ` ${chars(TAG_NAME_MAX_LENGTH)} `,
      ],
    ],
    [
      ['an empty name', '', ''],
      ['a blank name', '   ', ''],
      ['a name above the maximum', chars(TAG_NAME_MAX_LENGTH + 1), ''],
      ['a number', 5, ''],
      ['null', null, ''],
    ],
  );
});

describe('tag schemas', () => {
  schemaCases(
    'tagCreateSchema (POST /api/tags)',
    tagCreateSchema,
    [
      ['a name only', { name: 'Groceries' }],
      ['a name and a color', { name: 'Groceries', color: '#22c55e' }],
      ['a null color', { name: 'Groceries', color: null }],
      ['an upper-case color', { name: 'Groceries', color: '#22C55E' }],
      ['the longest name', { name: chars(TAG_NAME_MAX_LENGTH) }],
      ['a name that only differs in case from another (the server decides)', { name: 'GROCERIES' }],
    ],
    [
      ['an empty body', {}, 'name'],
      ['a missing name', { color: '#22c55e' }, 'name'],
      ['an empty name', { name: '' }, 'name'],
      ['a blank name', { name: '   ' }, 'name'],
      ['a too long name', { name: chars(TAG_NAME_MAX_LENGTH + 1) }, 'name'],
      ['a null name', { name: null }, 'name'],
      ['a numeric name', { name: 7 }, 'name'],
      ['a color that is not hex', { name: 'a', color: 'green' }, 'color'],
      ['a short hex color', { name: 'a', color: '#2c5' }, 'color'],
      ['a hex color without the hash', { name: 'a', color: '22c55e' }, 'color'],
      ['an empty color (send null for no color)', { name: 'a', color: '' }, 'color'],
      ['a numeric color', { name: 'a', color: 5 }, 'color'],
      ['an unknown key', { name: 'a', usageCount: 0 }, ''],
      ['an id in the body', { id: 3, name: 'a' }, ''],
    ],
  );
  parseCases('tagCreateSchema output', tagCreateSchema, [
    ['trims the name', { name: '  Groceries ' }, { name: 'Groceries' }],
    ['keeps inner spaces', { name: 'eating  out' }, { name: 'eating  out' }],
    [
      'lower-cases the color',
      { name: 'Groceries', color: '#22C55E' },
      { name: 'Groceries', color: '#22c55e' },
    ],
    ['leaves the color out when omitted (the server stores null)', { name: 'a' }, { name: 'a' }],
    ['keeps a null color', { name: 'a', color: null }, { name: 'a', color: null }],
  ]);

  schemaCases(
    'tagUpdateSchema (PATCH /api/tags/:id)',
    tagUpdateSchema,
    [
      ['only the name', { name: 'Eating out' }],
      ['only the color', { color: '#3b82f6' }],
      ['clearing the color', { color: null }],
      ['the name and the color', { name: 'Eating out', color: '#3b82f6' }],
      [
        'only the capitalization of a name (the server compares it with the tag itself)',
        { name: 'groceries' },
      ],
    ],
    [
      ['an empty body', {}, ''],
      ['an empty name', { name: '' }, 'name'],
      ['a blank name', { name: '  ' }, 'name'],
      ['a too long name', { name: chars(TAG_NAME_MAX_LENGTH + 1) }, 'name'],
      ['a null name (a name cannot be cleared)', { name: null }, 'name'],
      ['a bad color', { color: 'blue' }, 'color'],
      ['an empty color', { color: '' }, 'color'],
      ['an unknown key', { usageCount: 3 }, ''],
      ['an unknown key next to a name', { name: 'a', id: 3 }, ''],
    ],
  );
  parseCases('tagUpdateSchema output', tagUpdateSchema, [
    ['trims the name', { name: ' Eating out ' }, { name: 'Eating out' }],
    ['keeps a null color (it clears the color)', { color: null }, { color: null }],
    ['leaves out what is omitted', { color: '#3B82F6' }, { color: '#3b82f6' }],
  ]);

  it('has the documented name length', () => {
    expect(TAG_NAME_MAX_LENGTH).toBe(30);
  });
});
