/**
 * Helpers for the HTTP scenario tests of the month endpoints. The facts are rebuilt from the
 * Phase 1 read endpoints (not from the database and not through `loadFacts`), so checking the month
 * endpoints against an oracle built from them tests the whole path: storage, `loadFacts`, the
 * ledger and the routes.
 */
import type {
  BudgetDto,
  IncomeDto,
  MonthSummary,
  MonthView,
  SalaryEntryDto,
  SettingsDto,
  SpendingDto,
  SpendingsPage,
  SubscriptionDto,
} from '@wallet/shared';
import type { Express } from 'express';
import request from 'supertest';
import { expect } from 'vitest';
import type {
  BudgetFact,
  Facts,
  SpendingFact,
  SubscriptionFact,
  TransferFact,
} from '../domain/facts';
import { createOracle, oracleDifferences } from './ledger-oracle';
import {
  expectChainIdentities,
  expectMonthIdentities,
  expectSummaryMatchesView,
  paymentsOf,
} from './month-identities';

async function get<T>(app: Express, path: string): Promise<T> {
  return (await request(app).get(path).expect(200)).body as T;
}

/** The facts the API currently holds, read back through the Phase 1 endpoints. */
export async function factsFromApi(app: Express, transfers: TransferFact[] = []): Promise<Facts> {
  const settings = await get<SettingsDto>(app, '/api/settings');

  const spendingRows: SpendingDto[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await get<SpendingsPage>(app, `/api/spendings?limit=200&offset=${offset}`);
    spendingRows.push(...page.items);
    if (offset + 200 >= page.total) break;
  }
  const perBudgetMonth = new Map<string, SpendingFact>();
  for (const s of spendingRows) {
    const month = s.date.slice(0, 7);
    const key = `${s.budgetId}|${month}`;
    const fact = perBudgetMonth.get(key) ?? { budgetId: s.budgetId, month, amount: 0 };
    fact.amount += s.amount;
    perBudgetMonth.set(key, fact);
  }

  const budgets = (await get<BudgetDto[]>(app, '/api/budgets')).map((b): BudgetFact => ({
    id: b.id,
    name: b.name,
    color: b.color,
    icon: b.icon,
    sortOrder: b.sortOrder,
    startMonth: b.startMonth,
    endMonth: b.endMonth,
    alertWarnPercent: b.alertWarnPercent,
    versions: b.versions,
  }));
  const subscriptions = (await get<SubscriptionDto[]>(app, '/api/subscriptions')).map(
    (s): SubscriptionFact => ({
      id: s.id,
      name: s.name,
      color: s.color,
      frequency: s.frequency,
      anchorDate: s.anchorDate,
      startMonth: s.startMonth,
      endMonth: s.endMonth,
      prices: s.prices,
    }),
  );

  return {
    startMonth: settings.startMonth,
    alertWarnPercent: settings.alertWarnPercent,
    salary: await get<SalaryEntryDto[]>(app, '/api/salary'),
    incomes: (await get<IncomeDto[]>(app, '/api/incomes')).map((i) => ({
      month: i.date.slice(0, 7),
      amount: i.amount,
    })),
    subscriptions,
    budgets,
    spendings: [...perBudgetMonth.values()],
    transfers,
  };
}

export interface CheckedScenario {
  facts: Facts;
  summaries: MonthSummary[];
  views: MonthView[];
}

/**
 * Reads `GET /api/months?from&to` and every month of it with `GET /api/months/:month`, and checks:
 * the identities of the contract and of consecutive months; that each summary is its view; and
 * that the income, the spendings, what the subscriptions paid, set aside and released, what is
 * held, every yearly line, and above all the savings due of every month equal what the oracle
 * derives from the facts.
 */
export async function expectApiMatchesOracle(
  app: Express,
  range: { from: string; to: string },
  transfers: TransferFact[] = [],
): Promise<CheckedScenario> {
  const facts = await factsFromApi(app, transfers);
  const oracle = createOracle(facts);

  const summaries = await get<MonthSummary[]>(app, `/api/months?from=${range.from}&to=${range.to}`);
  expect(summaries.length, 'months in range').toBeGreaterThan(0);
  const views: MonthView[] = [];
  for (const summary of summaries) {
    const view = await get<MonthView>(app, `/api/months/${summary.month}`);
    views.push(view);

    expectMonthIdentities(view);
    expectSummaryMatchesView(summary, view);
    // Income, spendings, what was paid and what is held, the fixed costs, the reserves released,
    // the savings due, and every field of every yearly line, against the independent oracle.
    expect(
      oracleDifferences(view, oracle, paymentsOf(view)),
      `${view.month} against the oracle`,
    ).toEqual([]);
  }
  expectChainIdentities(views, { startsAtLedgerStart: views[0]?.month === facts.startMonth });
  return { facts, summaries, views };
}
