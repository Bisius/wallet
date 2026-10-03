/**
 * Tags and search against a naive reference (`testing/search-model.ts`), written from the doc and
 * independent of the implementation: random spendings, tags and filters, every filter AND-ed, the
 * order, `limit` and `offset` with `total` and `totalAmount`, the full tag list of each item, signed
 * amount bounds, `%` and `_`, and what happens to all of it when spendings and tags are changed.
 *
 * The text is drawn from a restricted alphabet where `toLowerCase()` is the ground truth for
 * "ignoring case"; what falls outside it (other alphabets, characters with several forms) is in the
 * hand-picked tables below, each answer written down by hand.
 *
 * Fixed seed (see testing/prop.ts), reproduce with the seed and the counterexample fast-check prints.
 */
import * as fc from 'fast-check';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { addBudget, addSpending, addTag, mutableClock, onboard } from '../../testing/helpers';
import { SLOW, boundedConfig, coverage, diff, failIfAny } from '../../testing/prop';
import { type Answer, call, send, serve, stop } from '../../testing/prop-api';
import {
  type RefQuery,
  type RefSpending,
  type RefTag,
  isValidQuery,
  queryString,
  recase,
  sameName,
  searchReference,
  tagListReference,
  textArb,
} from '../../testing/search-model';
import { createTestApp } from '../../testing/test-app';

const MONTHS = ['2026-01', '2026-02', '2026-03'];
/** Dates around the ends of the months, so that month, from and to cut between neighbours. */
const DATES = [
  '2026-01-01',
  '2026-01-31',
  '2026-02-01',
  '2026-02-15',
  '2026-02-28',
  '2026-03-01',
  '2026-03-31',
];
const AMOUNTS = [-5000, -250, -1, 1, 7, 100, 250, 1234, 5000, 12345];
/** Bounds for minAmount and maxAmount: the amounts above and the values right beside them and 0. */
const BOUNDS = [-5001, -5000, -250, -249, -1, 0, 1, 7, 100, 250, 1234, 5000, 12345, 12346];

// -------------------------------------------------------------------------------------------------
// Operations
// -------------------------------------------------------------------------------------------------

type QuerySel =
  | {
      k: 'sub';
      of: number;
      /** Where the piece is cut from: the description or the notes (when a spending has any). */
      from: 'description' | 'notes';
      start: number;
      len: number;
      bits: number;
      pad: boolean;
    }
  | { k: 'free'; text: string; bits: number; pad: boolean }
  | { k: 'wild'; text: string; pad: boolean }
  | { k: 'blank' };

interface QueryOp {
  t: 'query';
  /**
   * A spending the filters are derived from, so that the query is meant to find it: its month, its
   * budget, one of its tags, a piece of its text and amounts on either side of it. Without one the
   * filters are drawn at random.
   */
  target: number | undefined;
  month: number | undefined;
  from: number | undefined;
  to: number | undefined;
  budget: number | undefined;
  tag: number | undefined;
  /**
   * With `tag`: the tag filter names a tag that is gone (deleted) or never existed, instead of one
   * there is. "An unknown tag matches nothing", however much else the query would match.
   */
  deadTag: boolean;
  q: QuerySel | undefined;
  min: number | undefined;
  max: number | undefined;
  limit: number | undefined;
  offset: number | undefined;
}

/** What can be wrong with the tags of a request: an id that is no tag (where, and a second), or a repeated id. */
interface TagFault {
  unknownTag: boolean;
  /** Where in the list the unknown id goes. */
  at: number;
  twoUnknown: boolean;
  dupTag: boolean;
}

type SOp =
  | ({
      t: 'add';
      date: number;
      amount: number;
      budget: number;
      description: string;
      notes: string | null | undefined;
      tags: number[];
    } & TagFault)
  | ({
      t: 'patch';
      i: number;
      date: number | undefined;
      amount: number | undefined;
      budget: number | undefined;
      description: string | undefined;
      notes: string | null | undefined;
      tags: number[] | undefined;
    } & TagFault)
  | { t: 'delete'; i: number }
  /** `clash`: the name is that of an existing tag in another case (a name that is taken). */
  | { t: 'addTag'; name: string; color: boolean; clash: boolean; i: number; bits: number }
  | { t: 'renameTag'; i: number; name: string; clash: boolean; j: number; bits: number }
  | { t: 'deleteTag'; i: number }
  | QueryOp;

const nat = (max: number) => fc.nat(max);
/** Absent `absent` times out of `absent + 1`: a filter is present in a query only now and then. */
const maybe = <T>(arb: fc.Arbitrary<T>, absent = 1): fc.Arbitrary<T | undefined> =>
  fc.oneof(
    { weight: absent, arbitrary: fc.constant<T | undefined>(undefined) },
    { weight: 1, arbitrary: arb },
  );
const notesArb: fc.Arbitrary<string | null | undefined> = fc.oneof(
  { weight: 3, arbitrary: fc.constant(undefined) },
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 4, arbitrary: textArb(10).filter((text) => text !== '') },
);
const tagIndexes = fc.array(nat(5), { maxLength: 4 });

