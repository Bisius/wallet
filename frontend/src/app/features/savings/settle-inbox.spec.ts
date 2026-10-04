import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { SavingsDto } from '@wallet/shared';
import {
  getAllByLabel,
  getByLabel,
  getByRole,
  queryAllByRole,
  queryByRole,
  textOf,
} from '../../../testing/dom';
import { goalDto, outstandingMonth, savingsDto } from '../../../testing/fixtures';
import { flushError, settle } from '../../../testing/harness';
import { openSavingsPage } from '../../../testing/savings-harness';
import { SavingsStore } from '../../core/savings.store';
import { ToastService } from '../../shared/ui/toast.service';

const AUGUST = outstandingMonth({
  month: '2026-08',
  savingsDue: 31240,
  breakdown: { unallocated: 10000, budgetsSettled: 20240, reservesReleased: 1000 },
});
const SEPTEMBER_TAKE = outstandingMonth({
  month: '2026-09',
  savingsDue: -8500,
  breakdown: { unallocated: -10000, budgetsSettled: 1500, reservesReleased: 0 },
});

const HOLIDAY = goalDto({ id: 1, name: 'Holiday', balance: 30000, targetAmount: 100000 });
const CAR = goalDto({ id: 2, name: 'Car', balance: 0, targetAmount: 500000 });
const OLD = goalDto({ id: 3, name: 'Old laptop', archived: true, balance: 5000 });

