/**
 * The state of the conversations (docs/DOMAIN.md, "Flow state" and "Commands, cancel and stray
 * input"): one flow per chat, a 15-minute timeout counted from the last step, stale buttons, text
 * and commands that end a flow, `/cancel`, and what happens when a handler fails.
 */
import type { SpendingsPage } from '@wallet/shared';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { OWNER, STRANGER, callbackUpdate, messageUpdate } from '../../testing/fake-bot-api';
import { mutableClock } from '../../testing/helpers';
import { createBotHarness } from '../../testing/telegram-harness';
import { type RecordingHarness, createRecordingHarness } from '../../testing/telegram-flow-helpers';
import { FLOW_TIMEOUT_MS, createFlowStore, randomFlowId } from './telegram.flows.state';
import {
  CANCELLED_TEXT,
  NOT_ONBOARDED_TEXT,
  NOTHING_TO_CANCEL_TEXT,
  PREVIOUS_ENTRY_CANCELLED_TEXT,
  SOMETHING_WENT_WRONG_TEXT,
  STALE_BUTTON_TEXT,
  UNKNOWN_INPUT_TEXT,
} from './telegram.messages';

const MINUTE = 60_000;
const spendingsOf = async (h: RecordingHarness) =>
  ((await request(h.app).get('/api/spendings').expect(200)).body as SpendingsPage).items;
const stripped = (h: RecordingHarness, from: number) =>
  h.since(from).filter((call) => call.method === 'editMessageReplyMarkup');

describe('the timeout', () => {
  it('is 15 minutes', () => {
    expect(FLOW_TIMEOUT_MS).toBe(15 * MINUTE);
  });

  it('keeps a flow alive just under 15 minutes after its last step, and drops it at 15', () => {
    const clock = mutableClock('2026-10-05T10:00:00Z');
    const store = createFlowStore(clock);
    const flow = {
      id: 'abc12',
      kind: 'spending' as const,
      chatId: 1,
      step: 'amount' as const,
      touchedAt: clock.now().getTime(),
      promptMessageId: undefined,
    };
    store.put(flow);
    clock.set('2026-10-05T10:14:59Z');
    expect(store.get(1)).toBe(flow);
    store.touch(flow); // a step: the timeout starts again
    clock.set('2026-10-05T10:29:58Z');
    expect(store.get(1)).toBe(flow);
    clock.set('2026-10-05T10:29:59Z');
    expect(store.get(1)).toBeUndefined();
    expect(store.get(1)).toBeUndefined(); // and it stays gone
  });

  it('counts from the LAST step: a slow conversation of several steps is not cut off', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    h.clock.set('2026-10-05T10:14:00Z');
    await h.tapButton(/Groceries/);
    h.clock.set('2026-10-05T10:28:00Z'); // 28 minutes after the start, 14 after the last step
    await h.say('5 lunch');
    h.clock.set('2026-10-05T10:42:00Z');
    await h.tapButton('Today');
    expect(h.screen().text).toContain('✅ €5.00 · Groceries · lunch');
  });

  it('answers a button of an expired flow with the "expired" toast and removes its keyboard', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    const budget = h.screen().rows[0]?.[0];
    h.clock.set('2026-10-05T10:15:00Z');
    const mark = h.mark();
    await h.tap(budget?.data ?? '');
    expect(h.toast(mark)).toBe(STALE_BUTTON_TEXT);
    expect(stripped(h, mark)[0]?.payload['reply_markup']).toEqual({ inline_keyboard: [] });
    expect(await spendingsOf(h)).toEqual([]);
  });

  it('forgets an expired flow: the amount typed after it is a quick entry, not an answer', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton(/Groceries/);
    h.clock.set('2026-10-05T10:20:00Z');
    await h.say('23,40');
    expect(h.screen().text).toBe('€23.40. Which budget?');
  });
});

