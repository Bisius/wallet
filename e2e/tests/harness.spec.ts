import { existsSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { BudgetDto } from '@wallet/shared';
import { ApiRequestError, expect, json, test } from '../support/fixtures';
import {
  addSpending,
  createBudget,
  getMonth,
  getSavings,
  getToday,
  onboard,
  settleMonth,
} from '../support/seed';

/**
 * Checks of the harness itself, so that the specs built on it can trust it: the server, the fake
 * clock, the API client and the browser error guard.
 */

test.describe('the Wallet server of a test', () => {
  test('runs the production build with its own folder and the clock at the start instant', async ({
    wallet,
  }) => {
    expect(wallet.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(wallet.now).toBe('2026-03-10T09:00:00');
    expect(existsSync(wallet.dbPath)).toBe(true);
    expect(wallet.dbPath.startsWith(wallet.dir)).toBe(true);
    expect(wallet.backupDir.startsWith(wallet.dir)).toBe(true);

    expect(await getToday(wallet.api)).toEqual({
      date: '2026-03-10',
      month: '2026-03',
    });
    // The built Angular app is served by the same process.
    const home = await wallet.api.get('/');
    expect(home.headers()['content-type']).toContain('text/html');
    expect(await home.text()).toContain('<app-root');
  });

  test.describe('with another start instant', () => {
    test.use({ walletNow: '2027-12-31T23:00:00' });

    test('starts the clock there', async ({ wallet }) => {
      expect(await getToday(wallet.api)).toEqual({
        date: '2027-12-31',
        month: '2027-12',
      });
    });
  });

  test('moves the clock with setNow, which keeps ticking and honours a zone', async ({
    wallet,
  }) => {
    const today = async () => (await getToday(wallet.api)).date;

    await wallet.setNow('2026-04-30T23:59:00');
    expect(await today()).toBe('2026-04-30');
    expect(await wallet.getNow()).toMatch(/^2026-04-30T23:59:\d\d\.\d{3}Z$/);

    await wallet.setNow('2026-05-01T00:00:00');
    expect(await today()).toBe('2026-05-01');

    // A zone-less instant is UTC (the server's zone); one with an offset is converted.
    await wallet.setNow('2026-06-01T00:30:00+02:00');
    expect(await wallet.getNow()).toMatch(/^2026-05-31T22:30:\d\d\.\d{3}Z$/);
    expect(await today()).toBe('2026-05-31');

    await expect(wallet.setNow('next tuesday')).rejects.toThrow(/not a date-time/);
  });

  test('closes a month when the clock passes it', async ({ wallet }) => {
    const { api } = wallet;
    await onboard(api, { startMonth: '2026-03', salary: 250000 });
    const groceries = await createBudget(api, {
      name: 'Groceries',
      amount: 40000,
      incremental: false,
    });
    await addSpending(api, { date: '2026-03-12', amount: 10050, budgetId: groceries.id });

    expect((await getMonth(api, '2026-03')).status).toBe('current');
    expect((await getSavings(api)).outstanding).toEqual([]);

    await wallet.setNow('2026-04-02T08:00:00');

    expect((await getMonth(api, '2026-03')).status).toBe('closed');
    // Unallocated 2,100.00 (2,500.00 - 400.00) plus the 299.50 left in Groceries.
    const { outstanding, outstandingTotal } = await getSavings(api);
    expect(outstanding.map(({ month, outstanding }) => [month, outstanding])).toEqual([
      ['2026-03', 239950],
    ]);
    expect(outstandingTotal).toBe(239950);

    await settleMonth(api, '2026-03');
    const settled = await getSavings(api);
    expect(settled.outstanding).toEqual([]);
    expect(settled.balance).toBe(239950);
    await expect(settleMonth(api, '2026-03')).rejects.toThrow(/nothing outstanding/);
  });

  test('keeps its database, address and clock across stop and start', async ({ wallet }) => {
    const { api } = wallet;
    const baseURL = wallet.baseURL;
    await onboard(api, { startMonth: '2026-03', salary: 250000, openingSavings: 1000 });
    await createBudget(api, { name: 'Fun', amount: 5000, incremental: true });
    await wallet.setNow('2026-04-15T12:00:00');

    await wallet.stop();
    await expect(fetch(`${baseURL}/api/health`)).rejects.toThrow();

    await wallet.start();
    expect(wallet.baseURL).toBe(baseURL);
    const budgets = await json<BudgetDto[]>(await api.get('/api/budgets'));
    expect(budgets.map((budget) => budget.name)).toEqual(['Fun']);
    expect(await wallet.getNow()).toMatch(/^2026-04-15T12:00:\d\d\.\d{3}Z$/);
    expect(wallet.log()).toContain('Wallet listening');
  });
});

test.describe('the API client', () => {
  test('throws an error that shows the request and the response', async ({ wallet }) => {
    const request = wallet.api.post('/api/budgets', {
      data: { name: 'Fun', amount: 5000, incremental: true },
    });
    await expect(request).rejects.toThrow(/POST \/api\/budgets -> 409 Conflict/);
    await expect(request).rejects.toThrow(/"code":"not_onboarded"/);
    await expect(request).rejects.toThrow(/"name":"Fun"/);

    const error = await request.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 409, code: 'not_onboarded', method: 'POST' });
  });

  test('hands back an expected error with failOnStatusCode: false', async ({ wallet }) => {
    await onboard(wallet.api, { startMonth: '2026-03', salary: 1 });
    const again = await wallet.api.post('/api/onboarding', {
      data: {
        currency: 'EUR',
        locale: 'en-US',
        startMonth: '2026-03',
        salary: 1,
        openingSavings: 0,
      },
      failOnStatusCode: false,
    });
    expect(again.status()).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'already_onboarded' } });
  });
});

