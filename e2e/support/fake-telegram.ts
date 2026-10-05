import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * A fake Telegram Bot API for the end-to-end tests of the bot: a small HTTP server in the test
 * process, with the routes the bot calls (`/bot<token>/<method>`), and a "user" that types and taps
 * like a person in Telegram. The Wallet server under test is started with `TELEGRAM_BOT_TOKEN` and
 * `TELEGRAM_API_ROOT` pointing here (`serverEnv()`), so nothing goes to the real Telegram.
 *
 * What it implements (the rest answers a Telegram-style 404):
 *
 *   getMe, deleteWebhook, setMyCommands   a bot username; the commands are kept (`commands()`)
 *   getUpdates                            real long-poll semantics: the call is held until an update is
 *                                         queued or `timeout` seconds pass; an update stays queued
 *                                         until a later call confirms it with a higher `offset`
 *   sendMessage, editMessageText,         the chat keeps the current text and inline keyboard of every
 *   editMessageReplyMarkup                message, so a test asks "what does the chat show now". An edit
 *                                         that changes nothing is a 400 "message is not modified", an edit
 *                                         without `reply_markup` removes the keyboard, a message that is not
 *                                         valid Telegram HTML (an unescaped `<`) is a 400 "can't parse
 *                                         entities", and a button is checked like Telegram does (text,
 *                                         `callback_data` of 1 to 64 bytes)
 *   answerCallbackQuery                   recorded as a toast (`toasts()`); a query is answered once
 *
 * Every call is recorded in order with its parameters (`calls()`). `transcript()` prints the whole
 * conversation, for the report of a test that failed.
 *
 * THE USER. `owner` (and the shortcuts `say`, `tap`, `lastMessage`, ...) is a person in a private chat
 * with the bot. `as(person, chat)` is anyone else: a stranger (`STRANGER`), the owner in a group
 * (`GROUP`). `say()` and `tap()` return once the bot has HANDLED the update, which Telegram tells it by
 * the next `getUpdates` carrying a higher offset, so what the bot answered is in the chat when they
 * resolve and "the bot stayed silent" can be asserted without a sleep.
 *
 * FAILURES. `failNext` / `failAlways` answer a method with an error status (401, 403, 409, 429, 500...)
 * once, N times or until `heal()`; `dropNext` kills the connection (what a network error looks like);
 * `hold()` keeps the calls of a method waiting until released (a bot that is "connecting"); `block()`
 * makes the user block the bot (every message to that chat is a 403).
 */

/** The token of the fake bot: the server of a test is given this one. It is not secret. */
export const FAKE_BOT_TOKEN = '777000111:AAE2eFakeBotTokenForTheWalletTestsXY';
export const FAKE_BOT_USERNAME = 'wallet_e2e_bot';
const BOT_ID = 777_000_111;

/** The most Telegram lets one message hold, after its formatting is parsed. */
const MESSAGE_MAX_CHARS = 4096;
const CALLBACK_DATA_MAX_BYTES = 64;
const KEYBOARD_MAX_BUTTONS = 100;
const KEYBOARD_MAX_ROW = 8;

/** How long `say()`, `tap()` and the waiters give the bot, in milliseconds. */
export const DEFAULT_WAIT_MS = 10_000;

export interface Person {
  id: number;
  first_name: string;
  username?: string;
}

/** The owner: the one account that is linked in the tests. */
export const OWNER: Person = { id: 4242, first_name: 'Olivia', username: 'olivia' };
/** Somebody who is not linked. */
export const STRANGER: Person = { id: 666, first_name: 'Mallory', username: 'mallory' };

export interface ChatSpec {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
}

/** A group chat, for "a group never links and is never answered". */
export const GROUP: ChatSpec = { id: -1_002_003_004, type: 'supergroup', title: 'Family' };

/** The private chat of a person: its id is the user's id. */
export const privateChatOf = (person: Person): ChatSpec => ({ id: person.id, type: 'private' });

export interface ButtonView {
  text: string;
  /** `callback_data`, null for a link button. */
  data: string | null;
  /** The address of a link button, null for a callback button. */
  url: string | null;
}

/** A message of the bot as the chat shows it now (a copy: it does not change after the call). */
export interface BotMessage {
  id: number;
  chatId: number;
  /** What the chat shows: the text with its HTML formatting taken out and the entities decoded. */
  text: string;
  /** What the bot sent (HTML). */
  html: string;
  /** The inline keyboard, rows of buttons. Empty when the message has none (any more). */
  buttons: ButtonView[][];
  /** How many times it was edited. */
  edits: number;
}

export interface CallRecord {
  /** Order of arrival, from 1, over every call. */
  seq: number;
  method: string;
  params: Record<string, unknown>;
  /** The HTTP status the call got (0 while it is held or running; 0 too for a dropped connection). */
  status: number;
  /** For an error answer: Telegram's description. */
  description?: string;
}

export interface Toast {
  /** The text of the toast, undefined for a tap that was answered silently. */
  text: string | undefined;
  /** The callback query it answered. */
  queryId: string;
}

export interface FailureOptions {
  /** Telegram's `description`. Default: the usual one of the status. */
  description?: string;
  /** For 429: seconds until Telegram says to try again. */
  retryAfter?: number;
  /** Only the calls whose parameters satisfy this (to fail one kind of message and not the others). */
  when?: (params: Record<string, unknown>) => boolean;
}

