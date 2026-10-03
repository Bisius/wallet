/**
 * The operations of the transfers fuzz (`transfers-fuzz.ts`), as plain data, and the arbitraries
 * that generate them.
 *
 * An operation never names an id, a month or an amount that depends on the state. It says "the
 * 2nd budget active in a closed month", "all that the source holds", "a month that was settled",
 * "the transfer before last", and it is resolved against the model when it runs. So any subsequence
 * of a failing sequence is still a meaningful sequence, which is what lets fast-check shrink one to
 * a few operations.
 *
 * Faults are chosen independently (an unknown budget AND a date before the start month AND a budget
 * that is not active), so many refused requests break several rules at once: the model then has to
 * predict WHICH rule docs/DOMAIN.md and the shared contract report first.
 */
import * as fc from 'fast-check';

/** Where in time a fact is dated, relative to today and to the settlements made so far. */
export type WhenKind =
  /** A month between the start month and the month before the current one (the current one if none). */
  | 'closed'
  | 'current'
  /** One to three months after the current one. */
  | 'future'
  | 'start'
  /** A month that has settlement rows (a closed one if none has). */
  | 'settled'
  /** One before, on or one after the first or the last month of a budget (where the rules change). */
  | 'edge';
export interface When {
  k: WhenKind;
  i: number;
}

/** Cents a fixed amount is drawn from: from one cent to a few hundred euros. */
export const AMOUNTS = [1, 7, 100, 250, 1234, 5000, 12345, 30000, 99999, 250000];

export type AmountSel =
  | { k: 'fixed'; v: number }
  /** Exactly what the source holds in the month (1 when it holds nothing). */
  | { k: 'all' }
  /** One cent more than the source holds: the transfer is over it, which is allowed. */
  | { k: 'over' }
  | { k: 'half' };

export type TransferKind =
  /** Between two budgets that are both active in the month. */
  | 'bb'
  /** Between two budgets that are active in the month and in different modes (when there are). */
  | 'bbCross'
  | 'pb'
  | 'bp';

/** What is wrong with the shape of a transfer request (the 400s); `ok` is nothing. */
export type Shape =
  | 'ok'
  | 'bothPool'
  | 'same'
  | 'zero'
  | 'negative'
  | 'omitFrom'
  | 'omitTo'
  | 'badDate'
  /** A fraction of a cent. */
  | 'fraction'
  /** The amount written as text. */
  | 'textAmount'
  /** A budget id written as text. */
  | 'textId'
  /** A field the contract does not have. */
  | 'extra'
  /** A note one character over the limit. */
  | 'longNote';

/** The body asks for a note: absent, text with padding, only blanks, or null. */
export type NoteSel = 'absent' | 'text' | 'blank' | 'null';

export interface TransferFields {
  kind: TransferKind;
  a: number;
  b: number;
  when: When;
  day: number | 'last';
  amount: AmountSel;
  shape: Shape;
  /** The 422 faults, independent of each other. */
  unknownFrom: boolean;
  unknownTo: boolean;
  /** Both sides are budgets that do not exist: the doc names the one reported first. */
  unknownBoth: boolean;
  beforeStart: boolean;
  /** One budget it names is not active in the month of the date. */
  outside: boolean;
  /** Both budgets it names are not active in the month of the date (when there is such a month). */
  outsideBoth: boolean;
  note: NoteSel;
}

export type EndSel =
  /** The body is empty: the end month is the current month. */
  | 'default'
  | 'current'
  | 'beforeActivity'
  | 'atActivity'
  | 'beforeStart'
  | 'start'
  | 'later'
  | 'closed';

export type StartSel =
  'earlier' | 'later' | 'atActivity' | 'pastActivity' | 'beforeStart' | 'pastEnd';

