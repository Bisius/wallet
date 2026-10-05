import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { TelegramStatusDto } from '@wallet/shared';
import {
  getByLabel,
  getByRole,
  queryAllByRole,
  queryByRole,
  textOf,
  typeInto,
} from '../../../testing/dom';
import { telegramLinkDto, telegramPairingDto, telegramStatusDto } from '../../../testing/fixtures';
import { flushError, primeStores, settle } from '../../../testing/harness';
import { menuItemNames, rowAction } from '../../../testing/menu';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog';
import { ToastContainer } from '../../shared/ui/toast-container';
import { ToastService } from '../../shared/ui/toast.service';
import { TELEGRAM_POLL_MS, TelegramSection } from './telegram-section';

@Component({
  selector: 'app-telegram-host',
  imports: [TelegramSection, ConfirmDialog, ToastContainer],
  template: '<app-telegram-section /><app-confirm-dialog /><app-toast-container />',
})
class Host {}

/** What the browser's clock says in these specs: ten minutes before the default code expires. */
const NOW = new Date('2026-10-05T10:00:00.000Z');

/** What a person in any time zone reads for an instant: the same formatter the section uses. */
const clock = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { timeStyle: 'short' }).format(new Date(iso));
const when = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );

const NO_CONTENT = { status: 204, statusText: 'No Content' };

const LINKED = telegramStatusDto({ link: telegramLinkDto() });
const PENDING = telegramStatusDto({ pairing: telegramPairingDto() });