describe('stale buttons', () => {
  it('answers a button of a finished flow with the toast and takes the keyboard away', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    const budgets = h.screen().rows.flat();
    await h.tapButton(/Groceries/);
    await h.say('5 lunch');
    await h.tapButton('Today');
    const mark = h.mark();
    await h.tap(budgets[1]?.data ?? ''); // the budget list of a flow that is over
    expect(h.toast(mark)).toBe('This entry expired, start again with /spending');
    expect(stripped(h, mark)).toHaveLength(1);
    expect(await spendingsOf(h)).toHaveLength(1); // and nothing more was saved
  });

  it('answers the buttons of a flow that was replaced by a new one', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    const old = h.screen().rows[0]?.[0];
    await h.say('/spending');
    const fresh = h.screen().rows[0]?.[0];
    expect(fresh?.data).not.toBe(old?.data);
    const mark = h.mark();
    await h.tap(old?.data ?? '');
    expect(h.toast(mark)).toBe(STALE_BUTTON_TEXT);
    // The new flow is untouched: its own button still works.
    await h.tap(fresh?.data ?? '');
    expect(h.screen().text).toContain('How much?');
  });

  it('treats a button of the wrong step as stale (the date button while waiting for the amount)', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton(/Groceries/);
    const flowId = h.fake.callsOf('sendMessage')[0]; // the budget list, to read the flow id
    const budgetData = (
      flowId?.payload['reply_markup'] as { inline_keyboard: { callback_data: string }[][] }
    ).inline_keyboard[0]?.[0]?.callback_data;
    const id = budgetData?.split(':')[1];
    const mark = h.mark();
    await h.tap(`f:${id}:d:2026-10-05`);
    expect(h.toast(mark)).toBe(STALE_BUTTON_TEXT);
    expect(await spendingsOf(h)).toEqual([]);
    await h.say('5 x'); // the flow is where it was
    expect(h.screen().text).toBe('€5.00 · Groceries · x\nWhen?');
  });

  it.each([
    'f:zzzzz:b:1',
    'f:abc',
    'f:abc:b:x',
    'x:y',
    's:gone:1',
    'u:s:0',
    'c:s:1:2026-13-45',
    '',
    'k:1',
  ])('treats the unknown data %j as a stale button and does nothing else', async (data) => {
    const h = await createRecordingHarness();
    const mark = h.mark();
    await h.tap(data);
    expect(h.toast(mark)).toBe(STALE_BUTTON_TEXT);
    expect(h.since(mark).map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'editMessageReplyMarkup',
    ]);
  });

  it('makes ids that a stale button of an earlier flow cannot match', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => randomFlowId()));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{5}$/);
  });
});

describe('text and commands that end a flow', () => {
  it('text while the flow waits for a button cancels it, then is handled from scratch (quick entry)', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    const mark = h.mark();
    await h.say('4,50 coffee');
    expect(h.fake.sentTexts().slice(-2)).toEqual([
      PREVIOUS_ENTRY_CANCELLED_TEXT,
      '€4.50 · coffee. Which budget?',
    ]);
    expect(PREVIOUS_ENTRY_CANCELLED_TEXT).toBe('Previous entry cancelled');
    expect(stripped(h, mark)).toHaveLength(1); // the old keyboard went
    await h.tapButton(/Groceries/);
    expect((await spendingsOf(h))[0]).toMatchObject({ amount: 450, description: 'coffee' });
  });

  it('text that is no amount, while a flow waits for a button, cancels it and then gets the pointer', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.say('hello');
    expect(h.fake.sentTexts().slice(-2)).toEqual([
      PREVIOUS_ENTRY_CANCELLED_TEXT,
      UNKNOWN_INPUT_TEXT,
    ]);
  });

  it('cancels a flow that waits for the date when the text is not for it', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton(/Groceries/);
    await h.say('5 lunch'); // the flow waits for the date now
    await h.say('another 6');
    expect(h.fake.sentTexts().slice(-2)).toEqual([
      PREVIOUS_ENTRY_CANCELLED_TEXT,
      UNKNOWN_INPUT_TEXT,
    ]);
    expect(await spendingsOf(h)).toEqual([]);
  });

  it('text that answers a step is not a quick entry: 12 at the amount step is the amount', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton(/Groceries/);
    await h.say('12');
    expect(h.screen().text).toBe('€12.00 · Groceries\nA note?');
  });

  it('a command during a flow cancels it first, then runs', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton(/Groceries/);
    const mark = h.mark();
    await h.say('/status');
    const texts = h
      .since(mark)
      .filter((call) => call.method === 'sendMessage')
      .map((call) => String(call.payload['text']));
    expect(texts[0]).toBe(PREVIOUS_ENTRY_CANCELLED_TEXT);
    expect(texts[1]).toContain('Groceries');
    // The answer to the amount step is gone: 12 starts a quick entry.
    await h.say('12');
    expect(h.screen().text).toBe('€12.00. Which budget?');
  });

  it('a command is never the answer to a step: /help at the amount step is not an amount or a note', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton(/Groceries/);
    await h.say('5 x');
    await h.say('/help');
    expect(h.fake.sentTexts().slice(-2)[0]).toBe(PREVIOUS_ENTRY_CANCELLED_TEXT);
    expect(await spendingsOf(h)).toEqual([]);
  });

  it('a command during the note step is not taken as the note', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton(/Groceries/);
    await h.say('5');
    await h.say('/undo');
    expect(h.fake.sentTexts().slice(-2)).toEqual([
      PREVIOUS_ENTRY_CANCELLED_TEXT,
      'Nothing to undo.',
    ]);
  });

  it('a new command replaces the flow in progress: /income during /spending', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.say('/income');
    expect(h.fake.sentTexts().slice(-2)).toEqual([
      PREVIOUS_ENTRY_CANCELLED_TEXT,
      'How much was the income? You can add a description after the amount, like 200 Bonus',
    ]);
    await h.say('100 Gift');
    expect(h.screen().text).toBe('Income €100.00 · Gift\nWhen?');
  });

  it('a command addressed to another bot is not for this one: the flow goes on', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton(/Groceries/);
    await h.say('/help@some_other_bot');
    expect(h.fake.sentTexts().at(-1)).toBe(UNKNOWN_INPUT_TEXT);
    await h.say('5 x');
    expect(h.screen().text).toBe('€5.00 · Groceries · x\nWhen?');
  });

  it('answers /spending@thisbot like /spending', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending@wallet_test_bot');
    expect(h.screen().text).toBe('Which budget?');
  });
});

