/**
 * The operations of the savings fuzz (`savings-fuzz.ts`), as plain data, and the pure functions that
 * turn one into a concrete request against the state of the model.
 *
 * An operation never names an id or an amount that depends on the state. It says "the 2nd active
 * goal", "the whole balance of the source", "the month with the 3rd outstanding amount", "the figure
 * the user saw earlier", and it is resolved when it runs. So any subsequence of a failing sequence
 * is still a meaningful sequence, which is what lets fast-check shrink one to a few operations.
 *
 * The faults are chosen independently (a wrong date AND an unknown goal AND too much money), so a
 * large share of the refused requests break several rules at once: the model then has to predict
 * WHICH of them the doc says is reported first.
 */
import * as fc from 'fast-check';
import { monthIndex, monthKey } from './prop-model';
import {
  type ManualBody,
  type SettleBody,
  type World,
  currentMonthOf,
  dueByMonth,
  outstandingList,
  outstandingOf,
} from './savings-model';

// -------------------------------------------------------------------------------------------------
// Calendar, in plain UTC arithmetic (the fuzz runs with TZ=UTC)
// -------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const epochDay = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
export const addDays = (date: string, days: number): string =>
  new Date((epochDay(date) + days) * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string): number => epochDay(to) - epochDay(from);
export const firstDay = (month: string): string => `${month}-01`;
export const isMonthKey = (value: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

// -------------------------------------------------------------------------------------------------
// Operations
// -------------------------------------------------------------------------------------------------

/** Where money goes or comes from: 0 unassigned, 1 any goal, 2 an active goal, 3 an archived goal, 4 a goal that does not exist. */
export interface GoalSel {
  k: 0 | 1 | 2 | 3 | 4;
  i: number;
}

export type AmountSel = { k: 'fixed'; v: number } | { k: 'all' | 'over' | 'half' };
export type DateSel = 'omit' | 'today' | 'start' | 'rand' | 'beforeStart' | 'tomorrow';
export type NoteSel = null | undefined | string;
export type SettleMonthSel =
  | 'out'
  | 'adjust'
  | 'settled'
  | 'current'
  | 'future'
  | 'beforeStart'
  | 'atHorizon'
  | 'beyondHorizon'
  | 'malformed';

export type Op =
  | { t: 'advance'; mode: 'days' | 'tens' | 'monthEnd' | 'monthStart' | 'months'; n: number }
  | {
      t: 'goalCreate';
      target: number;
      deadline: 'none' | 'past' | 'soon' | 'far';
      r: number;
      color: boolean;
      padded: boolean;
    }
  | {
      t: 'goalPatch';
      goal: GoalSel;
      target: number | null;
      deadline: 'keep' | 'clear' | 'past' | 'soon' | 'far';
      r: number;
      archived: 'keep' | 'archive' | 'unarchive';
      rename: boolean;
    }
  | { t: 'goalDelete'; goal: GoalSel }
  | {
      t: 'deposit';
      goal: GoalSel;
      amount: number;
      date: DateSel;
      r: number;
      note: NoteSel;
      bad: boolean;
      clean: boolean;
    }
  | {
      t: 'withdraw';
      goal: GoalSel;
      amount: AmountSel;
      date: DateSel;
      r: number;
      note: NoteSel;
      clean: boolean;
    }
  | {
      t: 'reallocate';
      from: GoalSel;
      to: GoalSel;
      amount: AmountSel;
      date: DateSel;
      r: number;
      note: NoteSel;
      clean: boolean;
    }
  | {
      t: 'settle';
      month: SettleMonthSel;
      mi: number;
      amount: 'exact' | 'stale' | 'plus' | 'minus' | 'negated' | 'zero';
      delta: number;
      split: 'none' | 'one' | 'two' | 'three' | 'empty' | 'dupe' | 'badGoals';
      goals: GoalSel[];
      weights: number[];
      fault: 'none' | 'sum' | 'sign' | 'both' | 'zero';
    }
  | { t: 'undo'; mode: 'out' | 'adjust' | 'settled' | 'none'; mi: number }
  | { t: 'roundTrip'; mi: number; withGoal: boolean }
  | { t: 'netZero'; mi: number }
  | {
      t: 'deleteRow';
      k: 'plain' | 'pair' | 'settlement' | 'opening' | 'unknown' | 'gone';
      i: number;
    }
  | {
      t: 'lateSpending';
      budget: number;
      target: 'any' | 'settled';
      mi: number;
      day: number;
      amount: number;
      refund: boolean;
    }
  | { t: 'lateIncome'; target: 'any' | 'settled'; mi: number; day: number; amount: number }
  | { t: 'revert' }
  | { t: 'salaryPut'; mi: number; amount: number }
  | { t: 'salaryDelete'; i: number }
  | { t: 'opening'; amount: number }
  | { t: 'moveStart'; delta: number };

// -------------------------------------------------------------------------------------------------
// Arbitraries
// -------------------------------------------------------------------------------------------------

/** What a deposit may put in: small, round, and the sums that trip a floating point percentage. */
const POOL = [
  1, 7, 29, 57, 100, 290, 1000, 2900, 5700, 10000, 12345, 29999, 50000, 99999, 100000, 250000,
];

const goalSel: fc.Arbitrary<GoalSel> = fc.record({
  k: fc.constantFrom(0, 0, 1, 1, 1, 2, 2, 2, 3, 4) as fc.Arbitrary<GoalSel['k']>,
  i: fc.nat(9),
});
/** The goals a settlement names: archived and unknown ones come up often, to test which is reported first. */
const settleGoalSel: fc.Arbitrary<GoalSel> = fc.record({
  k: fc.constantFrom(0, 0, 1, 1, 2, 2, 2, 3, 4) as fc.Arbitrary<GoalSel['k']>,
  i: fc.nat(9),
});
const amountPool = fc.constantFrom(...POOL);
const sourceAmount: fc.Arbitrary<AmountSel> = fc.oneof(
  { weight: 5, arbitrary: amountPool.map((v): AmountSel => ({ k: 'fixed', v })) },
  { weight: 2, arbitrary: fc.constant<AmountSel>({ k: 'all' }) },
  { weight: 1, arbitrary: fc.constant<AmountSel>({ k: 'over' }) },
  { weight: 1, arbitrary: fc.constant<AmountSel>({ k: 'half' }) },
);
const dateSel = fc.constantFrom<DateSel>(
  'omit',
  'omit',
  'omit',
  'today',
  'start',
  'rand',
  'rand',
  'beforeStart',
  'tomorrow',
);
const noteSel = fc.constantFrom<NoteSel>(undefined, undefined, null, 'x', '  padded  ', '   ');
const r = fc.nat(1000);
const target = fc.constantFrom<'any' | 'settled'>('any', 'settled', 'settled');
/** Most manual requests are meant to be accepted (a clean request); the rest may break several rules at once. */
const clean = fc.constantFrom(true, true, true, false, false);

const arbitraries: { [T in Op['t']]: fc.Arbitrary<Extract<Op, { t: T }>> } = {
  advance: fc.record({
    t: fc.constant('advance' as const),
    mode: fc.constantFrom('days', 'days', 'tens', 'monthEnd', 'monthStart', 'months'),
    n: fc.integer({ min: 1, max: 9 }),
  }),
  goalCreate: fc.record({
    t: fc.constant('goalCreate' as const),
    target: fc.constantFrom(100, 700, 1000, 2500, 10000, 33333, 100000, 123457, 1_000_000),
    deadline: fc.constantFrom('none', 'past', 'soon', 'far'),
    r,
    color: fc.boolean(),
    padded: fc.boolean(),
  }),
  goalPatch: fc.record({
    t: fc.constant('goalPatch' as const),
    goal: goalSel,
    target: fc.constantFrom(null, null, 100, 1000, 33333, 100000, 1_000_000),
    deadline: fc.constantFrom('keep', 'keep', 'clear', 'past', 'soon', 'far'),
    r,
    archived: fc.constantFrom('keep', 'archive', 'archive', 'unarchive'),
    rename: fc.boolean(),
  }),
  goalDelete: fc.record({ t: fc.constant('goalDelete' as const), goal: goalSel }),
  deposit: fc.record({
    t: fc.constant('deposit' as const),
    goal: goalSel,
    amount: amountPool,
    date: dateSel,
    r,
    note: noteSel,
    bad: fc.constantFrom(false, false, false, false, false, false, false, false, false, true),
    clean,
  }),
  withdraw: fc.record({
    t: fc.constant('withdraw' as const),
    goal: goalSel,
    amount: sourceAmount,
    date: dateSel,
    r,
    note: noteSel,
    clean,
  }),
  reallocate: fc.record({
    t: fc.constant('reallocate' as const),
    from: goalSel,
    to: goalSel,
    amount: sourceAmount,
    date: dateSel,
    r,
    note: noteSel,
    clean,
  }),
  settle: fc.record({
    t: fc.constant('settle' as const),
    month: fc.constantFrom<SettleMonthSel>(
      ...(['out', 'out', 'out', 'out', 'out', 'out', 'out', 'adjust', 'adjust', 'adjust'] as const),
      ...([
        'settled',
        'current',
        'future',
        'beforeStart',
        'atHorizon',
        'beyondHorizon',
        'malformed',
      ] as const),
    ),
    mi: fc.nat(20),
    amount: fc.constantFrom(
      ...(['exact', 'exact', 'exact', 'exact', 'exact', 'exact', 'exact', 'exact'] as const),
      ...(['stale', 'stale', 'plus', 'minus', 'negated', 'zero'] as const),
    ),
    delta: fc.integer({ min: 1, max: 500 }),
    split: fc.constantFrom(
      ...(['none', 'none', 'none', 'one', 'two', 'two', 'two', 'three', 'three', 'three'] as const),
      ...(['empty', 'dupe', 'badGoals', 'badGoals'] as const),
    ),
    goals: fc.array(settleGoalSel, { minLength: 3, maxLength: 3 }),
    weights: fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 3, maxLength: 3 }),
    fault: fc.constantFrom(
      ...(['none', 'none', 'none', 'none', 'none', 'none', 'sum', 'sign', 'both', 'zero'] as const),
    ),
  }),
  undo: fc.record({
    t: fc.constant('undo' as const),
    mode: fc.constantFrom('out', 'adjust', 'settled', 'settled', 'none'),
    mi: fc.nat(20),
  }),
  roundTrip: fc.record({
    t: fc.constant('roundTrip' as const),
    mi: fc.nat(20),
    withGoal: fc.boolean(),
  }),
  netZero: fc.record({ t: fc.constant('netZero' as const), mi: fc.nat(20) }),
  deleteRow: fc.record({
    t: fc.constant('deleteRow' as const),
    k: fc.constantFrom(
      'plain',
      'plain',
      'pair',
      'pair',
      'pair',
      'settlement',
      'opening',
      'unknown',
      'gone',
    ),
    i: fc.nat(20),
  }),
  lateSpending: fc.record({
    t: fc.constant('lateSpending' as const),
    budget: fc.nat(5),
    target,
    mi: fc.nat(40),
    day: fc.integer({ min: 1, max: 28 }),
    amount: fc.constantFrom(500, 1000, 2500, 5000, 10000, 20000, 45000, 123456, 600000),
    refund: fc.constantFrom(false, false, false, true),
  }),
  lateIncome: fc.record({
    t: fc.constant('lateIncome' as const),
    target,
    mi: fc.nat(40),
    day: fc.integer({ min: 1, max: 28 }),
    amount: fc.constantFrom(500, 1000, 5000, 10000, 50000, 99999),
  }),
  revert: fc.constant({ t: 'revert' as const }),
  salaryPut: fc.record({
    t: fc.constant('salaryPut' as const),
    mi: fc.nat(40),
    amount: fc.constantFrom(0, 100000, 250000, 333333, 400000),
  }),
  salaryDelete: fc.record({ t: fc.constant('salaryDelete' as const), i: fc.nat(9) }),
  opening: fc.record({
    t: fc.constant('opening' as const),
    amount: fc.constantFrom(0, 1, 50000, 123456, 1_000_000_000_000),
  }),
  moveStart: fc.record({
    t: fc.constant('moveStart' as const),
    delta: fc.integer({ min: -8, max: 4 }),
  }),
};

