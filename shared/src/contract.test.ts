/**
 * Type-level checks of what the frontend sees. These run under `tsc` (npm run typecheck); at
 * runtime they are no-ops. If one fails to compile, a contract type changed shape.
 */
import { describe, expectTypeOf, it } from 'vitest';
import type { ApiError, ApiErrorCode, Page, RuleViolationRule, TodayResponse } from './api';
import type { BudgetCreateInput, BudgetDto, BudgetUpdateInput } from './budgets';
import type { GoalCreateInput, GoalDto, GoalUpdateInput } from './goals';
import type { IncomeCreateInput } from './incomes';
import type { SavingsTransactionKind } from './limits';
import type { Cents } from './money';
import type { IsoDate, MonthKey } from './month';
import type { MonthSavingsDue, MonthSummary, MonthView } from './months';
import type { OnboardingInput, OnboardingResponse } from './onboarding';
import type {
  OutstandingChangedDetails,
  OutstandingMonthDto,
  SavingsDto,
  SavingsDueBreakdown,
  SavingsOpeningDto,
  SavingsSettleInput,
  SavingsTransactionCreateInput,
  SavingsTransactionDto,
  SavingsTransactionListQuery,
} from './savings';
import type { SettingsDto, SettingsInput } from './settings';
import type {
  SpendingCreateInput,
  SpendingDto,
  SpendingListQuery,
  SpendingUpdateInput,
  SpendingsPage,
} from './spendings';
import type { SubscriptionCreateInput, SubscriptionDto } from './subscriptions';
import type { TagCreateInput, TagDto, TagUpdateInput } from './tags';
import type { TransferCreateInput, TransferDto, TransferListQuery } from './transfers';

