/**
 * The inline keyboards of the bot: pure builders, no I/O. What a button says comes from
 * `telegram.messages.ts`, what it carries from `telegram.callbacks.ts`. Telegram allows at most 100
 * buttons in a keyboard (and 8 in a row), and `budgetKeyboard` keeps to that.
 */
import type { InlineKeyboardButton } from 'grammy/types';
import type { IsoDate, MonthBudgetLine, MonthKey } from '@wallet/shared';
import { type RowRef, flowData, rowData } from './telegram.callbacks';
import { type MessageFormat, formatMoney } from './telegram.format';
import {
  BUTTON_NAME_MAX_CHARS,
  KEYBOARD_MAX_BUTTONS,
  dayLabel,
  recentDates,
  truncateLabel,
} from './telegram.messages';

type Button = InlineKeyboardButton.CallbackButton;

/** An inline keyboard whose every button carries `callback_data` (assignable to grammY's markup). */
export interface Keyboard {
  inline_keyboard: Button[][];
}

/** No buttons: what an edit sends to take a keyboard away. */
export const NO_KEYBOARD: Keyboard = { inline_keyboard: [] };

const button = (text: string, callback_data: string): Button => ({ text, callback_data });

const inRowsOf = (size: number, buttons: Button[]): Button[][] => {
  const rows: Button[][] = [];
  for (let i = 0; i < buttons.length; i += size) rows.push(buttons.slice(i, i + size));
  return rows;
};

// --- The budget step --------------------------------------------------------------------------

/** What `budgetKeyboard` needs of a budget line. */
export type BudgetChoice = Pick<MonthBudgetLine, 'id' | 'name' | 'icon' | 'remaining'>;

/** The most budget buttons a keyboard holds: the limit minus the Cancel button. */
export const MAX_BUDGET_BUTTONS = KEYBOARD_MAX_BUTTONS - 1;

/**
 * The budgets, two per row, then `[✖ Cancel]` on a row of its own. A button reads icon, name (cut at
 * about 24 characters) and what is left (`remaining`, which can be negative). The `suggested` budget
 * comes first, marked `⭐`. More than `MAX_BUDGET_BUTTONS` budgets are cut to the first ones.
 */
export function budgetKeyboard(
  flowId: string,
  lines: readonly BudgetChoice[],
  format: MessageFormat,
  suggestedId?: number | null,
): Keyboard {
  const first = lines.filter((line) => line.id === suggestedId);
  const ordered = [...first, ...lines.filter((line) => line.id !== suggestedId)];
  const buttons = ordered.slice(0, MAX_BUDGET_BUTTONS).map((line) => {
    const star = line.id === suggestedId ? '⭐ ' : '';
    const icon = line.icon ? `${line.icon} ` : '';
    const label = `${star}${icon}${truncateLabel(line.name, BUTTON_NAME_MAX_CHARS)} · ${formatMoney(line.remaining, format)}`;
    return button(label, flowData(flowId, { type: 'budget', budgetId: line.id }));
  });
  return {
    inline_keyboard: [
      ...inRowsOf(2, buttons),
      [button('✖ Cancel', flowData(flowId, { type: 'cancel' }))],
    ],
  };
}

// --- The steps after it -----------------------------------------------------------------------

export const skipKeyboard = (flowId: string): Keyboard => ({
  inline_keyboard: [[button('Skip', flowData(flowId, { type: 'skip' }))]],
});

/**
 * `[Today] [Yesterday] [Earlier…]`. Each day carries its explicit date, so a tap after midnight saves
 * the date it showed. A day before the start month is not offered, and `Earlier…` only when a day
 * from 2 to 6 days ago is.
 */
export function dateKeyboard(flowId: string, today: IsoDate, startMonth: MonthKey): Keyboard {
  const [first, second, ...earlier] = recentDates(today, startMonth);
  const row: Button[] = [];
  if (first !== undefined)
    row.push(button('Today', flowData(flowId, { type: 'date', date: first })));
  if (second !== undefined) {
    row.push(button('Yesterday', flowData(flowId, { type: 'date', date: second })));
  }
  if (earlier.length > 0) row.push(button('Earlier…', flowData(flowId, { type: 'earlier' })));
  return { inline_keyboard: [row] };
}

