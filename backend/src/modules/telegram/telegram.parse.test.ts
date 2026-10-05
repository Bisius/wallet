/**
 * The amount parser (docs/DOMAIN.md, "The `/spending` flow", step 2, and "Quick entry"): what it
 * reads, what it refuses, and the currency-symbol rule. The properties against `parseCents` are in
 * `telegram.parse.property.test.ts`.
 */
import { MAX_CENTS } from '@wallet/shared';
import { describe, expect, it } from 'vitest';
import {
  type AmountProblem,
  ALWAYS_ACCEPTED_SYMBOL,
  currencySymbols,
  parseAmountMessage,
  readAmountMessage,
} from './telegram.parse';

const problemOf = (text: string, symbols?: readonly string[]): AmountProblem | 'ok' => {
  const reading = readAmountMessage(text, { symbols });
  return reading.ok ? 'ok' : reading.problem;
};

describe('what is an amount', () => {
  it.each([
    ['12.50', 1250],
    ['12,50', 1250],
    ['12.5', 1250],
    ['12,5', 1250],
    ['12', 1200],
    ['0.05', 5],
    ['0,05', 5],
    ['1', 100],
    ['007.10', 710],
    ['€12.50', 1250],
    ['12.50€', 1250],
    ['€ 12,50', 1250],
    ['12,50 €', 1250],
    ['€12', 1200],
    ['12€', 1200],
    ['-5', -500],
    ['-5.25', -525],
    ['−5', -500], // the typographic minus
    ['-€5', -500],
    ['€-5', -500],
    ['-12,50€', -1250],
    ['  12.50  ', 1250],
    ['10000000000.00', MAX_CENTS],
    ['-10000000000.00', -MAX_CENTS],
  ])('reads %j as %i cents with no note', (text, cents) => {
    expect(parseAmountMessage(text)).toEqual({ amount: cents, note: '' });
  });

  it.each([
    ['4,50 coffee', 450, 'coffee'],
    ['12.50 lunch with Anna', 1250, 'lunch with Anna'],
    ['12,50   lunch\twith\nAnna  ', 1250, 'lunch with Anna'],
    ['-5 refund', -500, 'refund'],
    ['€4.50 coffee', 450, 'coffee'],
    ['4.50€ coffee', 450, 'coffee'],
    ['4.50 € coffee', 450, 'coffee'],
    ['5 2 coffees', 500, '2 coffees'],
    ['5 12.50', 500, '12.50'],
    ['1.50 234', 150, '234'], // an amount with decimals has no thousands group
    ['5 1000 steps', 500, '1000 steps'],
    ['12.50 kr', 1250, 'kr'], // letters are a note, whatever they stand for
    ['12.50 USD', 1250, 'USD'],
    ['5 <b>&', 500, '<b>&'],
    ['5 ☕ café', 500, '☕ café'],
  ])('reads %j as %i cents and the note %j', (text, cents, note) => {
    expect(parseAmountMessage(text)).toEqual({ amount: cents, note });
  });

  it('puts a space between the number and the note: a space ends the amount (parseCents would read 1 2 as 12)', () => {
    expect(parseAmountMessage('1 2')).toEqual({ amount: 100, note: '2' });
    expect(parseAmountMessage('12 50')).toEqual({ amount: 1200, note: '50' });
  });
});

