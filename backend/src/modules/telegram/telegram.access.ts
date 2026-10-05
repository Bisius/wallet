/**
 * Who the bot talks to (docs/DOMAIN.md, "Linking and access"): the link to ONE Telegram account, the
 * one-time pairing code, and the sender guard that every update passes before any handler sees it.
 *
 * The link and the code live in the database, so the routes and the bot share one source of truth and
 * a restart or a restored backup loses neither. The guard reads the link on every update, so
 * `DELETE /api/telegram/link` takes effect at once.
 */
import type { TelegramLinkDto } from '@wallet/shared';
import { eq } from 'drizzle-orm';
import type { Context } from 'grammy';
import { randomInt } from 'node:crypto';
import type { DbOrTx } from '../../db/client';
import { telegramLink, telegramPairing } from '../../db/schema';
import { type Deps, inTransaction } from '../../lib/deps';
import { timestampOf } from '../../lib/today';
import { INVALID_CODE_TEXT, NO_LONGER_LINKED_TEXT, linkGreeting } from './telegram.messages';
import type { TelegramBot, TelegramContext } from './telegram.types';

/** The alphabet of a pairing code: the letters and digits without the look-alikes 0, O, 1 and I. */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 8;
/** A code is valid for 10 minutes. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;
/** The pending code is cancelled at this many wrong codes, from any senders. */
export const PAIRING_MAX_FAILED_ATTEMPTS = 5;

/** Both tables hold one row, with this id. */
const SINGLETON_ID = 1;

export type TelegramLinkRow = typeof telegramLink.$inferSelect;
export type TelegramPairingRow = typeof telegramPairing.$inferSelect;

/** A new code: 8 characters drawn with `crypto.randomInt`, each from the 32-character alphabet. */
export function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_CODE_ALPHABET.charAt(randomInt(PAIRING_CODE_ALPHABET.length));
  }
  return code;
}

// --- The link ---------------------------------------------------------------------------------

/** The linked account, or null. */
export function findLink(db: DbOrTx): TelegramLinkRow | null {
  return db.select().from(telegramLink).where(eq(telegramLink.id, SINGLETON_ID)).get() ?? null;
}

export function toLinkDto(row: TelegramLinkRow): TelegramLinkDto {
  return { name: row.firstName, username: row.username, linkedAt: row.linkedAt };
}

/** Removes the link and returns what it was, or null when nothing was linked. Keeps the preferences. */
export function removeLink(db: DbOrTx): TelegramLinkRow | null {
  const removed = db
    .delete(telegramLink)
    .where(eq(telegramLink.id, SINGLETON_ID))
    .returning()
    .all();
  return removed[0] ?? null;
}

// --- The pairing code -------------------------------------------------------------------------

/** The open code, expired or not (the bot answers to it until it is used, replaced or cancelled). */
export function findPairing(db: DbOrTx): TelegramPairingRow | null {
  return (
    db.select().from(telegramPairing).where(eq(telegramPairing.id, SINGLETON_ID)).get() ?? null
  );
}

/** Whether `pairing` can still link: its expiry is in the future of the clock. */
export function isPairingLive(
  { clock }: Pick<Deps, 'clock'>,
  pairing: TelegramPairingRow,
): boolean {
  return Date.parse(pairing.expiresAt) > clock.now().getTime();
}

/** A new code that replaces the open one (and its count of wrong tries). */
export function createPairing({ db, clock }: Deps): TelegramPairingRow {
  const values = {
    id: SINGLETON_ID,
    code: generatePairingCode(),
    expiresAt: new Date(clock.now().getTime() + PAIRING_TTL_MS).toISOString(),
    failedAttempts: 0,
  };
  return db
    .insert(telegramPairing)
    .values(values)
    .onConflictDoUpdate({ target: telegramPairing.id, set: values })
    .returning()
    .get();
}

/** Cancels the open code. Does nothing when there is none. */
export function cancelPairing(db: DbOrTx): void {
  db.delete(telegramPairing).where(eq(telegramPairing.id, SINGLETON_ID)).run();
}

/** Who sent a code. */
export interface PairingSender {
  userId: number;
  chatId: number;
  firstName: string;
  username: string | null;
}

