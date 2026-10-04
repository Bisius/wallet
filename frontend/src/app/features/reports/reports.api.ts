import { type HttpResourceRef, httpResource } from '@angular/common/http';
import { Injectable } from '@angular/core';
import type { YearlyReportDto } from '@wallet/shared';
import { reloadOnDataChange } from '../../core/data-changes';

/** `/api/reports`: sums over time, computed by the backend from the same ledger as the months. */
@Injectable({ providedIn: 'root' })
export class ReportsApi {
  /**
   * `GET /api/reports/yearly/:year` for the year `year()` gives, reloading when it changes. While
   * `year()` is undefined nothing is requested. A year with no tracked month is a 404, which the
   * resource reports as its error. Call it where a resource may be created. It loads again when
   * something is added elsewhere in the app (`DataChanges`: the shell's Add spending).
   */
  yearly(year: () => number | undefined): HttpResourceRef<YearlyReportDto | undefined> {
    return reloadOnDataChange(
      httpResource<YearlyReportDto>(() => {
        const value = year();
        return value === undefined
          ? undefined
          : `/api/reports/yearly/${String(value).padStart(4, '0')}`;
      }),
    );
  }
}
