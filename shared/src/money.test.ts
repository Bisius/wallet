import { describe, expect, it } from 'vitest';
import { ceilDiv, parseCents, splitEvenly, sumCents } from './money';

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

describe('ceilDiv', () => {
  it.each([
    // [numerator, denominator, expected]
    [0, 1, 0],
    [1, 1, 1],
    [7, 1, 7],
    [9, 3, 3],
    [10, 3, 4],
    [11, 3, 4],
    [1, 12, 1],
    [11, 12, 1],
    [12, 12, 1],
    [13, 12, 2],
    [0, 12, 0],
    // docs/DOMAIN.md: 100.00 / 12 shows as 8.34, 120.00 / 12 as exactly 10.00
    [10000, 12, 834],
    [12000, 12, 1000],
    [12001, 12, 1001],
    // a negative numerator rounds towards zero, which is "up"
    [-1, 5, 0],
    [-5, 5, -1],
    [-6, 5, -1],
    [-7, 3, -2],
    [-6, 3, -2],
    [-9, 3, -3],
    // the extremes of the safe range
    [Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER],
    [Number.MAX_SAFE_INTEGER, 2, 4503599627370496],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1],
    [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, 1],
    [1, Number.MAX_SAFE_INTEGER, 1],
    [Number.MIN_SAFE_INTEGER, 2, -4503599627370495],
  ])('ceilDiv(%i, %i) is %i', (numerator, denominator, expected) => {
    expect(ceilDiv(numerator, denominator)).toBe(expected);
  });

  it('matches exact BigInt arithmetic for large pseudo-random operands', () => {
    // Operands near 2^53, where n = q * d + (0..2): cross-checked against BigInt, which is exact by
    // construction. (Deterministic LCG, so a failure is reproducible.)
    let seed = 20261002;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let i = 0; i < 2000; i++) {
      const denominator = (next() % 100_000_000) + 1;
      const quotient = Math.floor(Number.MAX_SAFE_INTEGER / denominator) - (next() % 3);
      const numerator = quotient * denominator + (next() % 3);
      const expected = Number((BigInt(numerator) + BigInt(denominator) - 1n) / BigInt(denominator));
      expect(ceilDiv(numerator, denominator)).toBe(expected);
    }
  });

  it('never returns a result below the true quotient or more than 1 above it', () => {
    for (let numerator = -60; numerator <= 60; numerator++) {
      for (let denominator = 1; denominator <= 14; denominator++) {
        const result = ceilDiv(numerator, denominator);
        expect(result * denominator).toBeGreaterThanOrEqual(numerator);
        expect((result - 1) * denominator).toBeLessThan(numerator);
      }
    }
  });

  it.each([
    ['a zero denominator', 5, 0],
    ['a negative denominator', 5, -2],
    ['a fractional denominator', 5, 1.5],
    ['a fractional numerator', 5.5, 2],
    ['a NaN numerator', Number.NaN, 2],
    ['an infinite numerator', Number.POSITIVE_INFINITY, 2],
    ['an unsafe numerator', Number.MAX_SAFE_INTEGER + 2, 2],
  ])('throws a RangeError for %s', (_label, numerator, denominator) => {
    expect(() => ceilDiv(numerator, denominator)).toThrow(RangeError);
  });
});

