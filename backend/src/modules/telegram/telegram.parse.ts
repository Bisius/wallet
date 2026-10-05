/**
 * The amount parser of the bot (docs/DOMAIN.md, "The `/spending` flow", step 2, and "Quick entry"):
 * pure, no I/O, built on `parseCents` so that an amount is read exactly the way the web form's
 * helper reads it, and never with a float.
 *
 * `12.50`, `12,50`, `€12.50`, `12.50€` and `-5` are amounts. What follows the number is the note:
 * `4,50 coffee` is 450 cents and "coffee". Everything that is not clearly an amount is refused, so
 * that money is never guessed:
 *
 * - The number is `digits`, or `digits`, a `.` or a `,` and one or two digits. It ends at a space or
 *   at the end of the text (`12.345` and `12.50lunch` are not amounts), and a note follows after a
 *   space. This is the shape `parseCents` accepts, minus the spaces it ignores: here a space ends
 *   the amount, so `1 2` is 1 and the note "2" (`parseCents("1 2")` would read 12).
 * - The sign is `-` (or the typographic minus `−`), before the number or before a symbol in front of
 *   it (`-€5`, `€-5`). A negative amount is a refund. There is no `+`.
 * - A currency symbol is dropped, in front of the number (`€12.50`, `€ 12.50`) or after it (`12.50€`,
 *   `12.50 €`), never both. It is `€` (always) and the symbol of the currency in Settings, read
 *   purely from `Intl` (`currencySymbols`). Any other symbol is not an amount: an amount in another
 *   currency must never be stored as if it were in the currency of Settings.
 * - A note that STARTS with a currency sign that is not accepted (`12.50 $`, `12.50 £ lunch`) is
 *   refused for the same reason: it is a currency marker written after a space, not a note. (A
 *   currency written in letters, `12.50 USD`, cannot be told from a note and stays one.)
 * - A number written with a thousands separator (`1 234,50`) is refused: read by the rule above it
 *   would be 1 with the note "234,50", which is the worst kind of silent mistake. So a whole number
 *   of up to three digits (no decimals) whose note STARTS with exactly three digits (not followed by
 *   another digit) is refused as ambiguous, whatever follows those digits: `1 234,50€`, `1 234€`,
 *   `1 234,50EUR` and `1 234.567` are all refused, and so is `5 200ml milk` (a safe refusal: write
 *   the note first or spell it out). A note that starts with four digits, or with fewer than three,
 *   is a note.
 * - The amount is never 0 and never above `MAX_CENTS`, and the note is at most 200 characters
 *   (`DESCRIPTION_MAX_LENGTH`) after its whitespace is collapsed. A longer note is refused, never cut.
 */
import {
  type Cents,
  DESCRIPTION_MAX_LENGTH,
  MAX_CENTS,
  cleanImportText,
  parseCents,
} from '@wallet/shared';

/** The symbol that is accepted whatever the settings say (the owner's currency, docs/DOMAIN.md). */
export const ALWAYS_ACCEPTED_SYMBOL = '€';

/** What a message that reads as an amount holds. `note` is cleaned, 0 to 200 characters. */
export interface AmountMessage {
  /** Integer cents. Negative is a refund. Never 0, never above `MAX_CENTS` in absolute value. */
  amount: Cents;
  note: string;
}

/** Why a text is not an amount. */
export type AmountProblem =
  /** It does not start with an amount (or the amount is written in a way that is not accepted). */
  | 'not_an_amount'
  /** The amount is 0. */
  | 'zero'
  /** The amount is above `MAX_CENTS`. */
  | 'too_large'
  /** The note after the amount is more than `DESCRIPTION_MAX_LENGTH` characters. */
  | 'note_too_long';

export type AmountReading = ({ ok: true } & AmountMessage) | { ok: false; problem: AmountProblem };

export interface AmountOptions {
  /** Currency symbols to accept besides `€` (see `currencySymbols`). */
  symbols?: readonly string[];
}

/** The part of the settings the symbol of the currency comes from. */
export interface CurrencyFormat {
  currency: string;
  locale: string;
}

const symbolCache = new Map<string, readonly string[]>();

/**
 * The symbols a Settings currency is written with: `€` always, and what `Intl` prints for the
 * currency in the Settings locale, both as the symbol and as the narrow symbol (`$` and `CA$` for
 * CAD in `en-US`, `kr` for SEK in `sv-SE`). A currency or locale that `Intl` refuses adds nothing.
 * Pure: the result only depends on the two settings.
 */