export type Profile = 'general' | 'books';

/**
 * How often each operation is drawn. `general` is a balanced mix. `books` spends most of its time on
 * the "move to savings" list: settling, undoing, adjusting after late edits to settled months, and
 * moving the clock, which is where the subtle rules (adjustments, the optimistic lock, a month netting
 * to 0) live.
 */
const WEIGHTS: Record<Profile, Record<Op['t'], number>> = {
  general: {
    advance: 12,
    goalCreate: 6,
    goalPatch: 8,
    goalDelete: 3,
    deposit: 11,
    withdraw: 9,
    reallocate: 8,
    settle: 20,
    undo: 5,
    roundTrip: 3,
    netZero: 2,
    deleteRow: 5,
    lateSpending: 6,
    lateIncome: 3,
    revert: 2,
    salaryPut: 2,
    salaryDelete: 1,
    opening: 3,
    moveStart: 4,
  },
  books: {
    advance: 10,
    goalCreate: 4,
    goalPatch: 4,
    goalDelete: 2,
    deposit: 5,
    withdraw: 4,
    reallocate: 4,
    settle: 30,
    undo: 8,
    roundTrip: 4,
    netZero: 4,
    deleteRow: 3,
    lateSpending: 12,
    lateIncome: 6,
    revert: 4,
    salaryPut: 4,
    salaryDelete: 2,
    opening: 2,
    moveStart: 3,
  },
};

