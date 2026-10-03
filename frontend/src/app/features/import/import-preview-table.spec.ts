import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { BudgetDto, ImportPreviewRow, ImportRowErrorCode, SettingsDto } from '@wallet/shared';
import { a11yProblems } from '../../../testing/a11y';
import {
  getAllByLabel,
  getByLabel,
  getByRole,
  queryAllByRole,
  queryByRole,
  textOf,
  typeInto,
} from '../../../testing/dom';
import { budgetDto, previewRow } from '../../../testing/fixtures';
import { SETTINGS, settle } from '../../../testing/harness';
import { IMPORT_STORES } from '../../../testing/import-harness';
import { answerRefusal, openReview } from '../../../testing/import-review-helpers';
import { optionTexts, selectedText } from '../../../testing/import-steps-helpers';
import { ImportPreviewTable } from './import-preview-table';

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

/** `count` clean October rows from `first` on, each with the suggestion of Groceries (or none). */
const manyRows = (count: number, suggestedBudgetId: number | null = 1, first = 2) =>
  Array.from({ length: count }, (_, index) =>
    previewRow({ line: index + first, suggestedBudgetId }),
  );

const lineOf = (checkbox: HTMLElement) =>
  Number(/\d+$/.exec(checkbox.getAttribute('aria-label') ?? '')?.[0]);

