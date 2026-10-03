import { type HttpResourceRef, httpResource } from '@angular/common/http';
import { Injectable } from '@angular/core';
import type { MonthKey, MonthSummary, MonthView } from '@wallet/shared';

/** A run of months, both ends included. */
export interface MonthRange {
  from: MonthKey;
  to: MonthKey;
}

/** `/api/months`: the read model the pages show. The UI never recomputes what it returns. */
@Injectable({ providedIn: 'root' })
export class MonthsApi {
  /**
   * `GET /api/months/:month` for the month `month()` gives, reloading when it changes. While
   * `month()` is undefined nothing is requested. Call it where a resource may be created: a field
   * initializer or constructor of a component or service.
   */
  view(month: () => MonthKey | undefined): HttpResourceRef<MonthView | undefined> {
    return httpResource<MonthView>(() => {
      const key = month();
      return key ? `/api/months/${key}` : undefined;
    });
  }

  /**
   * `GET /api/months?from=&to=`: the compact row of every month in the range `range()` gives, for
   * charts and history. It reloads when the range changes, and while `range()` is undefined nothing is
   * requested. Call it where a resource may be created, like `view`.
   */
  summaries(range: () => MonthRange | undefined): HttpResourceRef<MonthSummary[] | undefined> {
    return httpResource<MonthSummary[]>(() => {
      const months = range();
      return months
        ? { url: '/api/months', params: { from: months.from, to: months.to } }
        : undefined;
    });
  }
}