const queryArb: fc.Arbitrary<QueryOp> = fc.record({
  t: fc.constant('query' as const),
  target: maybe(nat(99), 1),
  month: maybe(nat(3), 3), // 3 is a month nothing is dated in
  from: maybe(nat(DATES.length - 1), 3),
  to: maybe(nat(DATES.length - 1), 3),
  budget: maybe(nat(2), 3), // 2 is a budget that does not exist
  tag: maybe(nat(6), 2), // an index counts around the tags there are
  deadTag: fc.boolean(), // one tag filter in two names a tag that is no tag
  q: maybe(
    fc.oneof(
      {
        weight: 6,
        arbitrary: fc.record({
          k: fc.constant('sub' as const),
          of: nat(99),
          from: fc.constantFrom('description' as const, 'notes' as const),
          start: nat(30),
          len: fc.integer({ min: 1, max: 6 }),
          bits: nat(2 ** 20),
          pad: fc.boolean(),
        }),
      },
      {
        weight: 3,
        arbitrary: fc.record({
          k: fc.constant('free' as const),
          text: textArb(4).filter((text) => text !== ''),
          bits: nat(2 ** 20),
          pad: fc.boolean(),
        }),
      },
      {
        weight: 3,
        arbitrary: fc.record({
          k: fc.constant('wild' as const),
          text: fc.constantFrom('%', '_', '%_', '_%', 'a%', '%a', 'a_', '_b', '% ', ' _'),
          pad: fc.boolean(),
        }),
      },
      { weight: 1, arbitrary: fc.constant<QuerySel>({ k: 'blank' }) },
    ),
    2,
  ),
  min: maybe(fc.constantFrom(...BOUNDS), 3),
  max: maybe(fc.constantFrom(...BOUNDS), 3),
  limit: maybe(fc.constantFrom(1, 2, 3, 5, 50, 200, 0, 201), 2),
  offset: maybe(fc.constantFrom(0, 1, 2, 5, 40, -1), 2),
});

const rarely = fc.constantFrom(
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  true,
);

const tagFaultArbs = {
  unknownTag: rarely,
  at: nat(9),
  twoUnknown: rarely,
  dupTag: rarely,
};

const addArb = fc.record({
  t: fc.constant('add' as const),
  date: nat(DATES.length - 1),
  amount: fc.constantFrom(...AMOUNTS),
  budget: nat(1),
  description: textArb(12),
  notes: notesArb,
  tags: tagIndexes,
  ...tagFaultArbs,
});

const opArb: fc.Arbitrary<SOp> = fc.oneof(
  { weight: 30, arbitrary: addArb },
  {
    weight: 10,
    arbitrary: fc.record({
      t: fc.constant('patch' as const),
      i: nat(99),
      date: maybe(nat(DATES.length - 1)),
      amount: maybe(fc.constantFrom(...AMOUNTS)),
      budget: maybe(nat(1)),
      description: maybe(textArb(12)),
      notes: notesArb,
      tags: maybe(tagIndexes),
      ...tagFaultArbs,
    }),
  },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('delete' as const), i: nat(99) }) },
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant('addTag' as const),
      name: textArb(4).filter((name) => name !== ''),
      color: fc.boolean(),
      clash: rarely,
      i: nat(99),
      bits: nat(2 ** 20),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant('renameTag' as const),
      i: nat(99),
      name: textArb(4).filter((name) => name !== ''),
      clash: fc.constantFrom(false, false, true),
      j: nat(99),
      bits: nat(2 ** 20),
    }),
  },
  { weight: 5, arbitrary: fc.record({ t: fc.constant('deleteTag' as const), i: nat(99) }) },
  { weight: 36, arbitrary: queryArb },
);

// -------------------------------------------------------------------------------------------------
// Running a sequence
// -------------------------------------------------------------------------------------------------

interface Model {
  tags: RefTag[];
  spendings: RefSpending[];
  /** Tag ids that were deleted, so that "a tag that is gone" can be named. */
  gone: number[];
}

const pick = <T>(items: readonly T[], i: number): T | undefined =>
  items.length === 0 ? undefined : items[i % items.length];