export interface Gate {
  /** Lets the calls that wait go, and every later one too. */
  release(): void;
}

export interface FakeTelegramOptions {
  token?: string;
  username?: string;
  /**
   * Two programs polling the same token: a new `getUpdates` ends the one that is held with a 409, as
   * Telegram does. Off by default (the bot's own call at stop would trip it for nothing).
   */
  singlePoller?: boolean;
}

type Params = Record<string, unknown>;
type Update = Record<string, unknown> & { update_id: number };

interface Stored {
  id: number;
  chatId: number;
  html: string;
  parseMode: string | undefined;
  text: string;
  keyboard: ButtonView[][];
  edits: number;
  /** The last time it was created or changed: "the latest message" is the one with the highest. */
  touched: number;
}

interface ChatState {
  spec: ChatSpec;
  /** Messages of the bot and of the user, one numbering, like Telegram. */
  nextMessageId: number;
  bot: Stored[];
}

interface Rule {
  method: string;
  /** 'network' kills the connection. */
  failure: { status: number; description: string; parameters?: Params } | 'network';
  /** Calls left that it fails (Infinity: until `heal()`). */
  remaining: number;
  when?: (params: Params) => boolean;
}

interface Held {
  poll: boolean;
  terminated: boolean;
}

class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly description: string,
    readonly parameters?: Params,
  ) {
    super(`${status} ${description}`);
  }
}

const DEFAULT_DESCRIPTION: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden: bot was blocked by the user',
  404: 'Not Found',
  409: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

// --- Telegram's HTML ----------------------------------------------------------------------------

const HTML_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'a',
  'code',
  'pre',
  'tg-spoiler',
  'tg-emoji',
  'span',
  'blockquote',
]);

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"' };

/**
 * What a chat shows for text sent with `parse_mode: 'HTML'`, or the reason Telegram refuses it. Like
 * Telegram, a `<` has to start a tag it knows (so a name with `<` must be escaped as `&lt;`), and tags
 * must be closed in order. A bare `&` or `>` is taken as text.
 */
export function renderTelegramHtml(html: string): { text: string } | { error: string } {
  const open: string[] = [];
  let text = '';
  let at = 0;
  while (at < html.length) {
    const char = html.charAt(at);
    if (char === '<') {
      const tag = /^<(\/?)([A-Za-z][\w-]*)((?:\s[^<>]*)?)>/.exec(html.slice(at));
      const offset = Buffer.byteLength(html.slice(0, at));
      if (!tag) {
        const shown = html.slice(at, at + 12);
        return {
          error: `can't parse entities: Unsupported start tag "${shown}" at byte offset ${offset}`,
        };
      }
      const closing = tag[1] === '/';
      const name = (tag[2] ?? '').toLowerCase();
      if (!HTML_TAGS.has(name)) {
        return {
          error: `can't parse entities: Unsupported start tag "${name}" at byte offset ${offset}`,
        };
      }
      if (closing) {
        if (open.pop() !== name) {
          return {
            error: `can't parse entities: Unmatched end tag at byte offset ${offset}, expected "</${open.at(-1) ?? ''}>", found "</${name}>"`,
          };
        }
      } else {
        open.push(name);
      }
      at += tag[0].length;
    } else if (char === '&') {
      const entity = /^&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/.exec(html.slice(at));
      const body = entity?.[1];
      let decoded: string | undefined;
      if (body?.startsWith('#x')) decoded = String.fromCodePoint(parseInt(body.slice(2), 16));
      else if (body?.startsWith('#')) decoded = String.fromCodePoint(parseInt(body.slice(1), 10));
      else if (body !== undefined) decoded = NAMED_ENTITIES[body];
      if (entity && decoded !== undefined) {
        text += decoded;
        at += entity[0].length;
      } else {
        text += '&';
        at += 1;
      }
    } else {
      text += char;
      at += 1;
    }
  }
  if (open.length > 0) {
    return {
      error: `can't parse entities: Can't find end tag corresponding to start tag "${open.at(-1)}"`,
    };
  }
  return { text };
}

// --- Keyboards ----------------------------------------------------------------------------------

