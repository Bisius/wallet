import type { BackupDto, BackupsDto } from '@wallet/shared';
import { backupNameParamsSchema } from '@wallet/shared';
import Database from 'better-sqlite3';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import request, { type Response } from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  expectApiError,
  expectNotFound,
  expectValidationPaths,
  onboard,
} from '../../testing/helpers';
import {
  cleanUpBackupFixtures,
  createBackupFixture,
  openBackupReadOnly,
  writeFakeBackups,
} from '../../testing/backup-fixture';
import { createTestApp } from '../../testing/test-app';

afterEach(() => {
  cleanUpBackupFixtures();
  vi.restoreAllMocks();
});

const binary = (res: Response, callback: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};
const download = (app: Parameters<typeof request>[0], name: string) =>
  request(app).get(`/api/backups/${name}`).buffer(true).parse(binary);

const names = (dir: string) => readdirSync(dir).sort();

describe('GET /api/backups', () => {
  it('without a backup directory (in-memory database): 200, automatic false, nothing listed', async () => {
    const { app } = createTestApp();
    const res = await request(app).get('/api/backups').expect(200);
    expect(res.body).toEqual({
      automatic: false,
      backups: [],
      lastBackupAt: null,
      nextDueAt: null,
    });
  });

  it('with a directory that does not exist yet: automatic, no backups, due now', async () => {
    const { app, backupDir } = createBackupFixture();
    expect(existsSync(backupDir as string)).toBe(false); // created on the first backup
    const res = await request(app).get('/api/backups').expect(200);
    expect(res.body).toEqual({
      automatic: true,
      backups: [],
      lastBackupAt: null,
      nextDueAt: '2026-03-15T10:00:00.000Z',
    });
    expect(existsSync(backupDir as string)).toBe(false); // listing never creates it
  });

  it('lists the backups newest first with createdAt from the name, and the next one due 24 h after the newest', async () => {
    const { app, backupDir } = createBackupFixture();
    writeFakeBackups(backupDir as string, [
      'wallet-20260101-030000.db',
      'wallet-20260314-030000.db',
      'wallet-20251231-235959.db',
    ]);
    const body: BackupsDto = (await request(app).get('/api/backups').expect(200)).body;
    expect(body.automatic).toBe(true);
    expect(body.backups).toEqual([
      { name: 'wallet-20260314-030000.db', createdAt: '2026-03-14T03:00:00.000Z', sizeBytes: 1 },
      { name: 'wallet-20260101-030000.db', createdAt: '2026-01-01T03:00:00.000Z', sizeBytes: 1 },
      { name: 'wallet-20251231-235959.db', createdAt: '2025-12-31T23:59:59.000Z', sizeBytes: 1 },
    ]);
    expect(body.lastBackupAt).toBe('2026-03-14T03:00:00.000Z');
    expect(body.nextDueAt).toBe('2026-03-15T03:00:00.000Z');
  });

  it('takes createdAt from the name, never from the modification time, and reports the real size', async () => {
    const { app, backupDir } = createBackupFixture();
    writeFakeBackups(backupDir as string, ['wallet-20260301-030000.db'], 'twelve bytes');
    utimesSync(
      join(backupDir as string, 'wallet-20260301-030000.db'),
      new Date('2001-01-01'),
      new Date('2001-01-01'),
    );
    const { backups } = (await request(app).get('/api/backups').expect(200)).body as BackupsDto;
    expect(backups).toEqual([
      { name: 'wallet-20260301-030000.db', createdAt: '2026-03-01T03:00:00.000Z', sizeBytes: 12 },
    ]);
  });

  it('lists regular files with a backup name only: not links, folders, temporary files or other files', async () => {
    const { app, backupDir, root } = createBackupFixture();
    const dir = backupDir as string;
    writeFakeBackups(dir, [
      'wallet-20260301-030000.db',
      'wallet-20260301-030000.db.tmp',
      'wallet-20261340-000000.db', // not a real date
      'WALLET-20260302-030000.db',
      'notes.txt',
      'wallet.db',
    ]);
    mkdirSync(join(dir, 'wallet-20260303-030000.db')); // a folder with a backup's name
    writeFileSync(join(root, 'secret.txt'), 'secret');
    symlinkSync(join(root, 'secret.txt'), join(dir, 'wallet-20260304-030000.db')); // a link to a file
    symlinkSync(join(root, 'missing'), join(dir, 'wallet-20260305-030000.db')); // a dangling link
    const { backups } = (await request(app).get('/api/backups').expect(200)).body as BackupsDto;
    expect(backups.map((backup) => backup.name)).toEqual(['wallet-20260301-030000.db']);
  });

  it('is reachable before onboarding, like /health and /settings', async () => {
    const { app } = createBackupFixture();
    expectApiError(await request(app).get('/api/salary'), 'not_onboarded'); // the control: setup is not done
    await request(app).get('/api/backups').expect(200);
  });
});

