/**
 * The commands. T1 wrote `/help`, `/start` (from the linked user, which answers like `/help`) and
 * `/cancel`, and the two fallbacks at the end; T2 owns the file from then on and added `/status`,
 * `/recent` and `/undo` (docs/DOMAIN.md, "The `/status` command" and "The `/recent` and `/undo`
 * commands"). `/spending` and `/income` live with their flows in `telegram.flows.ts`.
 *
 * Called by the runtime after the access guard and after `registerFlows`, with what the flows gave.
 * Whatever no handler took reaches the two fallbacks, which MUST stay last: a button that no flow
 * knows (a flow that ended, or a restart) gets the "expired" toast and loses its keyboard, and any
 * other message gets the pointer to `/help`.
 */
import { listSpendings } from '../spendings/spendings.service';
import { getMonthView } from '../months/months.service';
import type { TelegramFlows } from './telegram.flows';
import { latestEntry, spendingFingerprints } from './telegram.entries';
import { deleteQuestionKeyboard, recentKeyboard } from './telegram.keyboards';
import {
  CANCELLED_TEXT,
  NOTHING_TO_CANCEL_TEXT,
  NOTHING_TO_UNDO_TEXT,
  NO_ACTIVE_BUDGETS_TEXT,
  STALE_BUTTON_TEXT,
  UNKNOWN_INPUT_TEXT,
  chunkLines,
  escapeHtml,
  helpText,
  recentText,
  statusFooterText,
  statusLineText,
} from './telegram.messages';
import { botSettings, budgetNames, todayNow } from './telegram.records';
import { createReplier } from './telegram.reply';
import { deleteQuestion, loadRow, refOf } from './telegram.rows';
import type { TelegramBot, TelegramContext } from './telegram.types';

/** How many spendings `/recent` lists (docs/DOMAIN.md). */
export const RECENT_COUNT = 10;

export function registerCommands(
  bot: TelegramBot,
  tg: TelegramContext,
  flows: TelegramFlows,
): void {
  // `/start <code>` with a code that is open never gets here (the guard took it); a bare `/start`, or
  // a code when none is open, from the linked user, is a request for help.
  bot.command(['help', 'start'], async (ctx) => {
    await ctx.reply(helpText());
  });

  bot.command('cancel', async (ctx) => {
    const ended = await flows.cancel(ctx.chat.id);
    await ctx.reply(ended ? CANCELLED_TEXT : NOTHING_TO_CANCEL_TEXT);
  });

  const replier = createReplier(tg.log);

  // One line per active budget of the current month view, then the footer (and the link to the app).
  bot.command('status', (ctx) =>
    replier.guard(ctx, async () => {
      const settings = botSettings(tg);
      const { month, date } = todayNow(tg);
      const view = getMonthView(tg, month);
      const lines =
        view.budgets.length > 0
          ? view.budgets.map((line) => statusLineText(line, settings))
          : [NO_ACTIVE_BUDGETS_TEXT];
      const footer = statusFooterText(month, date, view, settings);
      const link = tg.config.appUrl ? [`Open Wallet: ${escapeHtml(tg.config.appUrl)}`] : [];
      // Telegram's limit is 4096 characters: a long list goes out in several messages.
      for (const text of chunkLines([...lines, '', footer, ...link])) {
        await replier.send(ctx, text.trim(), undefined, { noLinkPreview: true });
      }
    }),
  );

  // The last 10 spendings from any source, newest first, each with a [🗑 n] button.
  bot.command('recent', (ctx) =>
    replier.guard(ctx, async () => {
      const settings = botSettings(tg);
      const page = listSpendings(tg, { limit: RECENT_COUNT, offset: 0 });
      const names = budgetNames(tg);
      // A button names its spending by id AND fingerprint, so a list that has gone stale (or a
      // restored backup) can never delete another row.
      const fingerprints = spendingFingerprints(
        tg.db,
        page.items.map((item) => item.id),
      );
      const facts = page.items.map((item) => ({
        amount: item.amount,
        budgetName: names.get(item.budgetId) ?? 'Unknown budget',
        note: item.description,
        date: item.date,
      }));
      await replier.send(
        ctx,
        recentText(facts, settings),
        page.items.length > 0
          ? recentKeyboard(
              page.items.map((item) => ({ id: item.id, fp: fingerprints.get(item.id) ?? '0' })),
            )
          : undefined,
      );
    }),
  );

  // The latest spending or income the bot created that still exists. Always asks first.
  bot.command('undo', (ctx) =>
    replier.guard(ctx, async () => {
      const ref = latestEntry(tg.db);
      const loaded = ref ? loadRow(tg, ref) : null;
      if (!loaded) {
        await replier.send(ctx, NOTHING_TO_UNDO_TEXT);
        return;
      }
      const question = deleteQuestion(tg, loaded, 'Remove');
      await replier.send(
        ctx,
        question.text,
        deleteQuestionKeyboard(refOf(loaded), 'Remove', question.named),
      );
    }),
  );

  // The fallbacks: last, so that they only see what nothing else wanted.
  bot.on('callback_query', async (ctx) => {
    try {
      await ctx.answerCallbackQuery({ text: STALE_BUTTON_TEXT });
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch (error) {
      // The toast or the edit can fail (a query that is too old, a message that is gone): harmless.
      tg.log.error('could not answer a stale button', error);
    }
  });

  bot.on('message', async (ctx) => {
    await ctx.reply(UNKNOWN_INPUT_TEXT);
  });
}
