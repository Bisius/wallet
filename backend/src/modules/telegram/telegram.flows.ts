/**
 * The conversations that record something: `/spending`, quick entry and `/income`, with the date
 * step, the closed-month confirmation and the confirmation with Undo and Change date (docs/DOMAIN.md,
 * "The `/spending` flow" and the sections after it). OWNED BY T2.
 *
 * The flow is a small explicit state machine (`telegram.flows.state.ts`): one per chat, in memory,
 * with a 15-minute timeout, and nothing is written until its last step. This file wires it to
 * grammY:
 *
 * - A button of the flow (`f:<flowId>:...`) is handled only while its flow is the chat's live one and
 *   waits for that kind of button. Anything else (a finished, replaced or expired flow, a button of
 *   the wrong step, data nobody knows) does `return next()`, which reaches T1's fallback: the
 *   "expired" toast, and the keyboard removed.
 * - A button of a stored row (`u:`, `d:`, `c:`, `r:`, `k`) goes to `telegram.rows.ts`.
 * - A text message is, in this order: a command (it ends the flow in progress first, then goes on to
 *   its handler), the answer to a flow that waits for text, or (after ending a flow that waited for
 *   a button) a quick entry when it reads as an amount. Everything else does `return next()`.
 *
 * Writes go through the services (`telegram.records.ts`), "today" comes from `tg.clock`, and a
 * confirmation tells the alert watcher what it showed (`announceWrite`).
 */
import { DESCRIPTION_MAX_LENGTH, cleanImportText } from '@wallet/shared';
import type { Context } from 'grammy';
import { monthOfDate } from '../../lib/today';
import { findSettings } from '../settings/settings.service';
import { type FlowAction, readCallback } from './telegram.callbacks';
import {
  type Flow,
  type FlowKind,
  createFlowStore,
  promptHasKeyboard,
  waitsForText,
} from './telegram.flows.state';
import {
  budgetKeyboard,
  closedMonthKeyboard,
  confirmationKeyboard,
  dateKeyboard,
  earlierKeyboard,
  skipKeyboard,
} from './telegram.keyboards';
import {
  AMOUNT_PROMPT_TEXT,
  CANCELLED_TEXT,
  INCOME_AMOUNT_PROMPT_TEXT,
  INCOME_SAVED_NOT_SHOWN_TEXT,
  NO_ACTIVE_BUDGETS_TEXT,
  PREVIOUS_ENTRY_CANCELLED_TEXT,
  SAVED_NOT_SHOWN_TEXT,
  UNKNOWN_BUDGET_TEXT,
  WHICH_BUDGET_TEXT,
  amountProblemText,
  beforeStartMonthText,
  budgetTitle,
  datePromptText,
  incomeDescriptionPromptText,
  incomeDraftText,
  incomeText,
  monthLabel,
  notePromptText,
  noteTooLongText,
  outsideActiveMonthsText,
  quickBudgetPromptText,
  spendingDraftText,
  spendingText,
} from './telegram.messages';
import { formatMonth } from './telegram.format';
import { currencySymbols, readAmountMessage } from './telegram.parse';
import {
  type BotSettings,
  activeBudgets,
  addIncome,
  addSpending,
  botSettings,
  budgetName,
  closedMonthsOf,
  isClosedMonth,
  suggestedBudgetId,
  todayNow,
  writeProblemOf,
} from './telegram.records';
import { createReplier } from './telegram.reply';
import {
  closedQuestionText,
  createRows,
  deliver,
  refOf,
  renderIncome,
  renderSpending,
} from './telegram.rows';
import type { TelegramBot, TelegramContext } from './telegram.types';

/** What the flows give the commands. */
export interface TelegramFlows {
  /**
   * Ends the flow in progress in this chat and removes its keyboard. Resolves true when there was
   * one (`/cancel` answers "Cancelled." then, and "Nothing to cancel." otherwise).
   */
  cancel(chatId: number): Promise<boolean>;
}

