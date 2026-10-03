import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { BudgetDto, MonthView } from '@wallet/shared';
import { transferCreateSchema } from '@wallet/shared';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog';
import { ToastContainer } from '../../shared/ui/toast-container';
import { ToastService } from '../../shared/ui/toast.service';
import {
  fieldError,
  getByLabel,
  getByRole,
  queryByRole,
  textOf,
  typeInto,
} from '../../../testing/dom';
import { budgetDto, budgetLine, monthView, transferDto } from '../../../testing/fixtures';
import { flushError, primeStores, SETTINGS, settle } from '../../../testing/harness';
import { TransferDialog } from './transfer-dialog';

@Component({
  selector: 'app-transfer-dialog-host',
  imports: [TransferDialog, ConfirmDialog, ToastContainer],
  template: `
    @if (open()) {
      <app-transfer-dialog
        [budgets]="budgets()"
        [month]="month()"
        [monthView]="view()"
        [fromBudgetId]="from()"
        (changed)="changes = changes + 1"
        (finished)="open.set(false)"
        (cancelled)="open.set(false)"
      />
    }
    <app-confirm-dialog />
    <app-toast-container />
  `,
})
class Host {
  readonly open = signal(true);
  readonly budgets = signal<BudgetDto[]>([]);
  readonly month = signal('2026-10');
  readonly view = signal<MonthView | undefined>(undefined);
  readonly from = signal<number | null>(null);
  /** How many times the dialog said the page should load again. */
  changes = 0;
}

const GROCERIES = budgetDto({ id: 1, name: 'Groceries', sortOrder: 0 });
const FUN = budgetDto({ id: 2, name: 'Fun', sortOrder: 10 });
const RENT = budgetDto({ id: 3, name: 'Rent', sortOrder: 20, startMonth: '2026-10' });
const OLD_GYM = budgetDto({
  id: 4,
  name: 'Old gym',
  sortOrder: 30,
  endMonth: '2026-08',
  status: 'ended',
  hasHistory: true,
});
const HOLIDAY_2027 = budgetDto({
  id: 5,
  name: 'Holiday 2027',
  sortOrder: 40,
  startMonth: '2027-01',
  status: 'upcoming',
  current: null,
});
const BUDGETS = [GROCERIES, FUN, RENT, OLD_GYM, HOLIDAY_2027];

const line = (id: number, name: string, remaining: number) =>
  budgetLine({ id, name, remaining, available: Math.max(remaining, 0), allocated: 0 });
const OCTOBER = monthView({
  month: '2026-10',
  status: 'current',
  budgets: [line(1, 'Groceries', 30000), line(2, 'Fun', 15000), line(3, 'Rent', 90000)],
  unallocated: 21000,
});