export const opArbOf = (profile: Profile): fc.Arbitrary<Op> =>
  fc.oneof(
    ...(Object.keys(arbitraries) as Op['t'][]).map((t) => ({
      weight: WEIGHTS[profile][t],
      arbitrary: arbitraries[t] as fc.Arbitrary<Op>,
    })),
  );

/** The world a run starts from: a few closed months, some budgets and subscriptions, 0 to 2 goals. */
export interface Setup {
  /** The start month is 2025-01 plus this many months. */
  startOffset: number;
  /** Closed months at the start (the clock is in the month after them). */
  closed: number;
  day: number;
  /** The first salary starts one month after the start month, as do the budgets and subscriptions. */
  later: boolean;
  salary: number;
  raise: boolean;
  opening: number;
  budgets: { amount: number; incremental: boolean }[];
  monthlySub: number;
  yearlySub: number;
  yearlyMonth: number;
  goals: { target: number; deadline: boolean; archived: boolean }[];
}

export const setupArb: fc.Arbitrary<Setup> = fc.record({
  startOffset: fc.integer({ min: 0, max: 11 }),
  closed: fc.integer({ min: 2, max: 5 }),
  day: fc.integer({ min: 1, max: 28 }),
  later: fc.boolean(),
  salary: fc.constantFrom(200000, 250000, 333333, 400000),
  raise: fc.boolean(),
  opening: fc.constantFrom(0, 0, 10000, 50000, 123456),
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
  goals: fc.array(
    fc.record({
      target: fc.constantFrom(1000, 33333, 100000, 500000),
      deadline: fc.boolean(),
      archived: fc.boolean(),
    }),
    { minLength: 1, maxLength: 3 },
  ),
});

