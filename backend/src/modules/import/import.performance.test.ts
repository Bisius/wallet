/**
 * The importer at the limits of the contract: a file of 10,000 rows (`IMPORT_MAX_ROWS`) against a
 * database that already holds tens of thousands of spendings. The checks are structural first (the
 * number of SQL statements does not grow with the rows: no query per row, no `IN (...)` list of
 * hashes), then a generous time bound that only fails when the work has become quadratic.
 * Set WALLET_PERF_LOG=1 to print the timings.
 */
import { IMPORT_MAX_ROWS } from '@wallet/shared';
import type { Express } from 'express';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../db/client';
import { spendings } from '../../db/schema';
import { addBudget, mutableClock, onboard } from '../../testing/helpers';
import {
  allToBudget,
  bankFile,
  commitOf,
  commitRequest,
  previewOf,
} from '../../testing/import-helpers';
import { createTestApp } from '../../testing/test-app';

const STORED_SPENDINGS = 30_000;
const MERCHANTS = 2_000;
const BUDGET_COUNT = 20;

let app: Express;
let db: Db;
let budgetIds: number[];

/** Bank rows over 2026-01..2026-03 with a small set of merchants, so that suggestions are found. */
const bankRows = (count: number, offset = 0): string[] =>
  Array.from({ length: count }, (_, i) => {
    const n = i + offset;
    const day = String((n % 28) + 1).padStart(2, '0');
    const month = String((n % 3) + 1).padStart(2, '0');
    const cents = 100 + ((n * 37) % 90_000);
    // Some of the rows are credits (money in), some are the same row as an earlier one.
    const sign = n % 25 === 0 ? '' : '-';
    return `2026-${month}-${day},${sign}${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')},MERCHANT ${n % MERCHANTS} ${n % 7 === 0 ? 'cafe' : 'shop'}`;
  });

const log = (label: string, ms: number): void => {
  if (process.env['WALLET_PERF_LOG'])
    process.stdout.write(`[perf] ${label}: ${Math.round(ms)} ms\n`);
};

/** Counts the SQL statements the database is asked to prepare while `fn` runs. */
async function countStatements<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; statements: number }> {
  const spy = vi.spyOn(db.$client, 'prepare');
  try {
    const result = await fn();
    return { result, statements: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
  }
}

beforeAll(async () => {
  ({ app, db } = createTestApp(mutableClock('2026-03-15T10:00:00Z')));
  await onboard(app, { startMonth: '2026-01' });
  budgetIds = [];
  for (let i = 0; i < BUDGET_COUNT; i++) {
    budgetIds.push((await addBudget(app, { name: `Budget ${i}`, startMonth: '2026-01' })).id);
  }
  // Tens of thousands of stored spendings, entered "by hand": descriptions repeat, budgets vary.
  for (let start = 0; start < STORED_SPENDINGS; start += 1000) {
    db.insert(spendings)
      .values(
        Array.from({ length: 1000 }, (_, i) => {
          const n = start + i;
          return {
            date: `2026-0${(n % 3) + 1}-${String((n % 28) + 1).padStart(2, '0')}`,
            amount: 100 + (n % 5000),
            budgetId: budgetIds[n % BUDGET_COUNT] as number,
            description: `merchant ${n % MERCHANTS} ${n % 7 === 0 ? 'cafe' : 'shop'}`,
          };
        }),
      )
      .run();
  }
});

describe('the importer at the limits of the contract', () => {
  const file = bankFile(bankRows(IMPORT_MAX_ROWS));
  const lines = Array.from({ length: IMPORT_MAX_ROWS }, (_, i) => i + 2);

  it('previews 10,000 rows against 30,000 stored spendings without a query per row', async () => {
    const started = performance.now();
    const { result, statements } = await countStatements(() => previewOf(app, file));
    const elapsed = performance.now() - started;
    log('preview of 10,000 rows (30,000 stored)', elapsed);

    expect(result.summary.total).toBe(IMPORT_MAX_ROWS);
    expect(result.summary.invalid).toBe(0);
    // The merchants are known: most rows get a suggestion.
    expect(result.rows.filter((row) => row.suggestedBudgetId !== null).length).toBeGreaterThan(
      9_000,
    );
    // Three reads (budgets, hashes, spendings) and the settings: a handful, whatever the rows.
    expect(statements).toBeLessThan(15);
    expect(elapsed).toBeLessThan(5_000);
  });

  it('commits 10,000 rows in a few batches, and flags all of them afterwards', async () => {
    const started = performance.now();
    const { result, statements } = await countStatements(() =>
      commitOf(app, file, allToBudget(lines, budgetIds[0] as number)),
    );
    const elapsed = performance.now() - started;
    log('commit of 10,000 rows (30,000 stored)', elapsed);

    expect(result.created).toBe(IMPORT_MAX_ROWS);
    expect(result.items.map((item) => item.line)).toEqual(lines);
    const ids = result.items.map((item) => item.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    // Batches of 500 rows: 20 inserts, the reads, and the transaction's own statements.
    expect(statements).toBeLessThan(60);
    expect(elapsed).toBeLessThan(10_000);
    expect(db.$client.prepare('select count(*) as n from spendings').get()).toEqual({
      n: STORED_SPENDINGS + IMPORT_MAX_ROWS,
    });

    // Now the hash set holds 10,000 hashes: the same preview flags every row, still cheaply.
    const again = performance.now();
    const { result: second, statements: reads } = await countStatements(() => previewOf(app, file));
    log('preview of the same 10,000 rows (10,000 imported)', performance.now() - again);
    expect(second.summary.duplicates).toBe(IMPORT_MAX_ROWS);
    expect(second.summary.importable).toBe(0);
    expect(reads).toBeLessThan(15);
    expect(performance.now() - again).toBeLessThan(5_000);
  });

  it('refuses 10,000 rows that are all duplicates in one report, without a query per row', async () => {
    const started = performance.now();
    const { statements, result } = await countStatements(async () =>
      commitRequest(app, file, allToBudget(lines, budgetIds[0] as number)),
    );
    log('commit refused: 10,000 duplicates', performance.now() - started);
    expect(result.status).toBe(422);
    expect(result.body.error.details.rows).toHaveLength(IMPORT_MAX_ROWS);
    expect(statements).toBeLessThan(15);
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});
