/**
 * The inline keyboards: what a button says and carries, the two-per-row budget list, Telegram's
 * limit of 100 buttons (and 8 per row), and the date buttons with their explicit dates.
 */
import { describe, expect, it } from 'vitest';
import { CALLBACK_DATA_MAX_BYTES, readCallback } from './telegram.callbacks';
import {
  type BudgetChoice,
  MAX_BUDGET_BUTTONS,
  NO_KEYBOARD,
  budgetKeyboard,
  changeDateConfirmKeyboard,
  changeDateKeyboard,
  closedMonthKeyboard,
  confirmationKeyboard,
  dateKeyboard,
  deleteQuestionKeyboard,
  earlierKeyboard,
  recentKeyboard,
  skipKeyboard,
  undoConfirmKeyboard,
} from './telegram.keyboards';
import { KEYBOARD_MAX_BUTTONS } from './telegram.messages';

const FMT = { currency: 'EUR', locale: 'en-GB' };
const texts = (keyboard: { inline_keyboard: { text: string }[][] }) =>
  keyboard.inline_keyboard.map((row) => row.map((button) => button.text));
const datas = (keyboard: { inline_keyboard: { callback_data?: string }[][] }) =>
  keyboard.inline_keyboard.flat().map((button) => button.callback_data ?? '');
const choice = (
  id: number,
  name: string,
  remaining: number,
  icon: string | null = null,
): BudgetChoice => ({
  id,
  name,
  icon,
  remaining,
});

describe('the budget keyboard', () => {
  const lines = [
    choice(1, 'Groceries', 18750, '🛒'),
    choice(2, 'Eating out', 4200, '🍝'),
    choice(3, 'Fuel', -1240, '⛽'),
    choice(4, 'Misc', 0),
  ];

  it('shows icon, name and what is left, two per row, then Cancel on a row of its own', () => {
    expect(texts(budgetKeyboard('abc12', lines, FMT))).toEqual([
      ['🛒 Groceries · €187.50', '🍝 Eating out · €42.00'],
      ['⛽ Fuel · -€12.40', 'Misc · €0.00'],
      ['✖ Cancel'],
    ]);
  });

  it('puts the suggested budget first, with a star, and the others after it in their order', () => {
    expect(texts(budgetKeyboard('abc12', lines, FMT, 2))).toEqual([
      ['⭐ 🍝 Eating out · €42.00', '🛒 Groceries · €187.50'],
      ['⛽ Fuel · -€12.40', 'Misc · €0.00'],
      ['✖ Cancel'],
    ]);
    expect(texts(budgetKeyboard('abc12', lines, FMT, 4))[0]).toEqual([
      '⭐ Misc · €0.00',
      '🛒 Groceries · €187.50',
    ]);
    // A suggestion that is not in the list changes nothing.
    expect(texts(budgetKeyboard('abc12', lines, FMT, 99))).toEqual(
      texts(budgetKeyboard('abc12', lines, FMT)),
    );
    expect(texts(budgetKeyboard('abc12', lines, FMT, null))).toEqual(
      texts(budgetKeyboard('abc12', lines, FMT)),
    );
  });

  it('cuts a long name on the button only, and keeps the whole id in the data', () => {
    const [row] = budgetKeyboard('abc12', [choice(77, 'A'.repeat(60), 100)], FMT).inline_keyboard;
    expect(row?.[0]?.text).toBe(`${'A'.repeat(23)}… · €1.00`);
    expect(row?.[0]).toMatchObject({ callback_data: 'f:abc12:b:77' });
  });

  it('carries the budget id and the flow id of every button, and Cancel', () => {
    expect(datas(budgetKeyboard('abc12', lines, FMT))).toEqual([
      'f:abc12:b:1',
      'f:abc12:b:2',
      'f:abc12:b:3',
      'f:abc12:b:4',
      'f:abc12:x',
    ]);
  });

  it('never goes over 100 buttons: 99 budgets and Cancel, 2 per row', () => {
    const many = Array.from({ length: 250 }, (_unused, i) =>
      choice(i + 1, `Budget ${i + 1}`, 1000),
    );
    const keyboard = budgetKeyboard('abc12', many, FMT);
    const all = keyboard.inline_keyboard.flat();
    expect(MAX_BUDGET_BUTTONS).toBe(99);
    expect(all).toHaveLength(KEYBOARD_MAX_BUTTONS);
    expect(all.at(-1)?.text).toBe('✖ Cancel');
    expect(keyboard.inline_keyboard.slice(0, -1).every((row) => row.length <= 2)).toBe(true);
    expect(keyboard.inline_keyboard).toHaveLength(51); // 49 full rows of two, one of one, and Cancel
    for (const data of datas(keyboard)) {
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    }
  });

  it('keeps the suggested budget even when it comes after the cut', () => {
    const many = Array.from({ length: 150 }, (_unused, i) =>
      choice(i + 1, `Budget ${i + 1}`, 1000),
    );
    const keyboard = budgetKeyboard('abc12', many, FMT, 150);
    expect(keyboard.inline_keyboard[0]?.[0]?.text).toBe('⭐ Budget 150 · €10.00');
    expect(keyboard.inline_keyboard.flat()).toHaveLength(100);
  });

  it('is only Cancel with no budget at all', () => {
    expect(texts(budgetKeyboard('abc12', [], FMT))).toEqual([['✖ Cancel']]);
  });
});