// -------------------------------------------------------------------------------------------------
// Resolving a selector against the state of the model
// -------------------------------------------------------------------------------------------------

/** A goal id (or null) from a selector. Selectors that find nothing fall back to an id no goal has. */
export function pickGoal(world: World, sel: GoalSel, gone: readonly number[]): number | null {
  if (sel.k === 0) return null;
  const pool =
    sel.k === 1
      ? world.goals
      : sel.k === 2
        ? world.goals.filter((goal) => !goal.archived)
        : sel.k === 3
          ? world.goals.filter((goal) => goal.archived)
          : [];
  if (pool.length > 0) return pool[sel.i % pool.length]!.id;
  // A goal that does not exist: one that was deleted, or a fresh number.
  const deleted = gone.filter((id) => !world.goals.some((goal) => goal.id === id));
  if (deleted.length > 0 && sel.i % 2 === 0) return deleted[sel.i % deleted.length]!;
  return Math.max(0, ...world.goals.map((goal) => goal.id), ...gone) + 1 + (sel.i % 3);
}

/** The money an `AmountSel` stands for, given what the source holds now. Always positive. */
export function pickAmount(sel: AmountSel, held: number): number {
  switch (sel.k) {
    case 'fixed':
      return sel.v;
    case 'all':
      return held > 0 ? held : 1;
    case 'over':
      return held > 0 ? held + 1 : 1;
    case 'half':
      return Math.max(1, Math.floor(held / 2));
  }
}

