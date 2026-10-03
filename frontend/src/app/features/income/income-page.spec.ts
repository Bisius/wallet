import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import type { IncomeDto, MonthStatus, MonthView, SalaryEntryDto } from '@wallet/shared';
import { incomeCreateSchema, incomeUpdateSchema, salaryUpsertSchema } from '@wallet/shared';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog';
import { ToastContainer } from '../../shared/ui/toast-container';
import { ToastService } from '../../shared/ui/toast.service';
import {
  fieldError,
  getByLabel,
  getByRole,
  queryByRole,
  queryByText,
  textOf,
  typeInto,
} from '../../../testing/dom';
import { flushError, primeStores, SETTINGS, settle, StubPage } from '../../../testing/harness';
import { IncomePage } from './income-page';

@Component({
  selector: 'app-income-host',
  imports: [IncomePage, ConfirmDialog, ToastContainer],
  template: '<app-income-page /><app-confirm-dialog /><app-toast-container />',
})
class IncomeHost {}

function monthView(
  month: string,
  income: { salary: number; extra: number; total: number },
  status: MonthStatus = 'current',
): MonthView {
  return {
    month,
    status,
    income,
    fixedCosts: 0,
    subscriptions: [],
    budgets: [],
    totals: { allocated: 0, spent: 0, remaining: 0, transfersNet: 0 },
    unallocated: income.total,
    overAllocated: false,
    savingsDue: {
      unallocated: income.total,
      budgetsSettled: 0,
      reservesReleased: 0,
      total: income.total,
    },
  };
}

const SALARY: SalaryEntryDto[] = [
  { effectiveMonth: '2026-06', amount: 250000 },
  { effectiveMonth: '2026-09', amount: 270000 },
];
const INCOMES: IncomeDto[] = [
  { id: 2, date: '2026-10-02', amount: 5000, description: 'Birthday money' },
  { id: 1, date: '2026-10-01', amount: 30000, description: 'Tax refund' },
];
/** The page itself: the host also holds the toast container, which has its own (empty) alert region. */
const pageOf = (element: HTMLElement) => element.querySelector('app-income-page') as HTMLElement;

const OCTOBER = monthView('2026-10', { salary: 270000, extra: 35000, total: 305000 });

