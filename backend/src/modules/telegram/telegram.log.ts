import { GrammyError, HttpError } from 'grammy';
import type { TelegramLog } from './telegram.types';

const PLACEHOLDER = '[redacted]';

/** A bot token as @BotFather makes it: the bot's number, a colon and a secret. */
const TOKEN_SHAPE = /\b\d{5,}:[A-Za-z0-9_-]{20,}/g;
/** The token inside a Bot API URL: `https://api.telegram.org/bot<number>:<secret>/getUpdates`. */
const BOT_URL_SEGMENT = /\/bot\d+:[^/\s"'`]*/g;

/** `text` without the token (also URL-encoded) and without anything shaped like one. */
function scrub(text: string, token: string | undefined): string {
  let out = text;
  if (token) {
    for (const variant of new Set([token, encodeURIComponent(token)])) {
      out = out.split(variant).join(PLACEHOLDER);
    }
  }
  return out.replace(BOT_URL_SEGMENT, `/bot${PLACEHOLDER}`).replace(TOKEN_SHAPE, PLACEHOLDER);
}

/**
 * What an error says, with its chain: grammY's `HttpError` keeps the network error in `.error` (its
 * message holds the URL, so the token), and any error may have a `cause`. A plain error that is
 * logged itself (not one inside another) also gets the top of its stack, which is what finds a bug
 * in a handler.
 */
function describe(error: unknown, depth = 0): string {
  if (depth > 4) return '...';
  if (error instanceof Error) {
    let out = `${error.name}: ${error.message}`;
    const grammy = error instanceof GrammyError || error instanceof HttpError;
    if (!grammy && depth === 0 && error.stack) {
      out += `\n${error.stack.split('\n').slice(1, 6).join('\n')}`;
    }
    const inner = (error as { error?: unknown }).error;
    if (inner !== undefined && inner !== error) out += ` [${describe(inner, depth + 1)}]`;
    if (error.cause !== undefined) out += ` (cause: ${describe(error.cause, depth + 1)})`;
    return out;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * The text of whatever was thrown, safe to log: `token` (and its URL-encoded form), a Bot API URL's
 * token and anything shaped like a token are replaced by `[redacted]`. EVERY error that the module
 * logs goes through it (`createTelegramLog` does it), and so does every message that is shown to a
 * client. `token` is undefined only where there is none to hide.
 */
export function redact(value: unknown, token: string | undefined): string {
  return scrub(describe(value), token);
}

/**
 * The module's log: one line per call, written to `sink` (the console), prefixed with "Telegram: ".
 * The sink receives strings only, so nothing is left for the console to print as an object.
 */
export function createTelegramLog(
  token: string | undefined,
  sink: Pick<Console, 'log' | 'error'> = console,
): TelegramLog {
  return {
    info: (message) => sink.log(scrub(`Telegram: ${message}`, token)),
    error: (message, error) =>
      sink.error(
        scrub(`Telegram: ${message}${error === undefined ? '' : `: ${describe(error)}`}`, token),
      ),
  };
}
