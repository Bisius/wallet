/**
 * The sender guard, the pairing and the link (docs/DOMAIN.md, "Linking and access"), driven through
 * `bot.handleUpdate()` with a fake Bot API that records every outgoing call: no network.
 */
import { eq } from 'drizzle-orm';
import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { telegramLink, telegramPairing } from '../../db/schema';
import {
  OWNER,
  type Person,
  STRANGER,
  botApiError,
  callbackUpdate,
  messageUpdate,
} from '../../testing/fake-bot-api';
import { type BotHarness, createBotHarness } from '../../testing/telegram-harness';
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_MAX_FAILED_ATTEMPTS,
  PAIRING_TTL_MS,
  createPairing,
  findLink,
  findPairing,
  generatePairingCode,
  removeLink,
  startPayload,
} from './telegram.access';
import { INVALID_CODE_TEXT, NO_LONGER_LINKED_TEXT, helpText } from './telegram.messages';

const OTHER: Person = { id: 7777, first_name: 'Noah', username: 'noah' };

/** Opens a code in the database, as `POST /api/telegram/pairing` does, and returns it. */
function openCode(h: BotHarness): string {
  return createPairing(h.tg).code;
}

const messages = (h: BotHarness) => h.fake.callsOf('sendMessage');

describe('the sender guard', () => {
  it('gives a stranger no reply and no call at all, for any message, linked or not', async () => {
    const unlinked = createBotHarness();
    const linked = createBotHarness({ linked: OWNER });
    for (const h of [unlinked, linked]) {
      for (const text of [
        'hello',
        '/help',
        '/start',
        '/spending',
        '12,50 lunch',
        '/cancel',
        '/unknown',
      ]) {
        await h.say(text, { from: STRANGER });
      }
      expect(h.fake.calls).toEqual([]);
    }
  });

  it('gives a stranger no call for a button tap either, not even the toast that stops the spinner', async () => {
    const h = createBotHarness({ linked: OWNER });
    await h.tap('anything', { from: STRANGER });
    await h.tap('s:abc:1', { from: STRANGER });
    expect(h.fake.calls).toEqual([]);
  });

  it('gives nobody an answer while nobody is linked, not even a would-be owner', async () => {
    const h = createBotHarness();
    await h.say('/help', { from: OWNER });
    await h.say('hello', { from: OWNER });
    await h.tap('x', { from: OWNER });
    expect(h.fake.calls).toEqual([]);
  });

  it('answers the linked user', async () => {
    const h = createBotHarness({ linked: OWNER });
    await h.say('/help');
    expect(h.fake.sentTexts()).toEqual([helpText()]);
  });

  it('is decided by the sender id, not by the name or the username', async () => {
    const h = createBotHarness({ linked: OWNER });
    await h.say('/help', { from: { id: STRANGER.id, first_name: 'Olivia', username: 'olivia' } });
    expect(h.fake.calls).toEqual([]);
  });

  it.each(['group', 'supergroup', 'channel'] as const)(
    'ignores everything in a %s, even from the linked user',
    async (type) => {
      const h = createBotHarness({ linked: OWNER });
      const chat = { id: -100123, type };
      await h.say('/help', { from: OWNER, chat });
      await h.say('hello', { from: OWNER, chat });
      await h.tap('x', { from: OWNER, chat });
      await h.say('/help', { from: STRANGER, chat });
      expect(h.fake.calls).toEqual([]);
    },
  );

  it.each(['group', 'supergroup', 'channel'] as const)(
    'never links from a %s, even with the right code, and does not count it as a wrong code',
    async (type) => {
      const h = createBotHarness();
      const code = openCode(h);
      await h.say(`/start ${code}`, { from: OWNER, chat: { id: -100123, type } });
      await h.say('/start WRONGCODE', { from: STRANGER, chat: { id: -100123, type } });
      expect(h.fake.calls).toEqual([]);
      expect(findLink(h.db)).toBeNull();
      expect(findPairing(h.db)).toMatchObject({ code, failedAttempts: 0 });
    },
  );

  it('ignores another bot', async () => {
    const h = createBotHarness({ linked: OWNER });
    await h.bot.handleUpdate({
      update_id: 900,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: OWNER.id, type: 'private', first_name: 'Olivia' },
        from: { id: OWNER.id, is_bot: true, first_name: 'Olivia' },
        text: '/help',
        entities: [{ type: 'bot_command', offset: 0, length: 5 }],
      },
    });
    expect(h.fake.calls).toEqual([]);
  });

  it('ignores an update that has no sender', async () => {
    const h = createBotHarness({ linked: OWNER });
    await h.bot.handleUpdate({
      update_id: 901,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: OWNER.id, type: 'private', first_name: 'Olivia' },
        text: '/help',
        entities: [{ type: 'bot_command', offset: 0, length: 5 }],
      },
    } as Update);
    expect(h.fake.calls).toEqual([]);
  });

  it('ignores the owner the moment the link is removed', async () => {
    const h = createBotHarness({ linked: OWNER });
    await h.say('/help');
    expect(messages(h)).toHaveLength(1);
    removeLink(h.db);
    await h.say('/help');
    await h.tap('x');
    expect(messages(h)).toHaveLength(1);
    expect(h.fake.calls).toHaveLength(1);
  });

  it('lets only the linked user through when another account is linked later', async () => {
    const h = createBotHarness({ linked: OWNER });
    await h.say('/help', { from: OTHER });
    expect(h.fake.calls).toEqual([]);
  });

  it('runs before every handler: a middleware after it never sees a stranger', async () => {
    const h = createBotHarness({ linked: OWNER });
    const seen: number[] = [];
    // A handler registered after the module's own would be unreachable (the fallbacks end the
    // chain), so put one in front of them by inserting it at the head of the chain of a new bot.
    const { Bot } = await import('grammy');
    const { registerAccess } = await import('./telegram.access');
    const bot = new Bot('1:x', { botInfo: h.fake.me });
    bot.api.config.use(h.fake.transformer);
    registerAccess(bot, h.tg);
    bot.use(async (ctx) => {
      seen.push(ctx.from?.id ?? 0);
    });
    await bot.handleUpdate(messageUpdate('hi', { from: STRANGER }));
    await bot.handleUpdate(callbackUpdate('x', { from: STRANGER }));
    await bot.handleUpdate(messageUpdate('hi', { from: OWNER, chat: { id: -1, type: 'group' } }));
    expect(seen).toEqual([]);
    await bot.handleUpdate(messageUpdate('hi', { from: OWNER }));
    await bot.handleUpdate(callbackUpdate('x', { from: OWNER }));
    expect(seen).toEqual([OWNER.id, OWNER.id]);
  });
});

