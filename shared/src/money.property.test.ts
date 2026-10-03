/**
 * Property-based tests (fast-check) of the money helpers: `ceilDiv`, `splitEvenly`, `sumCents`,
 * `isCents`, and the `parseCents` / `formatCents` round trip. Fixed seed, so CI is stable; a deeper
 * sweep is `FC_RUNS_FACTOR=20 npx vitest run src/money.property.test.ts` (another seed:
 * `FC_SEED=123`). A failure prints the seed, the path and the shrunk counterexample.
 *
 * The reference for every property is exact BigInt arithmetic or the mathematical definition (the
 * smallest q with q * d >= n), never another float computation.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_CENTS } from './limits';
import { ceilDiv, formatCents, isCents, parseCents, splitEvenly, sumCents } from './money';

// `process` is not typed in this package (no @types/node), hence the cast.
const env =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const SEED = Number(env['FC_SEED'] ?? 20261002);
const FACTOR = Number(env['FC_RUNS_FACTOR'] ?? 1);
/** Per-test timeout (ms), generous because a loaded machine runs several packages at once. */
const SLOW = { timeout: 60_000 };
const params = (runs: number) => ({ seed: SEED, numRuns: Math.max(1, Math.round(runs * FACTOR)) });

const MAX = Number.MAX_SAFE_INTEGER;

/** Any integer amount: small, money-sized, anywhere in the safe range, and the awkward edges. */
const anyInteger: fc.Arbitrary<number> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: -100_000, max: 100_000 }) },
  { weight: 2, arbitrary: fc.integer({ min: -MAX_CENTS, max: MAX_CENTS }) },
  { weight: 2, arbitrary: fc.integer({ min: -MAX, max: MAX }) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      0,
      1,
      -1,
      MAX,
      -MAX,
      MAX - 1,
      1 - MAX,
      2 ** 52,
      -(2 ** 52),
      2 ** 53 - 2,
    ),
  },
);

/** A positive divisor: small (the real case: months), large, and the edges. */
const divisor: fc.Arbitrary<number> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 1, max: 40 }) },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 100_000 }) },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: MAX }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(1, 2, 3, 12, MAX, MAX - 1, 2 ** 52, 2 ** 26 + 1, 94_906_265),
  },
);

/** floor(n / d) by BigInt (BigInt division truncates toward zero, which is not the floor below 0). */
function floorDivBig(n: number, d: number): bigint {
  const modulo = ((BigInt(n) % BigInt(d)) + BigInt(d)) % BigInt(d);
  return (BigInt(n) - modulo) / BigInt(d);
}

/** `q` with `q * d >= n` and `(q - 1) * d < n`, by BigInt: the ceiling, from the definition. */
const isCeiling = (q: number, n: number, d: number): boolean =>
  BigInt(q) * BigInt(d) >= BigInt(n) && (BigInt(q) - 1n) * BigInt(d) < BigInt(n);

describe('ceilDiv', SLOW, () => {
  it('is the ceiling of the true quotient: the smallest q with q * d >= n, for any safe n and any positive d', () => {
    fc.assert(
      fc.property(anyInteger, divisor, (n, d) => {
        const q = ceilDiv(n, d);
        expect(Number.isSafeInteger(q), `ceilDiv(${n}, ${d}) = ${q} is not a safe integer`).toBe(
          true,
        );
        expect(isCeiling(q, n, d), `ceilDiv(${n}, ${d}) = ${q}`).toBe(true);
      }),
      params(5000),
    );
  });

  it('agrees with BigInt arithmetic', () => {
    fc.assert(
      fc.property(anyInteger, divisor, (n, d) => {
        const quotient = BigInt(n) / BigInt(d); // truncates toward zero
        const expected = BigInt(n) % BigInt(d) > 0n ? quotient + 1n : quotient;
        expect(BigInt(ceilDiv(n, d))).toBe(expected);
      }),
      params(3000),
    );
  });

  it('gives back the quotient of an exact multiple, and is the identity for a divisor of 1', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (q, d) => {
          expect(ceilDiv(q * d, d)).toBe(q);
          expect(ceilDiv(q, 1)).toBe(q);
          // One more cent needs one more unit; one less needs one fewer only when the unit is a cent.
          expect(ceilDiv(q * d + 1, d)).toBe(q + 1);
          expect(ceilDiv(q * d - 1, d)).toBe(d === 1 ? q - 1 : q);
        },
      ),
      params(2000),
    );
  });

  it('never decreases when the numerator grows, and by at most 1 per cent', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 5_000 }),
        divisor,
        (n, grow, d) => {
          const smaller = ceilDiv(n, d);
          const larger = ceilDiv(n + grow, d);
          expect(larger).toBeGreaterThanOrEqual(smaller);
          expect(larger - smaller).toBeLessThanOrEqual(grow);
        },
      ),
      params(2000),
    );
  });

  it('throws a RangeError for a divisor that is not a positive safe integer, and for a numerator that is not a safe integer', () => {
    const notPositiveSafe = fc.oneof(
      fc.integer({ min: -1_000_000, max: 0 }),
      fc.double({ min: 0.01, max: 1e6, noNaN: true }).filter((x) => !Number.isInteger(x)),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, MAX + 2),
    );
    const notSafe = fc.oneof(
      fc.double({ min: -1e6, max: 1e6, noNaN: true }).filter((x) => !Number.isInteger(x)),
      fc.constantFrom(
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        MAX + 2,
        -MAX - 2,
      ),
    );
    fc.assert(
      fc.property(
        anyInteger,
        notPositiveSafe,
        notSafe,
        divisor,
        (n, badDivisor, badNumerator, d) => {
          expect(() => ceilDiv(n, badDivisor)).toThrow(RangeError);
          expect(() => ceilDiv(badNumerator, d)).toThrow(RangeError);
        },
      ),
      params(1000),
    );
  });
});

