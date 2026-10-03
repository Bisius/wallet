import {
  type SavingsDto,
  type SavingsOpeningDto,
  type SavingsOpeningInput,
  addMonths,
  sumCents,
} from '@wallet/shared';
import { asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { savingsTransactions } from '../../db/schema';
import { loadFacts } from '../../domain/facts';
import { computeLedger } from '../../domain/ledger';
import { outstandingMonths } from '../../domain/savings';
import { loadSavingsFacts } from '../../domain/savings-facts';
import { type Deps, inTransaction } from '../../lib/deps';
import { firstDayOf, monthOfDate, timestampOf, todayOf } from '../../lib/today';
import { loadGoalDtos } from '../goals/goals.service';
import { requireSettings } from '../settings/settings.service';

/**
 * GET /api/savings: the balance, how it is spread and what is still to settle. Everything is
 * derived (nothing about the outstanding months is stored): the ledger through the month before
 * the current one gives each closed month's `savingsDue`, the `settlement` rows give what was
 * settled, and the sums of the transactions give the balances.
 */
export function getSavings(deps: Deps): SavingsDto {
  const facts = loadFacts(deps.db);
  const today = todayOf(deps.clock);
  const ledger = computeLedger(facts, addMonths(monthOfDate(today), -1), today);
  const savings = loadSavingsFacts(deps.db);
  const outstanding = outstandingMonths(ledger, savings.settlements);

  return {
    balance: sumCents([...savings.balances.values()]),
    unassigned: savings.balances.get(null) ?? 0,
    goals: loadGoalDtos(deps, savings),
    outstanding,
    outstandingTotal: sumCents(outstanding.map((month) => month.outstanding)),
  };
}

/** The one `opening` row, or undefined while there is none. */
function findOpeningRow(db: DbOrTx) {
  return db
    .select()
    .from(savingsTransactions)
    .where(eq(savingsTransactions.kind, 'opening'))
    .orderBy(asc(savingsTransactions.id))
    .get();
}

/**
 * GET /api/savings/opening: the savings balance on the first day of `settings.startMonth`. Without
 * an `opening` row (a first `PUT /api/settings` creates none) the amount is 0. The date is always
 * the first day of the start month.
 */
export function getOpening({ db }: Deps): SavingsOpeningDto {
  const { startMonth } = requireSettings(db);
  return { amount: findOpeningRow(db)?.amount ?? 0, date: firstDayOf(startMonth) };
}

/**
 * PUT /api/savings/opening: creates or updates the one `opening` row. It belongs to no goal and is
 * always dated the first day of the start month.
 */
export function setOpening(deps: Deps, input: SavingsOpeningInput): SavingsOpeningDto {
  return inTransaction(deps, ({ db, clock }) => {
    const date = firstDayOf(requireSettings(db).startMonth);
    const existing = findOpeningRow(db);
    if (existing) {
      db.update(savingsTransactions)
        .set({ amount: input.amount, date })
        .where(eq(savingsTransactions.id, existing.id))
        .run();
    } else {
      db.insert(savingsTransactions)
        .values({ date, amount: input.amount, kind: 'opening', createdAt: timestampOf(clock) })
        .run();
    }
    return { amount: input.amount, date };
  });
}
