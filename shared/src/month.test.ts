import { describe, expect, it } from 'vitest';
import { addMonths, isMonthKey, monthDiff, monthRange } from './month';

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
