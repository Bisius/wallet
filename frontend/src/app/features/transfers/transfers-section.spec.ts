import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { BudgetDto, TransferDto } from '@wallet/shared';
import type { LoadState } from '../../core/resource-state';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog';
import { ToastContainer } from '../../shared/ui/toast-container';
import { ToastService } from '../../shared/ui/toast.service';
import { getByRole, queryAllByRole, queryByRole, textOf } from '../../../testing/dom';
import { budgetDto, transferDto } from '../../../testing/fixtures';
import { flushError, primeStores, settle } from '../../../testing/harness';
import { TransfersSection } from './transfers-section';

@Component({
  selector: 'app-transfers-host',
  imports: [TransfersSection, ConfirmDialog, ToastContainer],
  template: `
    <app-transfers-section
      [month]="month()"
      [transfers]="transfers()"
      [state]="state()"
      [error]="error()"
      [budgets]="budgets()"
      [canMove]="canMove()"
      (retry)="retries = retries + 1"
      (moveMoney)="moves = moves + 1"
      (changed)="changes = changes + 1"
    />
    <app-confirm-dialog />
    <app-toast-container />
  `,
})
class Host {
  readonly month = signal('2026-10');
  readonly transfers = signal<TransferDto[] | undefined>([]);
  readonly state = signal<LoadState>('ready');
  readonly error = signal<unknown>(undefined);
  readonly budgets = signal<BudgetDto[] | undefined>([]);
  readonly canMove = signal(true);
  retries = 0;
  moves = 0;
  changes = 0;
}

const GROCERIES = budgetDto({ id: 1, name: 'Groceries' });
const FUN = budgetDto({ id: 2, name: 'Fun' });
const OLD_GYM = budgetDto({ id: 4, name: 'Old gym', endMonth: '2026-08', status: 'ended' });

