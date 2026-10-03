import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../lib/clock';
import { createTestApp } from '../../testing/test-app';
import { mutableClock, onboard, withTimeZone } from '../../testing/helpers';
import { addBudget } from '../../testing/helpers';

describe('GET /api/today', () => {
  it('returns the date and month of the injected clock', async () => {
    const { app } = createTestApp(fixedClock('2026-03-15T10:00:00Z'));
    const res = await request(app).get('/api/today').expect(200);
    expect(res.body).toEqual({ date: '2026-03-15', month: '2026-03' });
  });

  it('works before onboarding', async () => {
    const { app } = createTestApp(fixedClock('2026-03-15T10:00:00Z'));
    await request(app).get('/api/settings').expect(404);
    await request(app).get('/api/today').expect(200);
  });

  it('follows a clock that moves across a month boundary', async () => {
    const clock = mutableClock('2026-03-31T23:59:59Z');
    const { app } = createTestApp(clock);
    expect((await request(app).get('/api/today')).body).toEqual({
      date: '2026-03-31',
      month: '2026-03',
    });
    clock.set('2026-04-01T00:00:00Z');
    expect((await request(app).get('/api/today')).body).toEqual({
      date: '2026-04-01',
      month: '2026-04',
    });
  });

  describe('in the server time zone (TZ), not UTC', () => {
    it.each([
      // [label, instant, time zone, date]
      ['Rome is already on 1 April', '2026-03-31T23:30:00Z', 'Europe/Rome', '2026-04-01'],
      [
        'Los Angeles is still on 31 March',
        '2026-04-01T03:00:00Z',
        'America/Los_Angeles',
        '2026-03-31',
      ],
      ['Tokyo is already in the new year', '2026-12-31T16:00:00Z', 'Asia/Tokyo', '2027-01-01'],
    ])('%s', async (_label, instant, timeZone, date) => {
      const { app } = createTestApp(fixedClock(instant));
      const res = await withTimeZone(timeZone, () => request(app).get('/api/today').expect(200));
      expect(res.body).toEqual({ date, month: date.slice(0, 7) });
      // The UTC date is different, which is exactly what the API must not report.
      expect(instant.slice(0, 10)).not.toBe(date);
    });

    it('decides which month a new budget starts in', async () => {
      // 23:30 UTC on 31 March is 01:30 on 1 April in Rome.
      const { app } = createTestApp(fixedClock('2026-03-31T23:30:00Z'));
      await onboard(app, { startMonth: '2026-01' });
      const inUtc = await addBudget(app, { name: 'UTC budget' });
      const inRome = await withTimeZone('Europe/Rome', () =>
        addBudget(app, { name: 'Rome budget' }),
      );
      expect(inUtc.startMonth).toBe('2026-03');
      expect(inRome.startMonth).toBe('2026-04');
    });
  });
});
