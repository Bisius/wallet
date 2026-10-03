import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  billingDateIn,
  daysBetween,
  daysInMonth,
  isMonthKey,
  monthDiff,
  monthRange,
} from './month';

describe('month helpers', () => {
  it('validates month keys', () => {
    expect(isMonthKey('2026-10')).toBe(true);
    expect(isMonthKey('2026-13')).toBe(false);
    expect(isMonthKey('2026-1')).toBe(false);
  });

  it('adds months across year boundaries', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-05', 14)).toBe('2027-07');
  });

  it('builds inclusive ranges', () => {
    expect(monthRange('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(monthRange('2027-01', '2026-12')).toEqual([]);
  });

  it.each([
    ['2026-10', '2026-10', 0],
    ['2026-10', '2026-11', 1],
    ['2026-12', '2027-01', 1],
    ['2026-10', '2027-10', 12],
    ['2026-03', '2026-10', 7],
    ['2026-10', '2026-03', -7],
    ['2025-12', '2026-01', 1],
  ])('monthDiff(%s, %s) is %i', (from, to, expected) => {
    expect(monthDiff(from, to)).toBe(expected);
  });

  it('monthDiff is the inverse of addMonths', () => {
    for (const delta of [-25, -1, 0, 1, 11, 12, 13, 120]) {
      expect(monthDiff('2026-10', addMonths('2026-10', delta))).toBe(delta);
    }
  });
});

describe('day helpers', () => {
  it.each([
    ['2026-01', 31],
    ['2026-02', 28],
    ['2028-02', 29],
    ['2100-02', 28], // not a leap year
    ['2000-02', 29],
    ['2026-04', 30],
    ['2026-12', 31],
  ])('daysInMonth(%s) is %i', (month, expected) => {
    expect(daysInMonth(month)).toBe(expected);
  });

  it.each([
    ['2026-04', '2026-01-31', '2026-04-30'],
    ['2026-02', '2026-01-31', '2026-02-28'],
    ['2028-02', '2026-01-31', '2028-02-29'],
    ['2026-03', '2024-02-29', '2026-03-29'],
    ['2026-02', '2024-02-29', '2026-02-28'],
    ['2026-05', '2026-01-05', '2026-05-05'],
  ])('billingDateIn(%s, %s) is %s', (month, anchor, expected) => {
    expect(billingDateIn(month, anchor)).toBe(expected);
  });

  it.each([
    ['2026-10-03', 0, '2026-10-03'],
    ['2026-10-03', 28, '2026-10-31'],
    ['2026-10-03', 29, '2026-11-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2027-02-28', 1, '2027-03-01'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2027-03-15', 366, '2028-03-15'],
  ])('addDays(%s, %i) is %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });

  it('daysBetween is the inverse of addDays', () => {
    for (const delta of [-400, -1, 0, 1, 30, 59, 365, 366, 1000]) {
      expect(daysBetween('2027-02-27', addDays('2027-02-27', delta))).toBe(delta);
    }
    expect(daysBetween('2026-10-03', '2026-10-02')).toBe(-1);
  });
});
