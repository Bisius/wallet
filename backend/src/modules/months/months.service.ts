import {
  MAX_MONTHS_AHEAD,
  MAX_MONTH_RANGE,
  type MonthKey,
  type MonthListQuery,
  type MonthSummary,
  type MonthView,
  addMonths,
  monthDiff,
} from '@wallet/shared';
import { loadFacts } from '../../domain/facts';
import { computeLedger, ledgerMonth, toMonthSummary, toMonthView } from '../../domain/ledger';
import type { Deps } from '../../lib/deps';
import { apiError } from '../../lib/errors';
import { currentMonthOf, todayOf } from '../../lib/today';

/** How far ahead the list goes when `to` is omitted: the current month and the next 11. */
const DEFAULT_MONTHS_AHEAD = 11;

/**
 * GET /api/months/:month: the month's figures. The rules apply the same way to every month, so a
 * past, the current and a future month all come from one run of the ledger from `startMonth`
 * (balances and reserves carry from month to month). 404 outside `startMonth..current + 120`.
 */
export function getMonthView(deps: Deps, month: MonthKey): MonthView {
  const facts = loadFacts(deps.db);
  const horizon = addMonths(currentMonthOf(deps.clock), MAX_MONTHS_AHEAD);
  if (month < facts.startMonth || month > horizon) {
    throw apiError(
      'not_found',
      `Month ${month} is outside the tracked months (${facts.startMonth} to ${horizon})`,
    );
  }
  const ledger = computeLedger(facts, month, todayOf(deps.clock));
  const row = ledgerMonth(ledger, month);
  if (!row) throw new Error(`The ledger has no row for ${month}`); // unreachable: checked above
  return toMonthView(row);
}

/**
 * GET /api/months?from=&to=: the compact rows, ascending. Defaults: `to` is the current month + 11,
 * `from` is `startMonth` but never earlier than `to` - 119. The schema has already rejected an
 * explicit `from` after `to` or a range wider than MAX_MONTH_RANGE; here the same two checks cover
 * the case where one end is defaulted. The range is then cut to
 * `startMonth..current + MAX_MONTHS_AHEAD`, so a range outside it is `[]`.
 */
export function listMonthSummaries(deps: Deps, query: MonthListQuery): MonthSummary[] {
  const facts = loadFacts(deps.db);
  const current = currentMonthOf(deps.clock);
  const horizon = addMonths(current, MAX_MONTHS_AHEAD);

  const to = query.to ?? addMonths(current, DEFAULT_MONTHS_AHEAD);
  if (query.from !== undefined && query.to === undefined) {
    // `from` is explicit but `to` is the default: apply the checks the schema could not.
    if (query.from > to) {
      throw invalidRange(
        'from',
        '`from` must not be after `to` (the default `to` is the current month + 11)',
      );
    }
    if (monthDiff(query.from, to) >= MAX_MONTH_RANGE) {
      throw invalidRange(
        'from',
        `The range is limited to ${MAX_MONTH_RANGE} months (the default \`to\` is the current month + 11)`,
      );
    }
  }
  const widest = addMonths(to, -(MAX_MONTH_RANGE - 1));
  const from = query.from ?? (facts.startMonth > widest ? facts.startMonth : widest);

  const first = from > facts.startMonth ? from : facts.startMonth;
  const last = to < horizon ? to : horizon;
  if (first > last) return [];

  const ledger = computeLedger(facts, last, todayOf(deps.clock));
  return ledger.months.filter((row) => row.month >= first).map(toMonthSummary);
}

/** A 400 `validation_error` for a query problem only the service can see (it needs the clock). */
function invalidRange(path: string, message: string) {
  return apiError('validation_error', 'Invalid request', [{ path, message }]);
}