describe('the Move to savings inbox', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const open = (savings: SavingsDto) => openSavingsPage(http, { savings });
  const inbox = (p: Awaited<ReturnType<typeof open>>) => p.region('Move to savings');
  const rows = (p: Awaited<ReturnType<typeof open>>) =>
    queryAllByRole(inbox(p), 'listitem').filter((li) => li.parentElement?.tagName === 'UL');
  /** The breakdown of the first row (the section has a "How this works" disclosure of its own). */
  const breakdown = (p: Awaited<ReturnType<typeof open>>) =>
    rows(p)[0].querySelector('details') as HTMLDetailsElement;

  describe('the rows', () => {
    it('says all months are settled when nothing is outstanding', async () => {
      const p = await open(savingsDto());

      expect(textOf(inbox(p))).toContain('All months are settled');
      expect(queryAllByRole(inbox(p), 'button')).toEqual([]);
    });

    it('lists one row per month, oldest first, with the words move and take', async () => {
      const p = await open(
        savingsDto({
          unassigned: 100000,
          outstanding: [AUGUST, SEPTEMBER_TAKE],
        }),
      );

      expect(rows(p).map((row) => textOf(row).split(' See the breakdown')[0])).toEqual([
        expect.stringContaining('August 2026: move €312.40 to savings'),
        expect.stringContaining('September 2026: take €85.00 from savings'),
      ]);
      expect(textOf(inbox(p))).toContain('2 months to settle. In total: move €227.40 to savings.');
    });

    it('keeps the long explanation behind "How this works", and the line under the title short', async () => {
      const p = await open(savingsDto({ outstanding: [AUGUST] }));

      const help = inbox(p).querySelector('details') as HTMLDetailsElement;
      expect(textOf(help.querySelector('summary') as Element)).toBe('How this works');
      expect(help.open).toBe(false);
      expect(textOf(help)).toContain('Move the money in your bank, then mark the month done here.');
      // The line under the title says how many months there are, and what they come to.
      expect(textOf(inbox(p).querySelector('h2 + p') as Element)).toBe(
        '1 month to settle. In total: move €312.40 to savings.',
      );
    });

    it('says what the months come to when they cancel each other out', async () => {
      const p = await open(
        savingsDto({
          outstanding: [
            outstandingMonth({ month: '2026-08', savingsDue: 5000 }),
            outstandingMonth({ month: '2026-09', savingsDue: -5000 }),
          ],
        }),
      );

      expect(textOf(inbox(p))).toContain('In total: the months cancel each other out.');
    });

    it('shows the total as the API gave it, not as the rows add up', async () => {
      const p = await open(
        savingsDto({ outstanding: [AUGUST, SEPTEMBER_TAKE], outstandingTotal: 99900 }),
      );

      expect(textOf(inbox(p))).toContain('In total: move €999.00 to savings.');
    });

    it('marks a correction of an earlier settlement and says what happened', async () => {
      const p = await open(
        savingsDto({
          outstanding: [
            outstandingMonth({ month: '2026-08', savingsDue: 31240, settled: 30000 }),
            outstandingMonth({ month: '2026-09', savingsDue: 9000, settled: 10000 }),
          ],
        }),
      );

      const [more, back] = rows(p).map((row) => textOf(row));
      expect(more).toContain('August 2026: move €12.40 more to savings');
      expect(more).toContain('Correction');
      expect(more).toContain('You settled this month before');
      // It is a message of the row (an alert with a title), not a label among its details.
      expect(textOf(rows(p)[0].querySelector('app-alert') as Element)).toMatch(
        /^Correction You settled this month before/,
      );
      expect(back).toContain('September 2026: take €10.00 more from savings');
      expect(back).toContain('Correction');
    });

    it('does not call a first settlement a correction', async () => {
      const p = await open(savingsDto({ outstanding: [AUGUST] }));

      expect(textOf(inbox(p))).not.toContain('Correction');
    });

    it('keeps the breakdown folded away, with what the month is made of when it is opened', async () => {
      const p = await open(savingsDto({ outstanding: [AUGUST] }));
      const details = breakdown(p);

      expect(details.open).toBe(false);
      expect(textOf(details.querySelector('summary') as Element)).toBe(
        'See the breakdown for August 2026',
      );
      const text = textOf(details);
      expect(text).toMatch(/Unallocated income .*\+€100\.00/);
      expect(text).toMatch(/Budgets settled .*\+€202\.40/);
      expect(text).toMatch(/Reserves released .*\+€10\.00/);
      expect(text).toContain('Due for the month +€312.40');
      expect(text).toContain('To move now +€312.40');
      expect(text).not.toContain('Already settled');
    });

    it('shows a negative breakdown with its minus signs, and what was already settled in a correction', async () => {
      const p = await open(
        savingsDto({
          outstanding: [
            outstandingMonth({
              month: '2026-09',
              savingsDue: -8500,
              settled: -5000,
              breakdown: { unallocated: -10000, budgetsSettled: 1500, reservesReleased: 0 },
            }),
          ],
        }),
      );

      const text = textOf(breakdown(p));
      expect(text).toMatch(/Unallocated income .*-€100\.00/);
      expect(text).toMatch(/Budgets settled .*\+€15\.00/);
      expect(text).toContain('Due for the month -€85.00');
      expect(text).toContain('Already settled -€50.00');
      expect(text).toContain('To take now -€35.00');
    });
  });

  describe('Done', () => {
    it('sends only the amount the row shows, then reloads and says what was recorded', async () => {
      const p = await open(savingsDto({ outstanding: [AUGUST] }));

      await p.press('Mark August 2026 as done');

      const request = http.expectOne('/api/savings/settle/2026-08');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ amount: 31240 });
      request.flush([{ id: 9, date: '2026-10-02', kind: 'settlement', amount: 31240 }], {
        status: 201,
        statusText: 'Created',
      });
      await p.reload({ savings: savingsDto({ unassigned: 31240 }) });

      expect(p.toasts()).toEqual(['August 2026 is done: €312.40 moved to savings.']);
      expect(textOf(inbox(p))).toContain('All months are settled');
    });

    it('sends a negative amount for a month that takes money from savings', async () => {
      const p = await open(savingsDto({ outstanding: [SEPTEMBER_TAKE] }));

      await p.press('Mark September 2026 as done');

      const request = http.expectOne('/api/savings/settle/2026-09');
      expect(request.request.body).toEqual({ amount: -8500 });
      request.flush([], { status: 201, statusText: 'Created' });
      await p.reload({ savings: savingsDto() });

      expect(p.toasts()).toEqual(['September 2026 is done: €85.00 taken from savings.']);
    });

    it('shows that it is sending and cannot be sent twice', async () => {
      const p = await open(savingsDto({ outstanding: [AUGUST, SEPTEMBER_TAKE] }));
      const done = getByRole(inbox(p), 'button', 'Mark August 2026 as done') as HTMLButtonElement;

      done.click();
      await settle(p.fixture);

      expect(done.disabled).toBe(true);
      expect(done.getAttribute('aria-busy')).toBe('true');
      // Nothing else on the page can be settled meanwhile.
      expect(
        (getByRole(inbox(p), 'button', 'Mark September 2026 as done') as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      done.click();
      await settle(p.fixture);
      http
        .expectOne('/api/savings/settle/2026-08')
        .flush([], { status: 201, statusText: 'Created' });
      await p.reload({ savings: savingsDto({ outstanding: [SEPTEMBER_TAKE] }) });
    });

    it('moves focus to the heading of the inbox when the row it was on is gone', async () => {
      const p = await open(savingsDto({ outstanding: [AUGUST] }));
      await p.press('Mark August 2026 as done');
      http
        .expectOne('/api/savings/settle/2026-08')
        .flush([], { status: 201, statusText: 'Created' });
      await p.reload({ savings: savingsDto() });

      expect(document.activeElement).toBe(getByRole(inbox(p), 'heading', 'Move to savings'));
    });
  });

  describe('Undo', () => {
    const settleAugust = async (p: Awaited<ReturnType<typeof open>>) => {
      await p.press('Mark August 2026 as done');
      http
        .expectOne('/api/savings/settle/2026-08')
        .flush([], { status: 201, statusText: 'Created' });
      await p.reload({ savings: savingsDto({ unassigned: 31240 }) });
    };

    it('is offered on the toast after Done, and brings the month back', async () => {
      const p = await open(savingsDto({ outstanding: [AUGUST] }));
      await settleAugust(p);
      expect(TestBed.inject(ToastService).toasts()[0].action?.label).toBe('Undo');
      await settle(p.fixture);

      await p.press('Undo', getByRole(p.element, 'status', /August 2026 is done/).parentElement!);

      const request = http.expectOne('/api/savings/settle/2026-08');
      expect(request.request.method).toBe('DELETE');
      request.flush(null, { status: 204, statusText: 'No Content' });
      await p.reload({ savings: savingsDto({ outstanding: [AUGUST] }) });

      expect(p.toasts()).toContain(
        'Settlement of August 2026 undone. The month is back in the list.',
      );
      expect(textOf(inbox(p))).toContain('August 2026: move €312.40 to savings');
    });

    it('says so when there was nothing left to undo', async () => {
      const p = await open(savingsDto({ outstanding: [AUGUST] }));
      await settleAugust(p);

      await p.press('Undo', p.element.querySelector('app-toast-container') as HTMLElement);
      flushError(
        http.expectOne('/api/savings/settle/2026-08'),
        404,
        'not_found',
        'No settlement for 2026-08',
      );
      await p.reload({ savings: savingsDto() });

      expect(p.toasts()).toContain(
        'August 2026 has no settlement to undo. It may already have been undone.',
      );
    });

    it('is not offered for a correction: undoing would also remove the earlier settlement', async () => {
      const correction = outstandingMonth({ month: '2026-08', savingsDue: 31240, settled: 30000 });
      const p = await open(savingsDto({ outstanding: [correction] }));

      await p.press('Mark August 2026 as done');
      http
        .expectOne('/api/savings/settle/2026-08')
        .flush([], { status: 201, statusText: 'Created' });
      await p.reload({ savings: savingsDto() });

      const [toast] = TestBed.inject(ToastService).toasts();
      expect(toast.message).toBe('Correction for August 2026 recorded: €12.40 moved to savings.');
      expect(toast.action).toBeUndefined();
    });
  });

  describe('when the amount moved', () => {
    it('shows the new amount from the API and lets the user confirm it again', async () => {
      const p = await open(savingsDto({ outstanding: [AUGUST] }));
      await p.press('Mark August 2026 as done');

      flushError(
        http.expectOne('/api/savings/settle/2026-08'),
        409,
        'outstanding_changed',
        'The amount changed',
        { month: '2026-08', outstanding: 33000 },
      );
      await p.reload({
        savings: savingsDto({
          outstanding: [{ ...AUGUST, savingsDue: 33000, outstanding: 33000 }],
        }),
      });

      expect(p.alerts()).toEqual([
        expect.stringContaining(
          'It is now: move €330.00 to savings (it was: move €312.40 to savings).',
        ),
      ]);
      expect(textOf(inbox(p))).toContain('August 2026: move €330.00 to savings');
      expect(p.toasts()).toEqual([]);

      // Pressing Done again confirms the new figure.
      await p.press('Mark August 2026 as done');
      const request = http.expectOne('/api/savings/settle/2026-08');
      expect(request.request.body).toEqual({ amount: 33000 });
      request.flush([], { status: 201, statusText: 'Created' });
      await p.reload({ savings: savingsDto() });
      expect(p.alerts()).toEqual([]);
    });

    it('says which way a month turned when its amount flips from move to take', async () => {
      const p = await open(savingsDto({ outstanding: [AUGUST] }));
      await p.press('Mark August 2026 as done');

      flushError(http.expectOne('/api/savings/settle/2026-08'), 409, 'outstanding_changed', 'x', {
        month: '2026-08',
        outstanding: -1000,
      });
      await p.reload({
        savings: savingsDto({
          outstanding: [{ ...AUGUST, savingsDue: -1000, outstanding: -1000, direction: 'take' }],
        }),
      });

      expect(p.alerts()[0]).toContain(
        'It is now: take €10.00 from savings (it was: move €312.40 to savings).',
      );
    });

    it('still asks for a second look when the response carries no amount', async () => {
      const p = await open(savingsDto({ outstanding: [AUGUST] }));
      await p.press('Mark August 2026 as done');

      flushError(http.expectOne('/api/savings/settle/2026-08'), 409, 'outstanding_changed', 'x');
      await p.reload({
        savings: savingsDto({
          outstanding: [{ ...AUGUST, savingsDue: 33000, outstanding: 33000 }],
        }),
      });

      expect(p.alerts()[0]).toContain('It is now: move €330.00 to savings');
    });

    it('drops the notice when the row is settled', async () => {
      const p = await open(savingsDto({ outstanding: [AUGUST] }));
      await p.press('Mark August 2026 as done');
      flushError(http.expectOne('/api/savings/settle/2026-08'), 409, 'outstanding_changed', 'x', {
        month: '2026-08',
        outstanding: 33000,
      });
      await p.reload({
        savings: savingsDto({
          outstanding: [{ ...AUGUST, savingsDue: 33000, outstanding: 33000 }],
        }),
      });
      expect(p.alerts()).toHaveLength(1);

      await p.press('Mark August 2026 as done');
      http
        .expectOne('/api/savings/settle/2026-08')
        .flush([], { status: 201, statusText: 'Created' });
      await p.reload({ savings: savingsDto() });

      expect(p.alerts()).toEqual([]);
    });
  });

  describe('when the month cannot be settled', () => {
    it('says there is nothing left to move (nothing_to_settle) and drops the row', async () => {
      const p = await open(savingsDto({ outstanding: [AUGUST] }));
      await p.press('Mark August 2026 as done');

      flushError(
        http.expectOne('/api/savings/settle/2026-08'),
        409,
        'nothing_to_settle',
        'Nothing to settle for 2026-08',
      );
      await p.reload({ savings: savingsDto() });

      expect(p.toasts()).toEqual([
        'August 2026 has nothing left to move. It may have been settled in another window.',
      ]);
      expect(textOf(inbox(p))).toContain('All months are settled');
    });

    it('says the month has not closed (month_not_closed) and loads the list again', async () => {
      const p = await open(savingsDto({ outstanding: [AUGUST] }));
      await p.press('Mark August 2026 as done');

      flushError(
        http.expectOne('/api/savings/settle/2026-08'),
        422,
        'rule_violation',
        'Month is not closed',
        { rule: 'month_not_closed', field: 'month' },
      );
      await p.reload({ savings: savingsDto() });

      expect(p.toasts()).toEqual(["August 2026 has not closed yet, so it can't be settled."]);
    });

    it('says so when the month is not found any more (404) and loads the list again', async () => {
      const p = await open(savingsDto({ outstanding: [AUGUST] }));
      await p.press('Mark August 2026 as done');

      flushError(http.expectOne('/api/savings/settle/2026-08'), 404, 'not_found', 'No such month');
      await p.reload({ savings: savingsDto() });

      expect(p.toasts()).toEqual(["August 2026 can't be settled. No such month"]);
    });

    it('says the server cannot be reached when it cannot, and lets the user try again', async () => {
      const p = await open(savingsDto({ outstanding: [AUGUST] }));
      await p.press('Mark August 2026 as done');

      http
        .expectOne('/api/savings/settle/2026-08')
        .error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
      await settle(p.fixture);

      expect(p.toasts()).toEqual([
        "Couldn't mark August 2026 as done. Can't reach the server. Check your connection and try again.",
      ]);
      const done = getByRole(inbox(p), 'button', 'Mark August 2026 as done') as HTMLButtonElement;
      expect(done.disabled).toBe(false);
    });

    it('keeps the row and says what the API said when the request fails', async () => {
      const p = await open(savingsDto({ outstanding: [AUGUST] }));
      await p.press('Mark August 2026 as done');

      flushError(
        http.expectOne('/api/savings/settle/2026-08'),
        500,
        'internal_error',
        'Something went wrong on our side',
      );
      await settle(p.fixture);

      expect(p.toasts()).toEqual([
        "Couldn't mark August 2026 as done. Something went wrong on our side",
      ]);
      expect(textOf(inbox(p))).toContain('August 2026: move €312.40 to savings');
      // Nothing was reloaded, and the row can be tried again.
      const done = getByRole(inbox(p), 'button', 'Mark August 2026 as done') as HTMLButtonElement;
      expect(done.disabled).toBe(false);
    });
  });

  describe('Split', () => {
    const dialogOf = (p: Awaited<ReturnType<typeof open>>) =>
      p.dialog('app-settle-split-dialog') as HTMLElement;
    const split = async (p: Awaited<ReturnType<typeof open>>, month = 'August 2026') => {
      await p.press(`Split ${month} across goals`);
      return dialogOf(p);
    };
    const status = (dialog: HTMLElement) =>
      textOf(
        queryAllByRole(dialog, 'status').find((s) =>
          /allocate|allocated|too much/.test(textOf(s)),
        )!,
      );

    const GOALS = [HOLIDAY, CAR, OLD];

    it('opens a dialog with a field for unassigned savings and for each goal in use', async () => {
      const p = await open(savingsDto({ goals: GOALS, outstanding: [AUGUST] }));

      const dialog = await split(p);

      expect(textOf(getByRole(dialog, 'heading', 'Split August 2026'))).toBe('Split August 2026');
      expect(textOf(dialog)).toContain('August 2026: move €312.40 to savings');
      expect(getByRole(dialog, 'group', 'Move to')).toBeTruthy();
      expect(
        Array.from(dialog.querySelectorAll('input')).map((input) => input.getAttribute('id')),
      ).toHaveLength(3);
      for (const label of ['Unassigned savings', 'Holiday', 'Car']) {
        expect(getByLabel(dialog, label)).toBeTruthy();
      }
      // An archived goal takes no new money, so it is not offered.
      expect(getAllByLabel(dialog, 'Old laptop')).toEqual([]);
      expect(status(dialog)).toBe('€312.40 left to allocate');
    });

    it('shows how much is left to allocate as the amounts are typed', async () => {
      const p = await open(savingsDto({ goals: GOALS, outstanding: [AUGUST] }));
      const dialog = await split(p);

      await p.type('Holiday', '200', dialog);
      expect(status(dialog)).toBe('€112.40 left to allocate');

      await p.type('Car', '12,40', dialog);
      expect(status(dialog)).toBe('€100.00 left to allocate');

      await p.type('Unassigned savings', '100', dialog);
      expect(status(dialog)).toBe('Everything is allocated.');

      await p.type('Unassigned savings', '150', dialog);
      expect(status(dialog)).toBe('€50.00 too much: lower an amount');
    });

    it('puts what is left into a place with its Rest button', async () => {
      const p = await open(savingsDto({ goals: GOALS, outstanding: [AUGUST] }));
      const dialog = await split(p);
      await p.type('Holiday', '200', dialog);

      await p.press('Put the rest in Unassigned savings', dialog);

      expect(p.value('Unassigned savings', dialog)).toBe('112.40');
      expect(status(dialog)).toBe('Everything is allocated.');
      // Nothing is left, so the buttons wait.
      expect(
        (getByRole(dialog, 'button', 'Put the rest in Car') as HTMLButtonElement).disabled,
      ).toBe(true);
    });

    it('sends the amount the row shows and the allocations, unassigned first', async () => {
      const p = await open(savingsDto({ goals: GOALS, outstanding: [AUGUST] }));
      const dialog = await split(p);
      await p.type('Holiday', '200', dialog);
      await p.press('Put the rest in Unassigned savings', dialog);

      await p.press('Confirm split', dialog);

      const request = http.expectOne('/api/savings/settle/2026-08');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        amount: 31240,
        allocations: [
          { goalId: null, amount: 11240 },
          { goalId: 1, amount: 20000 },
        ],
      });
      request.flush([], { status: 201, statusText: 'Created' });
      await p.reload({ savings: savingsDto({ goals: GOALS }) });

      expect(p.dialog('app-settle-split-dialog')).toBeNull();
      expect(p.toasts()).toEqual(['August 2026 is done: €312.40 moved to savings.']);
    });

    it('skips the places left empty', async () => {
      const p = await open(savingsDto({ goals: GOALS, outstanding: [AUGUST] }));
      const dialog = await split(p);
      await p.type('Car', '312.40', dialog);

      await p.press('Confirm split', dialog);

      expect(http.expectOne('/api/savings/settle/2026-08').request.body).toEqual({
        amount: 31240,
        allocations: [{ goalId: 2, amount: 31240 }],
      });
    });

    it('takes each part from its place, with the sign of the whole, when the month takes money from savings', async () => {
      const p = await open(savingsDto({ goals: GOALS, outstanding: [SEPTEMBER_TAKE] }));
      const dialog = await split(p, 'September 2026');

      expect(textOf(dialog)).toContain('September 2026: take €85.00 from savings');
      expect(getByRole(dialog, 'group', 'Take from')).toBeTruthy();
      expect(status(dialog)).toBe('€85.00 left to allocate');

      await p.type('Holiday', '50', dialog);
      await p.press('Put the rest in Unassigned savings', dialog);
      expect(status(dialog)).toBe('Everything is allocated.');
      await p.press('Confirm split', dialog);

      const request = http.expectOne('/api/savings/settle/2026-09');
      expect(request.request.body).toEqual({
        amount: -8500,
        allocations: [
          { goalId: null, amount: -3500 },
          { goalId: 1, amount: -5000 },
        ],
      });
      request.flush([], { status: 201, statusText: 'Created' });
      await p.reload({ savings: savingsDto({ goals: GOALS }) });
      expect(p.toasts()).toEqual(['September 2026 is done: €85.00 taken from savings.']);
    });

    it('does not send an amount that is not fully allocated, and says what is left', async () => {
      const p = await open(savingsDto({ goals: GOALS, outstanding: [AUGUST] }));
      const dialog = await split(p);
      await p.type('Holiday', '200', dialog);

      await p.press('Confirm split', dialog);

      expect(textOf(dialog)).toContain(
        'Give the whole amount a place first: €112.40 is still left to allocate.',
      );
      http.expectNone('/api/savings/settle/2026-08');
      expect(p.dialog('app-settle-split-dialog')).not.toBeNull();
    });

    it('does not send more than the amount, and says by how much', async () => {
      const p = await open(savingsDto({ goals: GOALS, outstanding: [AUGUST] }));
      const dialog = await split(p);
      await p.type('Holiday', '400', dialog);

      await p.press('Confirm split', dialog);

      expect(textOf(dialog)).toContain(
        'The amounts add up to more than €312.40: lower one by €87.60.',
      );
      http.expectNone('/api/savings/settle/2026-08');
    });

    it('does not send an empty split', async () => {
      const p = await open(savingsDto({ goals: GOALS, outstanding: [AUGUST] }));
      const dialog = await split(p);

      await p.press('Confirm split', dialog);

      expect(textOf(dialog)).toContain('is still left to allocate');
      http.expectNone('/api/savings/settle/2026-08');
    });

    it('rejects a typed minus sign: amounts are plain numbers', async () => {
      const p = await open(savingsDto({ goals: GOALS, outstanding: [AUGUST] }));
      const dialog = await split(p);
      await p.type('Holiday', '-5', dialog);

      await p.press('Confirm split', dialog);

      expect(textOf(dialog)).toContain('Enter an amount of zero or more.');
      http.expectNone('/api/savings/settle/2026-08');
    });

    it('says the amount changed, and sends the new one when the user confirms again', async () => {
      const p = await open(savingsDto({ goals: GOALS, outstanding: [AUGUST] }));
      const dialog = await split(p);
      await p.type('Holiday', '312.40', dialog);
      await p.press('Confirm split', dialog);

      flushError(http.expectOne('/api/savings/settle/2026-08'), 409, 'outstanding_changed', 'x', {
        month: '2026-08',
        outstanding: 33000,
      });
      await p.reload({
        savings: savingsDto({
          goals: GOALS,
          outstanding: [{ ...AUGUST, savingsDue: 33000, outstanding: 33000 }],
        }),
      });

      // The dialog stays open, says so, and recalculates what is left.
      expect(p.dialog('app-settle-split-dialog')).not.toBeNull();
      expect(textOf(dialogOf(p))).toContain(
        'It is now: move €330.00 to savings (it was: move €312.40 to savings). Check the split, then confirm again.',
      );
      expect(status(dialogOf(p))).toBe('€17.60 left to allocate');

      await p.press('Put the rest in Holiday', dialogOf(p));
      await p.press('Confirm split', dialogOf(p));
      const request = http.expectOne('/api/savings/settle/2026-08');
      expect(request.request.body).toEqual({
        amount: 33000,
        allocations: [{ goalId: 1, amount: 33000 }],
      });
      request.flush([], { status: 201, statusText: 'Created' });
      await p.reload({ savings: savingsDto({ goals: GOALS }) });
      expect(p.dialog('app-settle-split-dialog')).toBeNull();
    });

    it('closes when the month was settled elsewhere', async () => {
      const p = await open(savingsDto({ goals: GOALS, outstanding: [AUGUST] }));
      const dialog = await split(p);
      await p.type('Holiday', '312.40', dialog);
      await p.press('Confirm split', dialog);

      flushError(http.expectOne('/api/savings/settle/2026-08'), 409, 'nothing_to_settle', 'x');
      await p.reload({ savings: savingsDto({ goals: GOALS }) });

      expect(p.dialog('app-settle-split-dialog')).toBeNull();
      expect(p.toasts()).toEqual([
        'August 2026 has nothing left to move. It may have been settled in another window.',
      ]);
    });

    it('shows the message of the API when a goal was archived meanwhile, and loads the goals again', async () => {
      const p = await open(savingsDto({ goals: GOALS, outstanding: [AUGUST] }));
      const dialog = await split(p);
      await p.type('Holiday', '312.40', dialog);
      await p.press('Confirm split', dialog);

      flushError(
        http.expectOne('/api/savings/settle/2026-08'),
        422,
        'rule_violation',
        'Goal 1 is archived',
        { rule: 'goal_archived', field: 'allocations.0.goalId' },
      );
      await p.reload({
        savings: savingsDto({
          goals: [{ ...HOLIDAY, archived: true, status: 'archived' }, CAR],
          outstanding: [AUGUST],
        }),
      });

      expect(textOf(dialogOf(p))).toContain('Goal 1 is archived');
      expect(textOf(dialogOf(p))).toContain('Close this dialog and open it again');
    });

    it('does not warn about an output that emits after its dialog was destroyed', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const p = await open(savingsDto({ goals: GOALS, outstanding: [AUGUST] }));
      const dialog = await split(p);
      await p.type('Holiday', '312.40', dialog);
      await p.press('Confirm split', dialog);

      http
        .expectOne('/api/savings/settle/2026-08')
        .flush([], { status: 201, statusText: 'Created' });
      // The month leaves the list while the dialog is still waiting for the reload to finish.
      await p.reload({ savings: savingsDto({ goals: GOALS }) });

      expect(p.dialog('app-settle-split-dialog')).toBeNull();
      expect(warn.mock.calls.flat().join(' ')).not.toContain('NG0953');
      warn.mockRestore();
    });

    it('stays open with the last known amount when the month is settled elsewhere, and closes once the API says so', async () => {
      const p = await open(savingsDto({ goals: GOALS, outstanding: [AUGUST] }));
      const dialog = await split(p);
      await p.type('Holiday', '312.40', dialog);

      // Another window settled the month: the next refresh of the overview no longer lists it.
      TestBed.inject(SavingsStore).refresh();
      await settle(p.fixture);
      http.expectOne('/api/savings').flush(savingsDto({ goals: GOALS }));
      await settle(p.fixture);
      expect(p.dialog('app-settle-split-dialog')).not.toBeNull();
      expect(status(dialogOf(p))).toBe('Everything is allocated.');

      await p.press('Confirm split', dialogOf(p));
      flushError(http.expectOne('/api/savings/settle/2026-08'), 409, 'nothing_to_settle', 'x');
      await p.reload({ savings: savingsDto({ goals: GOALS }) });

      expect(p.dialog('app-settle-split-dialog')).toBeNull();
      expect(p.toasts()).toEqual([
        'August 2026 has nothing left to move. It may have been settled in another window.',
      ]);
    });

    it('closes without a request when cancelled', async () => {
      const p = await open(savingsDto({ goals: GOALS, outstanding: [AUGUST] }));
      const dialog = await split(p);

      await p.press('Cancel', dialog);

      expect(p.dialog('app-settle-split-dialog')).toBeNull();
      expect(queryByRole(inbox(p), 'button', 'Mark August 2026 as done')).not.toBeNull();
    });
  });
});
