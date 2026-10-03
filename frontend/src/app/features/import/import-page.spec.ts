import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, viewChild } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, RouterOutlet, type Routes } from '@angular/router';
import { importCommitSchema, type ImportPreviewRow } from '@wallet/shared';
import { a11yProblems } from '../../../testing/a11y';
import {
  getByLabel,
  getByRole,
  queryAllByRole,
  textOf,
  typeInto,
} from '../../../testing/dom';
import {
  budgetDto,
  importMapping,
  parseResponse,
  previewResponse,
  previewRow,
} from '../../../testing/fixtures';
import { flushError, primeStores, settle, StubPage } from '../../../testing/harness';
import {
  answerBudgets,
  chooseFile,
  csvFile,
  IMPORT_STORES,
  setupWizard,
} from '../../../testing/import-harness';
import { answerSavingsRefresh, openReview } from '../../../testing/import-review-helpers';
import { pickFile, selectedText } from '../../../testing/import-steps-helpers';
import { canLeaveGuard } from '../../core/guards';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog';
import { ImportPage } from './import-page';
import { ImportReviewStore } from './import-review.store';
import { ImportWizardStore, type WizardStep } from './import-wizard.store';

const GROCERIES = budgetDto({ id: 1, name: 'Groceries', startMonth: '2026-06' });
const BUDGETS = [GROCERIES];

const CSV = 'Date;Amount;Description\n2026-10-01;-3.50;Coffee\n2026-10-02;-12.30;Lunch\n2026-10-03;2500.00;Salary\n';
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
});
const ROWS = [COFFEE, LUNCH, SALARY];

/** What `parse` says about `CSV`: a header and three data rows. */
const PARSED = parseResponse({
  recordCount: 4,
  sample: [
    { line: 2, cells: ['2026-10-01', '-3.50', 'Coffee'] },
    { line: 3, cells: ['2026-10-02', '-12.30', 'Lunch'] },
    { line: 4, cells: ['2026-10-03', '2500.00', 'Salary'] },
  ],
});

const HEADINGS: Record<WizardStep, string> = {
  file: "Choose your bank's file",
  mapping: 'How is the file laid out?',
  preview: 'Review the rows',
  done: 'Import complete',
};

/** The page with the question that asks before the user leaves it. */
@Component({
  selector: 'app-page-host',
  imports: [ImportPage, ConfirmDialog],
  template: '<app-import-page /><app-confirm-dialog />',
})
class PageHost {
  readonly page = viewChild.required(ImportPage);
}

/** The page as the router shows it, behind the guard that asks before the user leaves it. */
@Component({
  selector: 'app-routed-host',
  imports: [RouterOutlet, ConfirmDialog],
  template: '<router-outlet /><app-confirm-dialog />',
})
class RoutedHost {}

const dialogOf = (element: HTMLElement) => getByRole(element, 'dialog') as HTMLDialogElement;

/** The stepper: each step with the state a screen reader hears. */
function stepper(element: HTMLElement) {
  const items = queryAllByRole(getByRole(element, 'navigation', 'Import progress'), 'listitem');
  return {
    labels: items.map(textOf),
    current: items.map((item) => item.getAttribute('aria-current')),
  };
}

/** The headings of the step that is shown (the `h2` of a step), without the title of the page. */
const stepHeadings = (element: HTMLElement) =>
  queryAllByRole(element, 'heading')
    .filter((heading) => heading.tagName === 'H2')
    .map(textOf);

