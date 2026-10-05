import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  DEFAULT_TELEGRAM_NOTIFICATIONS,
  type TelegramNotificationSettingsDto,
  telegramNotificationSettingsInputSchema,
} from '@wallet/shared';
import { a11yProblems } from '../../../testing/a11y';
import {
  fieldError,
  getByLabel,
  getByRole,
  queryByRole,
  textOf,
  typeInto,
} from '../../../testing/dom';
import { flushError, primeStores, settle } from '../../../testing/harness';
import { ToastService } from '../../shared/ui/toast.service';
import { TelegramNotifications } from './telegram-notifications';

const SAVED: TelegramNotificationSettingsDto = {
  budgetAlerts: false,
  renewalYearlyDays: 14,
  renewalMonthlyDays: 0,
  monthlyRecap: true,
  notifyAt: '21:30',
};

const YEARLY = 'Yearly renewals: days before';
const MONTHLY = 'Monthly renewals: days before';
const TIME = "Time of day (server's time zone)";

describe('TelegramNotifications', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function setup(
    settings: TelegramNotificationSettingsDto = { ...DEFAULT_TELEGRAM_NOTIFICATIONS },
  ) {
    await primeStores(http);
    const fixture = TestBed.createComponent(TelegramNotifications);
    fixture.componentRef.setInput('settings', settings);
    const saved: number[] = [];
    fixture.componentInstance.saved.subscribe(() => saved.push(saved.length + 1));
    fixture.detectChanges();
    await settle(fixture);

    const element = fixture.nativeElement as HTMLElement;
    const field = <T extends HTMLElement = HTMLInputElement>(label: string | RegExp) =>
      getByLabel<T>(element, label);
    return {
      fixture,
      element,
      saved,
      field,
      type: async (label: string | RegExp, value: string) => {
        typeInto(field(label), value);
        await settle(fixture);
      },
      toggle: async (label: string) => {
        field(label).click();
        await settle(fixture);
      },
      save: async () => {
        getByRole(element, 'button', 'Save notification settings').click();
        await settle(fixture);
      },
      toasts: () =>
        TestBed.inject(ToastService)
          .toasts()
          .map((toast) => toast.message),
    };
  }

  describe('the form', () => {
    it('is a level 3 block named Notifications, with every control labelled', async () => {
      const t = await setup();

      expect(getByRole(t.element, 'region', 'Notifications')).toBeTruthy();
      expect(textOf(getByRole(t.element, 'heading', 'Notifications'))).toBe('Notifications');
      for (const label of ['Budget alerts', YEARLY, MONTHLY, 'Monthly recap', TIME]) {
        expect(t.field(label)).toBeTruthy();
      }
      expect(a11yProblems(t.element)).toEqual([]);
    });

    it('starts from the defaults: alerts on, 7 and 1 days, the recap on, 09:00', async () => {
      const t = await setup();

      expect((t.field('Budget alerts') as HTMLInputElement).checked).toBe(true);
      expect(t.field(YEARLY).value).toBe('7');
      expect(t.field(MONTHLY).value).toBe('1');
      expect((t.field('Monthly recap') as HTMLInputElement).checked).toBe(true);
      expect(t.field(TIME).value).toBe('09:00');
    });

    it('shows what the server holds', async () => {
      const t = await setup(SAVED);

      expect((t.field('Budget alerts') as HTMLInputElement).checked).toBe(false);
      expect(t.field(YEARLY).value).toBe('14');
      expect(t.field(MONTHLY).value).toBe('0');
      expect((t.field('Monthly recap') as HTMLInputElement).checked).toBe(true);
      expect(t.field(TIME).value).toBe('21:30');
    });

    it("says that 0 turns a reminder off, what the defaults are, and that the time is the server's", async () => {
      const t = await setup();

      const text = textOf(t.element);
      expect(text).toContain('0 turns the reminder off. Default: 7.');
      expect(text).toContain('0 turns the reminder off. Default: 1.');
      expect(text).toContain("It is the server's clock, which may differ from your device's.");
      expect(t.field(YEARLY).min).toBe('0');
      expect(t.field(YEARLY).max).toBe('30');
      expect(t.field(TIME).type).toBe('time');
    });

    it('does not overwrite what is being typed when the section gives new settings', async () => {
      const t = await setup();
      await t.type(YEARLY, '12');

      t.fixture.componentRef.setInput('settings', SAVED);
      await settle(t.fixture);

      expect(t.field(YEARLY).value).toBe('12');
    });
  });

  describe('saving', () => {
    it('sends the five preferences together (PUT), shows it busy, and says it was saved', async () => {
      const t = await setup();
      await t.toggle('Budget alerts');
      await t.type(YEARLY, '14');
      await t.type(MONTHLY, '0');
      await t.type(TIME, '21:30');

      await t.save();
      const request = http.expectOne('/api/telegram/notifications');
      expect(request.request.method).toBe('PUT');
      expect(request.request.body).toEqual(SAVED);
      // The body is what the API accepts.
      expect(telegramNotificationSettingsInputSchema.safeParse(request.request.body).success).toBe(
        true,
      );
      const button = getByRole(t.element, 'button', 'Save notification settings');
      expect(button.hasAttribute('disabled')).toBe(true);
      expect(button.getAttribute('aria-busy')).toBe('true');

      request.flush(SAVED);
      await settle(t.fixture);

      expect(t.toasts()).toEqual(['Notification settings saved.']);
      expect(t.saved).toEqual([1]);
      expect(button.hasAttribute('disabled')).toBe(false);
      expect(queryByRole(t.element, 'alert')).toBeNull();
    });

    it('sends the defaults as they are, with only what was changed different', async () => {
      const t = await setup();
      await t.toggle('Monthly recap');

      await t.save();

      const request = http.expectOne('/api/telegram/notifications');
      expect(request.request.body).toEqual({
        ...DEFAULT_TELEGRAM_NOTIFICATIONS,
        monthlyRecap: false,
      });
      request.flush({ ...DEFAULT_TELEGRAM_NOTIFICATIONS, monthlyRecap: false });
      await settle(t.fixture);
    });

    it('accepts 0 and 30 days, the ends of the range', async () => {
      const t = await setup();
      await t.type(YEARLY, '0');
      await t.type(MONTHLY, '30');

      await t.save();

      const request = http.expectOne('/api/telegram/notifications');
      expect(request.request.body).toMatchObject({ renewalYearlyDays: 0, renewalMonthlyDays: 30 });
      request.flush({
        ...DEFAULT_TELEGRAM_NOTIFICATIONS,
        renewalYearlyDays: 0,
        renewalMonthlyDays: 30,
      });
      await settle(t.fixture);
    });

    it('cannot be sent twice while it is under way', async () => {
      const t = await setup();

      await t.save();
      const request = http.expectOne('/api/telegram/notifications');
      getByRole(t.element, 'button', 'Save notification settings').click();
      await settle(t.fixture);
      http.expectNone('/api/telegram/notifications');

      request.flush({ ...DEFAULT_TELEGRAM_NOTIFICATIONS });
      await settle(t.fixture);
    });

    it('puts focus back on the button when it is done (a disabled button loses it)', async () => {
      const t = await setup();
      const button = getByRole(t.element, 'button', 'Save notification settings');
      button.focus();

      await t.save();
      // A browser takes focus off a button that becomes disabled and jsdom does not.
      const elsewhere = document.createElement('input');
      document.body.append(elsewhere);
      elsewhere.focus();
      elsewhere.remove();
      http.expectOne('/api/telegram/notifications').flush({ ...DEFAULT_TELEGRAM_NOTIFICATIONS });
      await settle(t.fixture);

      expect(document.activeElement).toBe(button);
    });
  });

  describe('validation', () => {
    it.each([['-1'], ['31'], ['7.5'], ['']])(
      'refuses %j days, says why next to the field and sends nothing',
      async (value) => {
        const t = await setup();
        await t.type(YEARLY, value);

        await t.save();

        http.expectNone('/api/telegram/notifications');
        expect(fieldError(t.field(YEARLY))).toBe('Enter a whole number from 0 to 30.');
        expect(t.field(YEARLY).getAttribute('aria-invalid')).toBe('true');
        expect(document.activeElement).toBe(t.field(YEARLY));
      },
    );

    it('checks the monthly days the same way', async () => {
      const t = await setup();
      await t.type(MONTHLY, '45');

      await t.save();

      http.expectNone('/api/telegram/notifications');
      expect(fieldError(t.field(MONTHLY))).toBe('Enter a whole number from 0 to 30.');
      expect(fieldError(t.field(YEARLY))).toBe('');
    });

    it('refuses an empty time, and says what to type', async () => {
      const t = await setup();
      await t.type(TIME, '');

      await t.save();

      http.expectNone('/api/telegram/notifications');
      expect(fieldError(t.field(TIME))).toBe('Enter a time of day, like 09:00.');
      expect(document.activeElement).toBe(t.field(TIME));
    });

    it('marks the invalid fields with more than color: an icon and the text', async () => {
      const t = await setup();
      await t.type(YEARLY, '99');
      await t.save();

      const message = t
        .field(YEARLY)
        .closest('app-field')!
        .querySelector('[aria-live="polite"] p')!;
      expect(message.querySelector('svg')).not.toBeNull();
      expect(textOf(message)).toBe('Enter a whole number from 0 to 30.');
    });

    it('clears the message once the value is fixed', async () => {
      const t = await setup();
      await t.type(YEARLY, '99');
      await t.save();
      expect(fieldError(t.field(YEARLY))).not.toBe('');

      await t.type(YEARLY, '3');

      expect(fieldError(t.field(YEARLY))).toBe('');
    });
  });

  describe('when the API refuses', () => {
    it('shows a 400 validation_error on the field it names, and keeps the form', async () => {
      const t = await setup();
      await t.type(YEARLY, '12');

      await t.save();
      flushError(
        http.expectOne('/api/telegram/notifications'),
        400,
        'validation_error',
        'The request was not valid',
        [{ path: 'renewalYearlyDays', message: 'Too big: expected number to be <=30' }],
      );
      await settle(t.fixture);

      expect(fieldError(t.field(YEARLY))).toBe('Too big: expected number to be <=30');
      expect(t.field(YEARLY).value).toBe('12');
      expect(document.activeElement).toBe(t.field(YEARLY));
      expect(t.toasts()).toEqual([]);
      expect(t.saved).toEqual([]);
    });

    it('shows an error that names no field above the button, and puts focus on it', async () => {
      const t = await setup();

      await t.save();
      flushError(http.expectOne('/api/telegram/notifications'), 500, 'internal_error', 'Disk full');
      await settle(t.fixture);

      const alert = getByRole(t.element, 'alert');
      expect(textOf(alert)).toContain('Disk full');
      expect(document.activeElement).toBe(
        getByRole(t.element, 'button', 'Save notification settings'),
      );
      expect(t.saved).toEqual([]);

      // The next try clears the old message.
      await t.save();
      expect(queryByRole(t.element, 'alert')).toBeNull();
      http.expectOne('/api/telegram/notifications').flush({ ...DEFAULT_TELEGRAM_NOTIFICATIONS });
      await settle(t.fixture);
    });
  });
});
