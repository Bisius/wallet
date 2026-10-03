import { monthDiff } from '@wallet/shared/month';
import { TREND_MONTHS, trendWindow } from './trend-window';

describe('trendWindow', () => {
  // [what the case shows, selected month, start month, size, expected range]
  it.each([
    ['12 months ending at the selected one', '2026-10', '2020-01', undefined, '2025-11', '2026-10'],
    ['across a year boundary', '2026-01', '2020-01', undefined, '2025-02', '2026-01'],
    [
      'exactly 12 months since the start month',
      '2026-10',
      '2025-11',
      undefined,
      '2025-11',
      '2026-10',
    ],
    [
      'one month short of 12 since the start month',
      '2026-10',
      '2025-12',
      undefined,
      '2025-12',
      '2026-10',
    ],
    [
      'a young wallet: clamped at the start month',
      '2026-10',
      '2026-06',
      undefined,
      '2026-06',
      '2026-10',
    ],
    [
      'the start month itself: a single month',
      '2026-10',
      '2026-10',
      undefined,
      '2026-10',
      '2026-10',
    ],
    [
      'a projection: still clamped at the start month',
      '2027-03',
      '2026-06',
      undefined,
      '2026-06',
      '2027-03',
    ],
    [
      'a projection far ahead: a full window again',
      '2028-10',
      '2026-06',
      undefined,
      '2027-11',
      '2028-10',
    ],
    [
      'the settings not loaded yet: the full window',
      '2026-10',
      undefined,
      undefined,
      '2025-11',
      '2026-10',
    ],
    ['another size', '2026-10', '2026-01', 3, '2026-08', '2026-10'],
    ['another size, clamped', '2026-10', '2026-09', 3, '2026-09', '2026-10'],
  ] as const)('%s', (_name, selected, start, size, from, to) => {
    expect(trendWindow(selected, start, size)).toEqual({ from, to });
  });

  it('is 12 months by default', () => {
    expect(TREND_MONTHS).toBe(12);
    const { from, to } = trendWindow('2026-10', undefined);
    expect(monthDiff(from, to) + 1).toBe(12);
  });

  it('never runs backwards, even for a start month after the selected month', () => {
    expect(trendWindow('2026-10', '2027-01')).toEqual({ from: '2026-10', to: '2026-10' });
  });
});
