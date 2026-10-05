import { describe, expect, it } from 'vitest';
import {
  BOT_COMMANDS,
  BUTTON_NAME_MAX_CHARS,
  type BudgetFigure,
  MESSAGE_MAX_CHARS,
  amountNoteText,
  amountProblemText,
  budgetFigureText,
  budgetTitle,
  chunkLines,
  closedMonthText,
  dayLabel,
  escapeHtml,
  helpText,
  incomeConfirmationText,
  incomeFiguresText,
  incomeQuestionText,
  incomeRemovedText,
  incomeText,
  INCOME_SAVED_NOT_SHOWN_TEXT,
  MOVED_NOT_SHOWN_TEXT,
  REMOVED_NOT_SHOWN_TEXT,
  SAVED_NOT_SHOWN_TEXT,
  linkGreeting,
  monthLabel,
  quickBudgetPromptText,
  recentDates,
  recentText,
  spendingConfirmationText,
  spendingDraftText,
  spendingQuestionText,
  spendingRemovedText,
  spendingText,
  statusFooterText,
  statusLineText,
  truncateLabel,
  visibleLength,
} from './telegram.messages';

const FMT = { currency: 'EUR', locale: 'en-GB' };
const NASTY = '<b>&';

describe('escapeHtml', () => {
  it('escapes the three characters Telegram reads as markup', () => {
    expect(escapeHtml('<b>&')).toBe('&lt;b&gt;&amp;');
    expect(escapeHtml('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d');
  });

  it('escapes the ampersand first, so that it does not escape twice', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
    expect(escapeHtml('<')).toBe('&lt;');
  });

  it('leaves everything else as it is', () => {
    expect(escapeHtml('Lidl\'s "best" café — 12,50 € 🛒')).toBe('Lidl\'s "best" café — 12,50 € 🛒');
    expect(escapeHtml('')).toBe('');
  });
});

