import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { importCommitSchema, type ImportPreviewRow } from '@wallet/shared';
import { a11yProblems } from '../../../testing/a11y';
import {
  getByLabel,
  getByRole,
  queryAllByRole,
  queryByRole,
  queryByText,
  textOf,
  typeInto,
} from '../../../testing/dom';
import { budgetDto, importMapping, previewRow } from '../../../testing/fixtures';
import { flushError, settle } from '../../../testing/harness';
import { IMPORT_STORES } from '../../../testing/import-harness';
import {
  answerRefusal,
  answerSavingsRefresh,
  openReview,
  type OpenReviewOptions,
  REVIEW_CSV,
} from '../../../testing/import-review-helpers';
import { optionTexts, selectedText } from '../../../testing/import-steps-helpers';
import { ImportPreviewStep } from './import-preview-step';

const GROCERIES = budgetDto({ id: 1, name: 'Groceries', startMonth: '2026-06' });
const FUN = budgetDto({ id: 2, name: 'Fun', startMonth: '2026-09', endMonth: '2026-09' });
const BUDGETS = [GROCERIES, FUN];

const COFFEE = previewRow({ line: 2, description: 'Coffee', suggestedBudgetId: 1 });
const LUNCH = previewRow({
  line: 3,
  date: '2026-10-02',
  amount: 1230,
  raw: { date: '2026-10-02', amount: '-12.30' },
  description: 'Lunch',
});
const SALARY = previewRow({
  line: 4,
  date: '2026-10-03',
  amount: -250000,
  raw: { date: '2026-10-03', amount: '2500.00' },
  description: 'Salary',
  credit: true,
  suggestedBudgetId: 1,
});
const RENT = previewRow({
  line: 5,
  amount: 90000,
  raw: { date: '2026-10-01', amount: '-900.00' },
  description: 'Rent',
  duplicate: true,
  suggestedBudgetId: 1,
});
const GYM = previewRow({
  line: 6,
  date: null,
  amount: 2500,
  raw: { date: '31/02/2026', amount: '-25.00' },
  description: 'Gym',
  errors: ['invalid_date'],
});
const CINEMA = previewRow({
  line: 7,
  date: '2026-09-15',
  amount: 1100,
  raw: { date: '2026-09-15', amount: '-11.00' },
  description: 'Cinema',
  suggestedBudgetId: 2,
});
const ROWS = [COFFEE, LUNCH, SALARY, RENT, GYM, CINEMA];

const lineOf = (checkbox: HTMLElement) =>
  Number(/\d+$/.exec(checkbox.getAttribute('aria-label') ?? '')?.[0]);

