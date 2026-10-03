import type {
  IncomeCreateInput,
  IncomeDto,
  IncomeListQuery,
  IncomeUpdateInput,
  IsoDate,
} from '@wallet/shared';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { incomes } from '../../db/schema';
import type { Deps } from '../../lib/deps';
import { notFound, ruleViolation } from '../../lib/errors';
import { monthBounds, monthOfDate, timestampOf } from '../../lib/today';
import { requireSettings } from '../settings/settings.service';

type IncomeRow = typeof incomes.$inferSelect;

const toDto = (row: IncomeRow): IncomeDto => ({
  id: row.id,
  date: row.date,
  amount: row.amount,
  description: row.description,
});

/** `before_start_month`: nothing is accepted before `settings.startMonth`. */
function assertNotBeforeStart({ db }: Deps, date: IsoDate): void {
  const { startMonth } = requireSettings(db);
  if (monthOfDate(date) < startMonth) {
    throw ruleViolation(
      'before_start_month',
      `An income cannot be dated ${date}, before the start month ${startMonth}`,
      'date',
    );
  }
}

/** GET /api/incomes: newest first (date, then id, descending), optionally one month. */
export function listIncomes({ db }: Deps, query: IncomeListQuery): IncomeDto[] {
  const where = query.month
    ? and(
        gte(incomes.date, monthBounds(query.month).from),
        lte(incomes.date, monthBounds(query.month).to),
      )
    : undefined;
  return db
    .select()
    .from(incomes)
    .where(where)
    .orderBy(desc(incomes.date), desc(incomes.id))
    .all()
    .map(toDto);
}

export function createIncome(deps: Deps, input: IncomeCreateInput): IncomeDto {
  assertNotBeforeStart(deps, input.date);
  const row = deps.db
    .insert(incomes)
    .values({ ...input, createdAt: timestampOf(deps.clock) })
    .returning()
    .get();
  return toDto(row);
}

export function updateIncome(deps: Deps, id: number, input: IncomeUpdateInput): IncomeDto {
  const current = deps.db.select().from(incomes).where(eq(incomes.id, id)).get();
  if (!current) throw notFound('Income');
  assertNotBeforeStart(deps, input.date ?? current.date);
  const row = deps.db.update(incomes).set(input).where(eq(incomes.id, id)).returning().get();
  return toDto(row);
}

export function deleteIncome({ db }: Deps, id: number): void {
  const removed = db.delete(incomes).where(eq(incomes.id, id)).returning({ id: incomes.id }).all();
  if (removed.length === 0) throw notFound('Income');
}