describe('POST /api/backups', () => {
  it('takes a backup: 201 with the DTO, the file is a whole SQLite database in one file', async () => {
    const { app, backupDir, clock } = createBackupFixture();
    clock.set('2026-03-15T14:25:30.789Z');
    const res = await request(app).post('/api/backups').expect(201);
    const dir = backupDir as string;
    expect(res.body).toEqual({
      name: 'wallet-20260315-142530.db',
      createdAt: '2026-03-15T14:25:30.000Z',
      sizeBytes: statSync(join(dir, 'wallet-20260315-142530.db')).size,
    } satisfies BackupDto);
    expect(res.body.sizeBytes).toBeGreaterThan(0);

    // Only the finished file is there: no temporary file, and no -wal or -shm side files.
    expect(names(dir)).toEqual(['wallet-20260315-142530.db']);
    const bytes = readFileSync(join(dir, 'wallet-20260315-142530.db'));
    expect(bytes.subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0');
    expect([bytes[18], bytes[19]]).toEqual([1, 1]); // rollback journal, not WAL: nothing to carry along

    const list = (await request(app).get('/api/backups').expect(200)).body as BackupsDto;
    expect(list.backups).toEqual([res.body]);
    expect(list.lastBackupAt).toBe('2026-03-15T14:25:30.000Z');
    expect(list.nextDueAt).toBe('2026-03-16T14:25:30.000Z');
  });

  it('works before onboarding, and takes a backup of an empty (fully migrated) database', async () => {
    const { app, backupDir } = createBackupFixture();
    expectApiError(await request(app).get('/api/salary'), 'not_onboarded');
    await request(app).post('/api/backups').expect(201);
    const copy = openBackupReadOnly(
      join(backupDir as string, readdirSync(backupDir as string)[0] as string),
    );
    try {
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(copy.prepare('select count(*) from settings').pluck().get()).toBe(0);
      expect(
        copy.prepare('select count(*) from __drizzle_migrations').pluck().get(),
      ).toBeGreaterThan(0);
    } finally {
      copy.close();
    }
  });

  it('works with the in-memory database when a backup directory is given', async () => {
    const { app, backupDir } = createBackupFixture({ file: false });
    await onboard(app);
    const res = await request(app).post('/api/backups').expect(201);
    const copy = openBackupReadOnly(join(backupDir as string, res.body.name));
    try {
      expect(copy.prepare('select currency from settings').pluck().get()).toBe('EUR');
    } finally {
      copy.close();
    }
  });

  it('answers 409 backups_unavailable without a backup directory, and writes nothing anywhere', async () => {
    const { app } = createTestApp();
    const res = await request(app).post('/api/backups');
    expectApiError(res, 'backups_unavailable');
    expect(res.status).toBe(409);
  });

  it('never reuses a name: backups in the same second take the next free seconds', async () => {
    const { app, backupDir } = createBackupFixture();
    const a: BackupDto = (await request(app).post('/api/backups').expect(201)).body;
    const b: BackupDto = (await request(app).post('/api/backups').expect(201)).body;
    const c: BackupDto = (await request(app).post('/api/backups').expect(201)).body;
    expect([a.name, b.name, c.name]).toEqual([
      'wallet-20260315-100000.db',
      'wallet-20260315-100001.db',
      'wallet-20260315-100002.db',
    ]);
    // Rotation keeps the newest of the day, so only the last is left; the names were still distinct.
    expect(names(backupDir as string)).toEqual(['wallet-20260315-100002.db']);
  });

  it('skips a name taken by something that is not a backup, such as a folder or a link', async () => {
    const { app, backupDir, root } = createBackupFixture();
    const dir = backupDir as string;
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'wallet-20260315-100000.db'));
    symlinkSync(join(root, 'nowhere'), join(dir, 'wallet-20260315-100001.db'));
    const res = await request(app).post('/api/backups').expect(201);
    expect(res.body.name).toBe('wallet-20260315-100002.db');
    expect(existsSync(join(dir, 'wallet-20260315-100002.db'))).toBe(true);
  });

  it('serializes overlapping requests: all succeed, each with its own name, and the directory ends consistent', async () => {
    const { app, backupDir } = createBackupFixture();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => request(app).post('/api/backups').expect(201)),
    );
    const created = responses.map((res) => (res.body as BackupDto).name).sort();
    expect(new Set(created).size).toBe(6);
    expect(created[0]).toBe('wallet-20260315-100000.db');
    expect(created[5]).toBe('wallet-20260315-100005.db');
    // One backup per day is kept, and no temporary file is left.
    expect(names(backupDir as string)).toEqual(['wallet-20260315-100005.db']);
    const copy = openBackupReadOnly(join(backupDir as string, 'wallet-20260315-100005.db'));
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    copy.close();
  });

  it('applies rotation after the backup: 14 days and the newest of each month, the file just made is kept', async () => {
    const { app, backupDir, clock } = createBackupFixture();
    const dir = backupDir as string;
    // One backup a day at 03:00 from 2026-01-01 to 2026-03-14.
    const days: string[] = [];
    for (let t = Date.UTC(2026, 0, 1); t <= Date.UTC(2026, 2, 14); t += 86_400_000) {
      const iso = new Date(t).toISOString();
      days.push(`wallet-${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-030000.db`);
    }
    writeFakeBackups(dir, [...days, 'notes.txt', 'wallet-20260301-030000.db.tmp']);
    clock.set('2026-03-15T10:00:00Z');
    const res = await request(app).post('/api/backups').expect(201);
    expect(res.body.name).toBe('wallet-20260315-100000.db');

    const expectedBackups = [
      'wallet-20260131-030000.db', // newest of January
      'wallet-20260228-030000.db', // newest of February
      ...Array.from(
        { length: 13 },
        (_, i) => `wallet-202603${String(i + 2).padStart(2, '0')}-030000.db`,
      ), // 03-02 .. 03-14
      'wallet-20260315-100000.db', // just made: the 14th day
    ];
    // Files that are not backups are never touched.
    expect(names(dir)).toEqual(
      [...expectedBackups, 'notes.txt', 'wallet-20260301-030000.db.tmp'].sort(),
    );
  });

  it('a second backup on the same day replaces the first one of that day', async () => {
    const { app, backupDir, clock } = createBackupFixture();
    await request(app).post('/api/backups').expect(201);
    clock.set('2026-03-15T18:30:00Z');
    await request(app).post('/api/backups').expect(201);
    expect(names(backupDir as string)).toEqual(['wallet-20260315-183000.db']);
  });

  it('names a backup after the newest one when the clock went backwards, so names keep the order of creation', async () => {
    const { app, backupDir, clock } = createBackupFixture();
    const dir = backupDir as string;
    writeFakeBackups(dir, ['wallet-20260315-120000.db']); // "in the future" of the clock below
    clock.set('2026-03-15T09:00:00Z');
    const res = await request(app).post('/api/backups').expect(201);
    expect(res.body).toMatchObject({
      name: 'wallet-20260315-120001.db',
      createdAt: '2026-03-15T12:00:01.000Z',
    });
    // It is the newest by name, so it is what the day keeps; the older one of that day goes.
    expect(names(dir)).toEqual(['wallet-20260315-120001.db']);

    clock.set('2026-03-14T00:00:00Z'); // and across a day boundary
    expect((await request(app).post('/api/backups').expect(201)).body.name).toBe(
      'wallet-20260315-120002.db',
    );
  });

  it('leaves symlinks and folders alone in rotation, and never follows a link to delete its target', async () => {
    const { app, backupDir, root, clock } = createBackupFixture();
    const dir = backupDir as string;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, 'precious.txt'), 'keep me');
    symlinkSync(join(root, 'precious.txt'), join(dir, 'wallet-20260315-010000.db')); // same day, older
    mkdirSync(join(dir, 'wallet-20260315-020000.db'));
    clock.set('2026-03-15T10:00:00Z');
    await request(app).post('/api/backups').expect(201);
    expect(existsSync(join(root, 'precious.txt'))).toBe(true);
    expect(names(dir)).toEqual([
      'wallet-20260315-010000.db',
      'wallet-20260315-020000.db',
      'wallet-20260315-100000.db',
    ]);
  });

  it('a failure is a 500 in the error format, leaves no file behind, and does not wedge later backups', async () => {
    const { app, db, backupDir } = createBackupFixture();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const realBackup = db.$client.backup.bind(db.$client);
    vi.spyOn(db.$client, 'backup').mockImplementationOnce(async (destination: string) => {
      writeFileSync(destination, 'half of a database');
      throw new Error('ENOSPC: no space left on device');
    });
    const failed = await request(app).post('/api/backups');
    expectApiError(failed, 'internal_error');
    expect(failed.body.error.message).not.toMatch(/ENOSPC/); // internals stay in the log
    expect(readdirSync(backupDir as string)).toEqual([]);

    vi.spyOn(db.$client, 'backup').mockImplementation(realBackup);
    await request(app).post('/api/backups').expect(201);
    expect(names(backupDir as string)).toEqual(['wallet-20260315-100000.db']);
  });

  it('refuses a copy that does not verify: it never gets a backup name', async () => {
    const { app, db, backupDir } = createBackupFixture();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(db.$client, 'backup').mockImplementation(async (destination: string) => {
      writeFileSync(destination, 'this is not a database file at all, only text');
      return { totalPages: 0, remainingPages: 0 };
    });
    expectApiError(await request(app).post('/api/backups'), 'internal_error');
    expect(readdirSync(backupDir as string)).toEqual([]);
    const list = (await request(app).get('/api/backups').expect(200)).body as BackupsDto;
    expect(list.backups).toEqual([]);
  });
});