describe('contract types', () => {
  it('ApiError carries the code union', () => {
    expectTypeOf<ApiError['error']['code']>().toEqualTypeOf<ApiErrorCode>();
  });

  it('TodayResponse', () => {
    expectTypeOf<TodayResponse>().toEqualTypeOf<{ date: IsoDate; month: MonthKey }>();
  });

  it('SettingsInput requires all five fields', () => {
    expectTypeOf<SettingsInput>().toEqualTypeOf<{
      currency: string;
      locale: string;
      startMonth: string;
      theme: 'system' | 'light' | 'dark';
      alertWarnPercent: number;
    }>();
    expectTypeOf<SettingsDto>().toEqualTypeOf<SettingsInput>();
  });

  it('OnboardingInput: wizard fields required, preferences and budgets optional', () => {
    expectTypeOf<OnboardingInput>().toEqualTypeOf<{
      currency: string;
      locale: string;
      startMonth: string;
      theme?: 'system' | 'light' | 'dark' | undefined;
      alertWarnPercent?: number | undefined;
      salary: number;
      openingSavings: number;
      budgets?: { name: string; amount: number; incremental: boolean }[] | undefined;
    }>();
    expectTypeOf<OnboardingResponse['budgets']>().toEqualTypeOf<BudgetDto[]>();
  });

  it('IncomeCreateInput', () => {
    expectTypeOf<IncomeCreateInput>().toEqualTypeOf<{
      date: string;
      amount: number;
      description: string;
    }>();
  });

  it('BudgetCreateInput and BudgetUpdateInput', () => {
    expectTypeOf<BudgetCreateInput>().toEqualTypeOf<{
      name: string;
      amount: number;
      incremental: boolean;
      startMonth?: string | undefined;
      color?: string | null | undefined;
      icon?: string | null | undefined;
      sortOrder?: number | undefined;
      alertWarnPercent?: number | null | undefined;
      notes?: string | null | undefined;
    }>();
    expectTypeOf<BudgetUpdateInput>().toEqualTypeOf<{
      name?: string | undefined;
      color?: string | null | undefined;
      icon?: string | null | undefined;
      sortOrder?: number | undefined;
      alertWarnPercent?: number | null | undefined;
      notes?: string | null | undefined;
      startMonth?: string | undefined;
    }>();
  });

  it('SubscriptionCreateInput', () => {
    expectTypeOf<SubscriptionCreateInput>().toEqualTypeOf<{
      name: string;
      frequency: 'monthly' | 'yearly';
      anchorDate: string;
      amount: number;
      startMonth?: string | undefined;
      color?: string | null | undefined;
      notes?: string | null | undefined;
    }>();
    expectTypeOf<SubscriptionDto['currentPrice']>().toEqualTypeOf<Cents | null>();
  });

  it('spending request types', () => {
    expectTypeOf<SpendingCreateInput>().toEqualTypeOf<{
      date: string;
      amount: number;
      budgetId: number;
      description?: string | undefined;
      notes?: string | null | undefined;
      tagIds?: number[] | undefined;
    }>();
    expectTypeOf<SpendingUpdateInput>().toEqualTypeOf<{
      date?: string | undefined;
      amount?: number | undefined;
      budgetId?: number | undefined;
      description?: string | undefined;
      notes?: string | null | undefined;
      tagIds?: number[] | undefined;
    }>();
    expectTypeOf<SpendingListQuery>().toEqualTypeOf<{
      month?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      budgetId?: number | undefined;
      tagId?: number | undefined;
      q?: string | undefined;
      minAmount?: number | undefined;
      maxAmount?: number | undefined;
      limit?: number | undefined;
      offset?: number | undefined;
    }>();
  });

  it('SpendingDto carries its tag ids, and a page is a Page plus totalAmount', () => {
    expectTypeOf<SpendingDto>().toEqualTypeOf<{
      id: number;
      date: IsoDate;
      amount: Cents;
      budgetId: number;
      description: string;
      notes: string | null;
      tagIds: number[];
    }>();
    expectTypeOf<SpendingsPage>().toExtend<Page<SpendingDto>>();
    expectTypeOf<SpendingsPage['totalAmount']>().toEqualTypeOf<Cents>();
  });

  it('the transfer, tag and search error codes and rules exist', () => {
    expectTypeOf<'tag_name_taken'>().toExtend<ApiErrorCode>();
    expectTypeOf<'unknown_tag'>().toExtend<RuleViolationRule>();
    // Transfers reuse three rules that spendings already had.
    expectTypeOf<
      'unknown_budget' | 'before_start_month' | 'outside_active_months'
    >().toExtend<RuleViolationRule>();
  });

  it('transfer types', () => {
    expectTypeOf<TransferCreateInput>().toEqualTypeOf<{
      date: string;
      fromBudgetId: number | null;
      toBudgetId: number | null;
      amount: number;
      note?: string | null | undefined;
    }>();
    expectTypeOf<TransferListQuery>().toEqualTypeOf<{
      month?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      budgetId?: number | undefined;
    }>();
    expectTypeOf<TransferDto>().toEqualTypeOf<{
      id: number;
      date: IsoDate;
      fromBudgetId: number | null;
      toBudgetId: number | null;
      amount: Cents;
      note: string | null;
    }>();
  });

  it('tag types', () => {
    expectTypeOf<TagCreateInput>().toEqualTypeOf<{
      name: string;
      color?: string | null | undefined;
    }>();
    expectTypeOf<TagUpdateInput>().toEqualTypeOf<{
      name?: string | undefined;
      color?: string | null | undefined;
    }>();
    expectTypeOf<TagDto>().toEqualTypeOf<{
      id: number;
      name: string;
      color: string | null;
      usageCount: number;
    }>();
  });

  it('the savings error codes and rules exist', () => {
    expectTypeOf<
      'outstanding_changed' | 'nothing_to_settle' | 'not_deletable'
    >().toExtend<ApiErrorCode>();
    expectTypeOf<
      | 'start_month_too_old'
      | 'month_not_closed'
      | 'allocation_mismatch'
      | 'unknown_goal'
      | 'goal_archived'
      | 'insufficient_balance'
      | 'date_in_future'
    >().toExtend<RuleViolationRule>();
  });

  it('savings request types', () => {
    expectTypeOf<SavingsSettleInput>().toEqualTypeOf<{
      amount: number;
      allocations?: { goalId: number | null; amount: number }[] | undefined;
    }>();
    expectTypeOf<SavingsTransactionCreateInput>().toEqualTypeOf<
      | {
          kind: 'deposit';
          amount: number;
          goalId?: number | null | undefined;
          date?: string | undefined;
          note?: string | null | undefined;
        }
      | {
          kind: 'withdrawal';
          amount: number;
          goalId?: number | null | undefined;
          date?: string | undefined;
          note?: string | null | undefined;
        }
      | {
          kind: 'reallocation';
          amount: number;
          fromGoalId: number | null;
          toGoalId: number | null;
          date?: string | undefined;
          note?: string | null | undefined;
        }
    >();
    expectTypeOf<SavingsTransactionListQuery>().toEqualTypeOf<{
      goalId?: number | undefined;
      unassigned?: boolean | undefined;
      kind?: SavingsTransactionKind | undefined;
      limit?: number | undefined;
      offset?: number | undefined;
    }>();
  });

  it('goal request types', () => {
    expectTypeOf<GoalCreateInput>().toEqualTypeOf<{
      name: string;
      targetAmount: number;
      deadline?: string | null | undefined;
      color?: string | null | undefined;
    }>();
    expectTypeOf<GoalUpdateInput>().toEqualTypeOf<{
      name?: string | undefined;
      targetAmount?: number | undefined;
      deadline?: string | null | undefined;
      color?: string | null | undefined;
      archived?: boolean | undefined;
    }>();
  });

  it('savings read models', () => {
    expectTypeOf<SavingsDto['goals']>().toEqualTypeOf<GoalDto[]>();
    expectTypeOf<SavingsDto['outstanding']>().toEqualTypeOf<OutstandingMonthDto[]>();
    expectTypeOf<OutstandingMonthDto['direction']>().toEqualTypeOf<'move' | 'take'>();
    expectTypeOf<OutstandingMonthDto['breakdown']>().toEqualTypeOf<SavingsDueBreakdown>();
    expectTypeOf<MonthSavingsDue>().toExtend<SavingsDueBreakdown>();
    expectTypeOf<SavingsTransactionDto['kind']>().toEqualTypeOf<SavingsTransactionKind>();
    expectTypeOf<SavingsTransactionDto['settlesMonth']>().toEqualTypeOf<MonthKey | null>();
    expectTypeOf<SavingsTransactionDto['groupId']>().toEqualTypeOf<number | null>();
    expectTypeOf<SavingsOpeningDto>().toEqualTypeOf<{ amount: Cents; date: IsoDate }>();
    expectTypeOf<OutstandingChangedDetails>().toEqualTypeOf<{
      month: MonthKey;
      outstanding: Cents;
    }>();
    expectTypeOf<GoalDto['status']>().toEqualTypeOf<
      'active' | 'reached' | 'overdue' | 'archived'
    >();
    expectTypeOf<GoalDto['monthlyNeeded']>().toEqualTypeOf<Cents | null>();
    expectTypeOf<GoalDto['deadline']>().toEqualTypeOf<IsoDate | null>();
  });

  it('the transaction list is a plain Page', () => {
    expectTypeOf<Page<SavingsTransactionDto>['items']>().toEqualTypeOf<SavingsTransactionDto[]>();
  });

  it('MonthSummary repeats the MonthView totals', () => {
    expectTypeOf<MonthSummary['income']>().toEqualTypeOf<MonthView['income']['total']>();
    expectTypeOf<MonthSummary['savingsDue']>().toEqualTypeOf<MonthView['savingsDue']['total']>();
    expectTypeOf<MonthSummary['status']>().toEqualTypeOf<MonthView['status']>();
  });
});
