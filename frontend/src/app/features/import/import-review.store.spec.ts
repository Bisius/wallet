import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { BudgetDto, ImportPreviewRow } from '@wallet/shared';
import {
  budgetDto,
  importMapping,
  parseResponse,
  previewResponse,
  previewRow,
  savingsDto,
} from '../../../testing/fixtures';
import { flushError, settle } from '../../../testing/harness';
import {
  answerBudgets,
  chooseFile,
  csvFile,
  IMPORT_STORES,
  setupWizard,
} from '../../../testing/import-harness';
import { SavingsStore } from '../../core/savings.store';
import { budgetsActiveIn, ImportReviewStore, isSelectable, PAGE_SIZE } from './import-review.store';
import { ImportWizardStore } from './import-wizard.store';

const TEXT = 'Date;Amount;Description\n';

const GROCERIES = budgetDto({ id: 1, name: 'Groceries', startMonth: '2026-06' });
const FUN = budgetDto({ id: 2, name: 'Fun', startMonth: '2026-09', endMonth: '2026-09' });
const TRAVEL = budgetDto({ id: 3, name: 'Travel', startMonth: '2026-11' });
const BUDGETS = [GROCERIES, FUN, TRAVEL];

const READY = previewRow({ line: 2, description: 'Coffee', suggestedBudgetId: 1 });
const NO_SUGGESTION = previewRow({ line: 3, description: 'Lunch', amount: 1230 });
const CREDIT = previewRow({
  line: 4,
  description: 'Salary',
  amount: -250000,
  credit: true,
  suggestedBudgetId: 1,
});
const DUPLICATE = previewRow({
  line: 5,
  description: 'Rent',
  amount: 90000,
  duplicate: true,
  suggestedBudgetId: 1,
});
const BROKEN = previewRow({
  line: 6,
  description: 'Gym',
  date: null,
  amount: 2500,
  raw: { date: '31/02/2026', amount: '-25.00' },
  errors: ['invalid_date'],
});
const SEPTEMBER = previewRow({
  line: 7,
  description: 'Cinema',
  date: '2026-09-15',
  amount: 1100,
  suggestedBudgetId: 2,
});
const ROWS = [READY, NO_SUGGESTION, CREDIT, DUPLICATE, BROKEN, SEPTEMBER];

