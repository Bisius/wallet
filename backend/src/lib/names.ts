/**
 * The one comparison of names: it ignores case but not accents, so "Groceries" and "groceries" are
 * the same name while "Café" and "Cafe" are not. It orders the subscription list, the lines of a
 * month and the tag list, and it decides that two tag names clash (docs/DOMAIN.md, "Tags and
 * search"), so the order a list is shown in and "the same name" can never disagree. Callers break
 * ties with the id.
 */
export const nameCollator = new Intl.Collator('en', { sensitivity: 'accent' });

/** True when the two names are the same under `nameCollator`. */
export const isSameName = (a: string, b: string): boolean => nameCollator.compare(a, b) === 0;

/**
 * A name made only of characters that `nameCollator` ignores (a zero-width space, a variation
 * selector, a bidi control, NUL, ...) is the empty name for the comparison, so it would show as an
 * empty chip and clash with every other such name. Services refuse it like an empty name (a 400
 * `validation_error` at "name"). Whitespace counts as invisible too: `trim()` only strips it at the
 * ends, and an invisible character at an end shields it. A name that merely contains such a
 * character next to real ones is fine.
 */
export const isInvisibleName = (name: string): boolean => isSameName(name.replace(/\s+/gu, ''), '');