describe('TelegramSection', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    // Only the clock and the interval are faked: `settle` waits on a real timer.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  async function setup(status: TelegramStatusDto | 'loading' | 'error' = telegramStatusDto()) {
    await primeStores(http);
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await settle(fixture);
    const request = http.expectOne('/api/telegram');
    if (status === 'error') flushError(request, 500, 'internal_error', 'No telegram table');
    else if (status !== 'loading') request.flush(structuredClone(status));
    await settle(fixture);

    const element = fixture.nativeElement as HTMLElement;
    const section = () => getByRole(element, 'region', 'Telegram');
    const confirmDialog = () =>
      element.querySelector<HTMLDialogElement>('app-confirm-dialog dialog')!;
    return {
      fixture,
      element,
      section,
      confirmDialog,
      text: () => textOf(section()),
      press: async (name: string | RegExp, root: ParentNode = element) => {
        getByRole(root, 'button', name).click();
        await settle(fixture);
      },
      menuAction: (item: string | RegExp) => rowAction(element, item, 'More actions for Telegram'),
      toasts: () =>
        TestBed.inject(ToastService)
          .toasts()
          .map((toast) => toast.message),
      /** Answers the read the section makes after a change (or a poll). */
      answerStatus: async (answer: TelegramStatusDto) => {
        await settle(fixture);
        // A copy: the real API gives a new object every time, and the test backend would hand back this one.
        http.expectOne('/api/telegram').flush(structuredClone(answer));
        await settle(fixture);
      },
      /** The 3 seconds of the poll pass. */
      tick: async (ms = TELEGRAM_POLL_MS) => {
        vi.advanceTimersByTime(ms);
        await settle(fixture);
      },
    };
  }

  describe('while it loads', () => {
    it('says it is loading', async () => {
      const t = await setup('loading');

      expect(t.text()).toContain('Loading Telegram…');
      expect(queryByRole(t.element, 'button', 'Link Telegram')).toBeNull();
    });

    it("says what went wrong when it can't be loaded, and tries again", async () => {
      const t = await setup('error');

      const alert = getByRole(t.section(), 'alert');
      expect(textOf(alert)).toContain("Couldn't load Telegram");
      expect(textOf(alert)).toContain('No telegram table');

      await t.press('Try again');
      await t.answerStatus(telegramStatusDto());
      expect(queryByRole(t.element, 'button', 'Link Telegram')).not.toBeNull();
    });
  });

  describe('not set up', () => {
    it('says how to set it up in four steps, in order', async () => {
      const t = await setup(telegramStatusDto({ configured: false, connection: 'off', bot: null }));

      const steps = queryAllByRole(getByRole(t.section(), 'list'), 'listitem');
      // The text as it reads, with no space added around the words in bold or in code.
      const reads = (step: HTMLElement) => (step.textContent ?? '').replace(/\s+/g, ' ').trim();
      expect(steps.map(reads)).toEqual([
        'In Telegram, open @BotFather, send /newbot and answer its questions. It gives you a bot token.',
        "Put the token in the server's env file as TELEGRAM_BOT_TOKEN=your-bot-token. Keep it private: Wallet never shows it.",
        'Restart Wallet. It reads the token when it starts.',
        'Come back to this page and press Link Telegram.',
      ]);
      expect(t.element.querySelector('ol')).not.toBeNull();
    });

    it('points at the "Telegram bot" section of the README as plain text, not as a link', async () => {
      const t = await setup(telegramStatusDto({ configured: false, connection: 'off', bot: null }));

      expect(t.text()).toContain('The README has the details, in the section “Telegram bot”.');
      expect(queryByRole(t.section(), 'link')).toBeNull();
    });

    it('offers nothing to press: no link, no notifications', async () => {
      const t = await setup(telegramStatusDto({ configured: false, connection: 'off', bot: null }));

      expect(queryByRole(t.section(), 'button', 'Link Telegram')).toBeNull();
      expect(queryByRole(t.element, 'region', 'Notifications')).toBeNull();
      expect(queryByRole(t.section(), 'alert')).toBeNull();
    });

    it('never asks for or shows a token', async () => {
      const t = await setup(telegramStatusDto({ configured: false, connection: 'off', bot: null }));

      expect(t.element.querySelector('input')).toBeNull();
    });
  });

  describe('connecting and errors', () => {
    it('says it is connecting, without an error, and keeps reading the status', async () => {
      const t = await setup(telegramStatusDto({ connection: 'connecting', bot: null }));

      expect(t.text()).toContain('Connecting to Telegram…');
      expect(queryByRole(t.section(), 'alert')).toBeNull();
      expect(getByRole(t.section(), 'status', /Connecting/)).toBeTruthy();

      await t.tick();
      await t.answerStatus(telegramStatusDto());
      expect(t.text()).not.toContain('Connecting to Telegram…');
      expect(queryByRole(t.section(), 'button', 'Link Telegram')).not.toBeNull();
      // Running and nothing pending: nothing left to wait for.
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      [
        'invalid_token',
        'Telegram refused the bot token',
        'The token in TELEGRAM_BOT_TOKEN is wrong or was revoked.',
      ],
      [
        'conflict',
        'Another program is using this bot',
        'Usually a second Wallet that has the same token: each Wallet needs a bot of its own, so use a separate bot for development.',
      ],
      [
        'unreachable',
        "Telegram can't be reached",
        'It tries again by itself, so there is nothing to do unless this lasts.',
      ],
      [
        'blocked',
        'You blocked the bot',
        "The bot can't write to your chat while it is blocked. Unblock it in Telegram",
      ],
    ] as const)('explains the problem %s', async (problem, title, text) => {
      const t = await setup(telegramStatusDto({ connection: 'error', problem }));

      expect(textOf(t.section())).toContain(title);
      expect(textOf(t.section())).toContain(text);
      // Told by an icon and a title, not by color alone.
      expect(t.section().querySelector('app-alert svg')).not.toBeNull();
    });

    it('announces an error that stops the bot as an alert', async () => {
      const t = await setup(telegramStatusDto({ connection: 'error', problem: 'invalid_token' }));

      expect(textOf(getByRole(t.section(), 'alert'))).toContain('Telegram refused the bot token');
    });

    it('does not offer to link while the bot is in error, since it could not answer', async () => {
      const t = await setup(telegramStatusDto({ connection: 'error', problem: 'conflict' }));

      expect(queryByRole(t.section(), 'button', 'Link Telegram')).toBeNull();
    });

    it('still shows the linked account below the problem', async () => {
      const t = await setup(
        telegramStatusDto({ connection: 'error', problem: 'unreachable', link: telegramLinkDto() }),
      );

      expect(t.text()).toContain("Telegram can't be reached");
      expect(t.text()).toContain('Linked account Anna');
      expect(queryByRole(t.section(), 'button', 'Send test message')).not.toBeNull();
    });

    it('says something useful when the API reports an error without a problem', async () => {
      const t = await setup(telegramStatusDto({ connection: 'error', problem: null }));

      expect(t.text()).toContain('The bot is not working');
    });
  });

  describe('set up, nobody linked', () => {
    it('offers to link and names the bot', async () => {
      const t = await setup();

      expect(t.text()).toContain('Bot @wallet_bot');
      expect(t.text()).toContain('Link your Telegram account');
      expect(queryByRole(t.section(), 'button', 'Link Telegram')).not.toBeNull();
      expect(queryByRole(t.element, 'region', 'Notifications')).toBeNull();
      expect(queryByRole(t.section(), 'button', 'Send test message')).toBeNull();
    });

    it('says how the bot works and that Telegram sees the messages, in the help', async () => {
      const t = await setup();

      expect(t.text()).toContain('How this works');
      expect(t.text()).toContain('it never answers anyone else');
      expect(t.text()).toContain('not end-to-end encrypted');
      expect(t.text()).toContain('never shown here');
    });

    describe('Link Telegram', () => {
      it('makes a code (POST with no body), shows it busy, then reads the status', async () => {
        const t = await setup();

        await t.press('Link Telegram');
        const post = http.expectOne('/api/telegram/pairing');
        expect(post.request.method).toBe('POST');
        expect(post.request.body).toBeNull();
        const button = getByRole(t.element, 'button', 'Link Telegram');
        expect(button.hasAttribute('disabled')).toBe(true);
        expect(button.getAttribute('aria-busy')).toBe('true');

        post.flush(telegramPairingDto());
        await t.answerStatus(PENDING);

        expect(queryByRole(t.element, 'button', 'Link Telegram')).toBeNull();
        expect(queryByRole(t.section(), 'alert')).toBeNull();
      });

      it('shows the code as plain selectable text, with its expiry as a countdown and a clock time', async () => {
        const t = await setup();
        await t.press('Link Telegram');
        http.expectOne('/api/telegram/pairing').flush(telegramPairingDto());
        await t.answerStatus(PENDING);

        const code = t.section().querySelector('code')!;
        expect(textOf(code)).toBe('K7M2QX9P');
        expect(code.className).toContain('select-all');
        expect(t.text()).toContain('Pairing code K7M2QX9P');
        expect(t.text()).toContain('This code links your Telegram account. It works once.');
        expect(t.text()).toContain(
          `Expires in 10 minutes, at ${clock('2026-10-05T10:10:00.000Z')}`,
        );
      });

      it('offers Open in Telegram (the deep link, in a new tab) and Cancel', async () => {
        const t = await setup();
        await t.press('Link Telegram');
        http.expectOne('/api/telegram/pairing').flush(telegramPairingDto());
        await t.answerStatus(PENDING);

        const open = getByRole(t.section(), 'link', /Open in Telegram/);
        expect(open.getAttribute('href')).toBe('https://t.me/wallet_bot?start=K7M2QX9P');
        expect(open.getAttribute('target')).toBe('_blank');
        expect(open.getAttribute('rel')).toBe('noopener noreferrer');
        expect(textOf(open)).toBe('Open in Telegram (opens in a new tab)');
        expect(queryByRole(t.section(), 'button', 'Cancel')).not.toBeNull();
        // With the link there is no need to type anything.
        expect(t.text()).not.toContain('/start K7M2QX9P');
      });

      it('tells what to send, and to whom, when there is no deep link yet', async () => {
        const t = await setup();
        await t.press('Link Telegram');
        http.expectOne('/api/telegram/pairing').flush(telegramPairingDto({ deepLink: null }));
        await t.answerStatus(
          telegramStatusDto({ pairing: telegramPairingDto({ deepLink: null }) }),
        );

        expect(queryByRole(t.section(), 'link')).toBeNull();
        expect(t.text()).toContain('In Telegram, send /start K7M2QX9P to @wallet_bot.');
      });

      it('says "your bot" when it does not know the bot yet either', async () => {
        const t = await setup(
          telegramStatusDto({
            connection: 'connecting',
            bot: null,
            pairing: telegramPairingDto({ deepLink: null }),
          }),
        );

        expect(t.text()).toContain('In Telegram, send /start K7M2QX9P to your bot.');
      });

      it('puts the keyboard on the code, so a screen reader reads it', async () => {
        const t = await setup();
        await t.press('Link Telegram');
        http.expectOne('/api/telegram/pairing').flush(telegramPairingDto());
        await t.answerStatus(PENDING);

        expect(document.activeElement).toBe(t.section().querySelector('code'));
      });

      it('says what the API said when no code could be made, and gives the button back', async () => {
        const t = await setup();

        await t.press('Link Telegram');
        flushError(
          http.expectOne('/api/telegram/pairing'),
          500,
          'internal_error',
          'The database is locked',
        );
        await settle(t.fixture);

        expect(textOf(getByRole(t.section(), 'alert'))).toContain('No code was made');
        expect(textOf(getByRole(t.section(), 'alert'))).toContain('The database is locked');
        expect(getByRole(t.element, 'button', 'Link Telegram').hasAttribute('disabled')).toBe(
          false,
        );
        expect(document.activeElement).toBe(getByRole(t.element, 'button', 'Link Telegram'));
      });

      it('explains a 409 telegram_not_configured, and shows the state the server has now', async () => {
        const t = await setup();

        await t.press('Link Telegram');
        flushError(
          http.expectOne('/api/telegram/pairing'),
          409,
          'telegram_not_configured',
          'No token',
        );
        await t.answerStatus(
          telegramStatusDto({ configured: false, connection: 'off', bot: null }),
        );

        expect(t.text()).toContain('This server has no bot token.');
        expect(t.text()).toContain('Telegram is off.');
        expect(queryByRole(t.section(), 'button', 'Link Telegram')).toBeNull();
      });

      it('cannot be sent twice while it is under way', async () => {
        const t = await setup();

        await t.press('Link Telegram');
        const post = http.expectOne('/api/telegram/pairing');
        getByRole(t.element, 'button', 'Link Telegram').click();
        await settle(t.fixture);
        http.expectNone('/api/telegram/pairing');

        post.flush(telegramPairingDto());
        await t.answerStatus(PENDING);
      });
    });

    describe('Cancel', () => {
      const withCode = () => setup(PENDING);

      it('cancels the code (DELETE), reads the status, and shows Link Telegram again with focus on it', async () => {
        const t = await withCode();

        await t.press('Cancel');
        const request = http.expectOne('/api/telegram/pairing');
        expect(request.request.method).toBe('DELETE');
        request.flush(null, NO_CONTENT);
        await t.answerStatus(telegramStatusDto());

        expect(queryByRole(t.section(), 'link')).toBeNull();
        expect(t.text()).not.toContain('K7M2QX9P');
        expect(document.activeElement).toBe(getByRole(t.section(), 'button', 'Link Telegram'));
      });

      it('is not an expiry: no "code expired" message, and the polling stops', async () => {
        const t = await withCode();
        expect(vi.getTimerCount()).toBe(1);

        await t.press('Cancel');
        http.expectOne('/api/telegram/pairing').flush(null, NO_CONTENT);
        await t.answerStatus(telegramStatusDto());

        expect(t.text()).not.toContain('The code expired');
        expect(vi.getTimerCount()).toBe(0);
        await t.tick(10 * TELEGRAM_POLL_MS);
        http.expectNone('/api/telegram');
      });

      it('says what the API said when it fails, and keeps the code', async () => {
        const t = await withCode();

        await t.press('Cancel');
        flushError(http.expectOne('/api/telegram/pairing'), 500, 'internal_error', 'Try later');
        await settle(t.fixture);

        expect(textOf(getByRole(t.section(), 'alert'))).toContain('The code was not cancelled');
        expect(t.text()).toContain('K7M2QX9P');
      });
    });

    describe('while a code is pending', () => {
      it('reads the status every 3 seconds, and switches to Linked when the code is used', async () => {
        const t = await setup(PENDING);
        expect(vi.getTimerCount()).toBe(1);

        await t.tick(TELEGRAM_POLL_MS - 1);
        http.expectNone('/api/telegram');

        await t.tick(1);
        await t.answerStatus(PENDING);
        expect(t.text()).toContain('K7M2QX9P');

        await t.tick();
        await t.answerStatus(LINKED);

        expect(t.text()).toContain('Linked account Anna');
        expect(t.text()).not.toContain('K7M2QX9P');
        expect(t.toasts()).toEqual(['Telegram linked: Anna (@anna).']);
        expect(queryByRole(t.section(), 'button', 'Send test message')).not.toBeNull();
        expect(getByRole(t.element, 'region', 'Notifications')).toBeTruthy();
      });

      it('stops reading once the code is used', async () => {
        const t = await setup(PENDING);
        await t.tick();
        await t.answerStatus(LINKED);

        expect(vi.getTimerCount()).toBe(0);
        await t.tick(10 * TELEGRAM_POLL_MS);
        http.expectNone('/api/telegram');
      });

      it('stops reading when the section goes away', async () => {
        const t = await setup(PENDING);
        expect(vi.getTimerCount()).toBe(1);

        t.fixture.destroy();
        await settle();

        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(10 * TELEGRAM_POLL_MS);
        http.expectNone('/api/telegram');
      });

      it('starts reading when a code is made, not before', async () => {
        const t = await setup();
        expect(vi.getTimerCount()).toBe(0);

        await t.press('Link Telegram');
        http.expectOne('/api/telegram/pairing').flush(telegramPairingDto());
        await t.answerStatus(PENDING);

        expect(vi.getTimerCount()).toBe(1);
      });

      it('moves the keyboard to the heading when the block that had it goes away', async () => {
        const t = await setup(PENDING);
        getByRole(t.section(), 'button', 'Cancel').focus();

        await t.tick();
        await t.answerStatus(LINKED);

        expect(document.activeElement).toBe(getByRole(t.element, 'heading', 'Telegram'));
      });

      it('counts down to the expiry as the status is read', async () => {
        const t = await setup(PENDING);
        expect(t.text()).toContain('Expires in 10 minutes');

        vi.setSystemTime(new Date('2026-10-05T10:07:30.000Z'));
        await t.tick();
        await t.answerStatus(PENDING);

        expect(t.text()).toContain('Expires in 3 minutes');
      });
    });

    describe('when the code expires', () => {
      it('says so and offers a new code', async () => {
        const t = await setup(PENDING);

        await t.tick();
        await t.answerStatus(telegramStatusDto());

        expect(getByRole(t.section(), 'status')).toBeTruthy();
        expect(t.text()).toContain('The code expired');
        expect(t.text()).toContain('Make a new one to link Telegram.');
        expect(queryByRole(t.section(), 'button', 'Create a new code')).not.toBeNull();
        // One way to make a code, not two buttons for it.
        expect(queryByRole(t.section(), 'button', 'Link Telegram')).toBeNull();
        expect(t.text()).not.toContain('K7M2QX9P');
        expect(vi.getTimerCount()).toBe(0);
        expect(t.toasts()).toEqual([]);
      });

      it('is decided by the status, not by the browser clock', async () => {
        const t = await setup(PENDING);

        // The device thinks it is an hour later: the code is valid until the server says otherwise.
        vi.setSystemTime(new Date('2026-10-05T11:00:00.000Z'));
        await t.tick();
        await t.answerStatus(PENDING);

        expect(t.text()).not.toContain('The code expired');
        expect(t.text()).toContain('K7M2QX9P');
        expect(t.text()).toContain('Expires this minute');
      });

      it('makes a new code from the message, and the message goes away', async () => {
        const t = await setup(PENDING);
        await t.tick();
        await t.answerStatus(telegramStatusDto());

        await t.press('Create a new code');
        const post = http.expectOne('/api/telegram/pairing');
        expect(post.request.method).toBe('POST');
        post.flush(telegramPairingDto({ code: 'NEWCODE2' }));
        await t.answerStatus(
          telegramStatusDto({ pairing: telegramPairingDto({ code: 'NEWCODE2' }) }),
        );

        expect(t.text()).not.toContain('The code expired');
        expect(t.text()).toContain('NEWCODE2');
        expect(vi.getTimerCount()).toBe(1);
      });

      it('does not make a message out of a code that was never seen pending', async () => {
        const t = await setup();

        expect(t.text()).not.toContain('The code expired');
      });
    });
  });

  describe('linked', () => {
    it('shows the account: name, @username and when it was linked', async () => {
      const t = await setup(LINKED);

      expect(t.text()).toContain('Bot @wallet_bot');
      expect(t.text()).toContain('Linked account Anna');
      expect(t.text()).toContain('Username @anna');
      expect(t.text()).toContain(`Linked since ${when('2026-10-04T08:30:00.000Z')}`);
    });

    it('leaves out the username of an account that has none', async () => {
      const t = await setup(
        telegramStatusDto({ link: telegramLinkDto({ name: 'Bo', username: null }) }),
      );

      expect(t.text()).toContain('Linked account Bo');
      expect(t.text()).not.toContain('Username');
      expect(t.text()).not.toContain('@null');
    });

    it('has Send test message in view, and Re-link and Unlink in the menu, Unlink last', async () => {
      const t = await setup(LINKED);

      expect(queryByRole(t.section(), 'button', 'Send test message')).not.toBeNull();
      expect(menuItemNames(t.element, 'More actions for Telegram')).toEqual(['Re-link', 'Unlink']);
      expect(queryByRole(t.section(), 'button', 'Link Telegram')).toBeNull();
    });

    it('is not polling: nothing is pending', async () => {
      await setup(LINKED);

      expect(vi.getTimerCount()).toBe(0);
    });

    it('shows the notifications form, filled with what the server holds', async () => {
      const t = await setup(
        telegramStatusDto({
          link: telegramLinkDto(),
          notifications: {
            budgetAlerts: false,
            renewalYearlyDays: 14,
            renewalMonthlyDays: 0,
            monthlyRecap: true,
            notifyAt: '21:30',
          },
        }),
      );

      const notifications = getByRole(t.element, 'region', 'Notifications');
      expect(t.section().contains(notifications)).toBe(true);
      expect((getByLabel(notifications, 'Budget alerts') as HTMLInputElement).checked).toBe(false);
      expect(
        getByLabel<HTMLInputElement>(notifications, 'Yearly renewals: days before').value,
      ).toBe('14');
      expect(
        getByLabel<HTMLInputElement>(notifications, 'Monthly renewals: days before').value,
      ).toBe('0');
      expect((getByLabel(notifications, 'Monthly recap') as HTMLInputElement).checked).toBe(true);
      expect(
        getByLabel<HTMLInputElement>(notifications, "Time of day (server's time zone)").value,
      ).toBe('21:30');
    });

    describe('Send test message', () => {
      it('sends it (POST with no body), shows it busy, and says it was sent', async () => {
        const t = await setup(LINKED);

        await t.press('Send test message');
        const request = http.expectOne('/api/telegram/test');
        expect(request.request.method).toBe('POST');
        expect(request.request.body).toBeNull();
        const button = getByRole(t.element, 'button', 'Send test message');
        expect(button.hasAttribute('disabled')).toBe(true);
        expect(button.getAttribute('aria-busy')).toBe('true');

        request.flush(null, NO_CONTENT);
        await settle(t.fixture);

        expect(getByRole(t.section(), 'status')).toBeTruthy();
        expect(t.text()).toContain('Test message sent');
        expect(t.text()).toContain('A test message is in your Telegram chat.');
        expect(queryByRole(t.section(), 'alert')).toBeNull();
        expect(button.hasAttribute('disabled')).toBe(false);
      });

      it('puts focus back on the button when it is done (a disabled button loses it)', async () => {
        const t = await setup(LINKED);
        const button = getByRole(t.element, 'button', 'Send test message');
        button.focus();

        await t.press('Send test message');
        // A browser takes focus off a button that becomes disabled and jsdom does not.
        const elsewhere = document.createElement('input');
        document.body.append(elsewhere);
        elsewhere.focus();
        elsewhere.remove();
        http.expectOne('/api/telegram/test').flush(null, NO_CONTENT);
        await settle(t.fixture);

        expect(document.activeElement).toBe(button);
      });

      it('explains a 503 telegram_unavailable: the bot is not running or Telegram refused', async () => {
        const t = await setup(LINKED);

        await t.press('Send test message');
        flushError(
          http.expectOne('/api/telegram/test'),
          503,
          'telegram_unavailable',
          'The bot is not running',
        );
        await t.answerStatus(LINKED);

        const alert = getByRole(t.section(), 'alert');
        expect(textOf(alert)).toContain('No test message was sent');
        expect(textOf(alert)).toContain(
          'The bot is not running right now, or Telegram refused the message. Check the connection above and try again in a moment.',
        );
        expect(queryByRole(t.section(), 'button', 'Send test message')).not.toBeNull();
      });

      it('reads the status after a 503, so the cause shows without a reload (the bot was blocked)', async () => {
        const t = await setup(LINKED);

        await t.press('Send test message');
        flushError(
          http.expectOne('/api/telegram/test'),
          503,
          'telegram_unavailable',
          'Telegram did not accept the message',
        );
        await t.answerStatus(
          telegramStatusDto({
            connection: 'error',
            problem: 'blocked',
            link: telegramLinkDto(),
          }),
        );

        expect(t.text()).toContain('You blocked the bot');
        expect(t.text()).toContain('No test message was sent');
      });

      it('explains a 503 that has no ApiError body, too', async () => {
        const t = await setup(LINKED);

        await t.press('Send test message');
        http
          .expectOne('/api/telegram/test')
          .flush('Service Unavailable', { status: 503, statusText: 'Service Unavailable' });
        await t.answerStatus(LINKED);

        expect(textOf(getByRole(t.section(), 'alert'))).toContain(
          'The bot is not running right now, or Telegram refused the message.',
        );
      });

      it('explains a 409 telegram_not_linked, and reads the status (it was unlinked elsewhere)', async () => {
        const t = await setup(LINKED);

        await t.press('Send test message');
        flushError(
          http.expectOne('/api/telegram/test'),
          409,
          'telegram_not_linked',
          'Nothing is linked',
        );
        await t.answerStatus(telegramStatusDto());

        expect(textOf(getByRole(t.section(), 'alert'))).toContain(
          'No Telegram account is linked, so there is no chat to send it to. Link one first.',
        );
        expect(queryByRole(t.section(), 'button', 'Link Telegram')).not.toBeNull();
      });

      it('explains a 409 telegram_not_configured', async () => {
        const t = await setup(LINKED);

        await t.press('Send test message');
        flushError(
          http.expectOne('/api/telegram/test'),
          409,
          'telegram_not_configured',
          'No token',
        );
        await t.answerStatus(
          telegramStatusDto({
            configured: false,
            connection: 'off',
            bot: null,
            link: telegramLinkDto(),
          }),
        );

        expect(textOf(getByRole(t.section(), 'alert'))).toContain('This server has no bot token.');
      });

      it('shows what the API said for any other failure', async () => {
        const t = await setup(LINKED);

        await t.press('Send test message');
        flushError(http.expectOne('/api/telegram/test'), 500, 'internal_error', 'Out of memory');
        await settle(t.fixture);

        expect(textOf(getByRole(t.section(), 'alert'))).toContain('Out of memory');
      });

      it('clears the old result when it is pressed again', async () => {
        const t = await setup(LINKED);
        await t.press('Send test message');
        flushError(http.expectOne('/api/telegram/test'), 503, 'telegram_unavailable', 'Down');
        await t.answerStatus(LINKED);
        expect(queryByRole(t.section(), 'alert')).not.toBeNull();

        await t.press('Send test message');
        expect(queryByRole(t.section(), 'alert')).toBeNull();
        http.expectOne('/api/telegram/test').flush(null, NO_CONTENT);
        await settle(t.fixture);
        expect(t.text()).toContain('Test message sent');
      });
    });

    describe('Unlink', () => {
      it('asks first, says what happens, and does nothing when cancelled', async () => {
        const t = await setup(LINKED);

        await t.menuAction('Unlink');

        const text = textOf(t.confirmDialog());
        expect(text).toContain('Unlink this Telegram account?');
        expect(text).toContain(
          'Anna (@anna) can no longer use the bot, and Wallet stops sending it messages.',
        );
        expect(text).toContain('Your notification settings are kept');
        await t.press('Cancel', t.confirmDialog());
        http.expectNone('/api/telegram/link');
        expect(t.text()).toContain('Linked account Anna');
      });

      it('unlinks once confirmed, reads the status, and puts focus on the heading', async () => {
        const t = await setup(LINKED);
        await t.menuAction('Unlink');
        await t.press('Unlink', t.confirmDialog());

        const request = http.expectOne('/api/telegram/link');
        expect(request.request.method).toBe('DELETE');
        request.flush(null, NO_CONTENT);
        await t.answerStatus(telegramStatusDto());

        expect(t.toasts()).toEqual(['Telegram unlinked.']);
        expect(t.text()).not.toContain('Linked account');
        expect(queryByRole(t.section(), 'button', 'Link Telegram')).not.toBeNull();
        expect(queryByRole(t.element, 'region', 'Notifications')).toBeNull();
        expect(document.activeElement).toBe(getByRole(t.element, 'heading', 'Telegram'));
      });

      it('says an account that was already unlinked is, and reads the status', async () => {
        const t = await setup(LINKED);
        await t.menuAction('Unlink');
        await t.press('Unlink', t.confirmDialog());

        flushError(http.expectOne('/api/telegram/link'), 404, 'not_found', 'Nothing is linked');
        await t.answerStatus(telegramStatusDto());

        expect(t.toasts()).toEqual(['That account was already unlinked.']);
        expect(queryByRole(t.section(), 'button', 'Link Telegram')).not.toBeNull();
      });

      it("reports another failure with the API's words, and keeps the account", async () => {
        const t = await setup(LINKED);
        await t.menuAction('Unlink');
        await t.press('Unlink', t.confirmDialog());

        flushError(http.expectOne('/api/telegram/link'), 500, 'internal_error', 'Disk full');
        await settle(t.fixture);

        expect(t.toasts()).toEqual(["Couldn't unlink Telegram. Disk full"]);
        expect(t.text()).toContain('Linked account Anna');
      });
    });

    describe('Re-link', () => {
      it('asks first, and says the current account stays linked until the new code is used', async () => {
        const t = await setup(LINKED);

        await t.menuAction('Re-link');

        const text = textOf(t.confirmDialog());
        expect(text).toContain('Link another Telegram account?');
        expect(text).toContain('Anna (@anna) stays linked until the new code is used.');
        expect(text).toContain('replaces it, and Anna can no longer use the bot');
        await t.press('Cancel', t.confirmDialog());
        http.expectNone('/api/telegram/pairing');
      });

      it('makes a code once confirmed, and shows it under the account that stays linked', async () => {
        const t = await setup(LINKED);
        await t.menuAction('Re-link');
        await t.press('Create a new code', t.confirmDialog());

        const post = http.expectOne('/api/telegram/pairing');
        expect(post.request.method).toBe('POST');
        post.flush(telegramPairingDto());
        await t.answerStatus(
          telegramStatusDto({ link: telegramLinkDto(), pairing: telegramPairingDto() }),
        );

        expect(t.text()).toContain('Linked account Anna');
        expect(t.text()).toContain('This code links another account. It works once.');
        expect(t.text()).toContain('Pairing code K7M2QX9P');
        expect(queryByRole(t.section(), 'link', /Open in Telegram/)).not.toBeNull();
        // One code at a time: Re-link is not offered while one is pending.
        expect(menuItemNames(t.element, 'More actions for Telegram')).toEqual(['Unlink']);
        expect(vi.getTimerCount()).toBe(1);
      });

      it('switches to the new account when its code is used', async () => {
        const t = await setup(
          telegramStatusDto({ link: telegramLinkDto(), pairing: telegramPairingDto() }),
        );

        await t.tick();
        await t.answerStatus(
          telegramStatusDto({
            link: telegramLinkDto({
              name: 'Bo',
              username: null,
              linkedAt: '2026-10-05T10:02:00.000Z',
            }),
          }),
        );

        expect(t.text()).toContain('Linked account Bo');
        expect(t.toasts()).toEqual(['Telegram linked: Bo.']);
        expect(vi.getTimerCount()).toBe(0);
      });

      it('goes back to the menu when the re-link is cancelled, and the account stays linked', async () => {
        const t = await setup(
          telegramStatusDto({ link: telegramLinkDto(), pairing: telegramPairingDto() }),
        );

        await t.press('Cancel');
        http.expectOne('/api/telegram/pairing').flush(null, NO_CONTENT);
        await t.answerStatus(LINKED);

        expect(t.text()).toContain('Linked account Anna');
        expect(t.text()).not.toContain('The code expired');
        expect(document.activeElement).toBe(
          getByRole(t.section(), 'button', 'More actions for Telegram'),
        );
      });
    });
  });

  describe('notifications', () => {
    it('are only there once an account is linked', async () => {
      const t = await setup();

      expect(queryByRole(t.element, 'region', 'Notifications')).toBeNull();
    });

    it('reads the status again after they are saved', async () => {
      const t = await setup(LINKED);
      const notifications = getByRole(t.element, 'region', 'Notifications');
      typeInto(getByLabel(notifications, 'Yearly renewals: days before'), '10');
      await settle(t.fixture);

      await t.press('Save notification settings');
      http.expectOne('/api/telegram/notifications').flush({
        budgetAlerts: true,
        renewalYearlyDays: 10,
        renewalMonthlyDays: 1,
        monthlyRecap: true,
        notifyAt: '09:00',
      });
      await t.answerStatus(
        telegramStatusDto({
          link: telegramLinkDto(),
          notifications: {
            budgetAlerts: true,
            renewalYearlyDays: 10,
            renewalMonthlyDays: 1,
            monthlyRecap: true,
            notifyAt: '09:00',
          },
        }),
      );

      expect(t.toasts()).toEqual(['Notification settings saved.']);
      // What was typed stays: the new status does not overwrite the form.
      expect(
        getByLabel<HTMLInputElement>(
          getByRole(t.element, 'region', 'Notifications'),
          'Yearly renewals: days before',
        ).value,
      ).toBe('10');
    });
  });
});