describe('ImportReviewStore', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ...IMPORT_STORES],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  /** A file read, its columns mapped, the budgets loaded and the preview of `rows` open. */
  async function open(rows: ImportPreviewRow[] = ROWS, budgets: BudgetDto[] = BUDGETS) {
    const wizard = await setupWizard(http);
    const review = TestBed.inject(ImportReviewStore);
    await chooseFile(http, wizard, csvFile(TEXT), parseResponse({ recordCount: rows.length + 1 }));
    await answerBudgets(http, budgets);
    wizard.goTo('mapping');
    wizard.patchMapping({ dateColumn: 0, amountColumn: 1, descriptionColumn: 2 });
    const opening = review.openPreview();
    await settle();
    http.expectOne('/api/import/preview').flush(previewResponse(rows));
    await opening;
    await settle();
    return { wizard, review };
  }

  const lines = (rows: readonly ImportPreviewRow[]) => rows.map((row) => row.line);

  describe('opening the preview', () => {
    it('asks the server to judge the file with the mapping, and moves to the review', async () => {
      const wizard = await setupWizard(http);
      const review = TestBed.inject(ImportReviewStore);
      await chooseFile(http, wizard, csvFile(TEXT));
      await answerBudgets(http, BUDGETS);
      wizard.goTo('mapping');
      wizard.patchMapping({ dateColumn: 0, amountColumn: 1, descriptionColumn: 2 });

      const opening = review.openPreview();
      await settle();
      expect(review.previewing()).toBe(true);
      const request = http.expectOne('/api/import/preview');
      expect(request.request.body).toEqual({ csv: TEXT, mapping: wizard.mapping() });
      expect(request.request.body.mapping).toEqual(importMapping());
      request.flush(previewResponse(ROWS));

      expect(await opening).toBe(true);
      expect(review.previewing()).toBe(false);
      expect(wizard.step()).toBe('preview');
      expect(review.summary()).toEqual(previewResponse(ROWS).summary);
    });

    it('does not ask without a valid mapping', async () => {
      const wizard = await setupWizard(http);
      const review = TestBed.inject(ImportReviewStore);
      await chooseFile(http, wizard, csvFile(TEXT));
      await answerBudgets(http, BUDGETS);
      wizard.goTo('mapping');

      expect(await review.openPreview()).toBe(false);

      http.expectNone('/api/import/preview');
      expect(wizard.step()).toBe('mapping');
    });

    it('stays on the mapping and says why when the server refuses the file', async () => {
      const wizard = await setupWizard(http);
      const review = TestBed.inject(ImportReviewStore);
      await chooseFile(http, wizard, csvFile(TEXT));
      await answerBudgets(http, BUDGETS);
      wizard.goTo('mapping');
      wizard.patchMapping({ dateColumn: 0, amountColumn: 1, descriptionColumn: 2 });

      const opening = review.openPreview();
      await settle();
      flushError(
        http.expectOne('/api/import/preview'),
        400,
        'validation_error',
        'A quote is never closed on line 9',
      );

      expect(await opening).toBe(false);
      expect(wizard.step()).toBe('mapping');
      expect(review.previewError()).toBe('A quote is never closed on line 9');
      expect(review.preview()).toBeNull();
      expect(review.previewing()).toBe(false);
    });

    it('keeps the preview and the choices when the user goes Back and forward without changing the mapping', async () => {
      const { wizard, review } = await open();
      review.toggle(NO_SUGGESTION.line, true);
      review.setBudget(NO_SUGGESTION.line, 1);
      wizard.back();

      expect(await review.openPreview()).toBe(true);

      http.expectNone('/api/import/preview');
      expect(wizard.step()).toBe('preview');
      expect(review.isChecked(NO_SUGGESTION.line)).toBe(true);
      expect(review.budgetFor(NO_SUGGESTION)).toBe(1);
    });

    it('asks again, with a fresh start, when the mapping changed', async () => {
      const { wizard, review } = await open();
      review.toggle(NO_SUGGESTION.line, true);
      wizard.back();
      wizard.patchMapping({ decimalSeparator: ',' });

      const opening = review.openPreview();
      await settle();
      const request = http.expectOne('/api/import/preview');
      expect(request.request.body.mapping.decimalSeparator).toBe(',');
      request.flush(previewResponse(ROWS));
      await opening;

      expect(review.isChecked(NO_SUGGESTION.line)).toBe(false);
      expect(review.isChecked(READY.line)).toBe(true);
    });

    it('forgets everything when another file is chosen', async () => {
      const { wizard, review } = await open();
      expect(review.preview()).not.toBeNull();

      wizard.reset();
      await settle();

      expect(review.preview()).toBeNull();
      expect(review.selectedCount()).toBe(0);
    });
  });

  describe('the default choices', () => {
    it('ticks the rows that are ready to import and have a suggested budget, and nothing else', async () => {
      const { review } = await open();

      // Ready with a suggestion, and the September one with its own. Not: no suggestion, a credit
      // (even with a suggestion), a duplicate, an error.
      expect([...review.checked()].sort()).toEqual([2, 7]);
      expect(review.selectedCount()).toBe(2);
      expect(review.selectedWithoutBudget()).toBe(0);
    });

    it('shows the suggested budget of each row', async () => {
      const { review } = await open();

      expect(review.budgetFor(READY)).toBe(1);
      expect(review.budgetFor(NO_SUGGESTION)).toBeNull();
      expect(review.budgetFor(SEPTEMBER)).toBe(2);
    });

    it('does not let a duplicate or a row with an error be ticked', async () => {
      const { review } = await open();

      review.toggle(DUPLICATE.line, true);
      review.toggle(BROKEN.line, true);

      expect(review.isChecked(DUPLICATE.line)).toBe(false);
      expect(review.isChecked(BROKEN.line)).toBe(false);
      expect(isSelectable(DUPLICATE)).toBe(false);
      expect(isSelectable(BROKEN)).toBe(false);
      expect(isSelectable(CREDIT)).toBe(true);
    });

    it('lets a credit be ticked on purpose, and then it needs a budget it already suggests', async () => {
      const { review } = await open();

      review.toggle(CREDIT.line, true);

      expect(review.isChecked(CREDIT.line)).toBe(true);
      expect(review.selectedCount()).toBe(3);
      expect(review.selectedTotal()).toBe(350 + 1100 - 250000);
    });

    it('unticks a row', async () => {
      const { review } = await open();

      review.toggle(READY.line, false);

      expect(review.isChecked(READY.line)).toBe(false);
      expect(review.selectedCount()).toBe(1);
    });
  });

  describe('budgets', () => {
    it('offers the budgets active in the month of each row', async () => {
      const { review } = await open();

      // October: Groceries (from June) only. Fun ended in September and Travel starts in November.
      expect(review.optionsFor(READY).map((budget) => budget.name)).toEqual(['Groceries']);
      // September: Groceries and Fun.
      expect(review.optionsFor(SEPTEMBER).map((budget) => budget.name)).toEqual([
        'Groceries',
        'Fun',
      ]);
      // No date, no choice.
      expect(review.optionsFor(BROKEN)).toEqual([]);
    });

    it('picking a budget for a ready row ticks it', async () => {
      const { review } = await open();
      expect(review.isChecked(NO_SUGGESTION.line)).toBe(false);

      review.setBudget(NO_SUGGESTION.line, 1);

      expect(review.budgetFor(NO_SUGGESTION)).toBe(1);
      expect(review.isChecked(NO_SUGGESTION.line)).toBe(true);
    });

    it('picking a budget for a credit does not tick it: credits are ticked on purpose', async () => {
      const { review } = await open();

      review.setBudget(CREDIT.line, 1);

      expect(review.isChecked(CREDIT.line)).toBe(false);
    });

    it('clearing the budget of a ticked row keeps it ticked and blocks the import', async () => {
      const { review } = await open();

      review.setBudget(READY.line, null);

      expect(review.budgetFor(READY)).toBeNull();
      expect(review.isChecked(READY.line)).toBe(true);
      expect(review.selectedWithoutBudget()).toBe(1);
      expect(review.canCommit()).toBe(false);
    });

    it('sets the budget of the ticked rows, leaving those it is not active for, and says so', async () => {
      const { review } = await open();
      review.toggle(NO_SUGGESTION.line, true);
      // Fun is active in September only: the October rows keep their budget.
      review.applyBudgetToSelected(2);

      expect(review.budgetFor(SEPTEMBER)).toBe(2);
      expect(review.budgetFor(READY)).toBe(1);
      expect(review.budgetFor(NO_SUGGESTION)).toBeNull();
      expect(review.bulkNotice()).toBe(
        'Fun set for 1 row. 2 rows kept their budget, because Fun is not active in their month.',
      );
    });

    it('sets one budget on every ticked row when it is active in all their months', async () => {
      const { review } = await open();
      review.toggle(NO_SUGGESTION.line, true);

      review.applyBudgetToSelected(1);

      for (const row of [READY, NO_SUGGESTION, SEPTEMBER]) expect(review.budgetFor(row)).toBe(1);
      expect(review.bulkNotice()).toBe('Groceries set for 3 rows.');
      expect(review.selectedWithoutBudget()).toBe(0);
    });

    it('budgetsActiveIn uses the first and last month of a budget, inclusive', () => {
      expect(budgetsActiveIn(BUDGETS, '2026-06').map((b) => b.id)).toEqual([1]);
      expect(budgetsActiveIn(BUDGETS, '2026-09').map((b) => b.id)).toEqual([1, 2]);
      expect(budgetsActiveIn(BUDGETS, '2026-10').map((b) => b.id)).toEqual([1]);
      expect(budgetsActiveIn(BUDGETS, '2026-11').map((b) => b.id)).toEqual([1, 3]);
      expect(budgetsActiveIn(BUDGETS, '2026-05')).toEqual([]);
    });
  });

  describe('filters and pages', () => {
    it('counts the rows of each filter', async () => {
      const { review } = await open();

      expect(review.filterCounts()).toEqual({
        all: 6,
        importable: 3, // READY, NO_SUGGESTION, SEPTEMBER
        'needs-budget': 1, // NO_SUGGESTION: no error, not a duplicate, no budget (the credit has one)
        duplicates: 1,
        credits: 1,
        errors: 1,
      });
    });

    it.each([
      ['all', [2, 3, 4, 5, 6, 7]],
      ['importable', [2, 3, 7]],
      ['needs-budget', [3]],
      ['duplicates', [5]],
      ['credits', [4]],
      ['errors', [6]],
    ] as const)('shows the rows of the %s filter', async (filter, expected) => {
      const { review } = await open();

      review.setFilter(filter);

      expect(lines(review.filteredRows())).toEqual(expected);
    });

    it('"needs a budget" follows the choices: a row leaves it when it gets a budget', async () => {
      const { review } = await open();
      review.setFilter('needs-budget');
      expect(lines(review.filteredRows())).toEqual([3]);

      review.setBudget(3, 1);

      expect(lines(review.filteredRows())).toEqual([]);
      expect(review.filterCounts()['needs-budget']).toBe(0);
    });

    it('a ticked credit without a budget is in "needs a budget"', async () => {
      const { review } = await open([READY, { ...CREDIT, suggestedBudgetId: null }]);
      review.toggle(CREDIT.line, true);

      // A credit is not importable by default, but once ticked it needs a budget like any row.
      expect(review.selectedWithoutBudget()).toBe(1);
      expect(review.commitBlocker()).toBe('1 ticked row needs a budget before you can import.');
    });

    it('shows pages of 100 rows and never a page past the last one', async () => {
      const many = Array.from({ length: 250 }, (_, index) =>
        previewRow({ line: index + 2, suggestedBudgetId: 1 }),
      );
      const { review } = await open(many);

      expect(review.pageCount()).toBe(3);
      expect(review.page()).toBe(0);
      expect(review.pageRows()).toHaveLength(PAGE_SIZE);
      expect(review.pageRows()[0].line).toBe(2);

      review.goToPage(2);
      expect(review.pageRows()).toHaveLength(50);
      expect(review.pageRows()[0].line).toBe(202);

      review.goToPage(9);
      expect(review.page()).toBe(2);
      review.goToPage(-4);
      expect(review.page()).toBe(0);
    });

    it('goes back to the first page when the filter changes, and clamps when the filter gets shorter', async () => {
      const many = Array.from({ length: 250 }, (_, index) =>
        previewRow({ line: index + 2, suggestedBudgetId: index < 10 ? 1 : null }),
      );
      const { review } = await open(many);
      review.goToPage(2);

      review.setFilter('needs-budget');

      expect(review.page()).toBe(0);
      expect(review.filteredRows()).toHaveLength(240);
      review.goToPage(2);
      // 235 rows left in the filter: the third page is the last, with 35.
      for (let line = 12; line < 17; line++) review.setBudget(line, 1);
      expect(review.pageCount()).toBe(3);
      for (let line = 17; line < 120; line++) review.setBudget(line, 1);
      expect(review.pageCount()).toBe(2);
      expect(review.page()).toBe(1);
    });

    it('ticks every selectable row of the filter, on every page, but not credits unless they are what is shown', async () => {
      const many = Array.from({ length: 150 }, (_, index) => previewRow({ line: index + 10 }));
      const { review } = await open([...many, CREDIT, DUPLICATE, BROKEN]);

      review.selectMatching();

      expect(review.selectedCount()).toBe(150);
      expect(review.isChecked(CREDIT.line)).toBe(false);
      expect(review.isChecked(DUPLICATE.line)).toBe(false);
      expect(review.isChecked(BROKEN.line)).toBe(false);

      review.setFilter('credits');
      review.selectMatching();
      expect(review.isChecked(CREDIT.line)).toBe(true);
    });

    it('unticks every row of the filter, and only those', async () => {
      const { review } = await open();
      review.toggle(CREDIT.line, true);

      review.setFilter('credits');
      review.unselectMatching();

      expect(review.isChecked(CREDIT.line)).toBe(false);
      expect(review.isChecked(READY.line)).toBe(true);
      expect(review.isChecked(SEPTEMBER.line)).toBe(true);
    });
  });

  describe('the numbers', () => {
    it('counts the ticked rows and adds their amounts in spending sign', async () => {
      const { review } = await open();

      expect(review.selectedCount()).toBe(2);
      expect(review.selectedTotal()).toBe(350 + 1100);
    });

    it('says why Import is off, and turns it on when it can be used', async () => {
      const { review } = await open();
      review.unselectMatching();
      expect(review.selectedCount()).toBe(0);
      expect(review.commitBlocker()).toBe('Tick at least one row to import.');
      expect(review.canCommit()).toBe(false);

      review.toggle(NO_SUGGESTION.line, true);
      expect(review.commitBlocker()).toBe('1 ticked row needs a budget before you can import.');
      expect(review.canCommit()).toBe(false);

      review.setBudget(NO_SUGGESTION.line, 1);
      expect(review.commitBlocker()).toBeNull();
      expect(review.canCommit()).toBe(true);
    });

    it('counts several rows without a budget', async () => {
      const { review } = await open();
      review.toggle(NO_SUGGESTION.line, true);
      review.toggle(CREDIT.line, true);
      review.setBudget(CREDIT.line, null);
      review.setBudget(NO_SUGGESTION.line, null);

      expect(review.commitBlocker()).toBe('2 ticked rows need a budget before you can import.');
    });
  });

  describe('importing', () => {
    it('sends the file, the mapping and only line and budget of the ticked rows, ascending by line', async () => {
      const { wizard, review } = await open();
      review.toggle(NO_SUGGESTION.line, true);
      review.setBudget(NO_SUGGESTION.line, 1);
      review.setBudget(SEPTEMBER.line, 1);

      const committing = review.commit();
      await settle();
      expect(review.committing()).toBe(true);
      expect(review.canCommit()).toBe(false);
      const request = http.expectOne('/api/import/commit');
      expect(request.request.body).toEqual({
        csv: TEXT,
        mapping: wizard.mapping(),
        rows: [
          { line: 2, budgetId: 1 },
          { line: 3, budgetId: 1 },
          { line: 7, budgetId: 1 },
        ],
      });
      request.flush({
        created: 3,
        items: [
          { line: 2, id: 1 },
          { line: 3, id: 2 },
          { line: 7, id: 3 },
        ],
      });
      await committing;

      expect(review.committing()).toBe(false);
      expect(review.result()).toEqual({ created: 3, months: ['2026-09', '2026-10'] });
      expect(wizard.step()).toBe('done');
      expect(wizard.hasWork()).toBe(false);
    });

    it('does nothing when Import is off', async () => {
      const { review } = await open();
      review.unselectMatching();

      await review.commit();

      http.expectNone('/api/import/commit');
    });

    it('asks for the savings overview again when a month before the current one was touched (the badge)', async () => {
      const { review } = await open();
      // The shell would have the store already; here it is created by the import.
      const committing = review.commit();
      await settle();
      http.expectOne('/api/import/commit').flush({
        created: 2,
        items: [
          { line: 2, id: 1 },
          { line: 7, id: 2 },
        ],
      });
      await committing;
      await settle();

      // September is before the current month (October).
      http.expectOne('/api/savings').flush(savingsDto());
      expect(TestBed.inject(SavingsStore).savings()).toBeUndefined();
    });

    it('leaves the savings overview alone when only the current month was touched', async () => {
      const { review } = await open();
      review.toggle(SEPTEMBER.line, false);

      const committing = review.commit();
      await settle();
      http.expectOne('/api/import/commit').flush({ created: 1, items: [{ line: 2, id: 1 }] });
      await committing;
      await settle();

      expect(review.result()?.months).toEqual(['2026-10']);
      http.expectNone('/api/savings');
    });

    describe('when the server refuses some rows (422)', () => {
      const REJECTION = {
        rows: [
          { line: 2, errors: ['duplicate'] },
          { line: 3, errors: ['unknown_budget'] },
          { line: 7, errors: ['outside_active_months'] },
        ],
      };

      async function refused() {
        const { wizard, review } = await open();
        review.toggle(NO_SUGGESTION.line, true);
        review.setBudget(NO_SUGGESTION.line, 3);
        const committing = review.commit();
        await settle();
        flushError(
          http.expectOne('/api/import/commit'),
          422,
          'import_rows_rejected',
          '3 of the listed rows were refused',
          REJECTION,
        );
        await settle();
        return { wizard, review, committing };
      }

      it('keeps the rejected lines with their codes, loads the budgets and the preview again, and stays on the review', async () => {
        const { wizard, review, committing } = await refused();

        // The budgets may have changed (one was deleted) and the preview is the truth about duplicates.
        http.expectOne('/api/budgets').flush([GROCERIES, FUN]);
        await settle();
        http
          .expectOne('/api/import/preview')
          .flush(
            previewResponse([
              { ...READY, duplicate: true },
              NO_SUGGESTION,
              CREDIT,
              DUPLICATE,
              BROKEN,
              SEPTEMBER,
            ]),
          );
        await committing;
        await settle();

        expect(review.rejected()).toEqual([
          { line: 2, codes: ['duplicate'] },
          { line: 3, codes: ['unknown_budget'] },
          { line: 7, codes: ['outside_active_months'] },
        ]);
        expect(wizard.step()).toBe('preview');
        expect(review.result()).toBeNull();
        expect(review.commitFailure()).toBeNull();
        expect(review.committing()).toBe(false);
      });

      it('makes the table current: a row that became a duplicate is unticked, a budget that is gone is cleared', async () => {
        const { review, committing } = await refused();

        http.expectOne('/api/budgets').flush([GROCERIES, FUN]);
        await settle();
        http
          .expectOne('/api/import/preview')
          .flush(
            previewResponse([
              { ...READY, duplicate: true },
              NO_SUGGESTION,
              CREDIT,
              DUPLICATE,
              BROKEN,
              SEPTEMBER,
            ]),
          );
        await committing;
        await settle();

        expect(review.isChecked(READY.line)).toBe(false);
        // Line 3 stays ticked with the budget the user picked, which does not exist any more: it needs another.
        expect(review.isChecked(NO_SUGGESTION.line)).toBe(true);
        expect(review.budgetFor(NO_SUGGESTION)).toBeNull();
        expect(review.canCommit()).toBe(false);
        expect(review.commitBlocker()).toBe('1 ticked row needs a budget before you can import.');
        // The rest is kept.
        expect(review.isChecked(SEPTEMBER.line)).toBe(true);
      });

      it('lets the user fix the row and try again', async () => {
        const { wizard, review, committing } = await refused();
        http.expectOne('/api/budgets').flush([GROCERIES, FUN]);
        await settle();
        http
          .expectOne('/api/import/preview')
          .flush(previewResponse([READY, NO_SUGGESTION, CREDIT, DUPLICATE, BROKEN, SEPTEMBER]));
        await committing;
        await settle();

        review.setBudget(NO_SUGGESTION.line, 1);
        const again = review.commit();
        await settle();
        const request = http.expectOne('/api/import/commit');
        expect(request.request.body.rows).toEqual([
          { line: 2, budgetId: 1 },
          { line: 3, budgetId: 1 },
          { line: 7, budgetId: 2 },
        ]);
        request.flush({ created: 3, items: [] });
        await again;

        expect(review.rejected()).toEqual([]);
        expect(wizard.step()).toBe('done');
      });
    });

    it('shows a 400 with a message and says nothing was stored, without asking for the preview again', async () => {
      const { wizard, review } = await open();

      const committing = review.commit();
      await settle();
      flushError(
        http.expectOne('/api/import/commit'),
        400,
        'validation_error',
        'A quote is never closed on line 9',
      );
      await committing;

      expect(review.commitFailure()).toEqual({
        status: 400,
        message: 'A quote is never closed on line 9',
      });
      expect(review.rejected()).toEqual([]);
      expect(wizard.step()).toBe('preview');
      expect(review.canCommit()).toBe(true);
      http.expectNone('/api/import/preview');
    });

    it('shows a 413', async () => {
      const { review } = await open();

      const committing = review.commit();
      await settle();
      flushError(
        http.expectOne('/api/import/commit'),
        413,
        'payload_too_large',
        'Request body too large',
        {
          limitBytes: 10485760,
        },
      );
      await committing;

      expect(review.commitFailure()).toMatchObject({
        status: 413,
        message: 'Request body too large',
      });
    });

    it('shows a network failure as one, so the user can try again', async () => {
      const { review } = await open();

      const committing = review.commit();
      await settle();
      http.expectOne('/api/import/commit').error(new ProgressEvent('error'));
      await committing;

      expect(review.commitFailure()?.status).toBe(0);
      expect(review.canCommit()).toBe(true);
    });

    it('clears an earlier failure when it tries again', async () => {
      const { review } = await open();
      let committing = review.commit();
      await settle();
      flushError(http.expectOne('/api/import/commit'), 500, 'internal_error', 'Boom');
      await committing;
      expect(review.commitFailure()).not.toBeNull();

      committing = review.commit();
      await settle();
      expect(review.commitFailure()).toBeNull();
      http.expectOne('/api/import/commit').flush({ created: 2, items: [] });
      await committing;
    });
  });
});