/** The ids of the tags a list of indexes stands for, each once, ascending. */
function tagIdsOf(model: Model, indexes: readonly number[]): number[] {
  const ids = indexes
    .map((index) => pick(model.tags, index)?.id)
    .filter((id): id is number => id !== undefined);
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** The ids in the order sent, with a tag that does not exist put first or last. */
const missingTagId = (model: Model): number =>
  Math.max(0, ...model.tags.map((t) => t.id), ...model.gone) + 1;

/**
 * The ids to send for a spending's tags and what the doc says of them: the ids in an order of their own
 * (not ascending), with an id that is no tag put in and one repeated if the fault says so. A repeated
 * id is a 400 (at the index of its second occurrence), an id that is no tag a 422 `unknown_tag` at the
 * index of the FIRST one in the order sent, and the schema is checked before the rules.
 */
function tagsToSend(
  model: Model,
  ids: readonly number[],
  fault: TagFault,
): {
  sent: number[];
  verdict: { status: 'ok' } | { status: 400 } | { status: 422; field: string };
} {
  const sent = [...ids].reverse();
  if (fault.unknownTag) {
    sent.splice(fault.at % (sent.length + 1), 0, missingTagId(model));
    if (fault.twoUnknown) sent.push(missingTagId(model) + 1);
  }
  if (fault.dupTag && sent.length > 0) sent.push(sent[0]!);
  if (new Set(sent).size !== sent.length) return { sent, verdict: { status: 400 } };
  const known = new Set(model.tags.map((tag) => tag.id));
  const first = sent.findIndex((id) => !known.has(id));
  if (first >= 0) return { sent, verdict: { status: 422, field: `tagIds.${first}` } };
  return { sent, verdict: { status: 'ok' } };
}

function resolveQuery(model: Model, op: QueryOp): RefQuery {
  const query: RefQuery = {};
  const base = op.target === undefined ? undefined : pick(model.spendings, op.target);
  if (op.month !== undefined)
    query.month = base ? base.date.slice(0, 7) : (MONTHS[op.month] ?? '2026-04');
  if (op.from !== undefined) {
    const from = base
      ? pick(
          DATES.filter((date) => date <= base.date),
          op.from,
        )
      : DATES[op.from];
    if (from !== undefined) query.from = from;
  }
  if (op.to !== undefined) {
    const to = base
      ? pick(
          DATES.filter((date) => date >= base.date),
          op.to,
        )
      : DATES[op.to];
    if (to !== undefined) query.to = to;
  }
  if (op.budget !== undefined) {
    query.budgetId = base ? base.budgetId : op.budget + 1 === 3 ? 99 : op.budget + 1;
  }
  if (op.tag !== undefined) {
    let id: number | undefined;
    if (op.deadTag) {
      // A tag that was deleted (when there is one and the index says so) or that never existed.
      id = (op.tag % 3 === 0 ? undefined : pick(model.gone, op.tag)) ?? missingTagId(model);
    } else {
      id = base ? pick(base.tagIds, op.tag) : (pick(model.tags, op.tag)?.id ?? missingTagId(model));
    }
    if (id !== undefined) query.tagId = id;
  }
  if (op.min !== undefined) {
    const min = base
      ? pick(
          BOUNDS.filter((bound) => bound <= base.amount),
          Math.abs(op.min),
        )
      : op.min;
    if (min !== undefined) query.minAmount = min;
  }
  if (op.max !== undefined) {
    const max = base
      ? pick(
          BOUNDS.filter((bound) => bound >= base.amount),
          Math.abs(op.max),
        )
      : op.max;
    if (max !== undefined) query.maxAmount = max;
  }
  if (op.limit !== undefined) query.limit = op.limit;
  if (op.offset !== undefined) query.offset = op.offset;
  if (op.q !== undefined) {
    const sel = op.q;
    if (sel.k === 'blank') query.q = '   ';
    else if (sel.k === 'wild') query.q = sel.pad ? `  ${sel.text}  ` : sel.text;
    else if (sel.k === 'free') {
      const text = recase(sel.text, sel.bits);
      query.q = sel.pad ? `  ${text} ` : text;
    } else {
      // A piece of the description or the notes of a spending (the target's, if there is one), in
      // another case.
      const from = base ? [base] : model.spendings;
      const withNotes = from.filter((s) => s.notes !== null && s.notes !== '');
      const source =
        (sel.from === 'notes' ? pick(withNotes, sel.of)?.notes : undefined) ??
        pick(from, sel.of)?.description ??
        'a';
      const start = sel.start % source.length;
      const piece = recase(source.slice(start, start + sel.len), sel.bits);
      query.q = sel.pad ? ` ${piece}  ` : piece;
      if (piece.trim() === '') query.q = 'a';
    }
  }
  return query;
}

async function run(
  setup: { server: Server },
  ops: readonly SOp[],
  cov: ReturnType<typeof coverage<string>>,
) {
  const { server } = setup;
  const model: Model = { tags: [], spendings: [], gone: [] };
  const trail: string[] = [];

  const tagsProblems = async (): Promise<string[]> =>
    diff(
      await send(server, 'get', '/api/tags'),
      tagListReference(model.tags, model.spendings),
      'GET /api/tags',
    );
  const bodyOf = (
    op: Extract<SOp, { t: 'add' }>,
    sent: readonly number[],
  ): Record<string, unknown> => ({
    date: DATES[op.date],
    amount: op.amount,
    budgetId: op.budget + 1,
    description: op.description,
    ...(op.notes === undefined ? {} : { notes: op.notes }),
    ...(sent.length === 0 && op.tags.length % 2 === 0 ? {} : { tagIds: sent }),
  });

  for (const [step, op] of ops.entries()) {
    const label = `step ${step + 1} of ${ops.length}: ${JSON.stringify(op)}`;
    try {
      switch (op.t) {
        case 'add': {
          const { sent, verdict } = tagsToSend(model, tagIdsOf(model, op.tags), op);
          const body = bodyOf(op, sent);
          const answer = await call(server, 'post', '/api/spendings', body);
          if (verdict.status === 422) {
            failIfAny(
              [
                ...(answer.status === 422 ? [] : [`status ${answer.status}`]),
                ...diff(
                  answer.body?.error?.details,
                  { rule: 'unknown_tag', field: verdict.field },
                  'details',
                ),
              ],
              'an unknown tag',
            );
            cov.hit('add refused unknown_tag');
          } else if (verdict.status === 400) {
            failIfAny(
              answer.status === 400 && answer.body?.error?.code === 'validation_error'
                ? []
                : [`answered ${answer.status} ${JSON.stringify(answer.body)}`],
              'a tag twice',
            );
            cov.hit('add refused: a tag twice');
          } else {
            if (answer.status !== 201)
              throw new Error(`answered ${answer.status} ${JSON.stringify(answer.body)}`);
            const made: RefSpending = {
              id: answer.body.id,
              date: body['date'] as string,
              amount: op.amount,
              budgetId: op.budget + 1,
              description: op.description,
              notes: op.notes ?? null,
              tagIds: tagIdsOf(model, op.tags),
            };
            failIfAny(diff(answer.body, made, 'the spending stored'), 'POST /api/spendings');
            model.spendings.push(made);
            cov.hit('add accepted');
            if (made.tagIds.length > 1) cov.hit('a spending with several tags');
          }
          break;
        }

        case 'patch': {
          const target = pick(model.spendings, op.i);
          if (!target) break;
          const body: Record<string, unknown> = {
            ...(op.date === undefined ? {} : { date: DATES[op.date] }),
            ...(op.amount === undefined ? {} : { amount: op.amount }),
            ...(op.budget === undefined ? {} : { budgetId: op.budget + 1 }),
            ...(op.description === undefined ? {} : { description: op.description }),
            ...(op.notes === undefined ? {} : { notes: op.notes }),
          };
          let tagIds: number[] | undefined;
          const faulty = op.unknownTag || op.dupTag;
          const { sent, verdict } = tagsToSend(
            model,
            op.tags === undefined ? [] : tagIdsOf(model, op.tags),
            op,
          );
          if (op.tags !== undefined || (faulty && sent.length > 0)) {
            if (op.tags !== undefined) tagIds = tagIdsOf(model, op.tags);
            body['tagIds'] = sent;
          }
          if (Object.keys(body).length === 0) body['amount'] = target.amount;
          // Only a request that carries tagIds can be refused for them.
          const refusal = 'tagIds' in body ? verdict : ({ status: 'ok' } as const);
          const answer = await call(server, 'patch', `/api/spendings/${target.id}`, body);
          if (refusal.status === 422) {
            failIfAny(
              [
                ...(answer.status === 422 ? [] : [`status ${answer.status}`]),
                ...diff(
                  answer.body?.error?.details,
                  { rule: 'unknown_tag', field: refusal.field },
                  'details',
                ),
              ],
              'an unknown tag on an update',
            );
            cov.hit('patch refused unknown_tag');
          } else if (refusal.status === 400) {
            failIfAny(
              answer.status === 400 && answer.body?.error?.code === 'validation_error'
                ? []
                : [`answered ${answer.status} ${JSON.stringify(answer.body)}`],
              'a tag twice on an update',
            );
            cov.hit('patch refused: a tag twice');
          } else {
            if (answer.status !== 200)
              throw new Error(`answered ${answer.status} ${JSON.stringify(answer.body)}`);
            Object.assign(target, {
              ...(body['date'] === undefined ? {} : { date: body['date'] }),
              ...(body['amount'] === undefined ? {} : { amount: body['amount'] }),
              ...(body['budgetId'] === undefined ? {} : { budgetId: body['budgetId'] }),
              ...(body['description'] === undefined ? {} : { description: body['description'] }),
              ...('notes' in body ? { notes: (body['notes'] as string | null) ?? null } : {}),
              ...(tagIds === undefined ? {} : { tagIds }),
            });
            failIfAny(diff(answer.body, target, 'the spending stored'), 'PATCH /api/spendings/:id');
            cov.hit(
              tagIds === undefined ? 'patch accepted, tags kept' : 'patch accepted, tags replaced',
            );
            if (tagIds?.length === 0) cov.hit('patch accepted, tags cleared');
          }
          break;
        }

        case 'delete': {
          const target = pick(model.spendings, op.i);
          if (!target) break;
          await send(server, 'delete', `/api/spendings/${target.id}`, undefined, 204);
          model.spendings = model.spendings.filter((s) => s.id !== target.id);
          cov.hit('delete');
          break;
        }

        case 'addTag': {
          // A name that is taken: the name of a tag there is, in other capitals.
          const taken = op.clash ? pick(model.tags, op.i) : undefined;
          const name = taken ? recase(taken.name, op.bits) : op.name;
          const answer = await call(server, 'post', '/api/tags', {
            name: ` ${name} `,
            ...(op.color ? { color: '#A1B2C3' } : {}),
          });
          const clash = model.tags.some((tag) => sameName(tag.name, name));
          if (clash) {
            failIfAny(
              answer.status === 409 && answer.body?.error?.code === 'tag_name_taken'
                ? []
                : [`answered ${answer.status} ${JSON.stringify(answer.body)}`],
              'a name that is taken',
            );
            cov.hit('addTag refused tag_name_taken');
          } else {
            if (answer.status !== 201)
              throw new Error(`answered ${answer.status} ${JSON.stringify(answer.body)}`);
            model.tags.push({
              id: answer.body.id,
              name,
              color: op.color ? '#a1b2c3' : null,
            });
            cov.hit('addTag accepted');
          }
          break;
        }

        case 'renameTag': {
          const target = pick(model.tags, op.i);
          if (!target) break;
          // A name that is taken by another tag, in other capitals; or the tag's own name in other
          // capitals, which is allowed.
          const other = op.clash
            ? pick(
                model.tags.filter((tag) => tag.id !== target.id),
                op.j,
              )
            : undefined;
          const name = other ? recase(other.name, op.bits) : op.name;
          const answer = await call(server, 'patch', `/api/tags/${target.id}`, { name });
          const clash = model.tags.some((tag) => tag.id !== target.id && sameName(tag.name, name));
          if (clash) {
            failIfAny(
              answer.status === 409
                ? []
                : [`answered ${answer.status} ${JSON.stringify(answer.body)}`],
              'a name that is taken',
            );
            cov.hit('renameTag refused tag_name_taken');
          } else {
            if (answer.status !== 200)
              throw new Error(`answered ${answer.status} ${JSON.stringify(answer.body)}`);
            target.name = name;
            cov.hit('renameTag accepted');
          }
          break;
        }

        case 'deleteTag': {
          const target = pick(model.tags, op.i);
          if (!target) break;
          await send(server, 'delete', `/api/tags/${target.id}`, undefined, 204);
          model.tags = model.tags.filter((tag) => tag.id !== target.id);
          model.gone.push(target.id);
          for (const s of model.spendings) s.tagIds = s.tagIds.filter((id) => id !== target.id);
          cov.hit('deleteTag');
          break;
        }

        case 'query': {
          const query = resolveQuery(model, op);
          const answer: Answer = await call(server, 'get', `/api/spendings${queryString(query)}`);
          if (!isValidQuery(query)) {
            failIfAny(
              answer.status === 400 && answer.body?.error?.code === 'validation_error'
                ? []
                : [`answered ${answer.status} ${JSON.stringify(answer.body)}`],
              `a bad query ${queryString(query)}`,
            );
            cov.hit('query refused (400)');
            break;
          }
          const expected = searchReference(model.spendings, query);
          failIfAny(
            [
              ...(answer.status === 200
                ? []
                : [`status ${answer.status} ${JSON.stringify(answer.body)}`]),
              ...diff(answer.body, expected, `GET /api/spendings${queryString(query)}`),
            ],
            'the search differs from the reference',
          );
          const filters = [
            'month',
            'from',
            'to',
            'budgetId',
            'tagId',
            'q',
            'minAmount',
            'maxAmount',
          ].filter((key) => query[key as keyof RefQuery] !== undefined);
          cov.hit(`query with ${Math.min(filters.length, 4)} filters`);
          cov.hit(expected.total === 0 ? 'query with no match' : 'query with matches');
          if (expected.total > expected.items.length)
            cov.hit('query paged: more matches than the page');
          if (expected.total > 0 && expected.items.length === 0)
            cov.hit('query paged: past the end');
          if (query.q !== undefined && expected.total > 0) cov.hit('query q matched');
          if (query.q !== undefined && /[%_]/.test(query.q) && expected.total > 0) {
            cov.hit('query q with % or _ matched');
          }
          if (query.tagId !== undefined && expected.items.some((s) => s.tagIds.length > 1)) {
            cov.hit('query tagId: an item with other tags too');
          }
          if (query.tagId !== undefined && !model.tags.some((tag) => tag.id === query.tagId)) {
            cov.hit(
              model.gone.includes(query.tagId)
                ? 'query tagId of a tag that is gone'
                : 'query tagId of a tag that never existed',
            );
            // What an unknown tag must not do is let the rest of the query through.
            const { tagId: _unknown, ...rest } = query;
            if (searchReference(model.spendings, rest).total > 0) {
              cov.hit('query unknown tagId, and the rest of it would match');
            }
          }
          if (query.minAmount !== undefined && query.minAmount >= 0 && expected.total > 0) {
            cov.hit('query minAmount >= 0 with matches');
          }
          if (query.maxAmount !== undefined && query.maxAmount < 0 && expected.total > 0) {
            cov.hit('query maxAmount < 0 with matches');
          }
          if (query.q !== undefined && query.q !== query.q.trim()) cov.hit('query q padded');
          if (
            query.q !== undefined &&
            expected.items.some(
              (s) =>
                !s.description.toLowerCase().includes(query.q!.trim().toLowerCase()) &&
                s.notes?.toLowerCase().includes(query.q!.trim().toLowerCase()),
            )
          ) {
            cov.hit('query q matched through the notes only');
          }
          break;
        }
      }
      // After a change, the tag list (and with it every usageCount) is what the reference says.
      if (op.t !== 'query') failIfAny(await tagsProblems(), 'GET /api/tags');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label}\n  after: ${trail.join(' | ') || '(nothing yet)'}\n  ${message}`, {
        cause: error,
      });
    }
    trail.push(op.t);
  }

  // Whatever the sequence was, the whole list, page by page, is the reference's, in order.
  const pages: unknown[] = [];
  for (let offset = 0; offset < Math.max(1, model.spendings.length); offset += 7) {
    const answer = await call(server, 'get', `/api/spendings${queryString({ limit: 7, offset })}`);
    const expected = searchReference(model.spendings, { limit: 7, offset });
    failIfAny(diff(answer.body, expected, `page at ${offset}`), 'paging through everything');
    pages.push(...expected.items);
  }
  expect(pages.length).toBe(model.spendings.length);
}

describe('spendings search against a naive reference', () => {
  it(
    'every filter AND-ed, the order, the pages and totals, and the tags of each item follow random spendings and tags',
    async () => {
      const cov = coverage<string>();
      await fc.assert(
        fc.asyncProperty(
          // A start that gives the queries something to find: a few tags and spendings.
          fc.array(
            fc.record({
              t: fc.constant('addTag' as const),
              name: textArb(3).filter((n) => n !== ''),
              color: fc.boolean(),
              clash: fc.constant(false),
              i: fc.constant(0),
              bits: fc.constant(0),
            }),
            { minLength: 2, maxLength: 4 },
          ),
          fc.array(addArb, { minLength: 6, maxLength: 9 }),
          fc.array(opArb, { minLength: 10, maxLength: 20 }),
          async (tags, adds, rest) => {
            const ops: SOp[] = [...tags, ...adds, ...rest];
            const { app } = createTestApp(mutableClock('2026-03-15T10:00:00Z'));
            const server = await serve(app);
            try {
              await onboard(app, { startMonth: '2026-01' });
              await addBudget(app, { name: 'A', startMonth: '2026-01' });
              await addBudget(app, { name: 'B', startMonth: '2026-01' });
              await run({ server }, ops, cov);
            } finally {
              await stop(server);
            }
          },
        ),
        boundedConfig(40),
      );
      // The cases this property is about must really have been generated (see `FC_COVERAGE=1`).
      cov.expectAtLeast({
        'add accepted': 50,
        'add refused unknown_tag': 3,
        'add refused: a tag twice': 2,
        'addTag accepted': 20,
        'addTag refused tag_name_taken': 1,
        'renameTag refused tag_name_taken': 1,
        'a spending with several tags': 20,
        delete: 3,
        deleteTag: 2,
        'patch accepted, tags kept': 4,
        'patch accepted, tags replaced': 4,
        'patch accepted, tags cleared': 1,
        'patch refused unknown_tag': 1,
        'renameTag accepted': 1,
        'query with matches': 25,
        'query with no match': 10,
        'query refused (400)': 10,
        'query with 3 filters': 5,
        'query with 4 filters': 2,
        'query paged: more matches than the page': 8,
        'query paged: past the end': 3,
        'query q matched': 8,
        'query q matched through the notes only': 3,
        'query q padded': 5,
        'query q with % or _ matched': 3,
        'query tagId: an item with other tags too': 1,
        // "An unknown tag matches nothing": a tag that was deleted and one that never existed, the
        // second kind with the rest of the query matching something (which it must not let through).
        'query tagId of a tag that is gone': 3,
        'query tagId of a tag that never existed': 8,
        'query unknown tagId, and the rest of it would match': 6,
        'query minAmount >= 0 with matches': 2,
        'query maxAmount < 0 with matches': 1,
      });
    },
    SLOW,
  );
});

// -------------------------------------------------------------------------------------------------
// Hand-picked tables
// -------------------------------------------------------------------------------------------------

describe('q ignores case in alphabets and blocks that the restricted alphabet leaves out', () => {
  /**
   * [stored, searched, found]. Every pair is the same letters in two cases, or two texts that are
   * not the same letters, and each answer is written down by hand: a case pair is found, anything
   * else is not.
   */
  const CASES: [string, string, boolean][] = [
    // Latin Extended and other Latin blocks
    ['ŁÓDŹ', 'łódź', true],
    ['łódź', 'ŁÓDŹ', true],
    ['Œuvre complète', 'ŒUVRE', true],
    ['ŒUVRE', 'œuvre', true],
    ['Ệ', 'ệ', true], // Vietnamese, U+1EC6 and U+1EC7
    ['ＡＢＣ 123', 'ａｂｃ', true], // full-width letters
    ['ａｂｃ', 'ＡＢＣ', true],
    ['Ⓐ', 'ⓐ', true], // circled letters
    ['Ⅷ', 'ⅷ', true], // the roman numeral eight
    ['ǅ', 'ǆ', true], // a digraph in title case, small and capital forms
    ['ǅ', 'Ǆ', true],
    // Alphabets of their own
    ['ᲐᲑᲒ', 'აბგ', true], // Georgian capitals and small letters
    ['აბგ', 'ᲐᲑᲒ', true],
    ['ᎠᎡᎢ', 'ꭰꭱꭲ', true], // Cherokee
    ['ꭰꭱꭲ', 'ᎠᎡᎢ', true],
    ['ΠΑΡΊΣΙ', 'παρίσι', true], // Greek with a tonos
    ['Привет', 'ПРИВЕТ', true],
    ['ՀԱՅԱՍՏԱՆ', 'հայաստան', true], // Armenian
    // Not the same letters: a text is not found by another one
    ['Ⅷ', 'VIII', false], // a roman numeral is not four letters
    ['ａ', 'a', false], // a full-width letter is not an ASCII one
    ['abc', 'abcd', false], // the search is longer than the text
    ['ab', 'ba', false],
    ['', 'a', false],
  ];

  it.each(CASES)('%j searched as %j: found is %s', async (stored, q, found) => {
    const { app } = createTestApp(mutableClock('2026-03-15T10:00:00Z'));
    await onboard(app, { startMonth: '2026-01' });
    const budget = await addBudget(app, { name: 'A', startMonth: '2026-01' });
    // The text is stored once as a description and once as notes: either is searched.
    const asDescription = await addSpending(app, {
      budgetId: budget.id,
      description: stored,
      notes: null,
    });
    const asNotes = await addSpending(app, {
      budgetId: budget.id,
      description: 'x',
      notes: stored === '' ? null : stored,
    });
    const page = (await call(app, 'get', `/api/spendings${queryString({ q })}`)).body;
    const ids = page.items.map((item: { id: number }) => item.id);
    expect(ids.includes(asDescription.id)).toBe(found);
    expect(ids.includes(asNotes.id)).toBe(found && stored !== '');
  });
});

describe('q looks at the description and at the notes, one at a time', () => {
  it('never at the two joined together', async () => {
    const { app } = createTestApp(mutableClock('2026-03-15T10:00:00Z'));
    await onboard(app, { startMonth: '2026-01' });
    const budget = await addBudget(app, { name: 'A', startMonth: '2026-01' });
    const made = await addSpending(app, { budgetId: budget.id, description: 'ab', notes: 'cd' });
    const found = async (q: string) =>
      (
        (await call(app, 'get', `/api/spendings${queryString({ q })}`)).body.items as {
          id: number;
        }[]
      ).map((item) => item.id);
    expect(await found('ab')).toEqual([made.id]);
    expect(await found('cd')).toEqual([made.id]);
    expect(await found('b')).toEqual([made.id]);
    expect(await found('bc')).toEqual([]); // the end of the description and the start of the notes
    expect(await found('abcd')).toEqual([]);
    expect(await found('ab cd')).toEqual([]);
  });
});

describe('tag names and the search are two different comparisons', () => {
  /**
   * docs/DOMAIN.md: "It is not the tag-name comparison above, on purpose: `ß` and `ss` are two tag
   * names but find each other in a search, while full-width letters clash as tag names and are not
   * found by their plain spelling." (The typographic ligatures are the exception: see the table of
   * the next block.)
   */
  it('ß and ss are two tag names, yet a search for one finds the other', async () => {
    const { app } = createTestApp(mutableClock('2026-03-15T10:00:00Z'));
    await onboard(app, { startMonth: '2026-01' });
    const budget = await addBudget(app, { name: 'A', startMonth: '2026-01' });
    await addTag(app, { name: 'ß' });
    await addTag(app, { name: 'ss' }); // 201: not the same name
    expect(((await call(app, 'get', '/api/tags')).body as unknown[]).length).toBe(2);
    const made = await addSpending(app, { budgetId: budget.id, description: 'Straße' });
    const page = (await call(app, 'get', `/api/spendings${queryString({ q: 'strasse' })}`)).body;
    expect(page.items.map((item: { id: number }) => item.id)).toEqual([made.id]);
  });

  it('Café and Cafe are two tag names: accents count', async () => {
    const { app } = createTestApp(mutableClock('2026-03-15T10:00:00Z'));
    await onboard(app, { startMonth: '2026-01' });
    await addTag(app, { name: 'Café' });
    await addTag(app, { name: 'Cafe' }); // 201: not the same name
    const names = ((await call(app, 'get', '/api/tags')).body as { name: string }[]).map(
      (tag) => tag.name,
    );
    expect(names.sort()).toEqual(['Cafe', 'Café'].sort());
  });

  // docs/DOMAIN.md: "names that differ only by Unicode normalization (`é` as one character or as `e`
  // plus an accent), by full-width or ligature forms, by a non-breaking space or by invisible
  // characters also clash", as capitals do. [what, the tag there is, the name that is refused]
  it.each([
    ['other capitals', 'file', 'FILE'],
    ['full-width letters', 'file', 'ｆｉｌｅ'],
    ['a ligature', 'file', 'ﬁle'],
    ['an accent written as a separate mark', 'café', 'cafe\u0301'],
    ['a non-breaking space for a space', 'my file', 'my\u00a0file'],
    ['an invisible character inside', 'file', 'fi\u200ble'],
  ])('%s clash: 409 tag_name_taken', async (_what, there, name) => {
    const { app } = createTestApp(mutableClock('2026-03-15T10:00:00Z'));
    await onboard(app, { startMonth: '2026-01' });
    await addTag(app, { name: there });
    const answer = await call(app, 'post', '/api/tags', { name });
    expect(answer.status, JSON.stringify(answer.body)).toBe(409);
    expect(answer.body.error.code).toBe('tag_name_taken');
    expect(((await call(app, 'get', '/api/tags')).body as unknown[]).length).toBe(1);
  });
});

describe('tagId', () => {
  /**
   * "`tagId` matches the spendings that carry that tag ... an unknown tag matches nothing." Three
   * spendings in March, by hand: Lunch 12.50 with Food, Train 30.00 with Trip and Work, Coffee 5.00
   * with no tag. Then Trip is deleted (Train keeps Work only) and a tag Spare is made that nothing
   * carries. `month=2026-03` alone matches all three (total 4750), so a tag filter that lets the
   * rest of the query through when the tag is unknown would answer 4750 where the doc says 0.
   */
  it('an unknown tag matches nothing, however much else the query matches', async () => {
    const { app } = createTestApp(mutableClock('2026-03-15T10:00:00Z'));
    await onboard(app, { startMonth: '2026-01' });
    const budget = await addBudget(app, { name: 'A', startMonth: '2026-01' });
    const food = await addTag(app, { name: 'Food' });
    const trip = await addTag(app, { name: 'Trip' });
    const work = await addTag(app, { name: 'Work' });
    const lunch = await addSpending(app, {
      budgetId: budget.id,
      description: 'Lunch',
      amount: 1250,
      tagIds: [food.id],
    });
    const train = await addSpending(app, {
      budgetId: budget.id,
      description: 'Train',
      amount: 3000,
      tagIds: [trip.id, work.id],
    });
    const coffee = await addSpending(app, {
      budgetId: budget.id,
      description: 'Coffee',
      amount: 500,
    });
    await send(app, 'delete', `/api/tags/${trip.id}`, undefined, 204);
    const spare = await addTag(app, { name: 'Spare' });
    const neverExisted = Math.max(food.id, trip.id, work.id, spare.id) + 100;

    const search = async (query: RefQuery) => {
      const answer = await call(app, 'get', `/api/spendings${queryString(query)}`);
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      return {
        ids: (answer.body.items as { id: number }[]).map((item) => item.id),
        total: answer.body.total as number,
        totalAmount: answer.body.totalAmount as number,
        items: answer.body.items as { id: number; tagIds: number[] }[],
      };
    };

    // The rest of the query alone: all three, 1250 + 3000 + 500 = 4750.
    const all = await search({ month: '2026-03' });
    expect(all.ids.sort()).toEqual([lunch.id, train.id, coffee.id].sort());
    expect(all.totalAmount).toBe(4750);

    // A tag there is.
    const byFood = await search({ tagId: food.id });
    expect([byFood.ids, byFood.total, byFood.totalAmount]).toEqual([[lunch.id], 1, 1250]);
    const byWork = await search({ tagId: work.id, month: '2026-03' });
    expect([byWork.ids, byWork.total, byWork.totalAmount]).toEqual([[train.id], 1, 3000]);
    // Each item still lists all of its tags: Train has lost Trip with the deletion.
    expect(byWork.items[0]?.tagIds).toEqual([work.id]);
    // A tag nothing carries.
    expect(await search({ tagId: spare.id })).toMatchObject({ ids: [], total: 0, totalAmount: 0 });

    // A tag that is gone, and a tag that never existed: nothing, alone and with other filters.
    for (const unknown of [trip.id, neverExisted]) {
      for (const rest of [
        {},
        { month: '2026-03' },
        { from: '2026-03-01', to: '2026-03-31' },
        { budgetId: budget.id },
        { q: 'lunch' },
        { minAmount: 0 },
        { maxAmount: 99999 },
        { month: '2026-03', budgetId: budget.id, q: 'o', minAmount: 1, maxAmount: 5000 },
      ]) {
        const found = await search({ tagId: unknown, ...rest });
        expect(
          [found.ids, found.total, found.totalAmount],
          `tagId=${unknown} with ${JSON.stringify(rest)}`,
        ).toEqual([[], 0, 0]);
      }
    }
  });
});

describe('q and the forms that docs/DOMAIN.md says are, and are not, folded together', () => {
  /**
   * "The fold ... applied to both sides: NFC, then lower case, upper case and lower case again
   * (Unicode's full case mappings, so `STRASSE` finds `Straße` and `ſ` is an `s`) ... There are no
   * locale rules: dotless `ı` and `i` find each other, and the Turkish `İ` does not find `i` ...
   * `ß` and `ss` are two tag names but find each other in a search, while full-width letters ... are
   * not found by their plain spelling. The typographic ligatures `ﬁ`, `ﬂ`, `ﬃ` and their kin (U+FB00 to
   * U+FB06) are the exception: upper case spells them out (`ﬁ` becomes `FI`) ... The letters `æ`, `œ`
   * and `ĳ` stay themselves." [stored, searched, found]
   */
  const CASES: [string, string, boolean][] = [
    ['Straße', 'STRASSE', true],
    ['STRASSE', 'straße', true],
    ['ß', 'ss', true],
    ['ss', 'ß', true],
    ['ſ', 's', true],
    ['s', 'ſ', true],
    ['ı', 'i', true], // dotless i and i find each other, both ways
    ['i', 'ı', true],
    ['i', 'İ', false], // the Turkish dotted capital I does not find i
    ['ｆｉｌｅ', 'file', false], // full-width letters are not found by the plain spelling
    ['ĳsselmeer', 'ijsselmeer', false], // nor is the ij ligature
    ['æ', 'ae', false], // nor the ae ligature
    ['œuvre', 'oeuvre', false],
    // The typographic ligatures (U+FB00 to U+FB06) are the exception: upper case spells them out
    // (ﬁ becomes FI), so they are found by their letters, and the other way round.
    ['ﬁle', 'file', true],
    ['file', 'ﬁle', true],
    ['ﬃ', 'ffi', true],
    ['office', 'oﬃce', true],
    ['ﬂ', 'fl', true],
    ['ﬀ', 'ff', true],
    ['ﬆ', 'st', true],
    // "Normalize to NFC": the same text written as one character or as a letter and its accent.
    ['cafe\u0301', 'CAFÉ', true],
    ['CAFÉ', 'cafe\u0301', true],
    ['caf\u00e9', 'cafe\u0301', true],
    // "Accents are never stripped."
    ['CAFÉ', 'cafe', false],
    ['cafe', 'CAFÉ', false],
    ['οδός', 'οδος', false],
    // "The Greek final sigma ς is written σ, so that a fragment of a word is found as well as the
    // whole word": ΟΣΟΥ holds the fragment ΟΣ, typed in capitals or in the final form.
    ['ΟΣΟΥ', 'ΟΣ', true],
    ['οσου', 'ΟΣ', true],
    ['ΟΣΟΥ', 'ος', true],
    ['ΟΔΟΣ', 'οδος', true],
  ];

  it.each(CASES)('%j searched as %j: found is %s', async (stored, q, found) => {
    const { app } = createTestApp(mutableClock('2026-03-15T10:00:00Z'));
    await onboard(app, { startMonth: '2026-01' });
    const budget = await addBudget(app, { name: 'A', startMonth: '2026-01' });
    const made = await addSpending(app, { budgetId: budget.id, description: stored });
    const page = (await call(app, 'get', `/api/spendings${queryString({ q })}`)).body;
    expect(page.items.map((item: { id: number }) => item.id).includes(made.id)).toBe(found);
  });
});