describe('/cancel', () => {
  it('ends the flow in progress, answers "Cancelled." and removes its keyboard', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    const mark = h.mark();
    await h.say('/cancel');
    expect(
      h
        .since(mark)
        .filter((call) => call.method === 'sendMessage')
        .map((c) => c.payload['text']),
    ).toEqual([CANCELLED_TEXT]);
    expect(stripped(h, mark)).toHaveLength(1);
    expect(CANCELLED_TEXT).toBe('Cancelled.');
    // The keyboard it left behind is stale now, and the text no longer answers a step.
    await h.say('5 x');
    expect(h.screen().text).toBe('€5.00 · x. Which budget?');
  });

  it('ends a flow that waits for text, and the next text starts nothing in it', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton(/Groceries/);
    await h.say('/cancel');
    expect(h.fake.sentTexts().at(-1)).toBe('Cancelled.');
    await h.say('hello');
    expect(h.fake.sentTexts().at(-1)).toBe(UNKNOWN_INPUT_TEXT);
  });

  it('says there is nothing to cancel when there is no flow, or when it expired', async () => {
    const h = await createRecordingHarness();
    await h.say('/cancel');
    expect(h.fake.sentTexts()).toEqual([NOTHING_TO_CANCEL_TEXT]);
    await h.say('/spending');
    h.clock.set('2026-10-05T10:16:00Z');
    await h.say('/cancel');
    expect(h.fake.sentTexts().at(-1)).toBe(NOTHING_TO_CANCEL_TEXT);
  });

  it('a Cancel button and /cancel after it: nothing to cancel', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton('✖ Cancel');
    await h.say('/cancel');
    expect(h.fake.sentTexts().at(-1)).toBe(NOTHING_TO_CANCEL_TEXT);
  });
});

describe('only the owner', () => {
  it('ignores a stranger’s tap on a button of the owner’s flow, and the flow goes on', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    const budget = h.screen().rows[0]?.[0];
    const mark = h.mark();
    await h.bot.handleUpdate(callbackUpdate(budget?.data ?? '', { from: STRANGER }));
    await h.bot.handleUpdate(messageUpdate('/cancel', { from: STRANGER }));
    expect(h.since(mark)).toEqual([]);
    await h.tapButton(/Groceries/);
    expect(h.screen().text).toContain('How much?');
  });

  it('ignores the owner writing from a group: no flow starts', async () => {
    const h = await createRecordingHarness();
    const mark = h.mark();
    await h.say('/spending', { chat: { id: -100123, type: 'supergroup' } });
    await h.say('4 coffee', { chat: { id: -100123, type: 'group' } });
    expect(h.since(mark)).toEqual([]);
  });
});

describe('when a handler fails', () => {
  it('says that nothing was changed, logs the cause, and leaves the books as they were', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton(/Groceries/);
    await h.say('5 lunch');
    // The entries table is gone: the write of the entry fails, so the whole transaction rolls back.
    h.db.run(sql`drop table telegram_entries`);
    await h.tapButton('Today');
    expect(h.fake.sentTexts().at(-1)).toBe(SOMETHING_WENT_WRONG_TEXT);
    expect(h.toast()).toBe(SOMETHING_WENT_WRONG_TEXT);
    expect(h.logged.join('\n')).toContain('a handler failed');
    expect(await spendingsOf(h)).toEqual([]);
    // And the flow was consumed: the same button is stale now.
    const mark = h.mark();
    const today = h
      .screen()
      .rows.flat()
      .find((b) => b.text === 'Today');
    await h.tap(today?.data ?? '');
    expect(h.toast(mark)).toBe(STALE_BUTTON_TEXT);
  });

  it('tells the owner to finish setting up when Wallet has no settings yet', async () => {
    const h = createBotHarness({ linked: OWNER }); // not onboarded
    await h.say('/spending');
    await h.say('/income');
    await h.say('4 coffee');
    await h.say('/status');
    await h.say('/recent');
    expect(h.fake.sentTexts()).toEqual(Array(5).fill(NOT_ONBOARDED_TEXT));
    expect(h.logged.join('\n')).not.toContain('a handler failed');
  });

  it('does not let a failed Telegram call stop the update from being answered once', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    h.fake.answerOnce('editMessageText', () => {
      throw new Error('socket hang up');
    });
    await h.tapButton(/Groceries/);
    // The edit failed and the prompt was sent as a new message instead.
    expect(h.screen().text).toContain('How much?');
    expect(h.logged.join('\n')).toContain('could not edit a message');
  });
});