describe('the command list', () => {
  it('is the T2 list, in order', () => {
    expect(BOT_COMMANDS.map((c) => c.command)).toEqual([
      'spending',
      'income',
      'status',
      'recent',
      'undo',
      'cancel',
      'help',
    ]);
  });

  it('fits Telegram setMyCommands: 1 to 32 lowercase letters, digits or underscores; a description of 3 to 256 characters', () => {
    for (const { command, description } of BOT_COMMANDS) {
      expect(command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(description.length).toBeGreaterThanOrEqual(3);
      expect(description.length).toBeLessThanOrEqual(256);
    }
  });

  it('is what /help lists', () => {
    const text = helpText();
    for (const { command, description } of BOT_COMMANDS) {
      expect(text).toContain(`/${command} – ${description}`);
    }
  });
});

describe('the link greeting', () => {
  it('greets by first name, escaped, then lists the commands', () => {
    expect(linkGreeting('Olivia')).toBe(`✅ Linked to Wallet, Olivia.\n\n${helpText()}`);
    expect(linkGreeting('<i>&')).toContain('Linked to Wallet, &lt;i&gt;&amp;.');
  });
});

describe('spendings', () => {
  const facts = { amount: 2340, budgetName: 'Groceries', note: 'Lidl', date: '2026-10-05' };

  it('writes amount, budget, note and date; the note is left out when empty', () => {
    expect(spendingText(facts, FMT)).toBe('€23.40 · Groceries · Lidl · Mon 5 Oct');
    expect(spendingText({ ...facts, note: '' }, FMT)).toBe('€23.40 · Groceries · Mon 5 Oct');
    expect(spendingText(facts, FMT, { withDate: false })).toBe('€23.40 · Groceries · Lidl');
  });

  it('reads a refund as a refund, with the amount unsigned', () => {
    expect(spendingText({ ...facts, amount: -500 }, FMT)).toBe(
      '↩ Refund €5.00 · Groceries · Lidl · Mon 5 Oct',
    );
    expect(amountNoteText(-500, 'jar', FMT)).toBe('↩ Refund €5.00 · jar');
    expect(amountNoteText(450, '', FMT)).toBe('€4.50');
  });

  it('formats with the currency and the locale of the settings', () => {
    expect(spendingText(facts, { currency: 'USD', locale: 'en-US' })).toBe(
      '$23.40 · Groceries · Lidl · Mon, Oct 5',
    );
    expect(
      spendingText({ ...facts, amount: 123456 }, { currency: 'EUR', locale: 'de-DE' }),
    ).toMatch(/^1\.234,56\s€ · Groceries · Lidl · Mo\., 5\. Okt\.$/);
  });

  it('escapes the budget and the note everywhere they appear, and nothing else', () => {
    const nasty = { ...facts, budgetName: NASTY, note: NASTY };
    const escaped = '&lt;b&gt;&amp;';
    expect(spendingText(nasty, FMT)).toBe(`€23.40 · ${escaped} · ${escaped} · Mon 5 Oct`);
    expect(spendingDraftText(nasty, FMT)).toBe(`€23.40 · ${escaped} · ${escaped}`);
    expect(spendingConfirmationText(nasty, null, FMT)).toBe(
      `✅ €23.40 · ${escaped} · ${escaped} · Mon 5 Oct`,
    );
    expect(spendingRemovedText(nasty, null, FMT)).toBe(
      `🗑 Removed €23.40 · ${escaped} · ${escaped} · Mon 5 Oct`,
    );
    expect(spendingQuestionText(nasty, FMT, 'Delete')).toBe(
      `Delete €23.40 · ${escaped} · ${escaped} (Mon 5 Oct)?`,
    );
    expect(spendingQuestionText(nasty, FMT, 'Remove')).toBe(
      `Remove €23.40 · ${escaped} · ${escaped} (Mon 5 Oct)?`,
    );
    expect(recentText([nasty], FMT)).toBe(
      `Last spendings\n1. €23.40 · ${escaped} · ${escaped} · Mon 5 Oct`,
    );
    expect(quickBudgetPromptText(450, NASTY, FMT)).toBe(`€4.50 · ${escaped}. Which budget?`);
    expect(budgetTitle({ icon: NASTY, name: NASTY })).toBe(`${escaped} ${escaped}`);
    expect(budgetTitle({ icon: null, name: NASTY })).toBe(escaped);
  });

  it('escapes the name in every figure, line and sentence', () => {
    const figure: BudgetFigure = {
      name: NASTY,
      remaining: 100,
      available: 200,
      usagePercent: 50,
      alert: 'ok',
      warnPercent: 80,
    };
    expect(budgetFigureText(figure, FMT)).toBe('&lt;b&gt;&amp;: €1.00 left of €2.00 (50% used)');
    expect(statusLineText({ ...figure, icon: NASTY }, FMT)).toBe(
      '&lt;b&gt;&amp; &lt;b&gt;&amp; · €1.00 left of €2.00 (50%)',
    );
    expect(amountProblemText('too_large', 'spending', FMT)).not.toContain('<');
  });

  it('keeps the text a message shows free of raw markup from names and notes', () => {
    const nasty = { ...facts, budgetName: '<a href="x">y</a>', note: '</b><i>' };
    for (const text of [
      spendingText(nasty, FMT),
      spendingConfirmationText(nasty, null, FMT),
      spendingQuestionText(nasty, FMT, 'Delete'),
    ]) {
      expect(text).not.toMatch(/<[a-z/]/);
    }
  });

  it('is longer than Telegram would take for nothing the bot sends: a confirmation with the longest name and note fits', () => {
    const longest = { ...facts, budgetName: '&'.repeat(60), note: '&'.repeat(200) };
    const figure: BudgetFigure = {
      name: '&'.repeat(60),
      remaining: -1,
      available: 10,
      usagePercent: 10,
      alert: 'over',
      warnPercent: 80,
    };
    expect(visibleLength(spendingConfirmationText(longest, figure, FMT, 'September'))).toBeLessThan(
      MESSAGE_MAX_CHARS,
    );
  });
});

describe('budget figures', () => {
  const figure = (overrides: Partial<BudgetFigure>): BudgetFigure => ({
    name: 'Groceries',
    remaining: 16410,
    available: 30000,
    usagePercent: 45,
    alert: 'ok',
    warnPercent: 80,
    ...overrides,
  });

  it('prints what is left, of what, and the percentage used', () => {
    expect(budgetFigureText(figure({}), FMT)).toBe('Groceries: €164.10 left of €300.00 (45% used)');
  });

  it('marks a warning with the sign and the threshold of the line', () => {
    expect(
      budgetFigureText(
        figure({
          alert: 'warning',
          usagePercent: 81,
          remaining: 5700,
          available: 30000,
          warnPercent: 80,
        }),
        FMT,
      ),
    ).toBe('⚠️ Groceries: €57.00 left of €300.00 (81% used, warning at 80%)');
    expect(
      budgetFigureText(figure({ alert: 'warning', usagePercent: 60, warnPercent: 60 }), FMT),
    ).toContain('warning at 60%');
  });

  it('marks over with "over by" (minus remaining), and the percentage of what was available', () => {
    expect(
      budgetFigureText(
        figure({ alert: 'over', remaining: -1240, available: 20000, usagePercent: 106 }),
        FMT,
      ),
    ).toBe('🔴 Groceries: over by €12.40 (106% of €200.00 used)');
  });

  it('has no percentage when nothing is available, ok or over', () => {
    expect(budgetFigureText(figure({ available: 0, remaining: 0, usagePercent: null }), FMT)).toBe(
      'Groceries: €0.00 left of €0.00',
    );
    expect(
      budgetFigureText(
        figure({ alert: 'over', available: 0, remaining: -500, usagePercent: null }),
        FMT,
      ),
    ).toBe('🔴 Groceries: over by €5.00');
    expect(
      budgetFigureText(
        figure({ alert: 'over', available: -1000, remaining: -1500, usagePercent: null }),
        FMT,
      ),
    ).toBe('🔴 Groceries: over by €15.00');
  });

  it('says the month when it is closed', () => {
    expect(budgetFigureText(figure({}), FMT, 'September')).toBe(
      'Groceries in September (closed): €164.10 left of €300.00 (45% used)',
    );
    expect(
      budgetFigureText(figure({ alert: 'over', remaining: -100 }), FMT, 'September 2025'),
    ).toContain('🔴 Groceries in September 2025 (closed): over by €1.00');
  });

  it('negates remaining only for "over by", and prints a negative figure with its sign otherwise', () => {
    // alert says ok although remaining is 0: nothing is over.
    expect(budgetFigureText(figure({ remaining: 0, usagePercent: 100 }), FMT)).toBe(
      'Groceries: €0.00 left of €300.00 (100% used)',
    );
  });

  it('writes the confirmation: a check mark, the row, then the figure; a refund has no check mark', () => {
    const facts = { amount: 2340, budgetName: 'Groceries', note: 'Lidl', date: '2026-10-05' };
    expect(spendingConfirmationText(facts, figure({}), FMT)).toBe(
      '✅ €23.40 · Groceries · Lidl · Mon 5 Oct\nGroceries: €164.10 left of €300.00 (45% used)',
    );
    expect(spendingConfirmationText({ ...facts, amount: -500 }, figure({}), FMT)).toBe(
      '↩ Refund €5.00 · Groceries · Lidl · Mon 5 Oct\nGroceries: €164.10 left of €300.00 (45% used)',
    );
    expect(spendingConfirmationText(facts, null, FMT)).toBe(
      '✅ €23.40 · Groceries · Lidl · Mon 5 Oct',
    );
    expect(spendingRemovedText(facts, figure({}), FMT, 'September')).toBe(
      '🗑 Removed €23.40 · Groceries · Lidl · Mon 5 Oct\nGroceries in September (closed): €164.10 left of €300.00 (45% used)',
    );
  });
});

describe('incomes', () => {
  const income = { amount: 20000, description: 'Bonus', date: '2026-10-05' };
  it('writes the income, and the month figures with the warning sign when over-allocated', () => {
    expect(incomeText(income, FMT)).toBe('Income €200.00 · Bonus · Mon 5 Oct');
    expect(incomeText(income, FMT, { withDate: false })).toBe('Income €200.00 · Bonus');
    const figures = { total: 320000, unallocated: 32000, overAllocated: false };
    expect(incomeFiguresText(figures, 'October', FMT, false)).toBe(
      'October: income €3,200.00 · Unallocated €320.00',
    );
    expect(
      incomeFiguresText(
        { ...figures, unallocated: -4000, overAllocated: true },
        'October',
        FMT,
        false,
      ),
    ).toBe('October: income €3,200.00 · ⚠️ Unallocated -€40.00');
    expect(incomeFiguresText(figures, 'September', FMT, true)).toBe(
      'September (closed): income €3,200.00 · Unallocated €320.00',
    );
    expect(incomeConfirmationText(income, 'October: x', FMT)).toBe(
      '✅ Income €200.00 · Bonus · Mon 5 Oct\nOctober: x',
    );
    expect(incomeConfirmationText(income, null, FMT)).toBe('✅ Income €200.00 · Bonus · Mon 5 Oct');
    expect(incomeRemovedText(income, 'October: x', FMT)).toBe(
      '🗑 Removed Income €200.00 · Bonus · Mon 5 Oct\nOctober: x',
    );
    expect(incomeQuestionText(income, FMT, 'Remove')).toBe(
      'Remove Income €200.00 · Bonus (Mon 5 Oct)?',
    );
  });

  it('escapes the description', () => {
    expect(incomeText({ ...income, description: NASTY }, FMT)).toBe(
      'Income €200.00 · &lt;b&gt;&amp; · Mon 5 Oct',
    );
    expect(incomeQuestionText({ ...income, description: NASTY }, FMT, 'Delete')).toContain(
      '&lt;b&gt;&amp;',
    );
  });
});

describe('the closed-month question', () => {
  /** The budget settles with savings in this month. */
  const settles = (name: string) => ({ name, savingsFor: name });
  /** The budget carries on from this month into the current one. */
  const carries = (name: string) => ({ name, savingsFor: null });
  /** The budget carries on from this month and settles with savings in a later closed month. */
  const settlesLater = (name: string, later: string) => ({ name, savingsFor: later });

  it('names one month, or several, and says what the action does to savings due', () => {
    expect(closedMonthText('Adding', [settles('September')])).toBe(
      'September is closed. Adding this changes what is due to savings for September.',
    );
    expect(closedMonthText('Moving', [settles('August'), settles('September')])).toBe(
      'August and September are closed. Moving this changes what is due to savings for August and September.',
    );
    expect(closedMonthText('Removing', [settles('June'), settles('July'), settles('August')])).toBe(
      'June, July and August are closed. Removing this changes what is due to savings for June, July and August.',
    );
  });

  it('words a budget that carries on by what it carries forward, not by savings due', () => {
    expect(closedMonthText('Adding', [carries('September')], 'Fuel')).toBe(
      'September is closed. Adding this changes what Fuel carries forward from September.',
    );
    expect(closedMonthText('Removing', [carries('August'), carries('September')], 'Fuel')).toBe(
      'August and September are closed. Removing this changes what Fuel carries forward from August and September.',
    );
  });

  it('says both when the budget settles in one closed month and carries on in another', () => {
    expect(closedMonthText('Moving', [settles('August'), carries('September')], 'Fuel')).toBe(
      'August and September are closed. Moving this changes what is due to savings for August and what Fuel carries forward from September.',
    );
  });

  it('names the later month where a carry settles with savings, not the month that was touched', () => {
    expect(closedMonthText('Removing', [settlesLater('August', 'September')], 'Fuel')).toBe(
      'August is closed. Removing this changes what is due to savings for September.',
    );
    // Touching a month and the one where it settles names that savings month once.
    expect(
      closedMonthText(
        'Moving',
        [settlesLater('August', 'September'), settles('September')],
        'Fuel',
      ),
    ).toBe(
      'August and September are closed. Moving this changes what is due to savings for September.',
    );
    expect(
      closedMonthText('Moving', [settlesLater('July', 'September'), carries('August')], 'Fuel'),
    ).toBe(
      'July and August are closed. Moving this changes what is due to savings for September and what Fuel carries forward from August.',
    );
  });

  it('escapes the budget name', () => {
    expect(closedMonthText('Adding', [carries('September')], NASTY)).toBe(
      'September is closed. Adding this changes what &lt;b&gt;&amp; carries forward from September.',
    );
  });
});

describe('the current month’s line under a closed month’s', () => {
  const closedLine: BudgetFigure = {
    name: 'Fuel',
    remaining: 87500,
    available: 90000,
    usagePercent: 2,
    alert: 'ok',
    warnPercent: 80,
  };
  const nowLine: BudgetFigure = {
    name: 'Fuel',
    remaining: 97500,
    available: 110000,
    usagePercent: 11,
    alert: 'ok',
    warnPercent: 80,
  };
  const facts = { amount: 2500, budgetName: 'Fuel', note: 'diesel', date: '2026-09-30' };

  it('prints the figure of the closed month, then the one of this month', () => {
    expect(
      spendingConfirmationText(facts, closedLine, FMT, 'September', {
        figure: nowLine,
        label: 'October',
        closed: false,
      }),
    ).toBe(
      '✅ €25.00 · Fuel · diesel · Wed 30 Sept\n' +
        'Fuel in September (closed): €875.00 left of €900.00 (2% used)\n' +
        'Fuel in October (this month): €975.00 left of €1,100.00 (11% used)',
    );
    expect(
      spendingRemovedText(facts, closedLine, FMT, 'September', {
        figure: nowLine,
        label: 'October',
        closed: false,
      }),
    ).toBe(
      '🗑 Removed €25.00 · Fuel · diesel · Wed 30 Sept\n' +
        'Fuel in September (closed): €875.00 left of €900.00 (2% used)\n' +
        'Fuel in October (this month): €975.00 left of €1,100.00 (11% used)',
    );
  });

  it('marks the this-month line with the mark of its own alert', () => {
    expect(
      budgetFigureText({ ...nowLine, alert: 'over', remaining: -100 }, FMT, undefined, 'October'),
    ).toBe('🔴 Fuel in October (this month): over by €1.00 (11% of €1,100.00 used)');
  });

  it('names a closed month where the carry settles as closed, not as this month', () => {
    const septemberLine: BudgetFigure = {
      ...nowLine,
      remaining: 10000,
      available: 10000,
      usagePercent: 0,
    };
    expect(
      spendingConfirmationText(facts, closedLine, FMT, 'August', {
        figure: septemberLine,
        label: 'September',
        closed: true,
      }),
    ).toBe(
      '✅ €25.00 · Fuel · diesel · Wed 30 Sept\n' +
        'Fuel in August (closed): €875.00 left of €900.00 (2% used)\n' +
        'Fuel in September (closed): €100.00 left of €100.00 (0% used)',
    );
  });

  it('is left out when there is none', () => {
    expect(spendingConfirmationText(facts, closedLine, FMT, 'September')).toBe(
      '✅ €25.00 · Fuel · diesel · Wed 30 Sept\nFuel in September (closed): €875.00 left of €900.00 (2% used)',
    );
  });
});

describe('what is said when a write cannot be confirmed', () => {
  it('never claims that nothing was changed', () => {
    for (const text of [
      SAVED_NOT_SHOWN_TEXT,
      INCOME_SAVED_NOT_SHOWN_TEXT,
      MOVED_NOT_SHOWN_TEXT,
      REMOVED_NOT_SHOWN_TEXT,
    ]) {
      expect(text).not.toMatch(/nothing was changed/i);
    }
    expect(SAVED_NOT_SHOWN_TEXT).toBe(
      "Saved, but I couldn't show the confirmation. /recent lists it.",
    );
    expect(INCOME_SAVED_NOT_SHOWN_TEXT).toBe(
      "Saved, but I couldn't show the confirmation. /undo takes it back.",
    );
    expect(MOVED_NOT_SHOWN_TEXT).toBe("Moved, but I couldn't show the result.");
    expect(REMOVED_NOT_SHOWN_TEXT).toBe("Removed, but I couldn't show the result.");
  });
});

describe('/status', () => {
  const line = {
    name: 'Groceries',
    icon: '🛒',
    remaining: 16410,
    available: 30000,
    usagePercent: 45,
    alert: 'ok' as const,
    warnPercent: 80,
  };

  it('writes a line with the icon, what is left, of what, and the percentage', () => {
    expect(statusLineText(line, FMT)).toBe('🛒 Groceries · €164.10 left of €300.00 (45%)');
  });

  it('marks warning and over at the end, uses "over by", and a bullet when there is no icon', () => {
    expect(statusLineText({ ...line, alert: 'warning', usagePercent: 85 }, FMT)).toBe(
      '🛒 Groceries · €164.10 left of €300.00 (85%) ⚠️',
    );
    expect(
      statusLineText(
        { ...line, alert: 'over', remaining: -1240, available: 10000, usagePercent: 112 },
        FMT,
      ),
    ).toBe('🛒 Groceries · over by €12.40 of €100.00 (112%) 🔴');
    expect(statusLineText({ ...line, icon: null }, FMT)).toBe(
      '• Groceries · €164.10 left of €300.00 (45%)',
    );
  });

  it('leaves the percentage out when it is null', () => {
    expect(statusLineText({ ...line, available: 0, remaining: 0, usagePercent: null }, FMT)).toBe(
      '🛒 Groceries · €0.00 left of €0.00',
    );
    expect(
      statusLineText(
        { ...line, alert: 'over', available: 0, remaining: -500, usagePercent: null },
        FMT,
      ),
    ).toBe('🛒 Groceries · over by €5.00 🔴');
  });

  it('counts the days left: after today up to the last day of the month', () => {
    const figures = { unallocated: 32000, overAllocated: false };
    expect(statusFooterText('2026-10', '2026-10-05', figures, FMT)).toBe(
      '26 days left in October · Unallocated €320.00',
    );
    expect(statusFooterText('2026-10', '2026-10-30', figures, FMT)).toBe(
      '1 day left in October · Unallocated €320.00',
    );
    expect(statusFooterText('2026-10', '2026-10-31', figures, FMT)).toBe(
      'Last day of October · Unallocated €320.00',
    );
    expect(statusFooterText('2026-10', '2026-10-01', figures, FMT)).toBe(
      '30 days left in October · Unallocated €320.00',
    );
    expect(statusFooterText('2028-02', '2028-02-10', figures, FMT)).toBe(
      '19 days left in February · Unallocated €320.00',
    );
    expect(statusFooterText('2027-02', '2027-02-10', figures, FMT)).toBe(
      '18 days left in February · Unallocated €320.00',
    );
    expect(
      statusFooterText('2026-10', '2026-10-05', { unallocated: -500, overAllocated: true }, FMT),
    ).toBe('26 days left in October · ⚠️ Unallocated -€5.00');
  });

  it('names the month in the locale of the settings', () => {
    expect(
      statusFooterText(
        '2026-10',
        '2026-10-05',
        { unallocated: 0, overAllocated: false },
        { currency: 'EUR', locale: 'de-DE' },
      ),
    ).toMatch(/^26 days left in Oktober · Unallocated 0,00\s€$/);
  });
});

describe('/recent', () => {
  it('numbers the rows, and says so when there are none', () => {
    const rows = [
      { amount: 1250, budgetName: 'Groceries', note: 'lunch', date: '2026-10-03' },
      { amount: -500, budgetName: 'Fun', note: '', date: '2026-10-02' },
    ];
    expect(recentText(rows, FMT)).toBe(
      'Last spendings\n1. €12.50 · Groceries · lunch · Sat 3 Oct\n2. ↩ Refund €5.00 · Fun · Fri 2 Oct',
    );
    expect(recentText([], FMT)).toBe('No spendings yet.');
  });
});

describe('the amount problems', () => {
  it('give an example to copy, for a spending and for an income', () => {
    expect(amountProblemText('not_an_amount', 'spending', FMT)).toBe(
      "I couldn't read an amount there. Try 12.50 or 12,50 lunch.",
    );
    expect(amountProblemText('not_an_amount', 'income', FMT)).toBe(
      "I couldn't read an amount there. Try 200 or 200 Bonus.",
    );
    expect(amountProblemText('zero', 'spending', FMT)).toContain('-5 for a refund');
    expect(amountProblemText('not_positive', 'income', FMT)).toBe(
      'An income is a positive amount. Try 200 Bonus.',
    );
    expect(amountProblemText('too_large', 'spending', FMT)).toBe(
      'That amount is too large: the most is €10,000,000,000.00.',
    );
    expect(amountProblemText('note_too_long', 'spending', FMT)).toBe(
      'That note is too long: 200 characters at most.',
    );
    expect(amountProblemText('note_too_long', 'income', FMT)).toBe(
      'That description is too long: 200 characters at most.',
    );
  });
});

describe('labels, days and months', () => {
  it('cuts a label at 24 characters with an ellipsis, by code point, and leaves a short one alone', () => {
    expect(BUTTON_NAME_MAX_CHARS).toBe(24);
    expect(truncateLabel('Groceries')).toBe('Groceries');
    expect(truncateLabel('x'.repeat(24))).toBe('x'.repeat(24));
    expect(truncateLabel('x'.repeat(25))).toBe(`${'x'.repeat(23)}…`);
    expect(Array.from(truncateLabel('x'.repeat(100))).length).toBe(24);
    // An emoji is one character, and is never cut in half.
    expect(truncateLabel('🛒'.repeat(30))).toBe(`${'🛒'.repeat(23)}…`);
    expect(truncateLabel('ab cd', 4)).toBe('ab…');
    expect(truncateLabel('')).toBe('');
  });

  it('writes a day as the weekday and the day of the month', () => {
    expect(dayLabel('2026-09-30', FMT)).toBe('Wed 30');
    expect(dayLabel('2026-10-01', { locale: 'en-US' })).toBe('1 Thu'); // the locale's own order
    expect(dayLabel('2026-10-01', { locale: 'xx_invalid' })).toMatch(/Thu/);
  });

  it('offers today and the 6 days before, newest first, and never a day before the start month', () => {
    expect(recentDates('2026-10-05', '2026-01')).toEqual([
      '2026-10-05',
      '2026-10-04',
      '2026-10-03',
      '2026-10-02',
      '2026-10-01',
      '2026-09-30',
      '2026-09-29',
    ]);
    expect(recentDates('2026-10-05', '2026-10')).toEqual([
      '2026-10-05',
      '2026-10-04',
      '2026-10-03',
      '2026-10-02',
      '2026-10-01',
    ]);
    expect(recentDates('2026-10-01', '2026-10')).toEqual(['2026-10-01']);
    expect(recentDates('2028-03-02', '2026-01')).toEqual([
      '2028-03-02',
      '2028-03-01',
      '2028-02-29',
      '2028-02-28',
      '2028-02-27',
      '2028-02-26',
      '2028-02-25',
    ]);
    expect(recentDates('2027-01-03', '2026-01')[6]).toBe('2026-12-28');
  });

  it('writes the year of a month only when it is not the current year', () => {
    expect(monthLabel('2026-09', '2026-10', FMT)).toBe('September');
    expect(monthLabel('2025-12', '2026-10', FMT)).toBe('December 2025');
  });
});

describe('Telegram’s limits', () => {
  it('counts what Telegram counts: tags are not text, and an entity is one character', () => {
    expect(visibleLength('<b>a</b>')).toBe(1);
    expect(visibleLength('&lt;b&gt;&amp;')).toBe(4); // < b > &
    expect(visibleLength('plain')).toBe(5);
  });

  it('splits lines into messages under the limit, never splitting a line, in order', () => {
    const lines = Array.from({ length: 200 }, (_unused, i) => `line ${i} ${'x'.repeat(40)}`);
    const chunks = chunkLines(lines);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(visibleLength(chunk)).toBeLessThanOrEqual(MESSAGE_MAX_CHARS);
    expect(chunks.join('\n').split('\n')).toEqual(lines);
  });

  it('gives one message for a short list, none for nothing, and keeps a single huge line alone', () => {
    expect(chunkLines(['a', 'b'])).toEqual(['a\nb']);
    expect(chunkLines([])).toEqual([]);
    const huge = 'x'.repeat(5000);
    expect(chunkLines(['a', huge, 'b'])).toEqual(['a', huge, 'b']);
  });
});
