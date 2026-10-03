import { ceilDiv } from '@wallet/shared/money';
import { monthDiff, monthRange } from '@wallet/shared/month';
import type {
  BudgetDto,
  GoalDto,
  MonthBudgetLine,
  MonthStatus,
  MonthSubscriptionLine,
  MonthSummary,
  MonthView,
  OutstandingMonthDto,
  Page,
  SavingsDto,
  SavingsTransactionDto,
  SpendingDto,
  SpendingsPage,
  SubscriptionDto,
  TagDto,
  TransferDto,
  UpcomingRenewalDto,
  YearlyReportDto,
  YearlyReportMonth,
} from '@wallet/shared';

/**
 * Builders for the API's response shapes, with sensible defaults. A spec names only what it cares
 * about, and what it leaves out is valid. Every builder returns a fresh object.
 */

/** One budget's figures for a month. Defaults: an ordinary budget a quarter used. */
export function budgetLine(overrides: Partial<MonthBudgetLine> = {}): MonthBudgetLine {
  return {
    id: 1,
    name: 'Groceries',
    color: null,
    icon: null,
    incremental: false,
    endsThisMonth: false,
    carriedIn: 0,
    allocated: 40000,
    transfersNet: 0,
    available: 40000,
    spent: 10000,
    remaining: 30000,
    usagePercent: 25,
    warnPercent: 80,
    alert: 'ok',
    carriedOut: 0,
    toSavings: 30000,
    ...overrides,
  };
}

/** A yearly subscription's line of a month: 120.00 a year renewing in March, with 60.00 set aside. */
export function subscriptionLine(
  overrides: Partial<MonthSubscriptionLine> = {},
): MonthSubscriptionLine {
  return {
    id: 1,
    name: 'Domain',
    color: null,
    frequency: 'yearly',
    price: 12000,
    charge: 2000,
    reserveBalance: 6000,
    renewalThisMonth: false,
    nextRenewalMonth: '2027-03',
    nextRenewalPrice: 12000,
    reserveReleased: 0,
    endsThisMonth: false,
    ...overrides,
  };
}

interface MonthViewOverrides extends Partial<Omit<MonthView, 'income'>> {
  income?: Partial<MonthView['income']>;
}

/**
 * A month view. The totals, the unallocated amount and the savings due are worked out from what is
 * given (as the real API does) unless the spec sets them, which also lets a spec give figures that
 * do not add up to prove the page shows what it is told.
 */
export function monthView(overrides: MonthViewOverrides = {}): MonthView {
  const { income: incomeOverrides, ...rest } = overrides;
  const budgets = rest.budgets ?? [];
  const subscriptions = rest.subscriptions ?? [];
  const salary = incomeOverrides?.salary ?? 270000;
  const extra = incomeOverrides?.extra ?? 0;
  const income = { salary, extra, total: incomeOverrides?.total ?? salary + extra };
  const fixedCosts = rest.fixedCosts ?? subscriptions.reduce((sum, line) => sum + line.charge, 0);
  const totals = rest.totals ?? {
    allocated: budgets.reduce((sum, line) => sum + line.allocated, 0),
    spent: budgets.reduce((sum, line) => sum + line.spent, 0),
    remaining: budgets.reduce((sum, line) => sum + line.remaining, 0),
    transfersNet: 0,
  };
  const unallocated = rest.unallocated ?? income.total - fixedCosts - totals.allocated;
  const budgetsSettled = budgets.reduce((sum, line) => sum + line.toSavings, 0);
  const reservesReleased = subscriptions.reduce((sum, line) => sum + line.reserveReleased, 0);
  return {
    month: '2026-10',
    status: 'current',
    fixedCosts,
    subscriptions,
    budgets,
    totals,
    unallocated,
    overAllocated: unallocated < 0,
    savingsDue: {
      unallocated,
      budgetsSettled,
      reservesReleased,
      total: unallocated + budgetsSettled + reservesReleased,
    },
    ...rest,
    income,
  };
}

/**
 * One month's compact row (`GET /api/months`). Defaults: the current month, 2700.00 of income of
 * which 100.00 was spent and 2400.00 is due to savings. The figures need not add up: a spec that
 * names one gets exactly that one back.
 */
export function monthSummary(overrides: Partial<MonthSummary> = {}): MonthSummary {
  return {
    month: '2026-10',
    status: 'current',
    income: 270000,
    fixedCosts: 20000,
    allocated: 40000,
    spent: 10000,
    unallocated: 210000,
    savingsDue: 240000,
    ...overrides,
  };
}

/**
 * The compact rows for every month from `from` to `to`, ascending, as the API returns them. The
 * status follows `current` (a month before it is closed, after it a projection). `build` gives the
 * figures of a month, by its place in the range, on top of the defaults.
 */
