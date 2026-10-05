/**
 * The buttons that act on a STORED spending or income: Undo, Change date, Delete, Keep and Back
 * (docs/DOMAIN.md, "The confirmation", and "The `/recent` and `/undo` commands"). They carry the
 * row's id and its fingerprint (telegram.callbacks.ts) and read the row as it is when they are
 * tapped, so they work after a restart, never belong to a flow, and show current values when the row
 * was edited on the web since. A row that is gone, or whose fingerprint is not the one the button
 * carries (another row got its id after a backup was restored), answers "Already removed." and acts
 * on nothing.
 *
 * Whatever touches a closed month asks first, naming the month and what changes in it (savings due
 * where the budget settles with savings, what it carries forward where it is incremental): Undo,
 * Change date (when the old and the new date are in different months and one is closed), and the
 * delete of `/recent` and `/undo`. A confirmed tap asks again when a month is closed that the
 * question did not name (the clock moved on, or the row was moved on the web).
 *
 * This file also renders the confirmations (`renderSpending`, `renderIncome`), which the flows use
 * after they write: the stored row, then the month view's figures read AFTER the write.
 * `deliver` shows one, and tells the alert watcher what it showed BEFORE it awaits any send, so a
 * check that runs while the message is in flight does not announce the same level again.
 */
import type { IsoDate, MonthKey } from '@wallet/shared';
import type { Context } from 'grammy';
import { monthOfDate } from '../../lib/today';
import type { RowAction, RowRef } from './telegram.callbacks';
import {
  type EntryRef,
  type StoredIncome,
  type StoredSpending,
  findIncome,
  findSpending,
  fingerprintOf,
  levelRow,
  restoreLevel,
} from './telegram.entries';
import { formatDay, formatMonth } from './telegram.format';
import {
  type Keyboard,
  NO_KEYBOARD,
  changeDateConfirmKeyboard,
  changeDateKeyboard,
  confirmationKeyboard,
  deleteQuestionKeyboard,
  undoConfirmKeyboard,
} from './telegram.keyboards';
import {
  ALREADY_REMOVED_TEXT,
  KEPT_TEXT,
  MOVED_NOT_SHOWN_TEXT,
  REMOVED_NOT_SHOWN_TEXT,
  SAME_DATE_TEXT,
  type QuestionVerb,
  type SpendingFacts,
  type LandingFigure,
  beforeStartMonthText,
  closedMonthText,
  incomeConfirmationText,
  incomeFiguresText,
  incomeQuestionText,
  incomeRemovedText,
  incomeText,
  monthLabel,
  outsideActiveMonthsText,
  spendingConfirmationText,
  spendingQuestionText,
  spendingRemovedText,
  spendingText,
} from './telegram.messages';
import type { AlertLevelRecord } from './telegram.notifications';
import {
  type ClosedMonth,
  botSettings,
  budgetName,
  carriesOn,
  carryLanding,
  closedMonthsOf,
  incomeFiguresOf,
  isClosedMonth,
  lineOf,
  moveIncome,
  moveSpending,
  readMonth,
  removeEntry,
  todayNow,
  writeProblemOf,
} from './telegram.records';
import type { Replier } from './telegram.reply';
import type { TelegramContext } from './telegram.types';

/** A confirmation (or a "Removed") as text, and the alert levels it showed, for `markNotified`. */
export interface Rendered {
  text: string;
  shown: AlertLevelRecord[];
}

const factsOf = (tg: TelegramContext, row: StoredSpending): SpendingFacts => ({
  amount: row.amount,
  budgetName: budgetName(tg, row.budgetId),
  note: row.description,
  date: row.date,
});

/**
 * The text of a stored spending: `confirmation` is "✅ row, then the budget's figure in the month of
 * the spending", `removed` is the same after a delete. The figure is the budget's line of
 * `getMonthView(month of the spending)`, read now (so after the write), and a spending in a closed
 * month says so. When that month is closed and the budget carries its remainder on there (the line
 * is incremental and not in its last month), the effect lands further on: a second line follows with
 * the budget's line where the carry ends up (`carryLanding`), which is the first later month that does
 * not carry (a closed month, whose savings due move) or else the current month. `shown` is every alert
 * level the text showed.
 */