/** The fingerprint the buttons of a row carry in these tests. */
const S42 = { kind: 's' as const, id: 42, fp: 'abc' };
const I7 = { kind: 'i' as const, id: 7, fp: 'xyz' };

describe('the date keyboards', () => {
  it('offers Today, Yesterday and Earlier… with explicit dates', () => {
    const keyboard = dateKeyboard('abc12', '2026-10-05', '2026-01');
    expect(texts(keyboard)).toEqual([['Today', 'Yesterday', 'Earlier…']]);
    expect(datas(keyboard)).toEqual(['f:abc12:d:2026-10-05', 'f:abc12:d:2026-10-04', 'f:abc12:e']);
  });

  it('leaves out what the start month rules out', () => {
    // 2 Oct: today, yesterday (1 Oct), and nothing earlier in the start month.
    expect(texts(dateKeyboard('abc12', '2026-10-02', '2026-10'))).toEqual([['Today', 'Yesterday']]);
    expect(texts(dateKeyboard('abc12', '2026-10-01', '2026-10'))).toEqual([['Today']]);
    expect(texts(dateKeyboard('abc12', '2026-10-03', '2026-10'))).toEqual([
      ['Today', 'Yesterday', 'Earlier…'],
    ]);
  });

  it('puts one button per day from 2 to 6 days ago in Earlier…', () => {
    const keyboard = earlierKeyboard('abc12', '2026-10-05', '2026-01', FMT);
    expect(texts(keyboard)).toEqual([
      ['Sat 3', 'Fri 2', 'Thu 1'],
      ['Wed 30', 'Tue 29'],
    ]);
    expect(datas(keyboard)).toEqual([
      'f:abc12:d:2026-10-03',
      'f:abc12:d:2026-10-02',
      'f:abc12:d:2026-10-01',
      'f:abc12:d:2026-09-30',
      'f:abc12:d:2026-09-29',
    ]);
    expect(texts(earlierKeyboard('abc12', '2026-10-05', '2026-10', FMT))).toEqual([
      ['Sat 3', 'Fri 2', 'Thu 1'],
    ]);
  });

  it('Change date offers the same 7 days in one keyboard, and Back', () => {
    const keyboard = changeDateKeyboard(S42, '2026-10-05', '2026-01', FMT);
    expect(texts(keyboard)).toEqual([
      ['Today', 'Yesterday', 'Sat 3'],
      ['Fri 2', 'Thu 1', 'Wed 30'],
      ['Tue 29', '‹ Back'],
    ]);
    expect(datas(keyboard)).toEqual([
      'c:s:42:abc:2026-10-05',
      'c:s:42:abc:2026-10-04',
      'c:s:42:abc:2026-10-03',
      'c:s:42:abc:2026-10-02',
      'c:s:42:abc:2026-10-01',
      'c:s:42:abc:2026-09-30',
      'c:s:42:abc:2026-09-29',
      'r:s:42:abc',
    ]);
    expect(texts(changeDateKeyboard(I7, '2026-01-01', '2026-01', FMT))).toEqual([
      ['Today', '‹ Back'],
    ]);
  });
});