describe('TransfersSection', () => {
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
      transfers?: TransferDto[] | undefined;
      budgets?: BudgetDto[] | undefined;
      state?: LoadState;
      month?: string;
      canMove?: boolean;
    } = {},
  ) {
    await primeStores(http);
    const fixture = TestBed.createComponent(Host);
    const host = fixture.componentInstance;
    if ('transfers' in options) host.transfers.set(options.transfers);
    host.budgets.set('budgets' in options ? options.budgets : [GROCERIES, FUN, OLD_GYM]);
    host.state.set(options.state ?? 'ready');
    host.month.set(options.month ?? '2026-10');
    host.canMove.set(options.canMove ?? true);
    fixture.detectChanges();
    await settle(fixture);

    const element = fixture.nativeElement as HTMLElement;
    const section = () => getByRole(element, 'region', /Money moved in/);
    const confirmDialog = () =>
      element.querySelector<HTMLDialogElement>('app-confirm-dialog dialog')!;
    return {
      fixture,
      host,
      element,
      section,
      confirmDialog,
      /** The rows, each as the text a person reads. */
      rows: () => queryAllByRole(section(), 'listitem').map((row) => textOf(row)),
      press: async (name: string | RegExp, root: ParentNode = element) => {
        getByRole(root, 'button', name).click();
        await settle(fixture);
      },
      toasts: () =>
        TestBed.inject(ToastService)
          .toasts()
          .map((toast) => toast.message),
    };
  }

  describe('the list', () => {
    it('is named after the month, and lists what moved: date, from and to, amount and note', async () => {
      const t = await setup({
        transfers: [
          transferDto({
            id: 2,
            date: '2026-10-05',
            fromBudgetId: 2,
            toBudgetId: 1,
            amount: 1250,
            note: 'Back',
          }),
          transferDto({ id: 1, date: '2026-10-02', fromBudgetId: 1, toBudgetId: 2, amount: 5000 }),
        ],
      });

      expect(textOf(getByRole(t.element, 'heading', 'Money moved in October 2026'))).toBe(
        'Money moved in October 2026',
      );
      expect(t.rows()).toEqual([
        'From Fun to Groceries Oct 5, 2026 · Back €12.50 Delete',
        'From Groceries to Fun Oct 2, 2026 €50.00 Delete',
      ]);
    });

    it('shows the arrow only to the eyes: a screen reader hears "from" and "to"', async () => {
      const t = await setup({ transfers: [transferDto()] });

      const name = queryAllByRole(t.section(), 'listitem')[0].querySelector('p') as HTMLElement;
      expect(name.textContent).toContain('→');
      expect(name.querySelector('[aria-hidden="true"]')?.textContent).toBe('→');
      expect(textOf(name)).toBe('From Groceries to Fun');
    });

    it('calls the unallocated pool "Unallocated", on either side', async () => {
      const t = await setup({
        transfers: [
          transferDto({ id: 2, fromBudgetId: 1, toBudgetId: null }),
          transferDto({ id: 1, fromBudgetId: null, toBudgetId: 2 }),
        ],
      });

      expect(t.rows()).toEqual([
        'From Groceries to Unallocated Oct 2, 2026 €50.00 Delete',
        'From Unallocated to Fun Oct 2, 2026 €50.00 Delete',
      ]);
    });

    it('names budgets of any status: the list it is given holds the ones that ended', async () => {
      const t = await setup({
        month: '2026-08',
        transfers: [transferDto({ date: '2026-08-10', fromBudgetId: 4, toBudgetId: 1 })],
      });

      expect(t.rows()[0]).toContain('From Old gym to Groceries');
    });

    it('falls back to a number while the budget list is missing', async () => {
      const t = await setup({ budgets: undefined, transfers: [transferDto()] });

      expect(t.rows()[0]).toContain('From Budget 1 to Budget 2');
    });

    it('has no edit: a transfer is deleted and entered again', async () => {
      const t = await setup({ transfers: [transferDto()] });

      expect(queryByRole(t.section(), 'button', /Edit/)).toBeNull();
      expect(
        queryAllByRole(t.section(), 'button').map((b) => b.getAttribute('aria-label') ?? textOf(b)),
      ).toEqual(['Delete transfer of €50.00 from Groceries to Fun on Oct 2, 2026']);
    });

    it('does not use the sign or the color of an amount: money moved is neither in nor out', async () => {
      const t = await setup({ transfers: [transferDto({ amount: 5000 })] });
      const amount = Array.from(t.section().querySelectorAll('p')).find(
        (p) => textOf(p) === '€50.00',
      )!;
      expect(amount.className).not.toContain('text-negative');
      expect(amount.className).not.toContain('text-positive');
    });
  });

  describe('states', () => {
    it('says when no money was moved, and offers to move some', async () => {
      const t = await setup({ transfers: [] });

      expect(textOf(t.section())).toContain('No money moved in October 2026');
      await t.press('Move money', t.section());
      expect(t.host.moves).toBe(1);
    });

    it('does not offer to move money when there is no budget to move it to or from', async () => {
      const t = await setup({ transfers: [], canMove: false });
      expect(queryByRole(t.section(), 'button', 'Move money')).toBeNull();
    });

    it('says it is loading', async () => {
      const t = await setup({ transfers: undefined, state: 'loading' });
      expect(textOf(t.section())).toContain('Loading the money moved…');
    });

    it('shows what went wrong, and asks the page to try again', async () => {
      const t = await setup({ transfers: undefined, state: 'error' });
      t.host.error.set(undefined);
      await settle(t.fixture);

      const alert = getByRole(t.section(), 'alert');
      expect(textOf(alert)).toContain("Couldn't load the money moved");
      await t.press('Try again', alert);
      expect(t.host.retries).toBe(1);
    });
  });

  describe('deleting', () => {
    it('asks first, and says what it does, and does nothing when cancelled', async () => {
      const t = await setup({ transfers: [transferDto({ note: 'x' })] });

      await t.press('Delete transfer of €50.00 from Groceries to Fun on Oct 2, 2026');

      const text = textOf(t.confirmDialog());
      expect(text).toContain('Delete this transfer?');
      expect(text).toContain(
        '€50.00 moved from Groceries to Fun on Oct 2, 2026 goes back where it was.',
      );
      // The current month is not closed: nothing is said about savings.
      expect(text).not.toContain('closed');
      await t.press('Cancel', t.confirmDialog());
      http.expectNone('/api/transfers/1');
      expect(t.host.changes).toBe(0);
    });

    it('deletes once confirmed, tells the page to load everything again, and puts focus on the heading', async () => {
      const t = await setup({ transfers: [transferDto()] });
      await t.press('Delete transfer of €50.00 from Groceries to Fun on Oct 2, 2026');
      await t.press('Delete transfer', t.confirmDialog());

      const request = http.expectOne('/api/transfers/1');
      expect(request.request.method).toBe('DELETE');
      request.flush(null, { status: 204, statusText: 'No Content' });
      await settle(t.fixture);

      expect(t.toasts()).toEqual(['Transfer deleted.']);
      expect(t.host.changes).toBe(1);
      expect(document.activeElement).toBe(
        getByRole(t.element, 'heading', 'Money moved in October 2026'),
      );
    });

    it('says in a closed month what the change does, in the words of the dialog that makes one', async () => {
      const t = await setup({
        month: '2026-09',
        transfers: [transferDto({ date: '2026-09-20' })],
      });

      await t.press('Delete transfer of €50.00 from Groceries to Fun on Sep 20, 2026');

      const text = textOf(t.confirmDialog());
      expect(text).toContain(
        '€50.00 moved from Groceries to Fun on Sep 20, 2026 goes back where it was.',
      );
      expect(text).toContain(
        "September 2026 is already closed, so this changes that month's budgets and the amount due to savings for it. If you already moved that month's savings, the difference shows up on the Savings page as an adjustment.",
      );
    });

    it('does not say that for a future month', async () => {
      const t = await setup({
        month: '2026-12',
        transfers: [transferDto({ date: '2026-12-03' })],
      });

      await t.press('Delete transfer of €50.00 from Groceries to Fun on Dec 3, 2026');

      expect(textOf(t.confirmDialog())).not.toContain('closed');
    });

    it('says a transfer that was already gone is gone, and still has the page load again', async () => {
      const t = await setup({ transfers: [transferDto()] });
      await t.press('Delete transfer of €50.00 from Groceries to Fun on Oct 2, 2026');
      await t.press('Delete transfer', t.confirmDialog());

      flushError(http.expectOne('/api/transfers/1'), 404, 'not_found', 'Transfer not found');
      await settle(t.fixture);

      expect(t.toasts()).toEqual(['That transfer was already gone.']);
      expect(t.host.changes).toBe(1);
    });

    it("reports another failure with the API's words and changes nothing on the page", async () => {
      const t = await setup({ transfers: [transferDto()] });
      await t.press('Delete transfer of €50.00 from Groceries to Fun on Oct 2, 2026');
      await t.press('Delete transfer', t.confirmDialog());

      flushError(http.expectOne('/api/transfers/1'), 500, 'internal_error', 'Something broke');
      await settle(t.fixture);

      expect(t.toasts()).toEqual(["Couldn't delete the transfer. Something broke"]);
      expect(t.host.changes).toBe(0);
    });
  });
});
