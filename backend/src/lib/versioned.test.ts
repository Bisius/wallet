import { describe, expect, it } from 'vitest';
import {
  type LifecycleStatus,
  currentRow,
  effectiveAt,
  firstRowRedate,
  isWithinActiveMonths,
  lifecycleStatus,
} from './versioned';

describe('lifecycleStatus', () => {
  it.each<[string, string, string | null, string, LifecycleStatus]>([
    // [label, start, end, current month, status]
    ['before the start', '2026-05', null, '2026-04', 'upcoming'],
    ['in the start month', '2026-05', null, '2026-05', 'active'],
    ['long after the start, never ends', '2026-05', null, '2030-01', 'active'],
    ['in the last month of a range', '2026-05', '2026-08', '2026-08', 'active'],
    ['one month after the end', '2026-05', '2026-08', '2026-09', 'ended'],
    ['a one-month item, in its month', '2026-05', '2026-05', '2026-05', 'active'],
    ['a one-month item, the month after', '2026-05', '2026-05', '2026-06', 'ended'],
    ['across a year boundary', '2026-11', '2027-02', '2027-01', 'active'],
    ['across a year boundary, ended', '2026-11', '2027-02', '2027-03', 'ended'],
  ])('%s', (_label, start, end, current, expected) => {
    expect(lifecycleStatus(start, end, current)).toBe(expected);
  });
});

describe('isWithinActiveMonths', () => {
  it.each<[string, string, string | null, string, boolean]>([
    ['the month before the start', '2026-05', '2026-08', '2026-04', false],
    ['the start month', '2026-05', '2026-08', '2026-05', true],
    ['the end month', '2026-05', '2026-08', '2026-08', true],
    ['the month after the end', '2026-05', '2026-08', '2026-09', false],
    ['far in the future without an end', '2026-05', null, '2099-12', true],
    ['before the start without an end', '2026-05', null, '2026-04', false],
  ])('%s', (_label, start, end, month, expected) => {
    expect(isWithinActiveMonths(start, end, month)).toBe(expected);
  });
});

describe('effectiveAt', () => {
  const rows = [
    { effectiveMonth: '2026-03' },
    { effectiveMonth: '2026-06' },
    { effectiveMonth: '2026-09' },
  ];

  it.each([
    ['2026-02', null],
    ['2026-03', '2026-03'],
    ['2026-05', '2026-03'],
    ['2026-06', '2026-06'],
    ['2026-08', '2026-06'],
    ['2026-09', '2026-09'],
    ['2031-01', '2026-09'],
  ])('in %s the row effective from %s applies', (month, expected) => {
    expect(effectiveAt(rows, month)?.effectiveMonth ?? null).toBe(expected);
  });

  it('is null without rows', () => {
    expect(effectiveAt([], '2026-01')).toBeNull();
  });
});

describe('currentRow', () => {
  // A price/version history: 100 from January, 200 from May, 300 from September.
  const rows = [
    { effectiveMonth: '2026-01', amount: 100 },
    { effectiveMonth: '2026-05', amount: 200 },
    { effectiveMonth: '2026-09', amount: 300 },
  ];
  const amountOf = (start: string, end: string | null, current: string) =>
    currentRow(rows, start, end, current)?.amount ?? null;

  it.each<[string, string, string | null, string, number | null]>([
    // [label, start, end, current month, amount of the row shown]
    ['the row in effect now, for an item with no end', '2026-01', null, '2026-06', 200],
    ['a row that starts in the current month', '2026-01', null, '2026-05', 200],
    ['the first row, in the start month', '2026-01', null, '2026-01', 100],
    ['the latest row, long after', '2026-01', null, '2031-01', 300],
    ['the row in effect now while the end is still ahead', '2026-01', '2026-12', '2026-06', 200],
    ['the row in effect in the end month itself', '2026-01', '2026-07', '2026-07', 200],
    ['a row dated exactly in the end month', '2026-01', '2026-09', '2026-09', 300],
    // Ended: the row in effect in the END month, never a later (inert) one.
    [
      'an ended item shows the row of its end month, not a later one',
      '2026-01',
      '2026-06',
      '2026-12',
      200,
    ],
    [
      'an inert row stays inert however long ago the item ended',
      '2026-01',
      '2026-03',
      '2031-01',
      100,
    ],
    ['a row dated the month after the end is inert', '2026-01', '2026-04', '2026-12', 100],
    // Upcoming is always null, even when a row is dated before the start month.
    ['an upcoming item has no current row', '2026-06', null, '2026-03', null],
    ['an upcoming item has none even if an older row exists', '2026-12', null, '2026-06', null],
    // A start moved later than the rows: the row in effect at the start month is an older one.
    [
      'a row dated before the start month is the one in effect at the start',
      '2026-07',
      null,
      '2026-07',
      200,
    ],
    ['a start moved past every row: the last row applies', '2026-11', null, '2026-11', 300],
  ])('%s', (_label, start, end, current, expected) => {
    expect(amountOf(start, end, current)).toBe(expected);
  });

  it('is null when no row is in effect yet (rows only start after the month asked for)', () => {
    expect(currentRow([{ effectiveMonth: '2026-08' }], '2026-03', null, '2026-05')).toBeNull();
  });

  it('is null without rows', () => {
    expect(currentRow([], '2026-01', null, '2026-06')).toBeNull();
  });
});