/** The inline keyboard of a `reply_markup`, checked the way Telegram checks it. Throws a 400. */
function readKeyboard(markup: unknown): ButtonView[][] {
  if (markup === undefined || markup === null) return [];
  const value: unknown = typeof markup === 'string' ? JSON.parse(markup) : markup;
  const rows = (value as { inline_keyboard?: unknown }).inline_keyboard;
  if (!Array.isArray(rows))
    throw new ApiFailure(400, "Bad Request: can't parse reply keyboard markup JSON object");
  let count = 0;
  const keyboard = rows.map((row: unknown) => {
    if (!Array.isArray(row))
      throw new ApiFailure(400, "Bad Request: can't parse inline keyboard button");
    if (row.length > KEYBOARD_MAX_ROW)
      throw new ApiFailure(400, 'Bad Request: too many buttons in a row');
    return row.map((raw: unknown): ButtonView => {
      const button = raw as { text?: unknown; callback_data?: unknown; url?: unknown };
      const text = typeof button.text === 'string' ? button.text : '';
      if (text === '') throw new ApiFailure(400, 'Bad Request: button text is empty');
      count += 1;
      if (typeof button.callback_data === 'string') {
        const bytes = Buffer.byteLength(button.callback_data);
        if (bytes < 1 || bytes > CALLBACK_DATA_MAX_BYTES) {
          throw new ApiFailure(400, 'Bad Request: BUTTON_DATA_INVALID');
        }
        return { text, data: button.callback_data, url: null };
      }
      if (typeof button.url === 'string') {
        if (!/^(https?|tg):\/\/\S+$/i.test(button.url)) {
          throw new ApiFailure(400, 'Bad Request: wrong HTTP URL');
        }
        return { text, data: null, url: button.url };
      }
      throw new ApiFailure(
        400,
        "Bad Request: can't parse inline keyboard button: Text buttons are unallowed in the inline keyboard",
      );
    });
  });
  if (count > KEYBOARD_MAX_BUTTONS) throw new ApiFailure(400, 'Bad Request: too many buttons');
  return keyboard.filter((row) => row.length > 0);
}

const sameKeyboard = (a: ButtonView[][], b: ButtonView[][]): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

// --- The fake ------------------------------------------------------------------------------------

export class FakeTelegram {
  readonly token: string;
  readonly username: string;
  readonly botId = BOT_ID;
  /** The user: a person in a private chat with the bot. */
  readonly owner: ChatUser;

  private singlePoller: boolean;
  private readonly server: Server;
  private url = '';
  private seq = 0;
  private nextUpdateId = 1000;
  private updates: Update[] = [];
  private confirmedThrough = 0;
  private readonly chats = new Map<number, ChatState>();
  private readonly queries = new Map<string, { answered: boolean }>();
  private nextQuery = 1;
  private readonly callLog: CallRecord[] = [];
  private readonly toastLog: Toast[] = [];
  private readonly rules: Rule[] = [];
  private readonly gates = new Map<string, Set<() => void>>();
  private readonly gated = new Set<string>();
  private readonly blockedChats = new Set<number>();
  private readonly held = new Set<Held>();
  private readonly watchers = new Set<() => void>();
  private commandList: { command: string; description: string }[] = [];
  private webhookRemoved = false;
  private closed = false;

  private constructor(options: FakeTelegramOptions) {
    this.token = options.token ?? FAKE_BOT_TOKEN;
    this.username = options.username ?? FAKE_BOT_USERNAME;
    this.singlePoller = options.singlePoller ?? false;
    this.owner = new ChatUser(this, OWNER, privateChatOf(OWNER));
    this.server = createServer((req, res) => void this.handle(req, res));
    // Telegram keeps a connection open for a long time, and the bot's HTTP client reuses it: a short
    // idle timeout here would reset a request that the client sends at the wrong moment.
    this.server.keepAliveTimeout = 120_000;
    this.server.headersTimeout = 125_000;
    this.server.requestTimeout = 0;
  }

  /**
   * From now on a new `getUpdates` ends the long poll that is held with a 409, as Telegram does when two
   * programs poll one token (`singlePoller` option, switched on late: a server that is already polling
   * is not disturbed until another one starts).
   */
  enforceSinglePoller(): void {
    this.singlePoller = true;
  }

  /** Starts the fake on a free port of 127.0.0.1. */
  static async start(options: FakeTelegramOptions = {}): Promise<FakeTelegram> {
    const fake = new FakeTelegram(options);
    await new Promise<void>((resolve, reject) => {
      fake.server.once('error', reject);
      fake.server.listen(0, '127.0.0.1', () => resolve());
    });
    fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    return fake;
  }

  /** `TELEGRAM_API_ROOT`: where the bot under test calls (no trailing slash). */
  get apiRoot(): string {
    return this.url;
  }

  /** The environment of a Wallet server that talks to this fake instead of Telegram. */
  serverEnv(options: { appUrl?: string } = {}): Record<string, string> {
    return {
      TELEGRAM_BOT_TOKEN: this.token,
      TELEGRAM_API_ROOT: this.apiRoot,
      ...(options.appUrl === undefined ? {} : { APP_URL: options.appUrl }),
    };
  }

  /** Stops the fake: calls that are held are let go, and the sockets are closed. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const release of [...this.gates.values()].flatMap((set) => [...set])) release();
    this.changed();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // --- The user ----------------------------------------------------------------------------------

  /** Anyone else in any chat: `as(STRANGER)`, `as(OWNER, GROUP)`. Default chat: the person's private one. */
  as(person: Person, chat: ChatSpec = privateChatOf(person)): ChatUser {
    return new ChatUser(this, person, chat);
  }

  /** The owner types. Resolves when the bot has handled it. */
  say(text: string, options?: { wait?: boolean; timeoutMs?: number }): Promise<void> {
    return this.owner.say(text, options);
  }

  /** The owner taps a button of the chat, found by its label. */
  tap(label: string | RegExp, options?: TapOptions): Promise<void> {
    return this.owner.tap(label, options);
  }

  /** The owner's tap of a button by its `callback_data`, even one that is not on the screen any more. */
  tapData(
    data: string,
    messageId: number,
    options?: { wait?: boolean; timeoutMs?: number },
  ): Promise<void> {
    return this.owner.tapData(data, messageId, options);
  }