export function monthSummaries(
  from: string,
  to: string,
  build: (month: string, index: number) => Partial<MonthSummary> = () => ({}),
  current = '2026-10',
): MonthSummary[] {
  return monthRange(from, to).map((month, index) => {
    const status: MonthStatus =
      month < current ? 'closed' : month === current ? 'current' : 'future';
    return monthSummary({ month, status, ...build(month, index) });
  });
}

/** A budget as the budget list returns it. Defaults: active, 400.00 a month from June 2026. */
export function budgetDto(overrides: Partial<BudgetDto> = {}): BudgetDto {
  const versions = overrides.versions ?? [
    { effectiveMonth: overrides.startMonth ?? '2026-06', amount: 40000, incremental: false },
  ];
  return {
    id: 1,
    name: 'Groceries',
    color: null,
    icon: null,
    sortOrder: 0,
    startMonth: '2026-06',
    endMonth: null,
    alertWarnPercent: null,
    notes: null,
    versions,
    current: versions.filter((v) => v.effectiveMonth <= '2026-10').at(-1) ?? null,
    hasHistory: false,
    status: 'active',
    ...overrides,
  };
}

/** A subscription as the list returns it. Defaults: a monthly 10.00 subscription, active. */
export function subscriptionDto(overrides: Partial<SubscriptionDto> = {}): SubscriptionDto {
  const prices = overrides.prices ?? [
    { effectiveMonth: overrides.startMonth ?? '2026-06', amount: 1000 },
  ];
  const current = prices.filter((p) => p.effectiveMonth <= '2026-10').at(-1)?.amount ?? null;
  const frequency = overrides.frequency ?? 'monthly';
  return {
    id: 1,
    name: 'Streaming',
    frequency,
    anchorDate: '2026-06-14',
    startMonth: '2026-06',
    endMonth: null,
    color: null,
    notes: null,
    prices,
    currentPrice: current,
    monthlyEquivalent:
      current === null ? null : frequency === 'yearly' ? ceilDiv(current, 12) : current,
    status: 'active',
    ...overrides,
  };
}

export function spendingDto(overrides: Partial<SpendingDto> = {}): SpendingDto {
  return {
    id: 1,
    date: '2026-10-02',
    amount: 1250,
    budgetId: 1,
    description: 'Coffee',
    notes: null,
    tagIds: [],
    ...overrides,
  };
}

/** A tag as the list returns it. Defaults: no color, on no spending. */
export function tagDto(overrides: Partial<TagDto> = {}): TagDto {
  return { id: 1, name: 'Groceries', color: null, usageCount: 0, ...overrides };
}

/** A transfer between two budgets: 50.00 from budget 1 to budget 2 on 2026-10-02. */
export function transferDto(overrides: Partial<TransferDto> = {}): TransferDto {
  return {
    id: 1,
    date: '2026-10-02',
    fromBudgetId: 1,
    toBudgetId: 2,
    amount: 5000,
    note: null,
    ...overrides,
  };
}

/** A page of spendings. `total` and `totalAmount` default to what the items add up to. */
export function spendingsPage(
  items: SpendingDto[],
  overrides: Partial<SpendingsPage> = {},
): SpendingsPage {
  return {
    items,
    total: items.length,
    limit: 50,
    offset: 0,
    totalAmount: items.reduce((sum, item) => sum + item.amount, 0),
    ...overrides,
  };
}

/**
 * A goal as the API returns it. The figures are worked out from `balance`, `targetAmount` and
 * `deadline` the way the API does (today is 2026-10-02) unless the spec sets them: a spec that
 * names one gets exactly that one back, even when it does not add up.
 */
export function goalDto(overrides: Partial<GoalDto> = {}): GoalDto {
  const targetAmount = overrides.targetAmount ?? 100000;
  const balance = overrides.balance ?? 0;
  const deadline = overrides.deadline ?? null;
  const archived = overrides.archived ?? false;
  const reached = overrides.reached ?? balance >= targetAmount;
  const remaining = overrides.remaining ?? Math.max(0, targetAmount - balance);
  const overdue = deadline !== null && deadline.slice(0, 7) < '2026-10';
  const status =
    overrides.status ??
    (archived ? 'archived' : reached ? 'reached' : overdue ? 'overdue' : 'active');
  const monthsLeft =
    deadline === null ? 1 : Math.max(1, monthDiff('2026-10', deadline.slice(0, 7)) + 1);
  const monthlyNeeded =
    deadline !== null && (status === 'active' || status === 'overdue')
      ? ceilDiv(remaining, monthsLeft)
      : null;
  return {
    id: 1,
    name: 'Holiday',
    targetAmount,
    deadline,
    color: null,
    archived,
    balance,
    progressPercent: Math.max(0, Math.floor((100 * balance) / targetAmount)),
    remaining,
    reached,
    monthlyNeeded,
    status,
    ...overrides,
  };
}

/**
 * One closed month waiting to be moved to savings. By default 312.40 due in September 2026, all of
 * it unallocated income and none settled yet. The direction, the outstanding amount and whether it is
 * a correction follow `savingsDue` and `settled` unless the spec sets them.
 */
