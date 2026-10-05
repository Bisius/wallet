import { expect, test } from '@playwright/test';
import {
  FAKE_BOT_TOKEN,
  FAKE_BOT_USERNAME,
  FakeTelegram,
  GROUP,
  OWNER,
  STRANGER,
  renderTelegramHtml,
} from '../support/fake-telegram';

/*
 * The fake Bot API of the Telegram specs, checked on its own (no browser, no Wallet server): the bot
 * under test is only as trustworthy as the Telegram it talks to. The calls here are made the way
 * grammY makes them: a POST with a JSON body to `/bot<token>/<method>`.
 */

interface Answer<T = unknown> {
  status: number;
  body: {
    ok: boolean;
    result?: T;
    error_code?: number;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

let fake: FakeTelegram;

test.beforeEach(async () => {
  fake = await FakeTelegram.start();
});

test.afterEach(async () => {
  await fake.close();
});

/** One call of the Bot API, as the bot makes it. */
async function call<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  options: { token?: string; signal?: AbortSignal } = {},
): Promise<Answer<T>> {
  const response = await fetch(`${fake.apiRoot}/bot${options.token ?? fake.token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: options.signal,
  });
  return { status: response.status, body: (await response.json()) as Answer<T>['body'] };
}

interface Message {
  message_id: number;
  text: string;
}

const keyboard = (...rows: [string, string][][]) => ({
  inline_keyboard: rows.map((row) => row.map(([text, callback_data]) => ({ text, callback_data }))),
});

/** The owner has talked, so the chat exists and the bot may answer it: `/start` and its handling. */
async function chatExists(): Promise<void> {
  await fake.owner.say('hello', { wait: false });
}

test.describe('the routes', () => {
  test('answer getMe with the bot, and anything else the way Telegram does', async () => {
    const me = await call<{ username: string; is_bot: boolean }>('getMe');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      ok: true,
      result: { username: FAKE_BOT_USERNAME, is_bot: true },
    });

    // A method that does not exist, a path that is not a bot route, a token that is not the bot's.
    expect(await call('makeCoffee')).toMatchObject({
      status: 404,
      body: { ok: false, error_code: 404, description: 'Not Found' },
    });
    const stray = await fetch(`${fake.apiRoot}/favicon.ico`);
    expect(stray.status).toBe(404);
    expect(await call('getMe', {}, { token: '1:wrong' })).toMatchObject({
      status: 401,
      body: { ok: false, error_code: 401, description: 'Unauthorized' },
    });
    expect(fake.token).toBe(FAKE_BOT_TOKEN);
    expect(fake.serverEnv({ appUrl: 'https://wallet.test' })).toEqual({
      TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN,
      TELEGRAM_API_ROOT: fake.apiRoot,
      APP_URL: 'https://wallet.test',
    });
    expect(fake.serverEnv()).not.toHaveProperty('APP_URL');
  });

  test('keep the commands and the removal of the webhook, and record every call in order', async () => {
    expect(fake.webhookWasRemoved).toBe(false);
    await call('deleteWebhook', {});
    await call('setMyCommands', {
      commands: [{ command: 'spending', description: 'Record a spending' }],
    });
    await call('getMe');
    expect(fake.webhookWasRemoved).toBe(true);
    expect(fake.commands()).toEqual([{ command: 'spending', description: 'Record a spending' }]);
    expect(fake.calls().map(({ seq, method, status }) => [seq, method, status])).toEqual([
      [1, 'deleteWebhook', 200],
      [2, 'setMyCommands', 200],
      [3, 'getMe', 200],
    ]);
    expect(fake.calls('setMyCommands')[0]?.params).toHaveProperty('commands');
  });
});

test.describe('getUpdates', () => {
  test('is held for its timeout when nothing is queued, and answers at once when something is', async () => {
    const started = Date.now();
    const none = await call<unknown[]>('getUpdates', { timeout: 1 });
    expect(none.body.result).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);

    await fake.say('hello', { wait: false });
    const quick = Date.now();
    const one = await call<{ update_id: number }[]>('getUpdates', { timeout: 20 });
    expect(Date.now() - quick).toBeLessThan(1000);
    expect(one.body.result).toHaveLength(1);
  });

  test('wakes a held poll as soon as an update arrives', async () => {
    const poll = call<{ update_id: number; message: { text: string } }[]>('getUpdates', {
      timeout: 20,
    });
    await fake.waitUntilPolling();
    expect(fake.pollsHeld).toBe(1);
    const started = Date.now();
    await fake.say('4,50 coffee', { wait: false });
    const answer = await poll;
    expect(Date.now() - started).toBeLessThan(1500);
    expect(answer.body.result?.map((update) => update.message.text)).toEqual(['4,50 coffee']);
    expect(fake.pollsHeld).toBe(0);
  });

  test('repeats an update until a later offset confirms it, then forgets it', async () => {
    await fake.owner.say('one', { wait: false });
    await fake.owner.say('two', { wait: false });
    const first = await call<{ update_id: number }[]>('getUpdates', { timeout: 0 });
    const ids = first.body.result?.map((update) => update.update_id) ?? [];
    expect(ids).toHaveLength(2);
    // Not confirmed: the same two come again.
    expect((await call<unknown[]>('getUpdates', { timeout: 0 })).body.result).toHaveLength(2);
    // Offset past the first one: only the second is left. `limit` is honoured.
    const rest = await call<{ update_id: number }[]>('getUpdates', {
      offset: (ids[0] ?? 0) + 1,
      limit: 1,
      timeout: 0,
    });
    expect(rest.body.result?.map((update) => update.update_id)).toEqual([ids[1]]);
    // Offset past both: nothing is left, and a long poll then waits.
    const gone = await call<unknown[]>('getUpdates', { offset: (ids[1] ?? 0) + 1, timeout: 0 });
    expect(gone.body.result).toEqual([]);
  });

  test('say() resolves once the bot has handled the update, which is when the next poll confirms it', async () => {
    // A very small bot: polls, answers every text with a message, and confirms by the next offset.
    let offset: number | undefined;
    const stop = new AbortController();
    const bot = (async () => {
      while (!stop.signal.aborted) {
        const answer = await call<
          { update_id: number; message?: { chat: { id: number }; text: string } }[]
        >('getUpdates', { offset, timeout: 20 }, { signal: stop.signal }).catch(() => undefined);
        for (const update of answer?.body.result ?? []) {
          offset = update.update_id + 1;
          if (update.message) {
            await call('sendMessage', {
              chat_id: update.message.chat.id,
              text: `echo ${update.message.text}`,
            });
          }
        }
      }
    })();
    try {
      await fake.waitUntilPolling();
      await fake.say('ping');
      // Handled means answered: no waiting needed to see the reply.
      expect(fake.lastMessage().text).toBe('echo ping');
      await fake.as(STRANGER).say('who am I');
      expect(fake.as(STRANGER).lastMessage().text).toBe('echo who am I');
      expect(fake.texts()).toEqual(['echo ping']);
      await fake.settled();
    } finally {
      stop.abort();
      await bot;
    }
  });

  test('says what is wrong when nobody collects an update', async () => {
    await expect(fake.say('anyone there?', { timeoutMs: 200 })).rejects.toThrow(
      /Timed out after 200 ms waiting for the bot to handle update[\s\S]*Is the bot connected/,
    );
  });

  test('a failure installed while a poll is held answers that poll', async () => {
    const poll = call('getUpdates', { timeout: 20 });
    await fake.waitUntilPolling();
    fake.failAlways('getUpdates', 409);
    const answer = await poll;
    expect(answer).toMatchObject({ status: 409, body: { ok: false, error_code: 409 } });
    expect(answer.body.description).toMatch(/^Conflict: terminated by other getUpdates request/);
  });

  test('a client that gives up frees its held poll', async () => {
    const abort = new AbortController();
    const poll = call('getUpdates', { timeout: 20 }, { signal: abort.signal }).catch(
      () => 'aborted',
    );
    await fake.waitUntilPolling();
    abort.abort();
    expect(await poll).toBe('aborted');
    await fake.waitFor('the poll to be dropped', () => fake.pollsHeld === 0 || undefined, 2000);
  });

  test('two pollers with one token: the new one ends the held one with a 409 (singlePoller)', async () => {
    const two = await FakeTelegram.start({ singlePoller: true });
    try {
      const url = (method: string) => `${two.apiRoot}/bot${two.token}/${method}`;
      const poll = (timeout: number) =>
        fetch(url('getUpdates'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ timeout }),
        });
      const older = poll(20);
      await two.waitUntilPolling();
      const newer = poll(1);
      expect((await older).status).toBe(409);
      expect((await newer).status).toBe(200);
    } finally {
      await two.close();
    }
  });
});

test.describe('messages', () => {
  test('keep their current text and keyboard, numbered per chat, and are shown to the right person', async () => {
    await chatExists();
    await fake.as(STRANGER).say('hi', { wait: false });
    const sent = await call<Message>('sendMessage', {
      chat_id: OWNER.id,
      text: 'Which budget?',
      reply_markup: keyboard(
        [
          ['Groceries', 'f:a:b:1'],
          ['Fuel', 'f:a:b:2'],
        ],
        [['Cancel', 'f:a:x']],
      ),
    });
    expect(sent.body.result).toMatchObject({ message_id: 2, text: 'Which budget?' });
    // The user's own message took number 1, so the bot's is 2: one numbering per chat, like Telegram.
    const other = await call<Message>('sendMessage', { chat_id: STRANGER.id, text: 'psst' });
    expect(other.body.result?.message_id).toBe(2);

    const shown = fake.lastMessage();
    expect(shown).toMatchObject({ id: 2, chatId: OWNER.id, text: 'Which budget?', edits: 0 });
    expect(shown.buttons.map((row) => row.map((button) => button.text))).toEqual([
      ['Groceries', 'Fuel'],
      ['Cancel'],
    ]);
    expect(fake.as(STRANGER).texts()).toEqual(['psst']);
    expect(fake.texts()).toEqual(['Which budget?']);
  });

  test('can be edited: the text changes, and an edit without a keyboard takes the keyboard away', async () => {
    await chatExists();
    const { body } = await call<Message>('sendMessage', {
      chat_id: OWNER.id,
      text: 'A note?',
      reply_markup: keyboard([['Skip', 'f:a:s']]),
    });
    const id = body.result?.message_id ?? 0;

    const edited = await call('editMessageText', {
      chat_id: OWNER.id,
      message_id: id,
      text: 'When?',
      reply_markup: keyboard([['Today', 'f:a:d:2026-03-10']]),
    });
    expect(edited.status).toBe(200);
    expect(fake.lastMessage()).toMatchObject({ id, text: 'When?', edits: 1 });
    expect(fake.lastMessage().buttons[0]?.[0]?.text).toBe('Today');

    await call('editMessageText', { chat_id: OWNER.id, message_id: id, text: '✅ Saved' });
    expect(fake.lastMessage()).toMatchObject({ text: '✅ Saved', buttons: [], edits: 2 });

    await call('editMessageReplyMarkup', {
      chat_id: OWNER.id,
      message_id: id,
      reply_markup: keyboard([['Undo', 'u:s:1']]),
    });
    expect(fake.lastMessage().buttons[0]?.[0]?.text).toBe('Undo');
    await call('editMessageReplyMarkup', {
      chat_id: OWNER.id,
      message_id: id,
      reply_markup: { inline_keyboard: [] },
    });
    expect(fake.lastMessage().buttons).toEqual([]);
  });

  test('refuse what Telegram refuses: an edit that changes nothing, a message that is not there, an empty one', async () => {
    await chatExists();
    const { body } = await call<Message>('sendMessage', { chat_id: OWNER.id, text: 'Same' });
    const id = body.result?.message_id ?? 0;

    const same = await call('editMessageText', { chat_id: OWNER.id, message_id: id, text: 'Same' });
    expect(same).toMatchObject({ status: 400, body: { ok: false } });
    expect(same.body.description).toMatch(/^Bad Request: message is not modified/);
    expect(fake.lastMessage().edits).toBe(0);

    expect(
      (await call('editMessageText', { chat_id: OWNER.id, message_id: 999, text: 'x' })).body
        .description,
    ).toBe('Bad Request: message to edit not found');
    expect((await call('sendMessage', { chat_id: OWNER.id, text: '' })).body.description).toBe(
      'Bad Request: message text is empty',
    );
    expect(
      (await call('sendMessage', { chat_id: OWNER.id, text: 'x'.repeat(4097) })).body.description,
    ).toBe('Bad Request: message is too long');
    expect((await call('sendMessage', { chat_id: 31337, text: 'Anyone?' })).body.description).toBe(
      'Bad Request: chat not found',
    );
  });

  test('check a keyboard like Telegram: callback_data of 1 to 64 bytes, a text on every button, a real link', async () => {
    await chatExists();
    const send = (reply_markup: unknown) =>
      call('sendMessage', { chat_id: OWNER.id, text: 'k', reply_markup });
    expect((await send(keyboard([['ok', 'x'.repeat(64)]]))).status).toBe(200);
    expect((await send(keyboard([['too long', 'x'.repeat(65)]]))).body.description).toBe(
      'Bad Request: BUTTON_DATA_INVALID',
    );
    expect((await send(keyboard([['two bytes each', 'é'.repeat(33)]]))).body.description).toBe(
      'Bad Request: BUTTON_DATA_INVALID',
    );
    expect((await send(keyboard([['', 'x']]))).body.description).toBe(
      'Bad Request: button text is empty',
    );
    expect(
      (await send({ inline_keyboard: [[{ text: 'Open', url: 'https://wallet.test/savings' }]] }))
        .status,
    ).toBe(200);
    expect(
      (await send({ inline_keyboard: [[{ text: 'Open', url: 'localhost' }]] })).body.description,
    ).toBe('Bad Request: wrong HTTP URL');
    // A link button is shown, and cannot be tapped.
    expect(fake.lastMessage().buttons[0]?.[0]).toEqual({
      text: 'Open',
      data: null,
      url: 'https://wallet.test/savings',
    });
  });

  test('with parse_mode HTML show the text without its tags, and refuse a name that was not escaped', async () => {
    await chatExists();
    const ok = await call('sendMessage', {
      chat_id: OWNER.id,
      parse_mode: 'HTML',
      text: '<b>Wallet</b>\n&lt;b&gt;&amp; Co: <code>12,50 lunch</code> &quot;quoted&quot;',
    });
    expect(ok.status).toBe(200);
    expect(fake.lastMessage().text).toBe('Wallet\n<b>& Co: 12,50 lunch "quoted"');
    expect(fake.lastMessage().html).toContain('<b>Wallet</b>');

    const bad = await call('sendMessage', {
      chat_id: OWNER.id,
      parse_mode: 'HTML',
      text: 'Groceries <b>& more',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.description).toMatch(/^Bad Request: can't parse entities/);
    // Without a parse mode the text is literal.
    await call('sendMessage', { chat_id: OWNER.id, text: 'a <b> literal' });
    expect(fake.lastMessage().text).toBe('a <b> literal');

    expect(renderTelegramHtml('<i>a</i> &amp; b')).toEqual({ text: 'a & b' });
    expect(renderTelegramHtml('<b>open')).toHaveProperty('error');
    expect(renderTelegramHtml('<b>x</i>')).toHaveProperty('error');
    expect(renderTelegramHtml('1 < 2')).toHaveProperty('error');
    expect(renderTelegramHtml('1 &gt; 0 and R&D')).toEqual({ text: '1 > 0 and R&D' });
  });
});

test.describe('the user', () => {
  test('types commands with the bot_command entity, and plain text without one', async () => {
    await fake.say('/start ABCD2345', { wait: false });
    await fake.say('12,50 lunch', { wait: false });
    await fake.as(STRANGER).say('/help', { wait: false });
    const { body } = await call<
      {
        message: {
          text: string;
          from: { id: number; is_bot: boolean; username?: string };
          chat: { id: number; type: string };
          entities?: unknown[];
        };
      }[]
    >('getUpdates', { timeout: 0 });
    const [start, plain, stranger] = body.result ?? [];
    expect(start?.message).toMatchObject({
      text: '/start ABCD2345',
      from: { id: OWNER.id, is_bot: false, username: 'olivia' },
      chat: { id: OWNER.id, type: 'private' },
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    });
    expect(plain?.message.entities).toBeUndefined();
    expect(stranger?.message).toMatchObject({
      from: { id: STRANGER.id },
      chat: { id: STRANGER.id, type: 'private' },
      entities: [{ type: 'bot_command', offset: 0, length: 5 }],
    });
  });

  test('can be a stranger or sit in a group', async () => {
    await fake.as(OWNER, GROUP).say('/status@wallet_e2e_bot', { wait: false });
    const { body } = await call<
      { message: { chat: { id: number; type: string; title: string }; from: { id: number } } }[]
    >('getUpdates', { timeout: 0 });
    expect(body.result?.[0]?.message).toMatchObject({
      chat: { id: GROUP.id, type: 'supergroup', title: 'Family' },
      from: { id: OWNER.id },
    });
  });

  test('taps a button found by its label, on the latest message that has it', async () => {
    await chatExists();
    await call('sendMessage', {
      chat_id: OWNER.id,
      text: 'Which budget?',
      reply_markup: keyboard(
        [
          ['🛒 Groceries · €400.00', 'f:a:b:1'],
          ['🍝 Eating out · €200.00', 'f:a:b:2'],
        ],
        [['✖ Cancel', 'f:a:x']],
      ),
    });
    await call('sendMessage', {
      chat_id: OWNER.id,
      text: 'Done',
      reply_markup: keyboard([
        ['↩ Undo', 'u:s:7'],
        ['📅 Change date', 'c:s:7'],
      ]),
    });
    const queryOf = async () => {
      const { body } = await call<
        {
          callback_query?: {
            id: string;
            data: string;
            from: { id: number };
            message: { message_id: number; chat: { id: number }; text: string };
          };
        }[]
      >('getUpdates', { timeout: 0 });
      return body.result?.at(-1)?.callback_query;
    };

    await fake.tap('Groceries', { wait: false });
    expect(await queryOf()).toMatchObject({
      data: 'f:a:b:1',
      from: { id: OWNER.id },
      message: { message_id: 2, chat: { id: OWNER.id }, text: 'Which budget?' },
    });
    // An exact label wins over a part of one; a RegExp works; the newest message is tried first.
    await fake.tap('✖ Cancel', { wait: false });
    expect((await queryOf())?.data).toBe('f:a:x');
    await fake.tap(/Undo$/, { wait: false });
    expect(await queryOf()).toMatchObject({ data: 'u:s:7', message: { message_id: 3 } });
    // `on` restricts the search to one message, and `tapData` sends data that is no longer on screen.
    await fake.tap('Groceries', { on: 2, wait: false });
    await fake.owner.tapData('f:old:b:9', 2, { wait: false });
    expect((await queryOf())?.data).toBe('f:old:b:9');
  });

  test('says which buttons there are when the one it is asked for is not there, or is ambiguous', async () => {
    await chatExists();
    await call('sendMessage', {
      chat_id: OWNER.id,
      text: 'Pick',
      reply_markup: keyboard([
        ['Eating out · €20.00', 'a'],
        ['Eating in · €5.00', 'b'],
        ['Fuel', 'c'],
      ]),
    });
    await expect(fake.tap('Cinema')).rejects.toThrow(
      /No button "?Cinema"? in the chat.*"Eating out · €20.00" \| "Eating in · €5.00" \| "Fuel"/,
    );
    await expect(fake.tap('Eating')).rejects.toThrow(/2 buttons match Eating on message 2/);
    await call('sendMessage', {
      chat_id: OWNER.id,
      text: 'Link',
      reply_markup: {
        inline_keyboard: [[{ text: 'Open savings', url: 'https://wallet.test/savings' }]],
      },
    });
    await expect(fake.tap('Open savings')).rejects.toThrow(/is a link/);
    await expect(fake.as(STRANGER).tap('Fuel')).rejects.toThrow(/\(no keyboard\)/);
  });

  test('has a tap answered once: a toast is recorded, a second answer is refused', async () => {
    await chatExists();
    await call('sendMessage', {
      chat_id: OWNER.id,
      text: 'x',
      reply_markup: keyboard([['Go', 'g']]),
    });
    await fake.tap('Go', { wait: false });
    const { body } = await call<{ callback_query?: { id: string } }[]>('getUpdates', {
      timeout: 0,
    });
    const id = body.result?.at(-1)?.callback_query?.id ?? '';
    expect(
      (
        await call('answerCallbackQuery', {
          callback_query_id: id,
          text: 'This entry expired, start again with /spending',
        })
      ).status,
    ).toBe(200);
    expect(fake.lastToast()).toBe('This entry expired, start again with /spending');
    expect((await call('answerCallbackQuery', { callback_query_id: id })).status).toBe(400);
    expect(
      (await call('answerCallbackQuery', { callback_query_id: 'cb-nope' })).body.description,
    ).toMatch(/query ID is invalid/);
    expect(fake.toasts()).toEqual([
      { queryId: id, text: 'This entry expired, start again with /spending' },
    ]);
  });

  test('waits for a message of the bot: one that is there, one that comes, one that is edited into place', async () => {
    await chatExists();
    await call('sendMessage', { chat_id: OWNER.id, text: 'first' });
    expect((await fake.waitForMessage((message) => message.text === 'first')).id).toBe(2);

    const later = fake.owner.waitForText(/^second/);
    await call('sendMessage', { chat_id: OWNER.id, text: 'second one' });
    expect((await later).text).toBe('second one');

    const edited = fake.waitForMessage((message) => message.text === 'edited');
    await call('editMessageText', { chat_id: OWNER.id, message_id: 2, text: 'edited' });
    expect((await edited).id).toBe(2);

    await expect(fake.waitForMessage((message) => message.text === 'never', 150)).rejects.toThrow(
      /Timed out after 150 ms waiting for a message of the bot that matches[\s\S]*- edited[\s\S]*- second one/,
    );
  });
});

test.describe('failures', () => {
  test('fail the next N calls of a method and then recover, with the status and description of Telegram', async () => {
    fake.failNext('sendMessage', 500, { times: 2 });
    await chatExists();
    const results = [
      await call('sendMessage', { chat_id: OWNER.id, text: 'a' }),
      await call('sendMessage', { chat_id: OWNER.id, text: 'b' }),
      await call('sendMessage', { chat_id: OWNER.id, text: 'c' }),
    ];
    expect(results.map((result) => result.status)).toEqual([500, 500, 200]);
    expect(results[0]?.body).toMatchObject({
      ok: false,
      error_code: 500,
      description: 'Internal Server Error',
    });
    expect(fake.texts()).toEqual(['c']);
    expect(fake.calls('sendMessage').map((entry) => entry.status)).toEqual([500, 500, 200]);
    expect(fake.calls('sendMessage')[0]?.description).toBe('Internal Server Error');
  });

  test('fail a method for good until healed, and carry retry_after for a 429', async () => {
    fake.failAlways('getMe', 401);
    expect((await call('getMe')).status).toBe(401);
    expect((await call('getMe')).status).toBe(401);
    expect((await call('getMe', {})).body.description).toBe('Unauthorized');
    fake.heal('getMe');
    expect((await call('getMe')).status).toBe(200);

    fake.failNext('getUpdates', 429, { retryAfter: 7 });
    expect((await call('getUpdates', { timeout: 0 })).body).toMatchObject({
      error_code: 429,
      parameters: { retry_after: 7 },
    });

    fake.failAlways('getMe', 403, { description: 'Forbidden: custom' });
    fake.failAlways('deleteWebhook', 409);
    fake.heal();
    expect((await call('getMe')).status).toBe(200);
    expect((await call('deleteWebhook')).status).toBe(200);
  });

  test('fail only the calls that match, so one kind of message can be refused and not the others', async () => {
    await chatExists();
    fake.failNext('sendMessage', 400, {
      description: 'Bad Request: wrong HTTP URL',
      when: (params) => String(params['text']).startsWith('📅'),
    });
    expect((await call('sendMessage', { chat_id: OWNER.id, text: '⚠️ Groceries' })).status).toBe(
      200,
    );
    expect(
      (await call('sendMessage', { chat_id: OWNER.id, text: '📅 March 2026 is closed' })).status,
    ).toBe(400);
    expect(
      (await call('sendMessage', { chat_id: OWNER.id, text: '📅 March 2026 is closed' })).status,
    ).toBe(200);
  });

  test('drop the connection, which is what a network error looks like to the bot', async () => {
    fake.dropNext('getMe', 1);
    await expect(call('getMe')).rejects.toThrow();
    expect((await call('getMe')).status).toBe(200);
    expect(fake.calls('getMe').map((entry) => entry.status)).toEqual([0, 200]);
  });

  test('hold the calls of a method until the gate is released', async () => {
    const gate = fake.hold('getMe');
    let answered = false;
    const pending = call('getMe').then((answer) => {
      answered = true;
      return answer;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(answered).toBe(false);
    // Another method is not held.
    expect((await call('deleteWebhook')).status).toBe(200);
    gate.release();
    expect((await pending).status).toBe(200);
    // Released for good.
    expect((await call('getMe')).status).toBe(200);
  });

  test('block the bot for a person: every message to that chat is a 403, until they unblock it', async () => {
    await chatExists();
    await fake.as(STRANGER).say('hi', { wait: false });
    fake.block(OWNER);
    const refused = await call('sendMessage', { chat_id: OWNER.id, text: 'hello?' });
    expect(refused).toMatchObject({
      status: 403,
      body: { description: 'Forbidden: bot was blocked by the user' },
    });
    expect((await call('sendMessage', { chat_id: STRANGER.id, text: 'hello' })).status).toBe(200);
    fake.unblock(OWNER);
    expect((await call('sendMessage', { chat_id: OWNER.id, text: 'back' })).status).toBe(200);
  });

  test('prints the conversation for the report of a failed test', async () => {
    await chatExists();
    await call('sendMessage', {
      chat_id: OWNER.id,
      text: 'Which budget?',
      reply_markup: keyboard([['Fuel', 'x']]),
    });
    const transcript = fake.transcript();
    expect(transcript).toContain('sendMessage');
    expect(transcript).toContain(`--- chat ${OWNER.id} (private) as it stands ---`);
    expect(transcript).toContain('[2] Which budget?');
    expect(transcript).toContain('[Fuel]');
  });
});