  /** The newest message the bot sent to the owner. Throws when there is none. */
  lastMessage(): BotMessage {
    return this.owner.lastMessage();
  }

  /** Every message the bot sent to the owner's chat, in the order sent, as the chat shows them now. */
  messages(): BotMessage[] {
    return this.owner.messages();
  }

  /** The visible texts of `messages()`. */
  texts(): string[] {
    return this.owner.texts();
  }

  waitForMessage(
    predicate: (message: BotMessage) => boolean,
    timeoutMs = DEFAULT_WAIT_MS,
  ): Promise<BotMessage> {
    return this.owner.waitForMessage(predicate, timeoutMs);
  }

  // --- What the bot did --------------------------------------------------------------------------

  /** Every call so far, in order (or only those of one method). `getUpdates` is in there too. */
  calls(method?: string): CallRecord[] {
    return this.callLog
      .filter((call) => method === undefined || call.method === method)
      .map((call) => ({ ...call, params: { ...call.params } }));
  }

  /** The toasts the bot answered taps with, in order. */
  toasts(): Toast[] {
    return this.toastLog.map((toast) => ({ ...toast }));
  }

  /** The text of the last toast, or undefined. */
  lastToast(): string | undefined {
    return this.toastLog.at(-1)?.text;
  }

  /** The commands of the bot's menu (`setMyCommands`), as it registered them. */
  commands(): { command: string; description: string }[] {
    return this.commandList.map((entry) => ({ ...entry }));
  }

  /** Whether the bot asked to remove its webhook (`deleteWebhook`), as it must before it polls. */
  get webhookWasRemoved(): boolean {
    return this.webhookRemoved;
  }

  /** How many `getUpdates` calls are held right now (a bot that is polling has one). */
  get pollsHeld(): number {
    return [...this.held].filter((entry) => entry.poll).length;
  }

  /** Resolves when the bot is polling: a `getUpdates` waits for updates. */
  waitUntilPolling(timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
    return this.waitFor(
      'the bot to poll for updates',
      () => this.pollsHeld > 0 || undefined,
      timeoutMs,
      () => this.describeState(),
    ).then(() => undefined);
  }

  /** Resolves when no update is waiting to be collected, that is when the bot has handled every one. */
  settled(timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
    return this.waitFor(
      'the bot to handle every update',
      () => (this.updates.length === 0 ? true : undefined),
      timeoutMs,
      () => this.describeState(),
    ).then(() => undefined);
  }

  /** Resolves with the first call of `method` (that matches) made from now on or already made after `afterSeq`. */
  waitForCall(
    method: string,
    predicate: (call: CallRecord) => boolean = () => true,
    timeoutMs = DEFAULT_WAIT_MS,
  ): Promise<CallRecord> {
    return this.waitFor(
      `a call of ${method}`,
      () =>
        this.callLog.find((call) => call.method === method && call.status !== 0 && predicate(call)),
      timeoutMs,
      () => this.describeState(),
    );
  }

  /** The sequence number of the last call: `calls()` entries after it are new. */
  get mark(): number {
    return this.seq;
  }

  // --- Failures ----------------------------------------------------------------------------------

  /**
   * The next `times` calls of `method` (that match) are answered with an error `status`. `'*'` is every
   * method: what Telegram answers to a token it does not know.
   */
  failNext(
    method: string,
    status: number,
    options: FailureOptions & { times?: number } = {},
  ): void {
    this.addRule(method, status, options, options.times ?? 1);
  }

  /** Every call of `method` is answered with an error `status` until `heal()`. */
  failAlways(method: string, status: number, options: FailureOptions = {}): void {
    this.addRule(method, status, options, Infinity);
  }

  /** The next `times` calls of `method` lose their connection (a network error for the bot). */
  dropNext(method: string, times = 1, when?: (params: Params) => boolean): void {
    this.rules.push({ method, failure: 'network', remaining: times, when });
  }

  /** Ends the failures of one method, or of all. A held long poll is woken to see it. */
  heal(method?: string): void {
    for (let i = this.rules.length - 1; i >= 0; i--) {
      if (method === undefined || this.rules[i]?.method === method) this.rules.splice(i, 1);
    }
    this.changed();
  }

  /** The calls of `method` wait until the gate is released (the bot stays "connecting"). */
  hold(method: string): Gate {
    this.gated.add(method);
    const release = () => {
      this.gated.delete(method);
      this.changed();
    };
    return { release };
  }

  /** The person blocks the bot: every message to their chat is a 403 until `unblock()`. */
  block(person: Person | ChatSpec): void {
    this.blockedChats.add(person.id);
  }

  unblock(person: Person | ChatSpec): void {
    this.blockedChats.delete(person.id);
  }

  // --- A report for a failed test ----------------------------------------------------------------

