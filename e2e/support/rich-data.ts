import type { APIRequestContext } from '@playwright/test';
import {
  type BudgetDto,
  type GoalDto,
  MAX_CENTS,
  type SubscriptionDto,
  type TagDto,
  type Theme,
} from '@wallet/shared';
import { json } from './api';
import {
  addIncome,
  addSpending,
  addTransfer,
  createBudget,
  createGoal,
  createSubscription,
  getSavings,
  onboard,
  setSalary,
  settleMonth,
} from './seed';

/*
 * The datasets that the accessibility and phone specs look at, written through the real HTTP API.
 *
 * The harness clock stands at 2026-03-10 (a Tuesday), the wallet starts in January, so January and
 * February are closed months and March is the current one.
 *
 *   empty         a freshly onboarded wallet: a salary and nothing else, every page shows its empty state
 *   rich          every page has content, and every status that a page can show is there at least once
 *   long-text     `rich` plus the longest text a user can type, with nothing to break at: 60 character
 *                 names of a budget, a subscription and a goal, a 200 character description, a 1000
 *                 character note, ten 30 character tags on one spending
 *   big-amounts   `rich` plus amounts at the most the API takes (10 billion, `MAX_CENTS`): the salary, a
 *                 budget, a yearly subscription, a goal, an income, a spending, a transfer, and a budget
 *                 that is over by about that much
 *
 * What `rich` holds (March 2026 is the month on screen):
 *   budgets       Groceries (not incremental, over budget), Fun (incremental, past its warning
 *                 threshold), Transport (not incremental, fine), Health (incremental, with an icon),
 *                 Holidays; Old gym (archived with history, so only archived), Unused (archived, no
 *                 history, so it can be deleted), Summer trip (starts in May: upcoming)
 *   subscriptions a monthly one with a price change, one renewing on the 25th, a yearly one renewing on
 *                 the 28th of March (inside the 30 days of "upcoming renewals"), a yearly one that
 *                 reserves money towards November, a cancelled one and one that starts in May
 *   money         a salary raise from March, one-off incomes, a transfer from the unallocated pool and
 *                 one between budgets, refunds, and enough spendings that "all months" needs a second
 *                 page
 *   savings       goals that are active, reached, overdue and archived, deposits, January settled and
 *                 then corrected by a late spending (so it is back in the inbox as a correction), and
 *                 February outstanding
 *   tags          Weekend, Work, Kids and a few more
 */

export type Dataset = 'empty' | 'rich' | 'long-text' | 'big-amounts';

/** Names that the specs click on. They are the user-visible names of what the seed created. */
export const NAMES = {
  budgets: {
    over: 'Groceries',
    warning: 'Fun',
    fine: 'Transport',
    icon: 'Health',
    archivedWithHistory: 'Old gym',
    deletable: 'Unused',
    upcoming: 'Summer trip',
  },
  subscriptions: {
    monthly: 'Netflix',
    renewsSoon: 'Gym membership',
    yearlySoon: 'Domain name',
    yearlyLater: 'Home insurance',
    cancelled: 'Old streaming',
    upcoming: 'Gadget club',
  },
  goals: {
    active: 'Holiday in Japan',
    reached: 'New laptop',
    overdue: 'Old camera',
    archived: 'Retired plan',
    open: 'Emergency fund',
  },
  incomes: { gift: 'Birthday gift', refund: 'Tax refund' },
  /** The saved import profile of the rich datasets, made for the bank file of `support/pages.ts`. */
  importProfile: 'Fineco',
  tags: { weekend: 'Weekend', work: 'Work', kids: 'Kids' },
  /** The spending with a very long description and the tags. */
  longSpending: 'Quarterly',
  /** A spending whose description matches a row of the CSV that the import specs use. */
  duplicateOfCsv: 'Esselunga Milano',
} as const;

