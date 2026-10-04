import type { APIRequestContext } from '@playwright/test';
import type {
  BudgetCreateInput,
  BudgetDto,
  GoalCreateInput,
  GoalDto,
  IncomeCreateInput,
  IncomeDto,
  MonthKey,
  MonthView,
  OnboardingInput,
  OnboardingResponse,
  SalaryEntryDto,
  SavingsAllocationInput,
  SavingsDto,
  SavingsTransactionDto,
  SettingsDto,
  SpendingCreateInput,
  SpendingDto,
  SubscriptionCreateInput,
  SubscriptionDto,
  TransferCreateInput,
  TodayResponse,
  TransferDto,
} from '@wallet/shared';
import { json } from './api';

/*
 * Typed helpers for the calls that specs repeat to put a server into a state before the browser
 * opens, through the real HTTP API (so the same rules apply as for the UI). Pass `wallet.api`.
 *
 * The inputs are the request types of `@wallet/shared`: the compiler checks the payloads, the server
 * checks the rules, and a refusal throws an `ApiRequestError` that shows the response.
 * Money is integer cents, months are `YYYY-MM` and dates `YYYY-MM-DD`, as everywhere.
 */

/** What `onboard` needs: the start month and the salary. The rest has a default. */
export type OnboardSeed = Pick<OnboardingInput, 'startMonth' | 'salary'> & Partial<OnboardingInput>;

/**
 * `POST /api/onboarding`: the settings, the first salary and the opening savings in one go.
 * Defaults: EUR, `en-US`, no opening savings, no budgets.
 */
export async function onboard(
  api: APIRequestContext,
  seed: OnboardSeed,
): Promise<OnboardingResponse> {
  const body: OnboardingInput = {
    currency: 'EUR',
    locale: 'en-US',
    openingSavings: 0,
    budgets: [],
    ...seed,
  };
  return json(await api.post('/api/onboarding', { data: body }));
}

/** `PUT /api/salary/:month`: the monthly salary from that month on. */
export async function setSalary(
  api: APIRequestContext,
  month: MonthKey,
  amount: number,
): Promise<SalaryEntryDto> {
  return json(await api.put(`/api/salary/${month}`, { data: { amount } }));
}

/** `POST /api/budgets`. `incremental: true` carries the leftover (or deficit) into the next month. */
export async function createBudget(
  api: APIRequestContext,
  input: BudgetCreateInput,
): Promise<BudgetDto> {
  return json(await api.post('/api/budgets', { data: input }));
}

/** `POST /api/subscriptions`, monthly or yearly. */
export async function createSubscription(
  api: APIRequestContext,
  input: SubscriptionCreateInput,
): Promise<SubscriptionDto> {
  return json(await api.post('/api/subscriptions', { data: input }));
}

/** `POST /api/incomes`: a one-off income in the month of its date. */
export async function addIncome(
  api: APIRequestContext,
  input: IncomeCreateInput,
): Promise<IncomeDto> {
  return json(await api.post('/api/incomes', { data: input }));
}

/** `POST /api/spendings`. A negative amount is a refund. */
export async function addSpending(
  api: APIRequestContext,
  input: SpendingCreateInput,
): Promise<SpendingDto> {
  return json(await api.post('/api/spendings', { data: input }));
}

/** `POST /api/goals`: a savings goal that starts with a balance of 0. */
export async function createGoal(api: APIRequestContext, input: GoalCreateInput): Promise<GoalDto> {
  return json(await api.post('/api/goals', { data: input }));
}

/** `POST /api/transfers`: money between two budgets, or between a budget and the month's unallocated pool (null). */
export async function addTransfer(
  api: APIRequestContext,
  input: TransferCreateInput,
): Promise<TransferDto> {
  return json(await api.post('/api/transfers', { data: input }));
}

/** `GET /api/today`: the server's date and month, from its (fake) clock. */
export async function getToday(api: APIRequestContext): Promise<TodayResponse> {
  return json(await api.get('/api/today'));
}

/** `GET /api/settings` (404 until the wallet is onboarded). */
export async function getSettings(api: APIRequestContext): Promise<SettingsDto> {
  return json(await api.get('/api/settings'));
}

/** `GET /api/months/:month`: the figures of one month, as the dashboard and the budgets page read them. */
export async function getMonth(api: APIRequestContext, month: MonthKey): Promise<MonthView> {
  return json(await api.get(`/api/months/${month}`));
}

/** `GET /api/savings`: the balance, the goals and the closed months still to move. */
export async function getSavings(api: APIRequestContext): Promise<SavingsDto> {
  return json(await api.get('/api/savings'));
}

/**
 * Marks a closed month as moved to savings (`POST /api/savings/settle/:month`) for exactly what is
 * outstanding now, as the UI's "Done" does. `allocations` splits it across goals (`goalId: null` is
 * the unassigned savings). Throws when the month has nothing outstanding.
 */
export async function settleMonth(
  api: APIRequestContext,
  month: MonthKey,
  allocations?: SavingsAllocationInput[],
): Promise<SavingsTransactionDto[]> {
  const { outstanding } = await getSavings(api);
  const entry = outstanding.find((candidate) => candidate.month === month);
  if (!entry) {
    const months = outstanding.map((candidate) => candidate.month).join(', ') || 'none';
    throw new Error(`${month} has nothing outstanding to settle (outstanding months: ${months})`);
  }
  const body = { amount: entry.outstanding, ...(allocations && { allocations }) };
  return json(await api.post(`/api/savings/settle/${month}`, { data: body }));
}
