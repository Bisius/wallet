import type { MonthBudgetLine, MonthView, UpcomingRenewalDto } from '@wallet/shared';
import { describe, expect, it } from 'vitest';
import {
  RENEWALS_CONTINUED_HEADER,
  RENEWALS_HEADER,
  TELEGRAM_MESSAGE_LIMIT,
  budgetAlertText,
  recapMessage,
  renewalLine,
  renewalMessages,
  renewalWhen,
  savingsMarker,
} from './telegram.notification-messages';

const GB = { currency: 'EUR', locale: 'en-GB' };
const US = { currency: 'EUR', locale: 'en-US' };

const line = (overrides: Partial<MonthBudgetLine> = {}): MonthBudgetLine => ({
  id: 1,
  name: 'Groceries',
  color: null,
  icon: null,
  incremental: false,
  endsThisMonth: false,
  carriedIn: 0,
  allocated: 30000,
  transfersNet: 0,
  available: 30000,
  spent: 0,
  remaining: 30000,
  usagePercent: 0,
  warnPercent: 80,
  alert: 'ok',
  carriedOut: 0,
  toSavings: 30000,
  ...overrides,
});

describe('budgetAlertText', () => {
  it('words a warning with the percentage, what is left and the available amount', () => {
    const text = budgetAlertText(
      line({ alert: 'warning', usagePercent: 84, spent: 25200, remaining: 4800 }),
      GB,
    );
    expect(text).toBe('⚠️ Groceries: 84% used, €48.00 left of €300.00');
  });

  it('words an overspent budget by the negated remaining', () => {
    const text = budgetAlertText(
      line({
        name: 'Eating out',
        alert: 'over',
        usagePercent: 106,
        remaining: -1240,
        available: 20000,
      }),
      GB,
    );
    expect(text).toBe('🔴 Eating out is over by €12.40');
  });

  it('words a budget that is over with nothing available (no percentage exists)', () => {
    const text = budgetAlertText(
      line({ alert: 'over', usagePercent: null, available: -5000, remaining: -5000 }),
      GB,
    );
    expect(text).toBe('🔴 Groceries is over by €50.00');
  });

  it('leaves the percentage out of a warning that has none, never printing "null"', () => {
    const text = budgetAlertText(
      line({ alert: 'warning', usagePercent: null, remaining: 100 }),
      GB,
    );
    expect(text).not.toContain('null');
  });

  it('follows the currency and the locale of Settings', () => {
    const text = budgetAlertText(line({ alert: 'warning', usagePercent: 84, remaining: 4800 }), {
      currency: 'USD',
      locale: 'en-US',
    });
    expect(text).toBe('⚠️ Groceries: 84% used, $48.00 left of $300.00');
  });

  it('escapes the name for HTML', () => {
    const over = budgetAlertText(line({ name: '<b>&', alert: 'over', remaining: -100 }), GB);
    expect(over).toBe('🔴 &lt;b&gt;&amp; is over by €1.00');
    const warning = budgetAlertText(
      line({ name: '<b>&', alert: 'warning', usagePercent: 90, remaining: 100 }),
      GB,
    );
    expect(warning).toContain('⚠️ &lt;b&gt;&amp;: 90% used');
    expect(warning).not.toContain('<b>');
  });

  it('refuses a budget that is ok: it has no alert', () => {
    expect(() => budgetAlertText(line(), GB)).toThrow(RangeError);
  });

  it('prints every amount to the cent, whatever its size', () => {
    const text = budgetAlertText(line({ alert: 'over', remaining: -123456789 }), GB);
    expect(text).toBe('🔴 Groceries is over by €1,234,567.89');
  });
});

const renewal = (overrides: Partial<UpcomingRenewalDto> = {}): UpcomingRenewalDto => ({
  id: 1,
  name: 'Netflix',
  color: null,
  frequency: 'monthly',
  yearly: false,
  date: '2026-10-06',
  daysUntil: 1,
  amount: 1399,
  reserved: null,
  unreserved: null,
  ...overrides,
});

