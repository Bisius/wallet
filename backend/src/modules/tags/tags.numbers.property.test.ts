/**
 * "Tags never change a number" (docs/DOMAIN.md, "Tags and search"), as a property: whatever the
 * facts, creating, renaming, recoloring, attaching, replacing, clearing and deleting tags, and
 * searching the spendings with every filter, leave every figure the API derives exactly as it was.
 *
 * The facts are generated like those of the other property tests (budgets of both modes with their
 * versions, archives, subscriptions, incomes, spendings, refunds, transfers, closed, current and
 * future months) and entered through the public endpoints, in two worlds: one without tags, one in
 * which every spending is created carrying some. The figures are the month list, some month views,
 * the savings, the budgets, the incomes, the salary and the spendings with their amounts. The
 * tagged world must show the same figures as the plain one when it is built, and still after a random
 * sequence of tag operations and searches. A search is a read, so it must not change a single row of
 * the database either.
 *
 * Fixed seed (see testing/prop.ts), reproduce with the seed and the counterexample fast-check prints.
 */
import type { SpendingDto, SpendingsPage, TagDto } from '@wallet/shared';
import fc from 'fast-check';
import type { Server } from 'node:http';
import { describe, it } from 'vitest';
import { dumpDb } from '../../testing/db-dump';
import { mutableClock } from '../../testing/helpers';
import { SLOW, boundedConfig, coverage, diff, failIfAny } from '../../testing/prop';
import { type Answer, call, enterFacts, send, serve, stop } from '../../testing/prop-api';
import { scenarioArb } from '../../testing/prop-gen';
import { monthIndex, monthKey } from '../../testing/prop-model';
import { queryString } from '../../testing/search-model';
import { createTestApp } from '../../testing/test-app';

type TagOp =
  | { t: 'create'; name: string; color: boolean }
  | { t: 'attach'; spending: number; tags: number[] }
  | { t: 'clear'; spending: number }
  | { t: 'rename'; tag: number; name: string }
  | { t: 'recolor'; tag: number; color: boolean }
  | { t: 'delete'; tag: number }
  | {
      t: 'search';
      q: string | undefined;
      tag: number | undefined;
      min: number | undefined;
      max: number | undefined;
      month: number | undefined;
    };

const nat = (max: number) => fc.nat(max);
const word = fc.constantFrom('Food', 'food', 'Fun', 'Work', 'work', 'Café', 'Cafe', 'a', 'B');

const tagOpArb: fc.Arbitrary<TagOp> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ t: fc.constant('create' as const), name: word, color: fc.boolean() }),
  },
  {
    weight: 14,
    arbitrary: fc.record({
      t: fc.constant('attach' as const),
      spending: nat(99),
      tags: fc.array(nat(9), { minLength: 1, maxLength: 4 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('clear' as const), spending: nat(99) }) },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant('rename' as const), tag: nat(9), name: word }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant('recolor' as const), tag: nat(9), color: fc.boolean() }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('delete' as const), tag: nat(9) }) },
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant('search' as const),
      q: fc.option(fc.constantFrom('a', 'food', 'Lunch', '%', '_', 'é', ' x '), { nil: undefined }),
      tag: fc.option(nat(9), { nil: undefined }),
      min: fc.option(fc.constantFrom(-100, 0, 1, 5000), { nil: undefined }),
      max: fc.option(fc.constantFrom(-1, 0, 100, 100000), { nil: undefined }),
      month: fc.option(nat(40), { nil: undefined }),
    }),
  },
);

/** Everything the API derives from the facts, and the rows the facts are made of, without the tags. */
async function numbers(server: Server, start: string, last: string, today: string) {
  const current = today.slice(0, 7);
  const months = [...new Set([start, current, last, monthKey(monthIndex(start) + 1)])]
    .filter((month) => month >= start && month <= last)
    .sort();
  const views: unknown[] = [];
  for (const month of months) views.push(await send(server, 'get', `/api/months/${month}`));
  const spendings: Omit<SpendingDto, 'tagIds'>[] = [];
  let totalAmount = 0;
  for (let offset = 0; ; offset += 200) {
    const page = (await send(
      server,
      'get',
      `/api/spendings?limit=200&offset=${offset}`,
    )) as SpendingsPage;
    spendings.push(...page.items.map(({ tagIds: _tagIds, ...rest }) => rest));
    totalAmount = page.totalAmount;
    if (offset + 200 >= page.total) break;
  }
  return {
    summaries: await send(server, 'get', `/api/months?from=${start}&to=${last}`),
    views,
    savings: await send(server, 'get', '/api/savings'),
    budgets: await send(server, 'get', '/api/budgets'),
    incomes: await send(server, 'get', '/api/incomes'),
    salary: await send(server, 'get', '/api/salary'),
    spendings,
    totalAmount,
  };
}

