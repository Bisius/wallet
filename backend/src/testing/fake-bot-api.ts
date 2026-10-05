/**
 * A fake Telegram Bot API for the tests of the bot: no network. It is an API transformer (grammY's
 * way to wrap every call), installed closest to the network, that records each call and answers it,
 * so `bot.handleUpdate()` and the polling loop both run for real against it.
 *
 * - Every call is recorded in `calls` (method and payload, with `parse_mode` already defaulted).
 * - `sendMessage` answers a message with a fresh id, `getMe` answers `me`, `getUpdates` is a real
 *   long poll over the updates given to `push()` (they stay until a later `offset` confirms them),
 *   and every other method answers `true`.
 * - `answerOnce` / `answerAlways` change one method's answer: a result, a `botApiError(...)` for a
 *   Telegram error, or a function that returns one of those or throws (a network error).
 */
import { HttpError, type Transformer } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';

export interface RecordedCall {
  method: string;
  payload: Record<string, unknown>;
}

/** A Telegram error answer (`ok: false`): what a handler returns to make grammY throw a `GrammyError`. */
export interface BotApiError {
  readonly __botApiError: true;
  code: number;
  description: string;
  parameters: Record<string, unknown>;
}

export const botApiError = (
  code: number,
  description: string,
  parameters: Record<string, unknown> = {},
): BotApiError => ({ __botApiError: true, code, description, parameters });

/** The error grammY throws when the request itself fails; its inner error names the URL, so the token. */
export function networkError(method: string, url: string): HttpError {
  return new HttpError(
    `Network request for '${method}' failed!`,
    new Error(`request to ${url} failed, reason: connect ECONNREFUSED 149.154.167.220:443`),
  );
}

export type FakeAnswer =
  unknown | ((payload: Record<string, unknown>, signal: AbortSignal | undefined) => unknown);

const abortError = () =>
  Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

export class FakeBotApi {
  readonly calls: RecordedCall[] = [];
  /** The highest update id that a later `offset` confirmed. */
  confirmedThrough = 0;
  readonly me: UserFromGetMe;

  private readonly once = new Map<string, FakeAnswer[]>();
  private readonly always = new Map<string, FakeAnswer>();
  private pending: Update[] = [];
  private waiting: (() => void)[] = [];
  private nextMessageId = 1000;

  constructor(username = 'wallet_test_bot') {
    this.me = {
      id: 999_000_111,
      is_bot: true,
      first_name: 'Wallet',
      username,
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    };
  }

  readonly transformer: Transformer = async (_prev, method, payload, signal) => {
    const params = { ...(payload as Record<string, unknown>) };
    this.calls.push({ method, payload: params });
    // grammY types its signals with the `abort-controller` package; they are standard signals at runtime.
    const result = await this.answer(method, params, signal as unknown as AbortSignal | undefined);
    const response =
      typeof result === 'object' && result !== null && '__botApiError' in result
        ? {
            ok: false as const,
            error_code: (result as BotApiError).code,
            description: (result as BotApiError).description,
            parameters: (result as BotApiError).parameters,
          }
        : { ok: true as const, result };
    return response as never;
  };

  /** The next call of `method` gets `answer`; after that, the usual answer. Several calls queue up. */
  answerOnce(method: string, answer: FakeAnswer): this {
    this.once.set(method, [...(this.once.get(method) ?? []), answer]);
    return this;
  }

  /** Every call of `method` gets `answer` (unless an `answerOnce` is queued). */
  answerAlways(method: string, answer: FakeAnswer): this {
    this.always.set(method, answer);
    return this;
  }

  /** Delivers updates, as if Telegram had received them. Wakes a long poll that is waiting. */
  push(...updates: Update[]): void {
    this.pending.push(...updates);
    for (const wake of this.waiting.splice(0)) wake();
  }

  callsOf(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** The text of every message sent, in order. */
  sentTexts(): string[] {
    return this.callsOf('sendMessage').map((call) => String(call.payload['text']));
  }

  private async answer(
    method: string,
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const queued = this.once.get(method);
    const chosen = queued?.length ? queued.shift() : this.always.get(method);
    if (chosen !== undefined) {
      return typeof chosen === 'function'
        ? (chosen as (p: Record<string, unknown>, s?: AbortSignal) => unknown)(payload, signal)
        : chosen;
    }
    switch (method) {
      case 'getMe':
        return this.me;
      case 'getUpdates':
        return this.getUpdates(payload, signal);
      case 'sendMessage':
        return {
          message_id: this.nextMessageId++,
          date: 0,
          chat: { id: payload['chat_id'], type: 'private' },
          text: payload['text'],
        };
      default:
        return true;
    }
  }

  private async getUpdates(payload: Record<string, unknown>, signal?: AbortSignal) {
    const offset = payload['offset'];
    if (typeof offset === 'number') {
      this.confirmedThrough = Math.max(this.confirmedThrough, offset - 1);
      this.pending = this.pending.filter((update) => update.update_id >= offset);
    }
    if (this.pending.length === 0 && Number(payload['timeout'] ?? 0) > 0) {
      await this.untilPushed(signal);
    }
    return this.pending.slice(0, Number(payload['limit'] ?? 100));
  }

  /** The long poll: resolves when an update arrives, rejects when the caller aborts. */
  private untilPushed(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const onWake = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        this.waiting = this.waiting.filter((wake) => wake !== onWake);
        reject(abortError());
      };
      this.waiting.push(onWake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

// --- Updates ----------------------------------------------------------------------------------

export interface Person {
  id: number;
  first_name: string;
  username?: string;
}

/** The owner, who links in most tests. */
export const OWNER: Person = { id: 4242, first_name: 'Olivia', username: 'olivia' };
/** Somebody who is not linked. */
export const STRANGER: Person = { id: 666, first_name: 'Mallory', username: 'mallory' };

export type ChatType = 'private' | 'group' | 'supergroup' | 'channel';
export interface UpdateOptions {
  from?: Person;
  /** Default: the private chat of `from` (its id is the user's id). */
  chat?: { id: number; type: ChatType };
}

let nextUpdateId = 1;
let nextMessageId = 1;

const chatOf = (from: Person, chat: UpdateOptions['chat']) =>
  chat ?? { id: from.id, type: 'private' as const };

/** A text message. A text that starts with a command carries the `bot_command` entity Telegram adds. */
export function messageUpdate(text: string, { from = OWNER, chat }: UpdateOptions = {}): Update {
  const entities = text.startsWith('/')
    ? [
        {
          type: 'bot_command' as const,
          offset: 0,
          length: text.split(/\s/, 1)[0]?.length ?? text.length,
        },
      ]
    : undefined;
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++,
      date: 0,
      chat: chatOf(from, chat),
      from: { ...from, is_bot: false },
      text,
      entities,
    },
  } as Update;
}

/** A tap on an inline button of a message in the chat. */
export function callbackUpdate(data: string, { from = OWNER, chat }: UpdateOptions = {}): Update {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: `cb${nextUpdateId}`,
      from: { ...from, is_bot: false },
      chat_instance: 'test',
      data,
      message: {
        message_id: nextMessageId++,
        date: 0,
        chat: chatOf(from, chat),
        text: 'earlier message',
      },
    },
  } as Update;
}
