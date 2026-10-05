import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { BackupDto, BackupsDto, SavingsDto, SpendingDto, TagDto } from '@wallet/shared';
import {
  SIMPLE_MAPPING,
  SPARKASSE_HEADER,
  SPARKASSE_MAPPING,
  ballastRows,
  simpleText,
  sparkasseFile,
  sparkasseText,
} from '../support/csv-fixtures';
import { json } from '../support/fixtures';
import {
  chooseColumns,
  chooseFile,
  openImport,
  review,
  reviewCount,
  reviewRow,
  rowCheckbox,
  toColumns,
  toReview,
} from '../support/import-flow';
import {
  BEFORE_RESTORE,
  type ObserveOptions,
  copyBackupIn,
  editDatabase,
  inspectDatabase,
  names,
  observe,
  queryDatabase,
  restoreBackup,
} from '../support/restore';
import { expect, test } from '../support/servers';
import {
  addIncome,
  addSpending,
  addTransfer,
  createBudget,
  createGoal,
  createSubscription,
  getMonth,
  getSavings,
  getTelegramStatus,
  onboard,
  setSalary,
  settleMonth,
} from '../support/seed';

/*
 * The backup restore drill, against the production build. It follows the README ("Backups and
 * restore") word for word: stop the app, move `wallet.db*` into a `before-restore` folder, copy the
 * chosen backup to `wallet.db`, start the app. `wallet.stop()` and `wallet.start()` are the service
 * manager's, and `support/restore.ts` does the file steps as the shell commands do them.
 *
 * The clock stands at 2026-04-10 09:00, so January to March are closed months and April is current.
 */
test.use({ walletNow: '2026-04-10T09:00:00' });

type Api = Parameters<typeof onboard>[0];

/** The months and years the snapshots cover: closed, current and projected ones. */
const OBSERVED: Pick<ObserveOptions, 'months' | 'years'> = {
  months: ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'],
  years: [2026],
};

/** A statement of April 2026, imported before the backup. 45.90 and 2.80 out. */
const APRIL_ROWS = [
  '02/04/2026;02/04/2026;-45,90;"REWE Markt ""Süd"" Straße";2.954,10',
  '03/04/2026;03/04/2026;-2,80;"Straßenbahn ""Ticket"" Zone 1";2.951,30',
];
/** Another one, imported after the backup. 12.00 out. */
const LATE_ROWS = ['05/04/2026;05/04/2026;-12,00;Apotheke am Markt;2.939,30'];

interface Rich {
  groceries: number;
  fun: number;
  transport: number;
  weekly: TagDto;
  treat: TagDto;
  goal: number;
  /** The ids of the two spendings that the April file created, in line order. */
  imported: number[];
}

/**
 * A wallet with something of everything. January 2026 is the start month, the salary 3,000.00 (3,100.00
 * from April), 500.00 in savings, budgets Groceries 400.00 and Transport 80.00 (leftovers go to
 * savings) and Fun 100.00 (carried over), Netflix 12.99 a month and a yearly domain at 120.00 that renews
 * in June (20.00 a month set aside), a bonus of 500.00 in March, a transfer, a goal, two tags, nine
 * spendings by hand with a refund among them, an import profile and a file of two rows imported.
 * January is settled. Hand-calculated, in cents:
 *
 *   January  fixed 1,299 + 2,000 = 3,299; allocated 40,000 + 10,000 + 8,000 = 58,000;
 *            unallocated 300,000 - 3,299 - 58,000 = 238,701; Groceries leaves 40,000 - 25,000 = 15,000,
 *            Transport 8,000 (Fun carries 6,500); due 238,701 + 15,000 + 8,000 = 261,701.
 *   February unallocated 238,701 (the transfer of 2,000 only moves money between budgets);
 *            Groceries 40,000 - 2,000 - 18,000 = 20,000 and Transport 8,000 - 2,500 = 5,500 are left
 *            (Fun carries 6,500 + 10,000 + 2,000 - 5,000 = 13,500); due 238,701 + 20,000 + 5,500 = 264,201.
 *   March    income 300,000 + 50,000; unallocated 350,000 - 3,299 - 58,000 = 288,701; Groceries leaves
 *            40,000 - (12,050 - 1,999) = 29,949, Transport 8,000 (Fun carries 13,500 + 10,000 - 1,000);
 *            due 288,701 + 29,949 + 8,000 = 326,650.
 */
