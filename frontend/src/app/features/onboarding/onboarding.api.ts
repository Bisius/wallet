import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { OnboardingInput, OnboardingResponse } from '@wallet/shared';
import type { Observable } from 'rxjs';

/** `/api/onboarding`. */
@Injectable({ providedIn: 'root' })
export class OnboardingApi {
  private readonly http = inject(HttpClient);

  /** `POST /api/onboarding`: the whole wizard in one atomic request. */
  submit(input: OnboardingInput): Observable<OnboardingResponse> {
    return this.http.post<OnboardingResponse>('/api/onboarding', input);
  }
}
