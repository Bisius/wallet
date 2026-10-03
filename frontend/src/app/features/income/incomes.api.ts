import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { IncomeCreateInput, IncomeDto, IncomeUpdateInput, MonthKey } from '@wallet/shared';
import type { Observable } from 'rxjs';

/** `/api/incomes`: one-off incomes (bonuses, refunds, ...) counted in the month of their date. */
@Injectable({ providedIn: 'root' })
export class IncomesApi {
  private readonly http = inject(HttpClient);

  /**
   * `GET /api/incomes?month=`, newest first, reloading when `month()` changes. Nothing is requested
   * while `month()` is undefined. Create it where a resource may be created.
   */
  forMonth(month: () => MonthKey | undefined): HttpResourceRef<IncomeDto[] | undefined> {
    return httpResource<IncomeDto[]>(() => {
      const key = month();
      return key ? { url: '/api/incomes', params: { month: key } } : undefined;
    });
  }

  /** `POST /api/incomes` */
  create(input: IncomeCreateInput): Observable<IncomeDto> {
    return this.http.post<IncomeDto>('/api/incomes', input);
  }

  /** `PATCH /api/incomes/:id`: any subset of the fields, at least one. */
  update(id: number, input: IncomeUpdateInput): Observable<IncomeDto> {
    return this.http.patch<IncomeDto>(`/api/incomes/${id}`, input);
  }

  /** `DELETE /api/incomes/:id` */
  remove(id: number): Observable<void> {
    return this.http.delete<void>(`/api/incomes/${id}`);
  }
}