export function renderSpending(
  tg: TelegramContext,
  row: StoredSpending,
  mode: 'confirmation' | 'removed',
): Rendered {
  const settings = botSettings(tg);
  const month = monthOfDate(row.date);
  const current = todayNow(tg).month;
  const line = lineOf(readMonth(tg, month), row.budgetId);
  const closed = isClosedMonth(tg, month);
  const shown: AlertLevelRecord[] = [];
  if (line) shown.push({ month, budgetId: row.budgetId, level: line.alert });

  let landing: LandingFigure | undefined;
  if (closed && carriesOn(line)) {
    const end = carryLanding(tg, row.budgetId, month);
    const landingLine = end.settles ? end.line : lineOf(readMonth(tg, current), row.budgetId);
    if (landingLine) {
      landing = {
        figure: landingLine,
        label: monthLabel(end.month, current, settings),
        closed: end.settles,
      };
      shown.push({ month: end.month, budgetId: row.budgetId, level: landingLine.alert });
    }
  }
  const build = mode === 'removed' ? spendingRemovedText : spendingConfirmationText;
  return {
    text: build(
      factsOf(tg, row),
      line,
      settings,
      closed ? monthLabel(month, current, settings) : undefined,
      landing,
    ),
    shown,
  };
}

/** The text of a stored income: "✅ Income ...", then the month's income and unallocated. */
export function renderIncome(
  tg: TelegramContext,
  row: StoredIncome,
  mode: 'confirmation' | 'removed',
): Rendered {
  const settings = botSettings(tg);
  const month = monthOfDate(row.date);
  const figures = incomeFiguresOf(readMonth(tg, month));
  const figuresText = figures
    ? incomeFiguresText(
        figures,
        monthLabel(month, todayNow(tg).month, settings),
        settings,
        isClosedMonth(tg, month),
      )
    : null;
  const build = mode === 'removed' ? incomeRemovedText : incomeConfirmationText;
  return { text: build(row, figuresText, settings), shown: [] };
}

/**
 * After a write by the bot: tell the alert watcher what the confirmation showed (so the alert is not
 * sent twice), then ask for a check. Neither may break the conversation. It is SYNCHRONOUS on
 * purpose: call it before awaiting anything after the write (the notify contract).
 */
export function announceWrite(tg: TelegramContext, shown: readonly AlertLevelRecord[]): void {
  for (const record of shown) {
    try {
      tg.notify.markNotified(record);
    } catch (error) {
      tg.log.error('could not record what the confirmation showed', error);
    }
  }
  try {
    tg.notify.scheduleBudgetAlertCheck();
  } catch (error) {
    tg.log.error('could not schedule the alert check', error);
  }
}

/**
 * Shows the confirmation of a write that has COMMITTED, and never throws: the write happened, so a
 * failure to show it must not read as "nothing was changed". The order matters:
 *
 *  1. `build` renders the text (it reads the month view after the write),
 *  2. `announceWrite` records the levels it shows as notified, BEFORE any await, because a check
 *     that starts while the message is in flight would otherwise announce what it is about to show,
 *  3. only then the tap is answered and the message goes out.
 *
 * The record of step 2 is PROVISIONAL: when the confirmation cannot be delivered (Telegram refuses
 * the edit and the new message), the levels it was to show are put back as they were (`restoreLevel`,
 * only where the row still holds what the mark wrote) and a check is asked for, so that the alert is
 * announced the next time Telegram answers. The user has not seen the level, so it is not lost.
 * `failureText` says what happened instead (it carries no level, so it does not count as delivered),
 * and when even that cannot be sent the failure is logged (redacted).
 */
