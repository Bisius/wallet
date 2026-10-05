/**
 * Property tests (fast-check) of the amount parser against `parseCents` (docs/DOMAIN.md, "The
 * `/spending` flow", step 2). Fixed seed, so CI is stable; a deeper sweep is
 * `FC_RUNS_FACTOR=20 npx vitest run src/modules/telegram/telegram.parse.property.test.ts` (another
 * seed: `FC_SEED=123`). A failure prints the seed, the path and the shrunk counterexample.
 *
 * The references are `parseCents` itself (the one reader of the digits), exact BigInt arithmetic,
 * and `cleanImportText` for the notes. No float is used to build an amount: a test amount is
 * written from integer cents by integer division and remainder.
 *
 * `parseCents` also ignores every space inside its input (`"1 2"` is 12). The bot reads a space as
 * the end of the amount (`"1 2"` is 1 and the note "2"), so the properties against `parseCents` are
 * about text with no whitespace in the number, and the note ones are about what comes after it.
 */
import { MAX_CENTS, cleanImportText, parseCents } from '@wallet/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SLOW, config } from '../../testing/prop';
import { type AmountProblem, readAmountMessage } from './telegram.parse';

const reading = (text: string) => readAmountMessage(text);
const problemOf = (text: string): AmountProblem | 'ok' => {
  const result = reading(text);
  return result.ok ? 'ok' : result.problem;
};

/** Whole units and the two decimals of |cents|, by integer remainder (never a float quotient). */
function parts(abs: bigint): { whole: string; fraction: string } {
  return { whole: String(abs / 100n), fraction: String(abs % 100n).padStart(2, '0') };
}

type Style = 'dot' | 'comma' | 'prefix' | 'suffix' | 'spaced-suffix' | 'spaced-prefix';

/** One way a person may write `cents` (a non-zero integer, any sign) that the bot accepts. */
function written(cents: bigint, style: Style, minus: '-' | '−' | 'after-symbol'): string {
  const negative = cents < 0n;
  const { whole, fraction } = parts(negative ? -cents : cents);
  const number = `${whole}${style === 'comma' ? ',' : '.'}${fraction}`;
  const sign = negative ? (minus === '−' ? '−' : '-') : '';
  switch (style) {
    case 'prefix':
      return minus === 'after-symbol' && negative ? `€-${number}` : `${sign}€${number}`;
    case 'spaced-prefix':
      return `${sign}€ ${number}`;
    case 'suffix':
      return `${sign}${number}€`;
    case 'spaced-suffix':
      return `${sign}${number} €`;
    default:
      return `${sign}${number}`;
  }
}

/** Non-zero cents the bot accepts: small, money-sized, and the edges. */
const acceptedCents: fc.Arbitrary<bigint> = fc
  .oneof(
    { weight: 4, arbitrary: fc.integer({ min: -100_000, max: 100_000 }) },
    { weight: 3, arbitrary: fc.integer({ min: -MAX_CENTS, max: MAX_CENTS }) },
    { weight: 1, arbitrary: fc.constantFrom(1, -1, 99, 100, 101, MAX_CENTS, -MAX_CENTS) },
  )
  .filter((cents) => cents !== 0)
  .map(BigInt);

const styles: fc.Arbitrary<Style> = fc.constantFrom(
  'dot',
  'comma',
  'prefix',
  'suffix',
  'spaced-suffix',
  'spaced-prefix',
);

const minuses = fc.constantFrom<'-' | '−' | 'after-symbol'>('-', '−', 'after-symbol');

/** A note that cannot be mistaken for part of the amount: it starts with a letter. */
const safeNote = fc
  .tuple(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzÀéßñ'), fc.string({ maxLength: 60 }))
  .map(([first, rest]) => `${first}${rest}`);

describe('what is written is read back', () => {
  it(
    'any non-zero amount, written in any accepted style, is read back to the same cents',
    () => {
      fc.assert(
        fc.property(acceptedCents, styles, minuses, (cents, style, minus) => {
          const text = written(cents, style, minus);
          const result = reading(text);
          expect(result, text).toEqual({ ok: true, amount: Number(cents), note: '' });
        }),
        config(600),
      );
    },
    SLOW,
  );

  it(
    'a note after the amount comes back cleaned, whatever the style of the amount',
    () => {
      fc.assert(
        fc.property(acceptedCents, styles, safeNote, (cents, style, note) => {
          fc.pre(cleanImportText(note).length <= 200);
          const result = reading(`${written(cents, style, '-')} ${note}`);
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.amount).toBe(Number(cents));
            expect(result.note).toBe(cleanImportText(note));
          }
        }),
        config(400),
      );
    },
    SLOW,
  );

  it(
    'is stable: what it read, written again, is read the same',
    () => {
      fc.assert(
        fc.property(acceptedCents, safeNote, (cents, note) => {
          fc.pre(cleanImportText(note).length <= 200);
          const first = reading(`${written(cents, 'comma', '-')} ${note}`);
          expect(first.ok).toBe(true);
          if (!first.ok) return;
          const second = reading(`${written(BigInt(first.amount), 'dot', '-')} ${first.note}`);
          expect(second).toEqual(first);
        }),
        config(300),
      );
    },
    SLOW,
  );
});