/** A date from a selector. */
export function pickDate(world: World, sel: DateSel, rnd: number): string | undefined {
  const start = firstDay(world.facts.startMonth);
  switch (sel) {
    case 'omit':
      return undefined;
    case 'today':
      return world.today;
    case 'start':
      return start;
    case 'rand':
      return addDays(start, rnd % (daysBetween(start, world.today) + 1));
    case 'beforeStart':
      return addDays(start, -1 - (rnd % 40));
    case 'tomorrow':
      return addDays(world.today, 1);
  }
}

/** A deadline from a selector: any past month, a near one, or a far one. */
export function pickDeadline(world: World, kind: 'past' | 'soon' | 'far', rnd: number): string {
  const current = monthIndex(currentMonthOf(world));
  const month =
    kind === 'past'
      ? current - 1 - (rnd % 6)
      : kind === 'soon'
        ? current + (rnd % 4)
        : current + 4 + (rnd % 20);
  return `${monthKey(month)}-${String(1 + (rnd % 28)).padStart(2, '0')}`;
}

/** The closed months that are tracked, with and without something to settle. */
export function closedMonths(world: World): string[] {
  return [...dueByMonth(world).keys()];
}

/** The closed months that have at least one settlement row. */
export function settledMonths(world: World): string[] {
  const months = new Set(
    world.rows.flatMap((row) => (row.kind === 'settlement' ? [row.settlesMonth ?? ''] : [])),
  );
  return closedMonths(world).filter((month) => months.has(month));
}

/** The month of a settle (or undo) request. */
export function pickSettleMonth(world: World, mode: SettleMonthSel, mi: number): string {
  const current = monthIndex(currentMonthOf(world));
  const start = monthIndex(world.facts.startMonth);
  const closed = closedMonths(world);
  const open = outstandingList(world);
  const fallback = closed[0] ?? currentMonthOf(world);
  const out = open.length > 0 ? open[mi % open.length]!.month : fallback;
  switch (mode) {
    case 'out':
      return out;
    case 'adjust': {
      // A month that was settled before and still has something outstanding: a correction.
      const adjust = open.filter((entry) => entry.adjustment);
      return adjust.length > 0 ? adjust[mi % adjust.length]!.month : out;
    }
    case 'settled': {
      const done = closed.filter((month) => outstandingOf(world, month) === 0);
      return done.length > 0 ? done[mi % done.length]! : fallback;
    }
    case 'current':
      return currentMonthOf(world);
    case 'future':
      return monthKey(current + 1 + (mi % 3));
    case 'beforeStart':
      return monthKey(start - 1 - (mi % 3));
    case 'atHorizon':
      return monthKey(current + 120);
    case 'beyondHorizon':
      return monthKey(current + 121 + (mi % 3));
    case 'malformed':
      return '2026-13';
  }
}

/** The month a late spending or income goes to: any month from `low`, or a month that was settled. */
export function pickEditMonth(
  world: World,
  low: number,
  mi: number,
  target: 'any' | 'settled',
): string {
  const current = monthIndex(currentMonthOf(world));
  if (target === 'settled') {
    const months = settledMonths(world).filter((month) => monthIndex(month) >= low);
    if (months.length > 0) return months[mi % months.length]!;
  }
  return monthKey(low + (mi % (current - low + 1)));
}

