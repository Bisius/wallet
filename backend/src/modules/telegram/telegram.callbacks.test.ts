/**
 * The `callback_data` of the buttons: every format, the round trip, the 64-byte limit and what is
 * refused. Telegram counts BYTES, so the longest possible data is built and measured.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SLOW, config } from '../../testing/prop';
import { fingerprintOf } from './telegram.entries';
import {
  CALLBACK_DATA_MAX_BYTES,
  type Callback,
  type FlowAction,
  LONGEST_CALLBACK_DATA,
  type RowAction,
  callbackData,
  flowData,
  readCallback,
  rowData,
} from './telegram.callbacks';

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe('the formats', () => {
  it.each<[FlowAction, string]>([
    [{ type: 'budget', budgetId: 12 }, 'f:k3x9a:b:12'],
    [{ type: 'cancel' }, 'f:k3x9a:x'],
    [{ type: 'skip' }, 'f:k3x9a:s'],
    [{ type: 'date', date: '2026-10-05' }, 'f:k3x9a:d:2026-10-05'],
    [{ type: 'earlier' }, 'f:k3x9a:e'],
    [{ type: 'confirm' }, 'f:k3x9a:ok'],
    [{ type: 'other' }, 'f:k3x9a:od'],
  ])('writes the flow button %j as %s', (action, data) => {
    expect(flowData('k3x9a', action)).toBe(data);
    expect(readCallback(data)).toEqual({ scope: 'flow', flowId: 'k3x9a', action });
  });

  it.each<[RowAction, string]>([
    [{ type: 'undo', kind: 's', id: 42, fp: 'mfk1xd8o' }, 'u:s:42:mfk1xd8o'],
    [{ type: 'undo', kind: 'i', id: 7, fp: 'a' }, 'u:i:7:a'],
    [{ type: 'delete', kind: 's', id: 42, fp: 'mfk1xd8o' }, 'd:s:42:mfk1xd8o'],
    [{ type: 'delete', kind: 's', id: 42, fp: 'mfk1xd8o', confirmed: [] }, 'd:s:42:mfk1xd8o:y'],
    [
      { type: 'delete', kind: 's', id: 42, fp: 'mfk1xd8o', confirmed: ['2026-09'] },
      'd:s:42:mfk1xd8o:y202609',
    ],
    [{ type: 'change', kind: 's', id: 42, fp: 'mfk1xd8o' }, 'c:s:42:mfk1xd8o'],
    [
      { type: 'change', kind: 'i', id: 42, fp: 'mfk1xd8o', date: '2026-09-30' },
      'c:i:42:mfk1xd8o:2026-09-30',
    ],
    [
      { type: 'change', kind: 's', id: 42, fp: 'mfk1xd8o', date: '2026-09-30', confirmed: [] },
      'c:s:42:mfk1xd8o:2026-09-30:y',
    ],
    [
      {
        type: 'change',
        kind: 's',
        id: 42,
        fp: 'mfk1xd8o',
        date: '2026-09-30',
        confirmed: ['2026-08', '2026-09'],
      },
      'c:s:42:mfk1xd8o:2026-09-30:y202608+202609',
    ],
    [{ type: 'back', kind: 's', id: 42, fp: 'mfk1xd8o' }, 'r:s:42:mfk1xd8o'],
    [{ type: 'keep' }, 'k'],
  ])('writes the row button %j as %s', (action, data) => {
    expect(rowData(action)).toBe(data);
    expect(readCallback(data)).toEqual({ scope: 'row', action });
  });

  it('reads back what callbackData wrote, for either kind', () => {
    const flow: Callback = { scope: 'flow', flowId: 'abc12', action: { type: 'skip' } };
    const row: Callback = { scope: 'row', action: { type: 'keep' } };
    expect(readCallback(callbackData(flow))).toEqual(flow);
    expect(readCallback(callbackData(row))).toEqual(row);
  });
});

describe('the limit of 64 bytes', () => {
  it('holds for the longest data that can exist', () => {
    expect(bytes(LONGEST_CALLBACK_DATA)).toBeLessThan(CALLBACK_DATA_MAX_BYTES);
    expect(CALLBACK_DATA_MAX_BYTES).toBe(64);
    expect(LONGEST_CALLBACK_DATA).toBe('c:s:9007199254740991:zzzzzzzzz:9999-12-31:y999911+999912');
  });

  it('holds for every format with the longest id (16 digits), flow id (8), fingerprint (9), date and two named months', () => {
    const id = Number.MAX_SAFE_INTEGER;
    const ref = { id, fp: 'zzzzzzzzz' };
    const named = ['9999-11', '9999-12'];
    const all = [
      flowData('zzzzzzzz', { type: 'budget', budgetId: id }),
      flowData('zzzzzzzz', { type: 'date', date: '9999-12-31' }),
      flowData('zzzzzzzz', { type: 'earlier' }),
      flowData('zzzzzzzz', { type: 'confirm' }),
      rowData({ type: 'undo', kind: 's', ...ref }),
      rowData({ type: 'delete', kind: 'i', ...ref, confirmed: named }),
      rowData({ type: 'change', kind: 'i', ...ref, date: '9999-12-31', confirmed: named }),
      rowData({ type: 'back', kind: 's', ...ref }),
    ];
    for (const data of all) expect(bytes(data), data).toBeLessThanOrEqual(64);
    expect(Math.max(...all.map(bytes))).toBe(bytes(LONGEST_CALLBACK_DATA));
  });

  it('holds for a fingerprint made from any date this century and the next', () => {
    // 2.8e12 ms is the year 2059; 9 base-36 characters reach year 5188.
    for (const iso of [
      '1970-01-01T00:00:00.000Z',
      '2026-10-05T10:00:00.123Z',
      '2200-01-01T00:00:00Z',
      '4000-01-01T00:00:00Z',
    ]) {
      const data = rowData({
        type: 'change',
        kind: 's',
        id: Number.MAX_SAFE_INTEGER,
        fp: fingerprintOf(iso),
        date: '9999-12-31',
        confirmed: ['9999-11', '9999-12'],
      });
      expect(bytes(data), iso).toBeLessThanOrEqual(64);
      expect(fingerprintOf(iso).length).toBeLessThanOrEqual(9);
    }
  });

  it('refuses data over 64 bytes instead of reading it', () => {
    expect(readCallback(`f:abcde:b:${'1'.repeat(60)}`)).toBeNull();
    expect(readCallback(`u:s:1:abc${'x'.repeat(100)}`)).toBeNull();
  });
});

describe('what is not a button of ours', () => {
  it.each([
    '',
    'k:1',
    'x',
    'f',
    'f:',
    'f:abcde',
    'f:abcde:',
    'f:abcde:z',
    'f:abcde:b',
    'f:abcde:b:',
    'f:abcde:b:0',
    'f:abcde:b:007',
    'f:abcde:b:-1',
    'f:abcde:b:1.5',
    'f:abcde:b:9999999999999999',
    'f:abcde:b:1:2',
    'f:abcde:x:1',
    'f:abcde:d',
    'f:abcde:d:2026-02-30',
    'f:abcde:d:2026-13-01',
    'f:abcde:d:2026-1-5',
    'f:abcde:d:20261005',
    'f:ABCDE:x',
    'f:ab:x',
    'f:abcdefghi:x',
    'f:ab-de:x',
    's:gone:1',
    'u',
    'u:s',
    'u:s:1', // no fingerprint: the buttons of before the fingerprint are stale
    'u:s:0:abc',
    'u:s:01:abc',
    'u:x:1:abc',
    'u:s:1:abc:y',
    'u:s:abc:abc',
    'u:s:1:ABC',
    'u:s:1:a-c',
    'u:s:1:abcdefghij', // a fingerprint is 1 to 9 characters
    'u:s:1:',
    'd:s:1:abc:n',
    'd:s:1:abc:y:z',
    'd:s:1:abc:y2026',
    'd:s:1:abc:y202613',
    'd:s:1:abc:y202609+',
    'd:s:1:abc:y202609+20261',
    'd:s:1:abc:ytrue',
    'd:s:1:abc:202609',
    'c:s:1:abc:2026-02-30',
    'c:s:1:abc:2026-10-05:n',
    'c:s:1:abc:2026-10-05:y:z',
    'c:s:1:abc:2026-10-05:y2026',
    'c:s:1:abc:y',
    'c:s:1',
    'r:s:1:abc:y',
    'r:s:1',
    'r:s',
    ' u:s:1:abc',
    'u:s:1:abc ',
  ])('refuses %j', (data) => {
    expect(readCallback(data)).toBeNull();
  });
});

describe('properties', () => {
  const id = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
  const date = fc
    .date({
      min: new Date('1900-01-01T00:00:00Z'),
      max: new Date('2999-12-31T00:00:00Z'),
      noInvalidDate: true,
    })
    .map((d) => d.toISOString().slice(0, 10));
  const flowId = fc.stringMatching(/^[0-9a-z]{3,8}$/);
  const flowAction: fc.Arbitrary<FlowAction> = fc.oneof(
    id.map((budgetId): FlowAction => ({ type: 'budget', budgetId })),
    date.map((d): FlowAction => ({ type: 'date', date: d })),
    fc.constantFrom<FlowAction>(
      { type: 'cancel' },
      { type: 'skip' },
      { type: 'earlier' },
      { type: 'confirm' },
      { type: 'other' },
    ),
  );
  const kind = fc.constantFrom<'s' | 'i'>('s', 'i');
  const fp = fc.stringMatching(/^[0-9a-z]{1,9}$/);
  const month = fc
    .tuple(fc.integer({ min: 1000, max: 9999 }), fc.integer({ min: 1, max: 12 }))
    .map(([y, m]) => `${y}-${String(m).padStart(2, '0')}`);
  const named = fc.array(month, { maxLength: 2 });
  const rowAction: fc.Arbitrary<RowAction> = fc.oneof(
    fc.record({ type: fc.constant('undo' as const), kind, id, fp }),
    fc.record({ type: fc.constant('delete' as const), kind, id, fp }),
    fc.record({ type: fc.constant('delete' as const), kind, id, fp, confirmed: named }),
    fc.record({ type: fc.constant('back' as const), kind, id, fp }),
    fc.record({ type: fc.constant('change' as const), kind, id, fp }),
    fc.record({ type: fc.constant('change' as const), kind, id, fp, date }),
    fc.record({ type: fc.constant('change' as const), kind, id, fp, date, confirmed: named }),
    fc.constant<RowAction>({ type: 'keep' }),
  );

  it(
    'every button is read back as written, and is under 64 bytes',
    () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc
              .tuple(flowId, flowAction)
              .map(([f, action]): Callback => ({ scope: 'flow', flowId: f, action })),
            rowAction.map((action): Callback => ({ scope: 'row', action })),
          ),
          (callback) => {
            const data = callbackData(callback);
            expect(bytes(data)).toBeLessThan(CALLBACK_DATA_MAX_BYTES);
            expect(readCallback(data)).toEqual(callback);
          },
        ),
        config(1000),
      );
    },
    SLOW,
  );

  it(
    'reading arbitrary text never throws, and whatever is read is written back to the same text',
    () => {
      fc.assert(
        fc.property(
          fc.string({ unit: fc.constantFrom(...'fucdrkbsxeod:0123456789-yz'), maxLength: 40 }),
          (text) => {
            const read = readCallback(text);
            if (read) expect(callbackData(read)).toBe(text);
          },
        ),
        config(3000),
      );
    },
    SLOW,
  );
});