describe('against parseCents', () => {
  /** Text over the characters an amount is made of, with no whitespace. */
  const amountLike = fc.string({
    unit: fc.constantFrom(...'0123456789.,-'),
    minLength: 1,
    maxLength: 16,
  });

  it(
    'any whitespace-free text that parseCents accepts is read to the same cents (but 0 and above MAX_CENTS)',
    () => {
      fc.assert(
        fc.property(amountLike, (text) => {
          const cents = parseCents(text);
          const result = reading(text);
          if (cents === null) {
            expect(result.ok, text).toBe(false);
          } else if (cents === 0 || Math.abs(cents) > MAX_CENTS) {
            expect(result.ok, text).toBe(false);
          } else {
            expect(result, text).toEqual({ ok: true, amount: cents, note: '' });
          }
        }),
        config(2000),
      );
    },
    SLOW,
  );

  it(
    'whatever it reads, parseCents reads the same (it never invents an amount)',
    () => {
      fc.assert(
        fc.property(
          fc.string({ unit: fc.constantFrom(...'0123456789.,- €$x'), maxLength: 18 }),
          (text) => {
            const result = reading(text);
            if (!result.ok) return;
            const numberPart = /^[-−]?(?:€\s*)?[-]?(\d+(?:[.,]\d{1,2})?)/.exec(text.trim());
            expect(numberPart, text).not.toBeNull();
            const digits = numberPart?.[1] ?? '';
            const cents = parseCents(digits);
            expect(cents, text).not.toBeNull();
            expect(Math.abs(result.amount), text).toBe(cents);
          },
        ),
        config(2000),
      );
    },
    SLOW,
  );

  it(
    'an amount parseCents reads, with a note after a space, is that amount and that note',
    () => {
      fc.assert(
        fc.property(amountLike, safeNote, (text, note) => {
          const cents = parseCents(text);
          fc.pre(cents !== null && cents !== 0 && Math.abs(cents) <= MAX_CENTS);
          fc.pre(cleanImportText(note).length <= 200);
          const result = reading(`${text} ${note}`);
          expect(result.ok, text).toBe(true);
          if (result.ok)
            expect(result).toEqual({ ok: true, amount: cents, note: cleanImportText(note) });
        }),
        config(800),
      );
    },
    SLOW,
  );
});

describe('zero is never an amount', () => {
  const zeros = fc
    .tuple(
      fc.constantFrom('', '-', '−'),
      fc.constantFrom('', '€', '€ '),
      fc.integer({ min: 1, max: 8 }).map((n) => '0'.repeat(n)),
      fc.constantFrom('', '.0', '.00', ',0', ',00'),
      fc.constantFrom('', '€', ' €'),
      fc.constantFrom('', ' coffee', ' ☕ x'),
    )
    .filter(([, prefix, , , suffix]) => !(prefix !== '' && suffix !== ''));

  it(
    'refuses every way of writing 0, with or without a sign, a symbol or a note',
    () => {
      fc.assert(
        fc.property(zeros, ([sign, prefix, whole, fraction, suffix, note]) => {
          const text = `${sign}${prefix}${whole}${fraction}${suffix}${note}`;
          expect(problemOf(text), text).toBe('zero');
        }),
        config(500),
      );
    },
    SLOW,
  );
});

