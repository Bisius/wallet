import { z } from 'zod';
import { TAG_NAME_MAX_LENGTH } from './limits';
import { AT_LEAST_ONE_FIELD, colorSchema, hasAnyKey } from './schemas';

// The constant lives in './limits' (no zod); it is re-exported so import paths stay uniform.
export { TAG_NAME_MAX_LENGTH } from './limits';

/**
 * A tag name: trimmed, 1 to TAG_NAME_MAX_LENGTH (30) characters. That it is not taken is not
 * checked here but by the server: names are unique ignoring case (docs/DOMAIN.md, "Tags and
 * search"), else 409 `tag_name_taken`.
 */
export const tagNameSchema = z.string().trim().min(1, 'Name is required').max(TAG_NAME_MAX_LENGTH);

/**
 * POST /api/tags body → 201 TagDto (its `usageCount` is 0). Defaults: `color` = null. 409
 * `tag_name_taken` when another tag already has this name ignoring case ("Groceries" and
 * "groceries" clash, "Cafe" and "Café" do not). No 422 rule applies.
 */
export const tagCreateSchema = z.strictObject({
  name: tagNameSchema,
  /** A hex color such as "#3b82f6". */
  color: colorSchema.nullish(),
});
export type TagCreateInput = z.infer<typeof tagCreateSchema>;

/**
 * PATCH /api/tags/:id body → 200 TagDto. Any subset, at least one; `color: null` clears the
 * color, and the name can't be cleared. Errors, in this order: 404 not_found (unknown id), then
 * 409 `tag_name_taken` (another tag has this name ignoring case: changing only the capitalization
 * of the tag's own name is fine). A rename shows on every spending that carries the tag at once,
 * because spendings refer to tags by id. No 422 rule applies.
 */
export const tagUpdateSchema = z
  .strictObject({
    name: tagNameSchema.optional(),
    color: colorSchema.nullable().optional(),
  })
  .refine(hasAnyKey, AT_LEAST_ONE_FIELD);
export type TagUpdateInput = z.infer<typeof tagUpdateSchema>;

/**
 * GET /api/tags → 200 TagDto[], ascending by name ignoring case, then id (the order of the
 * subscription list; no 409 or 422 rule applies). Also the response of POST (201) and PATCH (200)
 * /api/tags. DELETE /api/tags/:id → 204 (404 not_found for an unknown id): it removes the tag from
 * every spending that carries it, and the spendings and every figure stay as they are.
 *
 * `SpendingDto.tagIds` refer to these ids, so the UI keeps this list to show names and colors.
 */
export interface TagDto {
  id: number;
  /** Trimmed, 1 to 30 characters, unique ignoring case. */
  name: string;
  /** A hex color such as "#3b82f6", or null. */
  color: string | null;
  /** How many spendings carry the tag. */
  usageCount: number;
}