describe('renewalWhen', () => {
  it('says today, tomorrow and in n days, with the date', () => {
    expect(renewalWhen({ daysUntil: 0, date: '2026-10-05' }, GB)).toBe('today (Mon 5 Oct)');
    expect(renewalWhen({ daysUntil: 1, date: '2026-10-06' }, GB)).toBe('tomorrow (Tue 6 Oct)');
    expect(renewalWhen({ daysUntil: 7, date: '2026-10-12' }, GB)).toBe('in 7 days (Mon 12 Oct)');
    expect(renewalWhen({ daysUntil: 2, date: '2026-10-07' }, US)).toBe('in 2 days (Wed, Oct 7)');
  });
});

describe('renewalLine', () => {
  it('words a monthly renewal with its price and nothing about a reserve', () => {
    expect(renewalLine(renewal(), GB)).toBe('Netflix · tomorrow (Tue 6 Oct) · €13.99');
  });

  it('words a yearly renewal that is covered as set aside', () => {
    const domain = renewal({
      name: 'Domain',
      frequency: 'yearly',
      yearly: true,
      date: '2026-10-12',
      daysUntil: 7,
      amount: 1500,
      reserved: 1500,
      unreserved: 0,
    });
    expect(renewalLine(domain, GB)).toBe('Domain · in 7 days (Mon 12 Oct) · €15.00 · set aside ✅');
  });

  it('words a yearly renewal that is not covered with both amounts', () => {
    const insurance = renewal({
      name: 'Insurance',
      frequency: 'yearly',
      yearly: true,
      date: '2026-10-11',
      daysUntil: 6,
      amount: 48000,
      reserved: 40000,
      unreserved: 8000,
    });
    expect(renewalLine(insurance, GB)).toBe(
      'Insurance · in 6 days (Sun 11 Oct) · €480.00 · €400.00 set aside, €80.00 not covered',
    );
  });

  it('words a yearly renewal with nothing set aside at all', () => {
    const none = renewal({ yearly: true, frequency: 'yearly', reserved: 0, unreserved: 1399 });
    expect(renewalLine(none, GB)).toBe(
      'Netflix · tomorrow (Tue 6 Oct) · €13.99 · €0.00 set aside, €13.99 not covered',
    );
  });

  it('escapes the name for HTML', () => {
    expect(renewalLine(renewal({ name: '<b>&' }), GB)).toBe(
      '&lt;b&gt;&amp; · tomorrow (Tue 6 Oct) · €13.99',
    );
  });
});

