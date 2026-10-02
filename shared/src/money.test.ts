import { describe, expect, it } from 'vitest';
import { parseCents, sumCents } from './money';

describe('parseCents', () => {
  it.each([
    ['12', 1200],
    ['12.5', 1250],
    ['12,05', 1205],
    ['-3.10', -310],
    [' 1 000.99 ', 100099],
  ])('parses %j as %i', (input, expected) => {
    expect(parseCents(input)).toBe(expected);
  });

  it.each(['', 'abc', '1.234', '1..2', '--1'])('rejects %j', (input) => {
    expect(parseCents(input)).toBeNull();
  });
});

describe('sumCents', () => {
  it('sums integer amounts', () => {
    expect(sumCents([1, 2, 3])).toBe(6);
  });
});