/** Text with nothing to break at: the worst case for a layout that has to wrap it. */
export function unbroken(length: number, seed = 'Unbroken'): string {
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
}

/** A sentence of the given length with ordinary word breaks. */
function sentence(length: number): string {
  const words = 'Quarterly shopping for the whole family including household supplies and ';
  return words
    .repeat(Math.ceil(length / words.length))
    .slice(0, length)
    .trim();
}

/** The most the API takes in one amount: 10 billion in cents (`MAX_CENTS` of `@wallet/shared`). */
export const MAX = MAX_CENTS;

export interface SeedOptions {
  dataset: Dataset;
  /** Saved in the settings, which is what the app applies. `system` is what a new wallet gets. */
  theme: Theme;
}

export interface Seeded {
  budgets: Record<string, BudgetDto>;
  subscriptions: Record<string, SubscriptionDto>;
  goals: Record<string, GoalDto>;
  tags: Record<string, TagDto>;
}

async function createTag(api: APIRequestContext, name: string, color?: string): Promise<TagDto> {
  return json(await api.post('/api/tags', { data: { name, ...(color && { color }) } }));
}

async function archiveBudget(
  api: APIRequestContext,
  budget: BudgetDto,
  endMonth: string,
): Promise<BudgetDto> {
  return json(await api.post(`/api/budgets/${budget.id}/archive`, { data: { endMonth } }));
}

async function cancelSubscription(
  api: APIRequestContext,
  subscription: SubscriptionDto,
  endMonth: string,
): Promise<SubscriptionDto> {
  return json(
    await api.post(`/api/subscriptions/${subscription.id}/cancel`, { data: { endMonth } }),
  );
}

async function deposit(
  api: APIRequestContext,
  goal: GoalDto | null,
  amount: number,
  note: string,
): Promise<void> {
  await json(
    await api.post('/api/savings/transactions', {
      data: { kind: 'deposit', amount, date: '2026-03-02', note, goalId: goal?.id ?? null },
    }),
  );
}

/**
 * Puts a server (at the harness's default clock, 2026-03-10) into one of the datasets. Everything goes
 * through the API, as a user's own data would.
 */