describe('beyond MAX_CENTS is never an amount', () => {
  it(
    'refuses every amount above MAX_CENTS, in either sign and any style, however many digits',
    () => {
      const above = fc.bigInt({ min: BigInt(MAX_CENTS) + 1n, max: 10n ** 40n });
      fc.assert(
        fc.property(above, fc.boolean(), styles, (cents, negative, style) => {
          const text = written(negative ? -cents : cents, style, '-');
          expect(problemOf(text), text).toBe('too_large');
        }),
        config(600),
      );
    },
    SLOW,
  );

  it('accepts exactly up to MAX_CENTS', () => {
    expect(problemOf(written(BigInt(MAX_CENTS), 'dot', '-'))).toBe('ok');
    expect(problemOf(written(BigInt(MAX_CENTS) + 1n, 'dot', '-'))).toBe('too_large');
    expect(problemOf(written(-BigInt(MAX_CENTS), 'dot', '-'))).toBe('ok');
  });
});

describe('notes', () => {
  it(
    'are at most 200 characters, and a longer one is refused and never cut',
    () => {
      fc.assert(
        fc.property(
          acceptedCents,
          safeNote,
          fc.integer({ min: 0, max: 400 }),
          (cents, start, extra) => {
            const note = `${start}${'x'.repeat(extra)}`;
            const cleaned = cleanImportText(note);
            const result = reading(`${written(cents, 'dot', '-')} ${note}`);
            if (cleaned.length <= 200) {
              expect(result).toEqual({ ok: true, amount: Number(cents), note: cleaned });
            } else {
              expect(result).toEqual({ ok: false, problem: 'note_too_long' });
            }
            if (result.ok) expect(result.note.length).toBeLessThanOrEqual(200);
          },
        ),
        config(500),
      );
    },
    SLOW,
  );

  it(
    'are never longer than 200 whatever the text, and never differ from the text after the amount',
    () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 400 }), (tail) => {
          const result = reading(`5 ${tail}`);
          if (result.ok) {
            expect(result.note.length).toBeLessThanOrEqual(200);
            expect(result.note).toBe(cleanImportText(tail));
          }
        }),
        config(800),
      );
    },
    SLOW,
  );
});

describe('a thousands group is never read as an amount and a note', () => {
  /** What can follow the three digits of a group: a decimal part, a symbol, a unit, a space and a note. */
  const afterGroup = fc.constantFrom(
    '',
    ',50',
    '.50',
    ',5',
    ',567',
    '.567',
    '€',
    ',50€',
    '$',
    ',00$',
    'EUR',
    ',50EUR',
    ' €',
    ' EUR',
    'ml',
    'g',
    '%',
    ' x',
    ' coffee',
    '.',
    ',',
    '-',
  );

  it(
    'refuses every `a bbb…` form (a of 1 to 3 digits, then exactly three digits), whatever is glued after',
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 999 }),
          fc.integer({ min: 0, max: 999 }),
          afterGroup,
          fc.constantFrom(' ', '  ', '\t'),
          (whole, group, glued, gap) => {
            const text = `${whole}${gap}${String(group).padStart(3, '0')}${glued}`;
            expect(reading(text).ok, text).toBe(false);
          },
        ),
        config(1500),
      );
    },
    SLOW,
  );

  it(
    'reads the same forms when the first number has decimals or four digits (no grouping is meant)',
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1000, max: 99999 }),
          fc.integer({ min: 0, max: 999 }),
          (whole, group) => {
            const text = `${whole} ${String(group).padStart(3, '0')}`;
            expect(reading(text), text).toEqual({
              ok: true,
              amount: whole * 100,
              note: String(group).padStart(3, '0'),
            });
          },
        ),
        config(300),
      );
      expect(reading('12.50 234')).toEqual({ ok: true, amount: 1250, note: '234' });
    },
    SLOW,
  );
});

describe('any text at all', () => {
  it(
    'never throws, and answers with an amount that is a safe integer in range or a reason',
    () => {
      fc.assert(
        fc.property(fc.string({ unit: 'binary', maxLength: 120 }), (text) => {
          const result = reading(text);
          if (result.ok) {
            expect(Number.isSafeInteger(result.amount)).toBe(true);
            expect(result.amount).not.toBe(0);
            expect(Math.abs(result.amount)).toBeLessThanOrEqual(MAX_CENTS);
            expect(result.note.length).toBeLessThanOrEqual(200);
          } else {
            expect(['not_an_amount', 'zero', 'too_large', 'note_too_long']).toContain(
              result.problem,
            );
          }
        }),
        config(1500),
      );
    },
    SLOW,
  );

  it(
    'never reads text that does not start with an amount (a letter first)',
    () => {
      fc.assert(
        fc.property(safeNote, fc.string({ maxLength: 40 }), (head, tail) => {
          expect(problemOf(`${head} ${tail}`)).toBe('not_an_amount');
        }),
        config(500),
      );
    },
    SLOW,
  );
});
