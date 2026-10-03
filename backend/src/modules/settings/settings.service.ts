import {
  MAX_START_MONTH_AGE_MONTHS,
  type MonthKey,
  type SettingsDto,
  type SettingsInput,
  monthDiff,
} from '@wallet/shared';
import { eq, min, ne } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import {
  budgetTransfers,
  budgets,
  incomes,
  salaryChanges,
  savingsTransactions,
  settings,
  spendings,
  subscriptions,
} from '../../db/schema';
import { type Deps, inTransaction } from '../../lib/deps';
import { notFound, notOnboarded, ruleViolation } from '../../lib/errors';
import { currentMonthOf, firstDayOf, monthOfDate, timestampOf } from '../../lib/today';

/** The settings table holds exactly one row, with this id. */
export const SETTINGS_ID = 1;

type SettingsRow = typeof settings.$inferSelect;

function toDto(row: SettingsRow): SettingsDto {
  return {
    currency: row.currency,
    locale: row.locale,
    startMonth: row.startMonth,
    theme: row.theme,
    alertWarnPercent: row.alertWarnPercent,
  };
}

/** The settings, or null before onboarding. */
export function findSettings(db: DbOrTx): SettingsDto | null {
  const row = db.select().from(settings).where(eq(settings.id, SETTINGS_ID)).get();
  return row ? toDto(row) : null;
}

/** "Onboarded" simply means the settings exist. */
export function isOnboarded(db: DbOrTx): boolean {
  return findSettings(db) !== null;
}

/** The settings, or a 409 `not_onboarded`. For services that need `startMonth` as a lower bound. */
export function requireSettings(db: DbOrTx): SettingsDto {
  const found = findSettings(db);
  if (!found) throw notOnboarded();
  return found;
}

/** GET /api/settings: 404 until onboarded. */
export function getSettings({ db }: Deps): SettingsDto {
  const found = findSettings(db);
  if (!found) throw notFound('Settings');
  return found;
}

/** `start_month_in_future`: the current month would be untracked and have no figures. */
export function assertStartMonthNotInFuture(deps: Deps, startMonth: MonthKey): void {
  const current = currentMonthOf(deps.clock);
  if (startMonth > current) {
    throw ruleViolation(
      'start_month_in_future',
      `The start month ${startMonth} is after the current month ${current}`,
      'startMonth',
    );
  }
}

/**
 * `start_month_too_old`: more than `MAX_START_MONTH_AGE_MONTHS` months before the current month.
 * Every request recomputes the ledger from the start month, so an accidental "0001-01" would make
 * each request take seconds. Callers check it only when the start month is SET or CHANGED (the
 * first settings, or a different value), on the new value: an old start month that stays as it is
 * is never refused. Exactly `MAX_START_MONTH_AGE_MONTHS` months back is still accepted.
 */
export function assertStartMonthNotTooOld(deps: Deps, startMonth: MonthKey): void {
  const current = currentMonthOf(deps.clock);
  if (monthDiff(startMonth, current) > MAX_START_MONTH_AGE_MONTHS) {
    throw ruleViolation(
      'start_month_too_old',
      `The start month ${startMonth} is more than ${MAX_START_MONTH_AGE_MONTHS} months ` +
        `before the current month ${current}`,
      'startMonth',
    );
  }
}

/** Writes the single settings row (inserting it on first use). Callers have checked the rules. */
export function writeSettings({ db, clock }: Deps, input: SettingsInput): void {
  const values = { ...input, updatedAt: timestampOf(clock) };
  db.insert(settings)
    .values({ id: SETTINGS_ID, ...values })
    .onConflictDoUpdate({ target: settings.id, set: values })
    .run();
}

/**
 * PUT /api/settings. Replaces all five settings, and creates them on the first call (which
 * completes onboarding). The `startMonth` rules are in docs/DOMAIN.md, "Start month".
 */
export function saveSettings(deps: Deps, input: SettingsInput): SettingsDto {
  return inTransaction(deps, (tx) => {
    assertStartMonthNotInFuture(tx, input.startMonth);

    const existing = findSettings(tx.db);
    // Only a start month that is set (the first call) or changed is checked, on its new value.
    if (!existing || existing.startMonth !== input.startMonth) {
      assertStartMonthNotTooOld(tx, input.startMonth);
    }
    if (existing && input.startMonth > existing.startMonth) {
      const earliest = earliestFactMonth(tx.db);
      if (earliest !== null && earliest < input.startMonth) {
        throw ruleViolation(
          'start_month_after_facts',
          `Cannot start in ${input.startMonth}: there is data from ${earliest}. ` +
            'Delete or re-date it first',
          'startMonth',
        );
      }
    }

    writeSettings(tx, input);

    if (existing && existing.startMonth !== input.startMonth) {
      // The opening savings balance is "as of the start": its date follows the start month.
      tx.db
        .update(savingsTransactions)
        .set({ date: firstDayOf(input.startMonth) })
        .where(eq(savingsTransactions.kind, 'opening'))
        .run();
    }
    return requireSettings(tx.db);
  });
}

/**
 * The month of the earliest stored fact, or null when there are none. A fact is anything with a
 * date or an effective month (docs/DOMAIN.md, "Start month"): salary changes, incomes,
 * subscriptions, budgets, spendings, transfers, and savings transactions other than `opening`.
 *
 * A price or a version row has no month of its own as a fact: it only matters from its item's
 * start month on, so it counts as `max(its effective month, the item's start month)`. A row dated
 * before its item's start month (an older row that is still in effect at the start month, once
 * the start moved later) is inert for this check, and a row dated at or after the start month can
 * never be earlier than the item itself. Either way the item's own start month is the fact, so the
 * price and version tables are not read.
 */
export function earliestFactMonth(db: DbOrTx): MonthKey | null {
  const months: (MonthKey | null | undefined)[] = [
    db
      .select({ v: min(salaryChanges.effectiveMonth) })
      .from(salaryChanges)
      .get()?.v,
    db
      .select({ v: min(subscriptions.startMonth) })
      .from(subscriptions)
      .get()?.v,
    db
      .select({ v: min(budgets.startMonth) })
      .from(budgets)
      .get()?.v,
    db
      .select({ v: min(savingsTransactions.settlesMonth) })
      .from(savingsTransactions)
      .get()?.v,
  ];
  const dates: (string | null | undefined)[] = [
    db
      .select({ v: min(incomes.date) })
      .from(incomes)
      .get()?.v,
    db
      .select({ v: min(spendings.date) })
      .from(spendings)
      .get()?.v,
    db
      .select({ v: min(budgetTransfers.date) })
      .from(budgetTransfers)
      .get()?.v,
    db
      .select({ v: min(savingsTransactions.date) })
      .from(savingsTransactions)
      .where(ne(savingsTransactions.kind, 'opening'))
      .get()?.v,
  ];
  for (const date of dates) months.push(date ? monthOfDate(date) : null);

  let earliest: MonthKey | null = null;
  for (const month of months) {
    if (month && (earliest === null || month < earliest)) earliest = month;
  }
  return earliest;
}
