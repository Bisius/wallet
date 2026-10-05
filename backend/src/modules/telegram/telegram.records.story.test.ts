/**
 * Story: a summer with the bot at the till. Salary, two budgets (one that carries over), a monthly
 * and a yearly subscription; spendings, a refund and an income typed on the phone; two mistakes
 * undone; a forgotten receipt for a month that has closed meanwhile (with the confirmation) and
 * moved to another day; then September. Every figure the bot printed is worked out by hand, and in
 * the end the books are EXACTLY what the web API would hold had the same net entries been typed
 * there: every month view, the savings and the lists, compared in full against a twin database that
 * only ever saw the HTTP API.
 *
 *   salary 3000.00 from July; Groceries 400.00 (settled each month), Fun 100.00 (carries over)
 *   Netflix 12.99 a month; Insurance 480.00 a year, renewing in November: 96.00 a month from July
 *   fixed 108.99, allocated 500.00:  unallocated = income - 108.99 - 500.00
 *
 *   July    (nothing spent)  unallocated 2,391.01, Groceries 400.00 to savings  => due 2,791.01
 *   August  income 3,200.00 (3,000.00 + the 200.00 bonus), unallocated 2,591.01
 *           Groceries spent 45.60 - 5.00 + 30.00 = 70.60, 329.40 to savings        => due 2,920.41
 *           (without the forgotten 30.00 receipt it was 2,950.41)
 *           Fun: 100.00 carried + 100.00 = 200.00, spent 12.50: 187.50 carried on
 *   Sept    Fun: 187.50 + 100.00 = 287.50, spent 80.00: 207.50 left
 */
import type { IncomeDto, MonthView, SavingsDto, SpendingDto, SpendingsPage } from '@wallet/shared';
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  addIncome,
  addSpending,
  addSubscription,
  mutableClock,
  onboard,
} from '../../testing/helpers';
import { balances, budgetLine } from '../../testing/story';
import { createRecordingHarness } from '../../testing/telegram-flow-helpers';
import { createTestApp } from '../../testing/test-app';

const MONTHS = ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12'];

const ONBOARDING = {
  currency: 'EUR',
  locale: 'en-GB',
  startMonth: '2026-07',
  salary: 300000,
  openingSavings: 0,
};

const BUDGETS = [
  { name: 'Groceries', amount: 40000, incremental: false, icon: '🛒', startMonth: '2026-07' },
  { name: 'Fun', amount: 10000, incremental: true, icon: '🎟', startMonth: '2026-07' },
];

/** The books that are not the facts of the story: budgets (after onboarding) and subscriptions. */
async function seedBooks(app: Express, withBudgets: boolean) {
  if (withBudgets) {
    for (const budget of BUDGETS) {
      await request(app).post('/api/budgets').send(budget).expect(201);
    }
  }
  await addSubscription(app, {
    name: 'Netflix',
    frequency: 'monthly',
    anchorDate: '2026-07-15',
    amount: 1299,
    startMonth: '2026-07',
  });
  await addSubscription(app, {
    name: 'Insurance',
    frequency: 'yearly',
    anchorDate: '2026-11-15',
    amount: 48000,
    startMonth: '2026-07',
  });
}

/** Every month view, the savings, and the spendings and incomes without their ids. */
async function books(app: Express) {
  const months: MonthView[] = [];
  for (const month of MONTHS) {
    months.push((await request(app).get(`/api/months/${month}`).expect(200)).body as MonthView);
  }
  const savings = (await request(app).get('/api/savings').expect(200)).body as SavingsDto;
  const spendings = (
    (await request(app).get('/api/spendings?limit=200').expect(200)).body as SpendingsPage
  ).items.map(({ id: _id, ...rest }: SpendingDto) => rest);
  const incomes = ((await request(app).get('/api/incomes').expect(200)).body as IncomeDto[]).map(
    ({ id: _id, ...rest }) => rest,
  );
  return { months, savings, spendings, incomes };
}