export type Op =
  | { t: 'advance'; mode: 'days' | 'monthStart' | 'monthEnd' | 'months'; n: number }
  | ({ t: 'transfer' } & TransferFields)
  | { t: 'transferDelete'; k: 'newest' | 'oldest' | 'any' | 'unknown' | 'gone'; i: number }
  /** Creates something and deletes it again at once; nothing may have changed. */
  | {
      t: 'roundTrip';
      what: 'transfer' | 'spending' | 'income';
      transfer: TransferFields;
      r: number;
    }
  | {
      t: 'spending';
      budget: number;
      when: When;
      day: number | 'last';
      amount: number;
      refund: boolean;
      unknownBudget: boolean;
      beforeStart: boolean;
      outside: boolean;
    }
  | { t: 'spendingDelete'; i: number }
  | { t: 'income'; when: When; day: number | 'last'; amount: number; beforeStart: boolean }
  | { t: 'incomeDelete'; i: number }
  | { t: 'salary'; when: When; amount: number }
  | { t: 'budgetCreate'; when: When; amount: number; incremental: boolean }
  | { t: 'budgetVersion'; budget: number; when: When; amount: number; incremental: boolean }
  | { t: 'budgetArchive'; budget: number; end: EndSel; i: number }
  | { t: 'budgetStart'; budget: number; start: StartSel; i: number }
  | { t: 'budgetDelete'; budget: number }
  /** The requests on either side of the edges of the months of a budget that has activity. */
  | { t: 'edgeProbe'; budget: number }
  /** Archives a budget, dates a transfer that names it in its last month, and one in the month after. */
  | { t: 'finalMonth'; budget: number; later: boolean; i: number; transfer: TransferFields }
  /**
   * Makes two budgets that begin after today and sends the requests that break the same rule on
   * both sides, on either side, or several rules at once: the doc names the side of each.
   */
  | { t: 'sideProbe'; i: number; j: number; day: number | 'last'; incremental: boolean }
  | {
      t: 'settle';
      month: 'out' | 'adjust' | 'settled' | 'current';
      mi: number;
      amount: 'exact' | 'stale' | 'off';
      delta: number;
    }
  | { t: 'undo'; mode: 'rows' | 'out' | 'adjust' | 'current'; mi: number }
  /** Settles a month, dates a transfer in it, settles the adjustment, deletes it, settles that (and undoes it all). */
  | { t: 'lateTransfer'; mi: number; transfer: TransferFields; undoAfter: boolean }
  | { t: 'moveStart'; delta: number };

// -------------------------------------------------------------------------------------------------
// Arbitraries
// -------------------------------------------------------------------------------------------------

const nat = (max: number) => fc.nat(max);
const when: fc.Arbitrary<When> = fc.record({
  k: fc.constantFrom<WhenKind>(
    'closed',
    'closed',
    'closed',
    'current',
    'current',
    'future',
    'future',
    'start',
    'settled',
    'settled',
    'edge',
  ),
  i: nat(99),
});
const amountSel: fc.Arbitrary<AmountSel> = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...AMOUNTS).map((v): AmountSel => ({ k: 'fixed', v })) },
  { weight: 2, arbitrary: fc.constant<AmountSel>({ k: 'all' }) },
  { weight: 2, arbitrary: fc.constant<AmountSel>({ k: 'over' }) },
  { weight: 1, arbitrary: fc.constant<AmountSel>({ k: 'half' }) },
);
/** A fault is rare: about one request in twelve has each. */
const rare = fc.constantFrom(
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  true,
);

const transferFields: fc.Arbitrary<TransferFields> = fc.record({
  kind: fc.constantFrom<TransferKind>('bb', 'bb', 'bbCross', 'bbCross', 'pb', 'pb', 'bp', 'bp'),
  a: nat(99),
  b: nat(99),
  when,
  // Few days, so that several transfers share a date, and sometimes all but the amount.
  day: fc.constantFrom<number | 'last'>(1, 15, 15, 28, 'last'),
  amount: amountSel,
  shape: fc.constantFrom<Shape>(
    ...Array<Shape>(20).fill('ok'),
    'bothPool',
    'same',
    'zero',
    'negative',
    'omitFrom',
    'omitTo',
    'badDate',
    'fraction',
    'textAmount',
    'textId',
    'extra',
    'longNote',
  ),
  unknownFrom: rare,
  unknownTo: rare,
  unknownBoth: fc.constantFrom(false, false, false, false, false, false, false, false, false, true),
  beforeStart: fc.constantFrom(false, false, false, false, false, false, false, true),
  outside: fc.constantFrom(false, false, false, false, true),
  outsideBoth: fc.constantFrom(false, false, false, false, false, false, false, false, true),
  note: fc.constantFrom<NoteSel>('absent', 'absent', 'absent', 'text', 'blank', 'null'),
});