  /** The whole conversation: every call in order, and each chat as it stands. */
  transcript(): string {
    const lines: string[] = ['--- calls of the bot ---'];
    for (const call of this.callLog) {
      if (call.method === 'getUpdates' && call.status === 200) continue;
      const body = JSON.stringify(call.params);
      const outcome = call.status === 200 ? '' : ` -> ${call.status} ${call.description ?? ''}`;
      lines.push(
        `#${call.seq} ${call.method} ${body.length > 400 ? `${body.slice(0, 400)}…` : body}${outcome}`,
      );
    }
    for (const chat of this.chats.values()) {
      lines.push('', `--- chat ${chat.spec.id} (${chat.spec.type}) as it stands ---`);
      for (const message of chat.bot) {
        lines.push(`[${message.id}] ${message.text}`);
        for (const row of message.keyboard) {
          lines.push(`      ${row.map((button) => `[${button.text}]`).join(' ')}`);
        }
      }
    }
    return lines.join('\n');
  }

  // --- Used by ChatUser --------------------------------------------------------------------------

  /** @internal */
  chatState(spec: ChatSpec): ChatState {
    let state = this.chats.get(spec.id);
    if (!state) {
      state = { spec, nextMessageId: 1, bot: [] };
      this.chats.set(spec.id, state);
    }
    return state;
  }

  /** @internal Queues an update for the bot and returns its id. */
  queue(build: (updateId: number) => Update): number {
    const update = build(this.nextUpdateId++);
    this.updates.push(update);
    this.changed();
    return update.update_id;
  }

  /** @internal */
  newQueryId(): string {
    const id = `cb-${this.nextQuery++}`;
    this.queries.set(id, { answered: false });
    return id;
  }

  /** @internal Resolves when the bot has collected (and so handled) update `updateId`. */
  async handled(updateId: number, timeoutMs: number): Promise<void> {
    await this.waitFor(
      `the bot to handle update ${updateId}`,
      () => (this.confirmedThrough >= updateId ? true : undefined),
      timeoutMs,
      () =>
        `${this.describeState()}\nIs the bot connected? A server with the bot running polls from its first seconds.`,
    );
  }

  /** @internal The bot's message as a user sees it. */
  view(message: Stored): BotMessage {
    return {
      id: message.id,
      chatId: message.chatId,
      text: message.text,
      html: message.html,
      buttons: message.keyboard.map((row) => row.map((button) => ({ ...button }))),
      edits: message.edits,
    };
  }

