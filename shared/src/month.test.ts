import { describe, expect, it } from 'vitest';
import { addMonths, isMonthKey, monthRange } from './month';

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
});