/** The faults taken out: a request meant to be accepted. */
export const cleanTransfer = (fields: TransferFields): TransferFields => ({
  ...fields,
  shape: 'ok',
  unknownFrom: false,
  unknownTo: false,
  unknownBoth: false,
  beforeStart: false,
  outside: false,
  outsideBoth: false,
});

const arbitraries: { [T in Op['t']]: fc.Arbitrary<Extract<Op, { t: T }>> } = {
  advance: fc.record({
    t: fc.constant('advance' as const),
    mode: fc.constantFrom('days', 'days', 'monthStart', 'monthEnd', 'months'),
    n: fc.integer({ min: 1, max: 20 }),
  }),
  transfer: transferFields.map((fields) => ({ t: 'transfer' as const, ...fields })),
  transferDelete: fc.record({
    t: fc.constant('transferDelete' as const),
    k: fc.constantFrom('newest', 'oldest', 'any', 'any', 'any', 'unknown', 'gone'),
    i: nat(99),
  }),
  roundTrip: fc.record({
    t: fc.constant('roundTrip' as const),
    what: fc.constantFrom('transfer', 'spending', 'income'),
    transfer: transferFields.map(cleanTransfer),
    r: nat(99),
  }),
  spending: fc.record({
    t: fc.constant('spending' as const),
    budget: nat(99),
    when,
    day: fc.constantFrom<number | 'last'>(1, 5, 10, 15, 20, 28, 'last'),
    amount: fc.constantFrom(...AMOUNTS),
    refund: fc.constantFrom(false, false, false, true),
    unknownBudget: rare,
    beforeStart: rare,
    outside: rare,
  }),
  spendingDelete: fc.record({ t: fc.constant('spendingDelete' as const), i: nat(99) }),
  income: fc.record({
    t: fc.constant('income' as const),
    when,
    day: fc.constantFrom<number | 'last'>(1, 5, 10, 15, 20, 28, 'last'),
    amount: fc.constantFrom(...AMOUNTS),
    beforeStart: rare,
  }),
  incomeDelete: fc.record({ t: fc.constant('incomeDelete' as const), i: nat(99) }),
  salary: fc.record({
    t: fc.constant('salary' as const),
    when,
    amount: fc.constantFrom(0, 100000, 250000, 333333, 400000),
  }),
  budgetCreate: fc.record({
    t: fc.constant('budgetCreate' as const),
    when,
    amount: fc.constantFrom(0, 12345, 30000, 45000, 99999),
    incremental: fc.boolean(),
  }),
  budgetVersion: fc.record({
    t: fc.constant('budgetVersion' as const),
    budget: nat(99),
    when,
    amount: fc.constantFrom(0, 12345, 30000, 45000, 99999),
    incremental: fc.boolean(),
  }),
  budgetArchive: fc.record({
    t: fc.constant('budgetArchive' as const),
    budget: nat(99),
    end: fc.constantFrom<EndSel>(
      'default',
      'default',
      'current',
      'beforeActivity',
      'atActivity',
      'atActivity',
      'beforeStart',
      'start',
      'later',
      'later',
      'later',
      'closed',
    ),
    i: nat(99),
  }),
  budgetStart: fc.record({
    t: fc.constant('budgetStart' as const),
    budget: nat(99),
    start: fc.constantFrom<StartSel>(
      'earlier',
      'earlier',
      'later',
      'atActivity',
      'atActivity',
      'atActivity',
      'pastActivity',
      'pastActivity',
      'beforeStart',
      'pastEnd',
    ),
    i: nat(99),
  }),
  budgetDelete: fc.record({ t: fc.constant('budgetDelete' as const), budget: nat(99) }),
  edgeProbe: fc.record({ t: fc.constant('edgeProbe' as const), budget: nat(99) }),
  finalMonth: fc.record({
    t: fc.constant('finalMonth' as const),
    budget: nat(99),
    later: fc.boolean(),
    i: nat(99),
    transfer: transferFields,
  }),
  sideProbe: fc.record({
    t: fc.constant('sideProbe' as const),
    i: nat(99),
    j: nat(99),
    day: fc.constantFrom<number | 'last'>(1, 15, 28, 'last'),
    incremental: fc.boolean(),
  }),
  settle: fc.record({
    t: fc.constant('settle' as const),
    month: fc.constantFrom('out', 'out', 'out', 'out', 'adjust', 'adjust', 'settled', 'current'),
    mi: nat(99),
    amount: fc.constantFrom('exact', 'exact', 'stale', 'off'),
    delta: fc.integer({ min: 1, max: 500 }),
  }),
  undo: fc.record({
    t: fc.constant('undo' as const),
    mode: fc.constantFrom('rows', 'rows', 'rows', 'adjust', 'out', 'current'),
    mi: nat(99),
  }),
  lateTransfer: fc.record({
    t: fc.constant('lateTransfer' as const),
    mi: nat(99),
    transfer: transferFields,
    undoAfter: fc.boolean(),
  }),
  moveStart: fc.record({
    t: fc.constant('moveStart' as const),
    delta: fc.integer({ min: -6, max: 3 }),
  }),
};

