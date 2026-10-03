/**
 * Small helpers for the HTTP scenarios of transfers (`modules/transfers/transfers.*.scenario.test.ts`):
 * a budget line read as a row of numbers in the order of the formula of docs/DOMAIN.md, a snapshot
 * of everything the API derives from the facts (so a test can say "nothing else changed" and "the
 * delete put it all back, to the cent"), and a causality assertion. Nothing here computes money:
 * every expected number in the scenarios is typed in by hand next to its derivation.
 */
import type {
  BudgetDto,
  MonthBudgetLine,
  MonthSummary,
  MonthView,
  SavingsDto,
  TransferDto,
} from '@wallet/shared';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { expect } from 'vitest';
import { serve, stop } from './prop-api';
import { getSavings } from './savings-helpers';
import { getJson, monthSummaries, monthView } from './story';

const running = new Set<Server>();

/**
 * Puts `app` behind one listening server and hands it back, typed as the app. supertest accepts
 * either, and with a server that is already listening it does not start and stop one per request,
 * which is most of what a request costs here (about 2.0 ms against 3.4 ms). A scenario makes
 * hundreds of requests. Pair it with `afterEach(stopListening)`.
 */
export async function listening(app: Express): Promise<Express> {
  const server = await serve(app);
  running.add(server);
  return server as unknown as Express;
}

/** Stops every server `listening` started. */
export async function stopListening(): Promise<void> {
  const servers = [...running];
  running.clear();
  await Promise.all(servers.map((server) => stop(server)));
}

/**
 * A budget line as the numbers of the formula, in the order a person reads them:
 * `[carriedIn, allocated, transfersNet, available, spent, remaining, carriedOut, toSavings]` with
 * `available = carriedIn + allocated + transfersNet`, `remaining = available - spent` and
 * `remaining = carriedOut + toSavings`.
 */
export type Row = [
  carriedIn: number,
  allocated: number,
  transfersNet: number,
  available: number,
  spent: number,
  remaining: number,
  carriedOut: number,
  toSavings: number,
];

export const rowOf = (line: MonthBudgetLine): Row => [
  line.carriedIn,
  line.allocated,
  line.transfersNet,
  line.available,
  line.spent,
  line.remaining,
  line.carriedOut,
  line.toSavings,
];

/** The lines of a month by budget name. */
export const rowsOf = (view: MonthView): Record<string, Row> =>
  Object.fromEntries(view.budgets.map((line) => [line.name, rowOf(line)]));

/** The figures of a month that a transfer to or from the pool can move. */
export const levelOf = (view: MonthView) => ({
  unallocated: view.unallocated,
  transfersNet: view.totals.transfersNet,
  savingsDue: view.savingsDue.total,
});

/** Everything the API derives from the facts, over a fixed range of months. */
export interface Snapshot {
  views: MonthView[];
  summaries: MonthSummary[];
  savings: SavingsDto;
  budgets: BudgetDto[];
  transfers: TransferDto[];
}

export async function snapshotOf(
  app: Express,
  range: { from: string; to: string; months: readonly string[] },
): Promise<Snapshot> {
  const views: MonthView[] = [];
  for (const month of range.months) views.push(await monthView(app, month));
  return {
    views,
    summaries: await monthSummaries(app, range.from, range.to),
    savings: await getSavings(app),
    budgets: await getJson<BudgetDto[]>(app, '/api/budgets'),
    transfers: await getJson<TransferDto[]>(app, '/api/transfers'),
  };
}

export const viewOf = (snapshot: Snapshot, month: string): MonthView => {
  const view = snapshot.views.find((candidate) => candidate.month === month);
  if (!view) throw new Error(`the snapshot has no view of ${month}`);
  return view;
};

/**
 * Causality (docs/DOMAIN.md, invariant 5): a fact dated in `month` never changes a month before it.
 * Every view and every summary row before `month` is deep-equal, to the last field.
 */
export function expectNothingChangedBefore(before: Snapshot, after: Snapshot, month: string) {
  for (const old of before.views) {
    if (old.month >= month) continue;
    expect(viewOf(after, old.month), `the view of ${old.month} (before ${month})`).toEqual(old);
  }
  expect(
    after.summaries.filter((row) => row.month < month),
    `the month list before ${month}`,
  ).toEqual(before.summaries.filter((row) => row.month < month));
}

/**
 * "Nothing else changed". From `month` on, everything but what a transfer can move is deep-equal:
 *
 *  - the lines of the budgets in `carrying` (incremental budgets the transfer touches carry its
 *    effect into every later month) are left out from `month` on, and so are the lines of every
 *    budget in `involved` in `month` itself;
 *  - `totals` is left out (it is the sum of the lines, which the identities check), and in `month`
 *    itself so are `unallocated`, `overAllocated` and `savingsDue`, which the test asserts by hand.
 *
 * Everything else, the lines of the other budgets, the income, the fixed costs, the subscriptions
 * and the status of every month, and the money figures of every other month, must be as it was.
 */
export function expectNothingElseChanged(
  before: Snapshot,
  after: Snapshot,
  month: string,
  moved: { involved: readonly string[]; carrying: readonly string[] },
) {
  for (const old of before.views) {
    if (old.month < month) continue;
    const now = viewOf(after, old.month);
    const excluded = old.month === month ? moved.involved : moved.carrying;
    const left = (view: MonthView) => {
      const { totals: _totals, ...rest } = view;
      const budgets = view.budgets.filter((line) => !excluded.includes(line.name));
      if (old.month !== month) return { ...rest, budgets };
      const { unallocated: _u, overAllocated: _o, savingsDue: _s, ...others } = rest;
      return { ...others, budgets };
    };
    expect(left(now), `everything else in ${old.month}`).toEqual(left(old));
  }
}

/** Every number the API derives, as it stands: what "back to the cent" compares. */
export const expectSameSnapshot = (after: Snapshot, before: Snapshot) => {
  expect(after.views).toEqual(before.views);
  expect(after.summaries).toEqual(before.summaries);
  expect(after.savings).toEqual(before.savings);
  expect(after.budgets).toEqual(before.budgets);
  expect(after.transfers).toEqual(before.transfers);
};