/**
 * The body of a settle request: the amount (the outstanding, or the figure the user saw earlier, or
 * something that is not it) and the allocations that split it, with the faults the operation asks for.
 */
export function buildSettleBody(
  world: World,
  op: Extract<Op, { t: 'settle' }>,
  month: string,
  seen: ReadonlySet<number> | undefined,
  gone: readonly number[],
): SettleBody {
  const outstanding = outstandingOf(world, month) ?? 0;
  const base = outstanding === 0 ? op.delta : outstanding;
  // A figure the user saw earlier that is not the current one, when there is one.
  const stale = [...(seen ?? [])].reverse().find((value) => value !== outstanding);
  let amount: number;
  switch (op.amount) {
    case 'exact':
      amount = base;
      break;
    case 'stale':
      amount = stale ?? base + op.delta;
      break;
    case 'plus':
      amount = base + op.delta;
      break;
    case 'minus':
      amount = base - op.delta;
      break;
    case 'negated':
      amount = -base;
      break;
    case 'zero':
      amount = 0;
      break;
  }
  if (op.split === 'none') return { amount };
  if (op.split === 'empty') return { amount, allocations: [] };

  // Split |amount| into `parts` positive slices by the weights, each of the sign of the amount.
  const parts =
    op.split === 'one'
      ? 1
      : op.split === 'three'
        ? 3
        : op.split === 'badGoals'
          ? 2 + (op.weights[0]! % 2)
          : 2;
  const total = Math.abs(amount);
  const count = Math.max(1, Math.min(parts, total));
  const weights = op.weights.slice(0, count);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const slices = weights.map((weight) => Math.max(1, Math.floor((total * weight) / weightSum)));
  slices[0] = slices[0]! + (total - slices.reduce((sum, slice) => sum + slice, 0)); // the rest goes first
  const sign = amount < 0 ? -1 : 1;
  const allocations = slices.map((slice, index) => ({
    goalId: pickGoal(world, op.goals[index]!, gone),
    amount: sign * slice,
  }));

  if (op.split === 'badGoals') {
    // Slices that name an archived goal, a goal that does not exist, or a fine place, in an order the
    // weights choose: the request is refused at the FIRST offending slice, whichever way it is wrong.
    const archived = world.goals.filter((goal) => goal.archived);
    const fine = [null, ...world.goals.filter((goal) => !goal.archived).map((goal) => goal.id)];
    const missing = Math.max(0, ...world.goals.map((goal) => goal.id), ...gone) + 1;
    allocations.forEach((allocation, index) => {
      const kind = op.weights[index]! % 3;
      allocation.goalId =
        kind === 0 && archived.length > 0
          ? archived[(op.weights[index]! + index) % archived.length]!.id
          : kind === 1
            ? missing + index
            : (fine[(op.weights[index]! + index) % fine.length] ?? null);
    });
  }

  // A goal may appear only once: move a repeat to a place that is still free, or fold it into the
  // first slice when none is left, unless the operation is the one that repeats on purpose.
  const used = new Set<number | null>();
  const free = [null, ...world.goals.filter((goal) => !goal.archived).map((goal) => goal.id)];
  for (let index = 0; index < allocations.length; index++) {
    const allocation = allocations[index]!;
    if (op.split !== 'dupe' && op.split !== 'badGoals' && used.has(allocation.goalId)) {
      const place = free.find((candidate) => !used.has(candidate));
      if (place !== undefined) allocation.goalId = place;
      else {
        allocations[0]!.amount += allocation.amount;
        allocations.splice(index, 1);
        index -= 1;
        continue;
      }
    }
    used.add(allocation.goalId);
  }
  if (op.split === 'dupe' && allocations.length > 1)
    allocations[1]!.goalId = allocations[0]!.goalId;

  // Faults: the slices do not add up, one has the wrong sign (and they still add up), or one is 0.
  const first = allocations[0]!;
  const last = allocations[allocations.length - 1]!;
  switch (op.fault) {
    case 'sum':
      last.amount += sign * op.delta;
      break;
    case 'sign':
      if (allocations.length > 1) {
        // [a, b, ...] becomes [-a, b + 2a, ...]: the sum is the same, the first slice has the wrong sign.
        allocations[1]!.amount += 2 * first.amount;
        first.amount = -first.amount;
      } else {
        first.amount = -first.amount;
      }
      break;
    case 'both':
      for (const allocation of allocations)
        allocation.amount = -allocation.amount + sign * op.delta;
      break;
    case 'zero':
      last.amount = 0;
      break;
    case 'none':
      break;
  }
  return { amount, allocations };
}