describe('ImportPreviewTable', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ...IMPORT_STORES],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  /** The review of `rows` is open and the table is shown, as in the third step of the wizard. */
  async function setup(
    rows: ImportPreviewRow[] = ROWS,
    options: { budgets?: BudgetDto[]; settings?: SettingsDto } = {},
  ) {
    const { review } = await openReview(http, rows, {
      budgets: options.budgets ?? BUDGETS,
      settings: options.settings,
    });
    const fixture = TestBed.createComponent(ImportPreviewTable);
    fixture.detectChanges();
    await settle(fixture);
    const element = fixture.nativeElement as HTMLElement;

    const checkbox = (line: number) =>
      getByLabel<HTMLInputElement>(element, `Import line ${line}`);
    const row = (line: number) => checkbox(line).closest('tr') as HTMLTableRowElement;
    const budget = (line: number) =>
      getByLabel<HTMLSelectElement>(element, `Budget for line ${line}`);
    return {
      fixture,
      element,
      review,
      checkbox,
      row,
      budget,
      /** The text of the five cells of a row. */
      cells: (line: number) =>
        Array.from(row(line).querySelectorAll('td')).map((cell) => textOf(cell)),
      /** The lines of the rows shown, in order. */
      lines: () => queryAllByRole(element, 'checkbox').map(lineOf),
      /** The lines of the rows ticked. */
      ticked: () =>
        queryAllByRole(element, 'checkbox')
          .filter((box) => (box as HTMLInputElement).checked)
          .map(lineOf),
      pager: (name: RegExp) => getByRole(element, 'button', name) as HTMLButtonElement,
      range: () => textOf(getByRole(element, 'navigation', 'Pages of rows')),
      region: () => getByRole(element, 'region', 'Rows of the file'),
      pick: async (line: number, value: string) => {
        typeInto(budget(line), value);
        await settle(fixture);
      },
      click: async (control: HTMLElement) => {
        control.click();
        await settle(fixture);
      },
    };
  }

  describe('the rows', () => {
    it('shows each row with its date, line, description, amount and budget', async () => {
      const t = await setup();

      expect(t.cells(2).slice(1, 4)).toEqual(['Oct 1, 2026 Line 2', 'Coffee', '€3.50']);
      expect(t.cells(3).slice(1, 4)).toEqual(['Oct 2, 2026 Line 3', 'Lunch', '€12.30']);
      expect(t.cells(7).slice(1, 4)).toEqual(['Sep 15, 2026 Line 7', 'Cinema', '€11.00']);
      expect(selectedText(t.budget(2))).toBe('Groceries');
      expect(selectedText(t.budget(7))).toBe('Fun');
      expect(t.lines()).toEqual([2, 3, 4, 5, 6, 7]);
    });

    it('writes dates and amounts in the locale and currency of the settings', async () => {
      const t = await setup(
        [previewRow({ line: 2, amount: 123456, description: 'Rent', suggestedBudgetId: 1 })],
        { settings: { ...SETTINGS, locale: 'de-DE', currency: 'EUR' } },
      );

      const [, date, , amount] = t.cells(2);
      expect(date).toBe('1. Okt. 2026 Line 2');
      expect(amount).toBe('1.234,56 €');
    });

    it('shows a credit as a negative amount with a badge that says money came in', async () => {
      const t = await setup();

      const [, , description, amount] = t.cells(4);
      expect(description).toBe('Salary Credit: money in');
      expect(amount).toBe('-€2,500.00');
    });

    it('shows an amount of zero as an amount, and a missing one as "No amount"', async () => {
      const t = await setup([
        previewRow({
          line: 2,
          amount: 0,
          raw: { date: '2026-10-01', amount: '0.00' },
          errors: ['zero_amount'],
        }),
        previewRow({
          line: 3,
          amount: null,
          raw: { date: '2026-10-01', amount: 'abc' },
          errors: ['invalid_amount'],
        }),
      ]);

      expect(t.cells(2)[3]).toBe('€0.00');
      expect(t.cells(3)[3]).toBe('No amount');
    });

    it('says what the file holds when a date cannot be read, and "No date" when the cell is empty', async () => {
      const t = await setup([
        GYM,
        previewRow({
          line: 3,
          date: null,
          raw: { date: '', amount: '-1.00' },
          errors: ['invalid_date'],
        }),
      ]);

      expect(t.cells(6)[1]).toBe('31/02/2026 Line 6');
      expect(t.cells(3)[1]).toBe('No date Line 3');
    });

    it('says "No description" for an empty one', async () => {
      const t = await setup([
        previewRow({ line: 2, description: '', errors: ['empty_description'] }),
      ]);

      expect(t.cells(2)[2]).toBe('No description The description is empty');
    });

    it('shows a description as text, never as markup', async () => {
      const hostile = '<img src=x onerror=alert(1)> Shop';
      const t = await setup([previewRow({ line: 2, description: hostile, suggestedBudgetId: 1 })]);

      expect(t.cells(2)[2]).toBe(hostile);
      expect(t.element.querySelector('img')).toBeNull();
    });
  });

  describe('rows that cannot be imported', () => {
    it.each<[ImportRowErrorCode, Partial<ImportPreviewRow>, string]>([
      [
        'invalid_date',
        { date: null, raw: { date: '31/02/2026', amount: '-25.00' } },
        'The date can\'t be read in the chosen date format: "31/02/2026"',
      ],
      [
        'invalid_date',
        { date: null, raw: { date: '', amount: '-25.00' } },
        "The date can't be read in the chosen date format",
      ],
      [
        'invalid_amount',
        { amount: null, raw: { date: '2026-10-01', amount: '12.345' } },
        'The amount isn\'t a valid number: "12.345"',
      ],
      [
        'zero_amount',
        { amount: 0, raw: { date: '2026-10-01', amount: '0.00' } },
        'The amount is zero: "0.00"',
      ],
      [
        'amount_too_large',
        { amount: null, raw: { date: '2026-10-01', amount: '99999999999.99' } },
        'The amount is too large: "99999999999.99"',
      ],
      ['empty_description', { description: '' }, 'The description is empty'],
      ['before_start_month', { date: '2026-01-15' }, 'The date is before your start month'],
    ])('says in words what is wrong: %s', async (code, overrides, text) => {
      const t = await setup([previewRow({ line: 2, errors: [code], ...overrides })]);

      expect(t.cells(2)[2]).toContain(text);
      expect(t.checkbox(2).disabled).toBe(true);
    });

    it('lists every error of a row', async () => {
      const t = await setup([
        previewRow({
          line: 2,
          date: null,
          amount: null,
          description: '',
          raw: { date: 'never', amount: 'lots' },
          errors: ['invalid_date', 'invalid_amount', 'empty_description'],
        }),
      ]);

      expect(t.cells(2)[2]).toBe(
        'No description ' +
          'The date can\'t be read in the chosen date format: "never" ' +
          'The amount isn\'t a valid number: "lots" ' +
          'The description is empty',
      );
    });

    it('shows no budget picker for a row with an error, only that it is not imported', async () => {
      const t = await setup();

      expect(t.cells(6)[4]).toBe('Not imported');
      expect(queryAllByRole(t.row(6), 'combobox')).toEqual([]);
    });

    it('flags a row that was imported before and leaves it out of the selection', async () => {
      const t = await setup();

      expect(t.cells(5)[2]).toBe('Rent Already imported');
      expect(t.cells(5)[4]).toBe('Not imported');
      expect(t.checkbox(5).checked).toBe(false);
      expect(t.checkbox(5).disabled).toBe(true);
      expect(queryAllByRole(t.row(5), 'combobox')).toEqual([]);
    });

    it('cannot be ticked: a click on the box changes nothing', async () => {
      const t = await setup();
      const before = t.ticked();

      await t.click(t.checkbox(5));
      await t.click(t.checkbox(6));

      expect(t.checkbox(5).checked).toBe(false);
      expect(t.checkbox(6).checked).toBe(false);
      expect(t.ticked()).toEqual(before);
      expect(t.review.selectedCount()).toBe(before.length);
    });

    it('stays out of the selection when every row that can be imported is ticked', async () => {
      const t = await setup();

      t.review.selectMatching();
      await settle(t.fixture);

      expect(t.checkbox(5).checked).toBe(false);
      expect(t.checkbox(6).checked).toBe(false);
    });

    it('marks a row that is both a credit and already imported with both badges', async () => {
      const t = await setup([
        previewRow({ line: 2, amount: -500, credit: true, duplicate: true, description: 'Refund' }),
      ]);

      expect(t.cells(2)[2]).toBe('Refund Already imported Credit: money in');
      expect(t.checkbox(2).disabled).toBe(true);
    });
  });

  describe('which rows are ticked', () => {
    it('starts with the rows that are ready and have a suggested budget', async () => {
      const t = await setup();

      // Coffee and Cinema. Not Lunch (no suggestion), not the credit, not the duplicate or the error.
      expect(t.ticked()).toEqual([2, 7]);
    });

    it('ticks a row and unticks it again, and the store counts them', async () => {
      const t = await setup();

      await t.click(t.checkbox(3));
      expect(t.checkbox(3).checked).toBe(true);
      expect(t.review.selectedCount()).toBe(3);

      await t.click(t.checkbox(3));
      await t.click(t.checkbox(2));
      expect(t.ticked()).toEqual([7]);
      expect(t.review.selectedCount()).toBe(1);
    });

    it('lets a credit be ticked on purpose', async () => {
      const t = await setup();
      expect(t.checkbox(4).checked).toBe(false);

      await t.click(t.checkbox(4));

      expect(t.checkbox(4).checked).toBe(true);
      expect(t.ticked()).toEqual([2, 4, 7]);
    });

    it('follows the buttons that tick and untick every row that is shown', async () => {
      const t = await setup();

      t.review.selectMatching();
      await settle(t.fixture);
      // Every row that can be imported, but the credit is a decision of its own.
      expect(t.ticked()).toEqual([2, 3, 7]);

      t.review.unselectMatching();
      await settle(t.fixture);
      expect(t.ticked()).toEqual([]);
    });
  });

  describe('the budget of a row', () => {
    it('offers the budgets that are active in the month of the row, and the suggestion is chosen', async () => {
      const t = await setup();

      // October: Groceries only. Fun ended in September.
      expect(optionTexts(t.budget(2))).toEqual(['Choose a budget', 'Groceries']);
      expect(selectedText(t.budget(2))).toBe('Groceries');
      // September: both, and the suggestion is Fun.
      expect(optionTexts(t.budget(7))).toEqual(['Choose a budget', 'Groceries', 'Fun']);
      expect(selectedText(t.budget(7))).toBe('Fun');
    });

    it('asks to choose when nothing is suggested', async () => {
      const t = await setup();

      expect(selectedText(t.budget(3))).toBe('Choose a budget');
      expect(t.budget(3).value).toBe('');
    });

    it('offers the budgets also for a credit, with its suggestion', async () => {
      const t = await setup();

      expect(selectedText(t.budget(4))).toBe('Groceries');
    });

    it('changes the budget of a row, and ticks a row that was not', async () => {
      const t = await setup();
      expect(t.checkbox(3).checked).toBe(false);

      await t.pick(3, '1');

      expect(selectedText(t.budget(3))).toBe('Groceries');
      expect(t.checkbox(3).checked).toBe(true);
      expect(t.review.commitBlocker()).toBeNull();
    });

    it('moves a row to another budget without touching the others', async () => {
      const t = await setup();

      await t.pick(7, '1');

      expect(selectedText(t.budget(7))).toBe('Groceries');
      expect(selectedText(t.budget(2))).toBe('Groceries');
      expect(t.ticked()).toEqual([2, 7]);
    });

    it('does not tick a credit when its budget is picked: money in is ticked on purpose', async () => {
      const t = await setup();

      await t.pick(4, '1');

      expect(t.checkbox(4).checked).toBe(false);
    });

    it('keeps a ticked row ticked when its budget is cleared, and the import is then blocked', async () => {
      const t = await setup();

      await t.pick(2, '');

      expect(selectedText(t.budget(2))).toBe('Choose a budget');
      expect(t.checkbox(2).checked).toBe(true);
      expect(t.review.commitBlocker()).toBe('1 ticked row needs a budget before you can import.');
    });

    it('turns the picker off and says why when no budget is active in the month', async () => {
      // Fun is the only budget, and it was active in September only.
      const t = await setup([previewRow({ line: 2, description: 'Coffee' })], { budgets: [FUN] });

      expect(t.budget(2).disabled).toBe(true);
      expect(optionTexts(t.budget(2))).toEqual(['No budget is active in October 2026']);
      expect(t.checkbox(2).checked).toBe(false);
    });
  });

  describe('focus when a row leaves the list', () => {
    /** Three October rows with no budget, shown in the filter of the rows that need one. */
    async function needsBudget(rows: ImportPreviewRow[] = manyRows(3, null)) {
      const t = await setup(rows, { budgets: [GROCERIES] });
      t.review.setFilter('needs-budget');
      await settle(t.fixture);
      return t;
    }

    it('moves to the select that takes the place of the one that went, so the list can be worked down', async () => {
      const t = await needsBudget();
      expect(t.lines()).toEqual([2, 3, 4]);

      await t.pick(3, '1');

      expect(t.lines()).toEqual([2, 4]);
      expect(document.activeElement).toBe(t.budget(4));
    });

    it('moves up to the select above when the last row went', async () => {
      const t = await needsBudget();

      await t.pick(4, '1');

      expect(t.lines()).toEqual([2, 3]);
      expect(document.activeElement).toBe(t.budget(3));
    });

    it('moves to the table when it was the only row, so focus is not lost with it', async () => {
      const t = await needsBudget([previewRow({ line: 2 })]);

      await t.pick(2, '1');

      expect(textOf(t.element)).toContain('No rows match this filter.');
      expect(document.activeElement).toBe(t.region());
    });

    it('leaves focus where it is when the row stays in the list', async () => {
      const t = await setup(manyRows(3, null), { budgets: [GROCERIES] });

      await t.pick(3, '1');

      expect(t.lines()).toEqual([2, 3, 4]);
      expect(document.activeElement).toBe(t.budget(3));
    });
  });

  describe('pages', () => {
    it('shows the range of rows that are shown, with no pager for a single page', async () => {
      const t = await setup();

      expect(t.range()).toBe('Rows 1 to 6 of 6');
      expect(queryByRole(t.element, 'button', /^(Previous|Next)/)).toBeNull();
    });

    it('shows 100 rows at a time and moves through the pages with focus on the table', async () => {
      const t = await setup(manyRows(250));

      expect(t.range()).toContain('Rows 1 to 100 of 250');
      expect(t.lines()).toHaveLength(100);
      expect(t.lines()[0]).toBe(2);
      expect(t.pager(/^Previous 100$/).disabled).toBe(true);

      await t.click(t.pager(/^Next 100$/));
      expect(t.range()).toContain('Rows 101 to 200 of 250');
      expect(t.lines()).toHaveLength(100);
      expect(t.lines()[0]).toBe(102);
      expect(document.activeElement).toBe(t.region());

      await t.click(t.pager(/^Next 100$/));
      expect(t.range()).toContain('Rows 201 to 250 of 250');
      expect(t.lines()).toHaveLength(50);
      expect(t.pager(/^Next 100$/).disabled).toBe(true);
      expect(t.pager(/^Previous 100$/).disabled).toBe(false);

      await t.click(t.pager(/^Previous 100$/));
      expect(t.range()).toContain('Rows 101 to 200 of 250');
      expect(document.activeElement).toBe(t.region());
    });

    it('writes the numbers of the range in the locale of the settings', async () => {
      const t = await setup(manyRows(1203), { settings: { ...SETTINGS, locale: 'de-DE' } });

      expect(t.range()).toContain('Rows 1 to 100 of 1.203');
    });

    it('keeps what was ticked on a page when the user comes back to it', async () => {
      const t = await setup(manyRows(150, null), { budgets: [GROCERIES] });
      await t.pick(2, '1');
      await t.click(t.pager(/^Next 100$/));
      await t.pick(151, '1');

      await t.click(t.pager(/^Previous 100$/));
      expect(t.checkbox(2).checked).toBe(true);
      expect(selectedText(t.budget(2))).toBe('Groceries');

      await t.click(t.pager(/^Next 100$/));
      expect(t.checkbox(151).checked).toBe(true);
      expect(t.review.selectedCount()).toBe(2);
    });

    it('says so when no row matches the filter', async () => {
      const t = await setup([COFFEE, LUNCH]);

      t.review.setFilter('errors');
      await settle(t.fixture);

      expect(t.lines()).toEqual([]);
      expect(textOf(t.element)).toContain('No rows match this filter.');
      expect(t.range()).toBe('No rows');
      expect(queryByRole(t.element, 'button', /^(Previous|Next)/)).toBeNull();
    });
  });

  describe('rows the server refused', () => {
    it('names them with the reasons, and the table is current after the refusal', async () => {
      const t = await setup();
      void t.review.commit();
      await settle(t.fixture);

      await answerRefusal(
        http,
        t.fixture,
        [
          { line: 2, errors: ['duplicate'] },
          { line: 7, errors: ['unknown_budget', 'some_future_code'] },
        ],
        { budgets: BUDGETS, rows: [{ ...COFFEE, duplicate: true }, LUNCH, SALARY, RENT, GYM, CINEMA] },
      );

      expect(t.cells(2)[2]).toBe(
        'Coffee Already imported Refused by the server: It was imported already',
      );
      expect(t.cells(7)[2]).toBe(
        "Cinema Refused by the server: That budget doesn't exist any more; some_future_code",
      );
      // Coffee is a duplicate now: it is no longer ticked, and cannot be.
      expect(t.checkbox(2).checked).toBe(false);
      expect(t.checkbox(2).disabled).toBe(true);
    });
  });

  describe('accessibility', () => {
    it('labels the table, its columns, and every checkbox and picker by its line', async () => {
      const t = await setup();

      // Reachable by keyboard, so that a table wider than the screen can be scrolled.
      expect(t.region().getAttribute('tabindex')).toBe('0');
      expect(
        getByRole(t.element, 'table', /^Rows of the file: tick the ones to import/),
      ).toBeTruthy();
      expect(queryAllByRole(t.element, 'columnheader').map(textOf)).toEqual([
        'Import',
        'Date',
        'Description',
        'Amount',
        'Budget',
      ]);
      expect(getAllByLabel(t.element, /^Import line \d+$/)).toHaveLength(6);
      // Only the rows that can be imported have a picker.
      expect(getAllByLabel(t.element, /^Budget for line \d+$/)).toHaveLength(4);
    });

    it('has nothing a screen reader cannot use, with every kind of row, a pager and a refusal', async () => {
      const rows = [...ROWS, ...manyRows(120, 1, 12)];
      const t = await setup(rows);
      expect(t.pager(/^Next 100$/)).toBeTruthy();
      expect(a11yProblems(t.element)).toEqual([]);

      void t.review.commit();
      await settle(t.fixture);
      await answerRefusal(http, t.fixture, [{ line: 2, errors: ['duplicate'] }], {
        budgets: BUDGETS,
        rows,
      });

      expect(textOf(t.element)).toContain('Refused by the server');
      expect(a11yProblems(t.element)).toEqual([]);
    });

    it('has nothing a screen reader cannot use when no row is shown', async () => {
      const t = await setup([COFFEE]);
      t.review.setFilter('errors');
      await settle(t.fixture);

      expect(textOf(t.element)).toContain('No rows match this filter.');
      expect(a11yProblems(t.element)).toEqual([]);
    });
  });
});