  /** @internal Resolves when `check` holds, evaluated again at every change of the chat. */
  waitFor<T>(
    what: string,
    check: () => T | undefined | null | false,
    timeoutMs: number,
    detail?: () => string,
  ): Promise<NonNullable<T>> {
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (action: () => void) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.watchers.delete(run);
        action();
      };
      const run = () => {
        try {
          const value = check();
          if (value) finish(() => resolve(value as NonNullable<T>));
        } catch (error) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      };
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new Error(
                `Timed out after ${timeoutMs} ms waiting for ${what}.${detail ? `\n${detail()}` : ''}`,
              ),
            ),
          ),
        timeoutMs,
      );
      this.watchers.add(run);
      run();
    });
  }

  // --- The HTTP side -----------------------------------------------------------------------------

  private changed(): void {
    for (const watcher of [...this.watchers]) watcher();
  }

  private describeState(): string {
    const texts = [...this.chats.values()].flatMap((chat) =>
      chat.bot
        .slice(-3)
        .map(
          (message) =>
            `  chat ${chat.spec.id} [${message.id}]: ${message.text.replace(/\n/g, ' / ')}`,
        ),
    );
    const failing = this.callLog.filter((call) => call.status >= 400).slice(-3);
    return [
      `fake Telegram: ${this.callLog.length} calls, ${this.updates.length} update(s) not collected, ${this.pollsHeld} poll(s) held`,
      ...(texts.length > 0
        ? ['latest messages of the bot:', ...texts]
        : ['the bot has sent nothing']),
      ...failing.map(
        (call) =>
          `  failed call #${call.seq} ${call.method}: ${call.status} ${call.description ?? ''}`,
      ),
    ].join('\n');
  }

  private addRule(method: string, status: number, options: FailureOptions, times: number): void {
    const parameters =
      options.retryAfter === undefined ? undefined : { retry_after: options.retryAfter };
    this.rules.push({
      method,
      failure: {
        status,
        description: options.description ?? DEFAULT_DESCRIPTION[status] ?? 'Error',
        parameters,
      },
      remaining: times,
      when: options.when,
    });
    // A long poll that is held must see a failure that was just installed.
    this.changed();
  }

  private takeRule(method: string, params: Params): Rule | undefined {
    const rule = this.rules.find(
      (candidate) =>
        (candidate.method === method || candidate.method === '*') &&
        candidate.remaining > 0 &&
        (!candidate.when || candidate.when(params)),
    );
    if (rule) rule.remaining -= 1;
    return rule;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const abort = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    const respond = (status: number, body: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const fail = (error: ApiFailure) =>
      respond(error.status, {
        ok: false,
        error_code: error.status,
        description: error.description,
        ...(error.parameters ? { parameters: error.parameters } : {}),
      });

    const route = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(
      new URL(req.url ?? '/', 'http://fake').pathname,
    );
    if (!route) return fail(new ApiFailure(404, 'Not Found'));
    const token = decodeURIComponent(route[1] ?? '');
    const method = route[2] ?? '';
    const params = await readParams(req);

    const record: CallRecord = { seq: ++this.seq, method, params, status: 0 };
    this.callLog.push(record);
    this.changed();
    const finish = (status: number, description?: string) => {
      record.status = status;
      record.description = description;
      this.changed();
    };
    try {
      if (token !== this.token) throw new ApiFailure(401, 'Unauthorized');
      await this.passGates(method, abort.signal);
      const rule = this.takeRule(method, params);
      if (rule?.failure === 'network') {
        finish(0, 'connection dropped');
        req.socket.destroy();
        return;
      }
      if (rule)
        throw new ApiFailure(
          rule.failure.status,
          rule.failure.description,
          rule.failure.parameters,
        );
      const result = await this.dispatch(method, params, abort.signal);
      finish(200);
      respond(200, { ok: true, result });
    } catch (error) {
      if (abort.signal.aborted) return finish(0, 'client closed the connection');
      if (error instanceof ApiFailure) {
        finish(error.status, error.description);
        return fail(error);
      }
      finish(500, String(error));
      respond(500, {
        ok: false,
        error_code: 500,
        description: `Internal Server Error: ${String(error)}`,
      });
    }
  }

  /** A held method waits here until `release()`, the fake closes or the client gives up. */
  private async passGates(method: string, signal: AbortSignal): Promise<void> {
    if (!this.gated.has(method)) return;
    const entry: Held = { poll: false, terminated: false };
    this.held.add(entry);
    try {
      await this.until(() => !this.gated.has(method) || this.closed, Infinity, signal);
    } finally {
      this.held.delete(entry);
    }
  }

  /** Waits until `check()` holds, `ms` pass or `signal` aborts. Resolves whether it held. */
  private until(check: () => boolean, ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      let finished = false;
      const done = (value: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.watchers.delete(run);
        resolve(value);
      };
      const run = () => {
        if (check()) done(true);
      };
      const onAbort = () => done(false);
      const timer = Number.isFinite(ms) ? setTimeout(() => done(false), ms) : undefined;
      signal.addEventListener('abort', onAbort, { once: true });
      this.watchers.add(run);
      if (signal.aborted) done(false);
      else run();
    });
  }

  private dispatch(method: string, params: Params, signal: AbortSignal): unknown {
    switch (method) {
      case 'getMe':
        return this.botUser();
      case 'deleteWebhook':
        this.webhookRemoved = true;
        return true;
      case 'setMyCommands':
        this.commandList = (
          (params['commands'] as { command: string; description: string }[] | undefined) ?? []
        ).map(({ command, description }) => ({ command, description }));
        return true;
      case 'getUpdates':
        return this.getUpdates(params, signal);
      case 'sendMessage':
        return this.sendMessage(params);
      case 'editMessageText':
        return this.editMessage(params, true);
      case 'editMessageReplyMarkup':
        return this.editMessage(params, false);
      case 'answerCallbackQuery':
        return this.answerCallbackQuery(params);
      default:
        throw new ApiFailure(404, 'Not Found');
    }
  }

  private botUser() {
    return {
      id: this.botId,
      is_bot: true,
      first_name: 'Wallet',
      username: this.username,
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    };
  }

  private async getUpdates(params: Params, signal: AbortSignal): Promise<Update[]> {
    const offset = typeof params['offset'] === 'number' ? params['offset'] : undefined;
    if (offset !== undefined) {
      // A later offset confirms every update below it: Telegram forgets them.
      this.confirmedThrough = Math.max(this.confirmedThrough, offset - 1);
      this.updates = this.updates.filter((update) => update.update_id >= offset);
      this.changed();
    }
    const limit = Math.min(Math.max(Number(params['limit'] ?? 100) || 100, 1), 100);
    const timeout = Number(params['timeout'] ?? 0) || 0;
    const take = () => this.updates.slice(0, limit);

    if (this.singlePoller) {
      // Telegram ends the long poll that is held when another one arrives.
      for (const other of this.held) if (other.poll) other.terminated = true;
      this.changed();
    }
    if (take().length > 0 || timeout <= 0) return take();

    const me: Held = { poll: true, terminated: false };
    this.held.add(me);
    this.changed();
    try {
      await this.until(
        () =>
          take().length > 0 ||
          me.terminated ||
          this.closed ||
          this.rules.some((rule) => rule.method === 'getUpdates' || rule.method === '*'),
        timeout * 1000,
        signal,
      );
    } finally {
      this.held.delete(me);
      this.changed();
    }
    if (me.terminated) throw new ApiFailure(409, DEFAULT_DESCRIPTION[409] ?? 'Conflict');
    // A failure that was installed while the call was held answers it, as it would the next call.
    const rule = this.takeRule('getUpdates', params);
    if (rule) {
      const failure =
        rule.failure === 'network'
          ? { status: 502, description: 'Bad Gateway', parameters: undefined }
          : rule.failure;
      throw new ApiFailure(failure.status, failure.description, failure.parameters);
    }
    return take();
  }

  private chatOf(params: Params): ChatState {
    const id = Number(params['chat_id']);
    const chat = this.chats.get(id);
    if (!chat) throw new ApiFailure(400, 'Bad Request: chat not found');
    if (this.blockedChats.has(id))
      throw new ApiFailure(403, 'Forbidden: bot was blocked by the user');
    return chat;
  }

  /** The text of a message, as the chat shows it, or a 400 for formatting Telegram cannot parse. */
  private renderText(params: Params): {
    html: string;
    text: string;
    parseMode: string | undefined;
  } {
    const html = typeof params['text'] === 'string' ? params['text'] : '';
    if (html === '') throw new ApiFailure(400, 'Bad Request: message text is empty');
    const parseMode = typeof params['parse_mode'] === 'string' ? params['parse_mode'] : undefined;
    let text = html;
    if (parseMode === 'HTML') {
      const rendered = renderTelegramHtml(html);
      if ('error' in rendered) throw new ApiFailure(400, `Bad Request: ${rendered.error}`);
      text = rendered.text;
    }
    if (Array.from(text).length > MESSAGE_MAX_CHARS)
      throw new ApiFailure(400, 'Bad Request: message is too long');
    return { html, text, parseMode };
  }

  private sendMessage(params: Params) {
    const chat = this.chatOf(params);
    const { html, text, parseMode } = this.renderText(params);
    const keyboard = readKeyboard(params['reply_markup']);
    const message: Stored = {
      id: chat.nextMessageId++,
      chatId: chat.spec.id,
      html,
      parseMode,
      text,
      keyboard,
      edits: 0,
      touched: ++this.seq,
    };
    chat.bot.push(message);
    this.changed();
    return this.messageJson(chat, message);
  }

  private editMessage(params: Params, withText: boolean) {
    const chat = this.chatOf(params);
    const id = Number(params['message_id']);
    const message = chat.bot.find((candidate) => candidate.id === id);
    if (!message) throw new ApiFailure(400, 'Bad Request: message to edit not found');
    // Without `reply_markup` an edit takes the keyboard away, as it does in Telegram.
    const keyboard = readKeyboard(params['reply_markup']);
    const next = withText
      ? this.renderText(params)
      : { html: message.html, text: message.text, parseMode: message.parseMode };
    if (next.html === message.html && sameKeyboard(keyboard, message.keyboard)) {
      throw new ApiFailure(
        400,
        'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
      );
    }
    message.html = next.html;
    message.text = next.text;
    message.parseMode = next.parseMode;
    message.keyboard = keyboard;
    message.edits += 1;
    message.touched = ++this.seq;
    this.changed();
    return this.messageJson(chat, message);
  }

  private answerCallbackQuery(params: Params): true {
    const id = String(params['callback_query_id'] ?? '');
    const query = this.queries.get(id);
    if (!query || query.answered) {
      throw new ApiFailure(
        400,
        'Bad Request: query is too old and response timeout expired or query ID is invalid',
      );
    }
    query.answered = true;
    this.toastLog.push({
      queryId: id,
      text: typeof params['text'] === 'string' ? params['text'] : undefined,
    });
    this.changed();
    return true;
  }

  private messageJson(chat: ChatState, message: Stored) {
    return {
      message_id: message.id,
      from: this.botUser(),
      chat: chatJson(chat.spec),
      date: Math.floor(Date.now() / 1000),
      text: message.text,
    };
  }
}

