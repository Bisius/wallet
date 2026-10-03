import { IMPORT_SAMPLE_ROWS } from '@wallet/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/client';
import { importProfiles } from '../../db/schema';
import { dumpDb } from '../../testing/db-dump';
import {
  addBudget,
  addSpending,
  expectApiError,
  expectValidationPaths,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import { BANK_MAPPING, addProfile, parseCsvFile, parseOf } from '../../testing/import-helpers';
import { createTestApp } from '../../testing/test-app';

let app: Express;
let db: Db;
let clock: ReturnType<typeof mutableClock>;

beforeEach(async () => {
  clock = mutableClock('2026-03-15T10:00:00Z');
  ({ app, db } = createTestApp(clock));
  await onboard(app, { startMonth: '2026-01' });
});

describe('POST /api/import/parse: looking at a file', () => {
  it('detects the delimiter and answers the header, a sample with its lines and the counts', async () => {
    const csv = [
      'Date;Amount;Description',
      '2026-03-01;-1,50;One',
      '2026-03-02;-2,50;Two',
      '2026-03-03;-3,50;Three',
      '',
      '2026-03-05;-4,50;Four',
      '2026-03-06;-5,50;Five',
      '2026-03-07;-6,50;Six',
      '2026-03-08;-7,50;Seven',
    ].join('\r\n');
    const res = await parseOf(app, { csv });

    expect(res).toEqual({
      delimiter: ';',
      header: ['Date', 'Amount', 'Description'],
      // At most five records after the first one, with the line each starts on (the blank line
      // is not a record, but it is a line).
      sample: [
        { line: 2, cells: ['2026-03-01', '-1,50', 'One'] },
        { line: 3, cells: ['2026-03-02', '-2,50', 'Two'] },
        { line: 4, cells: ['2026-03-03', '-3,50', 'Three'] },
        { line: 6, cells: ['2026-03-05', '-4,50', 'Four'] },
        { line: 7, cells: ['2026-03-06', '-5,50', 'Five'] },
      ],
      recordCount: 8,
      columnCount: 3,
      suggestedProfileId: null,
    });
    expect(res.sample).toHaveLength(IMPORT_SAMPLE_ROWS);
  });

  it.each([
    [',', 'a,b,c\n1,2,3\n'],
    [';', 'a;b;c\n1;2;3\n'],
    ['\t', 'a\tb\tc\n1\t2\t3\n'],
    ['|', 'a|b|c\n1|2|3\n'],
  ])('detects %j', async (delimiter, csv) => {
    const res = await parseOf(app, { csv });
    expect(res.delimiter).toBe(delimiter);
    expect(res.header).toEqual(['a', 'b', 'c']);
  });

  it('uses the delimiter of the request instead of detecting one', async () => {
    const csv = 'a;b,c\n1;2,3\n';
    expect((await parseOf(app, { csv })).header).toHaveLength(2); // detected ";"
    const forced = await parseOf(app, { csv, delimiter: ',' });
    expect(forced.delimiter).toBe(',');
    expect(forced.header).toEqual(['a;b', 'c']);
  });

  it('reads quoted fields, counts their lines, drops a BOM and does not trim the cells', async () => {
    const csv = '﻿" Date ",Amount,Text\r\n2026-03-01,-1,"two\nlines"\r\n2026-03-02,-2,Next\r\n';
    const res = await parseOf(app, { csv });
    expect(res.header).toEqual([' Date ', 'Amount', 'Text']);
    expect(res.sample).toEqual([
      { line: 2, cells: ['2026-03-01', '-1', 'two\nlines'] },
      { line: 4, cells: ['2026-03-02', '-2', 'Next'] },
    ]);
    expect(res.recordCount).toBe(3);
  });

  it('reports the widest record as the column count', async () => {
    const res = await parseOf(app, { csv: 'a,b\n1,2,3,4\n5\n' });
    expect(res.columnCount).toBe(4);
    expect(res.recordCount).toBe(3);
  });

  it('answers a file with no records for an empty text or only blank lines', async () => {
    for (const csv of ['', '\n\n', ' ,, \n']) {
      expect(await parseOf(app, { csv })).toEqual({
        delimiter: ',',
        header: [],
        sample: [],
        recordCount: 0,
        columnCount: 0,
        suggestedProfileId: null,
      });
    }
  });

  it('offers the first record as the header even when it is data (it does not know yet)', async () => {
    const res = await parseOf(app, { csv: '2026-03-01,-1,A\n2026-03-02,-2,B\n' });
    expect(res.header).toEqual(['2026-03-01', '-1', 'A']);
    expect(res.sample).toHaveLength(1);
    expect(res.recordCount).toBe(2);
  });

  it('refuses a quoted field that is never closed with a 400 at csv that names the line', async () => {
    const res = await parseCsvFile(app, { csv: 'a,b\n1,"never closed\n2,3\n' });
    expectValidationPaths(res, 'csv');
    expect(res.body.error.details[0].message).toContain('line 2');
  });

  it('is not limited to the rows of a preview: only the size of the body limits it', async () => {
    const csv = Array.from({ length: 12_000 }, (_, i) => `2026-03-01,-1,Row ${i}`).join('\n');
    expect((await parseOf(app, { csv })).recordCount).toBe(12_000);
  });

  it('writes nothing', async () => {
    await addProfile(app);
    const before = dumpDb(db);
    await parseOf(app, { csv: 'date,amount,description\n2026-03-01,-1,A\n' });
    expect(dumpDb(db)).toBe(before);
  });

  it.each([
    ['no body', undefined, ['']],
    ['no csv', {}, ['csv']],
    ['a csv that is not text', { csv: ['a'] }, ['csv']],
    ['a delimiter that is not one of the four', { csv: 'a', delimiter: ':' }, ['delimiter']],
    ['a delimiter of two characters', { csv: 'a', delimiter: ',,' }, ['delimiter']],
    ['an unknown key', { csv: 'a', extra: 1 }, ['']],
    ['a mapping (parse has none)', { csv: 'a', mapping: BANK_MAPPING }, ['']],
  ])('is a 400 at the field for %s', async (_label, body, paths) => {
    expectValidationPaths(await request(app).post('/api/import/parse').send(body), ...paths);
  });

  it('answers 409 not_onboarded until the settings exist', async () => {
    const fresh = createTestApp(clock).app;
    expectApiError(await parseCsvFile(fresh, { csv: 'a' }), 'not_onboarded');
    expectApiError(await parseCsvFile(fresh, {}), 'not_onboarded');
  });
});

describe('POST /api/import/parse: suggestedProfileId', () => {
  const file = (header: string) => `${header}\n2026-03-01,-1,A\n`;
  const suggested = async (csv: string) => (await parseOf(app, { csv })).suggestedProfileId;

  it("is the profile whose header signature matches the file's header", async () => {
    const bank = await addProfile(app, { name: 'Bank', header: ['date', 'amount', 'description'] });
    expect(await suggested(file('date,amount,description'))).toBe(bank.id);
  });

  it('compares the mapped columns only, normalized: case, spaces and Unicode form do not matter', async () => {
    const bank = await addProfile(app, {
      name: 'Bank',
      mapping: { dateColumn: 1, amountColumn: 3, descriptionColumn: 4 },
      header: ['Nr', 'Buchungstag', 'Extra', 'Betrag', 'Verwendungszweck'],
    });
    // The other columns are free; the three mapped ones match after normalization.
    expect(await suggested(file('X,  BUCHUNGSTAG ,Y,betrag,Verwendungs­zweck'))).toBeNull();
    expect(await suggested(file('X,  BUCHUNGSTAG ,Y,betrag,VERWENDUNGSZWECK'))).toBe(bank.id);
    expect(await suggested(file('Z,buchungstag,anything,BETRAG,Verwendungszweck'))).toBe(bank.id);
    // A mapped column that differs, or is at another position, does not match.
    expect(await suggested(file('Nr,Buchungstag,Extra,Umsatz,Verwendungszweck'))).toBeNull();
    expect(await suggested(file('Buchungstag,Nr,Extra,Betrag,Verwendungszweck'))).toBeNull();
  });

  it('does not strip accents, but folds the case of every alphabet', async () => {
    const bank = await addProfile(app, {
      name: 'Bank',
      mapping: { dateColumn: 0, amountColumn: 1, descriptionColumn: 2 },
      header: ['Datum', 'Betrag', 'Beschreibung'],
    });
    expect(await suggested(file('DATUM,BETRAG,BESCHREIBUNG'))).toBe(bank.id);
    const accent = await addProfile(app, {
      name: 'Accents',
      mapping: { dateColumn: 0, amountColumn: 1, descriptionColumn: 2 },
      header: ['Дата', 'Сумма', 'Описание'],
    });
    expect(await suggested(file('ДАТА,сумма,описание'))).toBe(accent.id);
    expect(await suggested(file('Datüm,Betrag,Beschreibung'))).toBeNull();
  });

  it('is null when the header is too short for the mapped columns', async () => {
    await addProfile(app, { mapping: { descriptionColumn: 4 }, header: ['a', 'b', 'c', 'd', 'e'] });
    expect(await suggested(file('a,b,c'))).toBeNull();
  });

  it('never suggests a profile with no signature', async () => {
    await addProfile(app, { name: 'Null header', header: null });
    await addProfile(app, { name: 'Omitted header', header: undefined });
    // A profile of a file with no header row ignores the header it was sent and keeps no signature.
    await addProfile(app, { name: 'No header row', mapping: { hasHeader: false } });
    expect(await suggested(file('date,amount,description'))).toBeNull();
  });

  it('prefers the most recently updated profile, then the highest id', async () => {
    const a = await addProfile(app, { name: 'A' });
    clock.set('2026-03-15T11:00:00Z');
    const b = await addProfile(app, { name: 'B' });
    clock.set('2026-03-15T12:00:00Z');
    const c = await addProfile(app, { name: 'C' });
    expect(await suggested(file('date,amount,description'))).toBe(c.id);

    // Updating A makes it the most recent.
    clock.set('2026-03-15T13:00:00Z');
    await request(app)
      .put(`/api/import/profiles/${a.id}`)
      .send({ name: 'A', mapping: BANK_MAPPING, header: ['date', 'amount', 'description'] })
      .expect(200);
    expect(await suggested(file('date,amount,description'))).toBe(a.id);

    // On the same instant, the highest id wins.
    clock.set('2026-03-15T14:00:00Z');
    await request(app)
      .put(`/api/import/profiles/${b.id}`)
      .send({ name: 'B', mapping: BANK_MAPPING, header: ['date', 'amount', 'description'] })
      .expect(200);
    await request(app)
      .put(`/api/import/profiles/${c.id}`)
      .send({ name: 'C', mapping: BANK_MAPPING, header: ['date', 'amount', 'description'] })
      .expect(200);
    expect(await suggested(file('date,amount,description'))).toBe(c.id);
  });

  it('skips a profile whose stored mapping does not fit the contract instead of failing', async () => {
    const good = await addProfile(app, { name: 'Good' });
    db.insert(importProfiles)
      .values({
        name: 'Corrupt',
        mapping: { delimiter: 'x' } as never,
        headerSignature: ['date', 'amount', 'description'],
        createdAt: '2026-03-16T00:00:00.000Z',
        updatedAt: '2026-03-16T00:00:00.000Z',
      })
      .run();
    expect(await suggested(file('date,amount,description'))).toBe(good.id);
  });

  it('does not depend on the budgets or the spendings', async () => {
    const budget = await addBudget(app, { name: 'Groceries', startMonth: '2026-01' });
    await addSpending(app, { budgetId: budget.id, description: 'date' });
    expect(await suggested(file('date,amount,description'))).toBeNull();
  });
});