describe('pairing: /start <code>', () => {
  it('links the sender, uses the code up and greets with the help', async () => {
    const h = createBotHarness({ now: '2026-03-15T10:00:00Z' });
    const code = openCode(h);
    h.clock.set('2026-03-15T10:03:00Z');
    await h.say(`/start ${code}`, { from: OWNER });

    expect(findLink(h.db)).toEqual({
      id: 1,
      userId: OWNER.id,
      chatId: OWNER.id,
      firstName: 'Olivia',
      username: 'olivia',
      linkedAt: '2026-03-15T10:03:00.000Z',
    });
    expect(findPairing(h.db)).toBeNull(); // single use
    expect(messages(h)).toHaveLength(1);
    const [greeting] = messages(h);
    expect(greeting?.payload).toMatchObject({ chat_id: OWNER.id, parse_mode: 'HTML' });
    const text = String(greeting?.payload['text']);
    expect(text).toContain('Linked to Wallet, Olivia');
    expect(text).toContain(helpText());
    expect(h.notify.recordBaseline).toHaveBeenCalledTimes(1);
  });

  it('keeps no username for an account that has none', async () => {
    const h = createBotHarness();
    const code = openCode(h);
    await h.say(`/start ${code}`, { from: { id: 55, first_name: 'Sam' } });
    expect(findLink(h.db)).toMatchObject({ userId: 55, firstName: 'Sam', username: null });
  });

  it('escapes the first name in the greeting', async () => {
    const h = createBotHarness();
    const code = openCode(h);
    await h.say(`/start ${code}`, { from: { id: 55, first_name: '<b>&Sam' } });
    expect(h.fake.sentTexts()[0]).toContain('Linked to Wallet, &lt;b&gt;&amp;Sam.');
    expect(findLink(h.db)?.firstName).toBe('<b>&Sam'); // stored as Telegram gave it
  });

  it('accepts the code in lower case, with spaces around it and with the bot name after the command', async () => {
    for (const build of [
      (code: string) => `/start ${code.toLowerCase()}`,
      (code: string) => `/start   ${code}  `,
      (code: string) => `/start@wallet_test_bot ${code}`,
    ]) {
      const h = createBotHarness();
      await h.say(build(openCode(h)), { from: OWNER });
      expect(findLink(h.db)?.userId).toBe(OWNER.id);
    }
  });

  it('makes the first message after a link answer as the linked user', async () => {
    const h = createBotHarness();
    await h.say(`/start ${openCode(h)}`, { from: OWNER });
    await h.say('/help', { from: OWNER });
    await h.say('/help', { from: STRANGER });
    expect(messages(h)).toHaveLength(2); // the greeting and the help; nothing for the stranger
  });

  it('cannot be used twice: the used code is gone, so a second sender gets silence', async () => {
    const h = createBotHarness();
    const code = openCode(h);
    await h.say(`/start ${code}`, { from: OWNER });
    h.fake.calls.length = 0;
    await h.say(`/start ${code}`, { from: STRANGER });
    expect(h.fake.calls).toEqual([]);
    expect(findLink(h.db)?.userId).toBe(OWNER.id);
  });

  it('does not link on a bare /start, which is no code', async () => {
    const h = createBotHarness();
    openCode(h);
    await h.say('/start', { from: STRANGER });
    await h.say('/start   ', { from: STRANGER });
    expect(h.fake.calls).toEqual([]);
    expect(findPairing(h.db)?.failedAttempts).toBe(0);
  });

  it('survives a baseline that fails: the link is made and the greeting is sent', async () => {
    const h = createBotHarness();
    h.notify.recordBaseline.mockImplementation(() => {
      throw new Error('disk is full');
    });
    await h.say(`/start ${openCode(h)}`, { from: OWNER });
    expect(findLink(h.db)?.userId).toBe(OWNER.id);
    expect(messages(h)).toHaveLength(1);
    expect(h.logged.join('\n')).toContain('could not record the alert baseline');
  });

  describe('wrong codes', () => {
    it('answers "Invalid or expired code." only while a code is open, and counts it', async () => {
      const h = createBotHarness();
      openCode(h);
      await h.say('/start NOPE2345', { from: STRANGER });
      expect(h.fake.sentTexts()).toEqual([INVALID_CODE_TEXT]);
      expect(INVALID_CODE_TEXT).toBe('Invalid or expired code.');
      expect(messages(h)[0]?.payload['chat_id']).toBe(STRANGER.id);
      expect(findPairing(h.db)?.failedAttempts).toBe(1);
      expect(findLink(h.db)).toBeNull();
    });

    it('says nothing while no code is open: never made, used, replaced... or cancelled', async () => {
      const h = createBotHarness();
      await h.say('/start NOPE2345', { from: STRANGER });
      expect(h.fake.calls).toEqual([]);
      createPairing(h.tg);
      h.db.delete(telegramPairing).run(); // cancelled
      await h.say('/start NOPE2345', { from: STRANGER });
      expect(h.fake.calls).toEqual([]);
    });

    it('cancels the pending code at the 5th wrong code, from any senders', async () => {
      const h = createBotHarness();
      const code = openCode(h);
      const senders = [STRANGER, OTHER, STRANGER, OTHER, STRANGER];
      for (const [i, from] of senders.entries()) {
        await h.say(`/start WRONG00${i}`, { from });
        expect(findPairing(h.db) === null).toBe(i === PAIRING_MAX_FAILED_ATTEMPTS - 1);
      }
      expect(h.fake.sentTexts()).toEqual(Array(5).fill(INVALID_CODE_TEXT)); // the 5th still answers
      // The code is gone: the right one now gets silence and links nobody.
      h.fake.calls.length = 0;
      await h.say(`/start ${code}`, { from: OWNER });
      expect(h.fake.calls).toEqual([]);
      expect(findLink(h.db)).toBeNull();
      // ...and so does a 6th wrong one.
      await h.say('/start WRONG006', { from: STRANGER });
      expect(h.fake.calls).toEqual([]);
    });

    it('still links with the right code after 4 wrong ones', async () => {
      const h = createBotHarness();
      const code = openCode(h);
      for (let i = 0; i < 4; i++) await h.say(`/start WRONG00${i}`, { from: STRANGER });
      await h.say(`/start ${code}`, { from: OWNER });
      expect(findLink(h.db)?.userId).toBe(OWNER.id);
    });

    it('counts the wrong codes of the linked user too, and answers them', async () => {
      const h = createBotHarness({ linked: OWNER });
      openCode(h);
      await h.say('/start WRONG000', { from: OWNER });
      expect(h.fake.sentTexts()).toEqual([INVALID_CODE_TEXT]);
      expect(findPairing(h.db)?.failedAttempts).toBe(1);
    });

    it('starts again from zero with a new code', async () => {
      const h = createBotHarness();
      openCode(h);
      for (let i = 0; i < 4; i++) await h.say(`/start WRONG00${i}`, { from: STRANGER });
      const fresh = openCode(h);
      expect(findPairing(h.db)?.failedAttempts).toBe(0);
      await h.say('/start WRONG009', { from: STRANGER });
      expect(findPairing(h.db)?.code).toBe(fresh); // not cancelled by the old tries
    });

    it('treats extra words after the code as a wrong code', async () => {
      const h = createBotHarness();
      const code = openCode(h);
      await h.say(`/start ${code} please`, { from: OWNER });
      expect(h.fake.sentTexts()).toEqual([INVALID_CODE_TEXT]);
      expect(findLink(h.db)).toBeNull();
    });
  });

  describe('expiry', () => {
    it('refuses the right code once it expired, as an invalid code, and counts it', async () => {
      const h = createBotHarness({ now: '2026-03-15T10:00:00Z' });
      const code = openCode(h);
      h.clock.set('2026-03-15T10:10:01Z');
      await h.say(`/start ${code}`, { from: OWNER });
      expect(h.fake.sentTexts()).toEqual([INVALID_CODE_TEXT]);
      expect(findLink(h.db)).toBeNull();
      expect(findPairing(h.db)?.failedAttempts).toBe(1);
    });

    it('accepts it up to the last millisecond and refuses it at the expiry instant', async () => {
      const lastMoment = createBotHarness({ now: '2026-03-15T10:00:00Z' });
      const code = openCode(lastMoment);
      lastMoment.clock.set(
        new Date(Date.parse('2026-03-15T10:00:00Z') + PAIRING_TTL_MS - 1).toISOString(),
      );
      await lastMoment.say(`/start ${code}`, { from: OWNER });
      expect(findLink(lastMoment.db)?.userId).toBe(OWNER.id);

      const atExpiry = createBotHarness({ now: '2026-03-15T10:00:00Z' });
      const code2 = openCode(atExpiry);
      atExpiry.clock.set(
        new Date(Date.parse('2026-03-15T10:00:00Z') + PAIRING_TTL_MS).toISOString(),
      );
      await atExpiry.say(`/start ${code2}`, { from: OWNER });
      expect(findLink(atExpiry.db)).toBeNull();
    });

    it('keeps answering the open but expired code, until it is replaced or cancelled', async () => {
      const h = createBotHarness();
      openCode(h);
      h.clock.set('2026-03-16T10:00:00Z');
      await h.say('/start WRONG000', { from: STRANGER });
      expect(h.fake.sentTexts()).toEqual([INVALID_CODE_TEXT]);
    });
  });

  describe('linking another account (re-linking)', () => {
    it('replaces the link when the new code is used, and tells the old chat, best effort', async () => {
      const h = createBotHarness({ linked: OWNER });
      await h.say('/help');
      h.fake.calls.length = 0;
      const code = openCode(h);
      await h.say(`/start ${code}`, { from: OTHER });

      expect(findLink(h.db)).toMatchObject({
        userId: OTHER.id,
        chatId: OTHER.id,
        firstName: 'Noah',
      });
      const [greeting, notice] = messages(h);
      expect(greeting?.payload).toMatchObject({ chat_id: OTHER.id });
      expect(String(greeting?.payload['text'])).toContain('Linked to Wallet, Noah');
      expect(notice?.payload).toMatchObject({ chat_id: OWNER.id, text: NO_LONGER_LINKED_TEXT });
      expect(h.notify.recordBaseline).toHaveBeenCalledTimes(1);

      // The old account is a stranger now, and the new one is the owner.
      h.fake.calls.length = 0;
      await h.say('/help', { from: OWNER });
      expect(h.fake.calls).toEqual([]);
      await h.say('/help', { from: OTHER });
      expect(h.fake.sentTexts()).toEqual([helpText()]);
    });

    it('does not change anything before the new code is used', async () => {
      const h = createBotHarness({ linked: OWNER });
      openCode(h);
      await h.say('/start WRONG000', { from: OTHER });
      expect(findLink(h.db)?.userId).toBe(OWNER.id);
    });

    it('still links when the notice to the old chat fails', async () => {
      const h = createBotHarness({ linked: OWNER });
      const code = openCode(h);
      // The greeting goes through; the notice to the old chat is refused (they blocked the bot).
      h.fake.answerOnce('sendMessage', {
        message_id: 1,
        date: 0,
        chat: { id: OTHER.id, type: 'private' },
      });
      h.fake.answerOnce('sendMessage', botApiError(403, 'Forbidden: bot was blocked by the user'));
      await h.say(`/start ${code}`, { from: OTHER });
      expect(findLink(h.db)?.userId).toBe(OTHER.id);
      expect(messages(h)).toHaveLength(2); // the notice was tried, and its failure was logged
      expect(h.logged.join('\n')).toContain('could not tell the previous chat');
    });

    it('with the same account only refreshes the link: no notice to anyone', async () => {
      const h = createBotHarness({ now: '2026-03-15T10:00:00Z', linked: OWNER });
      const code = openCode(h);
      await h.say(`/start ${code}`, { from: OWNER });
      expect(findLink(h.db)).toMatchObject({
        userId: OWNER.id,
        linkedAt: '2026-03-15T10:00:00.000Z',
      });
      expect(messages(h)).toHaveLength(1); // the greeting only
      expect(messages(h)[0]?.payload['chat_id']).toBe(OWNER.id);
    });
  });

  describe('the linked user and /start', () => {
    it('answers a bare /start like /help', async () => {
      const h = createBotHarness({ linked: OWNER });
      await h.say('/start');
      expect(h.fake.sentTexts()).toEqual([helpText()]);
    });

    it('answers /start <code> like /help when no code is open (a stale link in Settings)', async () => {
      const h = createBotHarness({ linked: OWNER });
      await h.say('/start ABCD2345');
      expect(h.fake.sentTexts()).toEqual([helpText()]);
      expect(findLink(h.db)?.userId).toBe(OWNER.id);
    });
  });
});

