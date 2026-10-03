import {
  BACKUP_KEEP_DAILY,
  BACKUP_KEEP_MONTHLY,
  backupNameOf,
  parseBackupName,
} from '@wallet/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { withTimeZone } from '../../testing/helpers';
import { config } from '../../testing/prop';
import { DEFAULT_ROTATION, type RotationRules, backupsToDelete } from './backups.rotation';

/** The backup name of an ISO instant: `nameAt('2026-03-05T12:00:00Z')` is `wallet-20260305-120000.db`. */
const nameAt = (iso: string) => backupNameOf(new Date(iso));

/** One backup at `time` on each of `count` consecutive UTC days from `firstDay`. */
function dailyBackups(firstDay: string, count: number, time = '03:00:00'): string[] {
  const start = Date.parse(`${firstDay}T00:00:00Z`);
  return Array.from({ length: count }, (_, day) =>
    nameAt(new Date(start + day * 86_400_000).toISOString().replace('T00:00:00', `T${time}`)),
  );
}

const survivors = (
  names: readonly string[],
  rules?: RotationRules,
  protect?: readonly string[],
) => {
  const doomed = new Set(backupsToDelete(names, rules, protect));
  return names.filter((name) => !doomed.has(name)).sort();
};

describe('rotation rules', () => {
  it('uses the contract constants: 14 daily and 12 monthly', () => {
    expect(DEFAULT_ROTATION).toEqual({
      keepDaily: BACKUP_KEEP_DAILY,
      keepMonthly: BACKUP_KEEP_MONTHLY,
    });
    expect([BACKUP_KEEP_DAILY, BACKUP_KEEP_MONTHLY]).toEqual([14, 12]);
  });
});

