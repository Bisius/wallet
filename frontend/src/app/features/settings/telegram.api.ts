import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  TelegramNotificationSettingsDto,
  TelegramNotificationSettingsInput,
  TelegramPairingDto,
  TelegramStatusDto,
} from '@wallet/shared';
import type { Observable } from 'rxjs';

/**
 * `/api/telegram`: the Telegram bot as Settings sees it (the contract is `shared/src/telegram.ts`).
 * Nothing here ever holds the bot token: it lives in the server's environment only.
 */
@Injectable({ providedIn: 'root' })
export class TelegramApi {
  private readonly http = inject(HttpClient);

  /**
   * `GET /api/telegram`: whether the bot is set up and connected, the linked account, the pending
   * pairing code and the notification preferences, in one read.
   */
  status(): HttpResourceRef<TelegramStatusDto | undefined> {
    return httpResource<TelegramStatusDto>(() => '/api/telegram');
  }

  /**
   * `POST /api/telegram/pairing` (no body): makes a one-time code that links an account when it is
   * sent to the bot, and replaces a pending one. 409 `telegram_not_configured` without a bot token.
   */
  createPairing(): Observable<TelegramPairingDto> {
    return this.http.post<TelegramPairingDto>('/api/telegram/pairing', null);
  }

  /** `DELETE /api/telegram/pairing`: cancels the pending code. 204 also when none is pending. */
  cancelPairing(): Observable<void> {
    return this.http.delete<void>('/api/telegram/pairing');
  }

  /** `DELETE /api/telegram/link`: unlinks the account. 404 `not_found` when nothing is linked. */
  unlink(): Observable<void> {
    return this.http.delete<void>('/api/telegram/link');
  }

  /**
   * `PUT /api/telegram/notifications`: replaces the five notification preferences. 400
   * `validation_error` for a field that is missing or out of range.
   */
  saveNotifications(
    input: TelegramNotificationSettingsInput,
  ): Observable<TelegramNotificationSettingsDto> {
    return this.http.put<TelegramNotificationSettingsDto>('/api/telegram/notifications', input);
  }

  /**
   * `POST /api/telegram/test` (no body): sends a "Wallet is connected" message to the linked chat and
   * answers 204 once Telegram accepted it. 409 `telegram_not_configured` or `telegram_not_linked`,
   * 503 `telegram_unavailable` (the bot is not running, or Telegram refused the message).
   */
  sendTest(): Observable<void> {
    return this.http.post<void>('/api/telegram/test', null);
  }
}
