/**
 * Small helpers for the HTTP story tests (`months.story-*.test.ts`): JSON shortcuts that assert the
 * status they expect, and readers that pull the figures a story talks about out of a month view.
 * A story builds its data only through the public endpoints, moves the clock, and asserts figures
 * worked out by hand, so nothing here computes money.
 */
import type {
  MonthBudgetLine,
  MonthSubscriptionLine,
  MonthSummary,
  MonthView,
} from '@wallet/shared';
import type { Express } from 'express';
import request from 'supertest';

export async function getJson<T>(app: Express, path: string): Promise<T> {
  return (await request(app).get(path).expect(200)).body as T;
}

export async function putJson(app: Express, path: string, body: object): Promise<void> {
  await request(app).put(path).send(body).expect(200);
}

export async function postJson(app: Express, path: string, body: object = {}): Promise<void> {
  await request(app).post(path).send(body).expect(200);
}

/** `GET /api/months/:month`. */
export const monthView = (app: Express, month: string) =>
  getJson<MonthView>(app, `/api/months/${month}`);

/** `GET /api/months?from&to`. */
export const monthSummaries = (app: Express, from: string, to: string) =>
  getJson<MonthSummary[]>(app, `/api/months?from=${from}&to=${to}`);

/** The budget line called `name` in a month view; fails loudly when the month has none. */
export function budgetLine(view: MonthView, name: string): MonthBudgetLine {
  const line = view.budgets.find((b) => b.name === name);
  if (!line)
    throw new Error(
      `${view.month} has no budget "${name}" (it has ${view.budgets.map((b) => b.name)})`,
    );
  return line;
}

/** The subscription line called `name` in a month view; fails loudly when the month has none. */
export function subscriptionLine(view: MonthView, name: string): MonthSubscriptionLine {
  const line = view.subscriptions.find((s) => s.name === name);
  if (!line) {
    throw new Error(
      `${view.month} has no subscription "${name}" (it has ${view.subscriptions.map((s) => s.name)})`,
    );
  }
  return line;
}

/**
 * The balance sheet of a budget line, in the order a person reads it:
 * `[carriedIn, allocated, available, spent, remaining, carriedOut, toSavings]`.
 */
export const balances = (line: MonthBudgetLine) =>
  [
    line.carriedIn,
    line.allocated,
    line.available,
    line.spent,
    line.remaining,
    line.carriedOut,
    line.toSavings,
  ] as const;

/** `[charge, reserveBalance, reserveReleased]` of a subscription line. */
export const reserve = (line: MonthSubscriptionLine) =>
  [line.charge, line.reserveBalance, line.reserveReleased] as const;

/** `[month, status, income, fixedCosts, allocated, spent, unallocated, savingsDue]` of a summary row. */
export const summaryRow = (row: MonthSummary) =>
  [
    row.month,
    row.status,
    row.income,
    row.fixedCosts,
    row.allocated,
    row.spent,
    row.unallocated,
    row.savingsDue,
  ] as const;

export const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);
