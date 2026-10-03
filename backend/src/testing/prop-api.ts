/**
 * Helpers for the property tests that go through HTTP: a request that must answer a given status,
 * entering generated facts through the public endpoints, reading the stored state back through the
 * public endpoints, and comparing what the month endpoints answer with the independent model.
 * Nothing here reads the database except `insertTransfer`, because transfers have no endpoint yet.
 */
import type {
  BudgetDto,
  IncomeDto,
  SalaryEntryDto,
  SettingsDto,
  SpendingDto,
  SpendingsPage,
  SubscriptionDto,
} from '@wallet/shared';
import type { Express } from 'express';
import { type Server, createServer } from 'node:http';
import request from 'supertest';
import type { Facts, TransferFact } from '../domain/facts';
import { insertTransfer } from './helpers';
import { diff } from './prop';
import { modelLedger, monthIndex } from './prop-model';

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** What the requests go to: the app itself (supertest starts a server per request) or a listening server. */
export type Target = Express | Server;

/**
 * One listening server for a whole scenario. A property makes thousands of requests, and supertest
 * given an app opens (and closes) a server for each one, which exhausts the ephemeral ports when the
 * machine is busy ("Cannot read properties of null (reading 'address')"). Against one server the
 * connections are kept alive and reused. Pair it with `stop`.
 */
export async function serve(app: Express): Promise<Server> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

export async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export interface Answer {
  status: number;
  // The bodies are whatever the endpoint answers; callers narrow them.
  body: any;
}

/** One request, whatever it answers. */
export async function call(
  app: Target,
  method: Method,
  path: string,
  body?: object,
): Promise<Answer> {
  const response = await request(app)[method](path).send(body);
  return { status: response.status, body: response.body };
}

/** One request that must answer `expected`; otherwise the failure names the request and the answer. */
export async function send(
  app: Target,
  method: Method,
  path: string,
  body?: object,
  expected = 200,
): Promise<any> {
  const answer = await call(app, method, path, body);
  if (answer.status !== expected) {
    throw new Error(
      `${method.toUpperCase()} ${path} ${JSON.stringify(body)} answered ${answer.status}, expected ${expected}: ${JSON.stringify(answer.body)}`,
    );
  }
  return answer.body;
}

export const byMonth = (a: { effectiveMonth: string }, b: { effectiveMonth: string }) =>
  a.effectiveMonth < b.effectiveMonth ? -1 : a.effectiveMonth > b.effectiveMonth ? 1 : 0;

