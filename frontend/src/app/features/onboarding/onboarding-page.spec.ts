import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import {
  MAX_ONBOARDING_BUDGETS,
  type OnboardingInput,
  type OnboardingResponse,
  onboardingSchema,
} from '@wallet/shared';
import { SettingsStore } from '../../core/settings.store';
import { ToastService } from '../../shared/ui/toast.service';
import {
  accessibleName,
  fieldError,
  getAllByLabel,
  getByLabel,
  getByRole,
  queryAllByRole,
  queryByRole,
  queryByText,
  textOf,
  typeInto,
} from '../../../testing/dom';
import {
  flushError,
  primeStores,
  render,
  SETTINGS,
  settle,
  StubPage,
} from '../../../testing/harness';
import { OnboardingPage } from './onboarding-page';

const RESPONSE = (input: OnboardingInput): OnboardingResponse => ({
  settings: {
    currency: input.currency,
    locale: input.locale,
    startMonth: input.startMonth,
    theme: 'system',
    alertWarnPercent: 80,
  },
  salary: { effectiveMonth: input.startMonth, amount: input.salary },
  openingSavings: input.openingSavings,
  budgets: [],
});

/** The start month defaults to the current month of the server: October 2026. */
const SAVINGS_LABEL = 'Savings balance on the 1st of October 2026';

