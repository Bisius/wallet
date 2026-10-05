/**
 * The buttons of a stored row after a BACKUP WAS RESTORED. A restore brings back `sqlite_sequence`,
 * so an id the chat still holds can name a NEW row. Every row button therefore carries a fingerprint
 * of the row (its `createdAt`, which is never edited), and a button whose fingerprint is not the
 * stored row's acts on nothing and answers "Already removed."
 */
import type { SpendingsPage } from '@wallet/shared';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { addIncome, addSpending } from '../../testing/helpers';
import { type RecordingHarness, createRecordingHarness } from '../../testing/telegram-flow-helpers';
import { fingerprintOf, findSpending, spendingFingerprints } from './telegram.entries';

const spendingsOf = async (h: RecordingHarness) =>
  ((await request(h.app).get('/api/spendings').expect(200)).body as SpendingsPage).items;

/** The bot records a coffee; the screen is its confirmation. Returns the row's id. */
async function recordCoffee(h: RecordingHarness): Promise<number> {
  await h.say('12 coffee');
  await h.tapButton(/Eating out/);
  const [row] = await spendingsOf(h);
  if (!row) throw new Error('nothing was stored');
  return row.id;
}

/** What restoring a backup taken just BEFORE spending `id` looks like: the row and its counter go back. */
function restoreBackupBefore(h: RecordingHarness, id: number) {
  h.db.run(sql`DELETE FROM spendings WHERE id = ${id}`);
  h.db.run(sql`UPDATE sqlite_sequence SET seq = ${id - 1} WHERE name = 'spendings'`);
}

describe('the fingerprint of a row', () => {
  it('is its createdAt in milliseconds in base 36: equal for the same instant, different for another', () => {
    expect(fingerprintOf('2026-10-05T10:00:00.000Z')).toBe(
      Date.parse('2026-10-05T10:00:00.000Z').toString(36),
    );
    expect(fingerprintOf('2026-10-05T10:00:00.000Z')).not.toBe(
      fingerprintOf('2026-10-05T10:00:00.001Z'),
    );
    expect(fingerprintOf('2026-10-05T10:00:00.000Z')).toBe(fingerprintOf('2026-10-05T10:00:00Z'));
    expect(fingerprintOf('2026-10-05T10:00:00.000Z')).toMatch(/^[0-9a-z]{1,9}$/);
  });

  it('survives every edit of the row, because createdAt is never edited', async () => {
    const h = await createRecordingHarness();
    const id = await recordCoffee(h);
    const before = h.fp('s', id);
    h.clock.set('2026-10-05T11:00:00Z');
    await request(h.app)
      .patch(`/api/spendings/${id}`)
      .send({
        amount: 999,
        description: 'edited',
        date: '2026-10-02',
        budgetId: h.budget('Groceries').id,
      })
      .expect(200);
    expect(h.fp('s', id)).toBe(before);
    expect(findSpending(h.db, id)?.createdAt).toBe('2026-10-05T10:00:00.000Z');
  });

  it('reads the fingerprints of several spendings at once, and leaves out one that is gone', async () => {
    const h = await createRecordingHarness();
    const id = await recordCoffee(h);
    const map = spendingFingerprints(h.db, [id, 424242]);
    expect([...map.keys()]).toEqual([id]);
    expect(map.get(id)).toBe(h.fp('s', id));
    expect(spendingFingerprints(h.db, []).size).toBe(0);
  });
});

