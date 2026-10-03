import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  Cents,
  MonthKey,
  Page,
  SavingsOpeningDto,
  SavingsSettleInput,
  SavingsTransactionCreateInput,
  SavingsTransactionDto,
  SavingsTransactionKind,
} from '@wallet/shared';
import { SAVINGS_TRANSACTIONS_DEFAULT_LIMIT } from '@wallet/shared/limits';
import type { Observable } from 'rxjs';

/** Where a history is limited to: every row, the unassigned savings, or the rows of one goal. */
export type PlaceFilter = 'all' | 'unassigned' | number;

/** Which rows of the savings history a list shows. The filters combine. */
export interface HistoryFilter {
  place: PlaceFilter;
  /** Only this kind of row. `null`: every kind. */
  kind: SavingsTransactionKind | null;
}

export const NO_HISTORY_FILTER: HistoryFilter = { place: 'all', kind: null };

/** The query of `GET /api/savings/transactions` for a filter and the page that starts at `offset`. */
function queryOf(filter: HistoryFilter, offset: number): Record<string, string | number> {
  return {
    ...(typeof filter.place === 'number' ? { goalId: filter.place } : {}),
    ...(filter.place === 'unassigned' ? { unassigned: 'true' } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
    limit: SAVINGS_TRANSACTIONS_DEFAULT_LIMIT,
    offset,
  };
}

/**
 * `/api/savings/*`: settling months, manual money, the history and the opening balance. The overview
 * itself (`GET /api/savings`) is the `SavingsStore`, and the goals are in `GoalsApi`. Amounts are
 * cents, and an amount is signed where the API says so (a negative one takes money out).
 */
@Injectable({ providedIn: 'root' })
export class SavingsApi {
  private readonly http = inject(HttpClient);

  /** The page size of every history request. */
  readonly pageSize = SAVINGS_TRANSACTIONS_DEFAULT_LIMIT;

  /**
   * `POST /api/savings/settle/:month`: settles a closed month. `input.amount` is the outstanding the
   * user saw (409 `outstanding_changed` when it moved since), and without `allocations` the whole
   * amount goes to unassigned savings.
   */
  settle(month: MonthKey, input: SavingsSettleInput): Observable<SavingsTransactionDto[]> {
    return this.http.post<SavingsTransactionDto[]>(`/api/savings/settle/${month}`, input);
  }

  /** `DELETE /api/savings/settle/:month`: removes every settlement row of the month (404 if none). */
  undoSettlement(month: MonthKey): Observable<void> {
    return this.http.delete<void>(`/api/savings/settle/${month}`);
  }

  /** `POST /api/savings/transactions`: a deposit, a withdrawal or a reallocation. */
  addTransaction(input: SavingsTransactionCreateInput): Observable<SavingsTransactionDto[]> {
    return this.http.post<SavingsTransactionDto[]>('/api/savings/transactions', input);
  }

  /** `DELETE /api/savings/transactions/:id`: a deposit, a withdrawal or a reallocation (both rows). */
  removeTransaction(id: number): Observable<void> {
    return this.http.delete<void>(`/api/savings/transactions/${id}`);
  }

  /**
   * `GET /api/savings/transactions` for the first page of a filter, newest first, reloading when the
   * filter changes. Nothing is requested while `filter()` is undefined. Create it where a resource
   * may be created.
   */
  firstPage(
    filter: () => HistoryFilter | undefined,
  ): HttpResourceRef<Page<SavingsTransactionDto> | undefined> {
    return httpResource<Page<SavingsTransactionDto>>(() => {
      const current = filter();
      return current
        ? { url: '/api/savings/transactions', params: queryOf(current, 0) }
        : undefined;
    });
  }

  /** `GET /api/savings/transactions` for the page that starts at `offset` ("Load more"). */
  pageAt(filter: HistoryFilter, offset: number): Observable<Page<SavingsTransactionDto>> {
    return this.http.get<Page<SavingsTransactionDto>>('/api/savings/transactions', {
      params: queryOf(filter, offset),
    });
  }

  /**
   * `GET /api/savings/opening`: the balance on the first day of the start month. Nothing is
   * requested while `when()` is false. Create it where a resource may be created.
   */
  opening(when: () => boolean = () => true): HttpResourceRef<SavingsOpeningDto | undefined> {
    return httpResource<SavingsOpeningDto>(() => (when() ? '/api/savings/opening' : undefined));
  }

  /** `PUT /api/savings/opening`: sets the balance on the first day of the start month (0 or more). */
  setOpening(amount: Cents): Observable<SavingsOpeningDto> {
    return this.http.put<SavingsOpeningDto>('/api/savings/opening', { amount });
  }
}
