import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  MonthKey,
  SubscriptionCancelInput,
  SubscriptionCreateInput,
  SubscriptionDto,
  SubscriptionPriceInput,
  SubscriptionUpdateInput,
  UpcomingRenewalDto,
} from '@wallet/shared';
import { UPCOMING_DEFAULT_DAYS } from '@wallet/shared/limits';
import type { Observable } from 'rxjs';

/**
 * `/api/subscriptions`: the subscriptions themselves (name, frequency, prices, status). What a
 * month sets aside for them comes from `MonthsApi`.
 */
@Injectable({ providedIn: 'root' })
export class SubscriptionsApi {
  private readonly http = inject(HttpClient);

  /**
   * `GET /api/subscriptions`: every subscription of every status, ascending by name. Create it where
   * a resource may be created.
   */
  list(): HttpResourceRef<SubscriptionDto[] | undefined> {
    return httpResource<SubscriptionDto[]>(() => '/api/subscriptions');
  }

  /**
   * `GET /api/subscriptions/upcoming?days=`: each subscription's next billing date within `days`
   * days of today, ascending by date. It asks for nothing while `today()` is undefined (the server's
   * date is not known yet) and asks again when it changes. Create it where a resource may be created.
   */
  upcoming(
    today: () => string | undefined,
    days: number = UPCOMING_DEFAULT_DAYS,
  ): HttpResourceRef<UpcomingRenewalDto[] | undefined> {
    return httpResource<UpcomingRenewalDto[]>(() =>
      today() === undefined ? undefined : { url: '/api/subscriptions/upcoming', params: { days } },
    );
  }

  /** `POST /api/subscriptions` */
  create(input: SubscriptionCreateInput): Observable<SubscriptionDto> {
    return this.http.post<SubscriptionDto>('/api/subscriptions', input);
  }

  /** `PATCH /api/subscriptions/:id`: name, charge date, color, notes. */
  update(id: number, input: SubscriptionUpdateInput): Observable<SubscriptionDto> {
    return this.http.patch<SubscriptionDto>(`/api/subscriptions/${id}`, input);
  }

  /** `PUT /api/subscriptions/:id/prices/:month`: the price that applies from `month` on. */
  putPrice(
    id: number,
    month: MonthKey,
    input: SubscriptionPriceInput,
  ): Observable<SubscriptionDto> {
    return this.http.put<SubscriptionDto>(`/api/subscriptions/${id}/prices/${month}`, input);
  }

  /** `POST /api/subscriptions/:id/cancel`: without an `endMonth` the server uses the current month. */
  cancel(id: number, input: SubscriptionCancelInput = {}): Observable<SubscriptionDto> {
    return this.http.post<SubscriptionDto>(`/api/subscriptions/${id}/cancel`, input);
  }

  /** `DELETE /api/subscriptions/:id`: also removes it from every past month. */
  remove(id: number): Observable<void> {
    return this.http.delete<void>(`/api/subscriptions/${id}`);
  }
}
