/**
 * Renewal reminders (docs/DOMAIN.md, "Renewal reminders"), driven the way production drives them:
 * the scheduler's `tick()` with the clock moved between ticks. The facts come from the API, and what
 * is asserted is the text that reaches the fake Telegram and the dedupe log.
 *
 * The scenario, on Wednesday 28 October 2026 at 09:30 (the notify time is 09:00), English (UK):
 *
 *   Netflix    monthly, billed on the 29th, 13.99                               tomorrow
 *   Domain     yearly, renews 30 October, 150.00, saved from October           in 2 days, renewal this month
 *                                                                               so the whole price is reserved
 *   Insurance  yearly, renews 3 November, 480.00, saved from October            in 6 days; October's top-up is
 *                                                                               480.00 / 2 months = 240.00
 */
import type { UpcomingRenewalDto } from '@wallet/shared';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { addSubscription, onboard, withTimeZone } from '../../testing/helpers';
import { type NotifyHarness, createNotifyHarness } from '../../testing/telegram-notify-harness';

const open: NotifyHarness[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
});

const NETFLIX_LINE = 'Netflix · tomorrow (Thu 29 Oct) · €13.99';
const DOMAIN_LINE = 'Domain · in 2 days (Fri 30 Oct) · €150.00 · set aside ✅';
const INSURANCE_LINE =
  'Insurance · in 6 days (Tue 3 Nov) · €480.00 · €240.00 set aside, €240.00 not covered';

/** Linked on 10 October, and the recap is off: a recap of September would be sent in these tests too. */
async function scenario(options: Parameters<typeof createNotifyHarness>[0] = {}) {
  const h = createNotifyHarness({ now: '2026-10-28T09:30:00Z', ...options });
  open.push(h);
  h.savePrefs({ monthlyRecap: false });
  await onboard(h.setup, { locale: 'en-GB', startMonth: '2026-01', openingSavings: 0 });
  const netflix = await addSubscription(h.setup, {
    name: 'Netflix',
    frequency: 'monthly',
    anchorDate: '2026-01-29',
    amount: 1399,
    startMonth: '2026-01',
  });
  const domain = await addSubscription(h.setup, {
    name: 'Domain',
    frequency: 'yearly',
    anchorDate: '2026-10-30',
    amount: 15000,
    startMonth: '2026-10',
  });
  const insurance = await addSubscription(h.setup, {
    name: 'Insurance',
    frequency: 'yearly',
    anchorDate: '2026-11-03',
    amount: 48000,
    startMonth: '2026-10',
  });
  return { h, netflix, domain, insurance, scheduler: h.startScheduler() };
}

describe('what a reminder says', () => {
  it('is one message for every renewal within its lead, with the figures of the upcoming list', async () => {
    const { h, scheduler } = await scenario();
    await scheduler.tick();
    expect(h.texts()).toEqual([
      ['🔔 Renewals', NETFLIX_LINE, DOMAIN_LINE, INSURANCE_LINE].join('\n'),
    ]);
  });

  it('prints the price, reserved and unreserved of GET /api/subscriptions/upcoming, to the cent', async () => {
    const { h, scheduler } = await scenario();
    const upcoming: UpcomingRenewalDto[] = (
      await request(h.setup).get('/api/subscriptions/upcoming?days=7').expect(200)
    ).body;
    expect(upcoming.map((r) => [r.name, r.amount, r.reserved, r.unreserved, r.daysUntil])).toEqual([
      ['Netflix', 1399, null, null, 1],
      ['Domain', 15000, 15000, 0, 2],
      ['Insurance', 48000, 24000, 24000, 6],
    ]);
    await scheduler.tick();
    expect(h.texts()[0]).toContain('€480.00 · €240.00 set aside, €240.00 not covered');
  });

  it('uses the price of the renewal, not the price of this month (a rise dated in the renewal month)', async () => {
    const { h, insurance, scheduler } = await scenario();
    // Insurance rises to 600.00 from November: October still saves towards 480.00, November pays 600.00.
    await request(h.setup)
      .put(`/api/subscriptions/${insurance.id}/prices/2026-11`)
      .send({ amount: 60000 })
      .expect(200);
    await scheduler.tick();
    expect(h.texts()[0]).toContain(
      'Insurance · in 6 days (Tue 3 Nov) · €600.00 · €240.00 set aside, €360.00 not covered',
    );
  });

  it('escapes the name of a subscription for HTML', async () => {
    const h = createNotifyHarness({ now: '2026-10-28T09:30:00Z' });
    open.push(h);
    h.savePrefs({ monthlyRecap: false });
    await onboard(h.setup, { locale: 'en-GB', startMonth: '2026-01' });
    await addSubscription(h.setup, {
      name: '<b>&',
      anchorDate: '2026-01-29',
      amount: 100,
      startMonth: '2026-01',
    });
    await h.startScheduler().tick();
    expect(h.texts()).toEqual(['🔔 Renewals\n&lt;b&gt;&amp; · tomorrow (Thu 29 Oct) · €1.00']);
  });

  it('follows the locale of Settings', async () => {
    const h = createNotifyHarness({ now: '2026-10-28T09:30:00Z' });
    open.push(h);
    h.savePrefs({ monthlyRecap: false });
    await onboard(h.setup, { locale: 'en-US', startMonth: '2026-01' });
    await addSubscription(h.setup, {
      name: 'Netflix',
      anchorDate: '2026-01-29',
      amount: 1399,
      startMonth: '2026-01',
    });
    await h.startScheduler().tick();
    expect(h.texts()).toEqual(['🔔 Renewals\nNetflix · tomorrow (Thu, Oct 29) · €13.99']);
  });
});