describe('a number with a thousands separator is never read as 1 plus a note', () => {
  it.each(['€1 234', '-1 234€', '12 345€', '1 234 567,00€', '10 000 000'])(
    'refuses %j with a symbol in front, a sign, or several groups',
    (text) => {
      expect(parseAmountMessage(text, { symbols: ['€', '$'] })).toBeNull();
    },
  );

  it.each([
    ['1234 567€', 123400, '567€'],
    ['1,5 234', 150, '234'],
    ['12.50 300', 1250, '300'],
  ])('reads %j as an amount and a note: no grouping can be meant', (text, cents, note) => {
    expect(parseAmountMessage(text, { symbols: ['€'] })).toEqual({ amount: cents, note });
  });

  it.each(['1 234,50€', '1 234€', '2 000,00€', '1 234,50EUR', '1 234$', '1 234.567', '1 234,567'])(
    'refuses %j whatever the currency of the settings',
    (text) => {
      expect(parseAmountMessage(text, { symbols: ['$', '€', 'EUR'] })).toBeNull();
      expect(parseAmountMessage(text)).toBeNull();
    },
  );

  it('still reads a note that starts with fewer or more than three digits', () => {
    expect(parseAmountMessage('5 12 oranges')).toEqual({ amount: 500, note: '12 oranges' });
    expect(parseAmountMessage('5 1234 steps')).toEqual({ amount: 500, note: '1234 steps' });
    expect(parseAmountMessage('5 99g')).toEqual({ amount: 500, note: '99g' });
    expect(parseAmountMessage('1234 567')).toEqual({ amount: 123400, note: '567' }); // not a grouping: 4 digits first
    expect(parseAmountMessage('1.50 234')).toEqual({ amount: 150, note: '234' }); // decimals: no grouping
  });
});

describe('what is not an amount', () => {
  it.each([
    '',
    '   ',
    'hello',
    'coffee 4',
    'coffee',
    '€',
    '-',
    '€-',
    '+5',
    '.5',
    '5.',
    '5,',
    ',5',
    '12.345',
    '12,345',
    '1.234,56',
    '1,234.56',
    '12.50lunch',
    '12lunch',
    '12-5',
    '12/5',
    '5e3',
    '0x10',
    '--5',
    '- 5',
    '€€5',
    '€5€',
    '€12.50€',
    '$12.50',
    '£12.50',
    '12.50$',
    '12.50 $',
    '12.50 £ lunch',
    '12.50 ¥',
    '5 €uro',
    '5kroket',
    '١٢', // Arabic-Indic digits
    '1 234,50',
    '1 234',
    '12 345,6',
    '5 100',
    '5 100 grams',
    // A grouped thousand stays refused with a symbol, a unit or a decimal part glued to it.
    '1 234,50€',
    '1 234€',
    '2 000,00€',
    '1 234,50EUR',
    '1 234$',
    '1 234.567',
    '1 234,567',
    '12 345,6€',
    '1 234 €',
    '5 200ml milk',
    '5 100g flour',
    '999 999,99€',
  ])('refuses %j', (text) => {
    expect(parseAmountMessage(text)).toBeNull();
    expect(problemOf(text)).toBe('not_an_amount');
  });

  it.each(['0', '0.00', '0,00', '-0', '000', '0 coffee', '€0', '0€', '-0.00 x'])(
    'refuses the amount 0 in %j',
    (text) => {
      expect(problemOf(text)).toBe('zero');
    },
  );

  it('refuses an amount above MAX_CENTS, in either sign, however many digits', () => {
    expect(problemOf('10000000000.01')).toBe('too_large');
    expect(problemOf('-10000000000.01')).toBe('too_large');
    expect(problemOf('10000000001')).toBe('too_large');
    expect(problemOf('9007199254740992')).toBe('too_large'); // beyond a safe integer of cents
    expect(problemOf('9'.repeat(400))).toBe('too_large');
    expect(problemOf('10000000000.00')).toBe('ok');
  });

  it('refuses a note over 200 characters, and accepts exactly 200, never cutting', () => {
    expect(parseAmountMessage(`5 ${'x'.repeat(200)}`)).toEqual({
      amount: 500,
      note: 'x'.repeat(200),
    });
    expect(problemOf(`5 ${'x'.repeat(201)}`)).toBe('note_too_long');
    // Whitespace is collapsed before it counts.
    expect(parseAmountMessage(`5 ${'x '.repeat(100)}`)).toEqual({
      amount: 500,
      note: 'x '.repeat(99) + 'x',
    });
    expect(problemOf(`5 ${'x  '.repeat(99)}y`)).toBe('ok'); // 199 characters once collapsed
    expect(problemOf(`5 ${'x  '.repeat(100)}y`)).toBe('note_too_long'); // 201
  });

  it('says what is wrong with an amount before it says what is wrong with the note', () => {
    expect(problemOf(`0 ${'x'.repeat(300)}`)).toBe('zero');
    expect(problemOf(`99999999999999 ${'x'.repeat(300)}`)).toBe('too_large');
  });

  it('never throws, whatever the text', () => {
    for (const text of [
      '\u0000',
      '‮5',
      '5\u0000',
      '€'.repeat(5000),
      '9'.repeat(100_000),
      '\ud800',
      '5 \ud800',
    ]) {
      expect(() => readAmountMessage(text)).not.toThrow();
    }
  });
});

