import { describe, expect, it } from 'vitest';
import {
  BACKUP_INTERVAL_HOURS,
  BACKUP_KEEP_DAILY,
  BACKUP_KEEP_MONTHLY,
  BACKUP_NAME_PATTERN,
  backupNameOf,
  backupNameParamsSchema,
  parseBackupName,
} from './backups';
import { schemaCases } from './test-utils';

describe('parseBackupName', () => {
  it.each([
    ['wallet-20261003-142530.db', '2026-10-03T14:25:30.000Z'],
    ['wallet-20260101-000000.db', '2026-01-01T00:00:00.000Z'],
    ['wallet-20261231-235959.db', '2026-12-31T23:59:59.000Z'],
    ['wallet-20280229-120000.db', '2028-02-29T12:00:00.000Z'],
  ])('%s is %s', (name, iso) => {
    expect(parseBackupName(name)).toBe(iso);
  });

  it.each([
    ['not a date: month 13', 'wallet-20261340-000000.db'],
    ['not a date: 31 February', 'wallet-20260231-000000.db'],
    ['not a date: 29 February in a common year', 'wallet-20270229-000000.db'],
    ['not a time: hour 24', 'wallet-20261003-240000.db'],
    ['not a time: minute 60', 'wallet-20261003-126000.db'],
    ['not a time: second 60', 'wallet-20261003-120060.db'],
    ['month 0', 'wallet-20260001-000000.db'],
    ['day 0', 'wallet-20260100-000000.db'],
    ['another extension', 'wallet-20261003-142530.sqlite'],
    ['an upper-case extension', 'wallet-20261003-142530.DB'],
    ['another prefix', 'backup-20261003-142530.db'],
    ['an upper-case prefix', 'Wallet-20261003-142530.db'],
    ['no dash between date and time', 'wallet-20261003142530.db'],
    ['a short time', 'wallet-20261003-1425.db'],
    ['a short date', 'wallet-2026103-142530.db'],
    ['a suffix', 'wallet-20261003-142530.db.bak'],
    ['the partial name of a backup under way', 'wallet-20261003-142530.db.partial'],
    ['a prefix before it', 'x-wallet-20261003-142530.db'],
    ['spaces', ' wallet-20261003-142530.db'],
    ['a trailing newline', 'wallet-20261003-142530.db\n'],
    ['a path', 'backups/wallet-20261003-142530.db'],
    ['a parent path', '../wallet-20261003-142530.db'],
    ['a traversal', '../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
    ['a windows path', '..\\wallet-20261003-142530.db'],
    ['a NUL byte', 'wallet-20261003-142530.db\u0000'],
    ['a NUL byte in the middle', 'wallet-20261003-14\u00002530.db'],
    ['a percent-encoded dot', 'wallet-20261003-142530%2edb'],
    ['an empty name', ''],
    ['just the extension', '.db'],
    ['the database itself', 'wallet.db'],
    ['Arabic-Indic digits', 'wallet-٢٠٢٦١٠٠٣-١٤٢٥٣٠.db'],
    ['a write-ahead log', 'wallet-20261003-142530.db-wal'],
  ])('refuses %s', (_name, name) => {
    expect(parseBackupName(name)).toBeNull();
  });

  it('matches BACKUP_NAME_PATTERN for every name it accepts', () => {
    expect(BACKUP_NAME_PATTERN.test('wallet-20261003-142530.db')).toBe(true);
    expect(BACKUP_NAME_PATTERN.test('wallet-20261003-142530.db.partial')).toBe(false);
  });
});

describe('backupNameOf', () => {
  it('writes the whole seconds of the UTC time', () => {
    expect(backupNameOf(new Date('2026-10-03T14:25:30.999Z'))).toBe('wallet-20261003-142530.db');
    expect(backupNameOf(new Date('2026-01-01T00:00:00Z'))).toBe('wallet-20260101-000000.db');
    expect(backupNameOf(new Date('2026-12-31T23:59:59Z'))).toBe('wallet-20261231-235959.db');
  });

  it('does not depend on the time zone of the server (a +02:00 offset is converted)', () => {
    expect(backupNameOf(new Date('2026-10-03T01:30:00+02:00'))).toBe('wallet-20261002-233000.db');
  });

  it('is read back by parseBackupName as the same second', () => {
    for (const iso of [
      '2026-10-03T14:25:30.000Z',
      '2028-02-29T00:00:00.000Z',
      '2026-12-31T23:59:59.000Z',
    ]) {
      expect(parseBackupName(backupNameOf(new Date(iso)))).toBe(iso);
    }
  });

  it('gives names that sort in time order', () => {
    const names = [
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:01Z',
      '2026-01-02T00:00:00Z',
      '2027-01-01T00:00:00Z',
    ].map((iso) => backupNameOf(new Date(iso)));
    expect([...names].sort()).toEqual(names);
  });
});

describe('backupNameParamsSchema (path /:name)', () => {
  schemaCases(
    'name',
    backupNameParamsSchema,
    [
      ['a backup name', { name: 'wallet-20261003-142530.db' }],
      ['the first second of a year', { name: 'wallet-20260101-000000.db' }],
    ],
    [
      ['a path traversal', { name: '../wallet-20261003-142530.db' }, 'name'],
      ['a deeper traversal', { name: '../../etc/passwd' }, 'name'],
      ['a name in a folder', { name: 'backups/wallet-20261003-142530.db' }, 'name'],
      ['the database file', { name: 'wallet.db' }, 'name'],
      ['an impossible date', { name: 'wallet-20261340-000000.db' }, 'name'],
      ['a partial file', { name: 'wallet-20261003-142530.db.partial' }, 'name'],
      ['an empty name', { name: '' }, 'name'],
      ['a missing name', {}, 'name'],
      ['a number', { name: 5 }, 'name'],
      ['an unknown key', { name: 'wallet-20261003-142530.db', dir: '/tmp' }, ''],
    ],
  );
});

describe('the backup constants', () => {
  it('follow docs/PLAN.md: every 24 hours, keeping 14 daily and 12 monthly', () => {
    expect(BACKUP_INTERVAL_HOURS).toBe(24);
    expect(BACKUP_KEEP_DAILY).toBe(14);
    expect(BACKUP_KEEP_MONTHLY).toBe(12);
  });
});