describe('splitEvenly', SLOW, () => {
  /** Parts counts: the real case (months), plus a few larger ones. */
  const parts: fc.Arbitrary<number> = fc.oneof(
    { weight: 4, arbitrary: fc.integer({ min: 1, max: 14 }) },
    { weight: 2, arbitrary: fc.integer({ min: 1, max: 200 }) },
    { weight: 1, arbitrary: fc.constantFrom(1, 2, 3, 7, 12, 31, 365, 1000) },
  );

  it('sums exactly to the total, in safe integers, whatever the total (both ends of the safe range included)', () => {
    fc.assert(
      fc.property(anyInteger, parts, (total, count) => {
        const split = splitEvenly(total, count);
        expect(split).toHaveLength(count);
        expect(
          split.every(Number.isSafeInteger),
          `splitEvenly(${total}, ${count}) is not all safe integers`,
        ).toBe(true);
        expect(split.reduce((sum, part) => sum + BigInt(part), 0n)).toBe(BigInt(total));
      }),
      params(4000),
    );
  });

  it('gives parts that differ by at most 1, larger ones first, the first being the ceiling and the last the floor of the average', () => {
    fc.assert(
      fc.property(anyInteger, parts, (total, count) => {
        const split = splitEvenly(total, count);
        // Plain loops: this runs on parts lists of up to 1000 numbers, and `expect` per element is slow.
        for (let i = 1; i < split.length; i++) {
          if (split[i - 1]! < split[i]!) {
            throw new Error(
              `splitEvenly(${total}, ${count}): part ${i} is larger than part ${i - 1}`,
            );
          }
        }
        expect(split[0]! - split[count - 1]!).toBeLessThanOrEqual(1);
        expect(split[0]).toBe(ceilDiv(total, count));
        expect(BigInt(split[count - 1]!)).toBe(floorDivBig(total, count));
      }),
      params(3000),
    );
  });

  it('hands the remainder to the first parts: exactly (total mod parts) of them are one larger, checked on every prefix sum', () => {
    fc.assert(
      fc.property(anyInteger, parts, (total, count) => {
        const split = splitEvenly(total, count);
        const d = BigInt(count);
        const floor = floorDivBig(total, count);
        const remainder = ((BigInt(total) % d) + d) % d; // 0 <= remainder < parts
        let prefix = 0n;
        for (let index = 0; index < split.length; index++) {
          prefix += BigInt(split[index]!);
          const j = BigInt(index + 1);
          const expected = j * floor + (j < remainder ? j : remainder);
          if (prefix !== expected) {
            throw new Error(
              `the first ${index + 1} parts of splitEvenly(${total}, ${count}) add up to ${prefix}, expected ${expected}`,
            );
          }
        }
      }),
      params(3000),
    );
  });

  it('is the total itself for one part, and all equal parts for an exact multiple', () => {
    fc.assert(
      fc.property(
        anyInteger,
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: 1, max: 360 }),
        (total, each, count) => {
          expect(splitEvenly(total, 1)).toEqual([total]);
          expect(splitEvenly(each * count, count)).toEqual(
            Array.from({ length: count }, () => each),
          );
        },
      ),
      params(1500),
    );
  });

  it('splits a yearly price over the months left the way the reserve needs: the parts of 12 add up to the price', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_CENTS }), (price) => {
        const split = splitEvenly(price, 12);
        expect(split.reduce((sum, part) => sum + BigInt(part), 0n)).toBe(BigInt(price));
        expect(split[0]).toBe(ceilDiv(price, 12)); // "100.00 over 12 months is 8.34 first"
      }),
      params(1500),
    );
  });

  it('throws a RangeError for a count that is not a positive safe integer, and for a total that is not a safe integer', () => {
    const badParts = fc.oneof(
      fc.integer({ min: -1_000, max: 0 }),
      fc.double({ min: 0.01, max: 1e3, noNaN: true }).filter((x) => !Number.isInteger(x)),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, MAX + 2),
    );
    const badTotal = fc.oneof(
      fc.double({ min: -1e6, max: 1e6, noNaN: true }).filter((x) => !Number.isInteger(x)),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, MAX + 2),
    );
    fc.assert(
      fc.property(anyInteger, badParts, badTotal, (total, count, bad) => {
        expect(() => splitEvenly(total, count)).toThrow(RangeError);
        expect(() => splitEvenly(bad, 3)).toThrow(RangeError);
      }),
      params(800),
    );
  });
});