describe('a stale button after a backup was restored', () => {
  it('never deletes the new spending that has the old one’s id (Undo)', async () => {
    const h = await createRecordingHarness();
    const id = await recordCoffee(h);
    const undo =
      h
        .screen()
        .rows.flat()
        .find((b) => b.text === '↩ Undo')?.data ?? '';
    restoreBackupBefore(h, id);
    h.clock.set('2026-10-05T10:07:00Z'); // the restore took a while; the web entry comes after it
    const web = await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      amount: 8000,
      date: '2026-10-05',
      description: 'rent share',
    });
    expect(web.id).toBe(id); // the id is back, on another row
    const mark = h.mark();
    await h.tap(undo); // the old button in the chat
    expect(h.toast(mark)).toBe('Already removed.');
    expect(h.since(mark).some((call) => call.method === 'editMessageReplyMarkup')).toBe(true);
    expect((await spendingsOf(h)).map((s) => s.id)).toEqual([web.id]);
  });

  it('never moves it either (Change date, a day of the list, and Back)', async () => {
    const h = await createRecordingHarness();
    const id = await recordCoffee(h);
    const buttons = h.screen().rows.flat();
    const change = buttons.find((b) => b.text === '📅 Change date')?.data ?? '';
    await h.tap(change);
    const day =
      h
        .screen()
        .rows.flat()
        .find((b) => b.text === 'Yesterday')?.data ?? '';
    const back =
      h
        .screen()
        .rows.flat()
        .find((b) => b.text === '‹ Back')?.data ?? '';
    restoreBackupBefore(h, id);
    h.clock.set('2026-10-05T10:07:00Z');
    const web = await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      amount: 8000,
      date: '2026-10-05',
    });
    expect(web.id).toBe(id);
    for (const data of [change, day, back]) {
      const mark = h.mark();
      await h.tap(data);
      expect(h.toast(mark), data).toBe('Already removed.');
    }
    expect(await spendingsOf(h)).toMatchObject([{ id: web.id, date: '2026-10-05', amount: 8000 }]);
  });

  it('never deletes it from an old /recent list, asked or confirmed', async () => {
    const h = await createRecordingHarness();
    const id = await recordCoffee(h);
    await h.say('/recent');
    const ask = h.screen().rows.flat()[0]?.data ?? '';
    await h.tapButton('🗑 1'); // the question, with its Delete button
    const confirm = h.screen().rows.flat()[0]?.data ?? '';
    restoreBackupBefore(h, id);
    h.clock.set('2026-10-05T10:07:00Z');
    const web = await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      amount: 8000,
      date: '2026-10-05',
    });
    expect(web.id).toBe(id);
    for (const data of [ask, confirm]) {
      const mark = h.mark();
      await h.tap(data);
      expect(h.toast(mark), data).toBe('Already removed.');
    }
    expect((await spendingsOf(h)).map((s) => s.id)).toEqual([web.id]);
  });

  it('never touches an income that now has the id of the one the button was made for', async () => {
    const h = await createRecordingHarness();
    await h.say('/income');
    await h.say('200 Bonus');
    await h.tapButton('Today');
    const undo = h.screen().rows.flat()[0]?.data ?? '';
    const id = Number(undo.split(':')[2]);
    h.db.run(sql`DELETE FROM incomes WHERE id = ${id}`);
    h.db.run(sql`UPDATE sqlite_sequence SET seq = ${id - 1} WHERE name = 'incomes'`);
    h.clock.set('2026-10-05T10:07:00Z');
    const web = await addIncome(h.app, {
      amount: 50000,
      description: 'Web income',
      date: '2026-10-05',
    });
    expect(web.id).toBe(id);
    const mark = h.mark();
    await h.tap(undo);
    expect(h.toast(mark)).toBe('Already removed.');
    expect(((await request(h.app).get('/api/incomes').expect(200)).body as unknown[]).length).toBe(
      1,
    );
  });

  it('is not fooled by /undo either: the restored database holds no entry for it', async () => {
    const h = await createRecordingHarness();
    const id = await recordCoffee(h);
    restoreBackupBefore(h, id);
    await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      amount: 8000,
      date: '2026-10-05',
    });
    await h.say('/undo');
    expect(h.screen().text).toBe('Nothing to undo.');
  });

  it('keeps working for the row it was made for, also after another row was deleted', async () => {
    const h = await createRecordingHarness();
    await recordCoffee(h);
    await h.say('7 snack');
    await h.tapButton(/Eating out/);
    const undoSecond = h.screen().rows.flat()[0]?.data ?? '';
    const first = (await spendingsOf(h)).at(-1);
    await request(h.app).delete(`/api/spendings/${first?.id}`).expect(204);
    await h.tap(undoSecond);
    expect(h.screen().text).toContain('🗑 Removed €7.00 · Eating out · snack');
  });
});

describe('the assumption of the fingerprint: the clock never repeats a millisecond across a restore', () => {
  it('holds when the new row is created one millisecond after the one the restore took away', async () => {
    const h = await createRecordingHarness();
    const id = await recordCoffee(h);
    const undo =
      h
        .screen()
        .rows.flat()
        .find((b) => b.text === '↩ Undo')?.data ?? '';
    restoreBackupBefore(h, id);
    h.clock.set('2026-10-05T10:00:00.001Z');
    const web = await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      amount: 8000,
      date: '2026-10-05',
    });
    expect(web.id).toBe(id);
    await h.tap(undo);
    expect((await spendingsOf(h)).map((s) => s.id)).toEqual([web.id]);
  });

  it('is only an assumption: a frozen clock gives both rows one createdAt, and nothing tells them apart', async () => {
    const h = await createRecordingHarness();
    const id = await recordCoffee(h);
    const first = h.fp('s', id);
    restoreBackupBefore(h, id);
    const web = await addSpending(h.app, {
      budgetId: h.budget('Groceries').id,
      amount: 8000,
      date: '2026-10-05',
    });
    expect(web.id).toBe(id);
    // Same millisecond, same fingerprint. A restore takes seconds on a real clock (the server is
    // stopped, the file copied, the server started, and only then is something entered).
    expect(h.fp('s', web.id)).toBe(first);
  });
});
