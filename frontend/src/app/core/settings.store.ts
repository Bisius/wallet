import { HttpClient, HttpErrorResponse, httpResource } from '@angular/common/http';
import { computed, inject, Injectable, Injector, LOCALE_ID } from '@angular/core';
import type { SettingsDto, SettingsInput, Theme } from '@wallet/shared';
import { type Observable, tap } from 'rxjs';
import { waitUntil } from './wait-until';

/**
 * - `loading`: no answer yet.
 * - `onboarded`: the settings exist.
 * - `not-onboarded`: the API answered 404, so the user has to go through onboarding.
 * - `error`: the settings could not be loaded for another reason (server down, 500, ...).
 */
export type SettingsState = 'loading' | 'onboarded' | 'not-onboarded' | 'error';

/** A state that is final until something reloads the store. */
export type SettledSettingsState = Exclude<SettingsState, 'loading'>;

// Display fallbacks for the moment before the settings have loaded. They are not business rules.
const FALLBACK_CURRENCY = 'EUR';
const FALLBACK_THEME: Theme = 'system';
const FALLBACK_ALERT_WARN_PERCENT = 80;

/**
 * The user's settings (`GET /api/settings`), as signals. Currency and locale drive `MoneyPipe`, the
 * theme drives `ThemeService`, and `state` drives the onboarding guards.
 */
@Injectable({ providedIn: 'root' })
export class SettingsStore {
  private readonly http = inject(HttpClient);
  private readonly injector = inject(Injector);
  private readonly defaultLocale = inject(LOCALE_ID);
  private readonly resource = httpResource<SettingsDto>(() => '/api/settings');

  readonly state = computed<SettingsState>(() => {
    switch (this.resource.status()) {
      case 'resolved':
      case 'local':
        return this.resource.hasValue() ? 'onboarded' : 'not-onboarded';
      case 'reloading':
        return this.resource.hasValue() ? 'onboarded' : 'loading';
      case 'error': {
        const error = this.resource.error();
        return error instanceof HttpErrorResponse && error.status === 404
          ? 'not-onboarded'
          : 'error';
      }
      default:
        return 'loading';
    }
  });

  /** The settings, or undefined until onboarded. */
  readonly settings = computed<SettingsDto | undefined>(() =>
    this.resource.hasValue() ? this.resource.value() : undefined,
  );
  readonly onboarded = computed(() => this.state() === 'onboarded');
  /** Why loading failed, while `state()` is `error`. */
  readonly error = computed(() => (this.state() === 'error' ? this.resource.error() : undefined));

  readonly currency = computed(() => this.settings()?.currency ?? FALLBACK_CURRENCY);
  readonly locale = computed(() => this.settings()?.locale ?? this.defaultLocale);
  readonly theme = computed<Theme>(() => this.settings()?.theme ?? FALLBACK_THEME);
  readonly alertWarnPercent = computed(
    () => this.settings()?.alertWarnPercent ?? FALLBACK_ALERT_WARN_PERCENT,
  );
  /** First tracked month. undefined until onboarded. */
  readonly startMonth = computed(() => this.settings()?.startMonth);

  /** Resolves once the state is final: not `loading`. */
  settled(): Promise<SettledSettingsState> {
    return waitUntil(this.injector, () => {
      const state = this.state();
      return state === 'loading' ? undefined : state;
    });
  }

  /** Fetches the settings again. The state is `loading` right away when there is nothing to show. */
  reload(): void {
    this.resource.reload();
  }

  /** Takes settings the app already has (the response of onboarding or of a save). */
  seed(settings: SettingsDto): void {
    this.resource.set(settings);
  }

  /** The API said the app is not onboarded (409 `not_onboarded`): forget any settings we had. */
  markNotOnboarded(): void {
    this.resource.set(undefined);
  }

  /** `PUT /api/settings`. The store holds the saved settings once the request succeeds. */
  save(input: SettingsInput): Observable<SettingsDto> {
    return this.http
      .put<SettingsDto>('/api/settings', input)
      .pipe(tap((saved) => this.seed(saved)));
  }
}