function chatJson(spec: ChatSpec) {
  return { id: spec.id, type: spec.type, ...(spec.title ? { title: spec.title } : {}) };
}

async function readParams(req: IncomingMessage): Promise<Params> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');
  if (body.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Params) : {};
  } catch {
    return {};
  }
}

// --- A person in a chat -------------------------------------------------------------------------

export interface TapOptions {
  /** Look only on this message (or the one with this id). Default: the latest message that has the button. */
  on?: BotMessage | number;
  /** Do not wait for the bot to handle the tap. */
  wait?: boolean;
  timeoutMs?: number;
}

/**
 * Somebody typing and tapping in one chat with the bot. Everything the bot sent to that chat is read
 * from the fake's state, so `lastMessage()` is "what this person sees at the bottom of the chat".
 */
export class ChatUser {
  constructor(
    private readonly fake: FakeTelegram,
    readonly person: Person,
    readonly chat: ChatSpec,
  ) {}

  private get state(): ChatState {
    return this.fake.chatState(this.chat);
  }

  private from() {
    return {
      id: this.person.id,
      is_bot: false,
      first_name: this.person.first_name,
      ...(this.person.username ? { username: this.person.username } : {}),
      language_code: 'en',
    };
  }

  /**
   * Sends a message. A text that starts with a command carries the `bot_command` entity Telegram adds.
   * Resolves once the bot has handled it (unless `wait: false`).
   */
  async say(text: string, options: { wait?: boolean; timeoutMs?: number } = {}): Promise<void> {
    const chat = this.state;
    const command = text.startsWith('/') ? (/^\S+/.exec(text)?.[0] ?? '') : '';
    const updateId = this.fake.queue((update_id) => ({
      update_id,
      message: {
        message_id: chat.nextMessageId++,
        from: this.from(),
        chat: chatJson(this.chat),
        date: Math.floor(Date.now() / 1000),
        text,
        ...(command === ''
          ? {}
          : { entities: [{ type: 'bot_command', offset: 0, length: command.length }] }),
      },
    }));
    if (options.wait !== false)
      await this.fake.handled(updateId, options.timeoutMs ?? DEFAULT_WAIT_MS);
  }