export async function deliver(
  tg: TelegramContext,
  replier: Replier,
  ctx: Context,
  build: () => Rendered,
  markup: Keyboard | undefined,
  failureText: string,
): Promise<void> {
  let rendered: Rendered | null = null;
  try {
    rendered = build();
  } catch (error) {
    tg.log.error('could not build the confirmation of a write that was made', error);
  }
  const shown = rendered?.shown ?? [];
  const before = shown.map((record) => ({ record, row: levelRow(tg.db, record) }));
  announceWrite(tg, shown);
  try {
    await replier.ack(ctx);
    if (!rendered) throw new Error('there is no confirmation to show');
    await replier.show(ctx, rendered.text, markup);
  } catch (error) {
    tg.log.error('could not show the confirmation of a write that was made', error);
    takeBackLevels(tg, before);
    try {
      await replier.send(ctx, failureText);
    } catch (inner) {
      tg.log.error('could not tell the user about it either', inner);
    }
  }
}

/** Puts the levels a confirmation recorded back, and asks for a check that will announce them. Never throws. */
function takeBackLevels(
  tg: TelegramContext,
  before: readonly { record: AlertLevelRecord; row: ReturnType<typeof levelRow> }[],
): void {
  try {
    for (const { record, row } of before) restoreLevel(tg.db, record, row);
    if (before.length > 0) tg.notify.scheduleBudgetAlertCheck();
  } catch (error) {
    tg.log.error('could not take back the alert levels of an undelivered confirmation', error);
  }
}

export type Loaded = { kind: 's'; row: StoredSpending } | { kind: 'i'; row: StoredIncome };

/**
 * The stored row as it is now, or null when it is gone. With `fp` (a button's fingerprint) it is
 * also null when the row under that id is not the one the button was made for.
 */
export function loadRow(tg: TelegramContext, ref: EntryRef, fp?: string): Loaded | null {
  let loaded: Loaded | null = null;
  if (ref.kind === 's') {
    const row = findSpending(tg.db, ref.id);
    if (row) loaded = { kind: 's', row };
  } else {
    const row = findIncome(tg.db, ref.id);
    if (row) loaded = { kind: 'i', row };
  }
  if (loaded && fp !== undefined && fingerprintOf(loaded.row.createdAt) !== fp) return null;
  return loaded;
}

/** The reference a button of this row carries. */
export const refOf = (loaded: Loaded): RowRef => ({
  kind: loaded.kind,
  id: loaded.row.id,
  fp: fingerprintOf(loaded.row.createdAt),
});

/** The one-line summary of a row, with its date: what the questions print. */
export function summaryOf(tg: TelegramContext, loaded: Loaded): string {
  const settings = botSettings(tg);
  return loaded.kind === 's'
    ? spendingText(factsOf(tg, loaded.row), settings)
    : incomeText(loaded.row, settings);
}

/** The `[↩ Undo] [📅 Change date]` keyboard of a row. */
export const keyboardOf = (loaded: Loaded): Keyboard => confirmationKeyboard(refOf(loaded));

/**
 * The closed-month question, with each closed month's effect worded by the budget's mode there: what
 * is due to savings, or what the budget carries forward (docs/DOMAIN.md, "The `/spending` flow").
 * `budgetId` is null for an income.
 */
export function closedQuestionText(
  tg: TelegramContext,
  action: 'Adding' | 'Moving' | 'Removing',
  closed: readonly ClosedMonth[],
  budgetId: number | null,
): string {
  const settings = botSettings(tg);
  const current = todayNow(tg).month;
  return closedMonthText(
    action,
    closed.map(({ month, settlesIn }) => ({
      name: monthLabel(month, current, settings),
      savingsFor: settlesIn === null ? null : monthLabel(settlesIn, current, settings),
    })),
    budgetId === null ? undefined : budgetName(tg, budgetId),
  );
}

/** The closed months (now) an action on this row touches, among `months`. */
const closedFor = (
  tg: TelegramContext,
  loaded: Loaded,
  months: readonly MonthKey[],
): ClosedMonth[] => closedMonthsOf(tg, months, loaded.kind === 's' ? loaded.row.budgetId : null);

/**
 * The question of a delete: "Delete ...?" / "Remove ...?", with the closed month named when there
 * is one, and the closed months it names (what `[Delete]` or `[Remove]` confirms).
 */