async function buildRichWallet(api: Api): Promise<Rich> {
  await onboard(api, { startMonth: '2026-01', salary: 300000, openingSavings: 50000 });
  await setSalary(api, '2026-04', 310000);
  const start = { startMonth: '2026-01' } as const;
  const groceries = await createBudget(api, {
    name: 'Groceries',
    amount: 40000,
    incremental: false,
    ...start,
  });
  const fun = await createBudget(api, { name: 'Fun', amount: 10000, incremental: true, ...start });
  const transport = await createBudget(api, {
    name: 'Transport',
    amount: 8000,
    incremental: false,
    ...start,
  });
  await createSubscription(api, {
    name: 'Netflix',
    frequency: 'monthly',
    amount: 1299,
    anchorDate: '2026-01-15',
    ...start,
  });
  await createSubscription(api, {
    name: 'Domain',
    frequency: 'yearly',
    amount: 12000,
    anchorDate: '2026-06-15',
    ...start,
  });
  await addIncome(api, { date: '2026-03-05', amount: 50000, description: 'Bonus' });
  await addTransfer(api, {
    date: '2026-02-10',
    amount: 2000,
    fromBudgetId: groceries.id,
    toBudgetId: fun.id,
  });
  const weekly = await json<TagDto>(await api.post('/api/tags', { data: { name: 'weekly' } }));
  const treat = await json<TagDto>(await api.post('/api/tags', { data: { name: 'treat' } }));
  const goal = await createGoal(api, {
    name: 'Holiday',
    targetAmount: 150000,
    deadline: '2026-12-31',
  });

  const spend = (
    budgetId: number,
    date: string,
    amount: number,
    description: string,
    tagIds: number[] = [],
  ) => addSpending(api, { budgetId, date, amount, description, tagIds });
  await spend(groceries.id, '2026-01-20', 25000, 'Big shop', [weekly.id]);
  await spend(fun.id, '2026-01-25', 3500, 'Cinema');
  await spend(groceries.id, '2026-02-11', 18000, 'Market');
  await spend(fun.id, '2026-02-14', 5000, 'Concert', [treat.id]);
  await spend(transport.id, '2026-02-16', 2500, 'Bus pass');
  await spend(groceries.id, '2026-03-10', 12050, 'Lunch');
  await spend(fun.id, '2026-03-12', 1000, 'Popcorn');
  await spend(groceries.id, '2026-03-20', -1999, 'Refund');
  await spend(groceries.id, '2026-04-08', 3000, 'Corner shop');

  // January is settled: 1,000.00 into the Holiday goal and the rest unassigned.
  await settleMonth(api, '2026-01', [
    { goalId: goal.id, amount: 100000 },
    { goalId: null, amount: 161701 },
  ]);

  // An import profile and a file that was imported through it (two rows, with their hashes).
  await api.post('/api/import/profiles', {
    data: {
      name: 'Sparkasse Giro',
      mapping: SPARKASSE_MAPPING,
      header: SPARKASSE_HEADER.split(';'),
    },
  });
  const commit = await api.post('/api/import/commit', {
    data: {
      csv: sparkasseText(APRIL_ROWS),
      mapping: SPARKASSE_MAPPING,
      rows: [
        { line: 2, budgetId: groceries.id },
        { line: 3, budgetId: transport.id },
      ],
    },
  });
  const { items } = (await commit.json()) as { items: { line: number; id: number }[] };
  return {
    groceries: groceries.id,
    fun: fun.id,
    transport: transport.id,
    weekly,
    treat,
    goal: goal.id,
    imported: items.map(({ id }) => id),
  };
}

/**
 * Fills the database up: the largest file the importer takes, 10,000 rows of about 150 characters,
 * dated in April 2026 and all different, into one budget. It makes the database file a few
 * megabytes, and its write-ahead log longer than SQLite's limit of 1,000 pages, which is when
 * SQLite folds the log into the database file by itself.
 */
async function importBallast(api: Api, budgetId: number): Promise<void> {
  const rows = ballastRows(10_000);
  const response = await api.post('/api/import/commit', {
    timeout: 60_000,
    data: {
      csv: simpleText(rows),
      mapping: SIMPLE_MAPPING,
      rows: rows.map((_, index) => ({ line: index + 2, budgetId })),
    },
  });
  expect(await response.json()).toMatchObject({ created: 10_000 });
}

const observeOptions: ObserveOptions = {
  ...OBSERVED,
  preview: { csv: sparkasseText(APRIL_ROWS), mapping: SPARKASSE_MAPPING },
};

/** What `buildRichWallet` is worth in savings, worked out above: February and March wait to be moved. */
function expectRichSavings(savings: SavingsDto): void {
  // 500.00 opening + 2,617.01 settled for January.
  expect(savings.balance).toBe(311701);
  expect(savings.unassigned).toBe(211701);
  expect(savings.goals.map(({ name, balance }) => [name, balance])).toEqual([['Holiday', 100000]]);
  expect(savings.outstanding.map(({ month, outstanding }) => [month, outstanding])).toEqual([
    ['2026-02', 264201],
    ['2026-03', 326650],
  ]);
  expect(savings.outstandingTotal).toBe(590851);
}

