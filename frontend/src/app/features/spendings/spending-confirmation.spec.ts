import { budgetLine } from '../../../testing/fixtures';
import { addedConfirmation } from './spending-confirmation';

const money = (cents: number) => `€${(cents / 100).toFixed(2)}`;

describe('addedConfirmation', () => {
  it('says what was added and what is left of the budget, as the month view reports it', () => {
    const line = budgetLine({ name: 'Groceries', available: 40000, remaining: 28750 });

    expect(addedConfirmation({ budgetId: 1, amount: 1250 }, line, money)).toBe(
      'Added €12.50 to Groceries. €287.50 left of €400.00.',
    );
  });

  it('words a refund as one', () => {
    const line = budgetLine({ name: 'Fun', available: 15000, remaining: 15000 });

    expect(addedConfirmation({ budgetId: 2, amount: -4500 }, line, money)).toBe(
      'Refund of €45.00 added to Fun. €150.00 left of €150.00.',
    );
  });

  it('says how far over budget it is, with the share used when the API gives one', () => {
    const over = budgetLine({ name: 'Groceries', remaining: -11159, usagePercent: 128 });
    expect(addedConfirmation({ budgetId: 1, amount: 100 }, over, money)).toBe(
      'Added €1.00 to Groceries. Over budget by €111.59 (128% used).',
    );

    const noShare = budgetLine({ name: 'Groceries', remaining: -500, usagePercent: null });
    expect(addedConfirmation({ budgetId: 1, amount: 100 }, noShare, money)).toBe(
      'Added €1.00 to Groceries. Over budget by €5.00.',
    );
  });

  it('adds the warning when the budget is close to its limit', () => {
    const line = budgetLine({
      name: 'Groceries',
      available: 40000,
      remaining: 6000,
      usagePercent: 85,
      alert: 'warning',
    });

    expect(addedConfirmation({ budgetId: 1, amount: 100 }, line, money)).toMatch(
      /^Added €1\.00 to Groceries\. €60\.00 left of €400\.00\. .+: 85% used\.$/,
    );
  });

  it('says only what was added when the budget is not in the month view', () => {
    expect(addedConfirmation({ budgetId: 9, amount: 300 }, undefined, money)).toBe(
      'Added €3.00 to the budget.',
    );
  });
});
