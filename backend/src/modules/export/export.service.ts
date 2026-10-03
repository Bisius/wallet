import {
  EXPORT_COLUMNS,
  EXPORT_INCOMES_COLUMNS,
  EXPORT_SAVINGS_COLUMNS,
  EXPORT_SPENDINGS_COLUMNS,
  EXPORT_TAG_SEPARATOR,
  EXPORT_TEXT_COLUMNS,
  type ExportKind,
  type ExportQuery,
  encodeCsv,
  formatCentsPlain,
  guardCsvText,
} from '@wallet/shared';
import { type SQL, and, asc, eq, gte, lte } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import {
  budgets,
  incomes,
  savingsGoals,
  savingsTransactions,
  spendingTags,
  spendings,
  tags,
} from '../../db/schema';
import type { Deps } from '../../lib/deps';
import { nameCollator } from '../../lib/names';

/** One row of an export: the text of every column, keyed by the column's name in the contract. */
type ExportRow<Columns extends readonly string[]> = Record<Columns[number], string>;

/**
 * The whole file of an export: the BOM, the header row of the contract, then the rows with their
 * cells in the order of the contract (`EXPORT_COLUMNS`). The TEXT columns (`EXPORT_TEXT_COLUMNS`)
 * go through the formula-injection guard, each as a whole. Every other cell is written as it is:
 * an amount may begin with "-" and must stay a number. Typing a row by its column names makes a
 * missing or misspelled column a compile error.
 */
function toCsv<Kind extends ExportKind>(
  kind: Kind,
  rows: readonly ExportRow<(typeof EXPORT_COLUMNS)[Kind]>[],
): string {
  const columns: readonly string[] = EXPORT_COLUMNS[kind];
  const textColumns: readonly string[] = EXPORT_TEXT_COLUMNS[kind];
  const cells = (row: Record<string, string>): string[] =>
    columns.map((column) => {
      const value = row[column] ?? '';
      return textColumns.includes(column) ? guardCsvText(value) : value;
    });
  return encodeCsv([columns, ...rows.map((row) => cells(row))]);
}

/**
 * `from` and `to` are inclusive and optional. Dates are `YYYY-MM-DD` text, so comparing strings
 * compares dates. Every export lists its rows ascending by date, then id (the API lists show the
 * newest first), so that a spreadsheet reads as time passes.
 */
const inRange = (
  column: typeof spendings.date | typeof incomes.date | typeof savingsTransactions.date,
  { from, to }: ExportQuery,
): (SQL | undefined)[] => [
  from !== undefined ? gte(column, from) : undefined,
  to !== undefined ? lte(column, to) : undefined,
];

/**
 * The names of the tags of the spendings in range, spending id to the joined `tags` cell: the names
 * ascending under the tag-name comparison, then by id, joined by "|". ONE query for all of them
 * (a join, not an `IN` list of ids), so a range of tens of thousands of spendings costs one read.
 */
function tagCellsOf(db: DbOrTx, query: ExportQuery): Map<number, string> {
  const links = db
    .select({ spendingId: spendingTags.spendingId, tagId: tags.id, name: tags.name })
    .from(spendingTags)
    .innerJoin(tags, eq(tags.id, spendingTags.tagId))
    .innerJoin(spendings, eq(spendings.id, spendingTags.spendingId))
    .where(and(...inRange(spendings.date, query)))
    .all();

  const bySpending = new Map<number, { id: number; name: string }[]>();
  for (const { spendingId, tagId, name } of links) {
    const list = bySpending.get(spendingId);
    if (list) list.push({ id: tagId, name });
    else bySpending.set(spendingId, [{ id: tagId, name }]);
  }
  return new Map(
    [...bySpending].map(([spendingId, list]) => [
      spendingId,
      list
        .sort((a, b) => nameCollator.compare(a.name, b.name) || a.id - b.id)
        .map((tag) => tag.name)
        .join(EXPORT_TAG_SEPARATOR),
    ]),
  );
}

/** GET /api/export/spendings.csv: every spending in range with the names of its budget and tags. */
export function exportSpendings({ db }: Deps, query: ExportQuery): string {
  const rows = db
    .select({
      id: spendings.id,
      date: spendings.date,
      amount: spendings.amount,
      budget: budgets.name,
      description: spendings.description,
      notes: spendings.notes,
    })
    .from(spendings)
    .innerJoin(budgets, eq(budgets.id, spendings.budgetId))
    .where(and(...inRange(spendings.date, query)))
    .orderBy(asc(spendings.date), asc(spendings.id))
    .all();
  const tagCells = tagCellsOf(db, query);

  return toCsv(
    'spendings',
    rows.map((row): ExportRow<typeof EXPORT_SPENDINGS_COLUMNS> => ({
      id: String(row.id),
      date: row.date,
      amount: formatCentsPlain(row.amount),
      budget: row.budget,
      description: row.description,
      notes: row.notes ?? '',
      tags: tagCells.get(row.id) ?? '',
    })),
  );
}

/** GET /api/export/incomes.csv: the extra, one-off incomes in range (the salary is not a dated row). */
export function exportIncomes({ db }: Deps, query: ExportQuery): string {
  const rows = db
    .select()
    .from(incomes)
    .where(and(...inRange(incomes.date, query)))
    .orderBy(asc(incomes.date), asc(incomes.id))
    .all();

  return toCsv(
    'incomes',
    rows.map((row): ExportRow<typeof EXPORT_INCOMES_COLUMNS> => ({
      id: String(row.id),
      date: row.date,
      amount: formatCentsPlain(row.amount),
      description: row.description,
    })),
  );
}

/** GET /api/export/savings.csv: every savings transaction in range, of every kind, signed as stored. */
export function exportSavings({ db }: Deps, query: ExportQuery): string {
  const rows = db
    .select({
      id: savingsTransactions.id,
      date: savingsTransactions.date,
      kind: savingsTransactions.kind,
      amount: savingsTransactions.amount,
      goalId: savingsTransactions.goalId,
      goal: savingsGoals.name,
      settlesMonth: savingsTransactions.settlesMonth,
      note: savingsTransactions.note,
      groupId: savingsTransactions.groupId,
    })
    .from(savingsTransactions)
    .leftJoin(savingsGoals, eq(savingsGoals.id, savingsTransactions.goalId))
    .where(and(...inRange(savingsTransactions.date, query)))
    .orderBy(asc(savingsTransactions.date), asc(savingsTransactions.id))
    .all();

  return toCsv(
    'savings',
    rows.map((row): ExportRow<typeof EXPORT_SAVINGS_COLUMNS> => ({
      id: String(row.id),
      date: row.date,
      kind: row.kind,
      amount: formatCentsPlain(row.amount),
      goal_id: row.goalId === null ? '' : String(row.goalId),
      goal: row.goal ?? '',
      settles_month: row.settlesMonth ?? '',
      note: row.note ?? '',
      group_id: row.groupId === null ? '' : String(row.groupId),
    })),
  );
}
