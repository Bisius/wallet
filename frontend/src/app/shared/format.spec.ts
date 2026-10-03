import {
  clampDateToMonth,
  clampMonth,
  daysInMonth,
  firstDayOf,
  formatDate,
  formatMonth,
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
