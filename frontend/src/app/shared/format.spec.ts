import {
  clampDateToMonth,
  clampMonth,
  daysInMonth,
  firstDayOf,
  formatBytes,
  formatDate,
  formatDateTime,
  formatMonth,
  formatTime,
  formatTimeUntil,
  lastDayOf,
} from './format';

describe('formatMonth', () => {
  it('writes the month in the locale, long or short', () => {
    expect(formatMonth('2026-10', 'en-US')).toBe('October 2026');
    expect(formatMonth('2026-10', 'en-US', 'short')).toBe('Oct 2026');
    expect(formatMonth('2026-10', 'it-IT')).toBe('ottobre 2026');
    expect(formatMonth('2026-03', 'de-DE')).toBe('März 2026');
  });

  it('can write the month alone, or the year alone, for a chart axis', () => {
    expect(formatMonth('2026-10', 'en-US', 'monthOnly')).toBe('Oct');
    expect(formatMonth('2026-10', 'en-US', 'yearOnly')).toBe('2026');
    expect(formatMonth('2026-03', 'it-IT', 'monthOnly')).toBe('mar');
  });

  it('is not shifted by the time zone of the browser', () => {
    // January 1st at UTC midnight is still December in a time zone west of Greenwich.
    expect(formatMonth('2026-01', 'en-US')).toBe('January 2026');
    expect(formatMonth('2026-12', 'en-US')).toBe('December 2026');
  });

  it('survives a locale that is not valid, and a value that is not a month', () => {
    expect(formatMonth('2026-10', 'not a locale')).toBe('October 2026');
    expect(formatMonth('soon', 'en-US')).toBe('soon');
  });
});

describe('formatDate', () => {
  it('writes a calendar date without moving it', () => {
    expect(formatDate('2026-10-02', 'en-US')).toBe('Fri, Oct 2, 2026');
    expect(formatDate('2026-10-02', 'en-US', 'medium')).toBe('Oct 2, 2026');
    expect(formatDate('2026-10-02', 'en-US', 'day')).toBe('Fri, Oct 2');
    expect(formatDate('2026-03-14', 'en-US', 'monthDay')).toBe('March 14');
    expect(formatDate('2026-03-14', 'it-IT', 'monthDay')).toBe('14 marzo');
    expect(formatDate('2026-12-31', 'en-US', 'medium')).toBe('Dec 31, 2026');
  });

  it('returns what it cannot read', () => {
    expect(formatDate('yesterday', 'en-US')).toBe('yesterday');
  });
});

describe('days of a month', () => {
  it.each([
    ['2026-01', 31],
    ['2026-02', 28],
    ['2028-02', 29],
    ['2100-02', 28],
    ['2000-02', 29],
    ['2026-04', 30],
    ['2026-12', 31],
  ])('%s has %i days', (month, days) => {
    expect(daysInMonth(month)).toBe(days);
  });

  it('gives the first and last day', () => {
    expect(firstDayOf('2026-10')).toBe('2026-10-01');
    expect(lastDayOf('2026-10')).toBe('2026-10-31');
    expect(lastDayOf('2028-02')).toBe('2028-02-29');
  });

  it('keeps a date inside a month', () => {
    expect(clampDateToMonth('2026-10-02', '2026-10')).toBe('2026-10-02');
    expect(clampDateToMonth('2026-10-02', '2026-09')).toBe('2026-09-30'); // a past month: its last day
    expect(clampDateToMonth('2026-10-02', '2026-12')).toBe('2026-12-01'); // a future month: its first day
  });
});

describe('clampMonth', () => {
  it('keeps a month that is inside the range', () => {
    expect(clampMonth('2026-10', '2026-06', '2027-03')).toBe('2026-10');
    expect(clampMonth('2026-06', '2026-06', '2027-03')).toBe('2026-06');
    expect(clampMonth('2027-03', '2026-06', '2027-03')).toBe('2027-03');
  });

  it('moves a month that is outside the range to the nearest end', () => {
    expect(clampMonth('2026-05', '2026-06', '2027-03')).toBe('2026-06');
    expect(clampMonth('2027-04', '2026-06', '2027-03')).toBe('2027-03');
  });

  it('allows a range with no end, or no bounds at all', () => {
    expect(clampMonth('2030-01', '2026-06', null)).toBe('2030-01');
    expect(clampMonth('2020-01', '2026-06', undefined)).toBe('2026-06');
    expect(clampMonth('2026-10')).toBe('2026-10');
  });
});