/** Enters the generated facts through the public endpoints, in an order the API's rules accept. */
export async function enterFacts(
  app: Target,
  db: Parameters<typeof insertTransfer>[0],
  facts: Facts,
): Promise<void> {
  // Onboarding stores the first salary at the start month; a scenario without one deletes it again.
  const startSalary = facts.salary.find((row) => row.effectiveMonth === facts.startMonth);
  await send(
    app,
    'post',
    '/api/onboarding',
    {
      currency: 'EUR',
      locale: 'en-US',
      startMonth: facts.startMonth,
      alertWarnPercent: facts.alertWarnPercent,
      salary: startSalary?.amount ?? 0,
      openingSavings: 0,
    },
    201,
  );
  if (!startSalary) await send(app, 'delete', `/api/salary/${facts.startMonth}`, undefined, 204);
  for (const row of facts.salary) {
    if (row !== startSalary) {
      await send(app, 'put', `/api/salary/${row.effectiveMonth}`, { amount: row.amount });
    }
  }
  for (const income of facts.incomes) {
    await send(
      app,
      'post',
      '/api/incomes',
      { date: `${income.month}-15`, amount: income.amount, description: 'Income' },
      201,
    );
  }

  // Budgets, in id order. An item with rows older than its start month is created at its earliest
  // row and moved to its start month afterwards: that is how the API leaves such rows behind.
  for (const budget of facts.budgets) {
    const rows = [...budget.versions].sort(byMonth);
    const first = rows[0]!;
    const created = await send(
      app,
      'post',
      '/api/budgets',
      {
        name: budget.name,
        amount: first.amount,
        incremental: first.incremental,
        startMonth: first.effectiveMonth,
        sortOrder: budget.sortOrder,
        alertWarnPercent: budget.alertWarnPercent,
        color: budget.color,
        icon: budget.icon,
      },
      201,
    );
    if (created.id !== budget.id) throw new Error(`budget ${budget.id} got id ${created.id}`);
    for (const row of rows.slice(1)) {
      await send(app, 'put', `/api/budgets/${budget.id}/versions/${row.effectiveMonth}`, {
        amount: row.amount,
        incremental: row.incremental,
      });
    }
    if (first.effectiveMonth !== budget.startMonth) {
      await send(app, 'patch', `/api/budgets/${budget.id}`, { startMonth: budget.startMonth });
    }
  }
  for (const subscription of facts.subscriptions) {
    const rows = [...subscription.prices].sort(byMonth);
    const first = rows[0]!;
    const created = await send(
      app,
      'post',
      '/api/subscriptions',
      {
        name: subscription.name,
        frequency: subscription.frequency,
        anchorDate: subscription.anchorDate,
        amount: first.amount,
        startMonth: first.effectiveMonth,
        color: subscription.color,
      },
      201,
    );
    if (created.id !== subscription.id) {
      throw new Error(`subscription ${subscription.id} got id ${created.id}`);
    }
    for (const row of rows.slice(1)) {
      await send(app, 'put', `/api/subscriptions/${subscription.id}/prices/${row.effectiveMonth}`, {
        amount: row.amount,
      });
    }
    if (first.effectiveMonth !== subscription.startMonth) {
      await send(app, 'patch', `/api/subscriptions/${subscription.id}`, {
        startMonth: subscription.startMonth,
      });
    }
  }

  // Spendings and transfers, then the archives and cancellations (which may not precede them).
  for (const spending of facts.spendings) {
    await send(
      app,
      'post',
      '/api/spendings',
      { date: `${spending.month}-10`, amount: spending.amount, budgetId: spending.budgetId },
      201,
    );
  }
  for (const transfer of facts.transfers) {
    insertTransfer(db, {
      date: `${transfer.month}-10`,
      amount: transfer.amount,
      ...(transfer.fromBudgetId === null ? {} : { fromBudgetId: transfer.fromBudgetId }),
      ...(transfer.toBudgetId === null ? {} : { toBudgetId: transfer.toBudgetId }),
    });
  }
  for (const budget of facts.budgets) {
    if (budget.endMonth !== null) {
      await send(app, 'post', `/api/budgets/${budget.id}/archive`, { endMonth: budget.endMonth });
    }
  }
  for (const subscription of facts.subscriptions) {
    if (subscription.endMonth !== null) {
      await send(app, 'post', `/api/subscriptions/${subscription.id}/cancel`, {
        endMonth: subscription.endMonth,
      });
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Reading the stored state back
// -------------------------------------------------------------------------------------------------

/** Everything the public endpoints show, as rows (with ids) and as the facts the ledger works from. */
export interface StoredState {
  settings: SettingsDto;
  salary: SalaryEntryDto[];
  incomes: IncomeDto[];
  budgets: BudgetDto[];
  subscriptions: SubscriptionDto[];
  spendings: SpendingDto[];
  /** The transfers have no endpoint: the ones the test inserted, unchanged. */
  transfers: TransferFact[];
  facts: Facts;
}

export async function readState(app: Target, transfers: TransferFact[]): Promise<StoredState> {
  const settings = (await send(app, 'get', '/api/settings')) as SettingsDto;
  const salary = (await send(app, 'get', '/api/salary')) as SalaryEntryDto[];
  const incomes = (await send(app, 'get', '/api/incomes')) as IncomeDto[];
  const budgets = (await send(app, 'get', '/api/budgets')) as BudgetDto[];
  const subscriptions = (await send(app, 'get', '/api/subscriptions')) as SubscriptionDto[];
  const spendings: SpendingDto[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = (await send(
      app,
      'get',
      `/api/spendings?limit=200&offset=${offset}`,
    )) as SpendingsPage;
    spendings.push(...page.items);
    if (offset + 200 >= page.total) break;
  }
  const facts: Facts = {
    startMonth: settings.startMonth,
    alertWarnPercent: settings.alertWarnPercent,
    salary: salary.map(({ effectiveMonth, amount }) => ({ effectiveMonth, amount })),
    incomes: incomes.map((income) => ({ month: income.date.slice(0, 7), amount: income.amount })),
    subscriptions: subscriptions.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      frequency: s.frequency,
      anchorDate: s.anchorDate,
      startMonth: s.startMonth,
      endMonth: s.endMonth,
      prices: s.prices.map(({ effectiveMonth, amount }) => ({ effectiveMonth, amount })),
    })),
    budgets: budgets.map((b) => ({
      id: b.id,
      name: b.name,
      color: b.color,
      icon: b.icon,
      sortOrder: b.sortOrder,
      startMonth: b.startMonth,
      endMonth: b.endMonth,
      alertWarnPercent: b.alertWarnPercent,
      versions: b.versions.map(({ effectiveMonth, amount, incremental }) => ({
        effectiveMonth,
        amount,
        incremental,
      })),
    })),
    spendings: spendings.map((s) => ({
      budgetId: s.budgetId,
      month: s.date.slice(0, 7),
      amount: s.amount,
    })),
    transfers,
  };
  return { settings, salary, incomes, budgets, subscriptions, spendings, transfers, facts };
}

