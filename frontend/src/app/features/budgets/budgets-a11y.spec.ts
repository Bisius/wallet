import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { a11yProblems } from '../../../testing/a11y';
import { openBudgetsPage } from '../../../testing/budgets-harness';
import { budgetLine, monthView, transferDto } from '../../../testing/fixtures';
import { StubPage } from '../../../testing/harness';

describe('BudgetsPage: markup a screen reader can use', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'budgets', component: StubPage }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('has nothing wrong with the cards and the list of transfers', async () => {
    const p = await openBudgetsPage(http, {
      view: monthView({
        budgets: [
          budgetLine({ id: 1, name: 'Groceries', transfersNet: -5000 }),
          budgetLine({ id: 2, name: 'Fun', transfersNet: 5000 }),
        ],
      }),
      transfers: [
        transferDto({ id: 1 }),
        transferDto({ id: 2, fromBudgetId: null, note: 'Bonus' }),
      ],
    });

    expect(a11yProblems(p.element)).toEqual([]);
  });

  it('has nothing wrong with the "Move money" dialog, with its warning and its error', async () => {
    const p = await openBudgetsPage(http);
    await p.press('Move money from Groceries', p.card('Groceries'));
    await p.type('To', '2', p.dialog()!);
    await p.type('Amount', '999', p.dialog()!);
    expect(p.text()).toContain('Not enough there.');

    expect(a11yProblems(p.element)).toEqual([]);

    await p.type('To', '1', p.dialog()!);
    expect(a11yProblems(p.element)).toEqual([]);
  });

  it('has nothing wrong with the empty list', async () => {
    const p = await openBudgetsPage(http);
    expect(a11yProblems(p.element)).toEqual([]);
  });
});
