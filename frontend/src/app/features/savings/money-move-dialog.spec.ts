import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { SavingsDto } from '@wallet/shared';
import { fieldError, getByLabel, getByRole, textOf, typeInto } from '../../../testing/dom';
import { goalDto, savingsDto } from '../../../testing/fixtures';
import { flushError, settle } from '../../../testing/harness';
import { menuItemNames } from '../../../testing/menu';
import { openSavingsPage } from '../../../testing/savings-harness';

const HOLIDAY = goalDto({ id: 1, name: 'Holiday', balance: 35000, targetAmount: 100000 });
const CAR = goalDto({ id: 2, name: 'Car', balance: 0, targetAmount: 500000 });
const OLD = goalDto({ id: 3, name: 'Old laptop', archived: true, balance: 5000 });

const OVERVIEW = savingsDto({ unassigned: 10000, goals: [HOLIDAY, CAR, OLD] });

describe('moving money by hand', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const open = (savings: SavingsDto = OVERVIEW) => openSavingsPage(http, { savings });
  type Page = Awaited<ReturnType<typeof open>>;
  const dialog = (p: Page) => p.dialog('app-money-move-dialog') as HTMLElement;
  /** Opens a dialog from the buttons under the balance. */
  const start = async (p: Page, name: 'Deposit' | 'Withdraw' | 'Reallocate') => {
    await p.press(name, p.region('Your savings'));
    return dialog(p);
  };
  const optionsOf = (form: HTMLElement, label: string) =>
    Array.from(getByLabel<HTMLSelectElement>(form, label).options).map((option) => textOf(option));
  const choose = async (p: Page, form: HTMLElement, label: string, value: string) => {
    typeInto(getByLabel<HTMLSelectElement>(form, label), value);
    await settle(p.fixture);
  };
  const created = { status: 201, statusText: 'Created' };
  const TRANSACTIONS = '/api/savings/transactions';

  describe('deposit', () => {
    it('opens with today from the server, and offers unassigned savings and each goal in use with its balance', async () => {
      const p = await open();

      const form = await start(p, 'Deposit');

      expect(textOf(getByRole(form, 'heading', 'Deposit'))).toBe('Deposit');
      expect(p.value('Date', form)).toBe('2026-10-02');
      expect(p.value('Amount', form)).toBe('');
      expect(optionsOf(form, 'Deposit into')).toEqual([
        'Unassigned savings · €100.00',
        'Holiday · €350.00',
        'Car · €0.00',
      ]);
      expect(p.value('Deposit into', form)).toBe('unassigned');
    });

    it('does not offer an archived goal: it takes no new money, and the API says goal_archived', async () => {
      const p = await open();

      const form = await start(p, 'Deposit');

      expect(optionsOf(form, 'Deposit into').join()).not.toContain('Old laptop');
    });

    it('shows goal_archived on the picker when the goal was archived since the page loaded, and offers the goals as they are now', async () => {
      const p = await open();
      const form = await start(p, 'Deposit');
      await choose(p, form, 'Deposit into', '2');
      await p.type('Amount', '10', form);
      await p.press('Deposit', form);

      flushError(http.expectOne(TRANSACTIONS), 422, 'rule_violation', 'Goal 2 is archived', {
        rule: 'goal_archived',
        field: 'goalId',
      });
      await p.reload({
        savings: savingsDto({
          unassigned: 10000,
          goals: [HOLIDAY, { ...CAR, archived: true, status: 'archived' }],
        }),
      });

      expect(fieldError(getByLabel(form, 'Deposit into'))).toBe('Goal 2 is archived');
      expect(optionsOf(form, 'Deposit into').join()).not.toContain('Car');
    });

    it('limits the date to the days from the start month to today', async () => {
      const p = await open();

      const form = await start(p, 'Deposit');

      const date = getByLabel(form, 'Date');
      expect(date.getAttribute('min')).toBe('2026-06-01');
      expect(date.getAttribute('max')).toBe('2026-10-02');
    });

    it('sends the amount, the goal and the date, then reloads and confirms', async () => {
      const p = await open();
      const form = await start(p, 'Deposit');
      await choose(p, form, 'Deposit into', '1');
      await p.type('Amount', '50', form);

      await p.press('Deposit', form);

      const request = http.expectOne(TRANSACTIONS);
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        kind: 'deposit',
        amount: 5000,
        goalId: 1,
        date: '2026-10-02',
      });
      request.flush([{ id: 5, kind: 'deposit', amount: 5000, goalId: 1 }], created);
      await p.reload({
        savings: savingsDto({ unassigned: 10000, goals: [{ ...HOLIDAY, balance: 40000 }] }),
      });

      expect(p.toasts()).toEqual(['Deposited €50.00 into Holiday.']);
      expect(p.dialog('app-money-move-dialog')).toBeNull();
      expect(p.regionText('Your savings')).toContain('Savings balance');
    });

    it('sends unassigned savings as no goal, with the note and a chosen date', async () => {
      const p = await open();
      const form = await start(p, 'Deposit');
      await p.type('Amount', '12,50', form);
      await p.type('Date', '2026-09-20', form);
      await p.type(/^Note/, '  Birthday money ', form);

      await p.press('Deposit', form);

      expect(http.expectOne(TRANSACTIONS).request.body).toEqual({
        kind: 'deposit',
        amount: 1250,
        goalId: null,
        date: '2026-09-20',
        note: 'Birthday money',
      });
    });

    it('starts on the goal whose card asked for it', async () => {
      const p = await open();

      await p.press('Deposit to Car', getByRole(p.element, 'article', 'Car'));

      expect(p.value('Deposit into', dialog(p))).toBe('2');
    });

    it('does not send without an amount, or with one that is not above zero', async () => {
      const p = await open();
      const form = await start(p, 'Deposit');

      await p.press('Deposit', form);
      expect(fieldError(getByLabel(form, 'Amount'))).toBe('Amount is required.');

      await p.type('Amount', '0', form);
      await p.press('Deposit', form);
      expect(fieldError(getByLabel(form, 'Amount'))).toBe('Enter an amount greater than zero.');
      expect(document.activeElement).toBe(getByLabel(form, 'Amount'));
      http.expectNone(TRANSACTIONS);
    });

    it('does not accept a date in the future', async () => {
      const p = await open();
      const form = await start(p, 'Deposit');
      await p.type('Amount', '10', form);
      await p.type('Date', '2026-10-03', form);

      await p.press('Deposit', form);

      expect(fieldError(getByLabel(form, 'Date'))).toBe("The date can't be in the future.");
      http.expectNone(TRANSACTIONS);
    });

    it('does not accept a date before the start month', async () => {
      const p = await open();
      const form = await start(p, 'Deposit');
      await p.type('Amount', '10', form);
      await p.type('Date', '2026-05-31', form);

      await p.press('Deposit', form);

      expect(fieldError(getByLabel(form, 'Date'))).toBe(
        "The date can't be before the start month (Jun 1, 2026).",
      );
      http.expectNone(TRANSACTIONS);
    });

    it('shows a rule the API broke on its field and keeps what was typed', async () => {
      const p = await open();
      const form = await start(p, 'Deposit');
      await p.type('Amount', '10', form);
      await p.press('Deposit', form);

      flushError(
        http.expectOne(TRANSACTIONS),
        422,
        'rule_violation',
        'That date is in the future',
        {
          rule: 'date_in_future',
          field: 'date',
        },
      );
      await settle(p.fixture);

      expect(fieldError(getByLabel(form, 'Date'))).toBe('That date is in the future');
      expect(p.value('Amount', form)).toBe('10.00');
      expect(p.dialog('app-money-move-dialog')).not.toBeNull();
    });

    it('closes without a request when cancelled', async () => {
      const p = await open();
      const form = await start(p, 'Deposit');

      await p.press('Cancel', form);

      expect(p.dialog('app-money-move-dialog')).toBeNull();
      http.expectNone(TRANSACTIONS);
    });
  });

  describe('withdraw', () => {
    it('says what the chosen place holds', async () => {
      const p = await open();
      const form = await start(p, 'Withdraw');
      expect(textOf(form)).toContain('Unassigned savings holds €100.00.');

      await choose(p, form, 'Withdraw from', '1');

      expect(textOf(form)).toContain('Holiday holds €350.00.');
    });

    it('sends a positive amount: the API stores a withdrawal as negative', async () => {
      const p = await open();
      const form = await start(p, 'Withdraw');
      await choose(p, form, 'Withdraw from', '1');
      await p.type('Amount', '120,40', form);

      await p.press('Withdraw', form);

      const request = http.expectOne(TRANSACTIONS);
      expect(request.request.body).toEqual({
        kind: 'withdrawal',
        amount: 12040,
        goalId: 1,
        date: '2026-10-02',
      });
      request.flush([], created);
      await p.reload({ savings: OVERVIEW });
      expect(p.toasts()).toEqual(['Withdrew €120.40 from Holiday.']);
    });

    it('can take everything a place holds, to the cent', async () => {
      const p = await open();
      const form = await start(p, 'Withdraw');
      await choose(p, form, 'Withdraw from', '1');
      await p.type('Amount', '350', form);

      await p.press('Withdraw', form);

      expect(http.expectOne(TRANSACTIONS).request.body).toMatchObject({ amount: 35000, goalId: 1 });
    });

    it('does not let the user take more than the place holds', async () => {
      const p = await open();
      const form = await start(p, 'Withdraw');
      await choose(p, form, 'Withdraw from', '1');
      await p.type('Amount', '350,01', form);

      await p.press('Withdraw', form);

      expect(fieldError(getByLabel(form, 'Amount'))).toBe('Holiday holds only €350.00.');
      expect(document.activeElement).toBe(getByLabel(form, 'Amount'));
      http.expectNone(TRANSACTIONS);
    });

    it('checks the amount again when another place is chosen', async () => {
      const p = await open();
      const form = await start(p, 'Withdraw');
      await choose(p, form, 'Withdraw from', '1');
      await p.type('Amount', '200', form);
      await p.press('Withdraw', form);
      http.expectOne(TRANSACTIONS).flush([], created);
      await p.reload({ savings: OVERVIEW });

      // A second attempt, from a place that holds less.
      const again = await start(p, 'Withdraw');
      await p.type('Amount', '200', again);
      await p.press('Withdraw', again);

      expect(fieldError(getByLabel(again, 'Amount'))).toBe(
        'Unassigned savings holds only €100.00.',
      );
      await choose(p, again, 'Withdraw from', '1');
      expect(fieldError(getByLabel(again, 'Amount'))).toBe('');
    });

    it('offers an archived goal as a source: the money left in it is never frozen', async () => {
      const p = await open();
      const form = await start(p, 'Withdraw');

      expect(optionsOf(form, 'Withdraw from')).toEqual([
        'Unassigned savings · €100.00',
        'Holiday · €350.00',
        'Car · €0.00',
        'Old laptop (archived) · €50.00',
      ]);
      await choose(p, form, 'Withdraw from', '3');
      expect(textOf(form)).toContain('Old laptop (archived) holds €50.00.');
      await p.type('Amount', '20', form);

      await p.press('Withdraw', form);

      const request = http.expectOne(TRANSACTIONS);
      expect(request.request.body).toEqual({
        kind: 'withdrawal',
        amount: 2000,
        goalId: 3,
        date: '2026-10-02',
      });
      request.flush([], created);
      await p.reload({ savings: OVERVIEW });
      expect(p.toasts()).toEqual(['Withdrew €20.00 from Old laptop (archived).']);
    });

    it('still blocks taking more than an archived goal holds', async () => {
      const p = await open();
      const form = await start(p, 'Withdraw');
      await choose(p, form, 'Withdraw from', '3');
      await p.type('Amount', '50,01', form);

      await p.press('Withdraw', form);

      expect(fieldError(getByLabel(form, 'Amount'))).toBe(
        'Old laptop (archived) holds only €50.00.',
      );
      http.expectNone(TRANSACTIONS);
    });

    it('says there is nothing to take from a place that holds nothing, or less than nothing', async () => {
      const p = await open(savingsDto({ unassigned: -2000, goals: [CAR] }));
      const form = await start(p, 'Withdraw');
      expect(textOf(form)).toContain(
        'Unassigned savings holds -€20.00: there is nothing to take from it.',
      );
      await p.type('Amount', '1', form);

      await p.press('Withdraw', form);

      expect(fieldError(getByLabel(form, 'Amount'))).toBe(
        'Unassigned savings has nothing to take.',
      );
      http.expectNone(TRANSACTIONS);
    });

    it('shows insufficient_balance on the amount when the balance moved since the page loaded, and shows the current balances', async () => {
      const p = await open();
      const form = await start(p, 'Withdraw');
      await choose(p, form, 'Withdraw from', '1');
      await p.type('Amount', '300', form);
      await p.press('Withdraw', form);

      flushError(
        http.expectOne(TRANSACTIONS),
        422,
        'rule_violation',
        'The source holds 10000 cents, which is less than the 30000 cents to take out',
        { rule: 'insufficient_balance', field: 'amount' },
      );
      // The dialog asks the page to load the balances again.
      await p.reload({
        savings: savingsDto({ unassigned: 10000, goals: [{ ...HOLIDAY, balance: 10000 }, CAR] }),
      });

      // Said in money, not in the cents of the API's own message.
      expect(fieldError(getByLabel(form, 'Amount'))).toBe(
        'Holiday no longer holds €300.00. Its current balance is shown below.',
      );
      expect(p.dialog('app-money-move-dialog')).not.toBeNull();
      expect(textOf(form)).toContain('Holiday holds €100.00.');
    });
  });

  describe('reallocate', () => {
    it('offers it with a goal, from unassigned savings to the first goal', async () => {
      const p = await open();

      const form = await start(p, 'Reallocate');

      expect(textOf(getByRole(form, 'heading', 'Reallocate'))).toBe('Reallocate');
      expect(textOf(form)).toContain('Your savings balance does not change.');
      expect(p.value('Move from', form)).toBe('unassigned');
      expect(p.value('Move to', form)).toBe('1');
    });

    it('offers an archived goal as a source but never as a destination: it takes no new money', async () => {
      const p = await open();

      const form = await start(p, 'Reallocate');

      expect(optionsOf(form, 'Move from')).toEqual([
        'Unassigned savings · €100.00',
        'Holiday · €350.00',
        'Car · €0.00',
        'Old laptop (archived) · €50.00',
      ]);
      expect(optionsOf(form, 'Move to')).toEqual([
        'Unassigned savings · €100.00',
        'Holiday · €350.00',
        'Car · €0.00',
      ]);
    });

    it('moves the money left in an archived goal to unassigned savings', async () => {
      const p = await open();
      const form = await start(p, 'Reallocate');
      await choose(p, form, 'Move from', '3');
      await choose(p, form, 'Move to', 'unassigned');
      await p.type('Amount', '50', form);

      await p.press('Reallocate', form);

      const request = http.expectOne(TRANSACTIONS);
      expect(request.request.body).toEqual({
        kind: 'reallocation',
        amount: 5000,
        fromGoalId: 3,
        toGoalId: null,
        date: '2026-10-02',
      });
      request.flush([], created);
      await p.reload({ savings: OVERVIEW });
      expect(p.toasts()).toEqual([
        'Moved €50.00 from Old laptop (archived) to Unassigned savings.',
      ]);
    });

    it('starts from the archived goal, towards unassigned savings, when every goal is archived', async () => {
      const p = await open(savingsDto({ unassigned: 10000, goals: [OLD] }));

      const form = await start(p, 'Reallocate');

      expect(p.value('Move from', form)).toBe('3');
      expect(p.value('Move to', form)).toBe('unassigned');
    });

    it('does not let the user move more than an archived goal holds', async () => {
      const p = await open();
      const form = await start(p, 'Reallocate');
      await choose(p, form, 'Move from', '3');
      await choose(p, form, 'Move to', 'unassigned');
      await p.type('Amount', '50,01', form);

      await p.press('Reallocate', form);

      expect(fieldError(getByLabel(form, 'Amount'))).toBe(
        'Old laptop (archived) holds only €50.00.',
      );
      http.expectNone(TRANSACTIONS);
    });

    it('sends the source, the destination and a positive amount', async () => {
      const p = await open();
      const form = await start(p, 'Reallocate');
      await choose(p, form, 'Move from', '1');
      await choose(p, form, 'Move to', 'unassigned');
      await p.type('Amount', '50', form);
      await p.type(/^Note/, 'Car first', form);

      await p.press('Reallocate', form);

      const request = http.expectOne(TRANSACTIONS);
      expect(request.request.body).toEqual({
        kind: 'reallocation',
        amount: 5000,
        fromGoalId: 1,
        toGoalId: null,
        date: '2026-10-02',
        note: 'Car first',
      });
      request.flush([], created);
      await p.reload({ savings: OVERVIEW });

      expect(p.toasts()).toEqual(['Moved €50.00 from Holiday to Unassigned savings.']);
    });

    it('sends unassigned savings as the source as null', async () => {
      const p = await open();
      const form = await start(p, 'Reallocate');
      await choose(p, form, 'Move to', '2');
      await p.type('Amount', '100', form);

      await p.press('Reallocate', form);

      expect(http.expectOne(TRANSACTIONS).request.body).toMatchObject({
        kind: 'reallocation',
        fromGoalId: null,
        toGoalId: 2,
        amount: 10000,
      });
    });

    it('does not move money from a place to itself', async () => {
      const p = await open();
      const form = await start(p, 'Reallocate');
      await choose(p, form, 'Move to', 'unassigned');
      await p.type('Amount', '10', form);

      await p.press('Reallocate', form);

      expect(fieldError(getByLabel(form, 'Move to'))).toBe(
        'Choose two different places to move the money between.',
      );
      http.expectNone(TRANSACTIONS);
    });

    it('checks the two places again when the source changes', async () => {
      const p = await open();
      const form = await start(p, 'Reallocate');
      await p.type('Amount', '10', form);
      await choose(p, form, 'Move from', '1');
      await choose(p, form, 'Move to', '1');
      await p.press('Reallocate', form);
      expect(fieldError(getByLabel(form, 'Move to'))).not.toBe('');

      await choose(p, form, 'Move from', 'unassigned');

      expect(fieldError(getByLabel(form, 'Move to'))).toBe('');
    });

    it('does not let the user move more than the source holds', async () => {
      const p = await open();
      const form = await start(p, 'Reallocate');
      await choose(p, form, 'Move from', '1');
      await choose(p, form, 'Move to', '2');
      expect(textOf(form)).toContain('Holiday holds €350.00.');
      await p.type('Amount', '350,01', form);

      await p.press('Reallocate', form);

      expect(fieldError(getByLabel(form, 'Amount'))).toBe('Holiday holds only €350.00.');
      http.expectNone(TRANSACTIONS);
    });

    it('says in money, on the amount, that the source no longer holds it', async () => {
      const p = await open();
      const form = await start(p, 'Reallocate');
      await choose(p, form, 'Move from', '1');
      await choose(p, form, 'Move to', '2');
      await p.type('Amount', '350', form);
      await p.press('Reallocate', form);

      flushError(
        http.expectOne(TRANSACTIONS),
        422,
        'rule_violation',
        'The source holds 1 cents, ...',
        {
          rule: 'insufficient_balance',
          field: 'amount',
        },
      );
      await p.reload({
        savings: savingsDto({ unassigned: 10000, goals: [{ ...HOLIDAY, balance: 100 }, CAR] }),
      });

      expect(fieldError(getByLabel(form, 'Amount'))).toBe(
        'Holiday no longer holds €350.00. Its current balance is shown below.',
      );
      expect(textOf(form)).toContain('Holiday holds €1.00.');
    });

    it('shows a goal that was archived meanwhile on the picker the API names, and loads the goals again', async () => {
      const p = await open();
      const form = await start(p, 'Reallocate');
      await choose(p, form, 'Move to', '2');
      await p.type('Amount', '10', form);
      await p.press('Reallocate', form);

      flushError(http.expectOne(TRANSACTIONS), 422, 'rule_violation', 'Goal 2 is archived', {
        rule: 'goal_archived',
        field: 'toGoalId',
      });
      await p.reload({
        savings: savingsDto({
          unassigned: 10000,
          goals: [HOLIDAY, { ...CAR, archived: true, status: 'archived' }],
        }),
      });

      expect(fieldError(getByLabel(form, 'Move to'))).toBe('Goal 2 is archived');
      // The picker follows the goals as they are now.
      expect(optionsOf(form, 'Move to').join()).not.toContain('Car');
    });
  });

  describe('withdraw from a goal card', () => {
    it('starts on that goal', async () => {
      const p = await open();

      await p.menuAction('More actions for Holiday', 'Withdraw');

      expect(p.value('Withdraw from', dialog(p))).toBe('1');
      expect(textOf(dialog(p))).toContain('Holiday holds €350.00.');
    });

    it('is offered for an archived goal that still holds money, and starts on it', async () => {
      const p = await open();

      await p.menuAction('More actions for Old laptop', 'Withdraw');

      expect(p.value('Withdraw from', dialog(p))).toBe('3');
      expect(textOf(dialog(p))).toContain('Old laptop (archived) holds €50.00.');
    });

    it('moves the money of an archived goal with Reallocate, starting from it', async () => {
      const p = await open();

      await p.menuAction('More actions for Old laptop', 'Reallocate');

      expect(textOf(getByRole(dialog(p), 'heading', 'Reallocate'))).toBe('Reallocate');
      expect(p.value('Move from', dialog(p))).toBe('3');
      expect(p.value('Move to', dialog(p))).toBe('unassigned');
    });

    it('is not offered for an archived goal that holds nothing', async () => {
      const p = await open(savingsDto({ goals: [{ ...OLD, balance: 0 }] }));

      expect(menuItemNames(getByRole(p.element, 'article', 'Old laptop'))).toEqual([
        'Edit',
        'Unarchive',
        'Delete',
      ]);
    });
  });
});