describe('renewalMessages', () => {
  it('puts every renewal in one message under a header, in the order given', () => {
    const items = [renewal({ id: 1, name: 'A' }), renewal({ id: 2, name: 'B' })];
    const messages = renewalMessages(items, GB);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe(
      `${RENEWALS_HEADER}\nA · tomorrow (Tue 6 Oct) · €13.99\nB · tomorrow (Tue 6 Oct) · €13.99`,
    );
    expect(messages[0]?.renewals).toEqual(items);
  });

  it('is empty for nothing to remind about', () => {
    expect(renewalMessages([], GB)).toEqual([]);
  });

  it('splits a long list into messages that each fit, losing and repeating none', () => {
    // 60-character names, the longest a name can be, so about 100 characters a line.
    const items = Array.from({ length: 120 }, (_, index) =>
      renewal({ id: index + 1, name: `${String(index + 1).padStart(3, '0')} ${'x'.repeat(56)}` }),
    );
    const messages = renewalMessages(items, GB);
    expect(messages.length).toBeGreaterThan(2);
    for (const message of messages) {
      expect(message.text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
    expect(messages[0]?.text.startsWith(`${RENEWALS_HEADER}\n`)).toBe(true);
    for (const message of messages.slice(1)) {
      expect(message.text.startsWith(`${RENEWALS_CONTINUED_HEADER}\n`)).toBe(true);
    }
    expect(messages.flatMap((message) => message.renewals.map((r) => r.id))).toEqual(
      items.map((item) => item.id),
    );
    // Each message is as full as it can be: the next line would not have fitted.
    messages.slice(0, -1).forEach((message, index) => {
      const next = messages[index + 1]?.renewals[0];
      expect(next).toBeDefined();
      const nextLine = renewalLine(next as UpcomingRenewalDto, GB);
      expect(message.text.length + 1 + nextLine.length).toBeGreaterThan(TELEGRAM_MESSAGE_LIMIT);
    });
  });

  it('honours a smaller limit exactly: a line that fits to the character stays', () => {
    const items = [renewal({ id: 1, name: 'A' }), renewal({ id: 2, name: 'B' })];
    const oneLine = `${RENEWALS_HEADER}\n${renewalLine(items[0] as UpcomingRenewalDto, GB)}`;
    expect(
      renewalMessages(items, GB, oneLine.length + 1 + oneLine.split('\n')[1]!.length),
    ).toHaveLength(1);
    expect(
      renewalMessages(items, GB, oneLine.length + oneLine.split('\n')[1]!.length),
    ).toHaveLength(2);
  });
});

/** September 2026 as the hand-worked scenario of the recap test has it. */
const september = (overrides: Partial<MonthView> = {}): MonthView => ({
  month: '2026-09',
  status: 'closed',
  income: { salary: 300000, extra: 0, total: 300000 },
  fixedCosts: 1399,
  subscriptions: [],
  budgets: [
    line({ id: 1, name: 'Groceries', spent: 52000, remaining: 8000, toSavings: 8000 }),
    line({
      id: 2,
      name: 'Eating out',
      alert: 'over',
      available: 20000,
      spent: 24200,
      remaining: -4200,
      toSavings: -4200,
    }),
    line({
      id: 3,
      name: 'Fuel',
      incremental: true,
      available: 30000,
      spent: 10000,
      remaining: 20000,
      carriedOut: 20000,
      toSavings: 0,
    }),
  ],
  totals: { allocated: 95000, spent: 86200, remaining: 23800, transfersNet: 0 },
  unallocated: 203601,
  overAllocated: false,
  savingsDue: { unallocated: 203601, budgetsSettled: 3800, reservesReleased: 0, total: 207401 },
  ...overrides,
});

describe('recapMessage', () => {
  // September is in the inbox, nothing settled: what is outstanding is the whole 2,074.01 due.
  const base = {
    nextMonth: '2026-10',
    outstanding: {
      settled: 0,
      outstanding: 207401,
      direction: 'move' as const,
      adjustment: false,
    },
    format: GB,
    appUrl: undefined,
  };

  it('words the closed month from the month view, to the cent', () => {
    const { text, extra } = recapMessage({ ...base, view: september() });
    expect(text).toBe(
      [
        '📅 September 2026 is closed',
        'Spent €862.00 · €238.00 left over',
        '🔴 Over: Eating out by €42.00',
        '↪ Carried into October: €200.00',
        '💰 Due to savings: €2,074.01 · not settled yet',
      ].join('\n'),
    );
    expect(extra).toBeUndefined();
  });

  it('lists several budgets that are over, by their negated remaining, in the order of the view', () => {
    const view = september();
    view.budgets[2] = line({
      id: 3,
      name: 'Fuel',
      alert: 'over',
      available: 10000,
      spent: 11240,
      remaining: -1240,
    });
    const { text } = recapMessage({ ...base, view });
    expect(text).toContain('🔴 Over: Eating out by €42.00, Fuel by €12.40');
  });

  it('leaves the Over line out when no budget is over', () => {
    const view = september();
    view.budgets[1] = line({ id: 2, name: 'Eating out', remaining: 100, available: 24300 });
    const { text } = recapMessage({ ...base, view });
    expect(text).not.toContain('Over');
    expect(text.split('\n')).toHaveLength(4);
  });

  it('sums carriedOut over the lines, deficits included', () => {
    const view = september();
    view.budgets[0] = line({ id: 1, name: 'Groceries', carriedOut: -3000 });
    const { text } = recapMessage({ ...base, view });
    expect(text).toContain('↪ Carried into October: €170.00'); // 200.00 - 30.00
  });

  it('reads a total overspend as "over" rather than a negative "left over"', () => {
    const view = september({
      totals: { allocated: 95000, spent: 86200, remaining: -4000, transfersNet: 0 },
    });
    const { text } = recapMessage({ ...base, view });
    expect(text).toContain('Spent €862.00 · €40.00 over');
    expect(text).not.toContain('left over');
  });

  it('names the month it carries into, across a year end', () => {
    const view = september({ month: '2026-12' });
    const { text } = recapMessage({ ...base, view, nextMonth: '2027-01' });
    expect(text).toContain('📅 December 2026 is closed');
    expect(text).toContain('↪ Carried into January: €200.00');
  });

  it('reads a negative total as money to take from savings, by its absolute value', () => {
    const view = september({
      savingsDue: { unallocated: 0, budgetsSettled: -15000, reservesReleased: 0, total: -15000 },
    });
    const { text } = recapMessage({
      ...base,
      outstanding: { settled: 0, outstanding: -15000, direction: 'take', adjustment: false },
      view,
    });
    expect(text.split('\n').at(-1)).toBe('💰 To take from savings: €150.00 · not settled yet');
  });

  it('adds the Open savings button only with APP_URL', () => {
    const { extra } = recapMessage({
      ...base,
      view: september(),
      appUrl: 'https://wallet.example.ts.net',
    });
    expect(extra).toEqual({
      reply_markup: {
        inline_keyboard: [[{ text: 'Open savings', url: 'https://wallet.example.ts.net/savings' }]],
      },
    });
  });

  it('escapes the names of budgets that are over', () => {
    const view = september();
    view.budgets[1] = line({ id: 2, name: '<i>&', alert: 'over', remaining: -100 });
    const { text } = recapMessage({ ...base, view });
    expect(text).toContain('🔴 Over: &lt;i&gt;&amp; by €1.00');
  });

  it('shortens a long Over list with "and N more" and stays under the limit', () => {
    const budgets = Array.from({ length: 80 }, (_, index) =>
      line({
        id: index + 1,
        name: `${String(index + 1).padStart(2, '0')} ${'y'.repeat(57)}`,
        alert: 'over',
        remaining: -100 * (index + 1),
      }),
    );
    // 80 names of 60 characters are far more than 4096 characters of list.
    const { text } = recapMessage({ ...base, view: september({ budgets }) });
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    const over = text.split('\n')[2] ?? '';
    expect(over).toMatch(/^🔴 Over: 01 y+ by €1\.00, .* and \d+ more$/);
    // What is shown is a prefix of the full list, and the count is the rest.
    const shown = over.split(' and ')[0]?.split(', ').length ?? 0;
    const more = Number(/and (\d+) more$/.exec(over)?.[1]);
    expect(shown + more).toBe(80);
    // The rest of the message is untouched.
    expect(text.split('\n')).toHaveLength(5);
    expect(text.split('\n')[4]).toContain('💰 Due to savings');
  });
});

describe('savingsMarker', () => {
  /** An entry of the inbox: `adjustment` is true when the month has settlement rows, as in the DTO. */
  const entry = (settled: number, outstanding: number, adjustment = settled !== 0) => ({
    settled,
    outstanding,
    direction: outstanding > 0 ? ('move' as const) : ('take' as const),
    adjustment,
  });

  it('is "not settled yet" while the month is in the inbox and nothing was settled', () => {
    expect(savingsMarker(63000, entry(0, 63000), GB)).toBe(' · not settled yet');
    expect(savingsMarker(-5000, entry(0, -5000), GB)).toBe(' · not settled yet');
  });

  it('is "settled" when it is not in the inbox and the total is not 0', () => {
    expect(savingsMarker(63000, undefined, GB)).toBe(' · settled');
    expect(savingsMarker(-100, undefined, GB)).toBe(' · settled');
  });

  it('is nothing when the total is 0 and nothing is outstanding', () => {
    expect(savingsMarker(0, undefined, GB)).toBe('');
  });

  it('words an adjustment that takes money back as the savings inbox does', () => {
    // Moved 600.00, then a forgotten 30.00 spending: 570.00 is due, so 30.00 is taken back.
    expect(savingsMarker(57000, entry(60000, -3000), GB)).toBe(
      ' · €600.00 already moved to savings, take €30.00 more from savings',
    );
  });

  it('words an adjustment that moves more money to savings', () => {
    // Moved 600.00, then a 30.00 refund: 630.00 is due, so 30.00 more is moved.
    expect(savingsMarker(63000, entry(60000, 3000), GB)).toBe(
      ' · €600.00 already moved to savings, move €30.00 more to savings',
    );
  });

  it('words an adjustment on a month that is due nothing now', () => {
    expect(savingsMarker(0, entry(60000, -60000), GB)).toBe(
      ' · €600.00 already moved to savings, take €600.00 more from savings',
    );
  });

  it('says in words, with an unsigned amount, that money was already taken from savings', () => {
    // 200.00 was taken and 30.00 more is due to be taken: 230.00 in all.
    expect(savingsMarker(-23000, entry(-20000, -3000), GB)).toBe(
      ' · €200.00 already taken from savings, take €30.00 more from savings',
    );
    // 200.00 was taken and a 50.00 refund means only 150.00 is due to be taken: 50.00 comes back.
    expect(savingsMarker(-15000, entry(-20000, 5000), GB)).toBe(
      ' · €200.00 already taken from savings, move €50.00 more to savings',
    );
    for (const marker of [
      savingsMarker(-23000, entry(-20000, -3000), GB),
      savingsMarker(-15000, entry(-20000, 5000), GB),
    ]) {
      expect(marker).not.toMatch(/-€|−/); // no signed amount anywhere
    }
  });

  it('words a change of direction: moved to savings, and now money is to be taken', () => {
    // 100.00 was moved, then the month is due -50.00: 150.00 is taken back to end at -50.00.
    expect(savingsMarker(-5000, entry(10000, -15000), GB)).toBe(
      ' · €100.00 already moved to savings, take €150.00 more from savings',
    );
  });

  it('follows the adjustment flag of the entry when earlier settlements cancel out, as the inbox does', () => {
    // Settled 600.00 and then undone by a settlement of -600.00: nothing is settled net, but the
    // month has settlement rows, so the inbox shows a "Correction".
    expect(savingsMarker(3000, entry(0, 3000, true), GB)).toBe(
      ' · settled before, move €30.00 more to savings',
    );
    expect(savingsMarker(-3000, entry(0, -3000, true), GB)).toBe(
      ' · settled before, take €30.00 more from savings',
    );
    // Without settlement rows the same figures are a first settlement.
    expect(savingsMarker(3000, entry(0, 3000, false), GB)).toBe(' · not settled yet');
  });
});

describe('recapMessage after an adjustment', () => {
  it('prints the total and then the correction, to the cent', () => {
    const view = september({
      savingsDue: { unallocated: 203601, budgetsSettled: 800, reservesReleased: 0, total: 204401 },
    });
    const { text } = recapMessage({
      view,
      nextMonth: '2026-10',
      outstanding: { settled: 207401, outstanding: -3000, direction: 'take', adjustment: true },
      format: GB,
      appUrl: undefined,
    });
    expect(text.split('\n').at(-1)).toBe(
      '💰 Due to savings: €2,044.01 · €2,074.01 already moved to savings, take €30.00 more from savings',
    );
  });
});