/** How often each operation is drawn: transfers, and what they interact with, most often. */
const WEIGHTS: Record<Op['t'], number> = {
  advance: 10,
  transfer: 22,
  transferDelete: 8,
  roundTrip: 10,
  spending: 8,
  spendingDelete: 2,
  income: 2,
  incomeDelete: 1,
  salary: 2,
  budgetCreate: 4,
  budgetVersion: 5,
  budgetArchive: 7,
  budgetStart: 7,
  budgetDelete: 5,
  edgeProbe: 5,
  finalMonth: 4,
  sideProbe: 4,
  settle: 10,
  undo: 6,
  lateTransfer: 8,
  moveStart: 5,
};

export const opArb: fc.Arbitrary<Op> = fc.oneof(
  ...(Object.keys(arbitraries) as Op['t'][]).map((t) => ({
    weight: WEIGHTS[t],
    arbitrary: arbitraries[t] as fc.Arbitrary<Op>,
  })),
);

/**
 * Operations that only add activity (transfers and spendings that the rules accept), to start a run
 * with something for the rules about a budget's months, and for the savings, to count.
 */
export const seedArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: transferFields.map((fields): Op => ({ t: 'transfer', ...cleanTransfer(fields) })),
  },
  {
    weight: 2,
    arbitrary: arbitraries.spending.map((op): Op => ({
      ...op,
      unknownBudget: false,
      beforeStart: false,
      outside: false,
    })),
  },
);

// -------------------------------------------------------------------------------------------------
// The world a run starts from
// -------------------------------------------------------------------------------------------------

/** Some closed months, two or three budgets, a monthly and a yearly subscription. */
export interface Setup {
  /** The start month is 2025-06 plus this many months. */
  startOffset: number;
  /** Closed months at the start (the clock is in the month after them). */
  closed: number;
  day: number;
  salary: number;
  opening: number;
  budgets: { amount: number; incremental: boolean }[];
  monthlySub: number;
  yearlySub: number;
  yearlyMonth: number;
}

export const setupArb: fc.Arbitrary<Setup> = fc.record({
  startOffset: fc.integer({ min: 0, max: 11 }),
  closed: fc.integer({ min: 2, max: 4 }),
  day: fc.integer({ min: 1, max: 28 }),
  salary: fc.constantFrom(200000, 250000, 333333, 400000),
  opening: fc.constantFrom(0, 10000, 123456),
  budgets: fc.array(
    fc.record({
      amount: fc.constantFrom(12345, 30000, 45000, 60000, 99999),
      incremental: fc.boolean(),
    }),
    { minLength: 2, maxLength: 3 },
  ),
  monthlySub: fc.constantFrom(999, 1299, 4999),
  yearlySub: fc.constantFrom(12000, 12345, 99999),
  yearlyMonth: fc.integer({ min: 1, max: 12 }),
});