export function outstandingMonth(
  overrides: Partial<OutstandingMonthDto> = {},
): OutstandingMonthDto {
  const savingsDue = overrides.savingsDue ?? 31240;
  const settled = overrides.settled ?? 0;
  const outstanding = overrides.outstanding ?? savingsDue - settled;
  return {
    month: '2026-09',
    savingsDue,
    settled,
    outstanding,
    direction: outstanding > 0 ? 'move' : 'take',
    breakdown: { unallocated: savingsDue, budgetsSettled: 0, reservesReleased: 0 },
    adjustment: settled !== 0,
    ...overrides,
  };
}

/**
 * The savings overview. The balance, the outstanding total and the unassigned amount follow from
 * what is given unless the spec sets them. Default: an empty one (nothing saved, nothing to move).
 */
export function savingsDto(overrides: Partial<SavingsDto> = {}): SavingsDto {
  const goals = overrides.goals ?? [];
  const outstanding = overrides.outstanding ?? [];
  const unassigned = overrides.unassigned ?? 0;
  return {
    balance: unassigned + goals.reduce((sum, goal) => sum + goal.balance, 0),
    unassigned,
    goals,
    outstanding,
    outstandingTotal: outstanding.reduce((sum, month) => sum + month.outstanding, 0),
    ...overrides,
  };
}

/** One savings row. Default: a 50.00 deposit to unassigned savings today. */
export function savingsTransaction(
  overrides: Partial<SavingsTransactionDto> = {},
): SavingsTransactionDto {
  return {
    id: 1,
    date: '2026-10-02',
    kind: 'deposit',
    amount: 5000,
    goalId: null,
    settlesMonth: null,
    note: null,
    groupId: null,
    ...overrides,
  };
}

/** A page of savings rows. `total` defaults to what the items are. */
export function transactionsPage(
  items: SavingsTransactionDto[],
  overrides: Partial<Page<SavingsTransactionDto>> = {},
): Page<SavingsTransactionDto> {
  return { items, total: items.length, limit: 50, offset: 0, ...overrides };
}

/** A renewal of `GET /api/subscriptions/upcoming`. Defaults: a monthly 9.99 subscription in 5 days. */
export function upcomingRenewal(overrides: Partial<UpcomingRenewalDto> = {}): UpcomingRenewalDto {
  return {
    id: 1,
    name: 'Streaming',
    color: null,
    frequency: 'monthly',
    yearly: false,
    date: '2026-10-07',
    daysUntil: 5,
    amount: 999,
    reserved: null,
    unreserved: null,
    ...overrides,
  };
}

/** One month of the yearly report. Defaults: a closed month of 2700.00 income, 100.00 spent. */
export function reportMonth(overrides: Partial<YearlyReportMonth> = {}): YearlyReportMonth {
  return {
    month: '2026-06',
    status: 'closed',
    income: { salary: 270000, extra: 0, total: 270000 },
    fixedCosts: 20000,
    allocated: 40000,
    spent: 10000,
    unallocated: 210000,
    saved: 240000,
    savedBreakdown: { unallocated: 210000, budgetsSettled: 30000, reservesReleased: 0 },
    ...overrides,
  };
}

/**
 * The yearly report of 2026 from June (the default start month) to December. Like `monthView`, the
 * totals are worked out from the months unless a spec sets them, which also lets a spec give
 * figures that do not add up to prove the page shows what it is told.
 */
export function yearlyReport(overrides: Partial<YearlyReportDto> = {}): YearlyReportDto {
  const year = overrides.year ?? 2026;
  const months =
    overrides.months ??
    monthRange(`${year}-06`, `${year}-12`).map((month) =>
      reportMonth({
        month,
        status: month < '2026-10' ? 'closed' : month === '2026-10' ? 'current' : 'future',
      }),
    );
  const sum = (pick: (month: YearlyReportMonth) => number) =>
    months.reduce((total, month) => total + pick(month), 0);
  return {
    year,
    firstMonth: months[0]?.month ?? `${year}-01`,
    lastMonth: months.at(-1)?.month ?? `${year}-12`,
    months,
    income: {
      salary: sum((m) => m.income.salary),
      extra: sum((m) => m.income.extra),
      total: sum((m) => m.income.total),
    },
    fixedCosts: { total: sum((m) => m.fixedCosts), paid: 0, subscriptions: [] },
    budgets: [],
    allocated: sum((m) => m.allocated),
    spent: sum((m) => m.spent),
    unallocated: sum((m) => m.unallocated),
    saved: sum((m) => m.saved),
    savedBreakdown: {
      unallocated: sum((m) => m.savedBreakdown.unallocated),
      budgetsSettled: sum((m) => m.savedBreakdown.budgetsSettled),
      reservesReleased: sum((m) => m.savedBreakdown.reservesReleased),
    },
    ...overrides,
  };
}