test.describe('the browser error guard', () => {
  test('fails a test whose page logs a console error', async ({ page }) => {
    test.fail();
    await page.goto('/api/health');
    await page.evaluate(() => console.error('something broke'));
  });

  test('fails a test whose page throws', async ({ page }) => {
    test.fail();
    await page.goto('/api/health');
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('uncaught in the page');
      });
    });
    await page.waitForTimeout(200);
  });

  test('fails on a request that the app made and got a 404 for', async ({ page }) => {
    test.fail();
    await page.goto('/api/health');
    await page.evaluate(() => fetch('/api/nope'));
  });

  test('lets an expected message through when it is allowed', async ({ page, browserErrors }) => {
    browserErrors.allow(/something expected/, { url: /\/api\/nope$/ });
    await page.goto('/api/health');
    await page.evaluate(() => console.error('something expected'));
    await page.evaluate(() => fetch('/api/nope'));
    await expect.poll(() => browserErrors.all.length).toBe(2);
    expect(browserErrors.unexpected).toEqual([]);
  });

  test.describe('with the guard off', () => {
    test.use({ failOnConsoleErrors: false });

    test('does not fail, and still lists what happened', async ({ page, browserErrors }) => {
      await page.goto('/api/health');
      await page.evaluate(() => console.error('ignored'));
      await expect.poll(() => browserErrors.all.length).toBe(1);
    });
  });
});

test.describe('service workers', () => {
  const registrations = (page: Page) =>
    page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);

  async function openDashboard(page: Page, api: Parameters<typeof onboard>[0]) {
    await onboard(api, { startMonth: '2026-03', salary: 250000 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
  }

  test('are blocked by default, so no page is ever answered from a cache', async ({
    page,
    wallet,
  }) => {
    await openDashboard(page, wallet.api);
    expect(await registrations(page)).toBe(0);
  });

  test.describe('when a spec turns them on', () => {
    test.use({ serviceWorkers: 'allow' });

    test('the app registers its own', async ({ page, wallet }) => {
      await openDashboard(page, wallet.api);
      await expect.poll(() => registrations(page)).toBe(1);
    });
  });
});
