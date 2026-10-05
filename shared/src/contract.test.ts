/**
 * Type-level checks of what the frontend sees. These run under `tsc` (npm run typecheck); at
 * runtime they are no-ops. If one fails to compile, a contract type changed shape.
 */
import { describe, expectTypeOf, it } from 'vitest';
import type {
  ApiError,
  ApiErrorCode,
  Page,
  PayloadTooLargeDetails,
  RuleViolationRule,
  TodayResponse,
} from './api';
import type { BackupDto, BackupsDto } from './backups';
import type { BudgetCreateInput, BudgetDto, BudgetUpdateInput } from './budgets';
import type { ExportQuery } from './export';
import type { GoalCreateInput, GoalDto, GoalUpdateInput } from './goals';
import type {
  ImportCommitInput,
  ImportCommitResponse,
  ImportMapping,
  ImportParseInput,
  ImportParseResponse,
  ImportPreviewInput,
  ImportPreviewResponse,
  ImportPreviewRow,
  ImportProfileDto,
  ImportProfileInput,
  ImportRowsRejectedDetails,
} from './import';
import type { IncomeCreateInput } from './incomes';
import type {
  CsvDelimiter,
  ImportDateFormat,
  ImportDecimalSeparator,
  ImportRejectionCode,
  ImportRowErrorCode,
  ImportSignConvention,
  SavingsTransactionKind,
} from './limits';
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
import type { YearlyReportDto, YearlyReportMonth } from './reports';
import type {
  SubscriptionCreateInput,
  SubscriptionDto,
  UpcomingRenewalDto,
  UpcomingRenewalsQuery,
} from './subscriptions';
import type { TagCreateInput, TagDto, TagUpdateInput } from './tags';
import type {
  TelegramBotDto,
  TelegramConnectionState,
  TelegramLinkDto,
  TelegramNotificationSettingsDto,
  TelegramNotificationSettingsInput,
  TelegramPairingDto,
  TelegramProblem,
  TelegramStatusDto,
} from './telegram';
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

  it('upcoming renewals', () => {
    expectTypeOf<UpcomingRenewalsQuery>().toEqualTypeOf<{ days?: number | undefined }>();
    expectTypeOf<UpcomingRenewalDto>().toEqualTypeOf<{
      id: number;
      name: string;
      color: string | null;
      frequency: 'monthly' | 'yearly';
      yearly: boolean;
      date: IsoDate;
      daysUntil: number;
      amount: Cents;
      reserved: Cents | null;
      unreserved: Cents | null;
    }>();
  });

  it('yearly report', () => {
    expectTypeOf<YearlyReportMonth['status']>().toEqualTypeOf<MonthView['status']>();
    expectTypeOf<YearlyReportMonth['income']>().toEqualTypeOf<MonthView['income']>();
    expectTypeOf<YearlyReportMonth['savedBreakdown']>().toEqualTypeOf<SavingsDueBreakdown>();
    expectTypeOf<YearlyReportDto['months']>().toEqualTypeOf<YearlyReportMonth[]>();
    expectTypeOf<YearlyReportDto['year']>().toEqualTypeOf<number>();
    expectTypeOf<YearlyReportDto['saved']>().toEqualTypeOf<Cents>();
  });

  it('the Phase 7 error codes exist', () => {
    expectTypeOf<
      | 'import_profile_name_taken'
      | 'backups_unavailable'
      | 'payload_too_large'
      | 'import_rows_rejected'
    >().toExtend<ApiErrorCode>();
    expectTypeOf<PayloadTooLargeDetails>().toEqualTypeOf<{ limitBytes: number }>();
  });

  it('the Phase 10 error codes exist', () => {
    expectTypeOf<
      'telegram_not_configured' | 'telegram_not_linked' | 'telegram_unavailable'
    >().toExtend<ApiErrorCode>();
  });

  it('telegram status, pairing and link', () => {
    expectTypeOf<TelegramStatusDto>().toEqualTypeOf<{
      configured: boolean;
      connection: 'off' | 'connecting' | 'running' | 'error';
      problem: 'invalid_token' | 'conflict' | 'unreachable' | 'blocked' | null;
      bot: { username: string } | null;
      link: { name: string; username: string | null; linkedAt: string } | null;
      pairing: { code: string; expiresAt: string; deepLink: string | null } | null;
      notifications: TelegramNotificationSettingsDto;
    }>();
    expectTypeOf<TelegramStatusDto['connection']>().toEqualTypeOf<TelegramConnectionState>();
    expectTypeOf<TelegramStatusDto['problem']>().toEqualTypeOf<TelegramProblem | null>();
    expectTypeOf<TelegramStatusDto['bot']>().toEqualTypeOf<TelegramBotDto | null>();
    expectTypeOf<TelegramStatusDto['link']>().toEqualTypeOf<TelegramLinkDto | null>();
    expectTypeOf<TelegramStatusDto['pairing']>().toEqualTypeOf<TelegramPairingDto | null>();
  });

  it('telegram notification settings: the body is the response', () => {
    expectTypeOf<TelegramNotificationSettingsInput>().toEqualTypeOf<{
      budgetAlerts: boolean;
      renewalYearlyDays: number;
      renewalMonthlyDays: number;
      monthlyRecap: boolean;
      notifyAt: string;
    }>();
    expectTypeOf<TelegramNotificationSettingsDto>().toEqualTypeOf<TelegramNotificationSettingsInput>();
  });

  it('export query', () => {
    expectTypeOf<ExportQuery>().toEqualTypeOf<{
      from?: string | undefined;
      to?: string | undefined;
    }>();
  });

  it('import mapping and requests', () => {
    expectTypeOf<ImportMapping>().toEqualTypeOf<{
      delimiter: CsvDelimiter;
      hasHeader: boolean;
      dateColumn: number;
      amountColumn: number;
      descriptionColumn: number;
      dateFormat: ImportDateFormat;
      decimalSeparator: ImportDecimalSeparator;
      signConvention: ImportSignConvention;
    }>();
    expectTypeOf<CsvDelimiter>().toEqualTypeOf<',' | ';' | '\t' | '|'>();
    expectTypeOf<ImportParseInput>().toEqualTypeOf<{
      csv: string;
      delimiter?: CsvDelimiter | undefined;
    }>();
    expectTypeOf<ImportPreviewInput>().toEqualTypeOf<{ csv: string; mapping: ImportMapping }>();
    expectTypeOf<ImportCommitInput>().toEqualTypeOf<{
      csv: string;
      mapping: ImportMapping;
      rows: { line: number; budgetId: number }[];
    }>();
    expectTypeOf<ImportProfileInput>().toEqualTypeOf<{
      name: string;
      mapping: ImportMapping;
      header?: string[] | null | undefined;
    }>();
  });

  it('import responses', () => {
    expectTypeOf<ImportParseResponse>().toEqualTypeOf<{
      delimiter: CsvDelimiter;
      header: string[];
      sample: { line: number; cells: string[] }[];
      recordCount: number;
      columnCount: number;
      suggestedProfileId: number | null;
    }>();
    expectTypeOf<ImportPreviewRow>().toEqualTypeOf<{
      line: number;
      date: IsoDate | null;
      amount: Cents | null;
      raw: { date: string; amount: string };
      description: string;
      suggestedBudgetId: number | null;
      duplicate: boolean;
      credit: boolean;
      errors: ImportRowErrorCode[];
    }>();
    expectTypeOf<ImportPreviewResponse['summary']>().toEqualTypeOf<{
      total: number;
      invalid: number;
      duplicates: number;
      credits: number;
      importable: number;
    }>();
    expectTypeOf<ImportCommitResponse>().toEqualTypeOf<{
      created: number;
      items: { line: number; id: number }[];
    }>();
    expectTypeOf<ImportRowsRejectedDetails>().toEqualTypeOf<{
      rows: { line: number; errors: ImportRejectionCode[] }[];
    }>();
    expectTypeOf<ImportRowErrorCode>().toExtend<ImportRejectionCode>();
    expectTypeOf<ImportProfileDto>().toEqualTypeOf<{
      id: number;
      name: string;
      mapping: ImportMapping;
      header: string[] | null;
    }>();
  });

  it('backups', () => {
    expectTypeOf<BackupDto>().toEqualTypeOf<{
      name: string;
      createdAt: string;
      sizeBytes: number;
    }>();
    expectTypeOf<BackupsDto>().toEqualTypeOf<{
      automatic: boolean;
      backups: BackupDto[];
      lastBackupAt: string | null;
      nextDueAt: string | null;
    }>();
  });

  it('MonthSummary repeats the MonthView totals', () => {
    expectTypeOf<MonthSummary['income']>().toEqualTypeOf<MonthView['income']['total']>();
    expectTypeOf<MonthSummary['savingsDue']>().toEqualTypeOf<MonthView['savingsDue']['total']>();
    expectTypeOf<MonthSummary['status']>().toEqualTypeOf<MonthView['status']>();
  });
});