const sumGoal = (world: World, goalId: number): number =>
  world.rows.filter((row) => row.goalId === goalId).reduce((total, row) => total + row.amount, 0);
const sumUnassigned = (world: World): number =>
  world.rows.filter((row) => row.goalId === null).reduce((total, row) => total + row.amount, 0);

const heldAt = (world: World, place: number | null): number =>
  place === null ? sumUnassigned(world) : sumGoal(world, place);

/** Every place money can sit: unassigned savings, and the goals (the archived ones too when `archived`). */
const placesOf = (world: World, archived: boolean): (number | null)[] => [
  null,
  ...world.goals.filter((goal) => archived || !goal.archived).map((goal) => goal.id),
];

/** An amount that the source can give: at least 1, at most what it holds (when it holds anything). */
const affordable = (sel: AmountSel, held: number): number => {
  const wanted = pickAmount(sel.k === 'over' ? { k: 'half' } : sel, held);
  return held > 0 ? Math.min(Math.max(1, wanted), held) : wanted;
};

/**
 * The body of a deposit, withdrawal or reallocation. `bad` makes a deposit's amount not positive. A
 * `clean` request is meant to be accepted (a date in range, goals that exist and can receive or give
 * the money, an amount the source holds); any other one may break several rules at once.
 */
export function buildManualBody(
  world: World,
  op: Extract<Op, { t: 'deposit' | 'withdraw' | 'reallocate' }>,
  gone: readonly number[],
): ManualBody {
  const dateSel =
    op.clean && (op.date === 'beforeStart' || op.date === 'tomorrow') ? 'omit' : op.date;
  const date = pickDate(world, dateSel, op.r);
  const common = {
    ...(date === undefined ? {} : { date }),
    ...(op.note === undefined ? {} : { note: op.note }),
  };
  // An omitted goal and a null one mean the same: use both.
  const goalField = (goalId: number | null) =>
    goalId === null && op.r % 2 === 0 ? {} : { goalId };

  if (op.t === 'deposit') {
    const destinations = placesOf(world, false);
    const goalId = op.clean
      ? destinations[op.goal.i % destinations.length]!
      : pickGoal(world, op.goal, gone);
    return {
      kind: 'deposit',
      amount: op.bad && !op.clean ? -op.amount + (op.r % 2) : op.amount,
      ...goalField(goalId),
      ...common,
    };
  }
  if (op.t === 'withdraw') {
    const sources = placesOf(world, true).filter((place) => heldAt(world, place) > 0);
    const goalId =
      op.clean && sources.length > 0
        ? sources[op.goal.i % sources.length]!
        : pickGoal(world, op.goal, gone);
    const held = heldAt(world, goalId);
    return {
      kind: 'withdrawal',
      amount: op.clean ? affordable(op.amount, held) : pickAmount(op.amount, held),
      ...goalField(goalId),
      ...common,
    };
  }
  const sources = placesOf(world, true).filter((place) => heldAt(world, place) > 0);
  const fromGoalId =
    op.clean && sources.length > 0
      ? sources[op.from.i % sources.length]!
      : pickGoal(world, op.from, gone);
  const destinations = placesOf(world, false).filter((place) => place !== fromGoalId);
  const toGoalId =
    op.clean && destinations.length > 0
      ? destinations[op.to.i % destinations.length]!
      : pickGoal(world, op.to, gone);
  const held = heldAt(world, fromGoalId);
  return {
    kind: 'reallocation',
    amount: op.clean ? affordable(op.amount, held) : pickAmount(op.amount, held),
    fromGoalId,
    toGoalId,
    ...common,
  };
}