describe('once per renewal', () => {
  it('logs each renewal by subscription and billing date, after Telegram accepted the message', async () => {
    const { h, netflix, domain, insurance, scheduler } = await scenario();
    await scheduler.tick();
    expect(h.log()).toEqual(
      [
        `renewal ${netflix.id}:2026-10-29`,
        `renewal ${domain.id}:2026-10-30`,
        `renewal ${insurance.id}:2026-11-03`,
      ].sort(),
    );
    expect(h.log()).toHaveLength(3);
  });

  it('does not remind again at later ticks, the next day, or after a restart', async () => {
    const { h, scheduler } = await scenario();
    await scheduler.tick();
    await scheduler.tick();
    h.clock.set('2026-10-28T23:59:00Z');
    await scheduler.tick();
    h.clock.set('2026-10-29T09:30:00Z'); // Netflix is due today now, and was reminded yesterday
    await scheduler.tick();
    expect(h.texts()).toHaveLength(1);

    const restarted = h.startScheduler(); // a new scheduler on the same database
    await restarted.tick();
    expect(h.texts()).toHaveLength(1);
  });

  it('reminds again at the next billing of the same subscription', async () => {
    const { h, netflix, scheduler } = await scenario();
    await scheduler.tick();
    h.clock.set('2026-11-28T09:30:00Z');
    await scheduler.tick();
    expect(h.texts()).toHaveLength(2);
    expect(h.texts()[1]).toBe('🔔 Renewals\nNetflix · tomorrow (Sun 29 Nov) · €13.99');
    expect(h.log()).toContain(`renewal ${netflix.id}:2026-11-29`);
  });
});

describe('the notify time', () => {
  it('sends nothing before it and sends at it', async () => {
    const { h, scheduler } = await scenario({ now: '2026-10-28T08:59:00Z' });
    await scheduler.tick();
    expect(h.fake.attempts).toEqual([]);
    h.clock.set('2026-10-28T08:59:59Z');
    await scheduler.tick();
    expect(h.fake.attempts).toEqual([]);
    h.clock.set('2026-10-28T09:00:00Z');
    await scheduler.tick();
    expect(h.texts()).toHaveLength(1);
  });

  it('follows the saved time of day', async () => {
    const { h, scheduler } = await scenario({ now: '2026-10-28T07:29:00Z' });
    h.savePrefs({ notifyAt: '07:30' });
    await scheduler.tick();
    expect(h.fake.attempts).toEqual([]);
    h.clock.set('2026-10-28T07:30:00Z');
    await scheduler.tick();
    expect(h.texts()).toHaveLength(1);
  });

  it('sends at the next tick after the time when the server was off at it', async () => {
    const { h, scheduler } = await scenario({ now: '2026-10-28T09:00:00Z' });
    // No tick at 09:00; the server comes back at 17:45.
    h.clock.set('2026-10-28T17:45:00Z');
    await scheduler.tick();
    expect(h.texts()).toHaveLength(1);
  });

  it('is read in the time zone of the server, not in UTC', async () => {
    const { h, scheduler } = await scenario({ now: '2026-10-28T09:30:00Z' });
    // Rome is on CET (UTC+1) from 25 October 2026: 09:30 UTC is 10:30 there.
    await withTimeZone('Europe/Rome', async () => {
      h.savePrefs({ notifyAt: '10:31' });
      await scheduler.tick();
      expect(h.fake.attempts).toEqual([]);
      h.clock.set('2026-10-28T09:31:00Z'); // 10:31 in Rome
      await scheduler.tick();
      expect(h.texts()).toHaveLength(1);
    });
  });
});

