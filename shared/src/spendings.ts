import { z } from 'zod';
import type { Page } from './api';
import {
  MAX_TAGS_PER_SPENDING,
  SPENDINGS_DEFAULT_LIMIT,
  SPENDINGS_MAX_LIMIT,
  SPENDING_SEARCH_MAX_LENGTH,
} from './limits';
import type { Cents } from './money';
import type { IsoDate } from './month';
import {
  AT_LEAST_ONE_FIELD,
  descriptionSchema,
  hasAnyKey,
  idRefSchema,
  idSchema,
  isoDateSchema,
  monthKeySchema,
  nonZeroCentsSchema,
  notesSchema,
  queryCentsSchema,
} from './schemas';

// The constants live in './limits' (no zod); they are re-exported so existing imports keep working.
export {
  MAX_TAGS_PER_SPENDING,
  SPENDINGS_DEFAULT_LIMIT,
  SPENDINGS_MAX_LIMIT,
  SPENDING_SEARCH_MAX_LENGTH,
} from './limits';

/**
 * The `tagIds` of a create or an update: at most MAX_TAGS_PER_SPENDING ids, none twice (a repeated
 * id is a 400 validation_error at "tagIds.<i>", the index of its second occurrence). That every id
 * is a tag is 422 `unknown_tag`. The order they are sent in does not matter.
 */
const tagIdsSchema = z
  .array(idRefSchema)
  .max(MAX_TAGS_PER_SPENDING)
  .superRefine((ids, ctx) => {
    const seen = new Set<number>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        ctx.addIssue({ code: 'custom', message: 'Each tag may appear only once', path: [index] });
      }
      seen.add(id);
    });
  });

/**
 * POST /api/spendings body → 201 SpendingDto. Defaults: `description` = "", `notes` = null,
 * `tagIds` = []. 422 rule_violation, checked in this order: `unknown_budget` (field "budgetId"),
 * `before_start_month` (date before settings.startMonth, field "date"), `outside_active_months`
 * (date's month before the budget's startMonth or after its endMonth, field "date"), then
 * `unknown_tag` (field "tagIds.<i>": the first id, in the order sent, that is not a tag). The
 * spending and its tags are stored in one transaction.
 */
export const spendingCreateSchema = z.strictObject({
  /** The UI prefills it with `GET /api/today`. */
  date: isoDateSchema,
  /** Cents. Positive is a spending, negative is a refund into the budget. Never 0. */
  amount: nonZeroCentsSchema,
  budgetId: idRefSchema,
  /** 0 to 200 characters, may be empty. */
  description: descriptionSchema.optional(),
  notes: notesSchema.nullish(),
  /** The ids of its tags: at most 10, none twice. Omitted: no tags. */
  tagIds: tagIdsSchema.optional(),
});
export type SpendingCreateInput = z.infer<typeof spendingCreateSchema>;

/**
 * PATCH /api/spendings/:id body → 200 SpendingDto. Any subset of the create fields, at least one;
 * `notes: null` clears the notes. Errors, in this order: 404 not_found (unknown id), then the same
 * 422 rules as the create, checked against the resulting date and budget, with `unknown_tag` only
 * for a `tagIds` that is given. `tagIds` REPLACES the whole set of tags: `[]` removes every tag
 * and leaving it out keeps the tags as they are. The change is stored in one transaction.
 */
export const spendingUpdateSchema = z
  .strictObject({
    date: isoDateSchema.optional(),
    amount: nonZeroCentsSchema.optional(),
    budgetId: idRefSchema.optional(),
    description: descriptionSchema.optional(),
    notes: notesSchema.nullable().optional(),
    tagIds: tagIdsSchema.optional(),
  })
  .refine(hasAnyKey, AT_LEAST_ONE_FIELD);
export type SpendingUpdateInput = z.infer<typeof spendingUpdateSchema>;

/**
 * GET /api/spendings query → 200 SpendingsPage, newest first (date, then id, descending). No 409
 * or 422 rule applies: a bad query is a 400 validation_error. Filters combine with AND.
 * `month` and `from`/`to` (inclusive dates) are mutually exclusive, and `from` must not be after
 * `to`. `q` is 1 to 100 characters after trimming and matches a spending whose description OR
 * notes contain it, ignoring case for every alphabet (`café` finds `CAFÉ`): `%` and `_` are
 * ordinary characters. `tagId` keeps the spendings that carry that tag (each item still lists ALL
 * its tags). `minAmount` and `maxAmount` bound the SIGNED amount in cents as stored, both
 * inclusive, so refunds are negative: `minAmount` 0 hides the refunds and `maxAmount` -1 shows
 * only them. They are whole numbers written with digits and an optional "-" (a blank value is a
 * 400, not 0), and `minAmount` must not be greater than `maxAmount`. Defaults: limit 50 (1 to
 * 200), offset 0. An unknown budgetId or tagId just matches nothing.
 */
export const spendingListQuerySchema = z
  .strictObject({
    month: monthKeySchema.optional(),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    budgetId: idSchema.optional(),
    tagId: idSchema.optional(),
    q: z.string().trim().min(1).max(SPENDING_SEARCH_MAX_LENGTH).optional(),
    minAmount: queryCentsSchema.optional(),
    maxAmount: queryCentsSchema.optional(),
    limit: z.coerce.number().int().min(1).max(SPENDINGS_MAX_LIMIT).default(SPENDINGS_DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((q) => q.month === undefined || (q.from === undefined && q.to === undefined), {
    message: 'Use either month or from/to, not both',
    path: ['month'],
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: '`from` must not be after `to`',
    path: ['to'],
  })
  .refine(
    (q) => q.minAmount === undefined || q.maxAmount === undefined || q.minAmount <= q.maxAmount,
    {
      message: '`minAmount` must not be greater than `maxAmount`',
      path: ['maxAmount'],
    },
  );
/**
 * What a client may send (every key optional; defaults apply server side). The backend's parsed
 * value, with defaults applied, is `z.output<typeof spendingListQuerySchema>`.
 */
export type SpendingListQuery = Partial<z.infer<typeof spendingListQuerySchema>>;

/**
 * Item of GET /api/spendings → 200, and the response of POST (201) and PATCH (200)
 * /api/spendings. DELETE /api/spendings/:id → 204 (404 not_found for an unknown id): the tags of
 * the spending go with it, the tags themselves stay.
 */
export interface SpendingDto {
  id: number;
  date: IsoDate;
  /** Cents. Negative is a refund. */
  amount: Cents;
  budgetId: number;
  /** May be empty. */
  description: string;
  notes: string | null;
  /**
   * The ids of the spending's tags, ascending and each once; empty when it has none. The UI
   * resolves them to names and colors through `GET /api/tags`.
   */
  tagIds: number[];
}

/**
 * GET /api/spendings → 200: one page plus the net total of the whole filtered set. Every filter,
 * the search ones included, narrows `items`, `total` and `totalAmount` alike.
 */
export interface SpendingsPage extends Page<SpendingDto> {
  /** Sum of `amount` over ALL rows matching the filters, not just this page. Refunds subtract. */
  totalAmount: Cents;
}