/** `Earlier…` opened: one button per day from 2 to 6 days ago (`Wed 30`, …), three to a row. */
export function earlierKeyboard(
  flowId: string,
  today: IsoDate,
  startMonth: MonthKey,
  format: MessageFormat,
): Keyboard {
  const days = recentDates(today, startMonth).slice(2);
  return {
    inline_keyboard: inRowsOf(
      3,
      days.map((date) => button(dayLabel(date, format), flowData(flowId, { type: 'date', date }))),
    ),
  };
}

/** `[Save] [Other date]`: the closed-month question of a flow. */
export const closedMonthKeyboard = (flowId: string): Keyboard => ({
  inline_keyboard: [
    [
      button('Save', flowData(flowId, { type: 'confirm' })),
      button('Other date', flowData(flowId, { type: 'other' })),
    ],
  ],
});

// --- A stored row -----------------------------------------------------------------------------

/** `[↩ Undo] [📅 Change date]` under a confirmation. */
export const confirmationKeyboard = (ref: RowRef): Keyboard => ({
  inline_keyboard: [
    [
      button('↩ Undo', rowData({ type: 'undo', ...ref })),
      button('📅 Change date', rowData({ type: 'change', ...ref })),
    ],
  ],
});

/**
 * Change date: the same 7 days in one keyboard (`Today`, `Yesterday`, then `Wed 30`, …) and `‹ Back`,
 * which gives the confirmation its own buttons again.
 */
export function changeDateKeyboard(
  ref: RowRef,
  today: IsoDate,
  startMonth: MonthKey,
  format: MessageFormat,
): Keyboard {
  const days = recentDates(today, startMonth);
  const buttons = days.map((date, index) =>
    button(
      index === 0 ? 'Today' : index === 1 ? 'Yesterday' : dayLabel(date, format),
      rowData({ type: 'change', ...ref, date }),
    ),
  );
  buttons.push(button('‹ Back', rowData({ type: 'back', ...ref })));
  return { inline_keyboard: inRowsOf(3, buttons) };
}

/**
 * `[Save] [Other date]` under a Change date that touches a closed month. `named` are the closed
 * months the question names: a tap of Save asks again when another is closed by then.
 */
export const changeDateConfirmKeyboard = (
  ref: RowRef,
  date: IsoDate,
  named: readonly MonthKey[],
): Keyboard => ({
  inline_keyboard: [
    [
      button('Save', rowData({ type: 'change', ...ref, date, confirmed: named })),
      button('Other date', rowData({ type: 'change', ...ref })),
    ],
  ],
});

/**
 * `[Delete] [Keep]` (`/recent`) or `[Remove] [Keep]` (`/undo`): the question before a delete.
 * `named` are the closed months the question names (none when it names none).
 */
export const deleteQuestionKeyboard = (
  ref: RowRef,
  confirmLabel: 'Delete' | 'Remove',
  named: readonly MonthKey[],
): Keyboard => ({
  inline_keyboard: [
    [
      button(confirmLabel, rowData({ type: 'delete', ...ref, confirmed: named })),
      button('Keep', rowData({ type: 'keep' })),
    ],
  ],
});

/** `[Remove] [Keep]` under the closed-month question of Undo, in place on the confirmation: Keep goes back to it. */
export const undoConfirmKeyboard = (ref: RowRef, named: readonly MonthKey[]): Keyboard => ({
  inline_keyboard: [
    [
      button('Remove', rowData({ type: 'delete', ...ref, confirmed: named })),
      button('Keep', rowData({ type: 'back', ...ref })),
    ],
  ],
});

/** `[🗑 1] … [🗑 10]` in rows of five, under the list of `/recent`; each carries its spending's id and fingerprint. */
export function recentKeyboard(spendings: readonly Omit<RowRef, 'kind'>[]): Keyboard {
  return {
    inline_keyboard: inRowsOf(
      5,
      spendings.map(({ id, fp }, index) =>
        button(`🗑 ${index + 1}`, rowData({ type: 'delete', kind: 's', id, fp })),
      ),
    ),
  };
}
