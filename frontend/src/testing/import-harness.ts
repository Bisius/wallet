import type { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { BudgetDto, ImportParseResponse, ImportProfileDto } from '@wallet/shared';
import { ImportProfilesStore } from '../app/features/import/import-profiles.store';
import { ImportReviewStore } from '../app/features/import/import-review.store';
import { ImportWizardStore } from '../app/features/import/import-wizard.store';
import { parseResponse } from './fixtures';
import { primeStores, settle } from './harness';

/** A file as the file input hands it over: `text` encoded as UTF-8, or the given bytes. */
export function csvFile(content: string | Uint8Array, name = 'bank.csv'): File {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return new File([bytes as BlobPart], name, { type: 'text/csv' });
}

/** The providers of the wizard stores, as the import page gives them. */
export const IMPORT_STORES = [ImportProfilesStore, ImportWizardStore, ImportReviewStore];

/**
 * Creates the wizard store (the stores of the page it needs) and answers the requests that creating
 * them makes: the settings, today, and the list of saved profiles.
 */
export async function setupWizard(
  http: HttpTestingController,
  options: { profiles?: ImportProfileDto[] | 'error' } = {},
): Promise<ImportWizardStore> {
  await primeStores(http);
  const wizard = TestBed.inject(ImportWizardStore);
  await settle();
  const request = http.expectOne('/api/import/profiles');
  if (options.profiles === 'error') request.flush('boom', { status: 500, statusText: 'Error' });
  else request.flush(options.profiles ?? []);
  await settle();
  return wizard;
}

/**
 * Chooses a file and answers its `parse`. Returns once the wizard has the answer (and, when the
 * answer names a profile, once that profile has been applied).
 */
export async function chooseFile(
  http: HttpTestingController,
  wizard: ImportWizardStore,
  file: File,
  answer: ImportParseResponse = parseResponse(),
): Promise<void> {
  const loading = wizard.loadFile(file);
  await settle();
  http.expectOne('/api/import/parse').flush(answer);
  await loading;
  await settle();
}

/** The budgets the review store asks for once a file has been read. */
export async function answerBudgets(
  http: HttpTestingController,
  budgets: BudgetDto[],
): Promise<void> {
  await settle();
  http.expectOne('/api/budgets').flush(budgets);
  await settle();
}
