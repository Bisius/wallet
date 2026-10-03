import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  Cents,
  MonthKey,
  SpendingCreateInput,
  SpendingDto,
  SpendingsPage,
  SpendingUpdateInput,
} from '@wallet/shared';
import { SPENDINGS_DEFAULT_LIMIT } from '@wallet/shared/limits';
import type { Observable } from 'rxjs';

/** Which spendings a list shows. Every narrowing field that is empty (`null`, `''`) is not sent. */
export interface SpendingsFilter {
  /** Only this month's spendings. `null`: every month, so no date filter is sent. */
  month: MonthKey | null;
  /** Only this budget's spendings. `null`: every budget. */
  budgetId: number | null;
  /** Only spendings that carry this tag. `null`: any. */
  tagId: number | null;
  /** Text to find in the description or the notes, trimmed. `''`: no search. */
  q: string;
  /** Signed cents, as stored (a refund is negative), both bounds inclusive. `null`: no bound. */
  minAmount: Cents | null;
  maxAmount: Cents | null;
}

/** The query of `GET /api/spendings` for a filter and the page that starts at `offset`. */
function queryOf(filter: SpendingsFilter, offset: number): Record<string, string | number> {
  return {
    ...(filter.month === null ? {} : { month: filter.month }),
    ...(filter.budgetId === null ? {} : { budgetId: filter.budgetId }),
    ...(filter.tagId === null ? {} : { tagId: filter.tagId }),
    ...(filter.q === '' ? {} : { q: filter.q }),
    ...(filter.minAmount === null ? {} : { minAmount: filter.minAmount }),
    ...(filter.maxAmount === null ? {} : { maxAmount: filter.maxAmount }),
    limit: SPENDINGS_DEFAULT_LIMIT,
    offset,
  };
}

/** `/api/spendings`. Amounts are cents: negative is a refund. */
@Injectable({ providedIn: 'root' })
export class SpendingsApi {
  private readonly http = inject(HttpClient);

  /** The page size of every request. */
  readonly pageSize = SPENDINGS_DEFAULT_LIMIT;

  /**
   * `GET /api/spendings` for the first page of a filter, newest first, reloading when the filter
   * changes. Nothing is requested while `filter()` is undefined. Create it where a resource may be
   * created.
   */
  firstPage(filter: () => SpendingsFilter | undefined): HttpResourceRef<SpendingsPage | undefined> {
    return httpResource<SpendingsPage>(() => {
      const current = filter();
      return current ? { url: '/api/spendings', params: queryOf(current, 0) } : undefined;
    });
  }

  /** `GET /api/spendings` for the page that starts at `offset` ("Load more"). */
  pageAt(filter: SpendingsFilter, offset: number): Observable<SpendingsPage> {
    return this.http.get<SpendingsPage>('/api/spendings', { params: queryOf(filter, offset) });
  }

  /** `POST /api/spendings` */
  create(input: SpendingCreateInput): Observable<SpendingDto> {
    return this.http.post<SpendingDto>('/api/spendings', input);
  }

  /** `PATCH /api/spendings/:id`: any subset of the fields, at least one. */
  update(id: number, input: SpendingUpdateInput): Observable<SpendingDto> {
    return this.http.patch<SpendingDto>(`/api/spendings/${id}`, input);
  }

  /** `DELETE /api/spendings/:id` */
  remove(id: number): Observable<void> {
    return this.http.delete<void>(`/api/spendings/${id}`);
  }
}