describe('splitEvenly', () => {
  it.each([
    // [total, parts, expected]
    [0, 1, [0]],
    [100, 1, [100]],
    [0, 3, [0, 0, 0]],
    [9, 3, [3, 3, 3]],
    [10, 3, [4, 3, 3]],
    [11, 3, [4, 4, 3]],
    [1, 3, [1, 0, 0]],
    [4, 5, [1, 1, 1, 1, 0]],
    [5, 5, [1, 1, 1, 1, 1]],
    [2, 5, [1, 1, 0, 0, 0]],
    // docs/DOMAIN.md: 100.00 over 12 months is 8.34 four times, then 8.33 eight times
    [10000, 12, [834, 834, 834, 834, 833, 833, 833, 833, 833, 833, 833, 833]],
    [12000, 12, Array.from({ length: 12 }, () => 1000)],
    // a negative total keeps the larger (less negative) parts first
    [-10, 3, [-3, -3, -4]],
    [-1, 3, [0, 0, -1]],
    [-9, 3, [-3, -3, -3]],
    [-1, 1, [-1]],
  ])('splitEvenly(%i, %i) is %j', (total, parts, expected) => {
    expect(splitEvenly(total, parts)).toEqual(expected);
  });

  it('always sums exactly to the total, differs by at most 1 and puts the larger parts first', () => {
    for (let total = -150; total <= 150; total++) {
      for (let parts = 1; parts <= 14; parts++) {
        const split = splitEvenly(total, parts);
        expect(split).toHaveLength(parts);
        expect(sumCents(split)).toBe(total);
        expect(Math.max(...split) - Math.min(...split)).toBeLessThanOrEqual(1);
        expect(split).toEqual([...split].sort((a, b) => b - a));
      }
    }
  });

  it('stays exact for amounts far beyond float comfort', () => {
    const total = 1_000_000_000_000; // MAX_CENTS
    const split = splitEvenly(total, 7);
    expect(sumCents(split)).toBe(total);
    expect(split).toEqual([
      142857142858, 142857142857, 142857142857, 142857142857, 142857142857, 142857142857,
      142857142857,
    ]);
  });

  it('splitEvenly is exact for every safe total', () => {
    const p = splitEvenly(-Number.MAX_SAFE_INTEGER, 3);
    expect(p.every(Number.isSafeInteger)).toBe(true);
    expect(p.reduce((a, b) => a + b, 0)).toBe(-Number.MAX_SAFE_INTEGER);
  });

  it('is exact at both ends of the safe range, for any number of parts (checked with BigInt)', () => {
    const totals = [
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER - 6,
      -Number.MAX_SAFE_INTEGER,
      -Number.MAX_SAFE_INTEGER + 1,
      -Number.MAX_SAFE_INTEGER + 6,
      -(2 ** 52),
      2 ** 52,
    ];
    for (const total of totals) {
      for (let parts = 1; parts <= 31; parts++) {
        const split = splitEvenly(total, parts);
        const label = `splitEvenly(${total}, ${parts})`;
        expect(split, label).toHaveLength(parts);
        expect(split.every(Number.isSafeInteger), `${label}: safe integers`).toBe(true);
        // BigInt is exact by construction: the parts add up to the total, differ by at most 1 and
        // the larger ones come first.
        expect(
          split.reduce((sum, part) => sum + BigInt(part), 0n),
          `${label}: sum`,
        ).toBe(BigInt(total));
        expect(Math.max(...split) - Math.min(...split), `${label}: spread`).toBeLessThanOrEqual(1);
        expect(split, `${label}: larger parts first`).toEqual([...split].sort((a, b) => b - a));
      }
    }
  });

  it('gives the same parts as before for every ordinary total (the fix changes nothing there)', () => {
    // The previous formulation, with a non-negative remainder taken first, kept for the comparison.
    const previous = (total: number, parts: number): number[] => {
      const remainder = ((total % parts) + parts) % parts;
      const base = (total - remainder) / parts;
      return Array.from({ length: parts }, (_unused, i) => (i < remainder ? base + 1 : base));
    };
    for (let total = -2000; total <= 2000; total++) {
      for (let parts = 1; parts <= 30; parts++) {
        expect(splitEvenly(total, parts), `splitEvenly(${total}, ${parts})`).toEqual(
          previous(total, parts),
        );
      }
    }
    // 120,000 `expect` calls: about 3 s alone, but over the default 5 s timeout on a busy machine
    // (the other workspaces' tests share the CPU), so it has a generous timeout of its own.
  }, 60_000);

  it('agrees with ceilDiv: the first part is the ceiling of the average', () => {
    for (let total = 0; total <= 200; total++) {
      for (let parts = 1; parts <= 14; parts++) {
        expect(splitEvenly(total, parts)[0]).toBe(ceilDiv(total, parts));
      }
    }
  });

  it.each([
    ['zero parts', 10, 0],
    ['negative parts', 10, -1],
    ['fractional parts', 10, 2.5],
    ['NaN parts', 10, Number.NaN],
    ['a fractional total', 10.5, 2],
    ['a NaN total', Number.NaN, 2],
    ['an infinite total', Number.POSITIVE_INFINITY, 2],
  ])('throws a RangeError for %s', (_label, total, parts) => {
    expect(() => splitEvenly(total, parts)).toThrow(RangeError);
  });
});
