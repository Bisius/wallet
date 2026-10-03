import type { TodayResponse } from '@wallet/shared';
import type { Deps } from '../../lib/deps';
import { monthOfDate, todayOf } from '../../lib/today';

/** The server's "today" (clock + `TZ`) and the month it falls in. */
export function getToday({ clock }: Pick<Deps, 'clock'>): TodayResponse {
  const date = todayOf(clock);
  return { date, month: monthOfDate(date) };
}
