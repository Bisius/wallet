/** `/help`, `/start`, `/cancel` and the two fallbacks, from the linked user (T1's part of the commands). */
import { Bot } from 'grammy';
import { describe, expect, it } from 'vitest';
import { OWNER, botApiError, messageUpdate } from '../../testing/fake-bot-api';
import { TOKEN, createBotHarness } from '../../testing/telegram-harness';
import { registerCommands } from './telegram.commands';
import {
  BOT_COMMANDS,
  CANCELLED_TEXT,
  NOTHING_TO_CANCEL_TEXT,
  STALE_BUTTON_TEXT,
  UNKNOWN_INPUT_TEXT,
  helpText,
} from './telegram.messages';

const linked = () => createBotHarness({ linked: OWNER });

describe('/help', () => {
  it('lists every command, in HTML, to the linked chat', async () => {
    const h = linked();
    await h.say('/help');
    const [call] = h.fake.callsOf('sendMessage');
    expect(call?.payload).toMatchObject({
      chat_id: OWNER.id,
      text: helpText(),
      parse_mode: 'HTML',
    });
    for (const { command } of BOT_COMMANDS) expect(helpText()).toContain(`/${command} `);
  });

  it('is what /start answers for the linked user', async () => {
    const h = linked();
    await h.say('/start');
    await h.say('/help');
    const [first, second] = h.fake.sentTexts();
    expect(first).toBe(second);
  });

  it('answers /help@botname, and ignores a command for another bot', async () => {
    const h = linked();
    await h.say('/help@wallet_test_bot');
    expect(h.fake.sentTexts()).toEqual([helpText()]);
    await h.say('/help@some_other_bot');
    expect(h.fake.sentTexts()).toHaveLength(2); // falls to the "didn't understand" pointer
    expect(h.fake.sentTexts()[1]).toBe(UNKNOWN_INPUT_TEXT);
  });
});

describe('/cancel', () => {
  it('says there is nothing to cancel when no flow is in progress', async () => {
    const h = linked();
    await h.say('/cancel');
    expect(h.fake.sentTexts()).toEqual([NOTHING_TO_CANCEL_TEXT]);
  });

  it('ends the flow in progress, when the flows say there was one', async () => {
    const h = linked();
    const cancelled: number[] = [];
    const bot = new Bot(TOKEN, { botInfo: h.fake.me });
    bot.api.config.use(h.fake.transformer);
    registerCommands(bot, h.tg, {
      cancel: async (chatId) => {
        cancelled.push(chatId);
        return true;
      },
    });
    await bot.handleUpdate(messageUpdate('/cancel'));
    expect(cancelled).toEqual([OWNER.id]);
    expect(h.fake.sentTexts()).toEqual([CANCELLED_TEXT]);
  });
});

describe('what no handler took', () => {
  it.each(['hello there', '/spending', '/nonsense', '/help me', '4 coffees'])(
    'points %j to /help',
    async (text) => {
      const h = linked();
      await h.say(text);
      // T2 replaces the pointer for /spending and for an amount: only text that stays unknown is asserted.
      if (text === 'hello there' || text === '/nonsense') {
        expect(h.fake.sentTexts()).toEqual([UNKNOWN_INPUT_TEXT]);
        expect(UNKNOWN_INPUT_TEXT).toContain('/help');
      }
    },
  );

  it('points a message that is not text to /help too', async () => {
    const h = linked();
    await h.bot.handleUpdate({
      update_id: 5000,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: OWNER.id, type: 'private', first_name: 'Olivia' },
        from: { id: OWNER.id, is_bot: false, first_name: 'Olivia' },
        photo: [{ file_id: 'x', file_unique_id: 'y', width: 1, height: 1 }],
      },
    });
    expect(h.fake.sentTexts()).toEqual([UNKNOWN_INPUT_TEXT]);
  });

  it('answers a button that no flow knows with the "expired" toast, and removes its keyboard', async () => {
    const h = linked();
    await h.tap('s:gone:1');
    const toast = h.fake.callsOf('answerCallbackQuery');
    expect(toast).toHaveLength(1);
    expect(toast[0]?.payload['text']).toBe(STALE_BUTTON_TEXT);
    expect(STALE_BUTTON_TEXT).toBe('This entry expired, start again with /spending');
    const edit = h.fake.callsOf('editMessageReplyMarkup');
    expect(edit).toHaveLength(1);
    expect(edit[0]?.payload['reply_markup']).toEqual({ inline_keyboard: [] });
    expect(h.fake.callsOf('sendMessage')).toEqual([]);
  });

  it('survives a toast or an edit that Telegram refuses (an old message), and logs it', async () => {
    const h = linked();
    h.fake.answerOnce('answerCallbackQuery', botApiError(400, 'Bad Request: query is too old'));
    await h.tap('s:gone:1');
    expect(h.logged.join('\n')).toContain('could not answer a stale button');
    h.fake.answerOnce(
      'editMessageReplyMarkup',
      botApiError(400, 'Bad Request: message is not modified'),
    );
    await h.tap('s:gone:2');
    expect(h.logged.filter((line) => line.includes('stale button'))).toHaveLength(2);
  });
});

describe('every message is HTML unless a call says otherwise', () => {
  it('adds parse_mode HTML to sendMessage and editMessageText, and leaves a chosen one alone', async () => {
    const h = linked();
    await h.bot.api.sendMessage(OWNER.id, 'a');
    await h.bot.api.sendMessage(OWNER.id, 'b', { parse_mode: 'MarkdownV2' });
    await h.bot.api.editMessageText(OWNER.id, 1, 'c');
    await h.bot.api.sendChatAction(OWNER.id, 'typing');
    expect(h.fake.calls.map((call) => [call.method, call.payload['parse_mode']])).toEqual([
      ['sendMessage', 'HTML'],
      ['sendMessage', 'MarkdownV2'],
      ['editMessageText', 'HTML'],
      ['sendChatAction', undefined],
    ]);
  });
});
