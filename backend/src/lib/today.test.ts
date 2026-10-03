import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock';
import {
  currentMonthOf,
  firstDayOf,
  monthBounds,
  monthOfDate,
  timestampOf,
  todayOf,
} from './today';
import { withTimeZone } from '../testing/helpers';

describe('todayOf / currentMonthOf (the server-local calendar)', () => {
  it('runs in UTC, whatever the machine zone is (pinned in vitest.config.ts)', () => {
    // No offset in winter or in summer: the zone is UTC (or has no daylight saving and is UTC).
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(0);
    expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(0);
  });

  it.each([
    // [label, instant, time zone, local date]
    ['UTC mid-month', '2026-03-15T10:00:00Z', 'UTC', '2026-03-15'],
    ['UTC first instant of a month', '2026-04-01T00:00:00Z', 'UTC', '2026-04-01'],
    ['UTC last second of a month', '2026-03-31T23:59:59Z', 'UTC', '2026-03-31'],
    [
      'Rome (CEST, +2) is already in the next month',
      '2026-03-31T22:00:00Z',
      'Europe/Rome',
      '2026-04-01',
    ],
    [
      'Rome (CEST, +2) one minute earlier is not',
      '2026-03-31T21:59:00Z',
      'Europe/Rome',
      '2026-03-31',
    ],
    ['Auckland (NZDT, +13)', '2026-03-31T11:00:00Z', 'Pacific/Auckland', '2026-04-01'],
    ['Kolkata (+5:30)', '2026-03-31T18:30:00Z', 'Asia/Kolkata', '2026-04-01'],
    ['Kathmandu (+5:45)', '2026-03-31T18:15:00Z', 'Asia/Kathmandu', '2026-04-01'],
    [
      'Los Angeles (PDT, -7) is still in the previous month',
      '2026-04-01T06:59:00Z',
      'America/Los_Angeles',
      '2026-03-31',
    ],
    [
      'Los Angeles (PDT, -7) at its midnight',
      '2026-04-01T07:00:00Z',
      'America/Los_Angeles',
      '2026-04-01',
    ],
    ['New Year in Tokyo (+9)', '2026-12-31T15:00:00Z', 'Asia/Tokyo', '2027-01-01'],
    ['New Year in New York (EST, -5)', '2027-01-01T04:59:00Z', 'America/New_York', '2026-12-31'],
    ['a leap day in Rome (CET, +1)', '2028-02-28T23:00:00Z', 'Europe/Rome', '2028-02-29'],
    ['the day after a leap day', '2028-02-29T23:00:00Z', 'Europe/Rome', '2028-03-01'],
  ])('%s', async (_label, instant, timeZone, expected) => {
    await withTimeZone(timeZone, () => {
      expect(todayOf(fixedClock(instant))).toBe(expected);
      expect(currentMonthOf(fixedClock(instant))).toBe(expected.slice(0, 7));
    });
  });

  it('can differ from the UTC date: that is the point of the helper', async () => {
    const instant = '2026-03-31T23:30:00Z';
    expect(instant.slice(0, 10)).toBe('2026-03-31');
    await withTimeZone('Europe/Rome', () => {
      expect(todayOf(fixedClock(instant))).toBe('2026-04-01');
    });
    // ...and the zone is restored afterwards.
    expect(todayOf(fixedClock(instant))).toBe('2026-03-31');
  });

  it('follows a clock that moves', async () => {
    let instant = new Date('2026-03-31T10:00:00Z');
    const clock = { now: () => instant };
    expect(todayOf(clock)).toBe('2026-03-31');
    instant = new Date('2026-04-01T00:00:00Z');
    expect(todayOf(clock)).toBe('2026-04-01');
  });
});

describe('date helpers', () => {
  it.each([
    ['2026-03-15', '2026-03'],
    ['2026-12-31', '2026-12'],
    ['2028-02-29', '2028-02'],
  ])('monthOfDate(%s) is %s', (date, month) => {
    expect(monthOfDate(date)).toBe(month);
  });

  it('firstDayOf is the 1st', () => {
    expect(firstDayOf('2026-03')).toBe('2026-03-01');
  });

  it('monthBounds selects exactly the dates of the month when compared as strings', () => {
    const { from, to } = monthBounds('2026-02');
    const inside = (date: string) => date >= from && date <= to;
    expect(inside('2026-02-01')).toBe(true);
    expect(inside('2026-02-28')).toBe(true);
    expect(inside('2026-01-31')).toBe(false);
    expect(inside('2026-03-01')).toBe(false);
  });

  it.each([
    // [month, last day, first day of the next month]
    ['2026-01', '2026-01-31', '2026-02-01'],
    ['2026-02', '2026-02-28', '2026-03-01'],
    ['2028-02', '2028-02-29', '2028-03-01'],
    ['2026-03', '2026-03-31', '2026-04-01'],
    ['2026-04', '2026-04-30', '2026-05-01'],
    ['2026-12', '2026-12-31', '2027-01-01'],
  ])('monthBounds(%s) contains its last day %s but not %s', (month, lastDay, nextFirstDay) => {
    const { from, to } = monthBounds(month);
    expect(from).toBe(`${month}-01`);
    expect(lastDay >= from && lastDay <= to).toBe(true);
    expect(nextFirstDay >= from && nextFirstDay <= to).toBe(false);
  });

  it('timestampOf is the clock instant as a UTC ISO string', () => {
    expect(timestampOf(fixedClock('2026-03-15T10:00:00Z'))).toBe('2026-03-15T10:00:00.000Z');
  });
});
