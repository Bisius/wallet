import {
  DEFAULT_ALERT_WARN_PERCENT,
  DEFAULT_THEME,
  type OnboardingInput,
  type OnboardingResponse,
} from '@wallet/shared';
import { salaryChanges, savingsTransactions } from '../../db/schema';
import { type Deps, inTransaction } from '../../lib/deps';
import { alreadyOnboarded } from '../../lib/errors';
import { firstDayOf, timestampOf } from '../../lib/today';
import { insertBudget, loadBudgetDtos } from '../budgets/budgets.service';
import {
  assertStartMonthNotInFuture,
  assertStartMonthNotTooOld,
  findSettings,
  requireSettings,
  writeSettings,
} from '../settings/settings.service';

/** First budgets get `sortOrder` 0, 10, 20, ... in request order (gaps leave room to reorder). */
const SORT_ORDER_STEP = 10;

/**
 * POST /api/onboarding: the whole wizard in ONE transaction. Stores the settings, the first salary
 * (effective from `startMonth`), the `opening` savings transaction (dated the 1st of `startMonth`)
 * and the first budgets (each with a first version effective from `startMonth`), or nothing at all.
 */
export function onboard(deps: Deps, input: OnboardingInput): OnboardingResponse {
  return inTransaction(deps, (tx) => {
    if (findSettings(tx.db)) throw alreadyOnboarded();
    assertStartMonthNotInFuture(tx, input.startMonth);
    assertStartMonthNotTooOld(tx, input.startMonth);

    writeSettings(tx, {
      currency: input.currency,
      locale: input.locale,
      startMonth: input.startMonth,
      theme: input.theme ?? DEFAULT_THEME,
      alertWarnPercent: input.alertWarnPercent ?? DEFAULT_ALERT_WARN_PERCENT,
    });

    const createdAt = timestampOf(tx.clock);
    tx.db
      .insert(salaryChanges)
      .values({ effectiveMonth: input.startMonth, amount: input.salary, createdAt })
      .run();
    tx.db
      .insert(savingsTransactions)
      .values({
        date: firstDayOf(input.startMonth),
        amount: input.openingSavings,
        kind: 'opening',
        createdAt,
      })
      .run();

    const budgetIds = (input.budgets ?? []).map((budget, index) =>
      insertBudget(tx, {
        name: budget.name,
        amount: budget.amount,
        incremental: budget.incremental,
        startMonth: input.startMonth,
        sortOrder: index * SORT_ORDER_STEP,
      }),
    );

    return {
      settings: requireSettings(tx.db),
      salary: { effectiveMonth: input.startMonth, amount: input.salary },
      openingSavings: input.openingSavings,
      budgets: loadBudgetDtos(tx, budgetIds),
    };
  });
}