export type PairingResult =
  /** The code was right: the sender is linked now. `previous` is the link it replaced, if any. */
  | { outcome: 'linked'; link: TelegramLinkRow; previous: TelegramLinkRow | null }
  /** A code is open and this was not it (wrong, or right but expired): counted, the bot answers. */
  | { outcome: 'invalid' }
  /** No code is open: nothing happens, and the bot says nothing. */
  | { outcome: 'closed' };

/**
 * `/start <payload>` from a private chat. All in one transaction: a right code links the sender
 * (replacing a link) and is used up; a wrong code, or the right one after it expired, counts as a
 * failed attempt, and the fifth cancels the code.
 */
export function tryPairing(deps: Deps, sender: PairingSender, payload: string): PairingResult {
  return inTransaction(deps, ({ db, clock }) => {
    const pairing = findPairing(db);
    if (!pairing) return { outcome: 'closed' };

    if (payload.trim().toUpperCase() !== pairing.code || !isPairingLive({ clock }, pairing)) {
      const failed = pairing.failedAttempts + 1;
      if (failed >= PAIRING_MAX_FAILED_ATTEMPTS) cancelPairing(db);
      else
        db.update(telegramPairing)
          .set({ failedAttempts: failed })
          .where(eq(telegramPairing.id, SINGLETON_ID))
          .run();
      return { outcome: 'invalid' };
    }

    const previous = findLink(db);
    const values = {
      userId: sender.userId,
      chatId: sender.chatId,
      firstName: sender.firstName,
      username: sender.username,
      linkedAt: timestampOf(clock),
    };
    const link = db
      .insert(telegramLink)
      .values({ id: SINGLETON_ID, ...values })
      .onConflictDoUpdate({ target: telegramLink.id, set: values })
      .returning()
      .get();
    cancelPairing(db);
    return { outcome: 'linked', link, previous };
  });
}

// --- The guard --------------------------------------------------------------------------------

/** The payload of `/start <payload>`, or undefined for a message that is anything else. */
export function startPayload(text: string | undefined): string | undefined {
  const match = text === undefined ? null : /^\/start(?:@\w+)?[ \t]+(\S[\s\S]*)$/.exec(text.trim());
  return match?.[1];
}

/**
 * The first middleware of the bot. EVERY update (a message or a button tap) passes it, and only two
 * kinds get further:
 *
 * - `/start <code>` in a private chat is a pairing attempt, from anyone: the right code links the
 *   sender and greets them, a wrong one is answered "Invalid or expired code." while a code is open.
 * - anything else goes on to the handlers only when it comes from the linked user (`from.id`) in a
 *   private chat.
 *
 * Everything else is dropped WITHOUT A REPLY, and without even answering a button, so a stranger
 * cannot tell what the bot is. A group, a supergroup or a channel never links and never counts as a
 * wrong code.
 */
export function registerAccess(bot: TelegramBot, tg: TelegramContext): void {
  bot.use(async (ctx, next) => {
    const { from, chat } = ctx;
    if (!from || from.is_bot || !chat || chat.type !== 'private') return;

    const link = findLink(tg.db);
    const isOwner = link !== null && link.userId === from.id;

    const payload = startPayload(ctx.message?.text);
    if (payload !== undefined) {
      const result = tryPairing(
        tg,
        {
          userId: from.id,
          chatId: chat.id,
          firstName: from.first_name,
          username: from.username ?? null,
        },
        payload,
      );
      if (result.outcome === 'linked') {
        await greet(tg, ctx, result);
        return;
      }
      if (result.outcome === 'invalid') {
        await ctx.reply(INVALID_CODE_TEXT);
        return;
      }
      // No code is open: a stranger gets nothing, and the owner gets `/start` as `/help`.
    }

    if (!isOwner) return;
    await next();
  });
}

/** After a link: the baseline, the greeting, and the notice to the chat that was replaced. */
async function greet(
  tg: TelegramContext,
  ctx: Context,
  { link, previous }: Extract<PairingResult, { outcome: 'linked' }>,
): Promise<void> {
  try {
    tg.notify.recordBaseline();
  } catch (error) {
    // The link is made; a baseline that failed means the first check may announce old levels.
    tg.log.error('could not record the alert baseline', error);
  }
  await ctx.reply(linkGreeting(link.firstName));
  if (previous && previous.chatId !== link.chatId) {
    await ctx.api.sendMessage(previous.chatId, NO_LONGER_LINKED_TEXT).catch((error: unknown) => {
      tg.log.error('could not tell the previous chat that it was unlinked', error);
    });
  }
}
