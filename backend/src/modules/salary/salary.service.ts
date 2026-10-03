import type { MonthKey, SalaryEntryDto, SalaryUpsertInput } from '@wallet/shared';
import { asc, eq } from 'drizzle-orm';
import { salaryChanges } from '../../db/schema';
import type { Deps } from '../../lib/deps';
import { notFound, ruleViolation } from '../../lib/errors';
import { timestampOf } from '../../lib/today';
import { requireSettings } from '../settings/settings.service';

const toDto = (row: { effectiveMonth: MonthKey; amount: number }): SalaryEntryDto => ({
  effectiveMonth: row.effectiveMonth,
  amount: row.amount,
});

/** GET /api/salary: the salary history, ascending by effective month. */
export function listSalary({ db }: Deps): SalaryEntryDto[] {
  return db
    .select()
    .from(salaryChanges)
    .orderBy(asc(salaryChanges.effectiveMonth))
    .all()
    .map(toDto);
}

/**
 * PUT /api/salary/:month: sets the salary effective from `month` (replacing the entry for exactly
 * that month if there is one). Nothing can start before `settings.startMonth`.
 */
export function putSalary(
  { db, clock }: Deps,
  month: MonthKey,
  input: SalaryUpsertInput,
): SalaryEntryDto {
  const { startMonth } = requireSettings(db);
  if (month < startMonth) {
    throw ruleViolation(
      'before_start_month',
      `A salary cannot start in ${month}, before the start month ${startMonth}`,
      'month',
    );
  }
  db.insert(salaryChanges)
    .values({ effectiveMonth: month, amount: input.amount, createdAt: timestampOf(clock) })
    .onConflictDoUpdate({ target: salaryChanges.effectiveMonth, set: { amount: input.amount } })
    .run();
  return { effectiveMonth: month, amount: input.amount };
}

/** DELETE /api/salary/:month: removes the entry effective from exactly that month (404 if none). */
export function deleteSalary({ db }: Deps, month: MonthKey): void {
  const removed = db
    .delete(salaryChanges)
    .where(eq(salaryChanges.effectiveMonth, month))
    .returning({ id: salaryChanges.id })
    .all();
  if (removed.length === 0) throw notFound('Salary entry');
}
