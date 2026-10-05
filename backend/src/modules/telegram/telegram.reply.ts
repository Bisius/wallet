/**
 * The few things the handlers do to a chat, with the failures of Telegram handled in one place: a
 * button's message is edited in place (and sent again when it cannot be), a keyboard is taken away,
 * a tap is answered once. Telegram refuses an edit that changes nothing ("message is not modified")
 * and a toast that is too old: neither is an error worth more than a log line.
 */
import { GrammyError } from 'grammy';
import type { Context } from 'grammy';
import { HttpError } from '../../lib/errors';
import { NO_KEYBOARD, type Keyboard } from './telegram.keyboards';
import { NOT_ONBOARDED_TEXT, SOMETHING_WENT_WRONG_TEXT } from './telegram.messages';
import type { TelegramLog } from './telegram.types';

/** Options of a new message. */
export interface SendOptions {
  /** No preview of a link in the text (the link to the app). */
  noLinkPreview?: boolean;
}

export interface Replier {
  /** Sends a new message. Returns its id (undefined when Telegram's answer had none). */
  send(
    ctx: Context,
    text: string,
    markup?: Keyboard,
    options?: SendOptions,
  ): Promise<number | undefined>;
  /**
   * Shows `text` where the user is looking: the message of the tapped button is edited (with
   * `markup`, or with no keyboard), and any other update gets a new message. Returns the id of the
   * message that now holds it.
   */
  show(ctx: Context, text: string, markup?: Keyboard): Promise<number | undefined>;
  /** Replaces only the keyboard of the tapped message. */
  showKeyboard(ctx: Context, markup: Keyboard): Promise<void>;
  /** Best effort: removes the keyboard of a message sent earlier. */
  strip(api: Context['api'], chatId: number, messageId: number | undefined): Promise<void>;
  /** Answers the tap (once per update): a toast when `text` is given, nothing visible otherwise. */
  ack(ctx: Context, text?: string): Promise<void>;
  /**
   * Runs a handler so that nothing it throws reaches the runtime unanswered: the error is logged
   * (redacted), the user is told nothing was changed (or to finish setting up Wallet when it is not
   * set up), and the tap is answered. A handler that needs a settings row calls this first.
   */
  guard(ctx: Context, handler: () => Promise<void>): Promise<void>;
}

const isNotModified = (error: unknown): boolean =>
  error instanceof GrammyError && error.description.includes('message is not modified');

export function createReplier(log: TelegramLog): Replier {
  const send: Replier['send'] = async (ctx, text, markup, options) => {
    const extra = {
      ...(markup ? { reply_markup: markup } : {}),
      ...(options?.noLinkPreview ? { link_preview_options: { is_disabled: true } } : {}),
    };
    const sent = await ctx.reply(text, Object.keys(extra).length > 0 ? extra : undefined);
    return typeof sent === 'object' && sent !== null ? sent.message_id : undefined;
  };

  const answered = new WeakSet<Context>();
  const ack: Replier['ack'] = async (ctx, text) => {
    if (answered.has(ctx)) return;
    answered.add(ctx);
    try {
      await ctx.answerCallbackQuery(text === undefined ? undefined : { text });
    } catch (error) {
      log.error('could not answer a button tap', error);
    }
  };

  return {
    send,

    async show(ctx, text, markup = NO_KEYBOARD) {
      const message = ctx.callbackQuery?.message;
      if (!message) return send(ctx, text, markup.inline_keyboard.length > 0 ? markup : undefined);
      try {
        await ctx.editMessageText(text, { reply_markup: markup });
      } catch (error) {
        if (isNotModified(error)) return message.message_id;
        log.error('could not edit a message, sending it again', error);
        return send(ctx, text, markup.inline_keyboard.length > 0 ? markup : undefined);
      }
      return message.message_id;
    },

    async showKeyboard(ctx, markup) {
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: markup });
      } catch (error) {
        if (!isNotModified(error)) log.error('could not change a keyboard', error);
      }
    },

    async strip(api, chatId, messageId) {
      if (messageId === undefined) return;
      try {
        await api.editMessageReplyMarkup(chatId, messageId, { reply_markup: NO_KEYBOARD });
      } catch (error) {
        if (!isNotModified(error)) log.error('could not remove a keyboard', error);
      }
    },

    ack,

    async guard(ctx, handler) {
      try {
        await handler();
      } catch (error) {
        const notOnboarded = error instanceof HttpError && error.code === 'not_onboarded';
        if (!notOnboarded) log.error('a handler failed', error);
        const text = notOnboarded ? NOT_ONBOARDED_TEXT : SOMETHING_WENT_WRONG_TEXT;
        try {
          if (ctx.callbackQuery) await ack(ctx, text);
          await send(ctx, text);
        } catch (inner) {
          log.error('could not tell the user that a handler failed', inner);
        }
      }
    },
  };
}