describe('backupsToDelete: examples', () => {
  it('deletes nothing from an empty list or a single backup', () => {
    expect(backupsToDelete([])).toEqual([]);
    expect(backupsToDelete([nameAt('2026-03-05T12:00:00Z')])).toEqual([]);
  });

  it('keeps only the newest backup of a day: the older ones of that day go, oldest first', () => {
    const names = [
      nameAt('2026-03-05T18:00:00Z'),
      nameAt('2026-03-05T06:00:00Z'),
      nameAt('2026-03-05T23:59:59Z'),
      nameAt('2026-03-05T00:00:00Z'),
    ];
    expect(backupsToDelete(names)).toEqual([
      'wallet-20260305-000000.db',
      'wallet-20260305-060000.db',
      'wallet-20260305-180000.db',
    ]);
  });

  it('a second backup on the same day always replaces the older one, even when that one was the first of its month', () => {
    // The older one is never "the newest of its month": the newer one of the same day is later.
    const names = ['2026-03-01T00:00:00Z', '2026-03-01T00:00:01Z'].map(nameAt);
    expect(backupsToDelete(names)).toEqual(['wallet-20260301-000000.db']);
  });

  it('keeps 14 days when there are exactly 14, and drops the 15th day unless a month rule keeps it', () => {
    // 2026-02-21 .. 2026-03-06 is 14 days across a month boundary.
    expect(backupsToDelete(dailyBackups('2026-02-21', 14))).toEqual([]);
    // One more day back (02-20): its month (February) has the newer 02-28, so 02-20 is deleted.
    const fifteen = dailyBackups('2026-02-20', 15);
    expect(backupsToDelete(fifteen)).toEqual([nameAt('2026-02-20T03:00:00Z')]);
  });

  it('counts days that have a backup, not calendar days: a gap does not shorten the history', () => {
    // 14 backups, one each on every second day over 28 days: all are the newest of their day.
    const start = Date.parse('2026-03-01T00:00:00Z');
    const names = Array.from({ length: 14 }, (_, i) =>
      nameAt(new Date(start + i * 2 * 86_400_000 + 3_600_000).toISOString()),
    );
    expect(backupsToDelete(names)).toEqual([]);
  });

  it('keeps the newest backup of each of the 12 most recent months across a year boundary', () => {
    // Daily backups from 2025-12-01 to 2026-02-09 (71 days): 14 days survive (01-27 .. 02-09), and the
    // monthly rule adds 2025-12-31, the newest of December. January's newest (01-31) is among the dailies.
    const names = dailyBackups('2025-12-01', 71);
    const kept = survivors(names);
    expect(kept).toHaveLength(15);
    expect(kept[0]).toBe(nameAt('2025-12-31T03:00:00Z'));
    expect(kept.slice(1)).toEqual(dailyBackups('2026-01-27', 14));
  });

  it('keeps 12 months and deletes the 13th and older: one backup per month over 15 months', () => {
    // The 28th of every month from 2025-01 to 2026-03 (15 backups): the daily rule keeps the
    // newest 14 (each is the only one of its day), the monthly rule the newest 12 (a subset).
    const names = Array.from({ length: 15 }, (_, i) => {
      const month = ((i % 12) + 1).toString().padStart(2, '0');
      return nameAt(`${2025 + Math.floor(i / 12)}-${month}-28T12:00:00Z`);
    });
    expect(backupsToDelete(names)).toEqual([nameAt('2025-01-28T12:00:00Z')]);
  });

  it('keeps one per month beyond the 14 days: monthly backups outlive the daily window', () => {
    // Three backups a month (the 10th, 20th and 28th) for the 24 months of 2024 and 2025.
    const names: string[] = [];
    for (let m = 0; m < 24; m++) {
      const year = 2024 + Math.floor(m / 12);
      const month = ((m % 12) + 1).toString().padStart(2, '0');
      for (const day of ['10', '20', '28']) names.push(nameAt(`${year}-${month}-${day}T05:00:00Z`));
    }
    const last14 = [...names].sort().slice(-14); // every backup is on a day of its own
    const newestOf2025 = names.filter(
      (name) => name.startsWith('wallet-2025') && name.slice(13, 15) === '28',
    );
    expect(newestOf2025).toHaveLength(12);
    // Aug to Dec 2025 are in both sets, so the union is 14 + 7.
    const expected = [...new Set([...last14, ...newestOf2025])].sort();
    expect(expected).toHaveLength(21);
    expect(survivors(names)).toEqual(expected);
  });

  it('splits days and months at midnight UTC, not at local midnight', () => {
    const names = [
      nameAt('2026-12-31T23:59:59Z'),
      nameAt('2027-01-01T00:00:00Z'),
      nameAt('2027-01-01T00:00:01Z'),
    ];
    // Three different (day, month) buckets for the first and the other two; the two of 01-01 are one day.
    expect(backupsToDelete(names)).toEqual([nameAt('2027-01-01T00:00:00Z')]);
    // With one day and one month kept, the 12-31 backup is gone and only the newest stays.
    expect(backupsToDelete(names, { keepDaily: 1, keepMonthly: 1 })).toEqual([
      nameAt('2026-12-31T23:59:59Z'),
      nameAt('2027-01-01T00:00:00Z'),
    ]);
    // Keeping two months saves December's newest.
    expect(backupsToDelete(names, { keepDaily: 1, keepMonthly: 2 })).toEqual([
      nameAt('2027-01-01T00:00:00Z'),
    ]);
  });

  it('handles leap days: 2028-02-29 is a day of its own, and 2027-02-29 is not a backup name at all', () => {
    const names = [
      nameAt('2028-02-28T10:00:00Z'),
      nameAt('2028-02-29T10:00:00Z'),
      nameAt('2028-03-01T10:00:00Z'),
    ];
    expect(backupsToDelete(names, { keepDaily: 3, keepMonthly: 0 })).toEqual([]);
    expect(backupsToDelete(names, { keepDaily: 2, keepMonthly: 0 })).toEqual([
      nameAt('2028-02-28T10:00:00Z'),
    ]);
    expect(parseBackupName('wallet-20270229-100000.db')).toBeNull();
    expect(backupsToDelete(['wallet-20270229-100000.db', ...names])).toEqual([]);
  });

  it('with only monthly keeping, keeps the newest of each recent month', () => {
    const names = [
      nameAt('2026-01-05T00:00:00Z'),
      nameAt('2026-01-20T00:00:00Z'),
      nameAt('2026-02-03T00:00:00Z'),
      nameAt('2026-02-04T00:00:00Z'),
      nameAt('2026-03-01T00:00:00Z'),
    ];
    expect(backupsToDelete(names, { keepDaily: 0, keepMonthly: 2 })).toEqual([
      nameAt('2026-01-05T00:00:00Z'),
      nameAt('2026-01-20T00:00:00Z'),
      nameAt('2026-02-03T00:00:00Z'),
    ]);
  });

  it('never returns a name that is not a backup name, whatever else is in the list', () => {
    const junk = [
      'notes.txt',
      'wallet.db',
      'wallet-20260305-120000.db.tmp',
      'WALLET-20260305-120000.DB',
      'wallet-20261340-000000.db', // not a real date
      'wallet-20260305-240000.db', // hour 24
      '../wallet-20260305-120000.db',
      'sub/wallet-20260305-120000.db',
      '',
    ];
    const real = dailyBackups('2026-01-01', 20);
    expect(backupsToDelete([...junk, ...real])).toEqual(backupsToDelete(real));
    expect(backupsToDelete(junk)).toEqual([]);
  });

  it('counts a duplicate name once and does not depend on the order of the list', () => {
    const names = dailyBackups('2026-01-01', 30);
    const expected = backupsToDelete(names);
    expect(backupsToDelete([...names, ...names])).toEqual(expected);
    expect(backupsToDelete([...names].reverse())).toEqual(expected);
  });

  it('never deletes a protected name, such as the backup just made when the clock went backwards', () => {
    // The clock went back: this one is older than the backup of the same day that is there already.
    const justMade = nameAt('2026-03-01T01:00:00Z');
    const names = [justMade, ...dailyBackups('2026-03-01', 20)];
    expect(backupsToDelete(names)).toContain(justMade);
    expect(backupsToDelete(names, DEFAULT_ROTATION, [justMade])).not.toContain(justMade);
    // A protected name that is not in the list is simply ignored.
    expect(backupsToDelete(dailyBackups('2026-03-01', 3), DEFAULT_ROTATION, [justMade])).toEqual(
      [],
    );
  });

  it('gives the same answer in every server time zone: it reads the names only', async () => {
    const names = dailyBackups('2026-03-20', 20, '23:30:00'); // across the March clock change in Europe
    const inUtc = backupsToDelete(names);
    for (const zone of ['Europe/Rome', 'America/Los_Angeles', 'Pacific/Auckland']) {
      expect(await withTimeZone(zone, () => backupsToDelete(names))).toEqual(inUtc);
    }
  });

  it('settles to a bounded set: a backup every day for three years, rotated after each', () => {
    let kept: string[] = [];
    const days = 3 * 366;
    const start = Date.parse('2024-01-01T00:00:00Z');
    let maxKept = 0;
    for (let day = 0; day < days; day++) {
      const made = nameAt(new Date(start + day * 86_400_000 + 3 * 3_600_000).toISOString());
      const all = [...kept, made];
      const doomed = new Set(backupsToDelete(all, DEFAULT_ROTATION, [made]));
      kept = all.filter((name) => !doomed.has(name));
      maxKept = Math.max(maxKept, kept.length);
    }
    expect(maxKept).toBeLessThanOrEqual(26);
    // The end state: the last 14 days, plus the last day of each earlier month back to 12 months.
    const lastDay = new Date(start + (days - 1) * 86_400_000);
    expect(kept[kept.length - 1]).toBe(
      nameAt(new Date(lastDay.getTime() + 3 * 3_600_000).toISOString()),
    );
    const months = new Set(kept.map((name) => name.slice(7, 13)));
    expect(months.size).toBe(12);
    // Each kept month's backup that is outside the last 14 days is the last day of that month.
    const lastFourteen = new Set(kept.slice(-14));
    for (const name of kept.filter((n) => !lastFourteen.has(n))) {
      const date = new Date(`${parseBackupName(name)}`);
      const nextDay = new Date(date.getTime() + 86_400_000);
      expect(nextDay.getUTCDate()).toBe(1);
    }
  });
});

