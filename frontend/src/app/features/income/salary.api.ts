import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { MonthKey, SalaryEntryDto, SalaryUpsertInput } from '@wallet/shared';
import type { Observable } from 'rxjs';

/** `/api/salary`: the salary history. A change applies from its month onward. */
@Injectable({ providedIn: 'root' })
export class SalaryApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/salary`: every salary change, ascending by month. Create it where a resource may be created. */
  history(): HttpResourceRef<SalaryEntryDto[] | undefined> {
    return httpResource<SalaryEntryDto[]>(() => '/api/salary');
  }

  /** `PUT /api/salary/:month`: sets the salary that applies from `month` onward (adds or replaces that entry). */
  upsert(month: MonthKey, input: SalaryUpsertInput): Observable<SalaryEntryDto> {
    return this.http.put<SalaryEntryDto>(`/api/salary/${month}`, input);
  }

  /** `DELETE /api/salary/:month`: removes the entry that starts exactly in `month`. */
  remove(month: MonthKey): Observable<void> {
    return this.http.delete<void>(`/api/salary/${month}`);
  }
}
