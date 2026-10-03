import { type MonthKey, cleanImportText } from '@wallet/shared';
import { isNotNull } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { budgets, spendings } from '../../db/schema';
import { isWithinActiveMonths } from '../../lib/versioned';
import type { SpendingBudget } from '../spendings/spendings.rules';
import { normalizeImportText } from './import.file';

/**
 * What the importer needs to know about the stored data, read ONCE per request so that judging
 * 10,000 rows costs three queries and not one per row (docs/DOMAIN.md, "CSV import").
 */

/** Every budget by id, with what the rules of a spending read. */
export function loadBudgets(db: DbOrTx): Map<number, SpendingBudget> {
  return new Map(
    db
      .select({
        id: budgets.id,
        name: budgets.name,
        startMonth: budgets.startMonth,
        endMonth: budgets.endMonth,
      })
      .from(budgets)
      .all()
      .map(({ id, ...budget }) => [id, budget]),
  );
}

/**
 * The `importHash` of every stored spending that has one, in a Set: a row is a duplicate when its
 * hash is in it. One query and a membership test per row, never an `IN (...)` list.
 */
export function loadStoredHashes(db: DbOrTx): Set<string> {
  const hashes = new Set<string>();
  for (const { importHash } of db
    .select({ importHash: spendings.importHash })
    .from(spendings)
    .where(isNotNull(spendings.importHash))
    .all()) {
    if (importHash !== null) hashes.add(importHash);
  }
  return hashes;
}

/** How a budget has been used for one description: the figures that decide the suggestion. */
interface BudgetUse {
  budgetId: number;
  count: number;
  latestDate: string;
  latestId: number;
}

/** True when `a` is a better suggestion than `b`: more uses, then the latest date, then the highest id. */
const isBetterUse = (a: BudgetUse, b: BudgetUse): boolean =>
  a.count !== b.count
    ? a.count > b.count
    : a.latestDate !== b.latestDate
      ? a.latestDate > b.latestDate
      : a.latestId > b.latestId;

/**
 * Suggests a budget for the description of a row (docs/DOMAIN.md, "Suggested budget"): the budget
 * most often used by the stored spendings with the same normalized description, ties broken by the
 * most recent use (the latest date, then the highest id), and only when that budget is active in
 * the month of the row's date. It never falls back to the second most used budget.
 */
export interface BudgetSuggester {
  suggest(normalizedDescription: string, month: MonthKey): number | null;
}

/**
 * Builds the suggester in ONE pass over the spendings: description (normalized the same way as the
 * file's) to budget use, then each description's winner. Every stored spending counts, whatever its
 * date and whether it was imported or entered by hand. The budgets' active months are the ones
 * loaded once by the caller.
 */
export function loadSuggester(
  db: DbOrTx,
  budgetsById: ReadonlyMap<number, SpendingBudget>,
): BudgetSuggester {
  const rows = db
    .select({
      id: spendings.id,
      budgetId: spendings.budgetId,
      date: spendings.date,
      description: spendings.description,
    })
    .from(spendings)
    .all();

  // Bank descriptions repeat a lot ("SPOTIFY", "LIDL ..."): normalize each distinct text once.
  const normalized = new Map<string, string>();
  const usesByDescription = new Map<string, Map<number, BudgetUse>>();
  for (const row of rows) {
    let key = normalized.get(row.description);
    if (key === undefined) {
      key = normalizeImportText(cleanImportText(row.description));
      normalized.set(row.description, key);
    }
    if (key === '') continue; // a spending with no description is nobody's evidence

    let uses = usesByDescription.get(key);
    if (!uses) usesByDescription.set(key, (uses = new Map()));
    const use = uses.get(row.budgetId);
    if (!use) {
      uses.set(row.budgetId, {
        budgetId: row.budgetId,
        count: 1,
        latestDate: row.date,
        latestId: row.id,
      });
    } else {
      use.count++;
      if (row.date > use.latestDate || (row.date === use.latestDate && row.id > use.latestId)) {
        use.latestDate = row.date;
        use.latestId = row.id;
      }
    }
  }

  const winners = new Map<string, number>();
  for (const [key, uses] of usesByDescription) {
    let best: BudgetUse | undefined;
    for (const use of uses.values()) if (!best || isBetterUse(use, best)) best = use;
    if (best) winners.set(key, best.budgetId);
  }

  return {
    suggest(normalizedDescription, month) {
      const budgetId = winners.get(normalizedDescription);
      if (budgetId === undefined) return null;
      const budget = budgetsById.get(budgetId);
      return budget && isWithinActiveMonths(budget.startMonth, budget.endMonth, month)
        ? budgetId
        : null;
    },
  };
}