describe('firstRowRedate', () => {
  const row = (id: number, effectiveMonth: string) => ({ id, effectiveMonth });
  const three = [row(1, '2026-03'), row(2, '2026-06'), row(3, '2026-09')];

  it.each<
    [string, { id: number; effectiveMonth: string }[], string, { id: number; to: string } | null]
  >([
    // [label, rows, new start, the row re-dated]
    ['an unchanged start is a no-op', [row(1, '2026-03')], '2026-03', null],
    ['earlier: the only row is re-dated', [row(1, '2026-03')], '2026-01', { id: 1, to: '2026-01' }],
    ['later: nothing changes', [row(1, '2026-03')], '2026-05', null],
    ['earlier: only the first row is re-dated', three, '2026-01', { id: 1, to: '2026-01' }],
    ['earlier by a single month', three, '2026-02', { id: 1, to: '2026-02' }],
    ['later, still before the second row: nothing changes', three, '2026-05', null],
    ['later, exactly at the second row: nothing changes', three, '2026-06', null],
    ['later, between the second and third: nothing changes', three, '2026-07', null],
    ['later, exactly at the last row: nothing changes', three, '2026-09', null],
    ['later than every row: nothing changes', three, '2026-11', null],
    [
      'rows given out of order: the earliest one is still the first',
      [three[2]!, three[0]!, three[1]!],
      '2026-02',
      { id: 1, to: '2026-02' },
    ],
    [
      'across a year boundary',
      [row(1, '2027-02'), row(2, '2027-05')],
      '2026-11',
      { id: 1, to: '2026-11' },
    ],
    ['no rows at all (nothing to maintain)', [], '2026-05', null],
  ])('%s', (_label, rows, newStart, expected) => {
    expect(firstRowRedate(rows, newStart)).toEqual(expected);
  });

  it('never deletes, never adds, never collides, and leaves a row in effect at the new start', () => {
    // Exhaustive over a small grid: the item's first row sat at the old start month (as the API
    // creates it), later rows follow. Apply the plan and check the invariants of DOMAIN.md.
    const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
    for (const start of months) {
      for (const newStart of months) {
        const rows = [row(1, start)];
        for (const extra of months.filter((m) => m > start)) rows.push(row(rows.length + 1, extra));
        const redate = firstRowRedate(rows, newStart);

        const after = rows.map((r) =>
          redate?.id === r.id ? { ...r, effectiveMonth: redate.to } : r,
        );
        const label = `start ${start} -> ${newStart}`;
        expect(after, `${label}: no row added or deleted`).toHaveLength(rows.length);
        const kinds = after.map((r) => r.effectiveMonth);
        expect(new Set(kinds).size, `${label}: no two rows in one month`).toBe(kinds.length);
        // A row is in effect at the new start month.
        const ascending = [...after].sort((a, b) =>
          a.effectiveMonth.localeCompare(b.effectiveMonth),
        );
        expect(effectiveAt(ascending, newStart), `${label}: a row in effect`).not.toBeNull();
        // Only the first row can move, and only when the start moved before it.
        const moved = after.filter((r, i) => r.effectiveMonth !== rows[i]!.effectiveMonth);
        expect(
          moved.map((r) => r.id),
          label,
        ).toEqual(newStart < start ? [1] : []);
      }
    }
  });
});
