import { parseYear, yearBounds, yearOf } from './report-year';

describe('report year helpers', () => {
  it.each([
    ['2026', 2026],
    ['0001', 1],
    ['9999', 9999],
  ])('reads %s as the year %i', (value, year) => {
    expect(parseYear(value)).toBe(year);
  });

  it.each([null, '', '26', '02026', '2026.5', 'abc', '0000', '-2026', ' 2026'])(
    'does not take %j for a year',
    (value) => {
      expect(parseYear(value)).toBeNull();
    },
  );

  it('takes the year of a month', () => {
    expect(yearOf('2026-12')).toBe(2026);
    expect(yearOf('2027-01')).toBe(2027);
  });

  it('bounds the years from the start month to ten years after the current month', () => {
    expect(yearBounds('2024-03', '2026-10')).toEqual({ min: 2024, max: 2036 });
    expect(yearBounds('2026-06', '2026-02')).toEqual({ min: 2026, max: 2036 });
  });

  it('starts at the current year while the start month is not known', () => {
    expect(yearBounds(undefined, '2026-10')).toEqual({ min: 2026, max: 2036 });
  });
});