  /**
   * Taps a button of the chat. The button is found by its label: a string is matched whole first, and
   * else as a part of the label when exactly one button has it; a RegExp is tested on the label. The
   * message searched is the one most recently sent or changed that has such a button.
   */
  async tap(label: string | RegExp, options: TapOptions = {}): Promise<void> {
    const { message, button } = this.find(label, options.on);
    if (button.data === null) {
      throw new Error(
        `The button "${button.text}" is a link (${button.url ?? ''}), it cannot be tapped`,
      );
    }
    await this.tapData(button.data, message.id, options);
  }

  /**
   * Sends the tap of a button by its `callback_data`, from the message `messageId`. A button that is
   * not on the screen any more (the message was edited since) can still be tapped this way, as the
   * client of a person who had not refreshed would.
   */
  async tapData(
    data: string,
    messageId: number,
    options: { wait?: boolean; timeoutMs?: number } = {},
  ): Promise<void> {
    const stored = this.state.bot.find((candidate) => candidate.id === messageId);
    const queryId = this.fake.newQueryId();
    const updateId = this.fake.queue((update_id) => ({
      update_id,
      callback_query: {
        id: queryId,
        from: this.from(),
        chat_instance: `instance-${this.chat.id}`,
        data,
        message: {
          message_id: messageId,
          from: {
            id: this.fake.botId,
            is_bot: true,
            first_name: 'Wallet',
            username: this.fake.username,
          },
          chat: chatJson(this.chat),
          date: Math.floor(Date.now() / 1000),
          text: stored?.text ?? '',
        },
      },
    }));
    if (options.wait !== false)
      await this.fake.handled(updateId, options.timeoutMs ?? DEFAULT_WAIT_MS);
  }

  /** Every message the bot sent to this chat, in the order sent, as the chat shows them now. */
  messages(): BotMessage[] {
    return this.state.bot.map((message) => this.fake.view(message));
  }

  texts(): string[] {
    return this.messages().map((message) => message.text);
  }

  /** The newest message the bot sent to this chat. Throws when it sent none. */
  lastMessage(): BotMessage {
    const message = this.state.bot.at(-1);
    if (!message) throw new Error(`The bot has sent nothing to chat ${this.chat.id} yet`);
    return this.fake.view(message);
  }

  /** The newest message, or the one with this id, as it is now (after edits). */
  message(id: number): BotMessage {
    const message = this.state.bot.find((candidate) => candidate.id === id);
    if (!message) throw new Error(`Chat ${this.chat.id} has no message ${id}`);
    return this.fake.view(message);
  }

  /** The buttons of the latest message that has a keyboard, flat, or `[]`. */
  buttons(): ButtonView[] {
    const message = [...this.state.bot]
      .reverse()
      .find((candidate) => candidate.keyboard.length > 0);
    return message ? message.keyboard.flat().map((button) => ({ ...button })) : [];
  }

  /**
   * Resolves with the newest message of this chat that matches (messages already there count, and a
   * message that is edited into a match too), or fails with what the chat shows.
   */
  waitForMessage(
    predicate: (message: BotMessage) => boolean,
    timeoutMs = DEFAULT_WAIT_MS,
  ): Promise<BotMessage> {
    return this.fake.waitFor(
      'a message of the bot that matches',
      () => {
        const found = [...this.state.bot]
          .reverse()
          .find((candidate) => predicate(this.fake.view(candidate)));
        return found ? this.fake.view(found) : undefined;
      },
      timeoutMs,
      () =>
        `The chat shows:\n${
          this.texts()
            .map((text) => `  - ${text.replace(/\n/g, ' / ')}`)
            .join('\n') || '  (nothing)'
        }`,
    );
  }

  /** The text of the first message of the chat that contains `text` (a string or a pattern). */
  waitForText(text: string | RegExp, timeoutMs = DEFAULT_WAIT_MS): Promise<BotMessage> {
    return this.waitForMessage(
      (message) =>
        typeof text === 'string' ? message.text.includes(text) : text.test(message.text),
      timeoutMs,
    );
  }

  private find(
    label: string | RegExp,
    on?: BotMessage | number,
  ): { message: BotMessage; button: ButtonView } {
    const onId = typeof on === 'number' ? on : on?.id;
    const candidates = [...this.state.bot]
      .filter((message) => onId === undefined || message.id === onId)
      .sort((a, b) => b.touched - a.touched);
    const shown: string[] = [];
    for (const stored of candidates) {
      const buttons = stored.keyboard.flat();
      if (buttons.length === 0) continue;
      shown.push(...buttons.map((button) => button.text));
      let matches: ButtonView[];
      if (typeof label === 'string') {
        matches = buttons.filter((button) => button.text === label);
        if (matches.length === 0) matches = buttons.filter((button) => button.text.includes(label));
      } else {
        matches = buttons.filter((button) => label.test(button.text));
      }
      if (matches.length > 1) {
        throw new Error(
          `${matches.length} buttons match ${String(label)} on message ${stored.id}: ${matches.map((m) => `"${m.text}"`).join(', ')}`,
        );
      }
      const button = matches[0];
      if (button) return { message: this.fake.view(stored), button: { ...button } };
    }
    throw new Error(
      `No button ${String(label)} in the chat. The keyboards show: ${shown.map((text) => `"${text}"`).join(' | ') || '(no keyboard)'}`,
    );
  }
}