describe('the currency symbol (docs/DOMAIN.md: € always, and the symbol of the currency in Settings)', () => {
  it('always accepts the euro sign', () => {
    expect(ALWAYS_ACCEPTED_SYMBOL).toBe('€');
    expect(parseAmountMessage('€5', { symbols: [] })).toEqual({ amount: 500, note: '' });
    expect(parseAmountMessage('5€', { symbols: ['$'] })).toEqual({ amount: 500, note: '' });
  });

  it('accepts the symbols it is given, before or after the number', () => {
    expect(parseAmountMessage('$12.50', { symbols: ['$'] })).toEqual({ amount: 1250, note: '' });
    expect(parseAmountMessage('12.50 $ lunch', { symbols: ['$'] })).toEqual({
      amount: 1250,
      note: 'lunch',
    });
    expect(parseAmountMessage('12,50 kr x', { symbols: ['kr'] })).toEqual({
      amount: 1250,
      note: 'x',
    });
    expect(parseAmountMessage('CA$5', { symbols: ['$', 'CA$'] })).toEqual({
      amount: 500,
      note: '',
    });
  });

  it('refuses every other symbol: an amount in another currency is never stored as if it were in the settings one', () => {
    expect(problemOf('$12.50')).toBe('not_an_amount');
    expect(problemOf('£12.50', ['$'])).toBe('not_an_amount');
    expect(problemOf('12.50¥', ['$'])).toBe('not_an_amount');
  });

  it('does not take a note that merely starts with a symbol’s letters for the symbol', () => {
    expect(parseAmountMessage('5 kroket', { symbols: ['kr'] })).toEqual({
      amount: 500,
      note: 'kroket',
    });
    expect(parseAmountMessage('5 kr', { symbols: ['kr'] })).toEqual({ amount: 500, note: '' });
  });

  it.each([
    [{ currency: 'EUR', locale: 'en-GB' }, ['€']],
    [{ currency: 'EUR', locale: 'de-DE' }, ['€']],
    [{ currency: 'USD', locale: 'en-US' }, ['€', '$']],
    [{ currency: 'GBP', locale: 'en-GB' }, ['€', '£']],
    [{ currency: 'JPY', locale: 'ja-JP' }, ['€']],
  ])('reads the symbols of %j from Intl: %j (at least)', (format, expected) => {
    const symbols = currencySymbols(format);
    for (const symbol of expected) expect(symbols).toContain(symbol);
    for (const symbol of symbols) expect(symbol).not.toMatch(/[\d\s.,+\-−]/);
  });

  it('knows both the symbol and the narrow symbol of a currency', () => {
    const symbols = currencySymbols({ currency: 'CAD', locale: 'en-US' });
    expect(symbols).toContain('$');
    expect(symbols).toContain('CA$');
  });

  it('falls back to the euro sign alone for a currency or locale Intl cannot use', () => {
    expect(currencySymbols({ currency: 'not a currency', locale: 'en-US' })).toEqual(['€']);
    expect(currencySymbols({ currency: 'USD', locale: 'not_a_locale' })).toEqual(['€']);
  });

  it('is pure: the same settings give the same symbols, and the parser does not need the settings at all', () => {
    expect(currencySymbols({ currency: 'USD', locale: 'en-US' })).toEqual(
      currencySymbols({ currency: 'USD', locale: 'en-US' }),
    );
    expect(parseAmountMessage('12,50 lunch')).toEqual({ amount: 1250, note: 'lunch' });
  });
});