describe('OnboardingPage', () => {
  let http: HttpTestingController;
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'dashboard', component: StubPage }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  afterEach(() => http.verify());

  async function setup(options: Parameters<typeof primeStores>[1] = { settings: null }) {
    await primeStores(http, options);
    const fixture = await render(OnboardingPage);
    const element = fixture.nativeElement as HTMLElement;

    const wizard = {
      fixture,
      element,
      heading: () => textOf(element.querySelector('h2') as Element),
      /** Types into a field by its label and lets the form react. */
      type: async (label: string | RegExp, value: string) => {
        typeInto(getByLabel(element, label), value);
        await settle(fixture);
      },
      press: async (name: string | RegExp) => {
        getByRole(element, 'button', name).click();
        await settle(fixture);
      },
      /** Pressing Enter in a field submits the form: the same as the Next button. */
      submitForm: async () => {
        (element.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
        await settle(fixture);
      },
      next: () => wizard.press('Next'),
      toStep: async (step: 'salary' | 'savings' | 'budgets' | 'review') => {
        const order = ['salary', 'savings', 'budgets', 'review'];
        for (const name of order.slice(0, order.indexOf(step) + 1)) {
          if (name === 'salary') await wizard.next();
          if (name === 'salary' && step !== 'salary') {
            await wizard.type('Monthly net salary', '2500');
            await wizard.next();
          }
          if (name === 'savings' && step !== 'savings') {
            await wizard.type(SAVINGS_LABEL, '0');
            await wizard.next();
          }
          if (name === 'budgets' && step !== 'budgets') await wizard.next();
        }
      },
      addBudget: async (name: string, amount: string, incremental = false) => {
        await wizard.press('Add a budget');
        const row = getAllByLabel(element, 'Name').length - 1;
        typeInto(getAllByLabel(element, 'Name')[row], name);
        typeInto(getAllByLabel(element, 'Monthly amount')[row], amount);
        if (incremental) queryAllByRole(element, 'switch', 'Incremental')[row].click();
        await settle(fixture);
      },
    };
    return wizard;
  }

  describe('the first step', () => {
    it('starts at the start month of the server, with a currency and a locale', async () => {
      const wizard = await setup({
        settings: null,
        today: { date: '2031-03-31', month: '2031-03' },
      });

      expect(wizard.heading()).toBe('Start month and currency');
      expect((getByLabel(wizard.element, 'Start month') as HTMLInputElement).value).toBe('2031-03');
      expect((getByLabel(wizard.element, 'Currency') as HTMLInputElement).value).toBe('EUR');
      expect((getByLabel(wizard.element, 'Locale') as HTMLInputElement).value).toBe('en-US');
      expect(textOf(wizard.element)).toContain('Amounts will look like €1,234.56');
    });

    it('does not allow a start month in the future', async () => {
      const wizard = await setup();

      await wizard.type('Start month', '2026-11');
      await wizard.next();

      expect(wizard.heading()).toBe('Start month and currency');
      expect(fieldError(getByLabel(wizard.element, 'Start month'))).toBe(
        'Choose October 2026 or earlier.',
      );
    });

    it('allows an earlier start month', async () => {
      const wizard = await setup();
      await wizard.type('Start month', '2026-01');
      await wizard.next();
      expect(wizard.heading()).toBe('Your monthly salary');
    });

    it('needs a start month', async () => {
      const wizard = await setup();
      await wizard.type('Start month', '');
      await wizard.next();
      expect(fieldError(getByLabel(wizard.element, 'Start month'))).toBe(
        'Start month is required.',
      );
    });

    it('checks the currency and the locale with the rules of the API', async () => {
      const wizard = await setup();

      await wizard.type('Currency', 'EU');
      await wizard.type('Locale', 'en_US');
      await wizard.next();

      expect(wizard.heading()).toBe('Start month and currency');
      expect(fieldError(getByLabel(wizard.element, 'Currency'))).toBe(
        'Expected a 3-letter upper-case currency code like EUR',
      );
      expect(fieldError(getByLabel(wizard.element, 'Locale'))).toBe(
        'Expected a BCP-47 locale tag like en-US',
      );
    });

    it('writes the currency in capitals as the user types', async () => {
      const wizard = await setup();
      await wizard.type('Currency', 'usd');
      expect((getByLabel(wizard.element, 'Currency') as HTMLInputElement).value).toBe('USD');
      await wizard.type('Locale', 'it-IT');
      expect(textOf(wizard.element)).toContain('Amounts will look like 1234,56 USD');
    });

    it('offers common currencies and locales as suggestions', async () => {
      const wizard = await setup();
      const list = (id: string) =>
        Array.from(wizard.element.querySelectorAll(`#${id} option`)).map((o) =>
          o.getAttribute('value'),
        );
      expect(list('currency-options')).toContain('USD');
      expect(list('locale-options')).toContain('it-IT');
      expect(getByLabel(wizard.element, 'Currency').getAttribute('list')).toBe('currency-options');
    });
  });

  describe('the stepper', () => {
    it('shows where the user is, with aria-current on the current step', async () => {
      const wizard = await setup();
      const items = () =>
        Array.from(wizard.element.querySelectorAll('nav[aria-label="Setup progress"] li'));

      expect(textOf(wizard.element)).toContain('Step 1 of 5');
      expect(items().map((li) => li.getAttribute('aria-current'))).toEqual([
        'step',
        null,
        null,
        null,
        null,
      ]);
      expect(items().map((li) => textOf(li))).toEqual([
        'Basics',
        'Salary (upcoming)',
        'Savings (upcoming)',
        'Budgets (upcoming)',
        'Review (upcoming)',
      ]);

      await wizard.next();
      expect(textOf(wizard.element)).toContain('Step 2 of 5');
      expect(items().map((li) => li.getAttribute('aria-current'))).toEqual([
        null,
        'step',
        null,
        null,
        null,
      ]);
      expect(textOf(items()[0])).toContain('(done)');
    });

    it('moves focus to the heading of each new step', async () => {
      const wizard = await setup();
      await wizard.next();

      expect(document.activeElement).toBe(wizard.element.querySelector('h2'));
      expect(textOf(document.activeElement as Element)).toBe('Your monthly salary');

      await wizard.press('Back');
      expect(document.activeElement).toBe(wizard.element.querySelector('h2'));
      expect(textOf(document.activeElement as Element)).toBe('Start month and currency');
    });

    it('has Back (not on the first step) and Next, and the last step says what it does', async () => {
      const wizard = await setup();
      expect((getByRole(wizard.element, 'button', 'Back') as HTMLButtonElement).disabled).toBe(
        true,
      );
      expect(getByRole(wizard.element, 'button', 'Next').getAttribute('type')).toBe('submit');

      await wizard.toStep('review');
      expect(wizard.heading()).toBe('Review and finish');
      expect((getByRole(wizard.element, 'button', 'Back') as HTMLButtonElement).disabled).toBe(
        false,
      );
      expect(getByRole(wizard.element, 'button', 'Create my wallet').getAttribute('type')).toBe(
        'submit',
      );
      expect(queryByRole(wizard.element, 'button', 'Next')).toBeNull();
    });

    it('keeps what was typed when going back', async () => {
      const wizard = await setup();
      await wizard.next();
      await wizard.type('Monthly net salary', '2500,5');
      await wizard.press('Back');
      await wizard.next();
      expect((getByLabel(wizard.element, 'Monthly net salary') as HTMLInputElement).value).toBe(
        '2500.50',
      );
    });

    it('continues when Enter is pressed in a field (the form is submitted)', async () => {
      const wizard = await setup();
      await wizard.submitForm();
      expect(wizard.heading()).toBe('Your monthly salary');

      await wizard.type('Monthly net salary', '2500');
      await wizard.submitForm();
      expect(wizard.heading()).toBe('Your savings so far');
    });
  });

  describe('per-step validation', () => {
    it('needs a salary before going on, and puts focus on the field', async () => {
      const wizard = await setup();
      await wizard.next();
      await wizard.next();

      expect(wizard.heading()).toBe('Your monthly salary');
      const salary = getByLabel(wizard.element, 'Monthly net salary');
      expect(fieldError(salary)).toBe('Monthly net salary is required.');
      expect(document.activeElement).toBe(salary);
    });

    it.each([
      ['abc', 'Enter an amount like 12.50 or 12,50.'],
      ['-5', 'Enter an amount of zero or more.'],
      ['12.345', 'Enter an amount like 12.50 or 12,50.'],
    ])('rejects a salary of "%s"', async (text, message) => {
      const wizard = await setup();
      await wizard.next();
      await wizard.type('Monthly net salary', text);
      await wizard.next();

      expect(wizard.heading()).toBe('Your monthly salary');
      expect(fieldError(getByLabel(wizard.element, 'Monthly net salary'))).toBe(message);
    });

    it('accepts a salary of zero', async () => {
      const wizard = await setup();
      await wizard.next();
      await wizard.type('Monthly net salary', '0');
      await wizard.next();
      expect(wizard.heading()).toBe('Your savings so far');
    });

    it('starts the savings balance at zero and rejects a negative one', async () => {
      const wizard = await setup();
      await wizard.next();
      await wizard.type('Monthly net salary', '1');
      await wizard.next();
      expect((getByLabel(wizard.element, SAVINGS_LABEL) as HTMLInputElement).value).toBe('0.00');

      await wizard.type(SAVINGS_LABEL, '-1');
      await wizard.next();
      expect(wizard.heading()).toBe('Your savings so far');
      expect(fieldError(getByLabel(wizard.element, SAVINGS_LABEL))).toBe(
        'Enter an amount of zero or more.',
      );
    });

    it('shows amounts in the currency and separator that were chosen', async () => {
      const wizard = await setup();
      await wizard.type('Currency', 'USD');
      await wizard.type('Locale', 'it-IT');
      await wizard.next();

      const salary = getByLabel(wizard.element, 'Monthly net salary') as HTMLInputElement;
      expect(salary.placeholder).toBe('0,00');
      expect(
        textOf(
          wizard.element.querySelector(
            `#${salary.getAttribute('aria-describedby')?.split(' ').at(-1)}`,
          ) as Element,
        ),
      ).toBe('USD');
    });
  });

  describe('first budgets', () => {
    async function atBudgets() {
      const wizard = await setup();
      await wizard.toStep('budgets');
      return wizard;
    }

    it('may be skipped', async () => {
      const wizard = await atBudgets();
      expect(wizard.heading()).toBe('Your first budgets');
      expect(textOf(wizard.element)).toContain('You can skip this');

      await wizard.next();
      expect(wizard.heading()).toBe('Review and finish');
      expect(textOf(wizard.element)).toContain('None yet. You can add them later.');
    });

    it('adds rows, each with a name, a monthly amount and an incremental toggle', async () => {
      const wizard = await atBudgets();
      await wizard.press('Add a budget');

      expect(textOf(getByRole(wizard.element, 'group', 'Budget 1'))).toContain('Name');
      expect(getAllByLabel(wizard.element, 'Name')).toHaveLength(1);
      expect(getAllByLabel(wizard.element, 'Monthly amount')).toHaveLength(1);
      expect(queryAllByRole(wizard.element, 'switch', 'Incremental')).toHaveLength(1);
      // The new row's name field has focus: the keyboard user can start typing.
      expect(document.activeElement).toBe(getAllByLabel(wizard.element, 'Name')[0]);
    });

    it('lists the rows as plain groups divided by a line, not as boxes inside the card', async () => {
      const wizard = await atBudgets();
      await wizard.press('Add a budget');
      await wizard.press('Add a budget');

      const groups = queryAllByRole(wizard.element, 'group').filter((group) =>
        /^Budget \d$/.test(accessibleName(group)),
      );
      expect(groups).toHaveLength(2);
      for (const group of groups) {
        expect(group.className).not.toMatch(/\b(border|rounded-card)\b/);
      }
      // Each group sits in a row of its own, and the rows are divided by a line.
      expect((groups[0].parentElement?.parentElement as Element).className).toContain('divide-y');
    });

    it('says in one line under the heading that budgets may be skipped', async () => {
      const wizard = await atBudgets();

      expect(textOf(wizard.element.querySelector('h2')?.nextElementSibling as Element)).toBe(
        'Split your income into spending categories. You can skip this and add budgets later.',
      );
    });

    it('explains rollover in one line, next to the toggle', async () => {
      const wizard = await atBudgets();
      await wizard.press('Add a budget');

      const toggle = queryAllByRole(wizard.element, 'switch', 'Incremental')[0];
      const description = wizard.element.querySelector(
        `#${toggle.getAttribute('aria-describedby')}`,
      );
      expect(textOf(description as Element)).toBe(
        'Carry what is left (or overspent) into next month. Off: leftovers go to savings.',
      );
    });

    it('blocks Next while a row is incomplete, naming what is missing', async () => {
      const wizard = await atBudgets();
      await wizard.press('Add a budget');
      await wizard.next();

      expect(wizard.heading()).toBe('Your first budgets');
      expect(fieldError(getAllByLabel(wizard.element, 'Name')[0])).toBe('Name is required.');
      expect(fieldError(getAllByLabel(wizard.element, 'Monthly amount')[0])).toBe(
        'Monthly amount is required.',
      );
      expect(document.activeElement).toBe(getAllByLabel(wizard.element, 'Name')[0]);
    });

    it('removes a row, with a button named after the budget', async () => {
      const wizard = await atBudgets();
      await wizard.addBudget('Groceries', '400');
      await wizard.addBudget('Fun', '100');

      await wizard.press('Remove Groceries');

      expect(getAllByLabel(wizard.element, 'Name').map((i) => i.value)).toEqual(['Fun']);
      expect(queryByRole(wizard.element, 'button', 'Remove Fun')).not.toBeNull();
      // The removed row had focus: it moves to the button that adds one.
      expect(document.activeElement).toBe(getByRole(wizard.element, 'button', 'Add a budget'));
    });

    it('names an unnamed row by its position', async () => {
      const wizard = await atBudgets();
      await wizard.press('Add a budget');
      expect(queryByRole(wizard.element, 'button', 'Remove budget 1')).not.toBeNull();
    });

    it('stops adding at the most the API accepts', async () => {
      const wizard = await atBudgets();
      for (let i = 0; i < MAX_ONBOARDING_BUDGETS; i++) await wizard.press('Add a budget');

      expect(getAllByLabel(wizard.element, 'Name')).toHaveLength(MAX_ONBOARDING_BUDGETS);
      expect(
        (getByRole(wizard.element, 'button', 'Add a budget') as HTMLButtonElement).disabled,
      ).toBe(true);
    });
  });

  describe('the savings balance', () => {
    it('says which day it is the balance of: the first of the start month', async () => {
      const wizard = await setup();
      await wizard.next();
      await wizard.type('Monthly net salary', '1');
      await wizard.next();

      expect(wizard.heading()).toBe('Your savings so far');
      expect(getByLabel(wizard.element, SAVINGS_LABEL)).toBeTruthy();
      expect(textOf(wizard.element)).toContain(
        'What you already have set aside on that day. Use 0 if you are starting from scratch.',
      );
    });

    it('follows the start month the user chose', async () => {
      const wizard = await setup();
      await wizard.type('Start month', '2026-01');
      await wizard.next();
      await wizard.type('Monthly net salary', '1');
      await wizard.next();

      expect(getByLabel(wizard.element, 'Savings balance on the 1st of January 2026')).toBeTruthy();
      await wizard.type('Savings balance on the 1st of January 2026', '500');
      await wizard.next();
      await wizard.next();
      expect(textOf(wizard.element)).toContain(
        'Savings balance on the 1st of January 2026 €500.00',
      );
    });

    it('tells the user the start month, its limits and what the balance refers to', async () => {
      const wizard = await setup();

      const text = textOf(wizard.element);
      expect(text).toContain('not after the current month and not more than 20 years back');
      expect(text).toContain('Your opening savings balance is the balance on its first day');
      expect(text).not.toContain('always possible');
    });
  });

  describe('creating the wallet', () => {
    async function fillEverything() {
      const wizard = await setup();
      await wizard.type('Currency', 'EUR');
      await wizard.next();
      await wizard.type('Monthly net salary', '2500,00');
      await wizard.submitForm();
      await wizard.type(SAVINGS_LABEL, '1000');
      await wizard.next();
      await wizard.addBudget('Groceries', '400', true);
      await wizard.addBudget('  Fun ', '100,5');
      await wizard.next();
      return wizard;
    }

    it('shows what will be created, in the chosen currency and locale', async () => {
      const wizard = await fillEverything();
      const text = textOf(wizard.element);

      expect(wizard.heading()).toBe('Review and finish');
      expect(text).toContain('Start month October 2026');
      expect(text).toContain('Currency and locale EUR · en-US');
      expect(text).toContain('Monthly net salary €2,500.00');
      expect(text).toContain('Savings balance on the 1st of October 2026 €1,000.00');
      expect(text).toContain('Groceries Incremental €400.00');
      expect(text).toContain('Fun Not incremental €100.50');
      expect(text).toContain('Nothing is saved until you do.');
    });

    it('lets the user go back and change something from the review', async () => {
      const wizard = await fillEverything();

      await wizard.press('Change monthly net salary');
      expect(wizard.heading()).toBe('Your monthly salary');
      await wizard.type('Monthly net salary', '3000');
      await wizard.next();
      await wizard.next();
      await wizard.next();

      expect(textOf(wizard.element)).toContain('Monthly net salary €3,000.00');
    });

    it('sends ONE request with exactly the expected body, then opens the dashboard', async () => {
      const wizard = await fillEverything();
      http.expectNone('/api/onboarding');

      await wizard.press('Create my wallet');

      const request = http.expectOne('/api/onboarding');
      expect(request.request.method).toBe('POST');
      const expected: OnboardingInput = {
        currency: 'EUR',
        locale: 'en-US',
        startMonth: '2026-10',
        salary: 250000,
        openingSavings: 100000,
        budgets: [
          { name: 'Groceries', amount: 40000, incremental: true },
          { name: 'Fun', amount: 10050, incremental: false },
        ],
      };
      expect(request.request.body).toEqual(expected);
      // The request is something the API accepts, key for key.
      expect(onboardingSchema.safeParse(request.request.body).success).toBe(true);

      request.flush(RESPONSE(expected), { status: 201, statusText: 'Created' });
      await settle(wizard.fixture);

      expect(router.url).toBe('/dashboard');
      const settings = TestBed.inject(SettingsStore);
      expect(settings.onboarded()).toBe(true);
      expect(settings.currency()).toBe('EUR');
      expect(settings.startMonth()).toBe('2026-10');
      expect(
        TestBed.inject(ToastService)
          .toasts()
          .map((t) => t.message),
      ).toEqual(['Your wallet is ready.']);
    });

    it('sends a wallet with no budgets and a different currency and locale', async () => {
      const wizard = await setup();
      await wizard.type('Start month', '2026-01');
      await wizard.type('Currency', 'usd');
      await wizard.type('Locale', 'it-IT');
      await wizard.next();
      await wizard.type('Monthly net salary', '1.234,5'.replace('.', ''));
      await wizard.next();
      await wizard.next();
      await wizard.next();
      await wizard.press('Create my wallet');

      const request = http.expectOne('/api/onboarding');
      expect(request.request.body).toEqual({
        currency: 'USD',
        locale: 'it-IT',
        startMonth: '2026-01',
        salary: 123450,
        openingSavings: 0,
        budgets: [],
      });
      request.flush(RESPONSE(request.request.body), { status: 201, statusText: 'Created' });
      await settle(wizard.fixture);
    });

    it('shows that it is working and sends only one request however often it is pressed', async () => {
      const wizard = await fillEverything();
      const create = getByRole(wizard.element, 'button', 'Create my wallet') as HTMLButtonElement;

      create.click();
      await settle(wizard.fixture);
      expect(create.disabled).toBe(true);
      expect(create.getAttribute('aria-busy')).toBe('true');
      await wizard.submitForm();
      create.click();

      const request = http.expectOne('/api/onboarding');
      request.flush(RESPONSE(request.request.body), { status: 201, statusText: 'Created' });
      await settle(wizard.fixture);
    });
  });

  describe('errors from the API', () => {
    async function submitWithError(
      status: number,
      code: Parameters<typeof flushError>[2],
      message: string,
      details?: unknown,
    ) {
      const wizard = await setup();
      await wizard.next();
      await wizard.type('Monthly net salary', '2500');
      await wizard.next();
      await wizard.next();
      await wizard.addBudget('Groceries', '400');
      await wizard.addBudget('Fun', '100');
      await wizard.next();
      await wizard.press('Create my wallet');
      flushError(http.expectOne('/api/onboarding'), status, code, message, details);
      await settle(wizard.fixture);
      return wizard;
    }

    it('shows a field error on the right field and goes to its step', async () => {
      const wizard = await submitWithError(400, 'validation_error', 'Invalid request body', [
        { path: 'budgets.1.amount', message: 'Amount out of range' },
      ]);

      expect(wizard.heading()).toBe('Your first budgets');
      const amount = getAllByLabel(wizard.element, 'Monthly amount')[1];
      expect(fieldError(amount)).toBe('Amount out of range');
      expect(amount.getAttribute('aria-invalid')).toBe('true');
      expect(fieldError(getAllByLabel(wizard.element, 'Monthly amount')[0])).toBe('');
      expect(document.activeElement).toBe(amount);
    });

    it('explains a start month that is too far back (start_month_too_old) under the field', async () => {
      const wizard = await submitWithError(422, 'rule_violation', 'Too far back', {
        rule: 'start_month_too_old',
        field: 'startMonth',
      });

      expect(wizard.heading()).toBe('Start month and currency');
      const startMonth = getByLabel(wizard.element, 'Start month');
      expect(fieldError(startMonth)).toBe('Too far back');
      expect(textOf(wizard.element)).toContain(
        "The start month can't be more than 20 years before the current month. Choose a more recent one.",
      );
      expect(document.activeElement).toBe(startMonth);
    });

    it('explains a start month in the future (start_month_in_future) and drops the explanation when it is changed', async () => {
      const wizard = await submitWithError(422, 'rule_violation', 'After the current month', {
        rule: 'start_month_in_future',
        field: 'startMonth',
      });
      expect(textOf(wizard.element)).toContain(
        "The start month can't be after the current month, or the current month would not be tracked.",
      );

      await wizard.type('Start month', '2026-09');

      expect(textOf(wizard.element)).not.toContain('would not be tracked');
      expect(textOf(wizard.element)).toContain(
        'not after the current month and not more than 20 years back',
      );
    });

    it('goes to the first step for an error about the start month', async () => {
      const wizard = await submitWithError(
        422,
        'rule_violation',
        'The start month is after the current month',
        {
          rule: 'start_month_in_future',
          field: 'startMonth',
        },
      );

      expect(wizard.heading()).toBe('Start month and currency');
      const startMonth = getByLabel(wizard.element, 'Start month');
      expect(fieldError(startMonth)).toBe('The start month is after the current month');
      expect(document.activeElement).toBe(startMonth);
    });

    it('lets the user fix the field and send again', async () => {
      const wizard = await submitWithError(400, 'validation_error', 'Invalid request body', [
        { path: 'salary', message: 'Amount must not be negative' },
      ]);
      expect(wizard.heading()).toBe('Your monthly salary');

      // The error is stuck on the field until it is edited.
      await wizard.next();
      expect(wizard.heading()).toBe('Your monthly salary');

      await wizard.type('Monthly net salary', '2600');
      await wizard.next();
      await wizard.next();
      await wizard.next();
      await wizard.press('Create my wallet');

      const request = http.expectOne('/api/onboarding');
      expect((request.request.body as OnboardingInput).salary).toBe(260000);
      request.flush(RESPONSE(request.request.body), { status: 201, statusText: 'Created' });
      await settle(wizard.fixture);
      expect(router.url).toBe('/dashboard');
    });

    it('shows an error that belongs to no field in an alert, and stays on the review', async () => {
      const wizard = await submitWithError(
        500,
        'internal_error',
        'Something went wrong on our side',
      );

      expect(wizard.heading()).toBe('Review and finish');
      expect(textOf(getByRole(wizard.element, 'alert'))).toBe('Something went wrong on our side');
      const create = getByRole(wizard.element, 'button', 'Create my wallet') as HTMLButtonElement;
      expect(create.disabled).toBe(false);
      expect(create.getAttribute('aria-busy')).toBeNull();
    });

    it('says the server cannot be reached when it cannot', async () => {
      const wizard = await setup();
      await wizard.toStep('review');
      await wizard.press('Create my wallet');
      http.expectOne('/api/onboarding').error(new ProgressEvent('error'));
      await settle(wizard.fixture);

      expect(textOf(getByRole(wizard.element, 'alert'))).toMatch(/can't reach the server/i);
    });

    it('carries on to the dashboard when the wallet was already set up elsewhere', async () => {
      const wizard = await setup();
      await wizard.toStep('review');
      await wizard.press('Create my wallet');
      flushError(http.expectOne('/api/onboarding'), 409, 'already_onboarded', 'Already set up');
      await settle(wizard.fixture);

      expect(
        TestBed.inject(ToastService)
          .toasts()
          .map((t) => t.message),
      ).toEqual(['Wallet was already set up.']);
      // The app asks for the settings it now has, then opens the dashboard.
      http.expectOne('/api/settings').flush(SETTINGS);
      await settle(wizard.fixture);
      expect(router.url).toBe('/dashboard');
      expect(queryByText(wizard.element, 'Already set up')).toBeNull();
    });
  });
});
