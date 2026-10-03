import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { MonthKey, TransferCreateInput, TransferDto } from '@wallet/shared';
import type { Observable } from 'rxjs';

/**
 * `/api/transfers`: money moved between two budgets, or between a budget and the unallocated pool of
 * a month (a `null` side). A transfer is never edited: it is deleted and entered again.
 */
@Injectable({ providedIn: 'root' })
export class TransfersApi {
  private readonly http = inject(HttpClient);

  /**
   * `GET /api/transfers?month=`, newest first, reloading when `month()` changes. Nothing is requested
   * while `month()` is undefined. Create it where a resource may be created.
   */
  forMonth(month: () => MonthKey | undefined): HttpResourceRef<TransferDto[] | undefined> {
    return httpResource<TransferDto[]>(() => {
      const key = month();
      return key ? { url: '/api/transfers', params: { month: key } } : undefined;
    });
  }

  /** `POST /api/transfers`. Both sides are always sent: `null` is the unallocated pool. */
  create(input: TransferCreateInput): Observable<TransferDto> {
    return this.http.post<TransferDto>('/api/transfers', input);
  }

  /** `DELETE /api/transfers/:id` */
  remove(id: number): Observable<void> {
    return this.http.delete<void>(`/api/transfers/${id}`);
  }
}
