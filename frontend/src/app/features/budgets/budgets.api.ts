import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  BudgetArchiveInput,
  BudgetCreateInput,
  BudgetDto,
  BudgetUpdateInput,
  BudgetVersionInput,
  MonthKey,
} from '@wallet/shared';
import type { Observable } from 'rxjs';

/**
 * `/api/budgets`: the budgets themselves (name, color, versions, status). The figures of a month
 * (available, spent, remaining) are not here: they come from `MonthsApi`.
 */
@Injectable({ providedIn: 'root' })
export class BudgetsApi {
  private readonly http = inject(HttpClient);

  /**
   * `GET /api/budgets`: every budget of every status, ascending by `sortOrder`. Create it where a
   * resource may be created.
   */
  list(): HttpResourceRef<BudgetDto[] | undefined> {
    return httpResource<BudgetDto[]>(() => '/api/budgets');
  }

  /** `POST /api/budgets` */
  create(input: BudgetCreateInput): Observable<BudgetDto> {
    return this.http.post<BudgetDto>('/api/budgets', input);
  }

  /** `PATCH /api/budgets/:id`: name, color, icon, warning threshold, notes. */
  update(id: number, input: BudgetUpdateInput): Observable<BudgetDto> {
    return this.http.patch<BudgetDto>(`/api/budgets/${id}`, input);
  }

  /** `PUT /api/budgets/:id/versions/:month`: the amount and mode that apply from `month` on. */
  putVersion(id: number, month: MonthKey, input: BudgetVersionInput): Observable<BudgetDto> {
    return this.http.put<BudgetDto>(`/api/budgets/${id}/versions/${month}`, input);
  }

  /** `POST /api/budgets/:id/archive`: without an `endMonth` the server uses the current month. */
  archive(id: number, input: BudgetArchiveInput = {}): Observable<BudgetDto> {
    return this.http.post<BudgetDto>(`/api/budgets/${id}/archive`, input);
  }

  /** `DELETE /api/budgets/:id`: only for a budget without spendings or transfers (409 `has_history`). */
  remove(id: number): Observable<void> {
    return this.http.delete<void>(`/api/budgets/${id}`);
  }
}
