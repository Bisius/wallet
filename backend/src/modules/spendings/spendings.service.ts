import type {
  IsoDate,
  SpendingCreateInput,
  SpendingDto,
  SpendingUpdateInput,
  SpendingsPage,
  spendingListQuerySchema,
} from '@wallet/shared';
import { type SQL, and, asc, count, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { z } from 'zod';
import type { DbOrTx } from '../../db/client';
import { budgets, spendingTags, spendings, tags } from '../../db/schema';
import { type Deps, inTransaction } from '../../lib/deps';
import { notFound, ruleViolation } from '../../lib/errors';
import { FOLD_SQL_FUNCTION, foldText } from '../../lib/fold';
import { monthBounds, timestampOf } from '../../lib/today';
import { requireSettings } from '../settings/settings.service';
import { spendingRuleBreaks } from './spendings.rules';

type SpendingRow = typeof spendings.$inferSelect;

/** The parsed query of GET /api/spendings: the defaults (`limit`, `offset`) are applied. */
export type SpendingListFilters = z.output<typeof spendingListQuerySchema>;

const toDto = (row: SpendingRow, tagIds: readonly number[]): SpendingDto => ({
  id: row.id,
  date: row.date,
  amount: row.amount,
  budgetId: row.budgetId,
  description: row.description,
  notes: row.notes,
  tagIds: [...tagIds],
});

// -------------------------------------------------------------------------------------------------
// Tags of a spending
// -------------------------------------------------------------------------------------------------

/**
 * The tags of all `spendingIds` in ONE query: spending id → its tag ids, ascending. A spending
 * without tags has no entry.
 */
function loadTagIds(db: DbOrTx, spendingIds: readonly number[]): Map<number, number[]> {
  const byId = new Map<number, number[]>();
  if (spendingIds.length === 0) return byId;
  const rows = db
    .select({ spendingId: spendingTags.spendingId, tagId: spendingTags.tagId })
    .from(spendingTags)
    .where(inArray(spendingTags.spendingId, [...spendingIds]))
    .orderBy(asc(spendingTags.spendingId), asc(spendingTags.tagId))
    .all();
  for (const { spendingId, tagId } of rows) {
    const list = byId.get(spendingId);
    if (list) list.push(tagId);
    else byId.set(spendingId, [tagId]);
  }
  return byId;
}

/** DTOs of `rows`, in the same order. Their tags come from one query, not one per row. */
function toDtos(db: DbOrTx, rows: readonly SpendingRow[]): SpendingDto[] {
  const tagIds = loadTagIds(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toDto(row, tagIds.get(row.id) ?? []));
}

/** The DTO of one spending, with its tags as they are stored. */
const toDtoOf = (db: DbOrTx, row: SpendingRow): SpendingDto =>
  toDto(row, loadTagIds(db, [row.id]).get(row.id) ?? []);

/**
 * `unknown_tag`: every id of `tagIds` must be a tag. The field names the first one that is not, in
 * the order sent (`tagIds.<i>`). The caller has checked the budget and date rules first.
 */
function assertTagsExist(db: DbOrTx, tagIds: readonly number[]): void {
  if (tagIds.length === 0) return;
  const known = new Set(
    db
      .select({ id: tags.id })
      .from(tags)
      .where(inArray(tags.id, [...tagIds]))
      .all()
      .map((row) => row.id),
  );
  const index = tagIds.findIndex((id) => !known.has(id));
  if (index >= 0) {
    throw ruleViolation('unknown_tag', `Tag ${tagIds[index]} does not exist`, `tagIds.${index}`);
  }
}

/** Gives the spending these tags (they exist, none twice: `assertTagsExist` and the schema). */
function insertTags(db: DbOrTx, spendingId: number, tagIds: readonly number[]): void {
  if (tagIds.length === 0) return;
  db.insert(spendingTags)
    .values(tagIds.map((tagId) => ({ spendingId, tagId })))
    .run();
}

// -------------------------------------------------------------------------------------------------
// Rules
// -------------------------------------------------------------------------------------------------

/**
 * The rules a spending must satisfy, checked in the documented order and against the resulting
 * date and budget (so a PATCH is checked as a whole): `unknown_budget`, `before_start_month`, then
 * `outside_active_months`, the first one that applies is thrown. The check itself is
 * `spendingRuleBreaks`, which the CSV import shares. The fourth rule, `unknown_tag`, comes after
 * these (`assertTagsExist`).
 */
function assertSpendingAllowed(db: DbOrTx, target: { date: IsoDate; budgetId: number }): void {
  const budget = db.select().from(budgets).where(eq(budgets.id, target.budgetId)).get();
  const floor = requireSettings(db).startMonth;
  const [first] = spendingRuleBreaks(target, budget, floor);
  if (first) throw ruleViolation(first.rule, first.message, first.field);
}

// -------------------------------------------------------------------------------------------------
// Reading
// -------------------------------------------------------------------------------------------------

/**
 * `column` contains `needle`, a text already folded by `foldText`: both sides are folded the same
 * way, so the case is ignored in every alphabet (lib/fold.ts). `instr` is a plain substring
 * search, so `%` and `_` are ordinary characters. A NULL column (no notes) gives NULL, which never
 * matches.
 */
const containsFolded = (column: AnySQLiteColumn, needle: string): SQL =>
  sql`instr(${sql.raw(FOLD_SQL_FUNCTION)}(${column}), ${needle}) > 0`;

/**
 * GET /api/spendings: the filtered set, newest first (date, then id, descending), as one page plus
 * the net `totalAmount` over ALL rows matching the filters (not just this page). Every filter
 * combines with AND, the search ones (`q`, `tagId`, `minAmount`, `maxAmount`) included, and
 * narrows the page, `total` and `totalAmount` alike. Each item lists all its tags, whichever
 * `tagId` selected it.
 */
export function listSpendings({ db }: Deps, query: SpendingListFilters): SpendingsPage {
  const bounds = query.month ? monthBounds(query.month) : null;
  const needle = query.q === undefined ? undefined : foldText(query.q);
  const where = and(
    bounds ? gte(spendings.date, bounds.from) : undefined,
    bounds ? lte(spendings.date, bounds.to) : undefined,
    query.from ? gte(spendings.date, query.from) : undefined,
    query.to ? lte(spendings.date, query.to) : undefined,
    query.budgetId !== undefined ? eq(spendings.budgetId, query.budgetId) : undefined,
    query.tagId !== undefined
      ? inArray(
          spendings.id,
          db
            .select({ id: spendingTags.spendingId })
            .from(spendingTags)
            .where(eq(spendingTags.tagId, query.tagId)),
        )
      : undefined,
    // Description OR notes. Tag names are not searched: that is what `tagId` is for.
    needle !== undefined
      ? or(containsFolded(spendings.description, needle), containsFolded(spendings.notes, needle))
      : undefined,
    query.minAmount !== undefined ? gte(spendings.amount, query.minAmount) : undefined,
    query.maxAmount !== undefined ? lte(spendings.amount, query.maxAmount) : undefined,
  );

  const rows = db
    .select()
    .from(spendings)
    .where(where)
    .orderBy(desc(spendings.date), desc(spendings.id))
    .limit(query.limit)
    .offset(query.offset)
    .all();

  const totals = db
    .select({
      total: count(),
      totalAmount: sql<number>`coalesce(sum(${spendings.amount}), 0)`.mapWith(Number),
    })
    .from(spendings)
    .where(where)
    .get();

  return {
    items: toDtos(db, rows),
    total: totals?.total ?? 0,
    limit: query.limit,
    offset: query.offset,
    totalAmount: totals?.totalAmount ?? 0,
  };
}

// -------------------------------------------------------------------------------------------------
// Writing
// -------------------------------------------------------------------------------------------------

/** POST /api/spendings: the spending and its tags are stored in one transaction. */
export function createSpending(deps: Deps, input: SpendingCreateInput): SpendingDto {
  return inTransaction(deps, ({ db, clock }) => {
    assertSpendingAllowed(db, input);
    const tagIds = input.tagIds ?? [];
    assertTagsExist(db, tagIds);

    const now = timestampOf(clock);
    const row = db
      .insert(spendings)
      .values({
        date: input.date,
        amount: input.amount,
        budgetId: input.budgetId,
        description: input.description ?? '',
        notes: input.notes ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    insertTags(db, row.id, tagIds);
    return toDtoOf(db, row);
  });
}

/**
 * PATCH /api/spendings/:id. Errors, in order: 404, the budget and date rules against the resulting
 * values, then `unknown_tag` (only for a `tagIds` that is given). A given `tagIds` REPLACES the
 * whole set of tags (`[]` removes them all) and leaving it out keeps them. `updatedAt` is stamped
 * whichever part changed, tags included. Everything is one transaction: a request that fails
 * leaves the spending and its tags exactly as they were.
 */
export function updateSpending(deps: Deps, id: number, input: SpendingUpdateInput): SpendingDto {
  return inTransaction(deps, ({ db, clock }) => {
    const current = db.select().from(spendings).where(eq(spendings.id, id)).get();
    if (!current) throw notFound('Spending');

    assertSpendingAllowed(db, {
      date: input.date ?? current.date,
      budgetId: input.budgetId ?? current.budgetId,
    });
    // `tagIds` is not a column of `spendings`: it replaces the rows of `spending_tags`.
    const { tagIds, ...fields } = input;
    if (tagIds !== undefined) assertTagsExist(db, tagIds);

    const row = db
      .update(spendings)
      .set({ ...fields, updatedAt: timestampOf(clock) })
      .where(eq(spendings.id, id))
      .returning()
      .get();
    if (tagIds !== undefined) {
      db.delete(spendingTags).where(eq(spendingTags.spendingId, id)).run();
      insertTags(db, id, tagIds);
    }
    return toDtoOf(db, row);
  });
}

/** DELETE /api/spendings/:id. Its `spending_tags` rows go with it (foreign key cascade). */
export function deleteSpending({ db }: Deps, id: number): void {
  const removed = db
    .delete(spendings)
    .where(eq(spendings.id, id))
    .returning({ id: spendings.id })
    .all();
  if (removed.length === 0) throw notFound('Spending');
}
