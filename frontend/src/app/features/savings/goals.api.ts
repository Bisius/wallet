import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { GoalCreateInput, GoalDto, GoalUpdateInput } from '@wallet/shared';
import type { Observable } from 'rxjs';

/**
 * `/api/goals`: creating, changing, archiving and deleting goals. They are read with the rest of
 * the savings (`SavingsStore`, whose `goals` carry the derived figures), so there is no list here.
 */
@Injectable({ providedIn: 'root' })
export class GoalsApi {
  private readonly http = inject(HttpClient);

  /** `POST /api/goals` */
  create(input: GoalCreateInput): Observable<GoalDto> {
    return this.http.post<GoalDto>('/api/goals', input);
  }

  /** `PATCH /api/goals/:id`: any subset of the fields. `null` clears the deadline and the color. */
  update(id: number, input: GoalUpdateInput): Observable<GoalDto> {
    return this.http.patch<GoalDto>(`/api/goals/${id}`, input);
  }

  /** `DELETE /api/goals/:id`: the balance moves to unassigned savings. */
  remove(id: number): Observable<void> {
    return this.http.delete<void>(`/api/goals/${id}`);
  }
}