describe('GET /api/backups/:name', () => {
  it('downloads the file itself: same bytes, as an attachment, not cacheable', async () => {
    const { app, backupDir } = createBackupFixture();
    await onboard(app);
    const { name } = (await request(app).post('/api/backups').expect(201)).body as BackupDto;
    const res = await download(app, name).expect(200);
    const onDisk = readFileSync(join(backupDir as string, name));
    expect(Buffer.compare(res.body as Buffer, onDisk)).toBe(0);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${name}"`);
    expect(res.headers['content-length']).toBe(String(onDisk.length));
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers 404 for a file that rotation removed after the list showed it', async () => {
    const { app, backupDir } = createBackupFixture();
    const { name } = (await request(app).post('/api/backups').expect(201)).body as BackupDto;
    await download(app, name).expect(200);
    await request(app).post('/api/backups').expect(201); // the same day: replaces the first
    expect(existsSync(join(backupDir as string, name))).toBe(false);
    expectNotFound(await request(app).get(`/api/backups/${name}`));
  });

  it('answers 404 for a well-formed name that is not there, also before the directory exists', async () => {
    const { app } = createBackupFixture();
    expectNotFound(await request(app).get('/api/backups/wallet-20260101-000000.db'));
  });

  it('answers 404 without a backup directory', async () => {
    const { app } = createTestApp();
    expectNotFound(await request(app).get('/api/backups/wallet-20260101-000000.db'));
  });

  it('answers 404, not the target, for a symbolic link or a folder with a backup name', async () => {
    const { app, backupDir, root } = createBackupFixture();
    const dir = backupDir as string;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, 'secret.txt'), 'top secret');
    symlinkSync(join(root, 'secret.txt'), join(dir, 'wallet-20260101-000000.db'));
    mkdirSync(join(dir, 'wallet-20260102-000000.db'));
    for (const name of ['wallet-20260101-000000.db', 'wallet-20260102-000000.db']) {
      const res = await request(app).get(`/api/backups/${name}`);
      expectNotFound(res);
      expect(JSON.stringify(res.body)).not.toContain('secret');
    }
  });

  it('does not serve other files of the directory, nor a temporary file', async () => {
    const { app, backupDir } = createBackupFixture();
    writeFakeBackups(backupDir as string, [
      'notes.txt',
      'wallet-20260101-000000.db.tmp',
      'wallet.db',
    ]);
    for (const name of ['notes.txt', 'wallet-20260101-000000.db.tmp', 'wallet.db']) {
      expectValidationPaths(await request(app).get(`/api/backups/${name}`), 'name');
    }
  });

  it.each([
    ['a parent folder', '..%2Fwallet-20260101-000000.db'],
    ['an encoded parent folder', '%2e%2e%2fx'],
    ['a double-encoded one', '..%252fx'],
    ['an absolute path', '%2Fetc%2Fpasswd'],
    ['a Windows path', '..%5Cwallet-20260101-000000.db'],
    ['a path inside the name', 'sub%2Fwallet-20260101-000000.db'],
    ['the temporary name', 'wallet-20260101-000000.db.tmp'],
    ['upper case', 'WALLET-20260101-000000.DB'],
    ['an upper-case extension', 'wallet-20260101-000000.DB'],
    ['a NUL byte', 'wallet-20260101-000000.db%00'],
    ['a trailing space', 'wallet-20260101-000000.db%20'],
    ['a newline', 'wallet-20260101-000000.db%0A'],
    ['a leading space', '%20wallet-20260101-000000.db'],
    ['a date that does not exist', 'wallet-20261340-000000.db'],
    ['the 29th of February of a common year', 'wallet-20270229-000000.db'],
    ['hour 24', 'wallet-20260101-240000.db'],
    ['dashes in the date', 'wallet-2026-01-01.db'],
    ['no name at all, just dots', '..'],
    ['a dot', '.'],
    ['a malformed percent escape', '%E0%A4%A'],
    ['a lone percent sign', '%'],
    ['an unrelated name', 'wallet.db'],
  ])('answers 400 at "name" for %s', async (_what, name) => {
    const { app } = createBackupFixture();
    expectValidationPaths(await request(app).get(`/api/backups/${name}`), 'name');
  });

  it('answers 400 or 404, never a file, for dot segments sent as they are (no client normalises them)', async () => {
    const { app, root } = createBackupFixture();
    writeFileSync(join(root, 'secret.txt'), 'top secret');
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      for (const path of [
        '/api/backups/../../secret.txt',
        '/api/backups/../wallet.db',
        '/api/backups/%2e%2e/%2e%2e/secret.txt',
        `/api/backups/${root}/secret.txt`,
      ]) {
        const { status, body } = await new Promise<{ status: number; body: string }>(
          (resolve, reject) => {
            const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
              let text = '';
              res.on('data', (chunk) => (text += chunk));
              res.on('end', () => resolve({ status: res.statusCode as number, body: text }));
            });
            req.on('error', reject);
            req.end();
          },
        );
        expect([400, 404], path).toContain(status);
        expect(body).not.toContain('top secret');
        expect(JSON.parse(body).error.code).toMatch(/^(validation_error|not_found)$/);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('shares its name check with the contract: the validation message says what a name looks like', async () => {
    const { app } = createBackupFixture();
    const res = await request(app).get('/api/backups/nope');
    expectValidationPaths(res, 'name');
    expect(res.body.error.details[0].message).toMatch(/wallet-20261003-142530\.db/);
    expect(backupNameParamsSchema.safeParse({ name: 'nope' }).success).toBe(false);
  });

  it('streams a larger file completely', async () => {
    const { app, backupDir } = createBackupFixture();
    const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    mkdirSync(backupDir as string, { recursive: true });
    writeFileSync(join(backupDir as string, 'wallet-20260101-000000.db'), big);
    const res = await download(app, 'wallet-20260101-000000.db').expect(200);
    expect(Buffer.compare(res.body as Buffer, big)).toBe(0);
  });
});

describe('what a backup contains', () => {
  it('opens as a database, with the same applied migrations and tables as the live one', async () => {
    const { app, db, backupDir } = createBackupFixture();
    await onboard(app);
    const { name } = (await request(app).post('/api/backups').expect(201)).body as BackupDto;
    const copy = new Database(join(backupDir as string, name), { readonly: true });
    try {
      const tables = (sqlite: Database.Database) =>
        sqlite
          .prepare("select name from sqlite_master where type = 'table' order by name")
          .pluck()
          .all();
      expect(tables(copy)).toEqual(tables(db.$client));
      const migrations = (sqlite: Database.Database) =>
        sqlite.prepare('select hash, created_at from __drizzle_migrations order by rowid').all();
      expect(migrations(copy)).toEqual(migrations(db.$client));
      expect(migrations(copy).length).toBeGreaterThan(0);
    } finally {
      copy.close();
    }
  });
});