export async function seedWallet(api: APIRequestContext, options: SeedOptions): Promise<Seeded> {
  const { dataset, theme } = options;
  const seeded: Seeded = { budgets: {}, subscriptions: {}, goals: {}, tags: {} };

  if (dataset === 'empty') {
    await onboard(api, { startMonth: '2026-03', salary: 250000, theme });
    return seeded;
  }
  // The two kinds of worst case, apart, so that a failing page says which one it cannot take.
  const longText = dataset === 'long-text';
  const bigAmounts = dataset === 'big-amounts';
  const stress = longText || bigAmounts;
  /** A name: the longest the API takes without a break in it, or an ordinary one. */
  const name = (long: string, ordinary: string) => (longText ? unbroken(60, long) : ordinary);
  /** An amount: the largest the API takes, or an ordinary one. */
  const amount = (ordinary: number) => (bigAmounts ? MAX : ordinary);

  await onboard(api, { startMonth: '2026-01', salary: 320000, openingSavings: 120000, theme });
  // A raise from March, so the salary history has two rows.
  await setSalary(api, '2026-03', amount(340000));

  // --- tags
  const tag = async (key: string, name: string, color?: string) => {
    seeded.tags[key] = await createTag(api, name, color);
    return seeded.tags[key];
  };
  const weekend = await tag('weekend', NAMES.tags.weekend, '#2a78d6');
  const work = await tag('work', NAMES.tags.work, '#047857');
  const kids = await tag('kids', NAMES.tags.kids, '#b91c1c');

  // --- budgets, all from January so that January and February are real closed months
  const budget = async (key: string, input: Parameters<typeof createBudget>[1]) => {
    seeded.budgets[key] = await createBudget(api, { startMonth: '2026-01', ...input });
    return seeded.budgets[key];
  };
  const groceries = await budget('over', {
    name: NAMES.budgets.over,
    amount: 40000,
    incremental: false,
    color: '#2a78d6',
    notes: longText ? unbroken(1000, 'LongNotes') : 'Food and household supplies for the family.',
  });
  const fun = await budget('warning', {
    name: NAMES.budgets.warning,
    amount: 15000,
    incremental: true,
    color: '#eb6834',
  });
  const transport = await budget('fine', {
    name: NAMES.budgets.fine,
    amount: 20000,
    incremental: false,
    color: '#17a173',
  });
  await budget('icon', {
    name: NAMES.budgets.icon,
    amount: 10000,
    incremental: true,
    icon: '💊',
    alertWarnPercent: 60,
  });
  await budget('holidays', { name: 'Holidays', amount: 8000, incremental: true });
  const oldGym = await budget('archivedWithHistory', {
    name: NAMES.budgets.archivedWithHistory,
    amount: 5000,
    incremental: false,
  });
  const unused = await budget('deletable', {
    name: NAMES.budgets.deletable,
    amount: 3000,
    incremental: false,
  });
  await createBudget(api, {
    name: NAMES.budgets.upcoming,
    amount: 30000,
    incremental: true,
    startMonth: '2026-05',
  }).then((created) => {
    seeded.budgets['upcoming'] = created;
  });
  // A spending first (so Old gym has a history), then the archiving.
  await addSpending(api, {
    date: '2026-01-12',
    amount: 4500,
    budgetId: oldGym.id,
    description: 'Gym month',
  });
  seeded.budgets['archivedWithHistory'] = await archiveBudget(api, oldGym, '2026-02');
  seeded.budgets['deletable'] = await archiveBudget(api, unused, '2026-02');

  let longBudget: BudgetDto | undefined;
  if (stress) {
    // From March only: January and February are closed and must stay within what a settlement can
    // carry (an amount of at most `MAX`). Not incremental, so the figure does not pile up month after
    // month in the projections.
    longBudget = await budget('long', {
      name: name('AVeryLongBudgetName', 'Everything else'),
      amount: amount(50000),
      incremental: false,
      icon: '🏔️',
      startMonth: '2026-03',
    });
  }

  // --- subscriptions
  const sub = async (key: string, input: Parameters<typeof createSubscription>[1]) => {
    seeded.subscriptions[key] = await createSubscription(api, { startMonth: '2026-01', ...input });
    return seeded.subscriptions[key];
  };
  const netflix = await sub('monthly', {
    name: NAMES.subscriptions.monthly,
    frequency: 'monthly',
    anchorDate: '2026-01-15',
    amount: 1299,
    color: '#b91c1c',
  });
  // A price change from March: the card shows the history.
  await json(
    await api.put(`/api/subscriptions/${netflix.id}/prices/2026-03`, { data: { amount: 1499 } }),
  );
  await sub('renewsSoon', {
    name: NAMES.subscriptions.renewsSoon,
    frequency: 'monthly',
    anchorDate: '2026-01-25',
    amount: 3500,
    notes: 'Cancel with one month notice.',
  });
  await sub('yearlySoon', {
    name: NAMES.subscriptions.yearlySoon,
    frequency: 'yearly',
    anchorDate: '2026-03-28',
    amount: 1500,
  });
  await sub('yearlyLater', {
    name: NAMES.subscriptions.yearlyLater,
    frequency: 'yearly',
    anchorDate: '2026-11-02',
    amount: 48000,
    color: '#2a78d6',
  });
  const oldStreaming = await sub('cancelled', {
    name: NAMES.subscriptions.cancelled,
    frequency: 'monthly',
    anchorDate: '2026-01-05',
    amount: 999,
  });
  seeded.subscriptions['cancelled'] = await cancelSubscription(api, oldStreaming, '2026-02');
  await createSubscription(api, {
    name: NAMES.subscriptions.upcoming,
    frequency: 'monthly',
    anchorDate: '2026-05-10',
    amount: 2500,
    startMonth: '2026-05',
  }).then((created) => {
    seeded.subscriptions['upcoming'] = created;
  });
  if (stress) {
    await sub('long', {
      name: name('AnnualMembershipOfTheInternationalAssociation', 'Association'),
      frequency: 'yearly',
      anchorDate: '2026-03-30',
      amount: amount(12000),
      notes: longText ? unbroken(1000, 'LongNotes') : 'Paid in March.',
      startMonth: '2026-03',
    });
  }

  // --- incomes
  await addIncome(api, { date: '2026-02-14', amount: 8000, description: 'Sold the old bike' });
  await addIncome(api, { date: '2026-03-05', amount: 5000, description: NAMES.incomes.gift });
  await addIncome(api, { date: '2026-03-08', amount: 12000, description: NAMES.incomes.refund });
  if (stress) {
    await addIncome(api, {
      date: '2026-03-09',
      amount: amount(30000),
      description: longText ? unbroken(200, 'Bonus') : 'Windfall',
    });
  }

  // --- spendings: January and February first (closed), so Fun is spent out and carries nothing
  const day = (month: string, n: number) => `${month}-${String(n).padStart(2, '0')}`;
  for (const month of ['2026-01', '2026-02']) {
    await addSpending(api, {
      date: day(month, 3),
      amount: 15000,
      budgetId: fun.id,
      description: 'Concert',
    });
    await addSpending(api, {
      date: day(month, 6),
      amount: 8200,
      budgetId: groceries.id,
      description: 'Weekly shop',
    });
    await addSpending(api, {
      date: day(month, 9),
      amount: 3000,
      budgetId: transport.id,
      description: 'Train pass',
    });
    for (let n = 0; n < 18; n += 1) {
      await addSpending(api, {
        date: day(month, 10 + (n % 15)),
        amount: 350 + n * 10,
        budgetId: groceries.id,
        description: `Coffee and snacks ${n + 1}`,
      });
    }
  }
  // January is settled below. March is the current month.
  await addSpending(api, {
    date: '2026-03-05',
    amount: 4520,
    budgetId: groceries.id,
    description: NAMES.duplicateOfCsv,
    tagIds: [weekend.id],
  });
  await addSpending(api, {
    date: '2026-03-06',
    amount: 15000,
    budgetId: fun.id,
    description: 'Theatre tickets',
    tagIds: [weekend.id, kids.id],
  });
  await addSpending(api, {
    date: '2026-03-07',
    amount: 18500,
    budgetId: groceries.id,
    description: 'Market and bakery',
    tagIds: [kids.id],
  });
  await addSpending(api, {
    date: '2026-03-08',
    amount: 6000,
    budgetId: groceries.id,
    description: 'Fish shop',
  });
  await addSpending(api, {
    date: '2026-03-08',
    amount: 5000,
    budgetId: transport.id,
    description: 'Fuel',
    tagIds: [work.id],
  });
  await addSpending(api, {
    date: '2026-03-09',
    amount: 16000,
    budgetId: groceries.id,
    description: sentence(200),
    tagIds: [weekend.id, work.id],
  });
  await addSpending(api, {
    date: '2026-03-09',
    amount: -2500,
    budgetId: groceries.id,
    description: 'Returned blender',
  });
  for (let n = 0; n < 22; n += 1) {
    await addSpending(api, {
      date: day('2026-03', 1 + (n % 9)),
      amount: 300 + n * 15,
      budgetId: n % 3 === 0 ? transport.id : groceries.id,
      description: `Daily coffee ${n + 1}`,
    });
  }

  if (stress && longBudget) {
    // Ten tags on one spending, the most it may carry.
    const many = await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        createTag(
          api,
          longText ? unbroken(30, `TagNumber${n + 1}-`) : `Tag ${n + 1}`,
          n % 2 ? '#2a78d6' : '#b91c1c',
        ),
      ),
    );
    await addSpending(api, {
      date: '2026-03-10',
      amount: bigAmounts ? MAX - 100 : 12345,
      budgetId: longBudget.id,
      description: longText ? unbroken(200, 'Supermarket-') : 'Everything at the market',
      notes: longText ? unbroken(1000, 'LongNotes') : 'A note.',
      tagIds: many.map((created) => created.id),
    });
    if (bigAmounts) {
      // Over a budget by about the largest amount: a long negative figure.
      await addSpending(api, {
        date: '2026-03-10',
        amount: MAX,
        budgetId: transport.id,
        description: 'Car',
      });
    }
    await addTransfer(api, {
      date: '2026-03-10',
      fromBudgetId: longBudget.id,
      toBudgetId: transport.id,
      amount: bigAmounts ? MAX / 2 : 5000,
      note: longText ? unbroken(200, 'Note') : 'Topping up',
    });
  }

  // --- transfers
  await addTransfer(api, {
    date: '2026-03-06',
    fromBudgetId: null,
    toBudgetId: fun.id,
    amount: 2500,
    note: 'Concert tickets',
  });
  await addTransfer(api, {
    date: '2026-03-07',
    fromBudgetId: groceries.id,
    toBudgetId: transport.id,
    amount: 1000,
    note: 'Fuel is dearer',
  });

  // --- a saved import profile, for the bank file of `support/pages.ts` (BANK_CSV)
  await json(
    await api.post('/api/import/profiles', {
      data: {
        name: NAMES.importProfile,
        header: ['Date', 'Description', 'Amount'],
        mapping: {
          delimiter: ';',
          hasHeader: true,
          dateColumn: 0,
          descriptionColumn: 1,
          amountColumn: 2,
          dateFormat: 'DD/MM/YYYY',
          decimalSeparator: ',',
          signConvention: 'expenses_negative',
        },
      },
    }),
  );

  // --- savings: goals, deposits, a settled month with a correction, an outstanding month
  const goal = async (key: string, input: Parameters<typeof createGoal>[1]) => {
    seeded.goals[key] = await createGoal(api, input);
    return seeded.goals[key];
  };
  const japan = await goal('active', {
    name: NAMES.goals.active,
    targetAmount: 300000,
    deadline: '2026-12-31',
    color: '#2a78d6',
  });
  await goal('open', { name: NAMES.goals.open, targetAmount: 500000 });
  const laptop = await goal('reached', { name: NAMES.goals.reached, targetAmount: 10000 });
  await goal('overdue', { name: NAMES.goals.overdue, targetAmount: 60000, deadline: '2026-01-31' });
  const retired = await goal('archived', { name: NAMES.goals.archived, targetAmount: 20000 });
  if (stress) {
    await goal('long', {
      name: name('AGoalWithAnExtremelyLongName', 'Big purchase'),
      targetAmount: amount(250000),
    });
  }
  await deposit(api, japan, 45000, 'Birthday money');
  await deposit(api, laptop, 10000, 'Saved up');
  await deposit(api, retired, 5000, 'Kept');
  await deposit(api, null, 7500, 'Loose change');
  seeded.goals['archived'] = await json(
    await api.patch(`/api/goals/${retired.id}`, { data: { archived: true } }),
  );

  // January is settled, then a late spending dated in it changes what it was due: a correction.
  await settleMonth(api, '2026-01');
  await addSpending(api, {
    date: '2026-01-28',
    amount: 2750,
    budgetId: groceries.id,
    description: 'Forgotten receipt',
  });
  // February stays outstanding.
  const { outstanding } = await getSavings(api);
  if (outstanding.length < 2) {
    throw new Error(
      `The seed expected January (a correction) and February to be outstanding, got ${JSON.stringify(outstanding)}`,
    );
  }
  return seeded;
}
