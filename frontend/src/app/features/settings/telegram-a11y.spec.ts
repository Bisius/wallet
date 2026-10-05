import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { TelegramStatusDto } from '@wallet/shared';
import { a11yProblems } from '../../../testing/a11y';
import { getByLabel, getByRole, typeInto } from '../../../testing/dom';
import { telegramLinkDto, telegramPairingDto, telegramStatusDto } from '../../../testing/fixtures';
import { flushError, primeStores, settle } from '../../../testing/harness';
import { openActionMenu } from '../../../testing/menu';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog';
import { TelegramSection } from './telegram-section';

@Component({
  selector: 'app-telegram-a11y-host',
  imports: [TelegramSection, ConfirmDialog],
  template: '<app-telegram-section /><app-confirm-dialog />',
})
class Host {}

const LINKED = telegramStatusDto({ link: telegramLinkDto() });
const NOT_CONFIGURED = telegramStatusDto({ configured: false, connection: 'off', bot: null });

describe('TelegramSection: markup a screen reader can use', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    // The poll of a pending code must not run on a real timer behind the spec.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  async function setup(status: TelegramStatusDto | 'loading' | 'error') {
    await primeStores(http);
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await settle(fixture);
    const request = http.expectOne('/api/telegram');
    if (status === 'error') flushError(request, 500, 'internal_error', 'Boom');
    else if (status !== 'loading') request.flush(structuredClone(status));
    await settle(fixture);
    return fixture.nativeElement as HTMLElement;
  }

  it('has nothing wrong while it loads', async () => {
    expect(a11yProblems(await setup('loading'))).toEqual([]);
  });

  it('has nothing wrong when it could not be loaded', async () => {
    expect(a11yProblems(await setup('error'))).toEqual([]);
  });

  it('has nothing wrong in the setup steps (not configured)', async () => {
    expect(a11yProblems(await setup(NOT_CONFIGURED))).toEqual([]);
  });

  it('has nothing wrong while it connects', async () => {
    expect(
      a11yProblems(await setup(telegramStatusDto({ connection: 'connecting', bot: null }))),
    ).toEqual([]);
  });

  it.each(['invalid_token', 'conflict', 'unreachable', 'blocked'] as const)(
    'has nothing wrong with the %s problem',
    async (problem) => {
      expect(
        a11yProblems(await setup(telegramStatusDto({ connection: 'error', problem }))),
      ).toEqual([]);
    },
  );

  it('has nothing wrong with the problem above a linked account', async () => {
    expect(
      a11yProblems(
        await setup(
          telegramStatusDto({
            connection: 'error',
            problem: 'unreachable',
            link: telegramLinkDto(),
          }),
        ),
      ),
    ).toEqual([]);
  });

  it('has nothing wrong before a code is made', async () => {
    expect(a11yProblems(await setup(telegramStatusDto()))).toEqual([]);
  });

  it('has nothing wrong with a code and its link', async () => {
    expect(a11yProblems(await setup(telegramStatusDto({ pairing: telegramPairingDto() })))).toEqual(
      [],
    );
  });

  it('has nothing wrong with a code and no link', async () => {
    expect(
      a11yProblems(
        await setup(telegramStatusDto({ pairing: telegramPairingDto({ deepLink: null }) })),
      ),
    ).toEqual([]);
  });

  it('has nothing wrong with the message that a code expired', async () => {
    const element = await setup(telegramStatusDto({ pairing: telegramPairingDto() }));
    vi.advanceTimersByTime(3000);
    await settle();
    http.expectOne('/api/telegram').flush(telegramStatusDto());
    await settle();

    expect(element.textContent).toContain('The code expired');
    expect(a11yProblems(element)).toEqual([]);
  });

  it('has nothing wrong with a linked account, its menu and the notifications', async () => {
    const element = await setup(LINKED);

    expect(a11yProblems(element)).toEqual([]);
    await openActionMenu(element, 'More actions for Telegram');
    expect(a11yProblems(element)).toEqual([]);
  });

  it('has nothing wrong with a linked account and a code to link another', async () => {
    expect(
      a11yProblems(
        await setup(telegramStatusDto({ link: telegramLinkDto(), pairing: telegramPairingDto() })),
      ),
    ).toEqual([]);
  });

  it('has nothing wrong with the confirmation of an unlink', async () => {
    const element = await setup(LINKED);
    await openActionMenu(element, 'More actions for Telegram');
    getByRole(element, 'button', 'Unlink').click();
    await settle();

    expect(element.querySelector('app-confirm-dialog dialog')?.hasAttribute('open')).toBe(true);
    expect(a11yProblems(element)).toEqual([]);
  });

  it('has nothing wrong with the messages of a failed test message', async () => {
    const element = await setup(LINKED);
    getByRole(element, 'button', 'Send test message').click();
    await settle();
    flushError(http.expectOne('/api/telegram/test'), 503, 'telegram_unavailable', 'Down');
    await settle();
    // The refusal makes the section read the status again.
    http.expectOne('/api/telegram').flush(structuredClone(LINKED));
    await settle();

    expect(element.textContent).toContain('No test message was sent');
    expect(a11yProblems(element)).toEqual([]);
  });

  it('has nothing wrong with the notifications showing their errors', async () => {
    const element = await setup(LINKED);
    typeInto(getByLabel(element, 'Yearly renewals: days before'), '99');
    typeInto(getByLabel(element, "Time of day (server's time zone)"), '');
    getByRole(element, 'button', 'Save notification settings').click();
    await settle();

    expect(element.querySelectorAll('[aria-invalid="true"]')).toHaveLength(2);
    expect(a11yProblems(element)).toEqual([]);
  });
});
