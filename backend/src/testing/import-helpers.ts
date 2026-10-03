/**
 * Helpers for the CSV import tests: a default mapping, a file builder, shortcuts for the three
 * steps (parse, preview, commit) and the profile endpoints, and an assertion for the 422 of a
 * commit. Nothing here knows a rule of the importer: the tests state every expectation themselves.
 */
import type {
  ImportCommitInput,
  ImportCommitResponse,
  ImportMapping,
  ImportPreviewResponse,
  ImportProfileDto,
  ImportRejectedRow,
  ImportParseResponse,
} from '@wallet/shared';
import type { Express } from 'express';
import request, { type Response } from 'supertest';
import { expect } from 'vitest';
import { expectApiError } from './helpers';

/** `date,amount,description` with a header row, ISO dates, "." decimals and a minus on expenses. */
export const BANK_MAPPING: ImportMapping = {
  delimiter: ',',
  hasHeader: true,
  dateColumn: 0,
  amountColumn: 1,
  descriptionColumn: 2,
  dateFormat: 'YYYY-MM-DD',
  decimalSeparator: '.',
  signConvention: 'expenses_negative',
};

/** The file `date,amount,description` with the given data rows, one per line, CRLF-free. */
export function bankFile(rows: readonly string[], header = 'date,amount,description'): string {
  return [header, ...rows].join('\n') + '\n';
}

export const parseCsvFile = (app: Express, body: object) =>
  request(app).post('/api/import/parse').send(body);

export const previewRequest = (app: Express, csv: string, mapping: Partial<ImportMapping> = {}) =>
  request(app)
    .post('/api/import/preview')
    .send({ csv, mapping: { ...BANK_MAPPING, ...mapping } });

export const commitRequest = (
  app: Express,
  csv: string,
  rows: ImportCommitInput['rows'],
  mapping: Partial<ImportMapping> = {},
) =>
  request(app)
    .post('/api/import/commit')
    .send({ csv, mapping: { ...BANK_MAPPING, ...mapping }, rows });

export async function parseOf(app: Express, body: object): Promise<ImportParseResponse> {
  return (await parseCsvFile(app, body).expect(200)).body;
}

export async function previewOf(
  app: Express,
  csv: string,
  mapping: Partial<ImportMapping> = {},
): Promise<ImportPreviewResponse> {
  return (await previewRequest(app, csv, mapping).expect(200)).body;
}

/** POST /api/import/commit, which must answer 201. */
export async function commitOf(
  app: Express,
  csv: string,
  rows: ImportCommitInput['rows'],
  mapping: Partial<ImportMapping> = {},
): Promise<ImportCommitResponse> {
  return (await commitRequest(app, csv, rows, mapping).expect(201)).body;
}

/** POST /api/import/profiles, which must answer 201. */
export async function addProfile(
  app: Express,
  body: { name?: string; mapping?: Partial<ImportMapping>; header?: string[] | null } = {},
): Promise<ImportProfileDto> {
  return (
    await request(app)
      .post('/api/import/profiles')
      .send({
        name: 'My bank',
        header: ['date', 'amount', 'description'],
        ...body,
        mapping: { ...BANK_MAPPING, ...body.mapping },
      })
      .expect(201)
  ).body;
}

/** Every line of a file as a listed row for one budget. */
export const allToBudget = (lines: readonly number[], budgetId: number) =>
  lines.map((line) => ({ line, budgetId }));

/** 422 `import_rows_rejected` with exactly these rows (ascending by line, codes in order). */
export function expectRejected(res: Response, rows: readonly ImportRejectedRow[]): void {
  expectApiError(res, 'import_rows_rejected');
  expect(res.body.error.details).toEqual({ rows });
}
