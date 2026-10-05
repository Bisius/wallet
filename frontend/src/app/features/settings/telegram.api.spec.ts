import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { TelegramNotificationSettingsInput } from '@wallet/shared';
import { telegramLinkDto, telegramPairingDto, telegramStatusDto } from '../../../testing/fixtures';
import { settle } from '../../../testing/harness';
import { TelegramApi } from './telegram.api';

describe('TelegramApi', () => {
  let http: HttpTestingController;
  let api: TelegramApi;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(TelegramApi);
  });

  afterEach(() => http.verify());

  it('status: GET /api/telegram as a resource', async () => {
    const resource = TestBed.runInInjectionContext(() => api.status());
    await settle();

    const request = http.expectOne('/api/telegram');
    expect(request.request.method).toBe('GET');
    const status = telegramStatusDto({ link: telegramLinkDto() });
    request.flush(status);
    await settle();
    expect(resource.value()).toEqual(status);
  });

  it('createPairing: POST /api/telegram/pairing with no body', () => {
    const answers: unknown[] = [];
    api.createPairing().subscribe((pairing) => answers.push(pairing));

    const request = http.expectOne('/api/telegram/pairing');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toBeNull();
    request.flush(telegramPairingDto());
    expect(answers).toEqual([telegramPairingDto()]);
  });

  it('cancelPairing: DELETE /api/telegram/pairing', () => {
    let done = false;
    api.cancelPairing().subscribe(() => (done = true));

    const request = http.expectOne('/api/telegram/pairing');
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
    expect(done).toBe(true);
  });

  it('unlink: DELETE /api/telegram/link', () => {
    let done = false;
    api.unlink().subscribe(() => (done = true));

    const request = http.expectOne('/api/telegram/link');
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
    expect(done).toBe(true);
  });

  it('saveNotifications: PUT /api/telegram/notifications with the five preferences', () => {
    const input: TelegramNotificationSettingsInput = {
      budgetAlerts: false,
      renewalYearlyDays: 14,
      renewalMonthlyDays: 0,
      monthlyRecap: true,
      notifyAt: '21:30',
    };
    const answers: unknown[] = [];
    api.saveNotifications(input).subscribe((saved) => answers.push(saved));

    const request = http.expectOne('/api/telegram/notifications');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual(input);
    request.flush(input);
    expect(answers).toEqual([input]);
  });

  it('sendTest: POST /api/telegram/test with no body', () => {
    let done = false;
    api.sendTest().subscribe(() => (done = true));

    const request = http.expectOne('/api/telegram/test');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toBeNull();
    request.flush(null, { status: 204, statusText: 'No Content' });
    expect(done).toBe(true);
  });
});