describe('the access data', () => {
  it('draws pairing codes of 8 characters from the 32-character alphabet', () => {
    expect(PAIRING_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(PAIRING_CODE_ALPHABET).size).toBe(32);
    for (const forbidden of ['0', 'O', '1', 'I'])
      expect(PAIRING_CODE_ALPHABET).not.toContain(forbidden);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(new RegExp(`^[${PAIRING_CODE_ALPHABET}]{8}$`));
      for (const ch of code) seen.add(ch);
    }
    // 2000 codes of 8 draws each use every one of the 32 characters.
    expect(seen.size).toBe(32);
  });

  it('keeps one pairing row and one link row (id 1), enforced by the database', () => {
    const h = createBotHarness();
    expect(() =>
      h.db.insert(telegramPairing).values({ id: 2, code: 'ABCDEFGH', expiresAt: 'x' }).run(),
    ).toThrow(/telegram_pairing_singleton|CHECK/);
    expect(() =>
      h.db.insert(telegramLink).values({ id: 2, userId: 1, chatId: 1, firstName: 'x' }).run(),
    ).toThrow(/telegram_link_singleton|CHECK/);
    expect(h.db.select().from(telegramLink).where(eq(telegramLink.id, 1)).all()).toEqual([]);
  });

  it('reads the payload of /start only from a /start message', () => {
    expect(startPayload('/start ABCD2345')).toBe('ABCD2345');
    expect(startPayload('/start@wallet_test_bot ABCD2345')).toBe('ABCD2345');
    expect(startPayload('/start')).toBeUndefined();
    expect(startPayload('/start   ')).toBeUndefined();
    expect(startPayload('/started ABCD2345')).toBeUndefined();
    expect(startPayload('start ABCD2345')).toBeUndefined();
    expect(startPayload('hello /start ABCD2345')).toBeUndefined();
    expect(startPayload(undefined)).toBeUndefined();
  });
});