describe('catching up after a day off', () => {
  it('reminds, at the next tick, of what is still ahead, saying "today" for a renewal due today', async () => {
    const { h, scheduler } = await scenario();
    // The server was off on the 28th. On the 29th Netflix is billed today.
    h.clock.set('2026-10-29T09:30:00Z');
    await scheduler.tick();
    expect(h.texts()).toEqual([
      [
        '🔔 Renewals',
        'Netflix · today (Thu 29 Oct) · €13.99',
        'Domain · tomorrow (Fri 30 Oct) · €150.00 · set aside ✅',
        'Insurance · in 5 days (Tue 3 Nov) · €480.00 · €240.00 set aside, €240.00 not covered',
      ].join('\n'),
    ]);
  });

  it('does not remind of a renewal whose billing date has passed', async () => {
    const { h, scheduler } = await scenario();
    // Two days off: Netflix was billed on the 29th, and its next billing is a month away.
    h.clock.set('2026-10-30T09:30:00Z');
    await scheduler.tick();
    expect(h.texts()).toEqual([
      [
        '🔔 Renewals',
        'Domain · today (Fri 30 Oct) · €150.00 · set aside ✅',
        'Insurance · in 4 days (Tue 3 Nov) · €480.00 · €240.00 set aside, €240.00 not covered',
      ].join('\n'),
    ]);
  });

  it('sends a renewal that was reminded the day before as nothing new on the day itself', async () => {
    const { h, scheduler } = await scenario();
    await scheduler.tick(); // 28th: all three
    h.clock.set('2026-10-30T09:30:00Z'); // Domain is due today, but it was reminded already
    await scheduler.tick();
    expect(h.texts()).toHaveLength(1);
  });
});

describe('the preferences', () => {
  it('sends nothing at all when both leads are 0', async () => {
    const { h, scheduler } = await scenario();
    h.savePrefs({ renewalYearlyDays: 0, renewalMonthlyDays: 0 });
    await scheduler.tick();
    expect(h.fake.attempts).toEqual([]);
    expect(h.log()).toEqual([]);
  });

  it('leaves the yearly renewals out when their lead is 0', async () => {
    const { h, scheduler } = await scenario();
    h.savePrefs({ renewalYearlyDays: 0 });
    await scheduler.tick();
    expect(h.texts()).toEqual([`🔔 Renewals\n${NETFLIX_LINE}`]);
  });

  it('leaves the monthly renewals out when their lead is 0, even one that is due today', async () => {
    const { h, scheduler } = await scenario({ now: '2026-10-29T09:30:00Z' });
    h.savePrefs({ renewalMonthlyDays: 0 });
    await scheduler.tick();
    expect(h.texts()).toEqual([
      [
        '🔔 Renewals',
        'Domain · tomorrow (Fri 30 Oct) · €150.00 · set aside ✅',
        'Insurance · in 5 days (Tue 3 Nov) · €480.00 · €240.00 set aside, €240.00 not covered',
      ].join('\n'),
    ]);
  });

  it('includes a renewal exactly at its lead and not one day beyond it', async () => {
    const { h, scheduler } = await scenario();
    h.savePrefs({ renewalYearlyDays: 5, renewalMonthlyDays: 0 }); // Insurance is 6 days away
    await scheduler.tick();
    expect(h.texts()).toEqual([`🔔 Renewals\n${DOMAIN_LINE}`]);

    h.savePrefs({ renewalYearlyDays: 6, renewalMonthlyDays: 0 });
    await scheduler.tick();
    expect(h.texts()[1]).toBe(`🔔 Renewals\n${INSURANCE_LINE}`);
  });

  it('reminds at the next tick when a lead is raised after the notify time, only of what is new', async () => {
    const { h, scheduler } = await scenario();
    h.savePrefs({ renewalYearlyDays: 3 });
    await scheduler.tick();
    expect(h.texts()).toEqual([['🔔 Renewals', NETFLIX_LINE, DOMAIN_LINE].join('\n')]);

    h.savePrefs({ renewalYearlyDays: 7 });
    await scheduler.tick();
    expect(h.texts()[1]).toBe(`🔔 Renewals\n${INSURANCE_LINE}`);
    expect(h.texts()).toHaveLength(2);
  });
});

