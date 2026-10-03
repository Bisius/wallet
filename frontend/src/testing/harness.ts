import { HttpErrorResponse } from '@angular/common/http';
import type { HttpTestingController, TestRequest } from '@angular/common/http/testing';
import { Component, Type } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { ApiError, SettingsDto, TodayResponse } from '@wallet/shared';
import { SettingsStore } from '../app/core/settings.store';
import { TodayStore } from '../app/core/today.store';

/** What the server says "today" is in these specs: the clock of the browser is never used. */
export const TODAY: TodayResponse = { date: '2026-10-02', month: '2026-10' };

export const SETTINGS: SettingsDto = {
  currency: 'EUR',
  locale: 'en-US',
  startMonth: '2026-06',
  theme: 'system',
  alertWarnPercent: 80,
};

/** A page that renders nothing, for routes the spec only navigates to. */
@Component({ selector: 'app-stub', template: '<p>stub page</p>' })
export class StubPage {}

/** Lets pending effects, microtasks and one macrotask run, as the browser would between events. */
export async function settle(fixture?: ComponentFixture<unknown>): Promise<void> {
  for (let round = 0; round < 3; round++) {
    TestBed.tick();
    fixture?.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  TestBed.tick();
  fixture?.detectChanges();
}

/** The body of an error response, in the API's shape. */
export function apiError(
  code: ApiError['error']['code'],
  message: string,
  details?: unknown,
): ApiError {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

export function errorResponse(status: number, statusText = 'Error') {
  return { status, statusText };
}

/** Answers a request with an `ApiError`. */
export function flushError(
  request: TestRequest,
  status: number,
  code: ApiError['error']['code'],
  message: string,
  details?: unknown,
): void {
  request.flush(apiError(code, message, details), errorResponse(status));
}

interface PrimeOptions {
  /** The settings, or `null` for "not onboarded" (404), or `'error'` for a failing server. */
  settings?: SettingsDto | null | 'error';
  /** Today, or `'error'` for a failing server. */
  today?: TodayResponse | 'error';
}

/**
 * Creates the settings and today stores and answers their requests, so a spec starts with the app
 * in a known state. Defaults: onboarded, with `SETTINGS`, and today `TODAY`.
 */
export async function primeStores(
  http: HttpTestingController,
  options: PrimeOptions = {},
): Promise<{ settings: SettingsStore; today: TodayStore }> {
  const settings = TestBed.inject(SettingsStore);
  const today = TestBed.inject(TodayStore);
  await settle();

  const settingsRequest = http.expectOne('/api/settings');
  const wanted = options.settings === undefined ? SETTINGS : options.settings;
  if (wanted === null) flushError(settingsRequest, 404, 'not_found', 'Settings not found');
  else if (wanted === 'error') flushError(settingsRequest, 500, 'internal_error', 'Boom');
  else settingsRequest.flush(wanted);

  const todayRequest = http.expectOne('/api/today');
  const day = options.today ?? TODAY;
  if (day === 'error') flushError(todayRequest, 500, 'internal_error', 'Boom');
  else todayRequest.flush(day);

  await settle();
  return { settings, today };
}

/** The error a failed request would give to its caller, for unit tests of the helpers. */
export function httpError(status: number, body?: unknown): HttpErrorResponse {
  return new HttpErrorResponse({ status, statusText: 'Error', error: body });
}

/** Creates a component, renders it and lets the first requests go out. */
export async function render<T>(component: Type<T>): Promise<ComponentFixture<T>> {
  const fixture = TestBed.createComponent(component);
  fixture.detectChanges();
  await settle(fixture);
  return fixture;
}
