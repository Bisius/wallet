import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { SettingsDto, SettingsInput, TagDto } from '@wallet/shared';
import { SettingsStore } from '../../core/settings.store';
import { ThemeService } from '../../core/theme.service';
import { ToastService } from '../../shared/ui/toast.service';
import {
  fieldError,
  getByLabel,
  getByRole,
  queryByRole,
  textOf,
  typeInto,
} from '../../../testing/dom';
import { tagDto } from '../../../testing/fixtures';
import {
  flushError,
  primeStores,
  render,
  SETTINGS,
  settle,
  StubPage,
} from '../../../testing/harness';
import { SettingsPage } from './settings-page';

describe('SettingsPage', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'savings', component: StubPage }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    TestBed.inject(DOCUMENT).documentElement.classList.remove('dark');
    http.verify();
  });

  const SAVED: SettingsDto = {
    currency: 'USD',
    locale: 'it-IT',
    startMonth: '2026-03',
    theme: 'light',
    alertWarnPercent: 70,
  };

  async function setup(settings: SettingsDto = SETTINGS, tags: TagDto[] = []) {
    TestBed.inject(ThemeService);
    await primeStores(http, { settings });
    const fixture = await render(SettingsPage);
    // The page lists the tags below the form (see tags-section.spec.ts for what it does with them).
    http.expectOne('/api/tags').flush(tags);
    await settle(fixture);
    const element = fixture.nativeElement as HTMLElement;
    const field = <T extends HTMLElement = HTMLInputElement>(label: string | RegExp) =>
      getByLabel<T>(element, label);
    const type = async (label: string | RegExp, value: string) => {
      typeInto(field(label), value);
      await settle(fixture);
    };
    const save = async () => {
      getByRole(element, 'button', 'Save settings').click();
      await settle(fixture);
    };
    return { fixture, element, field, type, save };
  }

  it('shows the current settings', async () => {
    const { field } = await setup(SAVED);

    expect(field('Currency').value).toBe('USD');
    expect(field('Locale').value).toBe('it-IT');
    expect(field<HTMLSelectElement>('Theme').value).toBe('light');
    expect(field('Budget warning threshold (%)').value).toBe('70');
    expect(field('Start month').value).toBe('2026-03');
  });

  it('lists the tags below the settings, outside the form', async () => {
    const { element } = await setup(SETTINGS, [
      tagDto({ id: 1, name: 'Groceries', usageCount: 3 }),
    ]);

    const tags = getByRole(element, 'region', 'Tags');
    expect(textOf(tags)).toContain('Groceries');
    expect(textOf(tags)).toContain('On 3 spendings');
    // Saving the settings is a different thing from editing a tag.
    expect(element.querySelector('form')?.contains(tags)).toBe(false);
  });

  it('labels every control and says what the numbers will look like', async () => {
    const { element } = await setup(SAVED);

    for (const label of [
      'Currency',
      'Locale',
      'Theme',
      'Budget warning threshold (%)',
      'Start month',
    ]) {
      expect(getByLabel(element, label)).toBeTruthy();
    }
    expect(textOf(element)).toContain('Amounts look like 1234,56 USD');
    expect(
      Array.from(getByLabel<HTMLSelectElement>(element, 'Theme').options).map((o) =>
        o.textContent?.trim(),
      ),
    ).toEqual(['Same as my device', 'Light', 'Dark']);
  });

  describe('theme', () => {
    it('applies a chosen theme straight away, before saving', async () => {
      const { type } = await setup();
      const root = TestBed.inject(DOCUMENT).documentElement;
      expect(root.classList.contains('dark')).toBe(false);

      await type('Theme', 'dark');

      expect(root.classList.contains('dark')).toBe(true);
      http.expectNone('/api/settings');
    });

    it('goes back to the saved theme when the user leaves without saving', async () => {
      const { fixture, type } = await setup();
      const root = TestBed.inject(DOCUMENT).documentElement;
      await type('Theme', 'dark');
      expect(root.classList.contains('dark')).toBe(true);

      fixture.destroy();
      await settle();

      expect(root.classList.contains('dark')).toBe(false);
    });

    it('keeps the theme once saved', async () => {
      const { fixture, type, save } = await setup();
      const root = TestBed.inject(DOCUMENT).documentElement;
      await type('Theme', 'dark');
      await save();
      http.expectOne('/api/settings').flush({ ...SETTINGS, theme: 'dark' });
      await settle(fixture);

      fixture.destroy();
      await settle();

      expect(TestBed.inject(SettingsStore).theme()).toBe('dark');
      expect(root.classList.contains('dark')).toBe(true);
    });
  });

  describe('saving', () => {
    it('sends all five settings with PUT /api/settings, then confirms and applies them', async () => {
      const { fixture, element, type, field, save } = await setup();
      await type('Currency', 'usd');
      await type('Locale', 'it-IT');
      await type('Theme', 'light');
      await type('Budget warning threshold (%)', '70');
      await type('Start month', '2026-03');

      await save();

      const request = http.expectOne('/api/settings');
      expect(request.request.method).toBe('PUT');
      const body: SettingsInput = {
        currency: 'USD',
        locale: 'it-IT',
        startMonth: '2026-03',
        theme: 'light',
        alertWarnPercent: 70,
      };
      expect(request.request.body).toEqual(body);
      request.flush(body);
      await settle(fixture);
      // The start month moved, so the opening balance is asked for again (see the tests below).
      http.expectOne('/api/savings/opening').flush({ amount: 100000, date: '2026-03-01' });
      await settle(fixture);

      expect(
        TestBed.inject(ToastService)
          .toasts()
          .map((t) => t.message),
      ).toEqual(['Settings saved.']);
      const store = TestBed.inject(SettingsStore);
      expect(store.currency()).toBe('USD');
      expect(store.locale()).toBe('it-IT');
      expect(store.alertWarnPercent()).toBe(70);
      expect(store.startMonth()).toBe('2026-03');
      expect(textOf(element)).toContain('Amounts look like 1234,56 USD');
      expect(field('Currency').value).toBe('USD');
    });

    it('shows that it is saving and cannot be sent twice', async () => {
      const { fixture, element, save } = await setup();
      const button = getByRole(element, 'button', 'Save settings') as HTMLButtonElement;

      await save();
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-busy')).toBe('true');
      button.click();
      await save();

      http.expectOne('/api/settings').flush(SETTINGS);
      await settle(fixture);
      expect(button.disabled).toBe(false);
    });

    it('writes the currency in capitals as the user types', async () => {
      const { field, type } = await setup();
      await type('Currency', 'gbp');
      expect(field('Currency').value).toBe('GBP');
    });
  });

  describe('checks before sending', () => {
    it.each([
      ['Currency', 'EU', 'Expected a 3-letter upper-case currency code like EUR'],
      ['Currency', '', 'Currency is required.'],
      ['Locale', 'en_US', 'Expected a BCP-47 locale tag like en-US'],
      ['Budget warning threshold (%)', '0', 'Enter a whole number from 1 to 100.'],
      ['Budget warning threshold (%)', '101', 'Enter a whole number from 1 to 100.'],
      ['Budget warning threshold (%)', '80.5', 'Enter a whole number from 1 to 100.'],
      ['Budget warning threshold (%)', '', 'Budget warning threshold (%) is required.'],
      ['Start month', '2026-11', 'Choose October 2026 or earlier.'],
      ['Start month', '', 'Start month is required.'],
    ])('rejects %s "%s" without calling the API', async (label, value, message) => {
      const { type, field, save } = await setup();
      await type(label, value);

      await save();

      expect(fieldError(field(label))).toBe(message);
      expect(field(label).getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(field(label));
      http.expectNone('/api/settings');
    });
  });

  describe('errors from the API', () => {
    it('explains clearly when the start month cannot move later (start_month_after_facts)', async () => {
      const { fixture, element, type, field, save } = await setup();
      await type('Start month', '2026-08');
      await save();

      flushError(
        http.expectOne('/api/settings'),
        422,
        'rule_violation',
        'Entries exist from 2026-06',
        {
          rule: 'start_month_after_facts',
          field: 'startMonth',
        },
      );
      await settle(fixture);

      const startMonth = field('Start month');
      expect(fieldError(startMonth)).toBe('Entries exist from 2026-06');
      expect(document.activeElement).toBe(startMonth);
      // The field is described by the error and by what to do about it.
      const description = (startMonth.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => textOf(element.querySelector(`#${id}`) as Element))
        .join(' ');
      expect(description).toContain('for example your first salary entry');
      expect(description).toContain('move or delete the earlier ones first');
      expect(description).toContain('choose an earlier month');
      expect(TestBed.inject(SettingsStore).startMonth()).toBe('2026-06');
      expect(TestBed.inject(ToastService).toasts()).toEqual([]);
    });

    it('explains clearly when the start month is in the future (start_month_in_future)', async () => {
      const { fixture, element, type, field, save } = await setup();
      await type('Start month', '2026-10');
      await save();

      flushError(
        http.expectOne('/api/settings'),
        422,
        'rule_violation',
        'After the current month',
        {
          rule: 'start_month_in_future',
          field: 'startMonth',
        },
      );
      await settle(fixture);

      expect(fieldError(field('Start month'))).toBe('After the current month');
      expect(textOf(element)).toContain(
        "can't be after the current month, or the current month would not be tracked",
      );
    });

    it('drops the explanation when the start month is changed', async () => {
      const { fixture, element, type, save } = await setup();
      await type('Start month', '2026-08');
      await save();
      flushError(http.expectOne('/api/settings'), 422, 'rule_violation', 'Too late', {
        rule: 'start_month_after_facts',
        field: 'startMonth',
      });
      await settle(fixture);
      expect(textOf(element)).toContain('move or delete the earlier ones first');

      await type('Start month', '2026-05');

      expect(textOf(element)).not.toContain('move or delete the earlier ones first');
    });

    it('shows a field error on its field', async () => {
      const { fixture, type, field, save } = await setup();
      await type('Currency', 'USD');
      await save();

      flushError(http.expectOne('/api/settings'), 400, 'validation_error', 'Invalid request body', [
        { path: 'currency', message: 'Unknown currency' },
      ]);
      await settle(fixture);

      expect(fieldError(field('Currency'))).toBe('Unknown currency');
      expect(document.activeElement).toBe(field('Currency'));
    });

    it('shows an error that belongs to no field in an alert, and keeps what was typed', async () => {
      const { fixture, element, type, field, save } = await setup();
      await type('Currency', 'USD');
      await save();

      flushError(
        http.expectOne('/api/settings'),
        500,
        'internal_error',
        'Something went wrong on our side',
      );
      await settle(fixture);

      expect(textOf(getByRole(element, 'alert'))).toBe('Something went wrong on our side');
      expect(field('Currency').value).toBe('USD');
      expect(queryByRole(element, 'button', 'Save settings')).not.toBeNull();
      expect(TestBed.inject(SettingsStore).currency()).toBe('EUR');
    });
  });

  describe('what it says about the start month', () => {
    it('says what the start month can and cannot be, without promising that every move works', async () => {
      const { element } = await setup();

      const text = textOf(element);
      expect(text).toContain('not after the current month and not more than 20 years back');
      expect(text).toContain(
        'Moving it later only works while nothing is dated before the new month',
      );
      expect(text).toContain('Your opening savings balance is the balance on its first day');
      expect(text).not.toContain('always possible');
    });

    it('explains clearly when the start month is too far back (start_month_too_old)', async () => {
      const { fixture, element, type, field, save } = await setup();
      await type('Start month', '2000-01');
      await save();

      flushError(http.expectOne('/api/settings'), 422, 'rule_violation', 'Too far back', {
        rule: 'start_month_too_old',
        field: 'startMonth',
      });
      await settle(fixture);

      expect(fieldError(field('Start month'))).toBe('Too far back');
      expect(textOf(element)).toContain(
        "The start month can't be more than 20 years before the current month. Choose a more recent one.",
      );
      expect(document.activeElement).toBe(field('Start month'));
      http.expectNone('/api/savings/opening');
    });

    it('says a start month that is too late must wait for the first entries to be moved or deleted', async () => {
      const { fixture, element, type, save } = await setup();
      await type('Start month', '2026-08');
      await save();

      flushError(http.expectOne('/api/settings'), 422, 'rule_violation', 'Entries exist', {
        rule: 'start_month_after_facts',
        field: 'startMonth',
      });
      await settle(fixture);

      expect(textOf(element)).toContain(
        'Some of your entries are dated before that month, for example your first salary entry.',
      );
      expect(textOf(element)).toContain('move or delete the earlier ones first');
    });
  });

  describe('after the start month changed', () => {
    const dialog = (element: HTMLElement) =>
      element.querySelector<HTMLElement>('app-opening-balance-dialog dialog[open]');

    /** Moves the start month from June to March and answers the save and the opening balance. */
    async function moveStartMonth(opening = { amount: 100000, date: '2026-03-01' }) {
      const page = await setup();
      await page.type('Start month', '2026-03');
      await page.save();
      http.expectOne('/api/settings').flush({ ...SETTINGS, startMonth: '2026-03' });
      await settle(page.fixture);
      http.expectOne('/api/savings/opening').flush(opening);
      await settle(page.fixture);
      return page;
    }

    it('asks for the savings balance on the new first day, starting from the amount kept', async () => {
      const { element } = await moveStartMonth();

      const prompt = dialog(element) as HTMLElement;
      expect(textOf(getByRole(prompt, 'heading', 'Check your opening balance'))).toBe(
        'Check your opening balance',
      );
      expect(textOf(prompt)).toContain('You moved the start month.');
      expect(textOf(prompt)).toContain(
        'kept its amount, which was your balance on the old first day',
      );
      // The label says which day: the new first day, as the API reports it.
      expect(getByLabel<HTMLInputElement>(prompt, 'Savings balance on Mar 1, 2026').value).toBe(
        '1000.00',
      );
      expect(document.activeElement).toBe(getByLabel(prompt, 'Savings balance on Mar 1, 2026'));
    });

    it('sends the amount the user confirms or changes with PUT /api/savings/opening', async () => {
      const { fixture, element, type } = await moveStartMonth();
      const prompt = dialog(element) as HTMLElement;
      typeInto(getByLabel(prompt, 'Savings balance on Mar 1, 2026'), '250,75');
      await settle(fixture);

      getByRole(prompt, 'button', 'Confirm balance').click();
      await settle(fixture);

      const request = http.expectOne('/api/savings/opening');
      expect(request.request.method).toBe('PUT');
      expect(request.request.body).toEqual({ amount: 25075 });
      request.flush({ amount: 25075, date: '2026-03-01' });
      await settle(fixture);

      expect(dialog(element)).toBeNull();
      expect(
        TestBed.inject(ToastService)
          .toasts()
          .map((t) => t.message),
      ).toEqual(['Settings saved.', 'Opening balance saved.']);
      expect(type).toBeDefined();
    });

    it('can confirm the amount as it is', async () => {
      const { fixture, element } = await moveStartMonth();

      getByRole(dialog(element) as HTMLElement, 'button', 'Confirm balance').click();
      await settle(fixture);

      const request = http.expectOne('/api/savings/opening');
      expect(request.request.body).toEqual({ amount: 100000 });
      request.flush({ amount: 100000, date: '2026-03-01' });
      await settle(fixture);
    });

    it('can be left for later: it says where to change it, and offers to go there', async () => {
      const { fixture, element } = await moveStartMonth();

      getByRole(dialog(element) as HTMLElement, 'button', 'Not now').click();
      await settle(fixture);

      expect(dialog(element)).toBeNull();
      http.expectNone('/api/savings/opening');
      const toasts = TestBed.inject(ToastService).toasts();
      expect(toasts.map((t) => t.message)).toEqual([
        'Settings saved.',
        'Your opening balance was left as it is. You can change it on the Savings page.',
      ]);
      // The toast offers to go there.
      expect(toasts[1].action?.label).toBe('Open savings');
      TestBed.inject(ToastService).act(toasts[1].id);
      await settle(fixture);
      expect(TestBed.inject(Router).url).toBe('/savings');
    });

    it('says it is loading, and what went wrong when the balance cannot be loaded, with a way to try again', async () => {
      const page = await setup();
      await page.type('Start month', '2026-03');
      await page.save();
      http.expectOne('/api/settings').flush({ ...SETTINGS, startMonth: '2026-03' });
      await settle(page.fixture);
      expect(textOf(dialog(page.element) as HTMLElement)).toContain(
        'Loading your opening balance…',
      );

      flushError(
        http.expectOne('/api/savings/opening'),
        500,
        'internal_error',
        'The ledger is down',
      );
      await settle(page.fixture);
      expect(textOf(dialog(page.element) as HTMLElement)).toContain(
        "Couldn't load your opening balance",
      );
      expect(textOf(dialog(page.element) as HTMLElement)).toContain('The ledger is down');

      getByRole(dialog(page.element) as HTMLElement, 'button', 'Try again').click();
      await settle(page.fixture);
      http.expectOne('/api/savings/opening').flush({ amount: 100000, date: '2026-03-01' });
      await settle(page.fixture);
      expect(
        getByLabel<HTMLInputElement>(
          dialog(page.element) as HTMLElement,
          'Savings balance on Mar 1, 2026',
        ).value,
      ).toBe('1000.00');
    });

    it('does not ask when the start month stayed the same', async () => {
      const { fixture, element, type, save } = await setup();
      await type('Currency', 'USD');
      await save();
      http.expectOne('/api/settings').flush({ ...SETTINGS, currency: 'USD' });
      await settle(fixture);

      expect(dialog(element)).toBeNull();
      http.expectNone('/api/savings/opening');
    });

    it('does not ask when the save failed: the start month did not change', async () => {
      const { fixture, element, type, save } = await setup();
      await type('Start month', '2026-08');
      await save();

      flushError(http.expectOne('/api/settings'), 422, 'rule_violation', 'Entries exist', {
        rule: 'start_month_after_facts',
        field: 'startMonth',
      });
      await settle(fixture);

      expect(dialog(element)).toBeNull();
      http.expectNone('/api/savings/opening');
    });
  });
});