describe('tags never change a number, on generated facts', () => {
  it(
    'creating, attaching, renaming, deleting tags and searching leave the months, the savings and every row as they were',
    async () => {
      const cov = coverage<string>();
      await fc.assert(
        fc.asyncProperty(
          scenarioArb({ sequentialIds: true, maxMonths: 8, maxBudgets: 3, maxSubscriptions: 2 }),
          fc.array(tagOpArb, { minLength: 6, maxLength: 14 }),
          async (scenario, random) => {
            const ops: TagOp[] = random;
            const today = `${scenario.today}T12:00:00Z`;
            const plain = createTestApp(mutableClock(today));
            const { app, db } = createTestApp(mutableClock(today));
            const plainServer = await serve(plain.app);
            const server = await serve(app);
            try {
              // The plain world, and the tagged one: three tags, and spendings that carry none, one or two.
              await enterFacts(plainServer, scenario.facts);
              await enterFacts(server, scenario.facts, {
                tags: ['Food', 'Work', 'Fun'],
                tagsOf: (i) => (i % 4 === 3 ? [] : i % 2 === 0 ? [i % 3] : [i % 3, (i + 1) % 3]),
              });
              const { startMonth } = scenario.facts;
              const reference = await numbers(
                plainServer,
                startMonth,
                scenario.through,
                scenario.today,
              );
              failIfAny(
                diff(
                  await numbers(server, startMonth, scenario.through, scenario.today),
                  reference,
                  'the figures',
                ),
                'spendings created with tags show other figures than the same without',
              );
              const tags = (await send(server, 'get', '/api/tags')) as TagDto[];
              const spendings = (
                (await send(server, 'get', '/api/spendings?limit=200')) as SpendingsPage
              ).items;
              if (spendings.some((spending) => spending.tagIds.length > 0)) {
                cov.hit('spendings created with tags');
              }
              const pick = <T>(items: readonly T[], i: number): T | undefined =>
                items.length === 0 ? undefined : items[i % items.length];

              for (const op of ops) {
                const expect = async (answer: Answer, status: number | number[]) => {
                  const wanted = Array.isArray(status) ? status : [status];
                  failIfAny(
                    wanted.includes(answer.status)
                      ? []
                      : [
                          `${JSON.stringify(op)} answered ${answer.status} ${JSON.stringify(answer.body)}`,
                        ],
                    'a tag operation',
                  );
                };
                switch (op.t) {
                  case 'create': {
                    const answer = await call(server, 'post', '/api/tags', {
                      name: op.name,
                      ...(op.color ? { color: '#22c55e' } : {}),
                    });
                    await expect(answer, [201, 409]);
                    if (answer.status === 201) tags.push(answer.body);
                    break;
                  }
                  case 'attach': {
                    const spending = pick(spendings, op.spending);
                    const ids = [
                      ...new Set(
                        op.tags
                          .map((i) => pick(tags, i)?.id)
                          .filter((id): id is number => id !== undefined),
                      ),
                    ];
                    if (!spending || ids.length === 0) break;
                    await expect(
                      await call(server, 'patch', `/api/spendings/${spending.id}`, { tagIds: ids }),
                      200,
                    );
                    cov.hit('a spending carries tags');
                    break;
                  }
                  case 'clear': {
                    const spending = pick(spendings, op.spending);
                    if (spending) {
                      await expect(
                        await call(server, 'patch', `/api/spendings/${spending.id}`, {
                          tagIds: [],
                        }),
                        200,
                      );
                    }
                    break;
                  }
                  case 'rename': {
                    const tag = pick(tags, op.tag);
                    if (tag)
                      await expect(
                        await call(server, 'patch', `/api/tags/${tag.id}`, { name: op.name }),
                        [200, 409],
                      );
                    break;
                  }
                  case 'recolor': {
                    const tag = pick(tags, op.tag);
                    if (tag) {
                      await expect(
                        await call(server, 'patch', `/api/tags/${tag.id}`, {
                          color: op.color ? '#ef4444' : null,
                        }),
                        200,
                      );
                    }
                    break;
                  }
                  case 'delete': {
                    const tag = pick(tags, op.tag);
                    if (!tag) break;
                    await expect(await call(server, 'delete', `/api/tags/${tag.id}`), 204);
                    tags.splice(tags.indexOf(tag), 1);
                    cov.hit('a tag deleted');
                    break;
                  }
                  case 'search': {
                    const dump = dumpDb(db);
                    const query = {
                      ...(op.q === undefined ? {} : { q: op.q }),
                      ...(op.tag === undefined ? {} : { tagId: pick(tags, op.tag)?.id ?? 999 }),
                      ...(op.min === undefined ? {} : { minAmount: op.min }),
                      ...(op.max === undefined ? {} : { maxAmount: op.max }),
                      ...(op.month === undefined
                        ? {}
                        : { month: monthKey(monthIndex(startMonth) + (op.month % 10)) }),
                    };
                    const answer = await call(server, 'get', `/api/spendings${queryString(query)}`);
                    // A bad query (min above max) is a 400, any other is a 200: neither writes.
                    await expect(answer, [200, 400]);
                    failIfAny(
                      dumpDb(db) === dump ? [] : ['the search wrote to the database'],
                      'a search',
                    );
                    cov.hit(answer.status === 200 ? 'a search answered' : 'a search refused');
                    break;
                  }
                }
              }

              const after = await numbers(server, startMonth, scenario.through, scenario.today);
              failIfAny(diff(after, reference, 'the figures'), 'a tag operation changed a number');
            } finally {
              await stop(server);
              await stop(plainServer);
            }
          },
        ),
        boundedConfig(14),
      );
      cov.expectAtLeast({
        'spendings created with tags': 3,
        'a spending carries tags': 15,
        'a tag deleted': 3,
        'a search answered': 8,
      });
    },
    SLOW,
  );
});
