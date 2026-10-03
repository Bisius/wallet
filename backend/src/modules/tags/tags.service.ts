import type { TagCreateInput, TagDto, TagUpdateInput } from '@wallet/shared';
import { count, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { spendingTags, tags } from '../../db/schema';
import type { Deps } from '../../lib/deps';
import { apiError, notFound } from '../../lib/errors';
import { isSameName, nameCollator } from '../../lib/names';

type TagRow = typeof tags.$inferSelect;

/**
 * How many spendings carry each tag, for `ids` or for every tag, in one query. A tag that no
 * spending carries has no entry. (`spending_tags` has one row per spending and tag, so counting its
 * rows counts spendings.)
 */
function usageCounts(db: DbOrTx, ids?: readonly number[]): Map<number, number> {
  const rows = db
    .select({ tagId: spendingTags.tagId, uses: count() })
    .from(spendingTags)
    .where(ids ? inArray(spendingTags.tagId, [...ids]) : undefined)
    .groupBy(spendingTags.tagId)
    .all();
  return new Map(rows.map((row) => [row.tagId, row.uses]));
}

const toDto = (row: TagRow, usageCount: number): TagDto => ({
  id: row.id,
  name: row.name,
  color: row.color,
  usageCount,
});

/**
 * Tags as DTOs, ascending by name (ignoring case, see `nameCollator`) then id: all of them, or only
 * `ids`. Computed fresh from the stored rows, so a response always shows what is stored.
 */
export function loadTagDtos(db: DbOrTx, ids?: readonly number[]): TagDto[] {
  if (ids && ids.length === 0) return [];
  const only = ids ? [...ids] : undefined;
  const rows = db
    .select()
    .from(tags)
    .where(only ? inArray(tags.id, only) : undefined)
    .all();
  const uses = usageCounts(db, only);
  return rows
    .sort((a, b) => nameCollator.compare(a.name, b.name) || a.id - b.id)
    .map((row) => toDto(row, uses.get(row.id) ?? 0));
}

/** One tag as a DTO, or 404. */
function loadTagDto(db: DbOrTx, id: number): TagDto {
  const [dto] = loadTagDtos(db, [id]);
  if (!dto) throw notFound('Tag');
  return dto;
}

/**
 * A name made only of characters that `nameCollator` ignores (a zero-width space, a variation
 * selector, a bidi control, NUL, ...) is the empty name for the comparison. It still passes the
 * schema (`trim()` leaves it and the minimum length is met) and would show as an empty chip, so it
 * is refused like an empty name: the same 400 `validation_error` at "name" as the schema's. It
 * is a shape error, so it comes before every other check (the 404 of a PATCH, the 409). It lives
 * here and not in the shared schema, which cannot see the collator. Whitespace counts as invisible
 * too: `trim()` only strips it at the ends, and an invisible character at an end shields it.
 * A name that merely contains such a character next to real ones is fine.
 */
function assertNameVisible(name: string): void {
  if (isSameName(name.replace(/\s+/gu, ''), '')) {
    throw apiError('validation_error', 'Invalid request', [
      { path: 'name', message: 'Name is required' },
    ]);
  }
}

/**
 * `tag_name_taken`: no OTHER tag may have this name under `nameCollator`, the comparison that also
 * orders the list ("Groceries" and "groceries" clash, "Café" and "Cafe" do not). SQLite's unique
 * index on `tags.name` is case-sensitive, so it can only be a backstop. A tag never clashes with
 * itself, so changing only the capitalization of its own name is fine (`exceptId`).
 */
function assertNameFree(db: DbOrTx, name: string, exceptId?: number): void {
  const taken = db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .all()
    .find((tag) => tag.id !== exceptId && isSameName(tag.name, name));
  if (taken) {
    throw apiError('tag_name_taken', `Another tag is already called "${taken.name}"`);
  }
}

/** GET /api/tags */
export function listTags({ db }: Deps): TagDto[] {
  return loadTagDtos(db);
}

/** POST /api/tags: a new tag is carried by no spending. Rules, in order: 400, then 409. */
export function createTag({ db }: Deps, input: TagCreateInput): TagDto {
  assertNameVisible(input.name);
  assertNameFree(db, input.name);
  const row = db
    .insert(tags)
    .values({ name: input.name, color: input.color ?? null })
    .returning()
    .get();
  return toDto(row, 0);
}

/**
 * PATCH /api/tags/:id. Rules, in order: 400 for a name made only of invisible characters, 404, then
 * `tag_name_taken`. The name is only checked when it is given: a tag that already has a blank name
 * (an older row) can still be recolored, renamed or deleted.
 */
export function updateTag({ db }: Deps, id: number, input: TagUpdateInput): TagDto {
  if (input.name !== undefined) assertNameVisible(input.name);
  const current = db.select({ id: tags.id }).from(tags).where(eq(tags.id, id)).get();
  if (!current) throw notFound('Tag');
  if (input.name !== undefined) assertNameFree(db, input.name, id);

  db.update(tags).set(input).where(eq(tags.id, id)).run();
  return loadTagDto(db, id);
}

/**
 * DELETE /api/tags/:id. The tag leaves every spending that carries it through the foreign key
 * cascade of `spending_tags`; the spendings stay, and so does every figure.
 */
export function deleteTag({ db }: Deps, id: number): void {
  const removed = db.delete(tags).where(eq(tags.id, id)).returning({ id: tags.id }).all();
  if (removed.length === 0) throw notFound('Tag');
}
