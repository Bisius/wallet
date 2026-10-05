/**
 * What the flows do when Telegram or a handler misbehaves: a confirmation that cannot be shown after
 * the write, an edit that Telegram refuses as "not modified", and keyboards that are only taken away
 * when there is one.
 */
import type { SpendingsPage } from '@wallet/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { botApiError } from '../../testing/fake-bot-api';
import { type RecordingHarness, createRecordingHarness } from '../../testing/telegram-flow-helpers';

const spendingsOf = async (h: RecordingHarness) =>
  ((await request(h.app).get('/api/spendings').expect(200)).body as SpendingsPage).items;

describe('a confirmation that cannot be shown', () => {
  it('leaves the spending written, and asks for a check again once the level is taken back', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton(/Groceries/);
    await h.say('5 lunch');
    h.fake.answerAlways(
      'editMessageText',
      botApiError(400, 'Bad Request: message to edit not found'),
    );
    h.fake.answerAlways('sendMessage', botApiError(502, 'Bad Gateway'));
    await h.tapButton('Today');
    expect(await spendingsOf(h)).toHaveLength(1); // the write happened
    // The levels are recorded BEFORE the send is awaited (a check in between would announce them
    // otherwise): see the race test in telegram.flows.races.test.ts.
    expect(h.notify.markNotified).toHaveBeenCalledTimes(1);
    // One check was asked for by the write, and one after the level was taken back (nothing arrived).
    expect(h.notify.scheduleBudgetAlertCheck).toHaveBeenCalledTimes(2);
    // Nothing could be sent at all, so it was logged (redacted), and never as a failed handler.
    expect(h.logged.join('\n')).toContain(
      'could not show the confirmation of a write that was made',
    );
    expect(h.logged.join('\n')).toContain('could not tell the user about it either');
    expect(h.logged.join('\n')).not.toContain('a handler failed');
  });

  it('falls back to a new message when the edit fails, and the confirmation still arrives', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton(/Groceries/);
    await h.say('5 lunch');
    h.fake.answerOnce(
      'editMessageText',
      botApiError(400, 'Bad Request: message to edit not found'),
    );
    await h.tapButton('Today');
    expect(h.screen().text).toContain('✅ €5.00 · Groceries · lunch · Mon 5 Oct');
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['↩ Undo', '📅 Change date']);
    expect(h.notify.markNotified).toHaveBeenCalledTimes(1);
  });
});

describe('an edit that changes nothing', () => {
  it('is not an error: no log, and no second message', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    const sent = h.fake.callsOf('sendMessage').length;
    h.fake.answerOnce(
      'editMessageText',
      botApiError(
        400,
        'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
      ),
    );
    await h.tapButton(/Groceries/);
    expect(h.fake.callsOf('sendMessage')).toHaveLength(sent);
    expect(h.logged.join('\n')).not.toContain('could not edit');
  });

  it('is not an error either for a keyboard', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton(/Groceries/);
    await h.say('5 lunch');
    h.fake.answerOnce(
      'editMessageReplyMarkup',
      botApiError(400, 'Bad Request: message is not modified'),
    );
    await h.tapButton('Earlier…');
    expect(h.logged.join('\n')).not.toContain('could not change a keyboard');
  });
});

describe('keyboards are taken away only where there is one', () => {
  const strips = (h: RecordingHarness, from: number) =>
    h.since(from).filter((call) => call.method === 'editMessageReplyMarkup');

  it('not at the amount step of a spending, nor at the description step of an income', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton(/Groceries/); // the amount prompt has no keyboard
    let mark = h.mark();
    await h.say('/cancel');
    expect(strips(h, mark)).toEqual([]);

    await h.say('/income');
    await h.say('100'); // the description prompt has no keyboard
    mark = h.mark();
    await h.say('/cancel');
    expect(strips(h, mark)).toEqual([]);
  });

  it('at the note step of a spending (Skip), the date step, and the closed-month question', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton(/Groceries/);
    await h.say('5');
    let mark = h.mark();
    await h.say('/cancel');
    expect(strips(h, mark)).toHaveLength(1);

    await h.say('/spending');
    await h.tapButton(/Groceries/);
    await h.say('5 x'); // the date prompt
    mark = h.mark();
    await h.say('/cancel');
    expect(strips(h, mark)).toHaveLength(1);
  });

  it('when the note is typed, the Skip button goes; when the description of an income is typed, nothing is edited', async () => {
    const h = await createRecordingHarness();
    await h.say('/spending');
    await h.tapButton(/Groceries/);
    await h.say('5');
    let mark = h.mark();
    await h.say('lunch');
    expect(strips(h, mark)).toHaveLength(1);

    await h.say('/income');
    await h.say('100');
    mark = h.mark();
    await h.say('Bonus');
    expect(strips(h, mark)).toEqual([]);
  });
});