/** The figure of the tile (a `dt` and its `dd`) that is labelled `label` inside `region`. */
function figure(region: Locator, label: string): Locator {
  return region
    .locator('dl > div')
    .filter({ has: region.page().getByText(label, { exact: true }) })
    .getByRole('definition')
    .first();
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

test.describe('restoring a backup, the README way', () => {
  test('every figure, list, tag, profile and import hash is back as it was at the backup, and the old database is kept aside', async ({
    page,
    wallet,
    servers,
  }) => {
    const api = wallet.api;
    const rich = await buildRichWallet(api);

    // The state of the wallet, as it is when the backup is made.
    const before = await observe(api, observeOptions);
    expectRichSavings(await getSavings(api));
    const spendingsBefore = await json<{ total: number }>(await api.get('/api/spendings'));
    expect(spendingsBefore.total).toBe(11); // nine by hand and the two of the file

    // Back up from Settings, as a person does: the file is made, listed, and can be downloaded.
    await page.goto('/settings');
    const backups = page.getByRole('region', { name: 'Backups' });
    await expect(backups.getByText('Automatic backups')).toBeVisible();
    await backups.getByRole('button', { name: 'Back up now' }).click();
    const toast = page.getByText(/^Backup made: wallet-\d{8}-\d{6}\.db\.$/);
    await expect(toast).toBeVisible();
    const name = /wallet-\d{8}-\d{6}\.db/.exec((await toast.textContent()) ?? '')?.[0] ?? '';
    expect(name).not.toBe('');
    const list = backups.getByRole('list', { name: 'Backups, newest first' });
    await expect(list.getByRole('listitem').first()).toContainText(name);
    const backupFile = join(wallet.backupDir, name);
    expect(existsSync(backupFile)).toBe(true);

    // The download link serves the very bytes of the file on disk.
    const [downloaded] = await Promise.all([
      page.waitForEvent('download'),
      list
        .getByRole('listitem')
        .first()
        .getByRole('link', { name: /^Download the backup of / })
        .click(),
    ]);
    expect(downloaded.suggestedFilename()).toBe(name);
    expect(
      Buffer.compare(await readFile(await downloaded.path()), await readFile(backupFile)),
    ).toBe(0);

    // Taking a backup changed no figure and wrote no table.
    expect(await observe(api, observeOptions)).toEqual(before);
    // A backup is one file: no -wal or -shm next to it, and the folder holds only backups.
    expect(await names(wallet.backupDir)).toEqual(
      (await json<BackupsDto>(await api.get('/api/backups'))).backups
        .map((backup) => backup.name)
        .sort(),
    );

    // Then the wallet changes in every way that matters.
    // - a forgotten spending in February (a closed month: it moves what is due), 15.00
    // - March is settled, 3,266.50
    // - the tag "treat" is deleted, and the one spending of the first file is deleted, which frees its row
    // - the import profile is replaced, another file is imported, the salary changes
    await addSpending(api, {
      budgetId: rich.groceries,
      date: '2026-02-20',
      amount: 1500,
      description: 'Forgotten',
    });
    await settleMonth(api, '2026-03');
    await api.delete(`/api/tags/${rich.treat.id}`);
    await api.delete(`/api/spendings/${rich.imported[0]}`);
    const profiles = await json<{ id: number }[]>(await api.get('/api/import/profiles'));
    await api.delete(`/api/import/profiles/${profiles[0]?.id}`);
    await api.post('/api/import/profiles', {
      data: { name: 'Postbank', mapping: SPARKASSE_MAPPING },
    });
    await api.post('/api/import/commit', {
      data: {
        csv: sparkasseText(LATE_ROWS),
        mapping: SPARKASSE_MAPPING,
        rows: [{ line: 2, budgetId: rich.groceries }],
      },
    });
    await setSalary(api, '2026-04', 320000);

    const changed = await observe(api, observeOptions);
    expect(changed).not.toEqual(before);
    const changedSavings = await getSavings(api);
    // February is due 2,642.01 - 15.00 = 2,627.01; March is settled, so only February is left to move.
    expect(
      changedSavings.outstanding.map(({ month, outstanding }) => [month, outstanding]),
    ).toEqual([['2026-02', 262701]]);
    expect(changedSavings.balance).toBe(638351); // 3,117.01 + 3,266.50
    expect((await json<TagDto[]>(await api.get('/api/tags'))).map((tag) => tag.name)).toEqual([
      'weekly',
    ]);

    // The documented restore: stop, `mkdir before-restore`, `mv wallet.db* before-restore/`,
    // `cp <backup> wallet.db`, start.
    const moved = await restoreBackup(wallet, backupFile);

    // The old database is in the folder next to the new one, whole. After a clean stop SQLite has
    // folded its write-ahead log into the file, so the database file alone holds the changed state.
    const aside = join(wallet.dir, BEFORE_RESTORE);
    expect(moved).toEqual(['wallet.db']); // after a clean stop there are no -wal and -shm files
    expect(await names(aside)).toEqual(moved);
    expect(await names(wallet.dir)).toEqual(
      expect.arrayContaining([BEFORE_RESTORE, 'backups', 'wallet.db']),
    );
    const oldFacts = inspectDatabase(join(aside, 'wallet.db'), [
      'spendings',
      'tags',
      'import_profiles',
      'savings_transactions',
    ]);
    expect(oldFacts.integrity).toEqual(['ok']);
    expect(oldFacts.foreignKeyViolations).toEqual([]);
    // 11 - the deleted one + the forgotten one + the second file's row = 12 spendings; one tag; the
    // replaced profile; opening + two rows of January + one of March = 4 savings rows.
    expect(oldFacts.counts).toEqual({
      spendings: 12,
      tags: 1,
      import_profiles: 1,
      savings_transactions: 4,
    });

    // The app is back, and every observable thing is what it was when the backup was made: month
    // views (and with them the closed months' carry-overs), the savings page, the three exports,
    // the tags, the profile, and the preview of the first file.
    const restored = await observe(api, observeOptions);
    for (const key of Object.keys(before)) {
      expect(restored[key], key).toEqual(before[key]);
    }
    expect(restored).toEqual(before);

    // Spelled out for what the changes were. They are all gone:
    expectRichSavings(await getSavings(api)); // February 2,642.01 and March 3,266.50 are to move again
    expect((await json<{ total: number }>(await api.get('/api/spendings'))).total).toBe(11);
    const spendings = (
      await json<{ items: SpendingDto[] }>(await api.get('/api/spendings?limit=200'))
    ).items;
    expect(spendings.map(({ description }) => description)).not.toContain('Forgotten');
    expect(spendings.map(({ description }) => description)).not.toContain('Apotheke am Markt');
    expect(spendings.find(({ id }) => id === rich.imported[0])?.description).toBe(
      'REWE Markt "Süd" Straße',
    );
    const tags = await json<TagDto[]>(await api.get('/api/tags'));
    expect(tags.map(({ name, usageCount }) => [name, usageCount])).toEqual([
      ['treat', 1],
      ['weekly', 1],
    ]);
    const restoredProfiles = await json<{ name: string }[]>(await api.get('/api/import/profiles'));
    expect(restoredProfiles.map(({ name }) => name)).toEqual(['Sparkasse Giro']);
    // The salary of April is 3,100.00 again.
    expect(
      (await json<{ effectiveMonth: string; amount: number }[]>(await api.get('/api/salary'))).at(
        -1,
      ),
    ).toEqual({
      effectiveMonth: '2026-04',
      amount: 310000,
    });

    // The people using it see it too: the dashboard says two months wait to be moved, 2,642.01 and
    // 3,266.50 which make 5,908.51, and the savings page names them.
    await page.goto('/dashboard');
    const toMove = page.getByRole('region', { name: 'Savings to move' });
    await expect(toMove).toContainText('+€5,908.51');
    await expect(toMove).toContainText('2 months to settle.');
    await page.getByRole('link', { name: /^Savings/ }).click();
    await expect(page.getByText('February 2026: move €2,642.01 to savings')).toBeVisible();
    await expect(page.getByText('March 2026: move €3,266.50 to savings')).toBeVisible();
    const yourSavings = page.getByRole('region', { name: 'Your savings' });
    await expect(figure(yourSavings, 'Savings balance')).toHaveText('€3,117.01');

    // The file that was imported before is still known: its profile is suggested, and both of its
    // rows are flagged as imported already (the hashes came back with the database).
    await openImport(page);
    await chooseFile(page, sparkasseFile('april.csv', APRIL_ROWS));
    await toColumns(page);
    await expect(
      page.getByText(
        'This file looks like your "Sparkasse Giro" profile, so its columns and formats are filled in.',
      ),
    ).toBeVisible();
    await toReview(page);
    await expect(reviewCount(page, 'Already imported')).toHaveText('2');
    await expect(reviewCount(page, 'Ready to import')).toHaveText('0');
    await expect(reviewRow(page, 2)).toContainText('Already imported');
    await expect(reviewRow(page, 3)).toContainText('Already imported');
    await expect(rowCheckbox(page, 2)).toBeDisabled();
    await expect(review(page)).toContainText('0 rows selected of 2.');

    // The old state is not lost: a scratch server on a copy of the database in before-restore shows
    // the wallet as it was just before the restore, down to the last figure.
    const recovered = await servers.startOnCopyOf(join(aside, 'wallet.db'));
    expect(await observe(recovered.api, observeOptions)).toEqual(changed);
  });
});

test.describe('a backup taken while the app is busy', () => {
  test('is one consistent state however many writes it caught, and restoring it gives exactly that state', async ({
    wallet,
  }, testInfo) => {
    const api = wallet.api;
    await onboard(api, { startMonth: '2026-04', salary: 300000 });
    const groceries = await createBudget(api, {
      name: 'Groceries',
      amount: 40000,
      incremental: false,
    });
    const holiday = await createGoal(api, { name: 'Holiday', targetAmount: 100000 });
    const car = await createGoal(api, { name: 'Car', targetAmount: 500000 });
    await api.post('/api/savings/transactions', {
      data: { kind: 'deposit', amount: 100000, goalId: holiday.id, date: '2026-04-02' },
    });

    // Ballast, so that the copy takes a while (a few hundred milliseconds) and writes overlap it.
    await importBallast(api, groceries.id);

    // Four writers send requests one after the other without a pause: a spending, a budget with its
    // first version (two tables) and a reallocation between goals (two rows that share a group id),
    // in turn. Each counts a write once the server has acknowledged it, so what was acknowledged
    // before the backup was asked for is surely in it, and nothing can be in it that was not written.
    const acknowledged = { spendings: 0, budgets: 0, reallocations: 0 };
    const total = (counts: typeof acknowledged) =>
      counts.spendings + counts.budgets + counts.reallocations;
    let stopping = false;
    const write = async (writer: number, index: number) => {
      switch (index % 3) {
        case 0:
          await api.post('/api/spendings', {
            data: {
              date: '2026-04-09',
              amount: 100,
              budgetId: groceries.id,
              description: `In flight ${writer}-${index}`,
            },
          });
          acknowledged.spendings++;
          break;
        case 1:
          await api.post('/api/budgets', {
            data: { name: `Load ${writer}-${index}`, amount: 1000, incremental: index % 2 === 0 },
          });
          acknowledged.budgets++;
          break;
        default:
          await api.post('/api/savings/transactions', {
            data: {
              kind: 'reallocation',
              amount: 100,
              fromGoalId: holiday.id,
              toGoalId: car.id,
              date: '2026-04-09',
            },
          });
          acknowledged.reallocations++;
      }
    };
    const writers = [0, 1, 2, 3].map(async (writer) => {
      for (let index = 0; !stopping; index++) await write(writer, index);
    });

    await expect.poll(() => total(acknowledged)).toBeGreaterThan(20);
    const before = { ...acknowledged };
    const backupResponse = await api.post('/api/backups');
    const duringTheBackup = total(acknowledged) - total(before);
    stopping = true;
    await Promise.all(writers);
    const made = (await backupResponse.json()) as BackupDto;
    const backupFile = join(wallet.backupDir, made.name);
    // Writes did go on while the backup was made: the test is about that.
    expect(duringTheBackup).toBeGreaterThan(0);

    // Whatever the copy caught, it is one moment of the database: it is sound, no row refers to a
    // missing one, every budget has its version and every reallocation both of its rows.
    const tables = ['spendings', 'budgets', 'budget_versions', 'savings_transactions'] as const;
    const facts = inspectDatabase(backupFile, tables);
    expect(facts.integrity).toEqual(['ok']);
    expect(facts.foreignKeyViolations).toEqual([]);
    expect(facts.counts.budget_versions).toBe(facts.counts.budgets);
    const brokenGroups = queryDatabase<number>(
      backupFile,
      `select count(*) from (select group_id from savings_transactions
         where group_id is not null group by group_id having count(*) <> 2)`,
    );
    expect(brokenGroups).toBe(0);
    // Between what was acknowledged before the backup was asked for and everything that was written.
    // The ballast (10,000 spendings) and the first budget are in it, and each kind of write is in it
    // at least as often as it was acknowledged before and at most as often as it happened.
    const caught = {
      spendings: facts.counts.spendings - 10_000,
      budgets: facts.counts.budgets - 1,
      reallocations: queryDatabase<number>(
        backupFile,
        'select count(*) / 2 from savings_transactions where group_id is not null',
      ),
    };
    for (const kind of ['spendings', 'budgets', 'reallocations'] as const) {
      expect(caught[kind], kind).toBeGreaterThanOrEqual(before[kind]);
      expect(caught[kind], kind).toBeLessThanOrEqual(acknowledged[kind]);
    }
    // Some of the writes that overlapped the copy are in it (they are in the file as well as in
    // the live database), and a spending that the copy has is never preceded by a gap.
    expect(total(caught)).toBeGreaterThan(total(before));
    expect(queryDatabase<number>(backupFile, 'select max(id) from spendings')).toBe(
      facts.counts.spendings,
    );
    testInfo.annotations.push({
      type: 'writes caught by the backup',
      description: `${total(before)} acknowledged before it was asked for, ${duringTheBackup} during it, ${total(acknowledged)} in all, ${total(caught)} in the file`,
    });

    // The live database lost nothing: every write that was acknowledged is in it.
    expect((await json<{ total: number }>(await api.get('/api/spendings'))).total).toBe(
      10_000 + acknowledged.spendings,
    );
    expect((await json<unknown[]>(await api.get('/api/budgets'))).length).toBe(
      1 + acknowledged.budgets,
    );

    // Restore that backup. The app shows what the file holds, and its figures agree with the
    // rows: the spent total of April is the sum of the spendings in the file.
    await restoreBackup(wallet, backupFile);
    expect((await json<{ total: number }>(await api.get('/api/spendings'))).total).toBe(
      facts.counts.spendings,
    );
    expect((await json<unknown[]>(await api.get('/api/budgets'))).length).toBe(
      facts.counts.budgets,
    );
    const april = await getMonth(api, '2026-04');
    expect(april.totals.spent).toBe(
      queryDatabase<number>(backupFile, 'select sum(amount) from spendings'),
    );
    const savings = await getSavings(api);
    expect(savings.balance).toBe(100000); // the deposit: a reallocation never changes the balance
    expect(savings.goals.map(({ name }) => name)).toEqual(['Holiday', 'Car']);
    // Holiday had 1,000.00 and gave 1.00 for each reallocation the copy caught, Car received it.
    expect(savings.goals[0]?.balance).toBe(100000 - 100 * caught.reallocations);
    expect(savings.goals[1]?.balance).toBe(100 * caught.reallocations);
    // The restored database is sound too.
    const restored = inspectDatabase(wallet.dbPath, tables);
    expect(restored.integrity).toEqual(['ok']);
    expect(restored.counts).toEqual(facts.counts);
  });
});

test.describe('the scratch drill', () => {
  /** A figure of the "at a glance" strip of the dashboard. */
  const glance = (page: Page, label: string): Locator =>
    figure(page.getByRole('region', { name: /at a glance$/ }), label);

  test('a copy of a backup runs as a second server next to the live one, shows the same figures and touches nothing of it', async ({
    page,
    wallet,
    servers,
  }) => {
    await buildRichWallet(wallet.api);
    const made = await json<BackupDto>(await wallet.api.post('/api/backups'));
    const backupFile = join(wallet.backupDir, made.name);
    const backupHash = await sha256(backupFile);
    const liveBackups = await names(wallet.backupDir);
    const live = await observe(wallet.api, observeOptions);

    // README: copy the backup to another folder, start a server on it on another port, with a backup
    // folder of its own. The live one stays up.
    const scratch = await servers.startOnCopyOf(backupFile);
    expect(scratch.baseURL).not.toBe(wallet.baseURL);
    expect(scratch.dir).not.toBe(wallet.dir);
    expect(scratch.dbPath).not.toBe(wallet.dbPath);
    expect(scratch.backupDir).not.toBe(wallet.backupDir);
    for (const server of [wallet, scratch]) {
      const health = await server.api.get('/api/health');
      expect(await health.json()).toMatchObject({ status: 'ok' });
    }

    // "Compare the dashboard, a past month, the savings balance and the spending count with the live
    // app": every list, month and export is the same (the clock of the scratch server starts where
    // the live one is), and so is what the pages show. April: income 3,100.00, fixed costs
    // 12.99 + 20.00 = 32.99, budgeted 580.00, spent 30.00 + 45.90 + 2.80 = 78.70, unallocated
    // 3,100.00 - 32.99 - 580.00 = 2,487.01.
    expect(await observe(scratch.api, observeOptions)).toEqual(live);
    for (const server of [wallet, scratch]) {
      await page.goto(`${server.baseURL}/dashboard`);
      await expect(glance(page, 'Income')).toHaveText('€3,100.00');
      await expect(glance(page, 'Fixed costs')).toHaveText('€32.99');
      await expect(glance(page, 'Budgeted')).toHaveText('€580.00');
      await expect(glance(page, 'Spent')).toHaveText('€78.70');
      await expect(glance(page, 'Unallocated')).toHaveText('€2,487.01');
      await expect(page.getByRole('region', { name: 'Savings to move' })).toContainText(
        '+€5,908.51',
      );
      await page.goto(`${server.baseURL}/savings`);
      await expect(
        figure(page.getByRole('region', { name: 'Your savings' }), 'Savings balance'),
      ).toHaveText('€3,117.01');
    }

    // The scratch copy can be written to freely: the live wallet does not notice.
    await addSpending(scratch.api, {
      budgetId: 1,
      date: '2026-04-09',
      amount: 99900,
      description: 'Only in the scratch copy',
    });
    await settleMonth(scratch.api, '2026-02');
    expect(await observe(scratch.api, observeOptions)).not.toEqual(live);
    expect(await observe(wallet.api, observeOptions)).toEqual(live);

    // And the live server's backups were not touched, the backup file is byte for byte what it was,
    // and the copy keeps its own backups in its own folder.
    expect(await names(wallet.backupDir)).toEqual(liveBackups);
    expect(await sha256(backupFile)).toBe(backupHash);
    expect(scratch.backupDir.startsWith(scratch.dir)).toBe(true);
    expect(scratch.log()).toContain('Wallet listening');

    // "Stop it with Ctrl-C": the live one carries on.
    await scratch.stop();
    await expect(fetch(`${scratch.baseURL}/api/health`)).rejects.toThrow();
    expect((await wallet.api.get('/api/health')).ok()).toBe(true);
  });
});

test.describe('why the README moves wallet.db-wal and wallet.db-shm', () => {
  /*
   * After a clean stop (SIGTERM, what a service manager sends) SQLite has folded its write-ahead log
   * into wallet.db and deleted the two side files, so there is nothing to leave behind. After a crash
   * (SIGKILL, a power cut, `docker kill`) they stay, and the -wal holds committed changes that the
   * database file does not have yet. SQLite applies a -wal that it finds next to a database to it,
   * whatever database that is, and says nothing. These tests are that case: the app is killed after
   * the backup, the backup is copied over wallet.db as the README says, but the old files are not
   * moved aside first. What comes out depends on how much of the log had been folded in:
   *   - all of the history is still in the log (a young or quiet database): the restore is undone,
   *   - the log was folded in once and restarted (a busy one): the pages the log has come from the
   *     crashed state and all the others from the backup, a hybrid that is neither of them.
   */
  for (const leftBehind of [['-wal', '-shm'], ['-wal']] as readonly (readonly string[])[]) {
    test(`a backup copied over a crashed database, with its ${leftBehind.join(' and ')} left in place, is silently overridden by the whole log`, async ({
      servers,
    }) => {
      const server = await servers.start('2026-03-10T09:00:00');
      await onboard(server.api, { startMonth: '2026-03', salary: 250000 });
      const groceries = await createBudget(server.api, {
        name: 'Groceries',
        amount: 40000,
        incremental: false,
      });
      for (const [index, amount] of [1000, 1001, 1002].entries()) {
        await addSpending(server.api, {
          date: '2026-03-05',
          amount,
          budgetId: groceries.id,
          description: `early ${index}`,
        });
      }
      const made = await json<BackupDto>(await server.api.post('/api/backups'));
      const backupFile = join(server.backupDir, made.name);
      // Two more spendings after the backup: 50.00 and 50.01.
      for (const [index, amount] of [5000, 5001].entries()) {
        await addSpending(server.api, {
          date: '2026-03-06',
          amount,
          budgetId: groceries.id,
          description: `late ${index}`,
        });
      }
      // Spent: 10.00 + 10.01 + 10.02 = 30.03 at the backup, 30.03 + 50.00 + 50.01 = 130.04 now.
      const spent = async () => (await getMonth(server.api, '2026-03')).totals.spent;
      expect(await spent()).toBe(13004);

      await server.kill();
      // The crash left the write-ahead log and its index behind, and the database file has not got
      // the changes yet (everything is in the log: nothing was ever checkpointed).
      expect(await names(server.dir)).toEqual(
        expect.arrayContaining(['wallet.db', 'wallet.db-shm', 'wallet.db-wal']),
      );
      expect((await stat(`${server.dbPath}-wal`)).size).toBeGreaterThan(0);

      // The README without its second step: copy the backup over wallet.db, start.
      await copyBackupIn(backupFile, server.dbPath);
      if (!leftBehind.includes('-shm')) await rm(`${server.dbPath}-shm`);
      await server.start();

      // Nothing complains, and the restore did not happen: the app has the five spendings of the
      // crashed database, the two that the backup does not have included.
      expect(server.log()).not.toMatch(/SQLITE_|malformed|corrupt/i);
      expect(await spent()).toBe(13004);
      const descriptions = async () =>
        (await json<{ items: SpendingDto[] }>(await server.api.get('/api/spendings'))).items
          .map(({ description }) => description)
          .sort();
      expect(await descriptions()).toEqual(['early 0', 'early 1', 'early 2', 'late 0', 'late 1']);

      // The documented steps, in full, do restore it: the backup file is untouched, and the files
      // that were in the way are moved aside with the database.
      const moved = await restoreBackup(server, backupFile);
      expect(moved).toContain('wallet.db');
      expect(await spent()).toBe(3003);
      expect(await descriptions()).toEqual(['early 0', 'early 1', 'early 2']);
    });
  }

  test('a backup copied over a crashed database whose log was partly folded in gives a hybrid of both states that integrity_check calls ok', async ({
    servers,
  }) => {
    const server = await servers.start('2026-04-10T09:00:00');
    await onboard(server.api, { startMonth: '2026-04', salary: 250000 });
    const groceries = await createBudget(server.api, {
      name: 'Groceries',
      amount: 40000,
      incremental: false,
    });
    for (const [index, amount] of [1000, 1001, 1002].entries()) {
      await addSpending(server.api, {
        date: '2026-04-05',
        amount,
        budgetId: groceries.id,
        description: `early ${index}`,
      });
    }
    const made = await json<BackupDto>(await server.api.post('/api/backups'));
    const backupFile = join(server.backupDir, made.name);

    // A big import: SQLite folds the log into the database file after it. Then changes to the small
    // tables at the front of the file, which only the log has: a tag, a rename, a budget.
    await importBallast(server.api, groceries.id);
    await server.api.post('/api/tags', { data: { name: 'late tag' } });
    await server.api.patch(`/api/budgets/${groceries.id}`, { data: { name: 'Groceries renamed' } });
    await createBudget(server.api, { name: 'Late budget', amount: 1000, incremental: false });
    const state = async () => ({
      spendings: (await json<{ total: number }>(await server.api.get('/api/spendings'))).total,
      tags: (await json<TagDto[]>(await server.api.get('/api/tags'))).map(({ name }) => name),
      budgets: (await json<{ name: string }[]>(await server.api.get('/api/budgets'))).map(
        ({ name }) => name,
      ),
    });
    expect(await state()).toEqual({
      spendings: 10_003,
      tags: ['late tag'],
      budgets: ['Groceries renamed', 'Late budget'],
    });

    await server.kill();
    await copyBackupIn(backupFile, server.dbPath); // the README without its second step
    await server.start();

    // The three spendings of the backup are back and the ten thousand are gone, so it looks like a
    // restore, but the tag, the rename and the budget that came after the backup are still there:
    // the wallet is in a state it was never in. The server says nothing about it.
    expect(server.log()).not.toMatch(/SQLITE_|malformed|corrupt/i);
    expect(await state()).toEqual({
      spendings: 3,
      tags: ['late tag'],
      budgets: ['Groceries renamed', 'Late budget'],
    });
    // SQLite itself finds nothing wrong with that database, so nothing flags it.
    expect(inspectDatabase(server.dbPath, ['spendings']).integrity).toEqual(['ok']);

    // The documented steps restore the backup as it was, whole.
    await restoreBackup(server, backupFile);
    expect(await state()).toEqual({ spendings: 3, tags: [], budgets: ['Groceries'] });
    expect(inspectDatabase(server.dbPath, ['spendings']).counts).toEqual({ spendings: 3 });
  });
});

test.describe('a backup from an older version', () => {
  test('is brought up to date by the migrations when the restored app starts', async ({
    wallet,
  }) => {
    const api = wallet.api;
    await onboard(api, { startMonth: '2026-01', salary: 300000, openingSavings: 50000 });
    const budget = await createBudget(api, {
      name: 'Groceries',
      amount: 40000,
      incremental: false,
    });
    await addSpending(api, {
      budgetId: budget.id,
      date: '2026-04-08',
      amount: 3000,
      description: 'Corner shop',
    });
    const goal = await createGoal(api, { name: 'Holiday', targetAmount: 100000 });
    await api.post('/api/savings/transactions', {
      data: { kind: 'deposit', amount: 25000, goalId: goal.id, date: '2026-04-02', note: 'First' },
    });
    const options: ObserveOptions = { ...OBSERVED };
    const before = await observe(api, options);
    const made = await json<BackupDto>(await api.post('/api/backups'));

    // The backup as an older version made it: the schema before the last three migrations
    // (`0001_savings_group_id`, `0002_import_profiles` and `0003_telegram`) and without their rows in
    // the table that records which migrations were applied.
    const folder = await mkdtemp(join(tmpdir(), 'wallet-e2e-older-'));
    try {
      const older = join(folder, 'wallet-older.db');
      await copyFile(join(wallet.backupDir, made.name), older);
      editDatabase(older, (database) => {
        database.exec(`
          drop index savings_transactions_group_idx;
          alter table savings_transactions drop column group_id;
          drop table import_profiles;
          drop table telegram_entries;
          drop table telegram_link;
          drop table telegram_notifications;
          drop table telegram_pairing;
          drop table telegram_settings;
          delete from __drizzle_migrations where created_at in (select created_at from __drizzle_migrations order by created_at desc limit 3);
        `);
      });
      expect(queryDatabase<number>(older, 'select count(*) from __drizzle_migrations')).toBe(1);
      expect(
        queryDatabase<number>(
          older,
          "select count(*) from sqlite_master where name = 'import_profiles' or name like 'telegram_%'",
        ),
      ).toBe(0);

      await restoreBackup(wallet, older);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }

    // The four migrations are applied again, at startup, and the figures are what they were.
    expect(queryDatabase<number>(wallet.dbPath, 'select count(*) from __drizzle_migrations')).toBe(
      4,
    );
    expect(await observe(api, options)).toEqual(before);

    // What the newer versions added works: a profile can be saved, and a reallocation (its two rows
    // share a group id, the column that the migration added) can be made.
    await api.post('/api/import/profiles', {
      data: { name: 'Sparkasse Giro', mapping: SPARKASSE_MAPPING },
    });
    const other = await createGoal(api, { name: 'Car', targetAmount: 500000 });
    await api.post('/api/savings/transactions', {
      data: {
        kind: 'reallocation',
        amount: 5000,
        fromGoalId: goal.id,
        toGoalId: other.id,
        date: '2026-04-09',
      },
    });
    const savings = await getSavings(api);
    expect(savings.goals.map(({ name, balance }) => [name, balance])).toEqual([
      ['Holiday', 20000],
      ['Car', 5000],
    ]);
    expect(
      queryDatabase<number>(
        wallet.dbPath,
        'select count(*) from savings_transactions where group_id is not null',
      ),
    ).toBe(2);

    // And the tables of the Telegram bot are back too (they hold no money): with no token the bot is off,
    // and the preferences can be saved and read.
    await api.put('/api/telegram/notifications', {
      data: {
        budgetAlerts: false,
        renewalYearlyDays: 3,
        renewalMonthlyDays: 1,
        monthlyRecap: true,
        notifyAt: '07:30',
      },
    });
    expect(await getTelegramStatus(api)).toMatchObject({
      configured: false,
      connection: 'off',
      link: null,
      notifications: { budgetAlerts: false, renewalYearlyDays: 3, notifyAt: '07:30' },
    });
  });
});
