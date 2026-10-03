/**
 * The case fold behind the `q` search of `GET /api/spendings` (docs/DOMAIN.md, "Tags and search").
 *
 * SQLite's `lower()` and `LIKE` only fold ASCII, so "café" would not find "CAFÉ". The search folds
 * both sides itself: `createDb` registers `foldText` on the connection as the deterministic SQL
 * function `FOLD_SQL_FUNCTION`, and the service matches with
 * `instr(fold_text(column), foldText(q)) > 0`. `instr` is a plain substring search, so `%` and `_`
 * are ordinary characters and nothing needs escaping.
 *
 * The fold, in order:
 *  1. NFC, so "é" typed as e + U+0301 is the same text as the single character "é".
 *  2. `toLowerCase().toUpperCase().toLowerCase()`: Unicode's full case mappings, which bring every
 *     case variant of a letter to one form in every alphabet (Latin, Greek, Cyrillic, Armenian,
 *     Deseret, ...). Going up takes ſ to s and ß to ss, so "STRASSE" finds "Straße" and the other
 *     way round; going down first takes the capital ẞ to ß, which then follows, and down again
 *     leaves lower case.
 *  3. NFC again, because the mapping can split a letter into a letter and a combining mark
 *     (ǰ becomes j + U+030C), which would no longer equal the composed spelling.
 *  4. "ς" becomes "σ" (Greek final sigma). `toLowerCase()` writes Σ as ς at the end of a word and
 *     as σ elsewhere, which depends on the text around it, so a fragment folds differently from
 *     the same letters inside a longer text ("ΟΣ" is a part of "ΟΣΟΥ", but "ος" is not a part of
 *     "οσου"). One form for both makes "οδος", "οδοσ" and "ΟΔΟΣ" equal, and every fragment found.
 *
 * What it does NOT do: it never strips accents ("cafe" does not find "CAFÉ", "οδος" does not find
 * "οδός"), and it has no locale rules (Turkish dotted İ folds to i + U+0307, not to i, and dotless
 * ı folds to i). The match is by code point, as `instr` is: a mark that has no precomposed letter
 * (x + U+0301) is found by its base letter alone.
 */
export function foldText(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
    .normalize('NFC')
    .replaceAll('ς', 'σ');
}

/** The name `createDb` registers `foldText` under, for `sql` fragments in services. */
export const FOLD_SQL_FUNCTION = 'fold_text';