describe('ImportPage, with the stores of the test', () => {
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
    // The page provides its own stores, which a spec cannot reach. Without them the page uses the
    // ones of the test, so the spec can move the wizard through the real stores.
    TestBed.overrideComponent(ImportPage, { set: { providers: [] } });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  /** Brings the stores to `step` (the way a user gets there), then shows the page. */
  async function arrive(step: WizardStep, rows: ImportPreviewRow[] = ROWS) {
    let wizard: ImportWizardStore;
    let review: ImportReviewStore;
    if (step === 'file') {
      wizard = await setupWizard(http);
      review = TestBed.inject(ImportReviewStore);
    } else {
      ({ wizard, review } = await openReview(http, rows, { budgets: BUDGETS }));
      if (step === 'mapping') wizard.back();
      if (step === 'done') {
        review.setBudget(3, 1);
        const committing = review.commit();
        await settle();
        http.expectOne('/api/import/commit').flush({ created: 2, items: [] });
        await committing;
        await settle();
      }
    }
    const fixture = TestBed.createComponent(PageHost);
    fixture.detectChanges();
    await settle(fixture);
    return page(fixture, wizard, review);
  }

  function page(
    fixture: ComponentFixture<PageHost>,
    wizard: ImportWizardStore,
    review: ImportReviewStore,
  ) {
    const element = fixture.nativeElement as HTMLElement;
    return {
      fixture,
      element,
      wizard,
      review,
      /** Asks the page whether it may be left, as the router does. */
      leave: () => fixture.componentInstance.page().canLeave(),
      press: async (name: string | RegExp, within: HTMLElement = element) => {
        getByRole(within, 'button', name).click();
        await settle(fixture);
      },
    };
  }

  describe('the page', () => {
    it('is titled, explains what the wizard is for, and links back to the spendings', async () => {
      const t = await arrive('file');

      expect(getByRole(t.element, 'heading', 'Import CSV').tagName).toBe('H1');
      expect(textOf(t.element)).toContain(
        "Bring in spendings from your bank's CSV file. You check every row before anything is stored.",
      );
      expect(getByRole(t.element, 'link', 'Back to spendings').getAttribute('href')).toBe('/spendings');
    });

    it.each<WizardStep>(['file', 'mapping', 'preview', 'done'])(
      'has nothing a screen reader cannot use at the %s step',
      async (step) => {
        const t = await arrive(step);

        expect(a11yProblems(t.element)).toEqual([]);
      },
    );
  });

  describe('the steps', () => {
    it.each<[WizardStep, number, string[], (string | null)[]]>([
      ['file', 1, ['File', 'Columns', 'Review', 'Done'], ['step', null, null, null]],
      ['mapping', 2, ['File (done)', 'Columns', 'Review', 'Done'], [null, 'step', null, null]],
      [
        'preview',
        3,
        ['File (done)', 'Columns (done)', 'Review', 'Done'],
        [null, null, 'step', null],
      ],
      [
        'done',
        4,
        ['File (done)', 'Columns (done)', 'Review (done)', 'Done'],
        [null, null, null, 'step'],
      ],
    ])('at %s: shows that step alone, as step %i of 4', async (step, number, labels, current) => {
      const t = await arrive(step);

      expect(stepHeadings(t.element)).toEqual([HEADINGS[step]]);
      expect(stepper(t.element)).toEqual({ labels, current });
      expect(textOf(t.element)).toContain(`Step ${number} of 4`);
    });

    it('moves the stepper with the wizard, forward and back', async () => {
      const t = await arrive('preview');
      expect(stepper(t.element).current).toEqual([null, null, 'step', null]);

      await t.press('Back');
      expect(stepHeadings(t.element)).toEqual([HEADINGS.mapping]);
      expect(stepper(t.element).current).toEqual([null, 'step', null, null]);

      await t.press('Back');
      expect(stepHeadings(t.element)).toEqual([HEADINGS.file]);
      expect(stepper(t.element)).toEqual({
        labels: ['File', 'Columns', 'Review', 'Done'],
        current: ['step', null, null, null],
      });
    });

    it('keeps the file and the choices when the user goes back and forward', async () => {
      const t = await arrive('preview');
      await t.press('Back');
      await t.press('Back');
      expect(textOf(t.element)).toContain('bank.csv');

      await t.press('Next: choose the columns');
      await t.press('Next: review the rows');

      // The preview is kept: it is not asked for again.
      http.expectNone('/api/import/preview');
      expect(stepHeadings(t.element)).toEqual([HEADINGS.preview]);
      expect(stepper(t.element).current).toEqual([null, null, 'step', null]);
    });

    it('does not open the columns before a file has been read', async () => {
      const t = await arrive('file');

      const next = getByRole(t.element, 'button', 'Next: choose the columns') as HTMLButtonElement;
      expect(next.disabled).toBe(true);
      next.click();
      await settle(t.fixture);

      expect(stepHeadings(t.element)).toEqual([HEADINGS.file]);
    });

    it('stays on the columns, and says so, when the server cannot judge the file', async () => {
      const t = await arrive('mapping');
      // A change of the mapping makes the preview stale: the server is asked again.
      typeInto(getByLabel(t.element, 'Decimal separator'), ',');
      await settle(t.fixture);

      await t.press('Next: review the rows');
      flushError(
        http.expectOne('/api/import/preview'),
        400,
        'validation_error',
        'A quote is never closed on line 9',
      );
      await settle(t.fixture);

      expect(stepHeadings(t.element)).toEqual([HEADINGS.mapping]);
      expect(stepper(t.element).current).toEqual([null, 'step', null, null]);
      expect(textOf(getByRole(t.element, 'alert'))).toBe(
        "Couldn't check the rows. A quote is never closed on line 9 Nothing was imported.",
      );
    });

    it('starts over from the end with "Import another file"', async () => {
      const t = await arrive('done');
      expect(textOf(t.element)).toContain('Imported 2 spendings.');

      await t.press('Import another file');

      expect(stepHeadings(t.element)).toEqual([HEADINGS.file]);
      expect(stepper(t.element).current).toEqual(['step', null, null, null]);
      expect(textOf(t.element)).not.toContain('bank.csv');
      expect(t.review.result()).toBeNull();
    });
  });

  describe('focus', () => {
    it('leaves the first step to the page, and puts focus on the heading of each step after it', async () => {
      const wizard = await setupWizard(http);
      const review = TestBed.inject(ImportReviewStore);
      const fixture = TestBed.createComponent(PageHost);
      fixture.detectChanges();
      await settle(fixture);
      const element = fixture.nativeElement as HTMLElement;
      const focused = () => textOf(document.activeElement as HTMLElement);
      expect(document.activeElement?.tagName).not.toBe('H2');

      await chooseFile(http, wizard, csvFile(CSV), PARSED);
      await answerBudgets(http, BUDGETS);
      await settle(fixture);
      getByRole(element, 'button', 'Next: choose the columns').click();
      await settle(fixture);
      expect(focused()).toBe(HEADINGS.mapping);

      wizard.patchMapping({ dateColumn: 0, amountColumn: 1, descriptionColumn: 2 });
      await settle(fixture);
      getByRole(element, 'button', 'Next: review the rows').click();
      await settle(fixture);
      http.expectOne('/api/import/preview').flush(previewResponse(ROWS));
      await settle(fixture);
      expect(focused()).toBe(HEADINGS.preview);

      getByRole(element, 'button', 'Back').click();
      await settle(fixture);
      expect(focused()).toBe(HEADINGS.mapping);

      getByRole(element, 'button', 'Next: review the rows').click();
      await settle(fixture);
      getByRole(element, 'button', 'Import 1 spending').click();
      await settle(fixture);
      http.expectOne('/api/import/commit').flush({ created: 1, items: [] });
      await settle(fixture);
      expect(focused()).toBe(HEADINGS.done);
      expect(review.result()).toEqual({ created: 1, months: ['2026-10'] });
    });
  });

  describe('leaving the page', () => {
    it('lets the user go at once from a page with nothing on it', async () => {
      const t = await arrive('file');

      expect(t.leave()).toBe(true);
      await settle(t.fixture);
      expect(dialogOf(t.element).open).toBe(false);
    });

    it.each<WizardStep>(['mapping', 'preview'])(
      'asks before it throws away the work of the %s step, and the user can stay',
      async (step) => {
        const t = await arrive(step);

        const answer = t.leave();
        await settle(t.fixture);

        const dialog = dialogOf(t.element);
        expect(dialog.open).toBe(true);
        expect(getByRole(dialog, 'heading', 'Leave the import?')).toBeTruthy();
        expect(textOf(dialog)).toContain(
          'Your file and the rows you ticked are kept only on this page. If you leave now, you start over. Nothing has been imported.',
        );
        // Focus starts on the safe answer.
        expect(textOf(document.activeElement as HTMLElement)).toBe('Stay');

        await t.press('Stay', dialog);
        expect(await answer).toBe(false);
        expect(dialog.open).toBe(false);
        expect(stepHeadings(t.element)).toEqual([HEADINGS[step]]);
      },
    );

    it('lets the user leave once they say so', async () => {
      const t = await arrive('preview');

      const answer = t.leave();
      await settle(t.fixture);
      await t.press('Leave', dialogOf(t.element));

      expect(await answer).toBe(true);
    });

    it('asks as soon as a file has been read, before any column is chosen', async () => {
      const t = await arrive('file');
      await chooseFile(http, t.wizard, csvFile(CSV), PARSED);
      await answerBudgets(http, BUDGETS);
      await settle(t.fixture);

      const answer = t.leave();
      await settle(t.fixture);
      expect(dialogOf(t.element).open).toBe(true);

      await t.press('Stay', dialogOf(t.element));
      expect(await answer).toBe(false);
    });

    it('treats Escape as staying', async () => {
      const t = await arrive('preview');
      const answer = t.leave();
      await settle(t.fixture);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(t.fixture);

      expect(await answer).toBe(false);
    });

    it('does not ask when the file could not be used', async () => {
      const t = await arrive('file');
      const loading = t.wizard.loadFile(csvFile(CSV));
      await settle(t.fixture);
      flushError(http.expectOne('/api/import/parse'), 400, 'validation_error', 'A quote is never closed on line 3');
      await loading;
      await settle(t.fixture);
      expect(textOf(getByRole(t.element, 'alert'))).toContain('A quote is never closed on line 3');

      expect(t.leave()).toBe(true);
    });

    it('does not ask after the import: there is nothing left to lose', async () => {
      const t = await arrive('done');

      expect(t.leave()).toBe(true);
      await settle(t.fixture);
      expect(dialogOf(t.element).open).toBe(false);
    });

    it('does not ask after "Import another file", until a new file is read', async () => {
      const t = await arrive('done');
      await t.press('Import another file');
      expect(t.leave()).toBe(true);

      await chooseFile(http, t.wizard, csvFile(CSV), PARSED);
      await answerBudgets(http, BUDGETS);
      await settle(t.fixture);

      const answer = t.leave();
      await settle(t.fixture);
      expect(dialogOf(t.element).open).toBe(true);
      await t.press('Stay', dialogOf(t.element));
      expect(await answer).toBe(false);
    });
  });
});

