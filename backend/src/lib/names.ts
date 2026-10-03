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