export function currencySymbols({ currency, locale }: CurrencyFormat): readonly string[] {
  const key = `${locale}|${currency}`;
  const cached = symbolCache.get(key);
  if (cached) return cached;
  const found = new Set<string>([ALWAYS_ACCEPTED_SYMBOL]);
  for (const currencyDisplay of ['symbol', 'narrowSymbol'] as const) {
    try {
      const parts = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        currencyDisplay,
      }).formatToParts(0);
      const symbol = parts.find((part) => part.type === 'currency')?.value.trim();
      // A symbol that is empty or holds a digit, a sign or a separator could be read as part of the number.
      if (symbol && !/[\d\s.,+\-−]/.test(symbol)) found.add(symbol);
    } catch {
      // An ill-formed currency or locale: only the euro sign is accepted.
    }
  }
  const symbols = [...found];
  symbolCache.set(key, symbols);
  return symbols;
}

const MINUS = /^[-−]/;
const NUMBER = /^\d+(?:[.,]\d{1,2})?/;
/** What can follow an amount: nothing, or a space and then the note. */
const ENDS_THE_AMOUNT = /^(?:\s|$)/;
/**
 * The start of a thousands group: exactly three digits, not followed by another digit. What follows
 * them does not matter (a decimal part, a currency sign glued to it, a unit): `1 234,50€` is no less
 * 1234.50 than `1 234,50`.
 */
const THOUSANDS_GROUP = /^\d{3}(?!\d)/;
const WHOLE_UP_TO_THREE_DIGITS = /^\d{1,3}$/;
/** A currency sign (Unicode category Sc: $ £ ¥ ₹ ...). */
const STARTS_WITH_CURRENCY_SIGN = /^\p{Sc}/u;

/**
 * Reads `text` as an amount and an optional note, and says why when it cannot. See the header for
 * the rules. Never throws, whatever the text.
 */
export function readAmountMessage(text: string, options: AmountOptions = {}): AmountReading {
  const symbols = [...new Set([ALWAYS_ACCEPTED_SYMBOL, ...(options.symbols ?? [])])].sort(
    (a, b) => b.length - a.length,
  );
  const refused = (problem: AmountProblem): AmountReading => ({ ok: false, problem });

  let rest = text.trim();
  let negative = false;
  let signed = false;
  const takeSign = (): void => {
    if (!signed && MINUS.test(rest)) {
      signed = true;
      negative = true;
      rest = rest.slice(1);
    }
  };

  takeSign();
  const prefix = symbols.find((symbol) => rest.startsWith(symbol));
  if (prefix !== undefined) {
    rest = rest.slice(prefix.length).trimStart();
    takeSign(); // `€-5`
  }

  const number = NUMBER.exec(rest)?.[0];
  if (number === undefined) return refused('not_an_amount');
  rest = rest.slice(number.length);

  if (prefix === undefined) {
    // A symbol after the number: `12.50€` or `12.50 €`. It must end the word (`5 kroket` is a note).
    const after = rest.trimStart();
    const suffix = symbols.find(
      (symbol) => after.startsWith(symbol) && ENDS_THE_AMOUNT.test(after.slice(symbol.length)),
    );
    if (suffix !== undefined) rest = after.slice(suffix.length);
  }
  if (!ENDS_THE_AMOUNT.test(rest)) return refused('not_an_amount');

  const note = cleanImportText(rest);
  if (STARTS_WITH_CURRENCY_SIGN.test(note)) return refused('not_an_amount');
  if (WHOLE_UP_TO_THREE_DIGITS.test(number) && THOUSANDS_GROUP.test(note)) {
    return refused('not_an_amount');
  }

  // `parseCents` is the only reader of the digits. It answers null for a run of digits that is not
  // even a safe integer of cents.
  const cents = parseCents(number);
  if (cents === null || cents > MAX_CENTS) return refused('too_large');
  if (cents === 0) return refused('zero');
  if (note.length > DESCRIPTION_MAX_LENGTH) return refused('note_too_long');

  return { ok: true, amount: negative ? -cents : cents, note };
}

/** `readAmountMessage` without the reason: `{ amount, note }`, or null when the text is no amount. */
export function parseAmountMessage(text: string, options?: AmountOptions): AmountMessage | null {
  const reading = readAmountMessage(text, options);
  return reading.ok ? { amount: reading.amount, note: reading.note } : null;
}