describe('backupsToDelete: properties', () => {
  // Instants from 1999 to 2036, to the second, as names, mixed with names that are not backups.
  const instant = fc.integer({
    min: Date.UTC(1999, 0, 1) / 1000,
    max: Date.UTC(2036, 11, 31) / 1000,
  });
  const backupName = instant.map((seconds) => backupNameOf(new Date(seconds * 1000)));
  // Dense: a few days only, so several backups share a day and a month.
  const denseName = fc
    .integer({ min: 0, max: 60 * 86_400 })
    .map((offset) => backupNameOf(new Date(Date.UTC(2026, 0, 1) + offset * 1000)));
  const junkName = fc.constantFrom(
    'notes.txt',
    'wallet.db',
    'wallet-20260305-120000.db.tmp',
    'wallet-20261340-000000.db',
    'WALLET-20260305-120000.db',
  );
  const lists = fc.oneof(
    fc.array(backupName, { maxLength: 80 }),
    fc.array(denseName, { maxLength: 120 }),
    fc.array(fc.oneof(denseName, denseName, junkName), { maxLength: 120 }),
  );
  const rules = fc.record({
    keepDaily: fc.integer({ min: 1, max: 20 }),
    keepMonthly: fc.integer({ min: 1, max: 20 }),
  });
  const valid = (names: string[]) => [...new Set(names)].filter((n) => parseBackupName(n) !== null);

  it('never deletes the newest, never deletes a non-backup, returns each name once and ascending', () => {
    fc.assert(
      fc.property(lists, rules, (names, rule) => {
        const doomed = backupsToDelete(names, rule);
        const real = valid(names).sort();
        expect(new Set(doomed).size).toBe(doomed.length);
        expect(doomed).toEqual([...doomed].sort());
        for (const name of doomed) expect(real).toContain(name);
        if (real.length > 0) expect(doomed).not.toContain(real[real.length - 1]);
      }),
      config(300),
    );
  });

  it('keeps at most keepDaily + keepMonthly backups (and never more than there are)', () => {
    fc.assert(
      fc.property(lists, rules, (names, rule) => {
        const real = valid(names);
        const left = real.length - backupsToDelete(names, rule).length;
        expect(left).toBeLessThanOrEqual(rule.keepDaily + rule.keepMonthly);
        expect(left).toBeLessThanOrEqual(real.length);
        expect(left).toBeGreaterThanOrEqual(Math.min(real.length, 1));
      }),
      config(300),
    );
  });

  it('is idempotent: rotating what is left deletes nothing more', () => {
    fc.assert(
      fc.property(lists, rules, (names, rule) => {
        const doomed = new Set(backupsToDelete(names, rule));
        const left = names.filter((name) => !doomed.has(name));
        expect(backupsToDelete(left, rule)).toEqual([]);
      }),
      config(300),
    );
  });

  it('equals an independent oracle built on Date: the union of the newest of each recent day and month', () => {
    fc.assert(
      fc.property(lists, rules, (names, rule) => {
        const real = valid(names);
        const at = (name: string) => Date.parse(parseBackupName(name) as string);
        const newestBy = (key: (iso: string) => string, count: number) => {
          const byBucket = new Map<string, string>();
          for (const name of real) {
            const bucket = key(new Date(at(name)).toISOString());
            const current = byBucket.get(bucket);
            if (current === undefined || at(name) > at(current)) byBucket.set(bucket, name);
          }
          return [...byBucket.entries()]
            .sort(([a], [b]) => (a < b ? 1 : -1)) // most recent bucket first
            .slice(0, count)
            .map(([, name]) => name);
        };
        const kept = new Set([
          ...newestBy((iso) => iso.slice(0, 10), rule.keepDaily),
          ...newestBy((iso) => iso.slice(0, 7), rule.keepMonthly),
        ]);
        expect(backupsToDelete(names, rule)).toEqual(real.filter((n) => !kept.has(n)).sort());
      }),
      config(300),
    );
  });

  it('does not depend on the order of the list, and a protected name always survives', () => {
    fc.assert(
      fc.property(lists, rules, fc.integer({ min: 0, max: 1000 }), (names, rule, pick) => {
        const doomed = backupsToDelete(names, rule);
        expect(backupsToDelete([...names].reverse(), rule)).toEqual(doomed);
        const real = valid(names);
        if (real.length === 0) return;
        const protectedName = real[pick % real.length] as string;
        expect(backupsToDelete(names, rule, [protectedName])).not.toContain(protectedName);
        // Protecting only ever removes names from the answer.
        for (const name of backupsToDelete(names, rule, [protectedName]))
          expect(doomed).toContain(name);
      }),
      config(300),
    );
  });

  it('keeps every recent day and month that has a backup represented, and keeps the count bounded over time', () => {
    fc.assert(
      fc.property(fc.array(denseName, { minLength: 1, maxLength: 150 }), (names) => {
        const left = survivors(names);
        const days = [...new Set(valid(names).map((n) => n.slice(7, 15)))].sort().slice(-14);
        for (const day of days) expect(left.some((name) => name.slice(7, 15) === day)).toBe(true);
        const months = [...new Set(valid(names).map((n) => n.slice(7, 13)))].sort().slice(-12);
        for (const month of months)
          expect(left.some((name) => name.slice(7, 13) === month)).toBe(true);
        expect(left.length).toBeLessThanOrEqual(26);
      }),
      config(200),
    );
  });
});