/** What the API stores must be what was entered, row for row. */
export function storedProblems(state: StoredState, facts: Facts): string[] {
  const problems: string[] = [];
  for (const budget of facts.budgets) {
    const stored = state.budgets.find((b) => b.id === budget.id);
    problems.push(
      ...diff(
        {
          startMonth: stored?.startMonth,
          endMonth: stored?.endMonth,
          sortOrder: stored?.sortOrder,
          alertWarnPercent: stored?.alertWarnPercent,
          versions: stored?.versions,
        },
        {
          startMonth: budget.startMonth,
          endMonth: budget.endMonth,
          sortOrder: budget.sortOrder,
          alertWarnPercent: budget.alertWarnPercent,
          versions: [...budget.versions].sort(byMonth),
        },
        `budget ${budget.id}`,
      ),
    );
  }
  for (const subscription of facts.subscriptions) {
    const stored = state.subscriptions.find((s) => s.id === subscription.id);
    problems.push(
      ...diff(
        {
          startMonth: stored?.startMonth,
          endMonth: stored?.endMonth,
          frequency: stored?.frequency,
          anchorDate: stored?.anchorDate,
          prices: stored?.prices,
        },
        {
          startMonth: subscription.startMonth,
          endMonth: subscription.endMonth,
          frequency: subscription.frequency,
          anchorDate: subscription.anchorDate,
          prices: [...subscription.prices].sort(byMonth),
        },
        `subscription ${subscription.id}`,
      ),
    );
  }
  problems.push(...diff(state.salary, [...facts.salary].sort(byMonth), 'salary'));
  // Spendings: the sums per budget and month must be the sums the facts have.
  const sums = (rows: { budgetId: number; month: string; amount: number }[]) => {
    const total = new Map<string, number>();
    for (const row of rows) {
      const key = `${row.budgetId}|${row.month}`;
      total.set(key, (total.get(key) ?? 0) + row.amount);
    }
    return Object.fromEntries([...total].sort());
  };
  problems.push(...diff(sums(state.facts.spendings), sums(facts.spendings), 'spendings'));
  return problems;
}

/**
 * What differs between what `GET /api/months` and `GET /api/months/:month` answer and the model of
 * `facts`, for the whole list and for the views at the indexes in `viewIndexes` (clamped).
 */
export async function monthsProblems(
  app: Target,
  facts: Facts,
  through: string,
  today: string,
  viewIndexes: readonly number[],
): Promise<string[]> {
  const problems: string[] = [];
  const model = modelLedger(facts, through, today);
  if (model.length === 0) return problems;
  const summaries = await send(app, 'get', `/api/months?from=${facts.startMonth}&to=${through}`);
  problems.push(
    ...diff(
      summaries,
      model.map(({ view }) => ({
        month: view.month,
        status: view.status,
        income: view.income.total,
        fixedCosts: view.fixedCosts,
        allocated: view.totals.allocated,
        spent: view.totals.spent,
        unallocated: view.unallocated,
        savingsDue: view.savingsDue.total,
      })),
      'GET /api/months',
    ),
  );
  for (const wanted of new Set(viewIndexes)) {
    const expected = model[Math.min(model.length - 1, Math.max(0, wanted))]!.view;
    const view = await send(app, 'get', `/api/months/${expected.month}`);
    problems.push(...diff(view, expected, `GET /api/months/${expected.month}`));
  }
  return problems;
}

/** The index of `today`'s month among the months from `startMonth`. */
export const todayIndex = (facts: Facts, today: string): number =>
  monthIndex(today.slice(0, 7)) - monthIndex(facts.startMonth);
