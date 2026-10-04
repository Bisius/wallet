import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { ImportPreviewRow, MonthKey, SettingsDto } from '@wallet/shared';
import { a11yProblems } from '../../../testing/a11y';
import { getByRole, queryAllByRole, queryByRole, textOf } from '../../../testing/dom';
import { budgetDto, previewRow } from '../../../testing/fixtures';
import { SETTINGS, settle } from '../../../testing/harness';
import { IMPORT_STORES } from '../../../testing/import-harness';
import { answerSavingsRefresh, openReview } from '../../../testing/import-review-helpers';
import { ImportDoneStep } from './import-done-step';

const GROCERIES = budgetDto({ id: 1, name: 'Groceries', startMonth: '2025-01' });

/** One clean row per month, each with a suggested budget, so every one of them is ticked. */
const rowsIn = (months: MonthKey[]): ImportPreviewRow[] =>
  months.map((month, index) =>
    previewRow({
      line: index + 2,
      date: `${month}-10`,
      raw: { date: `${month}-10`, amount: '-1.00' },
      amount: 100,
      suggestedBudgetId: 1,
    }),
  );

/** `count` months ending in `last`, ascending. */
function monthsEnding(last: MonthKey, count: number): MonthKey[] {
  const [year, month] = last.split('-').map(Number);
  return Array.from({ length: count }, (_, index) => {
    const offset = count - 1 - index;
    const total = year * 12 + (month - 1) - offset;
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}` as MonthKey;
  });
}

describe('ImportDoneStep', () => {
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

  /** A file imported, as the review step leaves it: the commit answered, the step shown. */
  async function setup(
    months: MonthKey[] = ['2026-10'],
    options: { settings?: SettingsDto; created?: number } = {},
  ) {
    const rows = rowsIn(months);
    const { wizard, review } = await openReview(http, rows, {
      budgets: [GROCERIES],
      settings: options.settings,
    });
    const committing = review.commit();
    await settle();
    http
      .expectOne('/api/import/commit')
      .flush({ created: options.created ?? rows.length, items: [] });
    await committing;
    await settle();
    answerSavingsRefresh(http);

    const fixture = TestBed.createComponent(ImportDoneStep);
    fixture.detectChanges();
    await settle(fixture);
    const element = fixture.nativeElement as HTMLElement;
    return {
      fixture,
      element,
      wizard,
      review,
      /** The month links, in the order shown. */
      links: () =>
        queryAllByRole(getByRole(element, 'list'), 'link').map((link) => ({
          name: textOf(link),
          href: link.getAttribute('href'),
        })),
      summary: () => textOf(getByRole(element, 'status')),
    };
  }

  describe('the result', () => {
    it('says how many spendings were imported', async () => {
      const t = await setup(['2026-10', '2026-10', '2026-10'], { created: 3 });

      expect(getByRole(t.element, 'heading', 'Import complete')).toBeTruthy();
      expect(t.summary()).toBe('Imported 3 spendings.');
    });

    it('says "1 spending" for one', async () => {
      const t = await setup(['2026-10']);

      expect(t.summary()).toBe('Imported 1 spending.');
    });

    it('says that they are ordinary spendings, and that the same file is recognised next time', async () => {
      const t = await setup();

      expect(textOf(t.element)).toContain(
        'Imported rows are ordinary spendings: edit or delete them like any other.',
      );
      expect(textOf(t.element)).toContain(
        'If you choose this file again, its rows are marked as already imported.',
      );
    });

    it('says how many were imported in a success message, announced politely', async () => {
      const t = await setup(['2026-10', '2026-10'], { created: 2 });

      const status = getByRole(t.element, 'status');
      expect(textOf(status)).toBe('Imported 2 spendings.');
      expect(status.className).toContain('bg-positive-soft');
    });

    it('is the end of the wizard: there is nothing left to lose', async () => {
      const t = await setup();

      expect(t.wizard.step()).toBe('done');
      expect(t.wizard.hasWork()).toBe(false);
    });
  });

  describe('where to see them', () => {
    it('links to the spendings of each month that got one, oldest first', async () => {
      const t = await setup(['2026-10', '2026-09', '2026-10', '2026-08']);

      expect(t.links()).toEqual([
        { name: 'August 2026', href: '/spendings?month=2026-08' },
        { name: 'September 2026', href: '/spendings?month=2026-09' },
        { name: 'October 2026', href: '/spendings?month=2026-10' },
      ]);
      expect(textOf(t.element)).not.toContain('earlier month');
    });

    it('names the months in the language of the settings', async () => {
      const t = await setup(['2026-10'], { settings: { ...SETTINGS, locale: 'de-DE' } });

      expect(t.links()).toEqual([{ name: 'Oktober 2026', href: '/spendings?month=2026-10' }]);
    });

    it('lists the latest twelve months of a file of many years, and says how many are left out', async () => {
      const months = monthsEnding('2026-10', 14);
      expect(months[0]).toBe('2025-09');
      const t = await setup(months);

      expect(t.summary()).toBe('Imported 14 spendings.');
      const links = t.links();
      expect(links).toHaveLength(12);
      expect(links[0]).toEqual({ name: 'November 2025', href: '/spendings?month=2025-11' });
      expect(links[11]).toEqual({ name: 'October 2026', href: '/spendings?month=2026-10' });
      expect(textOf(t.element)).toContain(
        'and 2 earlier months: use the month switcher on the Spendings page.',
      );
    });

    it('says "1 earlier month" for one', async () => {
      const t = await setup(monthsEnding('2026-10', 13));

      expect(t.links()).toHaveLength(12);
      expect(textOf(t.element)).toContain(
        'and 1 earlier month: use the month switcher on the Spendings page.',
      );
    });

    it('lists exactly twelve months without a note', async () => {
      const t = await setup(monthsEnding('2026-10', 12));

      expect(t.links()).toHaveLength(12);
      expect(textOf(t.element)).not.toContain('earlier month');
    });

    it('has a way on to the spendings page', async () => {
      const t = await setup();

      const link = getByRole(t.element, 'link', 'Go to spendings');
      expect(link.getAttribute('href')).toBe('/spendings');
    });
  });

  describe('importing another file', () => {
    it('starts the wizard over, with no file and nothing from the last import', async () => {
      const t = await setup();

      getByRole(t.element, 'button', 'Import another file').click();
      await settle(t.fixture);

      expect(t.wizard.step()).toBe('file');
      expect(t.wizard.file()).toBeNull();
      expect(t.wizard.parse()).toBeNull();
      expect(t.review.preview()).toBeNull();
      expect(t.review.result()).toBeNull();
      expect(t.review.selectedCount()).toBe(0);
      // The result is gone with it: this step shows only the way out.
      expect(queryByRole(t.element, 'status')).toBeNull();
      expect(queryAllByRole(t.element, 'link', /\d{4}$/)).toEqual([]);
    });

    it('keeps the work-in-progress guard off until a new file is read', async () => {
      const t = await setup();

      getByRole(t.element, 'button', 'Import another file').click();
      await settle(t.fixture);

      expect(t.wizard.hasWork()).toBe(false);
    });
  });

  describe('accessibility', () => {
    it('is a named section with a focusable heading, and nothing a screen reader cannot use', async () => {
      const t = await setup(monthsEnding('2026-10', 14));

      expect(getByRole(t.element, 'region', 'Import complete')).toBeTruthy();
      expect(getByRole(t.element, 'heading', 'Import complete').getAttribute('tabindex')).toBe(
        '-1',
      );
      expect(getByRole(t.element, 'heading', 'See them in')).toBeTruthy();
      expect(a11yProblems(t.element)).toEqual([]);
    });
  });
});