describe('when nothing may be sent', () => {
  it('sends nothing while no account is linked', async () => {
    const { h, scheduler } = await scenario({ linkedAt: null });
    await scheduler.tick();
    expect(h.fake.attempts).toEqual([]);
    expect(h.log()).toEqual([]);
  });

  it('sends nothing while the bot is not running, then sends once it does', async () => {
    const { h, scheduler } = await scenario({
      status: { connection: 'error', problem: 'unreachable' },
    });
    await scheduler.tick();
    expect(h.fake.attempts).toEqual([]);
    expect(h.log()).toEqual([]);

    h.fake.setStatus({ connection: 'running', problem: null });
    await scheduler.tick();
    expect(h.texts()).toHaveLength(1);
  });

  it('sends nothing before onboarding and does not fail', async () => {
    const h = createNotifyHarness({ now: '2026-10-28T09:30:00Z' });
    open.push(h);
    await expect(h.startScheduler().tick()).resolves.toBeUndefined();
    expect(h.fake.attempts).toEqual([]);
  });
});

describe('a failed send', () => {
  it('writes no row, is retried at the next tick and is never lost', async () => {
    const { h, scheduler } = await scenario();
    h.failSends(1);
    await scheduler.tick();
    expect(h.fake.attempts).toHaveLength(1);
    expect(h.texts()).toEqual([]);
    expect(h.log()).toEqual([]);

    await scheduler.tick();
    expect(h.texts()).toEqual([
      ['🔔 Renewals', NETFLIX_LINE, DOMAIN_LINE, INSURANCE_LINE].join('\n'),
    ]);
    expect(h.log()).toHaveLength(3);

    await scheduler.tick(); // and a sent one is not repeated
    expect(h.texts()).toHaveLength(1);
  });
});

describe('a long list', () => {
  /** 50 monthly subscriptions with names of 60 characters, all billed tomorrow. */
  async function crowded() {
    const h = createNotifyHarness({ now: '2026-10-28T09:30:00Z' });
    open.push(h);
    h.savePrefs({ monthlyRecap: false });
    await onboard(h.setup, { locale: 'en-GB', startMonth: '2026-01' });
    for (let i = 1; i <= 50; i++) {
      await addSubscription(h.setup, {
        name: `${String(i).padStart(2, '0')} ${'s'.repeat(57)}`,
        anchorDate: '2026-01-29',
        amount: 100 * i,
        startMonth: '2026-01',
      });
    }
    return { h, scheduler: h.startScheduler() };
  }

  it('is split into messages under the limit of Telegram, each renewal in exactly one', async () => {
    const { h, scheduler } = await crowded();
    await scheduler.tick();
    const texts = h.texts();
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(4096);
    expect(texts[0]?.startsWith('🔔 Renewals\n')).toBe(true);
    expect(texts[1]?.startsWith('🔔 Renewals (continued)\n')).toBe(true);
    const names = texts.flatMap((text) => text.match(/^\d\d s{57}/gm) ?? []);
    expect(names).toEqual(
      Array.from({ length: 50 }, (_, i) => `${String(i + 1).padStart(2, '0')} ${'s'.repeat(57)}`),
    );
    expect(h.log()).toHaveLength(50);
  });

  it('keeps what the first message told when the second one fails, and sends only the rest next time', async () => {
    const { h, scheduler } = await crowded();
    h.failSends(2);
    await scheduler.tick();
    expect(h.texts()).toHaveLength(1);
    const told = h.log().length;
    expect(told).toBeGreaterThan(0);
    expect(told).toBeLessThan(50);

    await scheduler.tick();
    expect(h.texts()).toHaveLength(2);
    expect(h.texts()[1]?.startsWith('🔔 Renewals\n')).toBe(true); // it is the first message of its tick
    expect(h.log()).toHaveLength(50);
    const all = h.texts().flatMap((text) => text.match(/^\d\d s{57}/gm) ?? []);
    expect(new Set(all).size).toBe(50);
    expect(all).toHaveLength(50); // none twice
  });
});