describe('the buttons of a stored row and of a question', () => {
  it('writes Undo and Change date, which carry the id and the fingerprint', () => {
    const keyboard = confirmationKeyboard(S42);
    expect(texts(keyboard)).toEqual([['↩ Undo', '📅 Change date']]);
    expect(datas(keyboard)).toEqual(['u:s:42:abc', 'c:s:42:abc']);
    expect(datas(confirmationKeyboard(I7))).toEqual(['u:i:7:xyz', 'c:i:7:xyz']);
  });

  it('writes the questions: Save / Other date, Delete / Keep, Remove / Keep, with the months they name', () => {
    expect(texts(closedMonthKeyboard('abc12'))).toEqual([['Save', 'Other date']]);
    expect(datas(closedMonthKeyboard('abc12'))).toEqual(['f:abc12:ok', 'f:abc12:od']);
    expect(texts(changeDateConfirmKeyboard(S42, '2026-09-30', ['2026-09']))).toEqual([
      ['Save', 'Other date'],
    ]);
    expect(datas(changeDateConfirmKeyboard(S42, '2026-09-30', ['2026-09']))).toEqual([
      'c:s:42:abc:2026-09-30:y202609',
      'c:s:42:abc',
    ]);
    expect(texts(deleteQuestionKeyboard(S42, 'Delete', []))).toEqual([['Delete', 'Keep']]);
    expect(texts(deleteQuestionKeyboard(S42, 'Remove', []))).toEqual([['Remove', 'Keep']]);
    expect(datas(deleteQuestionKeyboard(S42, 'Remove', []))).toEqual(['d:s:42:abc:y', 'k']);
    expect(datas(deleteQuestionKeyboard(S42, 'Delete', ['2026-08', '2026-09']))[0]).toBe(
      'd:s:42:abc:y202608+202609',
    );
    expect(texts(undoConfirmKeyboard(S42, ['2026-09']))).toEqual([['Remove', 'Keep']]);
    expect(datas(undoConfirmKeyboard(S42, ['2026-09']))).toEqual([
      'd:s:42:abc:y202609',
      'r:s:42:abc',
    ]);
    expect(texts(skipKeyboard('abc12'))).toEqual([['Skip']]);
    expect(datas(skipKeyboard('abc12'))).toEqual(['f:abc12:s']);
    expect(NO_KEYBOARD).toEqual({ inline_keyboard: [] });
  });

  it('writes /recent’s buttons in rows of five, each with its spending id and fingerprint', () => {
    const spendings = [90, 80, 70, 60, 50, 40, 30, 20, 10, 5].map((id) => ({ id, fp: `f${id}` }));
    const keyboard = recentKeyboard(spendings);
    expect(texts(keyboard)).toEqual([
      ['🗑 1', '🗑 2', '🗑 3', '🗑 4', '🗑 5'],
      ['🗑 6', '🗑 7', '🗑 8', '🗑 9', '🗑 10'],
    ]);
    expect(datas(keyboard)).toEqual(spendings.map(({ id, fp }) => `d:s:${id}:${fp}`));
    expect(texts(recentKeyboard(spendings.slice(0, 3)))).toEqual([['🗑 1', '🗑 2', '🗑 3']]);
    expect(recentKeyboard([])).toEqual({ inline_keyboard: [] });
  });

  it('every button of every keyboard is data that the reader understands', () => {
    const keyboards = [
      budgetKeyboard('abc12', [choice(1, 'a', 1)], FMT),
      dateKeyboard('abc12', '2026-10-05', '2026-01'),
      earlierKeyboard('abc12', '2026-10-05', '2026-01', FMT),
      changeDateKeyboard(S42, '2026-10-05', '2026-01', FMT),
      confirmationKeyboard(I7),
      closedMonthKeyboard('abc12'),
      changeDateConfirmKeyboard(I7, '2026-09-30', ['2026-09']),
      deleteQuestionKeyboard(S42, 'Delete', []),
      undoConfirmKeyboard(I7, ['2026-08', '2026-09']),
      skipKeyboard('abc12'),
      recentKeyboard([
        { id: 1, fp: 'a' },
        { id: 2, fp: 'b' },
      ]),
    ];
    for (const keyboard of keyboards) {
      for (const data of datas(keyboard)) expect(readCallback(data), data).not.toBeNull();
    }
  });
});