describe('formatDateTime', () => {
  it('writes the date and the time in the locale, in the zone it is given', () => {
    expect(formatDateTime('2026-10-03T14:25:30.000Z', 'en-US', 'UTC')).toBe('Oct 3, 2026, 2:25 PM');
    expect(formatDateTime('2026-10-03T14:25:30.000Z', 'en-US', 'Asia/Tokyo')).toBe(
      'Oct 3, 2026, 11:25 PM',
    );
  });

  it('follows the locale', () => {
    expect(formatDateTime('2026-10-03T14:25:30.000Z', 'de-DE', 'UTC')).toBe('03.10.2026, 14:25');
  });

  it('falls back to a readable format for an ill-formed locale, and returns text it cannot read as it is', () => {
    expect(formatDateTime('2026-10-03T14:25:30.000Z', 'not a locale', 'UTC')).toContain('2026');
    expect(formatDateTime('yesterday', 'en-US')).toBe('yesterday');
  });
});

describe('formatTime', () => {
  it('writes the time of day in the locale, in the zone it is given', () => {
    expect(formatTime('2026-10-03T14:25:30.000Z', 'en-US', 'UTC')).toBe('2:25 PM');
    expect(formatTime('2026-10-03T14:25:30.000Z', 'en-US', 'Asia/Tokyo')).toBe('11:25 PM');
    expect(formatTime('2026-10-03T14:25:30.000Z', 'de-DE', 'UTC')).toBe('14:25');
  });

  it('falls back for an ill-formed locale, and returns text it cannot read as it is', () => {
    expect(formatTime('2026-10-03T14:25:30.000Z', 'not a locale', 'UTC')).toContain('2:25');
    expect(formatTime('later', 'en-US')).toBe('later');
  });
});

describe('formatTimeUntil', () => {
  const at = Date.parse('2026-10-05T10:00:00.000Z');
  const until = (iso: string, nowMs = at, locale = 'en-US') => formatTimeUntil(iso, nowMs, locale);

  it('counts whole minutes, rounded up', () => {
    expect(until('2026-10-05T10:10:00.000Z')).toBe('in 10 minutes');
    expect(until('2026-10-05T10:09:01.000Z')).toBe('in 10 minutes');
    expect(until('2026-10-05T10:01:00.000Z')).toBe('in 1 minute');
    expect(until('2026-10-05T10:00:10.000Z')).toBe('in 1 minute');
  });

  it('says "this minute" at the instant and after it', () => {
    expect(until('2026-10-05T10:00:00.000Z')).toBe('this minute');
    expect(until('2026-10-05T09:50:00.000Z')).toBe('this minute');
  });

  it('follows the locale, falls back for an ill-formed one, and returns text it cannot read as it is', () => {
    expect(until('2026-10-05T10:10:00.000Z', at, 'de-DE')).toBe('in 10 Minuten');
    expect(until('2026-10-05T10:10:00.000Z', at, 'not a locale')).toBe('in 10 minutes');
    expect(until('soon')).toBe('soon');
  });
});

describe('formatBytes', () => {
  it('writes small sizes in bytes and larger ones with one decimal at most', () => {
    expect(formatBytes(0, 'en-US')).toBe('0 B');
    expect(formatBytes(512, 'en-US')).toBe('512 B');
    expect(formatBytes(1024, 'en-US')).toBe('1 KB');
    expect(formatBytes(1536, 'en-US')).toBe('1.5 KB');
    expect(formatBytes(1048576, 'en-US')).toBe('1 MB');
    expect(formatBytes(12.3 * 1048576, 'en-US')).toBe('12.3 MB');
    expect(formatBytes(3 * 1024 ** 3, 'en-US')).toBe('3 GB');
  });

  it('never writes 1,024 of a unit that has a bigger one', () => {
    expect(formatBytes(1048575, 'en-US')).toBe('1 MB');
    expect(formatBytes(1023, 'en-US')).toBe('1,023 B');
  });

  it('writes the number the way the locale does', () => {
    expect(formatBytes(1536, 'de-DE')).toBe('1,5 KB');
  });
});
