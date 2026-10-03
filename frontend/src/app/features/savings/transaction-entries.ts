import type { Cents, IsoDate, MonthKey, SavingsTransactionDto } from '@wallet/shared';
import type { SavingsTransactionKind } from '@wallet/shared/limits';

/**
 * One line of the savings history. The API lists rows, and a few things the user did are more than
 * one row: a reallocation is two rows with the same `groupId`, and a settlement is one row per
 * allocation. This puts them back together, so the history reads as what happened.
 */
export interface HistoryEntry {
  /** Stable while the entry is on screen, whatever rows "Load more" adds to it. */
  key: string;
  kind: SavingsTransactionKind;
  date: IsoDate;
  /** The rows behind the entry, ascending by id: one, or the several of a reallocation or a settlement. */
  rows: SavingsTransactionDto[];
  note: string | null;
  /** The closed month a settlement settles. null for every other kind. */
  settlesMonth: MonthKey | null;
  /**
   * A settlement entry that is the first of its month in the list, which is the newest: the one that
   * offers "Undo settlement". Undoing removes every settlement of the month, so it is offered once.
   */
  offersUndo: boolean;
}

function plainKey(row: SavingsTransactionDto): string {
  if (row.kind === 'reallocation' && row.groupId !== null) return `group-${row.groupId}`;
  return `row-${row.id}`;
}

/**
 * Groups the rows of the history, which the API lists newest first, into entries in the same order
 * (an entry sits where its first row sits). The two rows of a reallocation, found by `groupId`, make
 * one entry. So do the rows of one settlement: the same month, settled on the same day, in the same
 * direction (every allocation of a settlement has the sign of its amount), and each place at most
 * once (a settlement names a goal only once). Two settlements of one month made on one day (a
 * correction made right after the first settlement) therefore stay two entries unless nothing
 * tells them apart. A row whose partner is not in the list (a filter by goal leaves out the other
 * side of a reallocation) is an entry of its own.
 */
export function groupTransactions(rows: readonly SavingsTransactionDto[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  const byKey = new Map<string, HistoryEntry>();

  const open = (key: string, row: SavingsTransactionDto): HistoryEntry => {
    const entry: HistoryEntry = {
      key,
      kind: row.kind,
      date: row.date,
      rows: [row],
      note: row.note,
      settlesMonth: row.settlesMonth,
      offersUndo: false,
    };
    byKey.set(key, entry);
    entries.push(entry);
    return entry;
  };

  for (const row of rows) {
    if (row.kind === 'settlement' && row.settlesMonth !== null) {
      // The first group of this month, day and direction that does not have the place yet.
      const base = `settlement-${row.settlesMonth}-${row.date}-${row.amount < 0 ? 'out' : 'in'}`;
      let n = 0;
      let entry = byKey.get(`${base}-${n}`);
      while (entry && entry.rows.some((other) => other.goalId === row.goalId)) {
        n++;
        entry = byKey.get(`${base}-${n}`);
      }
      if (entry) entry.rows.push(row);
      else open(`${base}-${n}`, row);
      continue;
    }
    const key = plainKey(row);
    const existing = byKey.get(key);
    if (existing) existing.rows.push(row);
    else open(key, row);
  }

  const undoOffered = new Set<MonthKey>();
  for (const entry of entries) {
    entry.rows.sort((a, b) => a.id - b.id);
    if (entry.kind === 'settlement' && entry.settlesMonth && !undoOffered.has(entry.settlesMonth)) {
      undoOffered.add(entry.settlesMonth);
      entry.offersUndo = true;
    }
  }
  return entries;
}

/** What the API lets the user do with an entry: a settlement and the opening balance are never deleted. */
export function canDelete(entry: HistoryEntry): boolean {
  return entry.kind === 'deposit' || entry.kind === 'withdrawal' || entry.kind === 'reallocation';
}

/** How an entry names places, amounts and months. */
export interface EntryContext {
  /** A goal's name, or the words for unassigned savings (`null`). */
  place: (goalId: number | null) => string;
  /** Cents as currency, with a minus sign for a negative amount. */
  money: (cents: Cents) => string;
  /** A month as "September 2026". */
  month: (month: MonthKey) => string;
}

/** What an entry says about itself, in words. */
export interface EntryText {
  /** "Deposit to Holiday", "Moved €50.00 from Holiday to Unassigned savings". */
  title: string;
  /** What the entry did to its place, signed. null when the title or the slices say it. */
  amount: Cents | null;
  /** A settlement's allocations: where each part went (positive) or came from (negative). */
  slices: { place: string; amount: Cents }[];
}

/** The words for an entry. Amounts are shown as the rows carry them: nothing is worked out here. */
export function describeEntry(entry: HistoryEntry, context: EntryContext): EntryText {
  const [first, second] = entry.rows;
  switch (entry.kind) {
    case 'opening':
      return { title: 'Opening balance', amount: first.amount, slices: [] };
    case 'deposit':
      return {
        title: `Deposit to ${context.place(first.goalId)}`,
        amount: first.amount,
        slices: [],
      };
    case 'withdrawal':
      return {
        title: `Withdrawal from ${context.place(first.goalId)}`,
        amount: first.amount,
        slices: [],
      };
    case 'settlement':
      return {
        title: entry.settlesMonth ? `Settled ${context.month(entry.settlesMonth)}` : 'Settlement',
        amount: null,
        slices: entry.rows.map((row) => ({ place: context.place(row.goalId), amount: row.amount })),
      };
    case 'reallocation': {
      if (second) {
        // The row that gave the money is negative, the one that received it positive.
        const from = first.amount < 0 ? first : second;
        const to = first.amount < 0 ? second : first;
        return {
          title: `Moved ${context.money(Math.abs(to.amount))} from ${context.place(from.goalId)} to ${context.place(to.goalId)}`,
          amount: null,
          slices: [],
        };
      }
      // Only one side is in the list (a filter by goal): say what it did to that place.
      return {
        title:
          first.amount < 0
            ? `Moved out of ${context.place(first.goalId)}`
            : `Moved into ${context.place(first.goalId)}`,
        amount: first.amount,
        slices: [],
      };
    }
  }
}