export interface FlowOptions {
  /** Tests: the ids of the flows (the default is random, which a stale button must never match). */
  makeId?: () => string;
}

/** Whether `action` is a button the flow can be waiting for at its current step. */
function isExpected(flow: Flow, action: FlowAction): boolean {
  switch (action.type) {
    case 'budget':
    case 'cancel':
      return flow.step === 'budget';
    case 'skip':
      return flow.step === 'note' && flow.kind === 'spending';
    case 'earlier':
      return flow.step === 'date';
    case 'date':
      return flow.step === 'date' || flow.step === 'earlier';
    case 'confirm':
      return flow.step === 'closed' && flow.date !== undefined;
    case 'other':
      return flow.step === 'closed';
  }
}

/** The command a message starts with: its name, 'other_bot' when it is addressed to another bot, or null. */
function commandOf(ctx: Context): string | 'other_bot' | null {
  const text = ctx.message?.text;
  const entity = ctx.message?.entities?.find(
    (candidate) => candidate.type === 'bot_command' && candidate.offset === 0,
  );
  if (text === undefined || !entity) return null;
  const [name = '', mention] = text.slice(1, entity.length).split('@');
  if (mention !== undefined && mention.toLowerCase() !== ctx.me.username.toLowerCase()) {
    return 'other_bot';
  }
  return name.toLowerCase();
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the flow has no ${what}`);
  return value;
}

export function registerFlows(
  bot: TelegramBot,
  tg: TelegramContext,
  options: FlowOptions = {},
): TelegramFlows {
  const store = createFlowStore(tg.clock, options.makeId);
  const replier = createReplier(tg.log);
  const rows = createRows(tg, replier);

  /** The currency symbols the amount parser accepts besides `€` (none before the settings exist). */
  const symbols = (): readonly string[] => {
    const settings = findSettings(tg.db);
    return settings ? currencySymbols(settings) : [];
  };

  // --- What the prompts print --------------------------------------------------------------------

  /** The flow so far, with no date: `€23.40 · Groceries · Lidl` or `Income €200.00 · Bonus`. */
  const draftText = (flow: Flow, settings: BotSettings): string =>
    flow.kind === 'income'
      ? incomeDraftText(need(flow.amount, 'amount'), flow.note ?? '', settings)
      : spendingDraftText(
          {
            amount: need(flow.amount, 'amount'),
            budgetName: budgetName(tg, need(flow.budgetId, 'budget')),
            note: flow.note ?? '',
          },
          settings,
        );

  /** The flow with its date: what the closed-month question and the confirmation start from. */
  const datedText = (flow: Flow, date: string, settings: BotSettings): string =>
    flow.kind === 'income'
      ? incomeText(
          { amount: need(flow.amount, 'amount'), description: flow.note ?? '', date },
          settings,
        )
      : spendingText(
          {
            amount: need(flow.amount, 'amount'),
            budgetName: budgetName(tg, need(flow.budgetId, 'budget')),
            note: flow.note ?? '',
            date,
          },
          settings,
        );

  // --- The steps ---------------------------------------------------------------------------------

  /** Step 1: the budgets of the current month. Starts the list again with a `notice` on top. */
  const askBudget = async (ctx: Context, flow: Flow, notice?: string): Promise<void> => {
    const settings = botSettings(tg);
    const { month, lines } = activeBudgets(tg);
    if (lines.length === 0) {
      store.delete(flow.chatId);
      await replier.show(ctx, NO_ACTIVE_BUDGETS_TEXT);
      return;
    }
    flow.step = 'budget';
    flow.budgetId = undefined;
    const suggested = flow.kind === 'quick' ? suggestedBudgetId(tg, flow.note ?? '', month) : null;
    const prompt =
      flow.kind === 'quick'
        ? quickBudgetPromptText(need(flow.amount, 'amount'), flow.note ?? '', settings)
        : WHICH_BUDGET_TEXT;
    flow.promptMessageId = await replier.show(
      ctx,
      notice === undefined ? prompt : `${notice}\n\n${prompt}`,
      budgetKeyboard(
        flow.id,
        lines,
        settings,
        lines.some((line) => line.id === suggested) ? suggested : null,
      ),
    );
  };

  /** Step 4: the last 7 days. */
  const askDate = async (ctx: Context, flow: Flow, notice?: string): Promise<void> => {
    const settings = botSettings(tg);
    flow.step = 'date';
    flow.date = undefined;
    const prompt = datePromptText(draftText(flow, settings));
    flow.promptMessageId = await replier.show(
      ctx,
      notice === undefined ? prompt : `${notice}\n\n${prompt}`,
      dateKeyboard(flow.id, todayNow(tg).date, settings.startMonth),
    );
  };

  /** The write: the flow is consumed, and a 422 of the service becomes a sentence and a way back. */
  const save = async (ctx: Context, flow: Flow, date: string): Promise<void> => {
    store.delete(flow.chatId); // consumed: a second tap of the same button is stale
    let stored:
      | { kind: 's'; row: ReturnType<typeof addSpending> }
      | { kind: 'i'; row: ReturnType<typeof addIncome> };
    try {
      stored =
        flow.kind === 'income'
          ? {
              kind: 'i',
              row: addIncome(tg, {
                date,
                amount: need(flow.amount, 'amount'),
                description: flow.note ?? '',
              }),
            }
          : {
              kind: 's',
              row: addSpending(tg, {
                date,
                amount: need(flow.amount, 'amount'),
                budgetId: need(flow.budgetId, 'budget'),
                note: flow.note ?? '',
              }),
            };
    } catch (error) {
      return recover(ctx, flow, date, error);
    }
    // Committed: from here on a failure to show it must not read as "nothing was changed".
    await deliver(
      tg,
      replier,
      ctx,
      () =>
        stored.kind === 'i'
          ? renderIncome(tg, stored.row, 'confirmation')
          : renderSpending(tg, stored.row, 'confirmation'),
      confirmationKeyboard(refOf(stored)),
      stored.kind === 'i' ? INCOME_SAVED_NOT_SHOWN_TEXT : SAVED_NOT_SHOWN_TEXT,
    );
  };

  /** A refused write: back to the step that can fix it (docs/DOMAIN.md, step 6). */
  const recover = async (ctx: Context, flow: Flow, date: string, error: unknown): Promise<void> => {
    const problem = writeProblemOf(error);
    if (problem === null || problem === 'gone') throw error;
    store.put(flow);
    await replier.ack(ctx);
    if (problem === 'unknown_budget' || flow.kind === 'quick') {
      // A quick entry has no date step: the budget is what cannot take today any more.
      return askBudget(ctx, flow, UNKNOWN_BUDGET_TEXT);
    }
    const settings = botSettings(tg);
    const current = todayNow(tg).month;
    const notice =
      problem === 'outside_active_months'
        ? outsideActiveMonthsText(
            budgetName(tg, need(flow.budgetId, 'budget')),
            monthLabel(monthOfDate(date), current, settings),
          )
        : beforeStartMonthText(formatMonth(settings.startMonth, settings, true));
    return askDate(ctx, flow, notice);
  };

  // --- A button of the flow ---------------------------------------------------------------------

  const onBudget = async (ctx: Context, flow: Flow, budgetId: number): Promise<void> => {
    const line = activeBudgets(tg).lines.find((candidate) => candidate.id === budgetId);
    await replier.ack(ctx);
    if (!line) return askBudget(ctx, flow, UNKNOWN_BUDGET_TEXT);
    flow.budgetId = line.id;
    // One tap saves a quick entry, dated by the clock at THIS moment (docs/DOMAIN.md, "Quick entry").
    if (flow.kind === 'quick') return save(ctx, flow, todayNow(tg).date);
    // Back from a refused write: the amount and the note are known already.
    if (flow.amount !== undefined) return askDate(ctx, flow);
    flow.step = 'amount';
    flow.promptMessageId = await replier.show(ctx, `${budgetTitle(line)}\n${AMOUNT_PROMPT_TEXT}`);
  };

  const onDate = async (ctx: Context, flow: Flow, date: string): Promise<void> => {
    const month = monthOfDate(date);
    if (!isClosedMonth(tg, month)) return save(ctx, flow, date);
    const settings = botSettings(tg);
    flow.step = 'closed';
    flow.date = date;
    await replier.ack(ctx);
    // An income only moves savings due; a spending moves what the budget's mode in that month says.
    const budgetId = flow.kind === 'income' ? null : need(flow.budgetId, 'budget');
    const question = closedQuestionText(
      tg,
      'Adding',
      closedMonthsOf(tg, [month], budgetId),
      budgetId,
    );
    flow.promptMessageId = await replier.show(
      ctx,
      `${datedText(flow, date, settings)}\n${question}`,
      closedMonthKeyboard(flow.id),
    );
  };

  const onFlowTap = async (
    ctx: Context,
    flowId: string,
    action: FlowAction,
    next: () => Promise<void>,
  ): Promise<void> => {
    const chatId = ctx.chat?.id;
    const flow = chatId === undefined ? undefined : store.get(chatId);
    // Not the live flow, or not a button it waits for: stale. T1's fallback answers it.
    if (!flow || flow.id !== flowId || !isExpected(flow, action)) return next();
    store.touch(flow);
    flow.promptMessageId = ctx.callbackQuery?.message?.message_id ?? flow.promptMessageId;

    await replier.guard(ctx, async () => {
      switch (action.type) {
        case 'cancel':
          store.delete(flow.chatId);
          await replier.ack(ctx);
          await replier.show(ctx, CANCELLED_TEXT);
          return;
        case 'budget':
          return onBudget(ctx, flow, action.budgetId);
        case 'skip':
          flow.note = '';
          await replier.ack(ctx);
          return askDate(ctx, flow);
        case 'earlier': {
          const settings = botSettings(tg);
          flow.step = 'earlier';
          await replier.ack(ctx);
          await replier.showKeyboard(
            ctx,
            earlierKeyboard(flow.id, todayNow(tg).date, settings.startMonth, settings),
          );
          return;
        }
        case 'date':
          return onDate(ctx, flow, action.date);
        case 'confirm':
          return save(ctx, flow, need(flow.date, 'date'));
        case 'other':
          await replier.ack(ctx);
          return askDate(ctx, flow);
      }
    });
  };

  // --- Text -------------------------------------------------------------------------------------

  /** Ends the flow in progress: it is forgotten and the keyboard of its prompt goes. */
  const endFlow = async (api: Context['api'], flow: Flow): Promise<void> => {
    store.delete(flow.chatId);
    if (promptHasKeyboard(flow)) await replier.strip(api, flow.chatId, flow.promptMessageId);
  };

  /** A message or a command that is not the answer to the flow ends it, and the user is told. */
  const supersede = async (ctx: Context, flow: Flow): Promise<void> => {
    await endFlow(ctx.api, flow);
    await replier.send(ctx, PREVIOUS_ENTRY_CANCELLED_TEXT);
  };

  /** The text answers the step the flow waits at (the amount, or the note or description). */
  const answerText = async (ctx: Context, flow: Flow, text: string): Promise<void> => {
    const settings = botSettings(tg);
    store.touch(flow);
    const kind = flow.kind === 'income' ? 'income' : 'spending';

    if (flow.step === 'amount') {
      const reading = readAmountMessage(text, { symbols: symbols() });
      if (!reading.ok) {
        await replier.send(ctx, amountProblemText(reading.problem, kind, settings));
        return;
      }
      if (kind === 'income' && reading.amount < 0) {
        await replier.send(ctx, amountProblemText('not_positive', kind, settings));
        return;
      }
      flow.amount = reading.amount;
      // Text after the number is the note (or the description): that step is skipped.
      if (reading.note !== '') {
        flow.note = reading.note;
        return askDate(ctx, flow);
      }
      flow.step = 'note';
      flow.promptMessageId =
        kind === 'income'
          ? await replier.send(ctx, incomeDescriptionPromptText(reading.amount, settings))
          : await replier.send(
              ctx,
              notePromptText(
                {
                  amount: reading.amount,
                  budgetName: budgetName(tg, need(flow.budgetId, 'budget')),
                  note: '',
                },
                settings,
              ),
              skipKeyboard(flow.id),
            );
      return;
    }

    // The note of a spending, or the description of an income (required, so no Skip).
    const note = cleanImportText(text);
    if (note.length > DESCRIPTION_MAX_LENGTH) {
      await replier.send(ctx, noteTooLongText(kind === 'income' ? 'description' : 'note'));
      return;
    }
    if (note === '' && kind === 'income') {
      await replier.send(ctx, incomeDescriptionPromptText(need(flow.amount, 'amount'), settings));
      return;
    }
    if (kind === 'spending') await replier.strip(ctx.api, flow.chatId, flow.promptMessageId); // Skip
    flow.note = note;
    return askDate(ctx, flow);
  };

  /** Quick entry: a message that reads as an amount, with no flow waiting for text. */
  const startQuick = async (ctx: Context, amount: number, note: string): Promise<void> => {
    botSettings(tg); // not set up: "Finish setting up Wallet"
    const flow: Flow = {
      id: store.newId(),
      kind: 'quick',
      chatId: need(ctx.chat?.id, 'chat'),
      step: 'budget',
      touchedAt: tg.clock.now().getTime(),
      promptMessageId: undefined,
      amount,
      note,
    };
    store.put(flow);
    await askBudget(ctx, flow);
  };

  const start = async (ctx: Context, kind: Exclude<FlowKind, 'quick'>): Promise<void> => {
    botSettings(tg);
    const flow: Flow = {
      id: store.newId(),
      kind,
      chatId: need(ctx.chat?.id, 'chat'),
      step: kind === 'income' ? 'amount' : 'budget',
      touchedAt: tg.clock.now().getTime(),
      promptMessageId: undefined,
    };
    store.put(flow);
    if (kind === 'spending') return askBudget(ctx, flow);
    flow.promptMessageId = await replier.send(ctx, INCOME_AMOUNT_PROMPT_TEXT);
  };

  // --- Registration -----------------------------------------------------------------------------

  bot.on('callback_query:data', async (ctx, next) => {
    const callback = readCallback(ctx.callbackQuery.data);
    if (!callback) return next();
    if (callback.scope === 'row') {
      await replier.guard(ctx, () => rows.onTap(ctx, callback.action));
      return;
    }
    await onFlowTap(ctx, callback.flowId, callback.action, next);
  });

  bot.on('message:text', async (ctx, next) => {
    const chatId = ctx.chat.id;
    const command = commandOf(ctx);
    if (command === 'other_bot') return next();
    const flow = store.get(chatId);

    // A command is never the answer to a step: it ends the flow first (`/cancel` has its own reply).
    if (command !== null) {
      if (flow && command !== 'cancel') await supersede(ctx, flow);
      return next();
    }

    if (flow && waitsForText(flow)) {
      await replier.guard(ctx, () => answerText(ctx, flow, ctx.message.text));
      return;
    }
    // Text while a flow waits for a button cancels it, and is then handled from scratch.
    if (flow) await supersede(ctx, flow);

    const reading = readAmountMessage(ctx.message.text, { symbols: symbols() });
    if (!reading.ok) return next();
    await replier.guard(ctx, () => startQuick(ctx, reading.amount, reading.note));
  });

  bot.command('spending', (ctx) => replier.guard(ctx, () => start(ctx, 'spending')));
  bot.command('income', (ctx) => replier.guard(ctx, () => start(ctx, 'income')));

  return {
    async cancel(chatId) {
      const flow = store.get(chatId);
      if (!flow) return false;
      await endFlow(bot.api, flow);
      return true;
    },
  };
}
