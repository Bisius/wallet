/**
 * Property-based tests (fast-check) of the month helpers: `addMonths`, `monthDiff`, `monthRange`,
 * `compareMonths`, `toMonthKey` / `parseMonthKey` and `monthKeyOf`, with year wraps everywhere.
 *
 * The reference is plain arithmetic on a month number (12 * year + month - 1) written in the test, and
 * string comparison, which the rest of the code relies on (`'2026-09' < '2026-10'`). Fixed seed, so
 * CI is stable; a deeper sweep is `FC_RUNS_FACTOR=20 npx vitest run src/month.property.test.ts`.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addMonths,
  compareMonths,
  isMonthKey,
  monthDiff,
  monthKeyOf,
  monthRange,
  parseMonthKey,
  toMonthKey,
} from './month';

// `process` is not typed in this package (no @types/node), hence the cast.
const env =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const SEED = Number(env['FC_SEED'] ?? 20261002);
const FACTOR = Number(env['FC_RUNS_FACTOR'] ?? 1);
/** Per-test timeout (ms), generous because a loaded machine runs several packages at once. */
const SLOW = { timeout: 60_000 };
const params = (runs: number) => ({ seed: SEED, numRuns: Math.max(1, Math.round(runs * FACTOR)) });

// The years the app can meet, with the year-wrap neighbourhood (Nov, Dec, Jan, Feb) over-represented.
const year = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 2000, max: 2100 }) },
  { weight: 2, arbitrary: fc.integer({ min: 200, max: 9000 }) },
  { weight: 1, arbitrary: fc.constantFrom(200, 1999, 2000, 2024, 2026, 2100, 9000) },
);
const monthOfYear = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(1, 2, 11, 12) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 12 }) },
);
/** Written out here rather than with `toMonthKey`, so that the helper is not its own reference. */
const format = (y: number, m: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
const monthKey = fc.tuple(year, monthOfYear).map(([y, m]) => format(y, m));
/** A shift that stays well inside years 1 to 9998 from any key above (years 200 to 9000). */
const shift = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: -30, max: 30 }) },
  { weight: 2, arbitrary: fc.integer({ min: -1_200, max: 1_200 }) },
  { weight: 1, arbitrary: fc.constantFrom(-24, -13, -12, -11, -1, 0, 1, 11, 12, 13, 24, 120) },
);
/** The month number of a key: 12 * year + month - 1. */
const monthNumber = (key: string) => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1;

describe('month keys', SLOW, () => {
  it('toMonthKey and parseMonthKey are inverse, and every key they make is valid', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9999 }), fc.integer({ min: 1, max: 12 }), (y, m) => {
        const key = toMonthKey(y, m);
        expect(key).toBe(format(y, m));
        expect(isMonthKey(key)).toBe(true);
        expect(parseMonthKey(key)).toEqual({ year: y, month: m });
      }),
      params(3000),
    );
  });

  it('accepts exactly four digits, a dash and a month from 01 to 12', () => {
    const notKey = fc.oneof(
      fc
        .tuple(fc.integer({ min: 0, max: 9999 }), fc.constantFrom(0, 13, 14, 19, 20, 99))
        .map(([y, m]) => format(y, m)),
      fc
        .integer({ min: 0, max: 99_999 })
        .map((y) => `${y}-01`)
        .filter((s) => !/^\d{4}-/.test(s)),
      fc
        .tuple(year, monthOfYear)
        .map(([y, m]) => `${y}-${m}`)
        .filter((s) => !/^\d{4}-\d{2}$/.test(s)),
      fc.tuple(year, monthOfYear).map(([y, m]) => `${format(y, m)}-01`),
      fc.tuple(year, monthOfYear).map(([y, m]) => ` ${format(y, m)}`),
      fc.tuple(year, monthOfYear).map(([y, m]) => `${format(y, m)}\n`),
      fc.tuple(year, monthOfYear).map(([y, m]) => `${y}/${String(m).padStart(2, '0')}`),
      fc.constantFrom('', '2026', '2026-', '-10', '2026-1', '26-10', 'abcd-ef', '٢٠٢٦-١٠'),
    );
    fc.assert(
      fc.property(notKey, (text) => {
        expect(isMonthKey(text), JSON.stringify(text)).toBe(false);
      }),
      params(2000),
    );
    fc.assert(
      fc.property(monthKey, (key) => {
        expect(isMonthKey(key)).toBe(true);
      }),
      params(1000),
    );
  });

  it('orders chronologically as strings: the comparison the ledger relies on', () => {
    fc.assert(
      fc.property(monthKey, monthKey, (a, b) => {
        const chronological = Math.sign(monthNumber(a) - monthNumber(b));
        expect(compareMonths(a, b)).toBe(chronological);
        expect(a < b).toBe(chronological < 0);
        expect(a > b).toBe(chronological > 0);
        expect(a === b).toBe(chronological === 0);
      }),
      params(3000),
    );
  });
});

