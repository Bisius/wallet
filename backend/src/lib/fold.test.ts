import { describe, expect, it } from 'vitest';
import { createDb } from '../db/client';
import { FOLD_SQL_FUNCTION, foldText } from './fold';

describe('foldText', () => {
  it.each([
    ['ASCII', 'COFFEE Shop', 'coffee shop'],
    ['Latin accents', 'CAFÉ', 'café'],
    ['Latin accents, already lower case', 'café', 'café'],
    ['Greek', 'ΑΘΗΝΑ', 'αθηνα'],
    ['Greek with a tonos', 'ΌΔΟΣ', 'όδοσ'],
    ['Cyrillic', 'МОСКВА', 'москва'],
    ['Cyrillic ё', 'Ёлка', 'ёлка'],
    ['Armenian', 'ԵՐԵՎԱՆ', 'երեվան'],
    ['Deseret (outside the BMP)', '\u{10400}', '\u{10428}'],
    ['German ß (full case mapping)', 'Straße', 'strasse'],
    ['German ß in capitals', 'STRASSE', 'strasse'],
    ['German capital ẞ', 'STRA\u1E9EE', 'strasse'],
    ['the long s', 'ſ', 's'],
    ['a digraph in title case', 'ǅ', 'ǆ'],
    ['an emoji, which has no case', 'Pizza 🍕', 'pizza 🍕'],
    ['digits and punctuation', '100% off_sale-#1', '100% off_sale-#1'],
    ['the empty text', '', ''],
  ])('%s', (_label, text, folded) => {
    expect(foldText(text)).toBe(folded);
  });

  it('keeps the spaces, inside and at the ends (trimming is the schema job)', () => {
    expect(foldText(' Ab  C ')).toBe(' ab  c ');
  });

  it('makes composed and decomposed spellings of the same text equal (NFC)', () => {
    expect(foldText('Café')).toBe(foldText('CAFÉ'));
    expect(foldText('CAFÉ')).toBe('café');
    // Upper-casing splits ǰ into j + U+030C and the capital one is spelled that way already.
    expect(foldText('ǰ')).toBe(foldText('J̌'));
    expect(foldText('ΐ')).toBe(foldText('Ϊ́'));
    expect(foldText('é')).toBe('é');
  });

  it('gives Greek final and medial sigma, and the capital, one form', () => {
    expect(new Set(['ΟΔΟΣ', 'οδος', 'οδοσ'].map(foldText)).size).toBe(1);
    expect(new Set(['Σ', 'σ', 'ς'].map(foldText)).size).toBe(1);
    expect(foldText('ς')).toBe('σ');
  });

  it('folds a fragment the way it folds the same letters inside a longer text', () => {
    // On its own "ΟΣ" ends a word, so toLowerCase() would write "ος", but inside "ΟΣΟΥ" it is "οσ".
    expect(foldText('ΟΣΟΥ')).toContain(foldText('ΟΣ'));
    expect(foldText('οδοσ ΑΘΗΝΩΝ')).toContain(foldText('ΟΔΟΣ'));
    expect(foldText('ΟΔΟΣ ΑΘΗΝΩΝ')).toContain(foldText('οδοσ'));
    expect(foldText('ΑΣΙΑ')).toContain(foldText('ασ'));
  });

  it('never strips accents', () => {
    expect(foldText('café')).not.toBe(foldText('cafe'));
    expect(foldText('οδός')).not.toBe(foldText('οδος'));
    expect(foldText('Ёлка')).not.toBe(foldText('Елка'));
    expect(foldText('naïve')).not.toBe(foldText('naive'));
    expect(foldText('ñ')).not.toBe(foldText('n'));
  });

  it('has no locale rules: Turkish dotted İ is not i', () => {
    expect(foldText('İ')).toBe('i̇');
    expect(foldText('İ')).not.toBe(foldText('i'));
    expect(foldText('I')).toBe(foldText('ı'));
  });

  it('is idempotent, so a folded text can be folded again without changing', () => {
    for (const text of ['CAFÉ', 'ΟΔΟΣ', 'Straße', 'Ёлка', 'Ϊ́', 'ǅ', 'ŉ']) {
      expect(foldText(foldText(text))).toBe(foldText(text));
    }
  });
});

describe('the SQL function createDb registers', () => {
  const { $client: sqlite } = createDb(':memory:');
  const fold = (value: unknown) =>
    (sqlite.prepare(`select ${FOLD_SQL_FUNCTION}(?) as folded`).get(value) as { folded: unknown })
      .folded;

  it('folds text the way foldText does', () => {
    for (const text of ['CAFÉ', 'ΟΔΟΣ', 'Straße', 'Café', '100% off']) {
      expect(fold(text)).toBe(foldText(text));
    }
  });

  it('lets NULL through as NULL, so a spending without notes never matches', () => {
    expect(fold(null)).toBeNull();
    expect(
      sqlite.prepare(`select instr(${FOLD_SQL_FUNCTION}(null), 'a') > 0 as hit`).get(),
    ).toEqual({ hit: null });
  });

  it('leaves what is not text as it is', () => {
    expect(fold(42)).toBe(42);
  });

  it('is deterministic (SQLite may use it in an index or fold constants)', () => {
    const calls = sqlite
      .prepare(`select ${FOLD_SQL_FUNCTION}('É') = ${FOLD_SQL_FUNCTION}('é') as same`)
      .get();
    expect(calls).toEqual({ same: 1 });
  });
});
