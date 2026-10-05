/**
 * Helpers for the tests of the recording flows (T2): a bot over an in-memory database that is
 * ONBOARDED and has budgets, an Express app over the SAME database and clock (so a test can compare
 * what the bot printed with `GET /api/months/...`, or delete a spending "on the web"), and a small
 * reader of what the fake Bot API saw, so that a test types text and taps buttons by their label,
 * like a person does.
 *
 *   const h = await createRecordingHarness();
 *   await h.say('/spending');
 *   await h.tapButton('🛒 Groceries · €300.00');   // or a RegExp
 *   expect(h.screen().text).toContain('How much?');
 *
 * `screen()` is what the user sees last: the text of the latest message sent or edited, and the
 * buttons of the latest call that set a keyboard.
 */
import type { BudgetDto, BudgetCreateInput, MonthView } from '@wallet/shared';
import type { InlineKeyboardMarkup } from 'grammy/types';
import request from 'supertest';
import { createApp } from '../app';
import { type RecordedCall } from './fake-bot-api';
import { addBudget, onboard } from './helpers';
import { findIncome, findSpending, fingerprintOf } from '../modules/telegram/telegram.entries';
import { OWNER, createBotHarness } from './telegram-harness';

export interface ScreenButton {
  text: string;
  data: string;
}

export interface Screen {
  text: string;
  /** The rows of the keyboard on the screen ([] when it has none). */
  rows: ScreenButton[][];
}

const buttonsOf = (markup: unknown): ScreenButton[][] =>
  ((markup as InlineKeyboardMarkup | undefined)?.inline_keyboard ?? []).map((row) =>
    row.map((button) => ({
      text: button.text,
      data: 'callback_data' in button ? button.callback_data : '',
    })),
  );

/** What the user sees after `calls`: the latest text and the latest keyboard. */
export function screenOf(calls: readonly RecordedCall[]): Screen {
  let text = '';
  let rows: ScreenButton[][] = [];
  for (const { method, payload } of calls) {
    if (method === 'sendMessage' || method === 'editMessageText') {
      text = String(payload['text']);
      rows = buttonsOf(payload['reply_markup']);
    } else if (method === 'editMessageReplyMarkup') {
      rows = buttonsOf(payload['reply_markup']);
    }
  }
  return { text, rows };
}

export interface RecordingOptions {
  /** Default 2026-10-05T10:00:00Z, a Monday: "Mon 5 Oct" as in docs/DOMAIN.md. */
  now?: string;
  locale?: string;
  startMonth?: string;
  salary?: number;
  appUrl?: string;
  /** Budgets to create, in order. Default: Groceries, Eating out, Fuel. */
  budgets?: Partial<BudgetCreateInput>[];
}

/** Groceries 300.00, Eating out 200.00, Fuel 100.00 (carries over): what the stories use. */
export const DEFAULT_BUDGETS: Partial<BudgetCreateInput>[] = [
  { name: 'Groceries', amount: 30000, incremental: false, icon: '🛒', startMonth: '2026-01' },
  { name: 'Eating out', amount: 20000, incremental: false, icon: '🍝', startMonth: '2026-01' },
  { name: 'Fuel', amount: 10000, incremental: true, icon: '⛽', startMonth: '2026-01' },
];

/**
 * The bot linked to OWNER, over an onboarded database with budgets, and the HTTP app over the same
 * database and clock.
 */
export async function createRecordingHarness(options: RecordingOptions = {}) {
  const harness = createBotHarness({
    now: options.now ?? '2026-10-05T10:00:00Z',
    linked: OWNER,
    appUrl: options.appUrl,
  });
  const app = createApp({
    db: harness.db,
    clock: harness.clock,
    config: { env: 'test', staticDir: undefined },
  });
  await onboard(app, {
    currency: 'EUR',
    locale: options.locale ?? 'en-GB',
    startMonth: options.startMonth ?? '2026-01',
    salary: options.salary ?? 300000,
    openingSavings: 0,
  });
  const budgets: BudgetDto[] = [];
  for (const budget of options.budgets ?? DEFAULT_BUDGETS)
    budgets.push(await addBudget(app, budget));
  const byName = (name: string): BudgetDto => {
    const found = budgets.find((budget) => budget.name === name);
    if (!found) throw new Error(`no budget called ${name}`);
    return found;
  };

  /** Where a call count starts: `since(mark)` is what happened after it. */
  const mark = (): number => harness.fake.calls.length;

  const recording = {
    ...harness,
    app,
    budgets,
    budget: byName,
    mark,
    /** The calls the fake Bot API saw after `mark`. */
    since: (from: number): RecordedCall[] => harness.fake.calls.slice(from),
    /** What the user sees now, or after `from` (a `mark`) when the test only wants what is new. */
    screen: (from = 0): Screen => screenOf(harness.fake.calls.slice(from)),
    /** The text of the last toast (`answerCallbackQuery`), or undefined. */
    toast: (from = 0): string | undefined =>
      harness.fake.calls
        .slice(from)
        .filter((call) => call.method === 'answerCallbackQuery')
        .map((call) => call.payload['text'] as string | undefined)
        .at(-1),
    /** Taps the button of the screen with this label (or matching this pattern). */
    tapButton: async (label: string | RegExp): Promise<void> => {
      const buttons = screenOf(harness.fake.calls).rows.flat();
      const found = buttons.find((button) =>
        typeof label === 'string' ? button.text === label : label.test(button.text),
      );
      if (!found) {
        throw new Error(
          `no button ${String(label)} on the screen; it has: ${buttons.map((b) => b.text).join(' | ') || '(none)'}`,
        );
      }
      await harness.tap(found.data);
    },
    /**
     * The fingerprint the buttons of a stored row carry (`u:s:<id>:<fp>`): for a test that taps the
     * button of a row it did not get from a confirmation. The row must exist.
     */
    fp: (kind: 's' | 'i', id: number): string => {
      const row = kind === 's' ? findSpending(harness.db, id) : findIncome(harness.db, id);
      if (!row) throw new Error(`no ${kind === 's' ? 'spending' : 'income'} ${id}`);
      return fingerprintOf(row.createdAt);
    },
    /** The month view as the web app gets it. */
    monthView: async (month: string): Promise<MonthView> =>
      (await request(app).get(`/api/months/${month}`).expect(200)).body as MonthView,
  };
  return recording;
}

export type RecordingHarness = Awaited<ReturnType<typeof createRecordingHarness>>;