describe('addMonths', SLOW, () => {
  it('moves by whole months, across year boundaries, to a valid key', () => {
    fc.assert(
      fc.property(monthKey, shift, (key, delta) => {
        const moved = addMonths(key, delta);
        expect(isMonthKey(moved), `addMonths(${key}, ${delta}) = ${moved}`).toBe(true);
        expect(monthNumber(moved)).toBe(monthNumber(key) + delta);
      }),
      params(4000),
    );
  });

  it('adds nothing for 0, adds in steps (a + b then c is a then b + c), and undoes itself', () => {
    fc.assert(
      fc.property(monthKey, shift, shift, (key, a, b) => {
        expect(addMonths(key, 0)).toBe(key);
        expect(addMonths(addMonths(key, a), b)).toBe(addMonths(key, a + b));
        expect(addMonths(addMonths(key, a), -a)).toBe(key);
        expect(addMonths(key, 12)).toBe(
          format(Number(key.slice(0, 4)) + 1, Number(key.slice(5, 7))),
        );
      }),
      params(3000),
    );
  });

  it('wraps December to January and January to December', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9998 }), (y) => {
        expect(addMonths(format(y, 12), 1)).toBe(format(y + 1, 1));
        expect(addMonths(format(y, 1), -1)).toBe(format(y - 1, 12));
        expect(addMonths(format(y, 11), 2)).toBe(format(y + 1, 1));
        expect(addMonths(format(y, 1), 11)).toBe(format(y, 12));
      }),
      params(1000),
    );
  });
});

describe('monthDiff', SLOW, () => {
  it('is the inverse of addMonths: the distance from a to a + n is n, and a + the distance from a to b is b', () => {
    fc.assert(
      fc.property(monthKey, monthKey, shift, (a, b, n) => {
        expect(monthDiff(a, addMonths(a, n))).toBe(n);
        expect(addMonths(a, monthDiff(a, b))).toBe(b);
      }),
      params(3000),
    );
  });

  it('is antisymmetric, zero only for the same month, and additive (a to c is a to b plus b to c)', () => {
    fc.assert(
      fc.property(monthKey, monthKey, monthKey, (a, b, c) => {
        expect(monthDiff(a, b)).toBe(-monthDiff(b, a) + 0);
        expect(monthDiff(a, a)).toBe(0);
        expect(monthDiff(a, b) === 0).toBe(a === b);
        expect(monthDiff(a, c)).toBe(monthDiff(a, b) + monthDiff(b, c));
        expect(monthDiff(a, b)).toBe(monthNumber(b) - monthNumber(a));
      }),
      params(3000),
    );
  });
});

describe('monthRange', SLOW, () => {
  /** A short span from a key, so ranges stay small: 0 to 70 months, year wraps included. */
  const span = fc.integer({ min: 0, max: 70 });

  it('lists every month from `from` to `to`, once each, in order, as valid keys', () => {
    fc.assert(
      fc.property(monthKey, span, (from, n) => {
        const to = addMonths(from, n);
        const months = monthRange(from, to);
        // The reference: year and month straight from the month number, one comparison per range.
        const start = monthNumber(from);
        const reference = Array.from({ length: n + 1 }, (_unused, index) =>
          format(Math.floor((start + index) / 12), ((start + index) % 12) + 1),
        );
        expect(months).toEqual(reference);
        expect(months.every(isMonthKey)).toBe(true);
        expect(months.map((month) => monthDiff(from, month))).toEqual(
          reference.map((_m, index) => index),
        );
        expect([...months].sort()).toEqual(months); // ascending as strings too
      }),
      params(2000),
    );
  });

  it('is empty when `from` is after `to`, and one month when they are the same', () => {
    fc.assert(
      fc.property(monthKey, fc.integer({ min: 1, max: 70 }), (from, n) => {
        expect(monthRange(from, addMonths(from, -n))).toEqual([]);
        expect(monthRange(from, from)).toEqual([from]);
      }),
      params(1500),
    );
  });

  it('splits and joins: the range a..c is the range a..b followed by the range after b to c', () => {
    fc.assert(
      fc.property(monthKey, span, span, (a, first, second) => {
        const b = addMonths(a, first);
        const c = addMonths(b, second);
        expect(monthRange(a, c)).toEqual([...monthRange(a, b), ...monthRange(addMonths(b, 1), c)]);
      }),
      params(1500),
    );
  });
});

describe('monthKeyOf', SLOW, () => {
  it('is the local calendar month of a date, on every day, including the first and last second of a month', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1971, max: 2100 }),
        fc.integer({ min: 0, max: 11 }),
        fc.constantFrom('first second', 'noon', 'last second', 'a day'),
        fc.integer({ min: 1, max: 31 }),
        (y, m, when, day) => {
          const days = new Date(y, m + 1, 0).getDate(); // the length of the month, local calendar
          const date =
            when === 'first second'
              ? new Date(y, m, 1, 0, 0, 0)
              : when === 'last second'
                ? new Date(y, m, days, 23, 59, 59)
                : when === 'noon'
                  ? new Date(y, m, Math.min(day, days), 12, 0, 0)
                  : new Date(y, m, Math.min(day, days), 5, 7, 9);
          expect(monthKeyOf(date)).toBe(format(y, m + 1));
        },
      ),
      params(3000),
    );
  });
});