describe('TransferDialog', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function setup(
    options: {
      from?: number | null;
      month?: string;
      view?: MonthView | undefined;
      budgets?: BudgetDto[];
    } = {},
  ) {
    await primeStores(http);
    const fixture = TestBed.createComponent(Host);
    const host = fixture.componentInstance;
    host.budgets.set(options.budgets ?? BUDGETS);
    host.month.set(options.month ?? '2026-10');
    host.view.set('view' in options ? options.view : OCTOBER);
    host.from.set(options.from ?? null);
    fixture.detectChanges();
    await settle(fixture);

    const element = fixture.nativeElement as HTMLElement;
    const dialog = () => element.querySelector<HTMLDialogElement>('app-transfer-dialog dialog')!;
    const confirmDialog = () =>
      element.querySelector<HTMLDialogElement>('app-confirm-dialog dialog')!;
    const helpers = {
      fixture,
      host,
      element,
      dialog,
      confirmDialog,
      text: () => textOf(dialog()),
      field: (label: string | RegExp) => getByLabel(dialog(), label),
      select: (label: string) => getByLabel<HTMLSelectElement>(dialog(), label),
      value: (label: string | RegExp) => (getByLabel(dialog(), label) as HTMLInputElement).value,
      options: (label: string) =>
        Array.from(helpers.select(label).options).map((option) => textOf(option)),
      type: async (label: string | RegExp, value: string) => {
        typeInto(getByLabel(dialog(), label), value);
        await settle(fixture);
      },
      press: async (name: string | RegExp, root: ParentNode = dialog()) => {
        getByRole(root, 'button', name).click();
        await settle(fixture);
      },
      submit: () => helpers.press('Move money'),
      toasts: () =>
        TestBed.inject(ToastService)
          .toasts()
          .map((toast) => toast.message),
      /** The block under the amount that shows the warning: it is in the page whether or not there is one. */
      warningBlock: () => {
        const block = dialog().querySelector<HTMLElement>('app-field + div');
        if (!block) throw new Error('The warning block is not in the page');
        return block;
      },
      /** What the warning says on screen: empty when there is none. */
      warning: () => textOf(helpers.warningBlock()),
      /**
       * The live region inside it: it has to be in the page whether or not there is a warning, because a
       * live region only speaks of what changes in it. It holds the part that does not change with the
       * amount.
       */
      liveRegion: () => {
        const region = helpers.warningBlock().querySelector<HTMLElement>('[aria-live="polite"]');
        if (!region) throw new Error('The live region of the warning is not in the page');
        return region;
      },
      /** What a screen reader is told about the warning. */
      announced: () => textOf(helpers.liveRegion()),
    };
    return helpers;
  }

  /** Fills the dialog for a transfer of 50.00 from Groceries to Fun. */
  async function fill(t: Awaited<ReturnType<typeof setup>>) {
    await t.type('From', '1');
    await t.type('To', '2');
    await t.type('Amount', '50');
  }

  describe('what it asks', () => {
    it('is a dialog named "Move money", with a label on every field', async () => {
      const t = await setup();

      expect(getByRole(t.element, 'dialog', 'Move money')).toBe(t.dialog());
      for (const label of ['From', 'To', 'Amount', 'Date', 'Note (optional)']) {
        expect(t.field(label), label).toBeTruthy();
      }
    });

    it('starts with nothing chosen when it is not opened from a budget', async () => {
      const t = await setup();

      expect(t.value('From')).toBe('');
      expect(t.value('To')).toBe('');
      expect(t.value('Amount')).toBe('');
      expect(document.activeElement).toBe(t.field('From'));
    });

    it('starts with the budget it was opened from as the source, and asks for the destination', async () => {
      const t = await setup({ from: 2 });

      expect(t.value('From')).toBe('2');
      expect(t.value('To')).toBe('');
      expect(document.activeElement).toBe(t.field('To'));
    });

    it("starts on today (the server's) when the shown month is the current one", async () => {
      const t = await setup();
      expect(t.value('Date')).toBe('2026-10-02');
    });

    it.each([
      ['a closed month', '2026-09', '2026-09-01'],
      ['a future month', '2026-12', '2026-12-01'],
    ])(
      'starts on the 1st of the shown month when it is %s, so the transfer lands where the person looks',
      async (_name, month, date) => {
        const t = await setup({
          month,
          view: monthView({ month, budgets: [line(1, 'Groceries', 1)] }),
        });
        expect(t.value('Date')).toBe(date);
      },
    );

    it('bounds the date to the months the app tracks: from the start month to 120 months past the current one', async () => {
      const t = await setup();

      // The first day of June 2026 (the start month) to the last day of October 2036 (October 2026 and 120 months).
      expect(t.field('Date').getAttribute('min')).toBe('2026-06-01');
      expect(t.field('Date').getAttribute('max')).toBe('2036-10-31');
    });

    it('offers "Unallocated" and the budgets that are active in the month of the date, with what each holds', async () => {
      const t = await setup();

      const expected = [
        'Choose…',
        'Unallocated · €210.00 left',
        'Groceries · €300.00 left',
        'Fun · €150.00 left',
        'Rent · €900.00 left',
      ];
      expect(t.options('From')).toEqual(expected);
      expect(t.options('To')).toEqual(expected);
    });

    it('says "over by" for a budget that is over, and "over-allocated" for a month that is', async () => {
      const t = await setup({
        view: monthView({
          month: '2026-10',
          budgets: [line(1, 'Groceries', 30000), line(2, 'Fun', -2000)],
          unallocated: -500,
        }),
        budgets: [GROCERIES, FUN],
      });

      expect(t.options('From')).toEqual([
        'Choose…',
        'Unallocated · over-allocated by €5.00',
        'Groceries · €300.00 left',
        'Fun · over by €20.00',
      ]);
    });

    it('offers the names alone while what they hold is not known', async () => {
      const t = await setup({ view: undefined });
      http.expectOne('/api/months/2026-10').flush(OCTOBER);
      await settle(t.fixture);

      expect(t.options('From')[1]).toBe('Unallocated · €210.00 left');
    });
  });

  describe('a date in another month', () => {
    it('offers the budgets active there, and loads that month for what they hold', async () => {
      const t = await setup();

      await t.type('Date', '2026-08-15');
      http.expectOne('/api/months/2026-08').flush(
        monthView({
          month: '2026-08',
          status: 'closed',
          budgets: [line(1, 'Groceries', 100), line(4, 'Old gym', 2500)],
          unallocated: 0,
        }),
      );
      await settle(t.fixture);

      // Old gym was active until August and Rent starts in October.
      expect(t.options('To')).toEqual([
        'Choose…',
        'Unallocated · €0.00 left',
        'Groceries · €1.00 left',
        'Fun',
        'Old gym · €25.00 left',
      ]);
    });

    it('keeps a budget that is not active in the month of the new date, marked, with the problem on its field', async () => {
      const t = await setup();
      await t.type('From', '3');
      await t.type('To', '2');

      await t.type('Date', '2026-09-10');
      http.expectOne('/api/months/2026-09').flush(
        monthView({
          month: '2026-09',
          status: 'closed',
          budgets: [line(1, 'Groceries', 1), line(2, 'Fun', 1)],
        }),
      );
      await settle(t.fixture);

      // Nothing the person chose is thrown away. Rent stays, and says what is wrong with it.
      expect(t.value('From')).toBe('3');
      expect(t.value('To')).toBe('2');
      expect(t.options('From')).toEqual([
        'Choose…',
        'Unallocated · €2,700.00 left',
        'Groceries · €0.01 left',
        'Fun · €0.01 left',
        'Rent (not active in September 2026)',
      ]);
      expect(fieldError(t.field('From'))).toBe(
        "Rent isn't active in September 2026. Choose another.",
      );
      expect(t.field('From').getAttribute('aria-invalid')).toBe('true');
      expect(fieldError(t.field('To'))).toBe('');
    });

    it('does not send while a budget that is chosen is not active at the date', async () => {
      const t = await setup();
      await fill(t);
      await t.type('From', '3');
      await t.type('Date', '2026-09-10');
      http
        .expectOne('/api/months/2026-09')
        .flush(monthView({ month: '2026-09', status: 'closed', budgets: [line(2, 'Fun', 1)] }));
      await settle(t.fixture);

      await t.submit();

      http.expectNone('/api/transfers');
      expect(queryByRole(t.confirmDialog(), 'button')).toBeNull();
      expect(document.activeElement).toBe(t.field('From'));
    });

    it('says it on each side that has the problem', async () => {
      const gym = budgetDto({ id: 6, name: 'Gym', sortOrder: 50, startMonth: '2026-10' });
      const t = await setup({ budgets: [...BUDGETS, gym] });
      await t.type('From', '3');
      await t.type('To', '6');

      await t.type('Date', '2026-09-10');
      http
        .expectOne('/api/months/2026-09')
        .flush(
          monthView({ month: '2026-09', status: 'closed', budgets: [line(1, 'Groceries', 1)] }),
        );
      await settle(t.fixture);

      expect(fieldError(t.field('From'))).toBe(
        "Rent isn't active in September 2026. Choose another.",
      );
      expect(fieldError(t.field('To'))).toBe("Gym isn't active in September 2026. Choose another.");
    });

    it('stops saying so, and drops the marked choice from the list, once another budget is chosen', async () => {
      const t = await setup();
      await t.type('From', '3');
      await t.type('Date', '2026-09-10');
      http.expectOne('/api/months/2026-09').flush(
        monthView({
          month: '2026-09',
          status: 'closed',
          budgets: [line(1, 'Groceries', 1), line(2, 'Fun', 1)],
        }),
      );
      await settle(t.fixture);
      expect(fieldError(t.field('From'))).toContain("Rent isn't active");

      await t.type('From', '1');

      expect(fieldError(t.field('From'))).toBe('');
      expect(t.options('From')).not.toContain('Rent (not active in September 2026)');
    });

    it('goes back to being fine when the date comes back to a month the budget is active in', async () => {
      const t = await setup();
      await t.type('From', '3');
      await t.type('Date', '2026-09-10');
      http
        .expectOne('/api/months/2026-09')
        .flush(monthView({ month: '2026-09', status: 'closed', budgets: [line(2, 'Fun', 1)] }));
      await settle(t.fixture);
      expect(fieldError(t.field('From'))).not.toBe('');

      await t.type('Date', '2026-10-20');

      expect(fieldError(t.field('From'))).toBe('');
      expect(t.value('From')).toBe('3');
    });

    it('does not lose the choices while the date is typed digit by digit', async () => {
      const t = await setup();
      await t.type('From', '3');
      await t.type('To', '2');

      // A keyboard fills a date field in pieces, and each piece that makes a whole date is a change:
      // the year 2025 passes through 0002, 0020 and 0202. None of these is a month anyone means.
      for (const date of ['0002-10-03', '0020-10-03', '0202-10-03', '2025-10-03']) {
        await t.type('Date', date);
        expect(t.value('From'), date).toBe('3');
        expect(t.value('To'), date).toBe('2');
        expect(fieldError(t.field('From')), date).toBe('');
      }
      await t.type('Date', '2026-10-05');

      expect(t.value('From')).toBe('3');
      expect(t.value('To')).toBe('2');
      expect(fieldError(t.field('From'))).toBe('');
      expect(t.options('From')).not.toContainEqual(expect.stringContaining('not active'));
      http.expectNone((request) => request.url.startsWith('/api/months/'));
    });

    it('does not use the month view of the page for another month', async () => {
      const t = await setup();
      await t.type('Date', '2026-11-05');

      http
        .expectOne('/api/months/2026-11')
        .flush(monthView({ month: '2026-11', status: 'future', budgets: [] }));
      await settle(t.fixture);
    });

    it('asks for the month view itself when the page has none', async () => {
      const t = await setup({ view: undefined });

      http.expectOne('/api/months/2026-10').flush(OCTOBER);
      await settle(t.fixture);
      expect(t.options('From')).toContain('Groceries · €300.00 left');
    });
  });

  describe('sending', () => {
    it('moves money from a budget to another: both sides are ids', async () => {
      const t = await setup();
      await fill(t);

      await t.submit();

      const request = http.expectOne('/api/transfers');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        date: '2026-10-02',
        fromBudgetId: 1,
        toBudgetId: 2,
        amount: 5000,
      });
      expect(transferCreateSchema.safeParse(request.request.body).success).toBe(true);
      request.flush(transferDto(), { status: 201, statusText: 'Created' });
      await settle(t.fixture);
    });

    it('moves money from the unallocated amount to a budget: the source is null, not left out', async () => {
      const t = await setup();
      await t.type('From', 'unallocated');
      await t.type('To', '2');
      await t.type('Amount', '12,5');

      await t.submit();

      const request = http.expectOne('/api/transfers');
      expect(request.request.body).toEqual({
        date: '2026-10-02',
        fromBudgetId: null,
        toBudgetId: 2,
        amount: 1250,
      });
      expect(transferCreateSchema.safeParse(request.request.body).success).toBe(true);
      request.flush(transferDto({ fromBudgetId: null, amount: 1250 }), {
        status: 201,
        statusText: 'Created',
      });
      await settle(t.fixture);
    });

    it('moves money from a budget back to the unallocated amount: the destination is null', async () => {
      const t = await setup();
      await t.type('From', '2');
      await t.type('To', 'unallocated');
      await t.type('Amount', '20');

      await t.submit();

      const request = http.expectOne('/api/transfers');
      expect(request.request.body).toEqual({
        date: '2026-10-02',
        fromBudgetId: 2,
        toBudgetId: null,
        amount: 2000,
      });
      expect(transferCreateSchema.safeParse(request.request.body).success).toBe(true);
      request.flush(transferDto({ fromBudgetId: 2, toBudgetId: null, amount: 2000 }), {
        status: 201,
        statusText: 'Created',
      });
      await settle(t.fixture);
    });

    it('sends the date and the note that were typed, the note trimmed', async () => {
      const t = await setup();
      await fill(t);
      await t.type('Date', '2026-10-20');
      await t.type('Note (optional)', '  For the trip ');

      await t.submit();

      const request = http.expectOne('/api/transfers');
      expect(request.request.body).toEqual({
        date: '2026-10-20',
        fromBudgetId: 1,
        toBudgetId: 2,
        amount: 5000,
        note: 'For the trip',
      });
      request.flush(transferDto(), { status: 201, statusText: 'Created' });
      await settle(t.fixture);
    });

    it('takes at most as long a note as the API does', async () => {
      const t = await setup();
      expect(t.field('Note (optional)').getAttribute('maxlength')).toBe('1000');
    });

    it('confirms what was moved, tells the page to load again and closes', async () => {
      const t = await setup();
      await fill(t);
      await t.submit();

      http.expectOne('/api/transfers').flush(transferDto(), { status: 201, statusText: 'Created' });
      await settle(t.fixture);

      expect(t.toasts()).toEqual(['Moved €50.00 from Groceries to Fun.']);
      expect(t.host.changes).toBe(1);
      expect(t.host.open()).toBe(false);
    });

    it('names the unallocated amount in the confirmation, and the month when it is not the shown one', async () => {
      const t = await setup();
      await t.type('From', 'unallocated');
      await t.type('To', '2');
      await t.type('Amount', '5');
      await t.type('Date', '2026-11-03');
      http
        .expectOne('/api/months/2026-11')
        .flush(monthView({ month: '2026-11', budgets: [line(2, 'Fun', 1)] }));
      await settle(t.fixture);
      await t.submit();

      http
        .expectOne('/api/transfers')
        .flush(transferDto({ fromBudgetId: null, date: '2026-11-03' }), {
          status: 201,
          statusText: 'Created',
        });
      await settle(t.fixture);

      expect(t.toasts()).toEqual(['Moved €5.00 from Unallocated to Fun in November 2026.']);
    });

    it('shows that it is sending and cannot be sent twice', async () => {
      const t = await setup();
      await fill(t);
      const button = getByRole(t.dialog(), 'button', 'Move money') as HTMLButtonElement;

      await t.submit();
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-busy')).toBe('true');
      button.click();
      await settle(t.fixture);

      http.expectOne('/api/transfers').flush(transferDto(), { status: 201, statusText: 'Created' });
      await settle(t.fixture);
    });

    it('closes without a request from Cancel and from Escape', async () => {
      const t = await setup();
      await fill(t);

      await t.press('Cancel');
      expect(t.host.open()).toBe(false);

      t.host.open.set(true);
      await settle(t.fixture);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(t.fixture);
      expect(t.host.open()).toBe(false);
      http.expectNone('/api/transfers');
    });

    it('does not close on Escape while the transfer is being sent, so its outcome is not lost', async () => {
      const t = await setup();
      await fill(t);
      await t.submit();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(t.fixture);
      expect(t.host.open()).toBe(true);
      expect(t.dialog().open).toBe(true);

      http.expectOne('/api/transfers').flush(transferDto(), { status: 201, statusText: 'Created' });
      await settle(t.fixture);
      expect(t.host.open()).toBe(false);
    });
  });

  describe('checks before sending', () => {
    it('asks for both sides and an amount, and sends nothing', async () => {
      const t = await setup();

      await t.submit();

      expect(fieldError(t.field('From'))).toBe('Choose where the money comes from.');
      expect(fieldError(t.field('To'))).toBe('Choose where the money goes.');
      expect(fieldError(t.field('Amount'))).toBe('Amount is required.');
      expect(document.activeElement).toBe(t.field('From'));
      http.expectNone('/api/transfers');
    });

    it('says at once that one side has to be a budget', async () => {
      const t = await setup();

      await t.type('From', 'unallocated');
      await t.type('To', 'unallocated');

      const message = "One side has to be a budget: Unallocated can't be moved to itself.";
      expect(fieldError(t.field('To'))).toBe(message);
      expect(t.field('To').getAttribute('aria-invalid')).toBe('true');

      await t.type('Amount', '5');
      await t.submit();
      expect(fieldError(t.field('To'))).toBe(message);
      expect(document.activeElement).toBe(t.field('To'));
      http.expectNone('/api/transfers');
    });

    it('says at once that the two budgets have to differ', async () => {
      const t = await setup();

      await t.type('From', '2');
      await t.type('To', '2');

      expect(fieldError(t.field('To'))).toBe(
        'Choose two different budgets to move the money between.',
      );
      await t.type('Amount', '5');
      await t.submit();
      http.expectNone('/api/transfers');
    });

    it('stops saying so when the sides are fine', async () => {
      const t = await setup();
      await t.type('From', '2');
      await t.type('To', '2');
      expect(fieldError(t.field('To'))).not.toBe('');

      await t.type('From', '1');

      expect(fieldError(t.field('To'))).toBe('');
      expect(t.field('To').getAttribute('aria-invalid')).toBeNull();
    });

    it.each([
      ['0', 'Enter an amount greater than zero.'],
      ['-5', 'Enter an amount greater than zero.'],
      ['abc', 'Enter an amount like 12.50 or 12,50.'],
    ])('refuses the amount "%s"', async (amount, message) => {
      const t = await setup();
      await t.type('From', '1');
      await t.type('To', '2');
      await t.type('Amount', amount);

      await t.submit();

      expect(fieldError(t.field('Amount'))).toBe(message);
      http.expectNone('/api/transfers');
    });

    it('refuses a date before the start month, without asking for a month that does not exist', async () => {
      const t = await setup();
      await fill(t);
      await t.type('Date', '2026-05-31');

      await t.submit();

      expect(fieldError(t.field('Date'))).toBe('Pick a date between June 2026 and October 2036.');
      expect(t.field('Date').getAttribute('aria-invalid')).toBe('true');
      http.expectNone('/api/transfers');
    });

    it('needs a date', async () => {
      const t = await setup();
      await fill(t);
      await t.type('Date', '');

      await t.submit();

      expect(fieldError(t.field('Date'))).toBe('Date is required.');
      http.expectNone('/api/transfers');
    });
  });

  describe('the dates it takes', () => {
    const RANGE = 'Pick a date between June 2026 and October 2036.';

    it.each([
      ['the day after the last month the app has', '2036-11-01'],
      ['a year typed wrong, 2062 for 2026', '2062-10-03'],
      ['a year far in the past', '0206-10-03'],
      ['a year of five digits, which a date field takes if the typing goes on', '20260-10-03'],
      ['the day before the start month', '2026-05-31'],
    ])('refuses %s (%s) on the date, before anything is sent', async (_name, date) => {
      const t = await setup();
      await fill(t);
      await t.type('Date', date);

      await t.submit();

      expect(fieldError(t.field('Date'))).toBe(RANGE);
      expect(t.field('Date').getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(t.field('Date'));
      // Nothing was sent, and no month that does not exist was asked for either.
      http.expectNone('/api/transfers');
      http.expectNone((request) => request.url.startsWith('/api/months/'));
      expect(queryByRole(t.confirmDialog(), 'button')).toBeNull();
    });

    it('accepts the first day of the start month', async () => {
      const t = await setup();
      await t.type('Date', '2026-06-01');
      http.expectOne('/api/months/2026-06').flush(
        monthView({
          month: '2026-06',
          status: 'closed',
          budgets: [line(1, 'Groceries', 100000), line(2, 'Fun', 1)],
        }),
      );
      await settle(t.fixture);
      await t.type('From', '1');
      await t.type('To', '2');
      await t.type('Amount', '50');

      await t.submit();

      // June 2026 is closed: the question about that comes first, and the date is not what stops it.
      expect(fieldError(t.field('Date'))).toBe('');
      await t.press('Move money anyway', t.confirmDialog());
      const request = http.expectOne('/api/transfers');
      expect(request.request.body).toMatchObject({ date: '2026-06-01' });
      request.flush(transferDto({ date: '2026-06-01' }), { status: 201, statusText: 'Created' });
      await settle(t.fixture);
    });

    it('accepts the last day of the last month the app has', async () => {
      const t = await setup();
      await t.type('Date', '2036-10-31');
      http.expectOne('/api/months/2036-10').flush(
        monthView({
          month: '2036-10',
          status: 'future',
          budgets: [line(1, 'Groceries', 100000), line(2, 'Fun', 1)],
        }),
      );
      await settle(t.fixture);
      await t.type('From', '1');
      await t.type('To', '2');
      await t.type('Amount', '50');

      await t.submit();

      expect(fieldError(t.field('Date'))).toBe('');
      const request = http.expectOne('/api/transfers');
      expect(request.request.body).toMatchObject({ date: '2036-10-31' });
      request.flush(transferDto({ date: '2036-10-31' }), { status: 201, statusText: 'Created' });
      await settle(t.fixture);
    });

    it('stops saying so once the date is fixed, and sends it', async () => {
      const t = await setup();
      await fill(t);
      await t.type('Date', '2062-10-03');
      await t.submit();
      expect(fieldError(t.field('Date'))).toBe(RANGE);

      await t.type('Date', '2026-10-20');
      await t.submit();

      expect(fieldError(t.field('Date'))).toBe('');
      const request = http.expectOne('/api/transfers');
      expect(request.request.body).toMatchObject({ date: '2026-10-20' });
      request.flush(transferDto({ date: '2026-10-20' }), { status: 201, statusText: 'Created' });
      await settle(t.fixture);
    });

    it('names the months in the language of the settings', async () => {
      await primeStores(http, { settings: { ...SETTINGS, locale: 'it-IT' } });
      const fixture = TestBed.createComponent(Host);
      const host = fixture.componentInstance;
      host.budgets.set(BUDGETS);
      host.view.set(OCTOBER);
      fixture.detectChanges();
      await settle(fixture);
      const element = fixture.nativeElement as HTMLElement;
      const date = getByLabel(element.querySelector('app-transfer-dialog dialog')!, 'Date');
      typeInto(date, '2062-10-03');
      await settle(fixture);

      getByRole(
        element.querySelector('app-transfer-dialog dialog')!,
        'button',
        'Move money',
      ).click();
      await settle(fixture);

      expect(fieldError(date)).toBe('Pick a date between giugno 2026 and ottobre 2036.');
    });
  });

  describe('moving more than the source holds', () => {
    it('warns, in a live region, which budget would go over and by how much', async () => {
      const t = await setup();
      await t.type('From', '1');
      await t.type('To', '2');
      expect(t.warning()).toBe('');

      await t.type('Amount', '350');

      expect(t.warning()).toBe(
        'Not enough there. Groceries holds only €300.00 in October 2026. Groceries would be €50.00 over budget. You can still move it.',
      );
      expect(t.liveRegion().getAttribute('aria-live')).toBe('polite');
      // What is spoken is the part that does not depend on the amount typed.
      expect(t.announced()).toBe('Not enough there. Groceries holds only €300.00 in October 2026.');
    });

    it('keeps the live region in the page before and after the warning, so the warning is announced', async () => {
      const t = await setup();
      await t.type('From', '1');
      await t.type('To', '2');
      const region = t.liveRegion();
      expect(textOf(region)).toBe('');

      await t.type('Amount', '350');

      // A live region only speaks of what changes in it: it has to be there before the warning is.
      expect(t.liveRegion()).toBe(region);
      expect(textOf(region)).toContain('Groceries holds only €300.00 in October 2026.');
      await t.type('Amount', '10');
      expect(t.liveRegion()).toBe(region);
      expect(textOf(region)).toBe('');
      expect(t.warning()).toBe('');
    });

    it('is announced once when it appears, not again on every digit typed after that', async () => {
      const t = await setup();
      await t.type('From', '1');
      await t.type('To', '2');
      const changes: string[] = [];
      const observer = new MutationObserver(() => changes.push(textOf(t.liveRegion())));
      observer.observe(t.liveRegion(), { childList: true, characterData: true, subtree: true });

      // 3 euros is within the 300, and so are 30 and 300: nothing is said.
      await t.type('Amount', '3');
      await t.type('Amount', '30');
      await t.type('Amount', '300');
      observer.takeRecords();
      expect(changes).toEqual([]);

      // The warning appears with the 4th digit (3000): that is the one announcement...
      await t.type('Amount', '3000');
      observer.takeRecords();
      const announcement = 'Not enough there. Groceries holds only €300.00 in October 2026.';
      expect(t.announced()).toBe(announcement);
      expect(t.warning()).toContain('Groceries would be €2,700.00 over budget.');
      changes.length = 0;

      // ...and the digits that follow change what is shown, not what is said.
      await t.type('Amount', '30000');
      await t.type('Amount', '300000');
      await t.type('Amount', '3000000');
      expect(t.warning()).toContain('Groceries would be €2,999,700.00 over budget.');
      expect(t.announced()).toBe(announcement);
      expect(changes).toEqual([]);
      observer.disconnect();
    });

    it('is announced again when the source changes, since that is another warning', async () => {
      const t = await setup();
      await t.type('From', '1');
      await t.type('To', '3');
      await t.type('Amount', '400');
      expect(t.announced()).toBe('Not enough there. Groceries holds only €300.00 in October 2026.');
      const changes: string[] = [];
      const observer = new MutationObserver(() => changes.push(textOf(t.liveRegion())));
      observer.observe(t.liveRegion(), { childList: true, characterData: true, subtree: true });

      await t.type('From', '2');

      observer.takeRecords();
      expect(t.announced()).toBe('Not enough there. Fun holds only €150.00 in October 2026.');
      expect(changes.length).toBeGreaterThan(0);
      observer.disconnect();
    });

    it('does not stop the transfer: it can still be sent, and nothing is refused for lack of money', async () => {
      const t = await setup();
      await t.type('From', '1');
      await t.type('To', '2');
      await t.type('Amount', '350');
      expect(t.warning()).not.toBe('');

      await t.submit();

      const request = http.expectOne('/api/transfers');
      expect(request.request.body).toMatchObject({ fromBudgetId: 1, toBudgetId: 2, amount: 35000 });
      request.flush(transferDto({ amount: 35000 }), { status: 201, statusText: 'Created' });
      await settle(t.fixture);
      expect(t.host.open()).toBe(false);
    });

    it('does not warn for exactly what the source holds, or less', async () => {
      const t = await setup();
      await t.type('From', '1');
      await t.type('To', '2');

      await t.type('Amount', '300');
      expect(t.warning()).toBe('');
      await t.type('Amount', '120');
      expect(t.warning()).toBe('');
      await t.type('Amount', '300,01');
      expect(t.warning()).toContain('€0.01 over budget');
    });

    it('goes away when the amount comes down, or the source changes to one that holds enough', async () => {
      const t = await setup();
      await t.type('From', '1');
      await t.type('To', '2');
      await t.type('Amount', '400');
      expect(t.warning()).not.toBe('');

      await t.type('From', '3');

      expect(t.warning()).toBe('');
    });

    it('says a budget that is over already would be over by more', async () => {
      const t = await setup({
        view: monthView({
          month: '2026-10',
          budgets: [line(1, 'Groceries', -1000), line(2, 'Fun', 15000)],
          unallocated: 21000,
        }),
        budgets: [GROCERIES, FUN],
      });
      await t.type('From', '1');
      await t.type('To', '2');
      await t.type('Amount', '50');

      expect(t.warning()).toContain(
        'Groceries is already €10.00 over budget in October 2026. Groceries would be €60.00 over budget.',
      );
    });

    it('warns about the unallocated amount, and says the month would be over-allocated', async () => {
      const t = await setup();
      await t.type('From', 'unallocated');
      await t.type('To', '2');
      await t.type('Amount', '250');

      expect(t.warning()).toBe(
        'Not enough there. Only €210.00 is unallocated in October 2026. The month would be over-allocated by €40.00. You can still move it.',
      );
    });

    it('says a month that is over-allocated already would be over-allocated by more', async () => {
      const t = await setup({
        view: monthView({ month: '2026-10', budgets: [line(2, 'Fun', 15000)], unallocated: -1000 }),
        budgets: [FUN],
      });
      await t.type('From', 'unallocated');
      await t.type('To', '2');
      await t.type('Amount', '5');

      expect(t.warning()).toContain(
        'October 2026 is already over-allocated by €10.00. The month would be over-allocated by €15.00.',
      );
    });

    it('reads the month of the date, not the one on show', async () => {
      const t = await setup();
      await t.type('From', '1');
      await t.type('To', '2');
      await t.type('Date', '2026-11-05');
      http.expectOne('/api/months/2026-11').flush(
        monthView({
          month: '2026-11',
          status: 'future',
          budgets: [line(1, 'Groceries', 10000), line(2, 'Fun', 1)],
        }),
      );
      await settle(t.fixture);

      await t.type('Amount', '150');

      expect(t.warning()).toContain('Groceries holds only €100.00 in November 2026.');
      expect(t.warning()).toContain('Groceries would be €50.00 over budget.');
    });

    it('stays silent when the amount is not a number or the source is not chosen yet', async () => {
      const t = await setup();
      await t.type('Amount', '99999');
      expect(t.warning()).toBe('');

      await t.type('From', '1');
      await t.type('Amount', 'abc');
      expect(t.warning()).toBe('');
    });

    it('stays silent when that month cannot be read, and still lets the transfer go', async () => {
      const t = await setup();
      await t.type('From', '1');
      await t.type('To', '2');
      await t.type('Date', '2030-01-10');
      flushError(http.expectOne('/api/months/2030-01'), 404, 'not_found', 'Month not found');
      await settle(t.fixture);
      await t.type('Amount', '99999');

      expect(t.warning()).toBe('');
    });
  });

  describe('a date in a closed month', () => {
    async function inSeptember() {
      const t = await setup();
      await fill(t);
      await t.type('Date', '2026-09-15');
      http.expectOne('/api/months/2026-09').flush(
        monthView({
          month: '2026-09',
          status: 'closed',
          budgets: [line(1, 'Groceries', 100000), line(2, 'Fun', 1)],
        }),
      );
      await settle(t.fixture);
      return t;
    }

    it('says so next to the date', async () => {
      const t = await inSeptember();

      expect(t.text()).toContain(
        "September 2026 is closed. A transfer in it changes that month's budgets and what is due to savings.",
      );
    });

    it('does not call a month before the start month closed: it does not exist, and the date says so', async () => {
      const t = await setup();
      await fill(t);

      // Typing a date digit by digit passes through months nobody means; May 2026 is before June 2026.
      await t.type('Date', '2026-05-31');
      expect(t.text()).not.toContain('is closed');
      expect(t.text()).not.toContain('what is due to savings');

      await t.submit();

      expect(fieldError(t.field('Date'))).toBe('Pick a date between June 2026 and October 2036.');
      expect(t.text()).not.toContain('May 2026 is closed');
      http.expectNone('/api/transfers');
      expect(queryByRole(t.confirmDialog(), 'button')).toBeNull();
    });

    it('asks before sending, in words that say what it does', async () => {
      const t = await inSeptember();

      await t.submit();

      const confirm = t.confirmDialog();
      expect(textOf(confirm)).toContain('Move money in a closed month?');
      expect(textOf(confirm)).toContain(
        "September 2026 is already closed, so this changes that month's budgets and the amount due to savings for it. If you already moved that month's savings, the difference shows up on the Savings page as an adjustment.",
      );
      http.expectNone('/api/transfers');
    });

    it('sends nothing when the answer is no, and keeps the dialog as it was', async () => {
      const t = await inSeptember();
      await t.submit();

      await t.press('Cancel', t.confirmDialog());

      http.expectNone('/api/transfers');
      expect(t.host.open()).toBe(true);
      expect(t.value('Amount')).toBe('50.00');
      expect(t.value('Date')).toBe('2026-09-15');
    });

    it('sends the transfer when the answer is yes', async () => {
      const t = await inSeptember();
      await t.submit();

      await t.press('Move money anyway', t.confirmDialog());

      const request = http.expectOne('/api/transfers');
      expect(request.request.body).toMatchObject({
        date: '2026-09-15',
        fromBudgetId: 1,
        toBudgetId: 2,
      });
      request.flush(transferDto({ date: '2026-09-15' }), { status: 201, statusText: 'Created' });
      await settle(t.fixture);
      expect(t.toasts()).toEqual(['Moved €50.00 from Groceries to Fun in September 2026.']);
    });

    it('does not ask for the current month', async () => {
      const t = await setup();
      await fill(t);

      await t.submit();

      http.expectOne('/api/transfers').flush(transferDto(), { status: 201, statusText: 'Created' });
      await settle(t.fixture);
      expect(queryByRole(t.confirmDialog(), 'button')).toBeNull();
    });

    it('does not ask for a future month either', async () => {
      const t = await setup();
      await fill(t);
      await t.type('Date', '2026-12-01');
      http
        .expectOne('/api/months/2026-12')
        .flush(monthView({ month: '2026-12', status: 'future', budgets: [] }));
      await settle(t.fixture);

      await t.submit();

      expect(queryByRole(t.confirmDialog(), 'button')).toBeNull();
      http
        .expectOne('/api/transfers')
        .flush(transferDto({ date: '2026-12-01' }), { status: 201, statusText: 'Created' });
      await settle(t.fixture);
    });
  });

  describe('errors from the API', () => {
    async function refuse(rule: string, field: string, message: string) {
      const t = await setup();
      await fill(t);
      await t.submit();
      flushError(http.expectOne('/api/transfers'), 422, 'rule_violation', message, { rule, field });
      await settle(t.fixture);
      return t;
    }

    it('shows unknown_budget on the source', async () => {
      const t = await refuse('unknown_budget', 'fromBudgetId', 'Budget 1 does not exist');

      expect(fieldError(t.field('From'))).toBe('Budget 1 does not exist');
      expect(document.activeElement).toBe(t.field('From'));
      expect(t.host.open()).toBe(true);
      expect(t.host.changes).toBe(1);
    });

    it('shows unknown_budget on the destination', async () => {
      const t = await refuse('unknown_budget', 'toBudgetId', 'Budget 2 does not exist');

      expect(fieldError(t.field('To'))).toBe('Budget 2 does not exist');
      expect(document.activeElement).toBe(t.field('To'));
    });

    it('shows before_start_month on the date', async () => {
      const t = await refuse(
        'before_start_month',
        'date',
        'A transfer cannot be dated 2026-10-02, before the start month 2026-11',
      );

      expect(fieldError(t.field('Date'))).toBe(
        'A transfer cannot be dated 2026-10-02, before the start month 2026-11',
      );
      expect(document.activeElement).toBe(t.field('Date'));
    });

    it.each([
      ['fromBudgetId', 'From'],
      ['toBudgetId', 'To'],
    ])(
      'shows outside_active_months on %s, and has the page load the budgets again',
      async (field, label) => {
        const t = await refuse(
          'outside_active_months',
          field,
          'The budget is not active in 2026-10',
        );

        expect(fieldError(t.field(label))).toBe('The budget is not active in 2026-10');
        expect(t.host.changes).toBe(1);
        expect(t.toasts()).toEqual([]);
      },
    );

    it('shows a 400 about the destination on the destination', async () => {
      const t = await setup();
      await fill(t);
      await t.submit();
      flushError(http.expectOne('/api/transfers'), 400, 'validation_error', 'Invalid request', [
        { path: 'toBudgetId', message: 'Choose two different budgets to move the money between' },
      ]);
      await settle(t.fixture);

      expect(fieldError(t.field('To'))).toBe(
        'Choose two different budgets to move the money between',
      );
    });

    it('lets the person try again once the field is changed', async () => {
      const t = await refuse('before_start_month', 'date', 'Too early');

      await t.type('Date', '2026-10-05');
      await t.submit();

      const request = http.expectOne('/api/transfers');
      expect(request.request.body.date).toBe('2026-10-05');
      request.flush(transferDto({ date: '2026-10-05' }), { status: 201, statusText: 'Created' });
      await settle(t.fixture);
    });

    it('puts focus back on the button after a failure that belongs to no field', async () => {
      const t = await setup();
      await fill(t);
      await t.submit();

      flushError(http.expectOne('/api/transfers'), 500, 'internal_error', 'Something broke');
      await settle(t.fixture);

      // The button was disabled while the request was out, which takes focus to the page.
      expect(document.activeElement).toBe(getByRole(t.dialog(), 'button', 'Move money'));
    });

    it('shows an error that belongs to no field in an alert, keeping what was typed', async () => {
      const t = await setup();
      await fill(t);
      await t.submit();
      flushError(http.expectOne('/api/transfers'), 500, 'internal_error', 'Something broke');
      await settle(t.fixture);

      expect(textOf(getByRole(t.dialog(), 'alert'))).toBe('Something broke');
      // Focus went back to the button, which tidied up the amount as the person left it.
      expect(t.value('Amount')).toBe('50.00');
      expect(t.host.open()).toBe(true);
    });
  });

  describe('when the budgets change under it', () => {
    it('keeps a budget that the reloaded list no longer has active, and says what is wrong with it', async () => {
      const t = await setup();
      await t.type('From', '3');
      expect(t.value('From')).toBe('3');

      t.host.budgets.set([GROCERIES, FUN, { ...RENT, startMonth: '2026-11' }]);
      await settle(t.fixture);

      expect(t.value('From')).toBe('3');
      expect(fieldError(t.field('From'))).toBe(
        "Rent isn't active in October 2026. Choose another.",
      );
      expect(t.options('From')).toContain('Rent (not active in October 2026)');
    });
  });
});