describe('ImportPreviewStep', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        ...IMPORT_STORES,
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  /** The review of `rows` is open and the step is shown, as in the third step of the wizard. */
  async function setup(rows: ImportPreviewRow[] = ROWS, options: OpenReviewOptions = {}) {
    const { wizard, review } = await openReview(http, rows, { budgets: BUDGETS, ...options });
    const fixture = TestBed.createComponent(ImportPreviewStep);
    fixture.detectChanges();
    await settle(fixture);
    const element = fixture.nativeElement as HTMLElement;

    const act = async (action: () => void) => {
      action();
      await settle(fixture);
    };
    const click = (name: string | RegExp) => act(() => getByRole(element, 'button', name).click());
    return {
      fixture,
      element,
      wizard,
      review,
      click,
      importButton: () =>
        getByRole(element, 'button', /^Import \d+ spendings?$/) as HTMLButtonElement,
      back: () => getByRole(element, 'button', 'Back') as HTMLButtonElement,
      show: () => getByLabel<HTMLSelectElement>(element, 'Show'),
      bulk: () => getByLabel<HTMLSelectElement>(element, 'Budget for the ticked rows'),
      budget: (line: number) => getByLabel<HTMLSelectElement>(element, `Budget for line ${line}`),
      checkbox: (line: number) => getByLabel<HTMLInputElement>(element, `Import line ${line}`),
      lines: () => queryAllByRole(element, 'checkbox').map(lineOf),
      ticked: () =>
        queryAllByRole(element, 'checkbox')
          .filter((box) => (box as HTMLInputElement).checked)
          .map(lineOf),
      alerts: () => queryAllByRole(element, 'alert').map(textOf),
      /** The line under the table: "2 rows selected of 6. Together €14.50 (...)". */
      selection: () =>
        queryAllByRole(element, 'status')
          .map(textOf)
          .find((text) => text.includes('selected of')),
      /** The note under the bulk-budget controls. */
      notice: () =>
        queryAllByRole(element, 'status')
          .map(textOf)
          .find((text) => text.includes(' set for ')),
      blocker: () => document.getElementById('import-blocker'),
      pick: async (select: HTMLSelectElement, value: string) => act(() => typeInto(select, value)),
      act,
    };
  }

  it('is a labelled step that says what to do and that nothing is stored yet', async () => {
    const t = await setup();

    expect(getByRole(t.element, 'region', 'Review the rows')).toBeTruthy();
    expect(getByRole(t.element, 'heading', 'Review the rows')).toBeTruthy();
    expect(textOf(t.element)).toContain(
      'Tick the rows to import and check the budget of each. Nothing is stored until you press Import.',
    );
  });

  describe('the summary', () => {
    it('counts the rows of the file as the server judged them', async () => {
      const t = await setup();

      expect(textOf(t.element.querySelector('dl') as HTMLElement)).toBe(
        'Rows 6 Ready to import 3 Already imported 1 Credits 1 With errors 1',
      );
      expect(textOf(t.element)).toContain('The counts overlap');
    });

    it('shows the counts as plain figures: the step is a card, so no tile sits in it', async () => {
      const t = await setup();

      const figures = t.element.querySelector('dl') as HTMLElement;
      expect(figures.querySelector('.bg-subtle')).toBeNull();
    });

    it('keeps the long notes (the overlap, the meaning of "all shown rows") in the help', async () => {
      const t = await setup();

      expect(textOf(t.element)).toContain('How this works');
      expect(textOf(t.element)).toContain(
        '"All shown rows" means every row of this filter, on every page.',
      );
    });

    it("shows the server's counts, not the count of the rows it holds, in the locale of the user", async () => {
      // A statement of 1,203 rows, of which this preview holds three: the counts are the server's.
      const t = await setup([COFFEE, LUNCH, RENT], {
        summary: { total: 1203, importable: 1148, duplicates: 40, credits: 3, invalid: 12 },
      });

      expect(textOf(t.element.querySelector('dl') as HTMLElement)).toBe(
        'Rows 1,203 Ready to import 1,148 Already imported 40 Credits 3 With errors 12',
      );
      expect(t.selection()).toBe(
        '1 row selected of 1,203. Together €3.50 (refunds and credits are subtracted).',
      );
    });

    it('says how many rows are selected and what they add up to', async () => {
      const t = await setup();

      // Coffee (3.50) and Cinema (11.00).
      expect(t.selection()).toBe(
        '2 rows selected of 6. Together €14.50 (refunds and credits are subtracted).',
      );
    });

    it('subtracts a credit that is ticked, in whole cents', async () => {
      const t = await setup();

      await t.act(() => t.checkbox(4).click());

      // 3.50 + 11.00 - 2,500.00
      expect(t.selection()).toBe(
        '3 rows selected of 6. Together -€2,485.50 (refunds and credits are subtracted).',
      );
    });

    it('says "1 row" for one, and gives no total for none', async () => {
      const t = await setup();

      await t.act(() => t.checkbox(7).click());
      expect(t.selection()).toBe(
        '1 row selected of 6. Together €3.50 (refunds and credits are subtracted).',
      );

      await t.act(() => t.checkbox(2).click());
      expect(t.selection()).toBe('0 rows selected of 6.');
    });
  });

  describe('choosing rows', () => {
    it('lists the filters with the number of rows in each', async () => {
      const t = await setup();

      expect(optionTexts(t.show())).toEqual([
        'All rows (6)',
        'Ready to import (3)',
        'Needs a budget (1)',
        'Already imported (1)',
        'Credits (1)',
        'With errors (1)',
      ]);
      expect(selectedText(t.show())).toBe('All rows (6)');
    });

    it.each([
      ['importable', [2, 3, 7]],
      ['needs-budget', [3]],
      ['duplicates', [5]],
      ['credits', [4]],
      ['errors', [6]],
      ['all', [2, 3, 4, 5, 6, 7]],
    ])('shows only the rows of the filter: %s', async (filter, lines) => {
      const t = await setup();

      await t.pick(t.show(), filter);

      expect(t.lines()).toEqual(lines);
    });

    it('ticks every row that can be imported, but not a credit, a duplicate or a row with an error', async () => {
      const t = await setup();

      await t.click('Tick all shown rows');

      expect(t.ticked()).toEqual([2, 3, 7]);
      // Lunch has no budget yet, so the import waits for one.
      expect(t.importButton().disabled).toBe(true);
    });

    it('ticks a credit only when the credits are what is shown', async () => {
      const t = await setup();
      await t.pick(t.show(), 'credits');

      await t.click('Tick all shown rows');

      await t.pick(t.show(), 'all');
      expect(t.ticked()).toEqual([2, 4, 7]);
    });

    it('unticks the rows that are shown, and only those', async () => {
      const t = await setup();
      await t.act(() => t.checkbox(4).click());
      await t.pick(t.show(), 'credits');

      await t.click('Untick all shown rows');

      await t.pick(t.show(), 'all');
      expect(t.ticked()).toEqual([2, 7]);

      await t.click('Untick all shown rows');
      expect(t.ticked()).toEqual([]);
      expect(t.selection()).toBe('0 rows selected of 6.');
    });
  });

  describe('one budget for the ticked rows', () => {
    it('offers every budget, and says when one has ended', async () => {
      const t = await setup();

      expect(optionTexts(t.bulk())).toEqual([
        'Choose a budget',
        'Groceries',
        'Fun (ended September 2026)',
      ]);
    });

    it('is off until a budget is chosen', async () => {
      const t = await setup();
      const apply = () => getByRole(t.element, 'button', 'Set budget for the ticked rows');
      expect((apply() as HTMLButtonElement).disabled).toBe(true);

      await t.pick(t.bulk(), '1');

      expect((apply() as HTMLButtonElement).disabled).toBe(false);
    });

    it('is off when no row is ticked', async () => {
      const t = await setup();
      await t.click('Untick all shown rows');
      await t.pick(t.bulk(), '1');

      const apply = getByRole(t.element, 'button', 'Set budget for the ticked rows');
      expect((apply as HTMLButtonElement).disabled).toBe(true);
    });

    it('puts every ticked row in the budget and says so', async () => {
      const t = await setup();
      await t.pick(t.bulk(), '1');

      await t.click('Set budget for the ticked rows');

      expect(selectedText(t.budget(2))).toBe('Groceries');
      expect(selectedText(t.budget(7))).toBe('Groceries');
      expect(t.notice()).toBe('Groceries set for 2 rows.');
    });

    it('leaves the rows it is not active for, and says how many', async () => {
      const t = await setup();
      await t.pick(t.bulk(), '2');

      await t.click('Set budget for the ticked rows');

      // Fun was active in September only: Coffee, of October, keeps Groceries.
      expect(selectedText(t.budget(7))).toBe('Fun');
      expect(selectedText(t.budget(2))).toBe('Groceries');
      expect(t.notice()).toBe(
        'Fun set for 1 row. 1 row kept its budget, because Fun is not active in its month.',
      );
    });

    it('makes the import possible for a ticked row that had no budget', async () => {
      const t = await setup();
      await t.act(() => t.checkbox(3).click());
      expect(t.importButton().disabled).toBe(true);
      await t.pick(t.bulk(), '1');

      await t.click('Set budget for the ticked rows');

      expect(selectedText(t.budget(3))).toBe('Groceries');
      expect(t.importButton().disabled).toBe(false);
      expect(textOf(t.importButton())).toBe('Import 3 spendings');
    });
  });

  describe('the Import button', () => {
    const label = (button: HTMLElement) => textOf(button);

    it('says how many spendings it will import, and is on when they are ready', async () => {
      const t = await setup();

      expect(label(t.importButton())).toBe('Import 2 spendings');
      expect(t.importButton().disabled).toBe(false);
      expect(t.blocker()).toBeNull();
      expect(t.importButton().hasAttribute('aria-describedby')).toBe(false);
    });

    it('says "spending" for one', async () => {
      const t = await setup();

      await t.act(() => t.checkbox(7).click());

      expect(label(t.importButton())).toBe('Import 1 spending');
      expect(t.importButton().disabled).toBe(false);
    });

    it('is off when no row is ticked, and says why', async () => {
      const t = await setup();

      await t.click('Untick all shown rows');

      expect(label(t.importButton())).toBe('Import 0 spendings');
      expect(t.importButton().disabled).toBe(true);
      expect(textOf(t.blocker() as HTMLElement)).toBe('Tick at least one row to import.');
      expect(t.importButton().getAttribute('aria-describedby')).toBe('import-blocker');
      expect(queryByRole(t.element, 'button', 'Show them')).toBeNull();
    });

    it('is off while a ticked row has no budget, and offers to show those rows', async () => {
      const t = await setup();

      await t.act(() => t.checkbox(3).click());

      expect(label(t.importButton())).toBe('Import 3 spendings');
      expect(t.importButton().disabled).toBe(true);
      expect(textOf(t.blocker() as HTMLElement)).toBe(
        '1 ticked row needs a budget before you can import. Show them',
      );
      expect(t.importButton().getAttribute('aria-describedby')).toBe('import-blocker');
    });

    it('counts the rows that need a budget', async () => {
      const t = await setup();
      await t.act(() => t.checkbox(3).click());
      await t.pick(t.budget(2), '');

      expect(textOf(t.blocker() as HTMLElement)).toBe(
        '2 ticked rows need a budget before you can import. Show them',
      );
    });

    it('"Show them" lists the ticked rows that need a budget, and picking one turns the import on', async () => {
      const t = await setup();
      await t.act(() => t.checkbox(3).click());

      await t.click('Show them');

      expect(selectedText(t.show())).toBe('Needs a budget (1)');
      expect(t.lines()).toEqual([3]);

      await t.pick(t.budget(3), '1');

      expect(t.blocker()).toBeNull();
      expect(t.importButton().disabled).toBe(false);
    });
  });

  describe('importing', () => {
    it('sends the file, the mapping and the line and budget of each ticked row, then moves on', async () => {
      const t = await setup();
      await t.pick(t.budget(3), '1');

      await t.click('Import 3 spendings');
      const request = http.expectOne('/api/import/commit');

      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        csv: REVIEW_CSV,
        mapping: importMapping(),
        rows: [
          { line: 2, budgetId: 1 },
          { line: 3, budgetId: 1 },
          { line: 7, budgetId: 2 },
        ],
      });
      expect(importCommitSchema.safeParse(request.request.body).success).toBe(true);
      request.flush({
        created: 3,
        items: [
          { line: 2, id: 1 },
          { line: 3, id: 2 },
          { line: 7, id: 3 },
        ],
      });
      await settle(t.fixture);
      answerSavingsRefresh(http);

      expect(t.wizard.step()).toBe('done');
      expect(t.review.result()).toEqual({ created: 3, months: ['2026-09', '2026-10'] });
    });

    it('sends the budget the user picked, and a credit that was ticked', async () => {
      const t = await setup();
      await t.act(() => t.checkbox(4).click());
      await t.pick(t.budget(7), '1');

      await t.click('Import 3 spendings');

      const request = http.expectOne('/api/import/commit');
      expect(request.request.body.rows).toEqual([
        { line: 2, budgetId: 1 },
        { line: 4, budgetId: 1 },
        { line: 7, budgetId: 1 },
      ]);
      request.flush({ created: 3, items: [] });
      await settle(t.fixture);
      answerSavingsRefresh(http);
    });

    it('never sends a row that is not ticked', async () => {
      const t = await setup();
      await t.act(() => t.checkbox(2).click());

      await t.click('Import 1 spending');

      const request = http.expectOne('/api/import/commit');
      expect(request.request.body.rows).toEqual([{ line: 7, budgetId: 2 }]);
      request.flush({ created: 1, items: [] });
      await settle(t.fixture);
      answerSavingsRefresh(http);
    });

    it('shows that it is working, keeps the user from going back or importing twice, then finishes', async () => {
      const t = await setup();

      await t.click('Import 2 spendings');

      expect(t.importButton().getAttribute('aria-busy')).toBe('true');
      expect(t.importButton().disabled).toBe(true);
      expect(t.back().disabled).toBe(true);
      t.importButton().click();
      t.back().click();
      await settle(t.fixture);

      http.expectOne('/api/import/commit').flush({ created: 2, items: [] });
      await settle(t.fixture);
      answerSavingsRefresh(http);
      expect(t.wizard.step()).toBe('done');
    });

    it('does nothing when the button is off', async () => {
      const t = await setup();
      await t.click('Untick all shown rows');

      t.importButton().click();
      await settle(t.fixture);

      http.expectNone('/api/import/commit');
      expect(t.wizard.step()).toBe('preview');
    });
  });

  describe('when the import fails', () => {
    it.each([
      [400, 'validation_error', 'A quote is never closed on line 9', undefined],
      [413, 'payload_too_large', 'Request body too large', { limitBytes: 10485760 }],
    ] as const)(
      'says nothing was imported, and sends the user back to the file or the columns: %s',
      async (status, code, message, details) => {
        const t = await setup();

        await t.click('Import 2 spendings');
        flushError(http.expectOne('/api/import/commit'), status, code, message, details);
        await settle(t.fixture);

        expect(t.alerts()).toEqual([
          `Nothing was imported ${message} Go back to change the file or the columns, then try again.`,
        ]);
        expect(t.wizard.step()).toBe('preview');
        expect(t.importButton().disabled).toBe(false);
      },
    );

    it.each([
      [500, 'internal_error', 'The database is locked'],
      [422, 'import_rows_rejected', 'Some rows were refused'],
    ] as const)(
      'says nothing was stored, so the user can try again: %s',
      async (status, code, message) => {
        const t = await setup();

        await t.click('Import 2 spendings');
        // A 422 without a list of rows is a plain failure.
        flushError(http.expectOne('/api/import/commit'), status, code, message);
        await settle(t.fixture);

        expect(t.alerts()).toEqual([
          `Nothing was imported ${message} Nothing was stored, so you can try again.`,
        ]);
        expect(t.wizard.step()).toBe('preview');
        expect(t.importButton().disabled).toBe(false);
      },
    );

    it('says so when the server cannot be reached', async () => {
      const t = await setup();

      await t.click('Import 2 spendings');
      http.expectOne('/api/import/commit').error(new ProgressEvent('error'));
      await settle(t.fixture);

      expect(t.alerts()).toEqual([
        "Nothing was imported Can't reach the server. Check your connection and try again. Nothing was stored, so you can try again.",
      ]);
      expect(t.importButton().disabled).toBe(false);
    });

    it('clears the message when the user tries again, and finishes when it works', async () => {
      const t = await setup();
      await t.click('Import 2 spendings');
      flushError(
        http.expectOne('/api/import/commit'),
        500,
        'internal_error',
        'The database is locked',
      );
      await settle(t.fixture);
      expect(t.alerts()).toHaveLength(1);

      await t.click('Import 2 spendings');
      expect(t.alerts()).toEqual([]);
      http.expectOne('/api/import/commit').flush({ created: 2, items: [] });
      await settle(t.fixture);
      answerSavingsRefresh(http);

      expect(t.wizard.step()).toBe('done');
    });

    it('keeps the choices of the user', async () => {
      const t = await setup();
      await t.act(() => t.checkbox(3).click());
      await t.pick(t.budget(3), '1');
      await t.click('Import 3 spendings');

      flushError(http.expectOne('/api/import/commit'), 500, 'internal_error', 'Boom');
      await settle(t.fixture);

      expect(t.ticked()).toEqual([2, 3, 7]);
      expect(selectedText(t.budget(3))).toBe('Groceries');
    });
  });

  describe('when the server refuses some rows', () => {
    const REFUSED_ROWS = [{ ...COFFEE, duplicate: true }, LUNCH, SALARY, RENT, GYM, CINEMA];

    async function refuse(
      t: Awaited<ReturnType<typeof setup>>,
      refused: { line: number; errors: string[] }[],
      rows: ImportPreviewRow[] = REFUSED_ROWS,
    ) {
      await t.click(/^Import \d+ spendings?$/);
      await answerRefusal(http, t.fixture, refused, { budgets: BUDGETS, rows });
    }

    it('lists each refused line with the reasons, says nothing was imported, and stays on the step', async () => {
      const t = await setup();

      await refuse(t, [
        { line: 2, errors: ['duplicate'] },
        { line: 7, errors: ['outside_active_months', 'some_future_code'] },
      ]);

      const [alert] = queryAllByRole(t.element, 'alert');
      expect(t.alerts()).toHaveLength(1);
      expect(textOf(alert)).toContain('Nothing was imported');
      expect(textOf(alert)).toContain(
        'The server refused 2 rows, so it stored none of them. The table below is up to date: fix them or untick them, then import again.',
      );
      expect(queryAllByRole(alert, 'listitem').map(textOf)).toEqual([
        'Line 2: It was imported already',
        "Line 7: The budget isn't active in the month of the date; some_future_code",
      ]);
      expect(t.wizard.step()).toBe('preview');
    });

    it('says "1 row" for one', async () => {
      const t = await setup();

      await refuse(t, [{ line: 2, errors: ['duplicate'] }]);

      expect(t.alerts()[0]).toContain('The server refused 1 row, so it stored none of them.');
    });

    it('brings the table up to date: a row that became a duplicate is no longer ticked', async () => {
      const t = await setup();
      expect(textOf(t.importButton())).toBe('Import 2 spendings');

      await refuse(t, [{ line: 2, errors: ['duplicate'] }]);

      expect(t.checkbox(2).checked).toBe(false);
      expect(t.checkbox(2).disabled).toBe(true);
      expect(t.ticked()).toEqual([7]);
      expect(textOf(t.importButton())).toBe('Import 1 spending');
    });

    it('lets the user fix it and import the rest, and the message goes', async () => {
      const t = await setup();
      await refuse(t, [{ line: 2, errors: ['duplicate'] }]);

      await t.click('Import 1 spending');
      expect(t.alerts()).toEqual([]);

      const request = http.expectOne('/api/import/commit');
      expect(request.request.body.rows).toEqual([{ line: 7, budgetId: 2 }]);
      request.flush({ created: 1, items: [{ line: 7, id: 1 }] });
      await settle(t.fixture);
      answerSavingsRefresh(http);
      expect(t.wizard.step()).toBe('done');
    });

    it('asks for a budget again when the one a row had is gone', async () => {
      const t = await setup();
      await t.click('Import 2 spendings');

      // Fun was deleted meanwhile: Cinema is refused, and the budget list no longer has it.
      await answerRefusal(http, t.fixture, [{ line: 7, errors: ['unknown_budget'] }], {
        budgets: [GROCERIES],
        rows: ROWS,
      });

      expect(t.alerts()[0]).toContain("Line 7: That budget doesn't exist any more");
      expect(selectedText(t.budget(7))).toBe('Choose a budget');
      expect(t.importButton().disabled).toBe(true);
      expect(textOf(t.blocker() as HTMLElement)).toBe(
        '1 ticked row needs a budget before you can import. Show them',
      );
    });
  });

  describe('going back', () => {
    it('returns to the columns, asks for nothing and keeps the choices', async () => {
      const t = await setup();
      await t.act(() => t.checkbox(3).click());

      await t.click('Back');

      expect(t.wizard.step()).toBe('mapping');
      http.expectNone('/api/import/preview');
      expect(t.review.selectedCount()).toBe(3);
    });

    it('is possible when the import failed', async () => {
      const t = await setup();
      await t.click('Import 2 spendings');
      flushError(
        http.expectOne('/api/import/commit'),
        400,
        'validation_error',
        'A quote is never closed',
      );
      await settle(t.fixture);

      await t.click('Back');

      expect(t.wizard.step()).toBe('mapping');
    });
  });

  describe('the budgets', () => {
    it('says they are loading, and shows no table yet', async () => {
      const t = await setup(ROWS, { budgets: 'loading' });

      expect(textOf(t.element)).toContain('Loading your budgets…');
      expect(queryAllByRole(t.element, 'checkbox')).toEqual([]);
      expect(queryByRole(t.element, 'combobox', 'Show')).toBeNull();
    });

    it('says what went wrong when they cannot be loaded, and loads them again', async () => {
      const t = await setup(ROWS, { budgets: 'error' });

      expect(t.alerts()).toEqual([
        "Couldn't load your budgets The budgets are unavailable Try again",
      ]);

      await t.click('Try again');
      http.expectOne('/api/budgets').flush(BUDGETS);
      await settle(t.fixture);

      expect(t.alerts()).toEqual([]);
      expect(t.lines()).toEqual([2, 3, 4, 5, 6, 7]);
      expect(optionTexts(t.budget(7))).toEqual(['Choose a budget', 'Groceries', 'Fun']);
    });

    it('sends a user with no budgets to create one first', async () => {
      const t = await setup(ROWS, { budgets: [] });

      expect(textOf(t.element)).toContain('You have no budgets yet');
      expect(textOf(t.element)).toContain(
        'A spending belongs to a budget. Create one, then import the file.',
      );
      expect(getByRole(t.element, 'link', 'Go to budgets').getAttribute('href')).toBe('/budgets');
      expect(queryAllByRole(t.element, 'checkbox')).toEqual([]);
      expect(queryByText(t.element, 'Tick all shown rows')).toBeNull();
    });
  });

  describe('accessibility', () => {
    it('has nothing a screen reader cannot use', async () => {
      const t = await setup();

      expect(a11yProblems(t.element)).toEqual([]);
    });

    it('has nothing a screen reader cannot use while the import is blocked', async () => {
      const t = await setup();
      await t.act(() => t.checkbox(3).click());
      expect(t.blocker()).not.toBeNull();

      expect(a11yProblems(t.element)).toEqual([]);

      await t.click('Untick all shown rows');
      expect(textOf(t.blocker() as HTMLElement)).toBe('Tick at least one row to import.');
      expect(a11yProblems(t.element)).toEqual([]);
    });

    it('has nothing a screen reader cannot use with a failure, a refusal and a notice', async () => {
      const t = await setup();
      await t.pick(t.bulk(), '2');
      await t.click('Set budget for the ticked rows');
      expect(t.notice()).not.toBeUndefined();
      await t.click('Import 2 spendings');
      flushError(http.expectOne('/api/import/commit'), 500, 'internal_error', 'Boom');
      await settle(t.fixture);
      expect(a11yProblems(t.element)).toEqual([]);

      await t.click('Import 2 spendings');
      await answerRefusal(http, t.fixture, [{ line: 2, errors: ['duplicate'] }], {
        budgets: BUDGETS,
        rows: [{ ...COFFEE, duplicate: true }, LUNCH, SALARY, RENT, GYM, CINEMA],
      });
      expect(a11yProblems(t.element)).toEqual([]);
    });

    it.each<[string, OpenReviewOptions['budgets']]>([
      ['loading', 'loading'],
      ['failing to load', 'error'],
      ['missing', []],
    ])(
      'has nothing a screen reader cannot use while the budgets are %s',
      async (_state, budgets) => {
        const t = await setup(ROWS, { budgets });

        expect(a11yProblems(t.element)).toEqual([]);
      },
    );
  });
});