describe('ImportPage, as the router shows it', () => {
  let http: HttpTestingController;
  let router: Router;

  const routes: Routes = [
    { path: 'import', component: ImportPage, canDeactivate: [canLeaveGuard] },
    { path: 'spendings', component: StubPage },
  ];

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  afterEach(() => http.verify());

  /** Opens `/import`: the page creates its own stores, and asks for the saved profiles. */
  async function open() {
    await primeStores(http);
    await router.navigateByUrl('/import');
    const fixture = TestBed.createComponent(RoutedHost);
    fixture.detectChanges();
    await settle(fixture);
    http.expectOne('/api/import/profiles').flush([]);
    await settle(fixture);
    const element = fixture.nativeElement as HTMLElement;
    return {
      fixture,
      element,
      press: async (name: string | RegExp, within: HTMLElement = element) => {
        getByRole(within, 'button', name).click();
        await settle(fixture);
      },
      /** Chooses the file in the file input, and answers what the page then asks the server. */
      chooseFile: async () => {
        pickFile(getByLabel(element, 'CSV file'), csvFile(CSV, 'march.csv'));
        await settle(fixture);
        http.expectOne('/api/import/parse').flush(PARSED);
        await settle(fixture);
      },
      /** Opens the columns. The budgets are asked for there, by the review the step belongs to. */
      openColumns: async () => {
        getByRole(element, 'button', 'Next: choose the columns').click();
        await settle(fixture);
        http.expectOne('/api/budgets').flush(BUDGETS);
        await settle(fixture);
      },
      /** Asks to go to another page and answers the question, if there is one. */
      leaveTo: async (url: string, answer?: 'Leave' | 'Stay') => {
        const navigation = router.navigateByUrl(url);
        await settle(fixture);
        if (answer) {
          expect(dialogOf(element).open).toBe(true);
          getByRole(dialogOf(element), 'button', answer).click();
        } else {
          expect(dialogOf(element).open).toBe(false);
        }
        await settle(fixture);
        return navigation;
      },
    };
  }

  describe('a whole import, through the page', () => {
    it('reads the file, maps the columns, reviews the rows, imports them and says what was done', async () => {
      const t = await open();
      const heading = () => stepHeadings(t.element);
      expect(heading()).toEqual([HEADINGS.file]);

      // 1. The file.
      await t.chooseFile();
      expect(textOf(t.element)).toContain('march.csv');
      expect(textOf(t.element)).toContain('4 (the first one may be a header)');
      await t.openColumns();
      expect(heading()).toEqual([HEADINGS.mapping]);
      expect(stepper(t.element).current).toEqual([null, 'step', null, null]);

      // 2. The columns: the page offers them by the names in the header.
      typeInto(getByLabel(t.element, 'Date column'), '0');
      typeInto(getByLabel(t.element, 'Amount column'), '1');
      typeInto(getByLabel(t.element, 'Description column'), '2');
      await settle(t.fixture);
      await t.press('Next: review the rows');
      const preview = http.expectOne('/api/import/preview');
      expect(preview.request.body).toEqual({ csv: CSV, mapping: importMapping() });
      preview.flush(previewResponse(ROWS));
      await settle(t.fixture);

      // 3. The rows: Coffee has a suggestion and is ticked; Lunch gets its budget from the user; the
      // salary is a credit and stays out.
      expect(heading()).toEqual([HEADINGS.preview]);
      expect(textOf(t.element.querySelector('dl') as HTMLElement)).toBe(
        'Rows 3 Ready to import 2 Already imported 0 Credits 1 With errors 0',
      );
      expect(textOf(getByRole(t.element, 'button', /^Import \d/))).toBe('Import 1 spending');
      typeInto(getByLabel(t.element, 'Budget for line 3'), '1');
      await settle(t.fixture);
      expect(selectedText(getByLabel(t.element, 'Budget for line 3'))).toBe('Groceries');
      expect(textOf(getByRole(t.element, 'button', /^Import \d/))).toBe('Import 2 spendings');
      expect(
        textOf(
          queryAllByRole(t.element, 'status').find((status) =>
            textOf(status).includes('selected of'),
          ) as HTMLElement,
        ),
      ).toBe('2 rows selected of 3. Together €15.80 (refunds and credits are subtracted).');

      // 4. Import.
      await t.press('Import 2 spendings');
      const commit = http.expectOne('/api/import/commit');
      expect(commit.request.body).toEqual({
        csv: CSV,
        mapping: importMapping(),
        rows: [
          { line: 2, budgetId: 1 },
          { line: 3, budgetId: 1 },
        ],
      });
      expect(importCommitSchema.safeParse(commit.request.body).success).toBe(true);
      commit.flush({
        created: 2,
        items: [
          { line: 2, id: 1 },
          { line: 3, id: 2 },
        ],
      });
      await settle(t.fixture);
      answerSavingsRefresh(http);

      // 5. Done.
      expect(heading()).toEqual([HEADINGS.done]);
      expect(stepper(t.element).labels).toEqual([
        'File (done)',
        'Columns (done)',
        'Review (done)',
        'Done',
      ]);
      expect(textOf(getByRole(t.element, 'status'))).toBe('Imported 2 spendings.');
      expect(getByRole(t.element, 'link', 'October 2026').getAttribute('href')).toBe(
        '/spendings?month=2026-10',
      );
      expect(a11yProblems(t.element)).toEqual([]);

      // The way out needs no question, and "another file" starts over.
      await t.press('Import another file');
      expect(heading()).toEqual([HEADINGS.file]);
      expect(textOf(t.element)).not.toContain('march.csv');
      await t.leaveTo('/spendings');
      expect(router.url).toBe('/spendings');
    });
  });

  describe('leaving in the middle', () => {
    it('lets the user leave a fresh page with no question', async () => {
      const t = await open();

      await t.leaveTo('/spendings');

      expect(router.url).toBe('/spendings');
    });

    it('asks first once a file has been read, and keeps the work when the user stays', async () => {
      const t = await open();
      await t.chooseFile();

      const navigation = await t.leaveTo('/spendings', 'Stay');

      expect(navigation).toBe(false);
      expect(router.url).toBe('/import');
      expect(textOf(t.element)).toContain('march.csv');
      expect(stepHeadings(t.element)).toEqual([HEADINGS.file]);
    });

    it('asks also when the link in the page header is used', async () => {
      const t = await open();
      await t.chooseFile();

      getByRole(t.element, 'link', 'Back to spendings').click();
      await settle(t.fixture);
      expect(dialogOf(t.element).open).toBe(true);
      getByRole(dialogOf(t.element), 'button', 'Leave').click();
      await settle(t.fixture);

      expect(router.url).toBe('/spendings');
    });

    it('lets the work go when the user leaves, and the next visit starts from nothing', async () => {
      const t = await open();
      await t.chooseFile();
      await t.openColumns();

      const navigation = await t.leaveTo('/spendings', 'Leave');
      expect(navigation).toBe(true);
      expect(router.url).toBe('/spendings');

      await router.navigateByUrl('/import');
      await settle(t.fixture);
      // A new visit is a new page, with its own stores: they ask for the saved profiles again.
      http.expectOne('/api/import/profiles').flush([]);
      await settle(t.fixture);
      expect(stepHeadings(t.element)).toEqual([HEADINGS.file]);
      expect(textOf(t.element)).not.toContain('march.csv');
      expect((getByRole(t.element, 'button', 'Next: choose the columns') as HTMLButtonElement).disabled).toBe(true);
      expect(dialogOf(t.element).open).toBe(false);
    });
  });
});
