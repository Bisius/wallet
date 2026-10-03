import { savingsTransaction as row } from '../../../testing/fixtures';
import {
  canDelete,
  describeEntry,
  type EntryContext,
  groupTransactions,
} from './transaction-entries';

const NAMES: Record<number, string> = { 1: 'Holiday', 2: 'Car' };

const context: EntryContext = {
  place: (goalId) => (goalId === null ? 'Unassigned savings' : (NAMES[goalId] ?? 'a deleted goal')),
  money: (cents) => `€${(cents / 100).toFixed(2)}`,
  month: (month) => (month === '2026-09' ? 'September 2026' : month),
};

describe('groupTransactions', () => {
  it('puts the two rows of a reallocation together, whichever way the page lists them', () => {
    const rows = [
      row({ id: 11, kind: 'reallocation', amount: 5000, goalId: null, groupId: 7 }),
      row({ id: 10, kind: 'reallocation', amount: -5000, goalId: 1, groupId: 7 }),
    ];

    const entries = groupTransactions(rows);

    expect(entries).toHaveLength(1);
    expect(entries[0].rows.map((r) => r.id)).toEqual([10, 11]);
    expect(describeEntry(entries[0], context).title).toBe(
      'Moved €50.00 from Holiday to Unassigned savings',
    );
  });

  it('keeps the order of the list, an entry sitting where its first row sits', () => {
    const rows = [
      row({ id: 9, kind: 'deposit', date: '2026-10-02' }),
      row({ id: 8, kind: 'reallocation', amount: 2000, goalId: 2, groupId: 3 }),
      row({ id: 7, kind: 'reallocation', amount: -2000, goalId: 1, groupId: 3 }),
      row({ id: 6, kind: 'withdrawal', amount: -100 }),
    ];

    expect(groupTransactions(rows).map((entry) => entry.kind)).toEqual([
      'deposit',
      'reallocation',
      'withdrawal',
    ]);
  });

  it('keeps two reallocations apart', () => {
    const rows = [
      row({ id: 4, kind: 'reallocation', amount: 100, goalId: 1, groupId: 2 }),
      row({ id: 3, kind: 'reallocation', amount: -100, goalId: null, groupId: 2 }),
      row({ id: 2, kind: 'reallocation', amount: 100, goalId: 2, groupId: 1 }),
      row({ id: 1, kind: 'reallocation', amount: -100, goalId: null, groupId: 1 }),
    ];

    const entries = groupTransactions(rows);

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => describeEntry(entry, context).title)).toEqual([
      'Moved €1.00 from Unassigned savings to Holiday',
      'Moved €1.00 from Unassigned savings to Car',
    ]);
  });

  it('says what a reallocation did to a place when its other side is not in the list', () => {
    const out = groupTransactions([
      row({ id: 3, kind: 'reallocation', amount: -5000, goalId: 1, groupId: 9 }),
    ]);
    const into = groupTransactions([
      row({ id: 4, kind: 'reallocation', amount: 5000, goalId: 1, groupId: 9 }),
    ]);

    expect(describeEntry(out[0], context)).toEqual({
      title: 'Moved out of Holiday',
      amount: -5000,
      slices: [],
    });
    expect(describeEntry(into[0], context)).toEqual({
      title: 'Moved into Holiday',
      amount: 5000,
      slices: [],
    });
  });

  it('makes one entry of the allocations of a settlement, listing where each part went', () => {
    const rows = [
      row({ id: 22, kind: 'settlement', amount: 11240, goalId: null, settlesMonth: '2026-09' }),
      row({ id: 21, kind: 'settlement', amount: 20000, goalId: 1, settlesMonth: '2026-09' }),
    ];

    const [entry, ...others] = groupTransactions(rows);

    expect(others).toEqual([]);
    expect(describeEntry(entry, context)).toEqual({
      title: 'Settled September 2026',
      amount: null,
      slices: [
        { place: 'Holiday', amount: 20000 },
        { place: 'Unassigned savings', amount: 11240 },
      ],
    });
  });

  it('keeps a correction made the same day apart from the settlement it corrects: it goes the other way', () => {
    // Settled +1,970.00 to unassigned savings, then 150.00 taken back, split over two places.
    const rows = [
      row({
        id: 33,
        date: '2026-10-02',
        kind: 'settlement',
        amount: -10000,
        goalId: 1,
        settlesMonth: '2026-08',
      }),
      row({
        id: 32,
        date: '2026-10-02',
        kind: 'settlement',
        amount: -5000,
        goalId: null,
        settlesMonth: '2026-08',
      }),
      row({
        id: 31,
        date: '2026-10-02',
        kind: 'settlement',
        amount: 197000,
        goalId: null,
        settlesMonth: '2026-08',
      }),
    ];

    const entries = groupTransactions(rows);

    expect(entries.map((entry) => describeEntry(entry, context).slices)).toEqual([
      [
        { place: 'Unassigned savings', amount: -5000 },
        { place: 'Holiday', amount: -10000 },
      ],
      [{ place: 'Unassigned savings', amount: 197000 }],
    ]);
  });

  it('keeps two settlements of one day apart when they put money in the same place: one settlement never does', () => {
    const rows = [
      row({
        id: 42,
        date: '2026-10-02',
        kind: 'settlement',
        amount: 5000,
        goalId: null,
        settlesMonth: '2026-08',
      }),
      row({
        id: 41,
        date: '2026-10-02',
        kind: 'settlement',
        amount: 20000,
        goalId: 1,
        settlesMonth: '2026-08',
      }),
      row({
        id: 40,
        date: '2026-10-02',
        kind: 'settlement',
        amount: 10000,
        goalId: null,
        settlesMonth: '2026-08',
      }),
    ];

    const entries = groupTransactions(rows);

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.rows.map((r) => r.id))).toEqual([[41, 42], [40]]);
    // Undoing takes back the whole month, so it is offered once, on the newest entry.
    expect(entries.map((entry) => entry.offersUndo)).toEqual([true, false]);
  });

  it('keeps settlements of different days, or of different months, apart', () => {
    const rows = [
      row({ id: 30, kind: 'settlement', date: '2026-10-02', settlesMonth: '2026-09' }),
      row({ id: 29, kind: 'settlement', date: '2026-10-01', settlesMonth: '2026-09' }),
      row({ id: 28, kind: 'settlement', date: '2026-10-01', settlesMonth: '2026-08' }),
    ];

    expect(groupTransactions(rows)).toHaveLength(3);
  });

  it('offers to undo a settled month once: on its newest entry', () => {
    const rows = [
      row({ id: 30, kind: 'settlement', date: '2026-10-02', settlesMonth: '2026-09' }),
      row({ id: 29, kind: 'settlement', date: '2026-10-01', settlesMonth: '2026-09' }),
      row({ id: 28, kind: 'settlement', date: '2026-10-01', settlesMonth: '2026-08' }),
      row({ id: 27, kind: 'deposit' }),
    ];

    expect(groupTransactions(rows).map((entry) => entry.offersUndo)).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it('describes the plain kinds with the amount the row carries', () => {
    const entries = groupTransactions([
      row({ id: 4, kind: 'deposit', amount: 5000, goalId: 1 }),
      row({ id: 3, kind: 'withdrawal', amount: -1250, goalId: null }),
      row({ id: 2, kind: 'opening', amount: 100000 }),
    ]);

    expect(entries.map((entry) => describeEntry(entry, context))).toEqual([
      { title: 'Deposit to Holiday', amount: 5000, slices: [] },
      { title: 'Withdrawal from Unassigned savings', amount: -1250, slices: [] },
      { title: 'Opening balance', amount: 100000, slices: [] },
    ]);
  });

  it('names a goal that no longer exists instead of failing', () => {
    const [entry] = groupTransactions([row({ kind: 'deposit', goalId: 99 })]);

    expect(describeEntry(entry, context).title).toBe('Deposit to a deleted goal');
  });
});

describe('canDelete', () => {
  it.each([
    ['deposit', true],
    ['withdrawal', true],
    ['reallocation', true],
    ['opening', false],
    ['settlement', false],
  ] as const)('%s: %s', (kind, expected) => {
    const [entry] = groupTransactions([row({ kind })]);
    expect(canDelete(entry)).toBe(expected);
  });
});