describe('sumCents and isCents', SLOW, () => {
  it('sums exactly (checked with BigInt) and in any order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -MAX_CENTS, max: MAX_CENTS }), { maxLength: 60 }),
        fc.integer({ min: 0, max: 59 }),
        (values, pivot) => {
          const expected = values.reduce((sum, v) => sum + BigInt(v), 0n);
          expect(BigInt(sumCents(values))).toBe(expected);
          const rotated = [...values.slice(pivot), ...values.slice(0, pivot)];
          expect(sumCents(rotated)).toBe(sumCents(values));
          expect(sumCents([...values].reverse())).toBe(sumCents(values));
        },
      ),
      params(1000),
    );
  });

  it('accepts exactly the safe integers', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.double(),
          fc.bigInt(),
          fc.string(),
          fc.constantFrom(null, undefined, true, -0, MAX, MAX + 1, -MAX, -MAX - 1, 0.5),
        ),
        (value) => {
          const expected =
            typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= MAX;
          expect(isCents(value)).toBe(expected);
        },
      ),
      params(2000),
    );
  });
});

// -------------------------------------------------------------------------------------------------
// parseCents and formatCents
// -------------------------------------------------------------------------------------------------

/** `12.34` for 1234 and `-0.05` for -5, by integer arithmetic only. */
function plain(cents: number): string {
  const absolute = BigInt(cents) < 0n ? -BigInt(cents) : BigInt(cents);
  return `${cents < 0 ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

const money = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: -100_000, max: 100_000 }) },
  { weight: 3, arbitrary: fc.integer({ min: -MAX_CENTS, max: MAX_CENTS }) },
  { weight: 1, arbitrary: fc.constantFrom(0, 1, -1, 99, 100, 101, -99, MAX_CENTS, -MAX_CENTS) },
);

describe('parseCents', SLOW, () => {
  it('reads back the plain decimal form of any amount up to the largest the API accepts, exactly', () => {
    fc.assert(
      fc.property(money, (cents) => {
        expect(parseCents(plain(cents))).toBe(cents);
      }),
      params(4000),
    );
  });

  it('accepts a decimal comma, a missing or one-digit fraction, leading zeros, and spaces anywhere', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_CENTS }),
        fc.boolean(),
        fc.integer({ min: 0, max: 3 }),
        fc.constantFrom(' ', '\u00a0', '\u202f', '\t'),
        (cents, wantsMinus, zeros, space) => {
          const negative = wantsMinus && cents > 0; // "-0" is its own case, below
          const expected = negative ? -cents : cents;
          const sign = negative ? '-' : '';
          const [whole, fraction] = plain(cents).split('.') as [string, string];
          const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, space);
          const padded = '0'.repeat(zeros) + grouped;
          // Two fraction digits, with a point and with a comma, with grouping and surrounding spaces.
          expect(parseCents(`${sign}${padded}.${fraction}`)).toBe(expected);
          expect(parseCents(` ${sign}${padded},${fraction} `)).toBe(expected);
          // No fraction: whole units.
          if (cents % 100 === 0) expect(parseCents(`${sign}${padded}`)).toBe(expected);
          // One fraction digit is tenths.
          if (cents % 10 === 0)
            expect(parseCents(`${sign}${padded}.${fraction.slice(0, 1)}`)).toBe(expected);
        },
      ),
      params(2000),
    );
  });

  it('is idempotent: whatever a string parses to, the plain form of it parses to the same', () => {
    const almostMoney = fc.stringMatching(/^[ \-]?[0-9]{0,12}([.,][0-9]{0,3})?[ ]?$/);
    fc.assert(
      fc.property(almostMoney, (text) => {
        const cents = parseCents(text);
        if (cents === null) return;
        expect(Number.isSafeInteger(cents), `${JSON.stringify(text)} gave ${cents}`).toBe(true);
        // (A negative zero is its own, known defect: see the `fails` test below.)
        expect(parseCents(plain(cents))).toBe(cents === 0 ? 0 : cents);
      }),
      params(3000),
    );
  });

  it('rejects what is not an amount: three fraction digits, two separators, letters, a bare sign or separator', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999_999 }),
        fc.integer({ min: 100, max: 999 }),
        fc.constantFrom(
          'a',
          'x',
          'e',
          '€',
          '+',
          '--',
          '..',
          ',,',
          '.,',
          '1.2.3',
          '0x',
          'NaN',
          '1e5',
        ),
        (whole, threeDigits, junk) => {
          expect(parseCents(`${whole}.${threeDigits}`)).toBeNull();
          expect(parseCents(`${whole}${junk}`)).toBeNull();
          expect(parseCents(`${junk}${whole}`)).toBeNull();
          expect(parseCents(`${whole}.`)).toBeNull();
          expect(parseCents(`.${threeDigits % 100}`)).toBeNull();
        },
      ),
      params(1000),
    );
    for (const text of ['', ' ', '-', '.', ',', '-.', '+5', '--5', '5-']) {
      expect(parseCents(text), JSON.stringify(text)).toBeNull();
    }
  });

  // Regression: `parseCents('-0')` used to return -0, and `formatCents(-0)` prints "-€0.00" (Intl
  // shows the sign of a negative zero), so a user who typed "-0" saw a negative zero amount.
  it('never returns a negative zero: "-0", "-0.00" and "-000,0" are 0', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('-0', '-0.0', '-0.00', '-0,00', '-000', ' -0 ', '-0.', '-00,0'),
        (text) => {
          const cents = parseCents(text);
          if (cents === null) return; // not an amount at all is fine
          expect(Object.is(cents, -0), `parseCents(${JSON.stringify(text)}) is -0`).toBe(false);
        },
      ),
      params(50),
    );
  });

  // Regression: `parseCents` used to take any number of digits, and `Number(whole) * 100` is not
  // exact above 2^53 cents (about 90 trillion units), so "90071992547410" (14 digits) came back as an
  // unsafe integer that was not the amount typed. `Cents` is a SAFE integer (`isCents`), so an
  // out-of-range amount is `null`.
  it('returns null or a safe integer for any digits, never an inexact amount', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[1-9][0-9]{13,24}(\.[0-9]{1,2})?$/), (text) => {
        const cents = parseCents(text);
        expect(
          cents === null || Number.isSafeInteger(cents),
          `parseCents(${text}) = ${cents}`,
        ).toBe(true);
      }),
      params(200),
    );
  });
});

describe('formatCents', SLOW, () => {
  const locales = [
    'en-US',
    'en-GB',
    'de-DE',
    'fr-FR',
    'it-IT',
    'es-ES',
    'nl-NL',
    'pt-BR',
    'en-IN',
    'de-CH',
    'sv-SE',
    'pl-PL',
    'ru-RU',
  ];
  const currencies = ['EUR', 'USD', 'GBP', 'CHF'];

  /** The amount in the formatted string, rebuilt from its parts (no symbol, no grouping), as a plain decimal. */
  function digitsOf(cents: number, currency: string, locale: string): string {
    const parts = new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(
      cents / 100,
    );
    const negative = parts.some((p) => p.type === 'minusSign');
    const whole = parts
      .filter((p) => p.type === 'integer')
      .map((p) => p.value)
      .join('');
    const fraction = parts.find((p) => p.type === 'fraction')?.value ?? '';
    return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
  }

  it('shows exactly the cents it is given, in every locale and currency with two decimals, up to the largest amount the API accepts', () => {
    fc.assert(
      fc.property(
        money,
        fc.constantFrom(...locales),
        fc.constantFrom(...currencies),
        (cents, locale, currency) => {
          // The text `formatCents` produces, taken apart: its digits are the amount.
          const text = formatCents(cents, currency, locale);
          expect(text.length).toBeGreaterThan(0);
          expect(
            parseCents(digitsOf(cents, currency, locale)),
            `${text} (${locale}, ${currency})`,
          ).toBe(cents);
          // A negative amount, and only a negative amount, is formatted with a minus sign.
          const hasMinus = /[-−]/.test(text);
          expect(hasMinus, `${text} for ${cents}`).toBe(cents < 0);
        },
      ),
      params(3000),
    );
  });

  it('formats an amount and its opposite alike, apart from the sign', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_CENTS }),
        fc.constantFrom('en-US', 'de-DE', 'fr-FR'),
        (cents, locale) => {
          const plus = digitsOf(cents, 'EUR', locale);
          const minus = digitsOf(-cents, 'EUR', locale);
          expect(minus).toBe(`-${plus}`);
        },
      ),
      params(1000),
    );
  });
});