describe('IncomePage', () => {
  let http: HttpTestingController;
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'income', component: StubPage }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  afterEach(() => http.verify());

  /** Asserts that no request to a URL matching `pattern` was made. */
  const noRequest = (pattern: RegExp) => http.expectNone((request) => pattern.test(request.url));

  interface Data {
    view?: MonthView;
    salary?: SalaryEntryDto[];
    incomes?: IncomeDto[];
  }

  /** Opens the page for a month and answers its three requests. */
  async function open(
    month = '2026-10',
    data: Data = {},
    query = month === '2026-10' ? '' : `?month=${month}`,
  ) {
    await primeStores(http);
    await router.navigateByUrl(`/income${query}`);
    const fixture = TestBed.createComponent(IncomeHost);
    fixture.detectChanges();
    await settle(fixture);
    await answer(fixture, month, data);
    return page(fixture, month);
  }

  async function answer(fixture: { detectChanges(): void }, month: string, data: Data = {}) {
    http.expectOne(`/api/months/${month}`).flush(data.view ?? monthView(month, OCTOBER.income));
    http.expectOne('/api/salary').flush(data.salary ?? SALARY);
    http.expectOne(`/api/incomes?month=${month}`).flush(data.incomes ?? INCOMES);
    await settle(fixture as never);
  }

  /** Moving to another month reloads the month view and the incomes: the salary history is the same. */
  async function answerMonthChange(
    fixture: { detectChanges(): void },
    month: string,
    data: Data = {},
  ) {
    http.expectOne(`/api/months/${month}`).flush(data.view ?? monthView(month, OCTOBER.income));
    http.expectOne(`/api/incomes?month=${month}`).flush(data.incomes ?? INCOMES);
    await settle(fixture as never);
  }

  function page(fixture: ReturnType<typeof TestBed.createComponent<IncomeHost>>, month: string) {
    const element = fixture.nativeElement as HTMLElement;
    const helpers = {
      fixture,
      element,
      month,
      text: () => textOf(element),
      type: async (label: string | RegExp, value: string) => {
        typeInto(getByLabel(element, label), value);
        await settle(fixture);
      },
      press: async (name: string | RegExp) => {
        getByRole(element, 'button', name).click();
        await settle(fixture);
      },
      /** After a change the page loads all three resources again. */
      reload: async (data: Data = {}) => {
        await settle(fixture);
        await answer(fixture, month, data);
      },
      section: (heading: string | RegExp) => getByRole(element, 'region', heading) as HTMLElement,
      dialog: () => element.querySelector('dialog') as HTMLDialogElement,
      toasts: () =>
        TestBed.inject(ToastService)
          .toasts()
          .map((toast) => toast.message),
    };
    return helpers;
  }

  describe('this month at a glance', () => {
    it('shows the totals of the month view exactly as the API reports them', async () => {
      // Figures that do not add up on purpose: the page must show what the API says, not compute.
      const p = await open('2026-10', {
        view: monthView('2026-10', { salary: 111, extra: 222, total: 999 }),
      });

      const summary = textOf(p.section('Income in October 2026'));
      expect(summary).toContain('Salary €1.11');
      expect(summary).toContain('One-off income €2.22');
      expect(summary).toContain('Total income €9.99');
    });

    it('says what kind of month it is', async () => {
      const closed = await open('2026-08', {
        view: monthView('2026-08', OCTOBER.income, 'closed'),
      });
      expect(textOf(closed.section('Income in August 2026'))).toContain('Closed month');
      expect(closed.text()).toContain(
        'This month is closed. Changing its income changes what is due to savings.',
      );
    });

    it('marks a future month as a projection', async () => {
      const p = await open('2026-12', { view: monthView('2026-12', OCTOBER.income, 'future') });
      expect(textOf(p.section('Income in December 2026'))).toContain('Projection');
      expect(p.text()).toContain(
        'This month has not started yet, so these figures are a projection.',
      );
    });

    it('names the month in the page header', async () => {
      const p = await open();
      expect(p.text()).toContain('Salary and other money coming in, for October 2026.');
      expect(getByRole(p.element, 'heading', 'Income')).toBeTruthy();
    });
  });

  describe('loading and failing', () => {
    it('says it is loading while the requests are out', async () => {
      await primeStores(http);
      await router.navigateByUrl('/income');
      const fixture = TestBed.createComponent(IncomeHost);
      fixture.detectChanges();
      await settle(fixture);

      const text = textOf(fixture.nativeElement);
      expect(text).toContain("Loading this month's income…");
      expect(text).toContain('Loading the salary history…');
      expect(text).toContain('Loading one-off income…');
      await answer(fixture, '2026-10');
    });

    it('shows the API message when one part fails, keeps the others, and can try again', async () => {
      await primeStores(http);
      await router.navigateByUrl('/income');
      const fixture = TestBed.createComponent(IncomeHost);
      fixture.detectChanges();
      await settle(fixture);
      http.expectOne('/api/months/2026-10').flush(OCTOBER);
      flushError(
        http.expectOne('/api/salary'),
        500,
        'internal_error',
        'The salary table is locked',
      );
      http.expectOne('/api/incomes?month=2026-10').flush(INCOMES);
      await settle(fixture);
      const p = page(fixture, '2026-10');

      const alert = getByRole(pageOf(p.element), 'alert', /salary history/);
      expect(textOf(alert)).toContain("Couldn't load the salary history");
      expect(textOf(alert)).toContain('The salary table is locked');
      // The rest of the page is still there.
      expect(p.text()).toContain('Tax refund');
      expect(p.text()).toContain('Income in October 2026');

      getByRole(alert, 'button', 'Try again').click();
      await settle(fixture);
      http.expectOne('/api/salary').flush(SALARY);
      await settle(fixture);
      expect(queryByRole(pageOf(p.element), 'alert')).toBeNull();
      expect(p.text()).toContain('From September 2026');
    });

    it('says the server cannot be reached when it cannot', async () => {
      await primeStores(http);
      await router.navigateByUrl('/income');
      const fixture = TestBed.createComponent(IncomeHost);
      fixture.detectChanges();
      await settle(fixture);
      http.expectOne('/api/months/2026-10').error(new ProgressEvent('error'));
      http.expectOne('/api/salary').flush(SALARY);
      http.expectOne('/api/incomes?month=2026-10').flush(INCOMES);
      await settle(fixture);

      expect(textOf(getByRole(pageOf(fixture.nativeElement), 'alert'))).toMatch(
        /can't reach the server/i,
      );
    });
  });

  describe('salary', () => {
    it('shows the salary in effect (from the month view) and the history', async () => {
      const p = await open();
      const salary = textOf(p.section('Salary'));

      expect(salary).toContain('In October 2026 your salary is €2,700.00 a month.');
      expect(salary).toContain('From June 2026 €2,500.00 a month');
      expect(salary).toContain('From September 2026 In effect in October 2026 €2,700.00 a month');
    });

    it('marks the entry that covers the selected month, not a later one', async () => {
      const p = await open('2026-07', {
        view: monthView('2026-07', { salary: 250000, extra: 0, total: 250000 }),
        incomes: [],
      });
      const salary = textOf(p.section('Salary'));

      expect(salary).toContain('From June 2026 In effect in July 2026');
      expect(salary).not.toContain('From September 2026 In effect');
    });

    it('invites the user to add the first salary when there is none', async () => {
      const p = await open('2026-10', {
        salary: [],
        view: monthView('2026-10', { salary: 0, extra: 0, total: 0 }),
        incomes: [],
      });

      expect(p.text()).toContain('No salary recorded yet');
      expect(p.text()).toContain('Add your monthly net salary below.');
    });

    describe('add or change', () => {
      it('starts on the selected month and says a change applies from then on, leaving earlier months alone', async () => {
        const p = await open();

        expect((getByLabel(p.element, 'Applies from') as HTMLInputElement).value).toBe('2026-10');
        expect(p.text()).toContain(
          'This salary applies from October 2026 onward. Earlier months are not changed.',
        );
      });

      it('follows the month switcher until the user picks another month', async () => {
        const p = await open();
        await router.navigateByUrl('/income?month=2026-08');
        await settle(p.fixture);
        await answerMonthChange(p.fixture, '2026-08');
        expect((getByLabel(p.element, 'Applies from') as HTMLInputElement).value).toBe('2026-08');

        await p.type('Applies from', '2026-11');
        await router.navigateByUrl('/income?month=2026-07');
        await settle(p.fixture);
        await answerMonthChange(p.fixture, '2026-07');
        expect((getByLabel(p.element, 'Applies from') as HTMLInputElement).value).toBe('2026-11');
      });

      it('saves with PUT /api/salary/:month, then reloads what the page shows', async () => {
        const p = await open();
        await p.type('Applies from', '2026-11');
        await p.type('Monthly net salary', '2900,50');
        expect(p.text()).toContain(
          'This salary applies from November 2026 onward. Earlier months are not changed.',
        );

        await p.press('Save salary');

        const request = http.expectOne('/api/salary/2026-11');
        expect(request.request.method).toBe('PUT');
        expect(request.request.body).toEqual({ amount: 290050 });
        expect(salaryUpsertSchema.safeParse(request.request.body).success).toBe(true);
        request.flush({ effectiveMonth: '2026-11', amount: 290050 });
        await p.reload({ salary: [...SALARY, { effectiveMonth: '2026-11', amount: 290050 }] });

        expect(p.toasts()).toEqual(['Salary saved from November 2026 onward.']);
        expect(textOf(p.section('Salary'))).toContain('From November 2026 €2,900.50 a month');
        // The form is ready for the next change.
        expect((getByLabel(p.element, 'Monthly net salary') as HTMLInputElement).value).toBe('');
        expect((getByLabel(p.element, 'Applies from') as HTMLInputElement).value).toBe('2026-10');
      });

      it('says when a month already has an entry, which saving replaces', async () => {
        const p = await open();
        await p.type('Applies from', '2026-09');

        expect(p.text()).toContain(
          'It replaces the €2,700.00 salary that starts in September 2026.',
        );
        expect(queryByRole(p.element, 'button', 'Save the change')).not.toBeNull();
        expect(p.text()).toContain('Change a salary');
      });

      it('loads an entry into the form with its Change button', async () => {
        const p = await open();

        await p.press('Change the salary from September 2026');

        expect((getByLabel(p.element, 'Applies from') as HTMLInputElement).value).toBe('2026-09');
        expect((getByLabel(p.element, 'Monthly net salary') as HTMLInputElement).value).toBe(
          '2700.00',
        );
        expect(document.activeElement).toBe(getByLabel(p.element, 'Monthly net salary'));

        await p.type('Monthly net salary', '2750');
        await p.press('Save the change');
        const request = http.expectOne('/api/salary/2026-09');
        expect(request.request.body).toEqual({ amount: 275000 });
        request.flush({ effectiveMonth: '2026-09', amount: 275000 });
        await p.reload();
      });

      it('keeps an edited entry in the form when the month switcher moves', async () => {
        const p = await open();
        await p.press('Change the salary from June 2026');
        await router.navigateByUrl('/income?month=2026-12');
        await settle(p.fixture);
        await answerMonthChange(p.fixture, '2026-12');

        expect((getByLabel(p.element, 'Applies from') as HTMLInputElement).value).toBe('2026-06');
      });

      it('needs an amount and a month, and does not call the API without them', async () => {
        const p = await open();
        await p.press('Save salary');

        expect(fieldError(getByLabel(p.element, 'Monthly net salary'))).toBe(
          'Monthly net salary is required.',
        );
        expect(document.activeElement).toBe(getByLabel(p.element, 'Monthly net salary'));

        await p.type('Monthly net salary', '2000');
        await p.type('Applies from', '');
        await p.press('Save salary');
        expect(fieldError(getByLabel(p.element, 'Applies from'))).toBe('Applies from is required.');
        noRequest(/\/api\/salary\//);
      });

      it('does not accept a negative salary', async () => {
        const p = await open();
        await p.type('Monthly net salary', '-1');
        await p.press('Save salary');

        expect(fieldError(getByLabel(p.element, 'Monthly net salary'))).toBe(
          'Enter an amount of zero or more.',
        );
        noRequest(/\/api\/salary\//);
      });

      it('does not accept a month before the start month', async () => {
        const p = await open();
        await p.type('Monthly net salary', '2000');
        await p.type('Applies from', '2026-05');
        await p.press('Save salary');

        expect(fieldError(getByLabel(p.element, 'Applies from'))).toBe(
          'Choose June 2026 or later.',
        );
        noRequest(/\/api\/salary\//);
      });

      it('shows what the API says on the field it names', async () => {
        const p = await open();
        await p.type('Monthly net salary', '2000');
        await p.type('Applies from', '2026-07');
        await p.press('Save salary');

        flushError(
          http.expectOne('/api/salary/2026-07'),
          422,
          'rule_violation',
          'That month is before the start month',
          {
            rule: 'before_start_month',
            field: 'month',
          },
        );
        await settle(p.fixture);

        expect(fieldError(getByLabel(p.element, 'Applies from'))).toBe(
          'That month is before the start month',
        );
        expect(p.toasts()).toEqual([]);
      });

      it('shows an error that belongs to no field in an alert, and keeps what was typed', async () => {
        const p = await open();
        await p.type('Monthly net salary', '2000');
        await p.press('Save salary');
        flushError(
          http.expectOne('/api/salary/2026-10'),
          500,
          'internal_error',
          'Something went wrong on our side',
        );
        await settle(p.fixture);

        expect(textOf(getByRole(p.section('Salary'), 'alert'))).toBe(
          'Something went wrong on our side',
        );
        expect((getByLabel(p.element, 'Monthly net salary') as HTMLInputElement).value).toBe(
          '2000',
        );
      });
    });

    describe('delete', () => {
      it('asks first, saying what will happen, and does nothing when cancelled', async () => {
        const p = await open();

        await p.press('Delete the salary change from September 2026');

        expect(p.dialog().open).toBe(true);
        const dialog = textOf(p.dialog());
        expect(dialog).toContain('Delete this salary change?');
        expect(dialog).toContain(
          'Months from September 2026 on use the previous salary entry instead',
        );
        getByRole(p.dialog(), 'button', 'Cancel').click();
        await settle(p.fixture);

        expect(p.dialog().open).toBe(false);
        noRequest(/\/api\/salary\//);
        expect(p.text()).toContain('From September 2026');
      });

      it('deletes the exact entry once confirmed, then reloads', async () => {
        const p = await open();
        await p.press('Delete the salary change from September 2026');
        getByRole(p.dialog(), 'button', 'Delete salary change').click();
        await settle(p.fixture);

        const request = http.expectOne('/api/salary/2026-09');
        expect(request.request.method).toBe('DELETE');
        request.flush(null, { status: 204, statusText: 'No Content' });
        await p.reload({
          salary: [SALARY[0]],
          view: monthView('2026-10', { salary: 250000, extra: 35000, total: 285000 }),
        });

        expect(p.toasts()).toEqual(['Salary change from September 2026 deleted.']);
        expect(textOf(p.section('Salary'))).not.toContain('From September 2026');
        expect(textOf(p.section('Salary'))).toContain(
          'In October 2026 your salary is €2,500.00 a month.',
        );
        // The row that had focus is gone: focus moves to the section heading.
        expect(document.activeElement).toBe(getByRole(p.element, 'heading', 'Salary'));
      });

      it('reports a failure with the message of the API', async () => {
        const p = await open();
        await p.press('Delete the salary change from June 2026');
        getByRole(p.dialog(), 'button', 'Delete salary change').click();
        await settle(p.fixture);

        flushError(
          http.expectOne('/api/salary/2026-06'),
          404,
          'not_found',
          'No salary entry for 2026-06',
        );
        await settle(p.fixture);

        expect(p.toasts()).toEqual(['No salary entry for 2026-06']);
        expect(p.text()).toContain('From June 2026');
      });
    });
  });

  describe('one-off income', () => {
    it('lists the month newest first with date and a signed amount', async () => {
      const p = await open();
      const section = p.section('One-off income in October 2026');

      expect(textOf(section)).toContain('Birthday money Fri, Oct 2, 2026 +€50.00');
      expect(textOf(section)).toContain('Tax refund Thu, Oct 1, 2026 +€300.00');
      expect(textOf(section).indexOf('Birthday money')).toBeLessThan(
        textOf(section).indexOf('Tax refund'),
      );
    });

    it('says when there is none', async () => {
      const p = await open('2026-10', { incomes: [] });
      expect(p.text()).toContain('No one-off income in October 2026');
    });

    describe('add', () => {
      it('opens a form whose date is today, from the server, inside the selected month', async () => {
        const p = await open();
        await p.press('Add income');

        const date = getByLabel(p.element, 'Date') as HTMLInputElement;
        expect(date.value).toBe('2026-10-02');
        expect(date.getAttribute('min')).toBe('2026-10-01');
        expect(date.getAttribute('max')).toBe('2026-10-31');
        expect(document.activeElement).toBe(getByLabel(p.element, 'Description'));
      });

      it('uses the nearest day of another month: the last of a past one, the first of a future one', async () => {
        const past = await open('2026-08');
        await past.press('Add income');
        expect((getByLabel(past.element, 'Date') as HTMLInputElement).value).toBe('2026-08-31');
        past.fixture.destroy();

        await router.navigateByUrl('/income?month=2026-12');
        const fixture = TestBed.createComponent(IncomeHost);
        fixture.detectChanges();
        await settle(fixture);
        await answer(fixture, '2026-12');
        const future = page(fixture, '2026-12');
        await future.press('Add income');
        expect((getByLabel(future.element, 'Date') as HTMLInputElement).value).toBe('2026-12-01');
      });

      it('posts the income with the date, integer cents and a trimmed description', async () => {
        const p = await open();
        await p.press('Add income');
        await p.type('Description', '  Bonus ');
        await p.type('Amount', '1234,50');
        await p.type('Date', '2026-10-15');

        await p.press('Add income');

        const request = http.expectOne('/api/incomes');
        expect(request.request.method).toBe('POST');
        expect(request.request.body).toEqual({
          date: '2026-10-15',
          amount: 123450,
          description: 'Bonus',
        });
        expect(incomeCreateSchema.safeParse(request.request.body).success).toBe(true);
        request.flush(
          { id: 3, date: '2026-10-15', amount: 123450, description: 'Bonus' },
          { status: 201, statusText: 'Created' },
        );
        await p.reload({
          incomes: [
            { id: 3, date: '2026-10-15', amount: 123450, description: 'Bonus' },
            ...INCOMES,
          ],
          view: monthView('2026-10', { salary: 270000, extra: 158450, total: 428450 }),
        });

        expect(p.toasts()).toEqual(['Income added.']);
        expect(queryByRole(p.element, 'button', 'Cancel')).toBeNull(); // the form closed
        expect(textOf(p.section('One-off income in October 2026'))).toContain(
          'Bonus Thu, Oct 15, 2026 +€1,234.50',
        );
        expect(textOf(p.section('Income in October 2026'))).toContain('Total income €4,284.50');
        expect(document.activeElement).toBe(
          getByRole(p.element, 'heading', 'One-off income in October 2026'),
        );
      });

      it('needs a description, an amount above zero and a date in this month', async () => {
        const p = await open();
        await p.press('Add income');
        await p.press('Add income');
        expect(fieldError(getByLabel(p.element, 'Description'))).toBe('Description is required.');
        expect(fieldError(getByLabel(p.element, 'Amount'))).toBe('Amount is required.');

        await p.type('Description', 'Gift');
        await p.type('Amount', '0');
        await p.type('Date', '2026-09-30');
        await p.press('Add income');

        expect(fieldError(getByLabel(p.element, 'Amount'))).toBe(
          'Enter an amount greater than zero.',
        );
        expect(fieldError(getByLabel(p.element, 'Date'))).toBe('Choose a date in October 2026.');
        http.expectNone('/api/incomes');
      });

      it('limits the description to what the API accepts', async () => {
        const p = await open();
        await p.press('Add income');
        expect(getByLabel(p.element, 'Description').getAttribute('maxlength')).toBe('200');
      });

      it('cancels without a request, and puts focus back on the Add income button', async () => {
        const p = await open();
        await p.press('Add income');
        await p.press('Cancel');

        expect(queryByText(p.element, 'Edit income')).toBeNull();
        expect(document.activeElement).toBe(getByRole(p.element, 'button', 'Add income'));
        http.expectNone('/api/incomes');
      });

      it('shows what the API says on the field it names', async () => {
        const p = await open();
        await p.press('Add income');
        await p.type('Description', 'Gift');
        await p.type('Amount', '10');
        await p.press('Add income');
        flushError(
          http.expectOne('/api/incomes'),
          422,
          'rule_violation',
          'The date is before the start month',
          {
            rule: 'before_start_month',
            field: 'date',
          },
        );
        await settle(p.fixture);

        expect(fieldError(getByLabel(p.element, 'Date'))).toBe(
          'The date is before the start month',
        );
        expect(document.activeElement).toBe(getByLabel(p.element, 'Date'));
        expect(p.toasts()).toEqual([]);
      });

      it('keeps the date inside the month when the month switcher moves while the form is open', async () => {
        const p = await open();
        await p.press('Add income');
        expect((getByLabel(p.element, 'Date') as HTMLInputElement).value).toBe('2026-10-02');

        await router.navigateByUrl('/income?month=2026-09');
        await settle(p.fixture);
        await answerMonthChange(p.fixture, '2026-09');

        expect((getByLabel(p.element, 'Date') as HTMLInputElement).value).toBe('2026-09-30');
        expect(getByLabel(p.element, 'Date').getAttribute('max')).toBe('2026-09-30');
      });
    });

    describe('edit', () => {
      it('edits in place with the values filled in', async () => {
        const p = await open();
        await p.press('Edit Tax refund');

        expect((getByLabel(p.element, 'Description') as HTMLInputElement).value).toBe('Tax refund');
        expect((getByLabel(p.element, 'Amount') as HTMLInputElement).value).toBe('300.00');
        expect((getByLabel(p.element, 'Date') as HTMLInputElement).value).toBe('2026-10-01');
        expect(p.text()).toContain('Edit income');
      });

      it('sends only what changed, with PATCH', async () => {
        const p = await open();
        await p.press('Edit Tax refund');
        await p.type('Amount', '310');

        await p.press('Save changes');

        const request = http.expectOne('/api/incomes/1');
        expect(request.request.method).toBe('PATCH');
        expect(request.request.body).toEqual({ amount: 31000 });
        expect(incomeUpdateSchema.safeParse(request.request.body).success).toBe(true);
        request.flush({ id: 1, date: '2026-10-01', amount: 31000, description: 'Tax refund' });
        await p.reload({ incomes: [INCOMES[0], { ...INCOMES[1], amount: 31000 }] });

        expect(p.toasts()).toEqual(['Income updated.']);
        expect(textOf(p.section('One-off income in October 2026'))).toContain(
          'Tax refund Thu, Oct 1, 2026 +€310.00',
        );
        // Focus returns to the row that was edited.
        expect(document.activeElement).toBe(getByRole(p.element, 'button', 'Edit Tax refund'));
      });

      it('can change the description and the date', async () => {
        const p = await open();
        await p.press('Edit Birthday money');
        await p.type('Description', 'Birthday gift');
        await p.type('Date', '2026-10-09');
        await p.press('Save changes');

        const request = http.expectOne('/api/incomes/2');
        expect(request.request.body).toEqual({ date: '2026-10-09', description: 'Birthday gift' });
        request.flush({ id: 2, date: '2026-10-09', amount: 5000, description: 'Birthday gift' });
        await p.reload();
      });

      it('sends nothing when nothing changed', async () => {
        const p = await open();
        await p.press('Edit Tax refund');
        await p.press('Save changes');

        noRequest(/\/api\/incomes\/\d+/);
        expect(queryByText(p.element, 'Edit income')).toBeNull();
        expect(document.activeElement).toBe(getByRole(p.element, 'button', 'Edit Tax refund'));
      });

      it('cancels an edit without sending anything', async () => {
        const p = await open();
        await p.press('Edit Tax refund');
        await p.type('Amount', '5');
        await p.press('Cancel');

        noRequest(/\/api\/incomes\/\d+/);
        expect(p.text()).toContain('+€300.00');
      });

      it('edits one income at a time, and opening the add form closes an edit', async () => {
        const p = await open();
        await p.press('Edit Tax refund');
        await p.press('Edit Birthday money');
        expect(p.element.querySelectorAll('app-income-form')).toHaveLength(1);
        expect((getByLabel(p.element, 'Description') as HTMLInputElement).value).toBe(
          'Birthday money',
        );

        await p.press('Add income');
        expect(p.element.querySelectorAll('app-income-form')).toHaveLength(1);
        expect((getByLabel(p.element, 'Description') as HTMLInputElement).value).toBe('');
      });
    });

    describe('delete', () => {
      it('asks first, naming the income, and does nothing when cancelled', async () => {
        const p = await open();
        await p.press('Delete Tax refund');

        const dialog = textOf(p.dialog());
        expect(dialog).toContain('Delete this income?');
        expect(dialog).toContain(
          '"Tax refund" (€300.00, Thu, Oct 1, 2026) will no longer count towards the income of October 2026.',
        );
        getByRole(p.dialog(), 'button', 'Cancel').click();
        await settle(p.fixture);

        noRequest(/\/api\/incomes\/\d+/);
        expect(p.text()).toContain('Tax refund');
      });

      it('deletes once confirmed, then reloads', async () => {
        const p = await open();
        await p.press('Delete Tax refund');
        getByRole(p.dialog(), 'button', 'Delete income').click();
        await settle(p.fixture);

        const request = http.expectOne('/api/incomes/1');
        expect(request.request.method).toBe('DELETE');
        request.flush(null, { status: 204, statusText: 'No Content' });
        await p.reload({
          incomes: [INCOMES[0]],
          view: monthView('2026-10', { salary: 270000, extra: 5000, total: 275000 }),
        });

        expect(p.toasts()).toEqual(['Income deleted.']);
        expect(p.text()).not.toContain('Tax refund');
        expect(textOf(p.section('Income in October 2026'))).toContain('One-off income €50.00');
        expect(document.activeElement).toBe(
          getByRole(p.element, 'heading', 'One-off income in October 2026'),
        );
      });

      it('reports a failure with the message of the API', async () => {
        const p = await open();
        await p.press('Delete Tax refund');
        getByRole(p.dialog(), 'button', 'Delete income').click();
        await settle(p.fixture);
        flushError(http.expectOne('/api/incomes/1'), 404, 'not_found', 'Income 1 not found');
        await settle(p.fixture);

        expect(p.toasts()).toEqual(['Income 1 not found']);
      });
    });
  });

  describe('changing month', () => {
    it('loads the other month: its totals and its incomes', async () => {
      const p = await open();
      await router.navigateByUrl('/income?month=2026-09');
      await settle(p.fixture);

      http
        .expectOne('/api/months/2026-09')
        .flush(monthView('2026-09', { salary: 270000, extra: 1000, total: 271000 }, 'closed'));
      http
        .expectOne('/api/incomes?month=2026-09')
        .flush([{ id: 9, date: '2026-09-12', amount: 1000, description: 'Sold a bike' }]);
      await settle(p.fixture);

      expect(p.text()).toContain('Income in September 2026');
      expect(p.text()).toContain('Sold a bike');
      expect(p.text()).not.toContain('Tax refund');
      expect(p.text()).toContain('One-off income in September 2026');
    });

    it('uses the currency and locale of the settings for every amount', async () => {
      await primeStores(http, { settings: { ...SETTINGS, currency: 'USD', locale: 'it-IT' } });
      await router.navigateByUrl('/income');
      const fixture = TestBed.createComponent(IncomeHost);
      fixture.detectChanges();
      await settle(fixture);
      await answer(fixture, '2026-10');

      const text = textOf(fixture.nativeElement).replace(/ /g, ' ');
      expect(text).toContain('Salary 2700,00 USD');
      expect(text).toContain('+50,00 USD');
      expect(text).toContain('ottobre 2026');
    });
  });
});
