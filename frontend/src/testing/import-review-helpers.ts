import type { HttpTestingController } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type {
  BudgetDto,
  ImportPreviewResponse,
  ImportPreviewRow,
  SettingsDto,
} from '@wallet/shared';
import { ImportReviewStore } from '../app/features/import/import-review.store';
import { ImportWizardStore } from '../app/features/import/import-wizard.store';
import { parseResponse, previewResponse, savingsDto } from './fixtures';
import { flushError, primeStores, settle } from './harness';
import { answerBudgets, chooseFile, csvFile, setupWizard } from './import-harness';

/** The text of the file the review specs read. The server judges it: its rows are the specs' own. */
export const REVIEW_CSV = 'Date;Amount;Description\n';

export interface OpenReviewOptions {
  /**
   * The budgets the server lists. `'loading'` leaves the request unanswered, `'error'` answers it
   * with a 500. Default: none.
   */
  budgets?: BudgetDto[] | 'loading' | 'error';
  /** The settings of the user (currency, locale). Default: `SETTINGS` of the harness. */
  settings?: SettingsDto;
  /**
   * The counts the server sends with the rows. Default: counted from the rows, which is right for a
   * preview that holds the whole file; a spec of a long file names its own.
   */
  summary?: ImportPreviewResponse['summary'];
}

/** The wizard stores, created the way `setupWizard` does, for a user with their own settings. */
async function setupWizardFor(
  http: HttpTestingController,
  settings: SettingsDto,
): Promise<ImportWizardStore> {
  await primeStores(http, { settings });
  const wizard = TestBed.inject(ImportWizardStore);
  await settle();
  http.expectOne('/api/import/profiles').flush([]);
  await settle();
  return wizard;
}

/**
 * Brings the stores to the review step: a file read, its three columns mapped, the budgets loaded and
 * the server's preview of `rows` in. The spec must provide `IMPORT_STORES` and the HTTP testing
 * backend. Nothing is rendered: the spec creates the component it tests afterwards.
 */
export async function openReview(
  http: HttpTestingController,
  rows: ImportPreviewRow[],
  options: OpenReviewOptions = {},
): Promise<{ wizard: ImportWizardStore; review: ImportReviewStore }> {
  const wizard = options.settings
    ? await setupWizardFor(http, options.settings)
    : await setupWizard(http);
  const review = TestBed.inject(ImportReviewStore);
  await chooseFile(
    http,
    wizard,
    csvFile(REVIEW_CSV),
    parseResponse({ recordCount: rows.length + 1 }),
  );

  const budgets = options.budgets ?? [];
  if (budgets === 'loading') {
    await settle();
    // Taken off the list of open requests and never answered: the budgets are still loading.
    http.expectOne('/api/budgets');
  } else if (budgets === 'error') {
    await settle();
    flushError(http.expectOne('/api/budgets'), 500, 'internal_error', 'The budgets are unavailable');
    await settle();
  } else {
    await answerBudgets(http, budgets);
  }

  wizard.goTo('mapping');
  wizard.patchMapping({ dateColumn: 0, amountColumn: 1, descriptionColumn: 2 });
  const opening = review.openPreview();
  await settle();
  http
    .expectOne('/api/import/preview')
    .flush(options.summary ? { rows, summary: options.summary } : previewResponse(rows));
  await opening;
  await settle();
  return { wizard, review };
}

/**
 * Answers a commit the server refused (422 `import_rows_rejected`) and the two requests the review
 * then makes to make the table current: the budgets, and the preview of `rows`.
 */
export async function answerRefusal(
  http: HttpTestingController,
  fixture: ComponentFixture<unknown>,
  refused: { line: number; errors: string[] }[],
  current: { budgets: BudgetDto[]; rows: ImportPreviewRow[] },
): Promise<void> {
  flushError(
    http.expectOne('/api/import/commit'),
    422,
    'import_rows_rejected',
    `${refused.length} of the listed rows were refused`,
    { rows: refused },
  );
  await settle(fixture);
  http.expectOne('/api/budgets').flush(current.budgets);
  await settle(fixture);
  http.expectOne('/api/import/preview').flush(previewResponse(current.rows));
  await settle(fixture);
}

/**
 * Answers the savings overview, which an import into a month before the current one asks for at once
 * (the badge in the navigation counts those months). Nothing happens when it was not asked for.
 */
export function answerSavingsRefresh(http: HttpTestingController): void {
  for (const request of http.match('/api/savings')) request.flush(savingsDto());
}
