import Database from 'better-sqlite3';
import {
  copyFileSync,
  openSync,
  readFileSync,
  truncateSync,
  writeFileSync,
  writeSync,
  closeSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanUpBackupFixtures, createBackupFixture } from '../../testing/backup-fixture';
import { makeSelfContained, verifyCopy } from './backups.service';

afterEach(cleanUpBackupFixtures);

/** A source database with some data and a copy of its file that the test may damage. */
async function sourceAndCopy() {
  const { db, root } = createBackupFixture();
  const sqlite = db.$client;
  sqlite.exec('create table ballast (id integer primary key, pad text not null)');
  sqlite.transaction(() => {
    const insert = sqlite.prepare('insert into ballast (pad) values (?)');
    for (let i = 0; i < 5000; i++) insert.run(`row ${i} ${'z'.repeat(300)}`);
  })();
  const path = join(root, 'copy.db');
  await sqlite.backup(path);
  makeSelfContained(path);
  return { sqlite, path };
}

describe('verifyCopy', () => {
  it('accepts a good copy, and makeSelfContained leaves a single file in rollback-journal mode', async () => {
    const { sqlite, path } = await sourceAndCopy();
    expect(() => verifyCopy(path, sqlite)).not.toThrow();
    const header = readFileSync(path).subarray(16, 20);
    expect([header[2], header[3]]).toEqual([1, 1]); // bytes 18 and 19: legacy, not WAL
  });

  it('rejects a copy that lacks a table the live database has', async () => {
    const { sqlite, path } = await sourceAndCopy();
    const copy = new Database(path);
    copy.exec('drop table ballast');
    copy.close();
    expect(() => verifyCopy(path, sqlite)).toThrow(/tables missing from the copy: ballast/);
  });

  it('rejects a copy whose list of applied migrations differs', async () => {
    const { sqlite, path } = await sourceAndCopy();
    const copy = new Database(path);
    copy.exec(
      'delete from __drizzle_migrations where rowid = (select max(rowid) from __drizzle_migrations)',
    );
    copy.close();
    expect(() => verifyCopy(path, sqlite)).toThrow(/applied migrations/);
  });

  it('rejects a copy with damaged pages', async () => {
    const { sqlite, path } = await sourceAndCopy();
    const size = statSync(path).size;
    const fd = openSync(path, 'r+');
    // Overwrite a stretch in the middle of the data with garbage, leaving the header intact.
    writeSync(fd, Buffer.alloc(20_000, 0xab), 0, 20_000, Math.floor(size / 2));
    closeSync(fd);
    expect(() => verifyCopy(path, sqlite)).toThrow();
  });

  it('rejects a truncated copy', async () => {
    const { sqlite, path } = await sourceAndCopy();
    truncateSync(path, Math.floor(statSync(path).size / 2));
    expect(() => verifyCopy(path, sqlite)).toThrow();
  });

  it('rejects a file that is not a database, and one that is missing', async () => {
    const { sqlite, path } = await sourceAndCopy();
    writeFileSync(
      path,
      'this is plain text, not a SQLite file at all, nothing to see here, move along',
    );
    expect(() => verifyCopy(path, sqlite)).toThrow();
    expect(() => verifyCopy(`${path}.missing`, sqlite)).toThrow();
  });

  it('never creates side files while checking: it opens the copy read-only', async () => {
    const { sqlite, path } = await sourceAndCopy();
    const other = join(path, '..', 'copy2.db');
    copyFileSync(path, other);
    verifyCopy(other, sqlite);
    expect(() => readFileSync(`${other}-wal`)).toThrow();
    expect(() => readFileSync(`${other}-shm`)).toThrow();
  });
});