describe('story: a summer with the bot', () => {
  it('leaves the books exactly as the web would, with every printed figure right to the cent', async () => {
    const h = await createRecordingHarness({
      now: '2026-08-20T09:00:00Z',
      locale: 'en-GB',
      startMonth: '2026-07',
      budgets: BUDGETS,
    });
    await seedBooks(h.app, false);
    const groceries = h.budget('Groceries').id;
    const fun = h.budget('Fun').id;

    // --- Thursday 20 August: the guided flow, then a quick entry ---------------------------------
    await h.say('/spending');
    await h.tapButton('🛒 Groceries · €400.00');
    await h.say('45,60 Lidl');
    await h.tapButton('Today');
    expect(h.screen().text).toBe(
      '✅ €45.60 · Groceries · Lidl · Thu 20 Aug\nGroceries: €354.40 left of €400.00 (11% used)',
    );

    await h.say('12,50 lunch');
    await h.tapButton(/Fun/); // 200.00 available: 100.00 carried from July and 100.00 for August
    expect(h.screen().text).toBe(
      '✅ €12.50 · Fun · lunch · Thu 20 Aug\nFun: €187.50 left of €200.00 (6% used)',
    );

    // --- Friday 21 August: a refund, an income, and two mistakes that are undone ------------------
    h.clock.set('2026-08-21T18:30:00Z');
    await h.say('-5 returned jar');
    await h.tapButton(/Groceries/);
    expect(h.screen().text).toBe(
      '↩ Refund €5.00 · Groceries · returned jar · Fri 21 Aug\nGroceries: €359.40 left of €400.00 (10% used)',
    );

    await h.say('/income');
    await h.say('200 Bonus');
    await h.tapButton('Today');
    expect(h.screen().text).toBe(
      '✅ Income €200.00 · Bonus · Fri 21 Aug\nAugust: income €3,200.00 · Unallocated €2,591.01',
    );

    await h.say('99 oops');
    await h.tapButton(/Groceries/);
    expect(h.screen().text).toContain('Groceries: €260.40 left of €400.00 (34% used)');
    await h.tapButton('↩ Undo');
    expect(h.screen().text).toBe(
      '🗑 Removed €99.00 · Groceries · oops · Fri 21 Aug\nGroceries: €359.40 left of €400.00 (10% used)',
    );

    await h.say('7 test');
    await h.tapButton(/Fun/);
    await h.say('/undo');
    expect(h.screen().text).toBe('Remove €7.00 · Fun · test (Fri 21 Aug)?');
    await h.tapButton('Remove');
    expect(h.screen().text).toBe(
      '🗑 Removed €7.00 · Fun · test · Fri 21 Aug\nFun: €187.50 left of €200.00 (6% used)',
    );

    // Mid-August: what is on the books so far.
    const august = await h.monthView('2026-08');
    expect(balances(budgetLine(august, 'Groceries'))).toEqual([
      0, 40000, 40000, 4060, 35940, 0, 35940,
    ]);
    expect(balances(budgetLine(august, 'Fun'))).toEqual([
      10000, 10000, 20000, 1250, 18750, 18750, 0,
    ]);

    // --- Wednesday 2 September: August is closed; the forgotten pharmacy receipt ----------------
    h.clock.set('2026-09-02T08:15:00Z');
    const before = (await h.monthView('2026-08')).savingsDue;
    expect(before).toMatchObject({ unallocated: 259101, budgetsSettled: 35940, total: 295041 });

    await h.say('/spending');
    await h.tapButton(/Groceries/);
    await h.say('30 pharmacy');
    await h.tapButton('Earlier…');
    expect(
      h
        .screen()
        .rows.flat()
        .map((b) => b.text),
    ).toEqual(['Mon 31', 'Sun 30', 'Sat 29', 'Fri 28', 'Thu 27']);
    await h.tapButton('Sun 30');
    expect(h.screen().text).toBe(
      '€30.00 · Groceries · pharmacy · Sun 30 Aug\n' +
        'August is closed. Adding this changes what is due to savings for August.',
    );
    await h.tapButton('Save');
    expect(h.screen().text).toBe(
      '✅ €30.00 · Groceries · pharmacy · Sun 30 Aug\n' +
        'Groceries in August (closed): €329.40 left of €400.00 (17% used)',
    );

    // Change date inside the same closed month changes no figure of any month, so it does not ask.
    await h.tapButton('📅 Change date');
    await h.tapButton('Mon 31');
    expect(h.screen().text).toBe(
      '✅ €30.00 · Groceries · pharmacy · Mon 31 Aug\n' +
        'Groceries in August (closed): €329.40 left of €400.00 (17% used)',
    );

    // The late receipt moved August's savings due by exactly its amount, and nothing else moved.
    const after = (await h.monthView('2026-08')).savingsDue;
    expect(after).toMatchObject({ unallocated: 259101, budgetsSettled: 32940, total: 292041 });
    expect(before.total - after.total).toBe(3000);
    const savings = (await request(h.app).get('/api/savings').expect(200)).body as SavingsDto;
    expect(savings.outstanding.map((o) => [o.month, o.outstanding])).toEqual([
      ['2026-07', 279101],
      ['2026-08', 292041],
    ]);
    expect(savings.outstandingTotal).toBe(571142);

    // --- September: Fun carried 187.50 in -----------------------------------------------------------
    await h.say('80 concert');
    await h.tapButton(/Fun/);
    expect(h.screen().text).toBe(
      '✅ €80.00 · Fun · concert · Wed 2 Sept\nFun: €207.50 left of €287.50 (27% used)',
    );
    const september = await h.monthView('2026-09');
    expect(balances(budgetLine(september, 'Fun'))).toEqual([
      18750, 10000, 28750, 8000, 20750, 20750, 0,
    ]);
    expect(balances(budgetLine(september, 'Groceries'))).toEqual([
      0, 40000, 40000, 0, 40000, 0, 40000,
    ]);
    expect(september.unallocated).toBe(239101);

    // --- The twin: the same net entries, typed on the web only -------------------------------------
    const clock = mutableClock('2026-08-20T09:00:00Z');
    const twin = createTestApp(clock).app;
    await onboard(twin, ONBOARDING);
    await seedBooks(twin, true);
    await addSpending(twin, {
      budgetId: groceries,
      amount: 4560,
      description: 'Lidl',
      date: '2026-08-20',
    });
    await addSpending(twin, {
      budgetId: fun,
      amount: 1250,
      description: 'lunch',
      date: '2026-08-20',
    });
    clock.set('2026-08-21T18:30:00Z');
    await addSpending(twin, {
      budgetId: groceries,
      amount: -500,
      description: 'returned jar',
      date: '2026-08-21',
    });
    await addIncome(twin, { amount: 20000, description: 'Bonus', date: '2026-08-21' });
    clock.set('2026-09-02T08:15:00Z');
    await addSpending(twin, {
      budgetId: groceries,
      amount: 3000,
      description: 'pharmacy',
      date: '2026-08-31',
    });
    await addSpending(twin, {
      budgetId: fun,
      amount: 8000,
      description: 'concert',
      date: '2026-09-02',
    });

    const bot = await books(h.app);
    const web = await books(twin);
    expect(bot.spendings).toEqual(web.spendings);
    expect(bot.incomes).toEqual(web.incomes);
    expect(bot.months).toEqual(web.months);
    expect(bot.savings).toEqual(web.savings);
    expect(bot.spendings).toHaveLength(5);

    // --- And the bot kept its own notes: one entry per row that is still there, none for the undone ----
    h.clock.set('2026-09-02T09:00:00Z');
    await h.say('/undo');
    expect(h.screen().text).toBe('Remove €80.00 · Fun · concert (Wed 2 Sept)?');
  });
});