export function deleteQuestion(
  tg: TelegramContext,
  loaded: Loaded,
  verb: QuestionVerb,
): { text: string; named: MonthKey[] } {
  const settings = botSettings(tg);
  const question =
    loaded.kind === 's'
      ? spendingQuestionText(factsOf(tg, loaded.row), settings, verb)
      : incomeQuestionText(loaded.row, settings, verb);
  const closed = closedFor(tg, loaded, [monthOfDate(loaded.row.date)]);
  const budgetId = loaded.kind === 's' ? loaded.row.budgetId : null;
  return {
    text:
      closed.length > 0
        ? `${question}\n${closedQuestionText(tg, 'Removing', closed, budgetId)}`
        : question,
    named: closed.map(({ month }) => month),
  };
}

export interface Rows {
  onTap(ctx: Context, action: RowAction): Promise<void>;
}

export function createRows(tg: TelegramContext, replier: Replier): Rows {
  const render = (loaded: Loaded, mode: 'confirmation' | 'removed'): Rendered =>
    loaded.kind === 's' ? renderSpending(tg, loaded.row, mode) : renderIncome(tg, loaded.row, mode);

  /** The row is gone (or is another row now): say so, and take the buttons away. */
  const gone = async (ctx: Context): Promise<void> => {
    await replier.ack(ctx, ALREADY_REMOVED_TEXT);
    await replier.showKeyboard(ctx, NO_KEYBOARD);
  };

  /**
   * Deletes through the service and shows "Removed" with the budget's new figure, in the tapped
   * message. Nothing is awaited between the delete and `deliver`'s `markNotified`.
   */
  const removeNow = async (ctx: Context, loaded: Loaded): Promise<void> => {
    try {
      removeEntry(tg, { kind: loaded.kind, id: loaded.row.id });
    } catch (error) {
      if (writeProblemOf(error) === 'gone') return gone(ctx);
      throw error;
    }
    await deliver(
      tg,
      replier,
      ctx,
      () => render(loaded, 'removed'),
      undefined,
      REMOVED_NOT_SHOWN_TEXT,
    );
  };

  const showConfirmation = async (ctx: Context, loaded: Loaded): Promise<void> => {
    await replier.show(ctx, render(loaded, 'confirmation').text, keyboardOf(loaded));
  };

  const onUndo = async (ctx: Context, action: RowRef): Promise<void> => {
    const loaded = loadRow(tg, action, action.fp);
    if (!loaded) return gone(ctx);
    await replier.ack(ctx);
    const closed = closedFor(tg, loaded, [monthOfDate(loaded.row.date)]);
    if (closed.length === 0) return removeNow(ctx, loaded);
    const budgetId = loaded.kind === 's' ? loaded.row.budgetId : null;
    await replier.show(
      ctx,
      `${summaryOf(tg, loaded)}\n${closedQuestionText(tg, 'Removing', closed, budgetId)}`,
      undoConfirmKeyboard(
        refOf(loaded),
        closed.map(({ month }) => month),
      ),
    );
  };

  const onDelete = async (
    ctx: Context,
    action: RowRef,
    confirmed: readonly MonthKey[] | undefined,
  ): Promise<void> => {
    const loaded = loadRow(tg, action, action.fp);
    if (!loaded) return gone(ctx);
    await replier.ack(ctx);
    if (confirmed === undefined) {
      // From the list of /recent: ask in a message of its own, so the list stays as it is.
      const question = deleteQuestion(tg, loaded, 'Delete');
      await replier.send(
        ctx,
        question.text,
        deleteQuestionKeyboard(refOf(loaded), 'Delete', question.named),
      );
      return;
    }
    // Confirmed: but the clock (or the web) may have put the row in a closed month the question did
    // not name, so the closed months are worked out again now.
    const closed = closedFor(tg, loaded, [monthOfDate(loaded.row.date)]);
    if (closed.some(({ month }) => !confirmed.includes(month))) {
      const budgetId = loaded.kind === 's' ? loaded.row.budgetId : null;
      await replier.show(
        ctx,
        `${summaryOf(tg, loaded)}\n${closedQuestionText(tg, 'Removing', closed, budgetId)}`,
        deleteQuestionKeyboard(
          refOf(loaded),
          'Remove',
          closed.map(({ month }) => month),
        ),
      );
      return;
    }
    return removeNow(ctx, loaded);
  };

  const onChange = async (
    ctx: Context,
    action: RowRef,
    date: IsoDate | undefined,
    confirmed: readonly MonthKey[] | undefined,
  ): Promise<void> => {
    const loaded = loadRow(tg, action, action.fp);
    if (!loaded) return gone(ctx);
    const settings = botSettings(tg);
    const today = todayNow(tg);
    const ref = refOf(loaded);

    // Change date: the same 7 days in one keyboard, under the row as it is now.
    if (date === undefined) {
      await replier.ack(ctx);
      await replier.show(
        ctx,
        render(loaded, 'confirmation').text,
        changeDateKeyboard(ref, today.date, settings.startMonth, settings),
      );
      return;
    }
    if (date === loaded.row.date) return replier.ack(ctx, SAME_DATE_TEXT);

    // It asks whenever the edit changes a closed month: the row leaves one, or goes into one. A move
    // inside one month changes no figure of any month, so it never asks. A confirmed tap asks again
    // when a month is closed that the question did not name.
    const oldMonth = monthOfDate(loaded.row.date);
    const newMonth = monthOfDate(date);
    const closed = oldMonth === newMonth ? [] : closedFor(tg, loaded, [oldMonth, newMonth]);
    const unnamed = closed.some(({ month }) => !(confirmed ?? []).includes(month));
    if (closed.length > 0 && (confirmed === undefined || unnamed)) {
      await replier.ack(ctx);
      const budgetId = loaded.kind === 's' ? loaded.row.budgetId : null;
      await replier.show(
        ctx,
        `${summaryOf(tg, loaded)}\nNew date: ${formatDay(date, settings)}\n` +
          closedQuestionText(tg, 'Moving', closed, budgetId),
        changeDateConfirmKeyboard(
          ref,
          date,
          closed.map(({ month }) => month),
        ),
      );
      return;
    }

    let moved: Loaded;
    try {
      moved =
        loaded.kind === 's'
          ? { kind: 's', row: moveSpending(tg, loaded.row.id, date) }
          : { kind: 'i', row: moveIncome(tg, loaded.row.id, date) };
    } catch (error) {
      const problem = writeProblemOf(error);
      if (problem === 'gone') return gone(ctx);
      if (problem === 'outside_active_months' || problem === 'before_start_month') {
        await replier.ack(ctx);
        const notice =
          problem === 'outside_active_months' && loaded.kind === 's'
            ? outsideActiveMonthsText(
                budgetName(tg, loaded.row.budgetId),
                monthLabel(monthOfDate(date), today.month, settings),
              )
            : beforeStartMonthText(formatMonth(settings.startMonth, settings, true));
        await replier.show(
          ctx,
          `${notice}\n\n${render(loaded, 'confirmation').text}`,
          changeDateKeyboard(ref, today.date, settings.startMonth, settings),
        );
        return;
      }
      throw error;
    }
    // Committed: from here nothing may read as "nothing was changed".
    await deliver(
      tg,
      replier,
      ctx,
      () => render(moved, 'confirmation'),
      keyboardOf(moved),
      MOVED_NOT_SHOWN_TEXT,
    );
  };

  return {
    async onTap(ctx, action) {
      switch (action.type) {
        case 'keep':
          await replier.ack(ctx);
          await replier.show(ctx, KEPT_TEXT);
          return;
        case 'undo':
          return onUndo(ctx, action);
        case 'delete':
          return onDelete(ctx, action, action.confirmed);
        case 'change':
          return onChange(ctx, action, action.date, action.confirmed);
        case 'back': {
          const loaded = loadRow(tg, action, action.fp);
          if (!loaded) return gone(ctx);
          await replier.ack(ctx);
          return showConfirmation(ctx, loaded);
        }
      }
    },
  };
}
