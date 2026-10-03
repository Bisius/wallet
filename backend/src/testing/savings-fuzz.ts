/**
 * The driver of the savings operation fuzz. A run starts from a small world built through the public
 * endpoints, then executes a random sequence of operations (`savings-fuzz-gen.ts`) against the app
 * and, in lock step, against the independent model (`savings-model.ts`).
 *
 * For EVERY operation it asserts:
 *
 * - the answer is the one docs/DOMAIN.md demands: accepted with the rows the doc says, or refused
 *   with the status, code, rule and field of the FIRST rule broken in the doc's order;
 * - `GET /api/savings`, `GET /api/goals`, `GET /api/savings/opening`, every row of
 *   `GET /api/savings/transactions` and one filtered, paged slice of it equal the model, figure for
 *   figure;
 * - a refused request changed nothing (the whole state read back is identical to the step before);
 * - the identities of the contract and of invariants 6 and 7 hold on the numbers the API shows,
 *   without the model: `balance = unassigned + the goals = opening + every other row`, the list is
 *   exactly the months with a non-zero `savingsDue - settled`, a reallocation changes no balance, a
 *   deleted goal changes no balance, undoing a settlement gives the month back to the whole of its
 *   savings due, and `sum of savingsDue over the closed months = sum settled + sum outstanding`;
 * - `GET /api/months` agrees with the model on the savings due of every closed month (so the model's
 *   facts are what the API stored).
 *
 * Everything is deterministic: a fixed clock that only the operations move, an in-memory database,
 * and one server per run.
 */
import type {
  GoalDto,
  MonthSummary,
  SavingsDto,
  SavingsOpeningDto,
  SavingsTransactionDto,
  SettingsDto,
} from '@wallet/shared';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BudgetFact, IncomeFact, SpendingFact, SubscriptionFact } from '../domain/facts';
import { type MutableClock, mutableClock } from './helpers';
import { canonical, type coverage, diff, failIfAny } from './prop';
import { type Answer, serve, stop } from './prop-api';
import { monthIndex, monthKey } from './prop-model';
import {
  type Op,
  type Setup,
  addDays,
  buildManualBody,
  buildSettleBody,
  firstDay,
  isMonthKey,
  pickDate,
  pickDeadline,
  pickEditMonth,
  pickGoal,
  pickSettleMonth,
  settledMonths,
} from './savings-fuzz-gen';
import {
  type ModelGoal,
  type ModelRow,
  type NewRow,
  type Verdict,
  type World,
  balanceOf,
  currentMonthOf,
  dueByMonth,
  expectedGoals,
  expectedOpening,
  expectedPage,
  expectedSavings,
  goalFigures,
  moveStart,
  outstandingOf,
  predictDeleteRow,
  predictGoalPatch,
  predictManual,
  predictMoveStart,
  predictSettle,
  predictUndo,
  settlementRowsOf,
  sumOf,
  withoutGoal,
} from './savings-model';
import { createTestApp } from './test-app';

export type Coverage = ReturnType<typeof coverage<string>>;

/** Everything the API shows about savings at one moment. */
interface Snapshot {
  savings: SavingsDto;
  goals: GoalDto[];
  opening: SavingsOpeningDto;
  rows: SavingsTransactionDto[];
}

interface Edit {
  id: number;
  kind: 'spending' | 'income';
  fact: SpendingFact | IncomeFact;
}

interface Ctx {
  server: Server;
  clock: MutableClock;
  world: World;
  cov: Coverage;
  /** The late spendings and incomes the fuzz added, last one last (`revert` takes the last). */
  edits: Edit[];
  goneGoals: number[];
  goneRows: number[];
  /** Every outstanding amount shown for a month so far: "the figure the user saw". */
  seen: Map<string, Set<number>>;
  /** The state after the previous step, already checked against the model. */
  prev: Snapshot;
  step: number;
}

// -------------------------------------------------------------------------------------------------
// HTTP: `fetch` against one listening server (supertest costs more per request than the app does,
// and a run makes thousands of them)
// -------------------------------------------------------------------------------------------------

async function call(
  server: Server,
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
  body?: object,
): Promise<Answer> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: method.toUpperCase(),
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : JSON.parse(text) };
}

/** One request that must answer `expected`; otherwise the failure names the request and the answer. */
async function send(
  server: Server,
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
  body?: object,
  expected = 200,
): Promise<any> {
  const answer = await call(server, method, path, body);
  if (answer.status !== expected) {
    throw new Error(
      `${method.toUpperCase()} ${path} ${JSON.stringify(body)} answered ${answer.status}, expected ${expected}: ${JSON.stringify(answer.body)}`,
    );
  }
  return answer.body;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** A positive id no goal has (a goal endpoint answers 400 to id 0, which is not what is being tested). */
const missingGoalId = (world: World, gone: readonly number[]): number =>
  Math.max(0, ...world.goals.map((goal) => goal.id), ...gone) + 1;

// -------------------------------------------------------------------------------------------------
// Reading and checking the state
// -------------------------------------------------------------------------------------------------

/**
 * What the API shows about savings. `GET /api/goals` and `GET /api/savings/opening` are read on
 * every fourth step and after the operations that change them (a request costs more than the work
 * behind it, and `GET /api/savings` carries the goals anyway); otherwise they are taken from the
 * model, which is then compared with itself and so proves nothing on that step.
 */
async function readSnapshot(ctx: Ctx, full: boolean): Promise<Snapshot> {
  const savings = (await send(ctx.server, 'get', '/api/savings')) as SavingsDto;
  const goals = full ? ((await send(ctx.server, 'get', '/api/goals')) as GoalDto[]) : savings.goals;
  const opening = full
    ? ((await send(ctx.server, 'get', '/api/savings/opening')) as SavingsOpeningDto)
    : expectedOpening(ctx.world);
  const rows: SavingsTransactionDto[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await send(
      ctx.server,
      'get',
      `/api/savings/transactions?limit=200&offset=${offset}`,
    );
    rows.push(...(page.items as SavingsTransactionDto[]));
    if (offset + 200 >= page.total) break;
  }
  return { savings, goals, opening, rows };
}

/** The API against the model: every figure of the four reads. */
function modelProblems(world: World, snap: Snapshot): string[] {
  const full = expectedPage(world, { limit: Number.MAX_SAFE_INTEGER, offset: 0 }).items;
  return [
    ...diff(snap.savings, expectedSavings(world), 'GET /api/savings'),
    ...diff(snap.goals, expectedGoals(world), 'GET /api/goals'),
    ...diff(snap.opening, expectedOpening(world), 'GET /api/savings/opening'),
    ...diff(snap.rows, full, 'GET /api/savings/transactions'),
  ];
}

/**
 * The identities of docs/DOMAIN.md and of the contract, on the numbers the API shows (the model only
 * supplies the savings due of each closed month, for the conservation).
 */
function identityProblems(world: World, snap: Snapshot): string[] {
  const { savings, rows, opening, goals } = snap;
  const problems: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };
  const today = world.today;
  const start = world.facts.startMonth;
  const current = currentMonthOf(world);

  // "savingsBalance = sum of every row", "unassigned = the rows with no goal", "goalBalance(G)".
  check(
    savings.balance === sumOf(rows),
    `balance ${savings.balance} is not the sum of the rows ${sumOf(rows)}`,
  );
  check(
    savings.unassigned === sumOf(rows.filter((row) => row.goalId === null)),
    'unassigned is not the sum of the rows with no goal',
  );
  for (const goal of savings.goals) {
    check(
      goal.balance === sumOf(rows.filter((row) => row.goalId === goal.id)),
      `goal ${goal.id} balance ${goal.balance} is not the sum of its rows`,
    );
  }
  // "savingsBalance = unassigned + the sum of the goal balances (archived ones too)".
  check(
    savings.balance ===
      savings.unassigned + sumOf(savings.goals.map((goal) => ({ amount: goal.balance }))),
    'balance is not unassigned + the goals',
  );
  // "balance equals opening plus all rows".
  check(
    savings.balance === opening.amount + sumOf(rows.filter((row) => row.kind !== 'opening')),
    'balance is not the opening balance + every other row',
  );
  check(
    canonical(goals) === canonical(savings.goals),
    'GET /api/goals is not the goals of GET /api/savings',
  );

  // Rows: one opening row dated the 1st of the start month; goals exist; kinds and dates are coherent.
  const openingRows = rows.filter((row) => row.kind === 'opening');
  check(openingRows.length === 1, `${openingRows.length} opening rows`);
  check(new Set(rows.map((row) => row.id)).size === rows.length, 'duplicate row ids');
  const goalIds = new Set(goals.map((goal) => goal.id));
  for (const row of rows) {
    check(
      row.goalId === null || goalIds.has(row.goalId),
      `row ${row.id} names the missing goal ${row.goalId}`,
    );
    check(
      (row.kind === 'settlement') === (row.settlesMonth !== null),
      `row ${row.id}: settlesMonth/kind`,
    );
    check((row.kind === 'reallocation') === (row.groupId !== null), `row ${row.id}: groupId/kind`);
    check(
      row.date >= firstDay(start),
      `row ${row.id} is dated ${row.date}, before the start month`,
    );
    if (row.kind === 'opening')
      check(row.date === firstDay(start) && row.goalId === null, 'opening row');
    if (row.kind !== 'opening') check(row.date <= today, `row ${row.id} is dated after today`);
    if (row.kind === 'settlement') check(row.note === null, `settlement row ${row.id} has a note`);
    if (row.kind === 'deposit') check(row.amount > 0, `deposit row ${row.id} is not positive`);
    if (row.kind === 'withdrawal')
      check(row.amount < 0, `withdrawal row ${row.id} is not negative`);
  }
  // "The two rows of a reallocation share a groupId" and "sum to 0": exactly two rows per group.
  const groups = new Map<number, SavingsTransactionDto[]>();
  for (const row of rows) {
    if (row.groupId !== null) groups.set(row.groupId, [...(groups.get(row.groupId) ?? []), row]);
  }
  for (const [groupId, pair] of groups) {
    check(pair.length === 2, `group ${groupId} has ${pair.length} rows`);
    check(sumOf(pair) === 0, `group ${groupId} does not sum to 0`);
    if (pair.length === 2) {
      check(
        pair[0]!.date === pair[1]!.date && pair[0]!.note === pair[1]!.note,
        `group ${groupId}: date/note differ`,
      );
    }
  }

  // The list: closed tracked months with a non-zero outstanding, ascending.
  const months = savings.outstanding.map((entry) => entry.month);
  check(
    canonical(months) === canonical([...months].sort()),
    'the outstanding list is not ascending',
  );
  check(new Set(months).size === months.length, 'a month is listed twice');
  for (const entry of savings.outstanding) {
    const settlement = rows.filter(
      (row) => row.kind === 'settlement' && row.settlesMonth === entry.month,
    );
    check(
      entry.month >= start && entry.month < current,
      `${entry.month} is listed but is not a closed month`,
    );
    check(
      entry.settled === sumOf(settlement),
      `${entry.month}: settled is not the sum of its settlement rows`,
    );
    check(
      entry.outstanding === entry.savingsDue - entry.settled,
      `${entry.month}: outstanding != due - settled`,
    );
    check(entry.outstanding !== 0, `${entry.month}: listed with 0 outstanding`);
    check(
      entry.direction === (entry.outstanding > 0 ? 'move' : 'take'),
      `${entry.month}: direction`,
    );
    check(entry.adjustment === settlement.length > 0, `${entry.month}: adjustment`);
    const { unallocated, budgetsSettled, reservesReleased } = entry.breakdown;
    check(
      unallocated + budgetsSettled + reservesReleased === entry.savingsDue,
      `${entry.month}: breakdown`,
    );
  }
  check(
    savings.outstandingTotal ===
      sumOf(savings.outstanding.map((entry) => ({ amount: entry.outstanding }))),
    'outstandingTotal is not the sum of the outstanding amounts',
  );

  // Conservation: what the closed months produced is settled or still outstanding.
  const due = dueByMonth(world);
  const dueTotal = sumOf([...due.values()].map((lines) => ({ amount: lines.total })));
  const settledTotal = sumOf(
    rows.filter((row) => row.kind === 'settlement' && due.has(row.settlesMonth ?? '')),
  );
  check(
    dueTotal === settledTotal + savings.outstandingTotal,
    `conservation: sum of savings due ${dueTotal} != settled ${settledTotal} + outstanding ${savings.outstandingTotal}`,
  );

  // Goals: the figures agree with each other (the contract's identities).
  for (const goal of savings.goals) {
    check(goal.reached === goal.balance >= goal.targetAmount, `goal ${goal.id}: reached`);
    check(
      goal.reached === (goal.remaining === 0) && goal.reached === goal.progressPercent >= 100,
      `goal ${goal.id}: reached, remaining and progress disagree`,
    );
    check(
      (goal.monthlyNeeded !== null) ===
        (goal.deadline !== null && (goal.status === 'active' || goal.status === 'overdue')),
      `goal ${goal.id}: monthlyNeeded is set exactly for an active or overdue goal with a deadline`,
    );
  }
  return problems;
}

/** One filtered, paged slice of the list, chosen by the step number so every variant comes round. */
async function pageProblems(ctx: Ctx): Promise<string[]> {
  const { world, step } = ctx;
  const limit = [1, 2, 3, 5, 50, 200][step % 6]!;
  const offset = [0, 0, 1, 2, 4, 0][(step * 5) % 6]!;
  const goal = world.goals.length > 0 ? world.goals[step % world.goals.length]!.id : 999;
  const variants: [string, Parameters<typeof expectedPage>[1]][] = [
    ['', { limit, offset }],
    [`&goalId=${goal}`, { goalId: goal, limit, offset }],
    ['&unassigned=true', { unassigned: true, limit, offset }],
    ['&kind=settlement', { kind: 'settlement', limit, offset }],
    ['&kind=reallocation', { kind: 'reallocation', limit, offset }],
    [`&goalId=${goal}&kind=deposit`, { goalId: goal, kind: 'deposit', limit, offset }],
    ['&unassigned=false&kind=withdrawal', { kind: 'withdrawal', limit, offset }],
  ];
  const [query, expected] = variants[step % variants.length]!;
  const path = `/api/savings/transactions?limit=${limit}&offset=${offset}${query}`;
  const page = await send(ctx.server, 'get', path);
  return diff(page, expectedPage(world, expected), path);
}

/** `GET /api/months`: the savings due of the closed months is what the model works out from the facts. */
async function monthsProblems(ctx: Ctx): Promise<string[]> {
  const due = dueByMonth(ctx.world);
  const months = [...due.keys()];
  if (months.length === 0) return [];
  const path = `/api/months?from=${months[0]}&to=${months[months.length - 1]}`;
  const summaries = (await send(ctx.server, 'get', path)) as MonthSummary[];
  return diff(
    summaries.map(({ month, status, savingsDue }) => ({ month, status, savingsDue })),
    months.map((month) => ({ month, status: 'closed', savingsDue: due.get(month)!.total })),
    path,
  );
}

/** The state is read back after every step: it must be the model's, and a refusal must have changed nothing. */
async function finish(
  ctx: Ctx,
  opts: { refused: boolean; months?: boolean; full?: boolean },
): Promise<Snapshot> {
  const snap = await readSnapshot(ctx, opts.full ?? ctx.step % 4 === 0);
  failIfAny(modelProblems(ctx.world, snap), 'the API differs from the model');
  failIfAny(identityProblems(ctx.world, snap), 'an identity of docs/DOMAIN.md is broken');
  if (ctx.step % 2 === 0) {
    failIfAny(await pageProblems(ctx), 'a page of the transactions differs from the model');
  }
  if (opts.months)
    failIfAny(await monthsProblems(ctx), 'the month summaries differ from the model');
  if (opts.refused) {
    failIfAny(
      canonical(snap) === canonical(ctx.prev) ? [] : [...diff(snap, ctx.prev, 'state')],
      'a refused request changed something',
    );
  }
  for (const entry of snap.savings.outstanding) {
    ctx.seen.set(entry.month, new Set([...(ctx.seen.get(entry.month) ?? []), entry.outstanding]));
  }
  if (snap.savings.outstanding.length >= 3) ctx.cov.hit('three or more outstanding months at once');
  if (snap.savings.outstanding.some((entry) => entry.adjustment && entry.settled === 0)) {
    ctx.cov.hit('adjustment month whose settlements net to 0');
  }
  if (snap.savings.balance < 0) ctx.cov.hit('total balance below 0');
  if (snap.savings.unassigned < 0) ctx.cov.hit('unassigned below 0');
  if (snap.savings.goals.some((goal) => goal.balance < 0)) ctx.cov.hit('a goal below 0');
  for (const goal of snap.savings.goals) ctx.cov.hit(`goal status ${goal.status}`);
  ctx.prev = snap;
  return snap;
}

// -------------------------------------------------------------------------------------------------
// Answers
// -------------------------------------------------------------------------------------------------

/** The answer must be the acceptance or the refusal the model predicted. */
function checkAnswer(
  ctx: Ctx,
  what: string,
  answer: Answer,
  verdict: Verdict<unknown>,
  okStatus: number,
): void {
  const shown = `${answer.status} ${JSON.stringify(answer.body)}`;
  if (verdict.ok) {
    if (answer.status !== okStatus) {
      throw new Error(
        `${what}: docs/DOMAIN.md accepts it (${okStatus}), the API answered ${shown}`,
      );
    }
    return;
  }
  const { refusal } = verdict;
  const label = [refusal.code, refusal.rule, refusal.field].filter(Boolean).join(' ');
  const error = answer.body?.error;
  const problems: string[] = [];
  if (answer.status !== refusal.status) problems.push(`status ${answer.status}`);
  if (error?.code !== refusal.code) problems.push(`error.code ${error?.code}`);
  if (refusal.code === 'rule_violation') {
    if (error?.details?.rule !== refusal.rule) problems.push(`rule ${error?.details?.rule}`);
    if (error?.details?.field !== refusal.field) problems.push(`field ${error?.details?.field}`);
  }
  if (refusal.code === 'outstanding_changed') {
    problems.push(...diff(error?.details, refusal.details, 'details'));
  }
  if (
    refusal.code === 'validation_error' &&
    !(Array.isArray(error?.details) && error.details.length > 0)
  ) {
    problems.push('no validation issues');
  }
  failIfAny(
    problems,
    `${what}: docs/DOMAIN.md refuses it with ${refusal.status} ${label}, the API answered ${shown}`,
  );
  ctx.cov.hit(`${what.split(' ')[0]} refused ${label}`);
}

/** The rows the server stored: what the doc says, with ids that are new and one group id per reallocation. */
function adoptRows(
  ctx: Ctx,
  predicted: NewRow[],
  stored: SavingsTransactionDto[],
  what: string,
): void {
  const problems = diff(
    stored.map(({ id: _id, groupId: _groupId, ...rest }) => rest),
    predicted,
    `${what} rows`,
  );
  const taken = new Set(ctx.world.rows.map((row) => row.id));
  for (const row of stored) {
    if (!Number.isInteger(row.id) || row.id <= 0 || taken.has(row.id))
      problems.push(`row id ${row.id} is not new`);
    taken.add(row.id);
  }
  if (predicted[0]?.kind === 'reallocation') {
    // "The two rows of a reallocation share a groupId, which is null on every other row."
    if (typeof stored[0]?.groupId !== 'number' || stored[0].groupId !== stored[1]?.groupId) {
      problems.push('the two rows of a reallocation do not share a groupId');
    }
  } else if (stored.some((row) => row.groupId !== null)) {
    problems.push('a row that is not a reallocation has a groupId');
  }
  failIfAny(problems, `${what} stored the wrong rows`);
  ctx.world.rows.push(...stored);
}

const sameBalance = (a: Snapshot, b: Snapshot): string[] =>
  diff(a.savings.balance, b.savings.balance, 'balance');

// -------------------------------------------------------------------------------------------------
// Operations
// -------------------------------------------------------------------------------------------------

async function settleRequest(ctx: Ctx, month: string, body: object): Promise<boolean> {
  const { world } = ctx;
  const verdict = isMonthKey(month)
    ? predictSettle(world, month, body as Parameters<typeof predictSettle>[2])
    : ({ ok: false, refusal: { status: 400, code: 'validation_error' } } as const);
  const before = ctx.prev;
  const answer = await call(ctx.server, 'post', `/api/savings/settle/${month}`, body);
  checkAnswer(ctx, 'settle', answer, verdict, 201);
  if (verdict.ok) {
    adoptRows(ctx, verdict.value, answer.body as SavingsTransactionDto[], 'settle');
    ctx.cov.hit('settle accepted');
    const amount = (body as { amount: number }).amount;
    if (amount < 0) ctx.cov.hit('settle accepted, negative (take from savings)');
    if (verdict.value.length > 1) ctx.cov.hit('settle accepted, split');
    if (verdict.value.some((row) => row.goalId !== null)) ctx.cov.hit('settle accepted, to a goal');
    if (before.rows.some((row) => row.kind === 'settlement' && row.settlesMonth === month)) {
      ctx.cov.hit('settle accepted, an adjustment of a settled month');
    }
  }
  const snap = await finish(ctx, { refused: !verdict.ok });
  if (verdict.ok) {
    // Invariant 7: after a settlement of a closed month, its outstanding is 0 (it is not listed).
    failIfAny(
      snap.savings.outstanding.some((entry) => entry.month === month)
        ? [`${month} is still outstanding`]
        : [],
      'after settling',
    );
  }
  return verdict.ok;
}

async function undoRequest(ctx: Ctx, month: string): Promise<boolean> {
  const verdict = predictUndo(ctx.world, month);
  const before = ctx.prev;
  const answer = await call(ctx.server, 'delete', `/api/savings/settle/${month}`);
  checkAnswer(ctx, 'undo', answer, verdict, 204);
  if (verdict.ok) {
    ctx.world.rows = ctx.world.rows.filter((row) => !verdict.value.includes(row.id));
    ctx.cov.hit('undo accepted');
  }
  const snap = await finish(ctx, { refused: !verdict.ok });
  if (verdict.ok) {
    // Invariant 7: no settlement row of M is left and M owes its whole savings due again: what was
    // outstanding plus what had been settled, whichever way the month is shown.
    const owed = (snapshot: Snapshot) =>
      snapshot.savings.outstanding.find((entry) => entry.month === month)?.outstanding ?? 0;
    const settledBefore = sumOf(
      before.rows.filter((row) => row.kind === 'settlement' && row.settlesMonth === month),
    );
    const problems = diff(
      owed(snap),
      owed(before) + settledBefore,
      `outstanding of ${month} after the undo`,
    );
    if (snap.rows.some((row) => row.kind === 'settlement' && row.settlesMonth === month))
      problems.push('a settlement row is left');
    if (snap.savings.outstanding.find((entry) => entry.month === month)?.adjustment)
      problems.push('still an adjustment');
    failIfAny(problems, 'undo does not give the month back to its whole savings due');
  }
  return verdict.ok;
}

/** A day of `month` that exists, and that is not after today when `month` is the current one. */
function dayIn(world: World, month: string, day: number): number {
  return month === currentMonthOf(world) ? Math.min(day, Number(world.today.slice(8, 10))) : day;
}

/** `POST /api/spendings` (it must be accepted), mirrored in the model's facts. */
async function postSpending(
  ctx: Ctx,
  budgetId: number,
  month: string,
  day: number,
  amount: number,
) {
  const { world } = ctx;
  const answer = await call(ctx.server, 'post', '/api/spendings', {
    date: `${month}-${pad(dayIn(world, month, day))}`,
    amount,
    budgetId,
    description: 'late',
  });
  failIfAny(
    answer.status === 201 ? [] : [`status ${answer.status} ${JSON.stringify(answer.body)}`],
    'POST /api/spendings',
  );
  const fact: SpendingFact = { budgetId, month, amount };
  world.facts.spendings.push(fact);
  ctx.edits.push({ id: answer.body.id as number, kind: 'spending', fact });
  if (month < currentMonthOf(world)) {
    ctx.cov.hit(
      amount < 0 ? 'a late refund in a closed month' : 'a late spending in a closed month',
    );
  }
  if (settledMonths(world).includes(month)) ctx.cov.hit('a late edit to a settled month');
  await finish(ctx, { refused: false, months: true });
}

/** The unit of work of every operation: run it, count it, and wrap a failure with the step and the operation. */
async function execute(ctx: Ctx, op: Op): Promise<void> {
  const { world } = ctx;
  const gone = ctx.goneGoals;
  ctx.cov.hit(`op ${op.t}`);
  switch (op.t) {
    case 'advance': {
      const current = monthIndex(currentMonthOf(world));
      let next: string;
      let time = '12:00:00';
      if (op.mode === 'days') next = addDays(world.today, op.n);
      else if (op.mode === 'tens') next = addDays(world.today, op.n * 10);
      else if (op.mode === 'monthEnd') {
        next = addDays(firstDay(monthKey(current + 1)), -1);
        time = '23:59:59';
      } else if (op.mode === 'monthStart') {
        next = firstDay(monthKey(current + 1));
        time = '00:00:00';
      } else
        next = `${monthKey(current + op.n)}-${pad(Math.min(28, Number(world.today.slice(8, 10))))}`;
      if (next.slice(0, 7) !== world.today.slice(0, 7))
        ctx.cov.hit('the clock crossed a month boundary');
      ctx.clock.set(`${next}T${time}Z`);
      world.today = next;
      await finish(ctx, { refused: false, months: true });
      return;
    }

    case 'goalCreate': {
      const name = `${op.padded ? '  ' : ''}Goal ${op.r}${op.padded ? ' ' : ''}`;
      const deadline = op.deadline === 'none' ? undefined : pickDeadline(world, op.deadline, op.r);
      const color = op.color ? '#A1B2C3' : undefined;
      const body = {
        name,
        targetAmount: op.target,
        ...(deadline === undefined ? (op.r % 2 === 0 ? {} : { deadline: null }) : { deadline }),
        ...(color === undefined ? {} : { color }),
      };
      const answer = await call(ctx.server, 'post', '/api/goals', body);
      failIfAny(
        answer.status === 201 ? [] : [`status ${answer.status} ${JSON.stringify(answer.body)}`],
        'POST /api/goals',
      );
      const goal: ModelGoal = {
        id: answer.body.id as number,
        name: name.trim(),
        targetAmount: op.target,
        deadline: deadline ?? null,
        color: color === undefined ? null : color.toLowerCase(),
        archived: false,
      };
      failIfAny(
        [
          ...diff(answer.body, goalFigures(goal, 0, currentMonthOf(world)), 'new goal'),
          ...(world.goals.some((other) => other.id === goal.id) ? ['the goal id is not new'] : []),
        ],
        'POST /api/goals',
      );
      world.goals.push(goal);
      await finish(ctx, { refused: false, full: true });
      return;
    }

    case 'goalPatch': {
      const id = pickGoal(world, op.goal, gone) ?? missingGoalId(world, gone);
      const deadline =
        op.deadline === 'keep'
          ? undefined
          : op.deadline === 'clear'
            ? null
            : pickDeadline(world, op.deadline, op.r);
      const body = {
        ...(op.target === null ? {} : { targetAmount: op.target }),
        ...(deadline === undefined ? {} : { deadline }),
        ...(op.archived === 'keep' ? {} : { archived: op.archived === 'archive' }),
        ...(op.rename
          ? { name: `  Renamed ${op.r} `, color: op.r % 2 === 0 ? '#ABCDEF' : null }
          : {}),
      };
      const verdict: Verdict<ModelGoal> =
        Object.keys(body).length === 0
          ? { ok: false, refusal: { status: 400, code: 'validation_error' } }
          : predictGoalPatch(world, id, body);
      const answer = await call(ctx.server, 'patch', `/api/goals/${id}`, body);
      checkAnswer(ctx, 'goal-patch', answer, verdict, 200);
      if (verdict.ok) {
        const index = world.goals.findIndex((goal) => goal.id === id);
        world.goals[index] = verdict.value;
        failIfAny(
          diff(
            answer.body,
            goalFigures(verdict.value, balanceOf(world, id), currentMonthOf(world)),
            'patched goal',
          ),
          'PATCH /api/goals/:id',
        );
        if (op.archived === 'archive' && balanceOf(world, id) !== 0)
          ctx.cov.hit('a goal archived with money in it');
        if (op.archived === 'unarchive') ctx.cov.hit('a goal brought back');
      }
      await finish(ctx, { refused: !verdict.ok, full: true });
      return;
    }

    case 'goalDelete': {
      const id = pickGoal(world, op.goal, gone) ?? missingGoalId(world, gone);
      const goal = world.goals.find((candidate) => candidate.id === id);
      const before = ctx.prev;
      const answer = await call(ctx.server, 'delete', `/api/goals/${id}`);
      const verdict: Verdict<null> = goal
        ? { ok: true, value: null }
        : { ok: false, refusal: { status: 404, code: 'not_found' } };
      checkAnswer(ctx, 'goal-delete', answer, verdict, 204);
      if (goal) {
        const held = balanceOf(world, id);
        withoutGoal(world, id);
        gone.push(id);
        ctx.cov.hit(held !== 0 ? 'a goal deleted with money in it' : 'a goal deleted empty');
        const snap = await finish(ctx, { refused: false, full: true });
        // Invariant 6: deleting a goal changes neither the balance nor any other goal; its money is unassigned.
        failIfAny(
          [
            ...sameBalance(snap, before),
            ...diff(snap.savings.unassigned, before.savings.unassigned + held, 'unassigned'),
            ...diff(
              snap.savings.goals.map((other) => [other.id, other.balance]),
              before.savings.goals
                .filter((other) => other.id !== id)
                .map((other) => [other.id, other.balance]),
              'the other goals',
            ),
          ],
          'deleting a goal',
        );
      } else {
        await finish(ctx, { refused: true, full: true });
      }
      return;
    }

    case 'deposit':
    case 'withdraw':
    case 'reallocate': {
      const body = buildManualBody(world, op, gone);
      const verdict = predictManual(world, body);
      const before = ctx.prev;
      const answer = await call(ctx.server, 'post', '/api/savings/transactions', body);
      checkAnswer(ctx, `${body.kind}`, answer, verdict, 201);
      if (verdict.ok) {
        adoptRows(ctx, verdict.value, answer.body as SavingsTransactionDto[], body.kind);
        ctx.cov.hit(`${body.kind} accepted`);
        if (body.kind !== 'deposit') {
          const source = body.kind === 'withdrawal' ? (body.goalId ?? null) : body.fromGoalId;
          if (balanceOf(world, source) === 0)
            ctx.cov.hit(`${body.kind} of exactly the whole balance`);
          if (source !== null && world.goals.find((goal) => goal.id === source)?.archived) {
            ctx.cov.hit(`${body.kind} out of an archived goal`);
          }
        }
      }
      const snap = await finish(ctx, { refused: !verdict.ok });
      if (verdict.ok && body.kind === 'reallocation') {
        // Invariant 6: a reallocation never changes the savings balance.
        failIfAny(sameBalance(snap, before), 'a reallocation');
      }
      return;
    }

    case 'settle': {
      const month = pickSettleMonth(world, op.month, op.mi);
      const body = buildSettleBody(world, op, month, ctx.seen.get(month), gone);
      const current = outstandingOf(world, month);
      if (ctx.seen.get(month)?.has(body.amount) && body.amount !== current) {
        ctx.cov.hit('a settle with a figure seen earlier that is stale now');
      }
      await settleRequest(ctx, month, body);
      return;
    }

    case 'undo': {
      const month = pickSettleMonth(world, op.mode === 'none' ? 'current' : op.mode, op.mi);
      await undoRequest(ctx, month);
      return;
    }

    case 'roundTrip': {
      // Invariant 7: settling a month that had no settlement and undoing it at once leaves everything as it was.
      const open = ctx.prev.savings.outstanding.filter(
        (entry) =>
          !ctx.prev.rows.some(
            (row) => row.kind === 'settlement' && row.settlesMonth === entry.month,
          ),
      );
      if (open.length === 0) {
        ctx.cov.hit('round trip skipped');
        return;
      }
      const entry = open[op.mi % open.length]!;
      const goal = world.goals.find((candidate) => !candidate.archived);
      const sign = Math.sign(entry.outstanding);
      const split =
        op.withGoal && goal && Math.abs(entry.outstanding) >= 2
          ? {
              allocations: [
                { goalId: goal.id, amount: sign },
                { goalId: null, amount: entry.outstanding - sign },
              ],
            }
          : {};
      const before = canonical(ctx.prev);
      const accepted = await settleRequest(ctx, entry.month, {
        amount: entry.outstanding,
        ...split,
      });
      if (!accepted) throw new Error(`the exact outstanding of ${entry.month} was refused`);
      await undoRequest(ctx, entry.month);
      failIfAny(
        canonical(ctx.prev) === before
          ? []
          : diff(JSON.parse(canonical(ctx.prev)), JSON.parse(before), 'state'),
        'settle then undo at once did not leave everything as it was',
      );
      ctx.cov.hit('settle then undo at once');
      return;
    }

    case 'deleteRow': {
      const plain = world.rows.filter((row) =>
        ['deposit', 'withdrawal', 'reallocation'].includes(row.kind),
      );
      const settlements = world.rows.filter((row) => row.kind === 'settlement');
      const unknown =
        Math.max(0, ...world.rows.map((row) => row.id), ...ctx.goneRows) + 1 + (op.i % 3);
      let id = unknown;
      const pairs = plain.filter((row) => row.kind === 'reallocation');
      if (op.k === 'pair' && pairs.length > 0) id = pairs[op.i % pairs.length]!.id;
      else if (op.k === 'plain' && plain.length > 0) id = plain[op.i % plain.length]!.id;
      else if (op.k === 'settlement' && settlements.length > 0)
        id = settlements[op.i % settlements.length]!.id;
      else if (op.k === 'opening') id = world.rows.find((row) => row.kind === 'opening')!.id;
      else if (op.k === 'gone' && ctx.goneRows.length > 0)
        id = ctx.goneRows[op.i % ctx.goneRows.length]!;
      const verdict = predictDeleteRow(world, id);
      const before = ctx.prev;
      const answer = await call(ctx.server, 'delete', `/api/savings/transactions/${id}`);
      checkAnswer(ctx, 'delete-row', answer, verdict, 204);
      if (verdict.ok) {
        const removed = world.rows.filter((row) => verdict.value.includes(row.id));
        world.rows = world.rows.filter((row) => !verdict.value.includes(row.id));
        ctx.goneRows.push(...verdict.value);
        ctx.cov.hit(
          removed.length === 2
            ? 'delete-row accepted, a reallocation (both rows)'
            : 'delete-row accepted',
        );
      }
      const snap = await finish(ctx, { refused: !verdict.ok });
      if (verdict.ok && before.rows.length - snap.rows.length !== verdict.value.length) {
        throw new Error('deleting a row did not remove exactly its rows');
      }
      return;
    }

    case 'lateSpending': {
      const { budgets } = world.facts;
      if (budgets.length === 0) return;
      const budget = budgets[op.budget % budgets.length]!;
      const low = Math.max(monthIndex(world.facts.startMonth), monthIndex(budget.startMonth));
      const month = pickEditMonth(world, low, op.mi, op.target);
      await postSpending(ctx, budget.id, month, op.day, op.refund ? -op.amount : op.amount);
      return;
    }

    case 'lateIncome': {
      const month = pickEditMonth(world, monthIndex(world.facts.startMonth), op.mi, op.target);
      const day = dayIn(world, month, op.day);
      const answer = await call(ctx.server, 'post', '/api/incomes', {
        date: `${month}-${pad(day)}`,
        amount: op.amount,
        description: 'late',
      });
      failIfAny(
        answer.status === 201 ? [] : [`status ${answer.status} ${JSON.stringify(answer.body)}`],
        'POST /api/incomes',
      );
      const fact: IncomeFact = { month, amount: op.amount };
      world.facts.incomes.push(fact);
      ctx.edits.push({ id: answer.body.id as number, kind: 'income', fact });
      if (month < currentMonthOf(world)) ctx.cov.hit('a late income in a closed month');
      if (settledMonths(world).includes(month)) ctx.cov.hit('a late edit to a settled month');
      await finish(ctx, { refused: false, months: true });
      return;
    }

    case 'netZero': {
      // A month settled by +D, whose savings due then falls to 0 (a spending of D on a budget that is
      // not incremental takes exactly D from it), is settled by -D: its settlements net to 0, and
      // when the spending is taken back the month is outstanding by D again, as an adjustment with
      // `settled` 0. Every step is checked like any other operation.
      const budgetFor = (month: string) =>
        world.facts.budgets.find(
          (budget) =>
            budget.endMonth === null &&
            monthIndex(budget.startMonth) <= monthIndex(month) &&
            !budget.versions.some(
              (version) =>
                version.incremental && monthIndex(version.effectiveMonth) <= monthIndex(month),
            ),
        );
      const open = ctx.prev.savings.outstanding.filter(
        (entry) => settlementRowsOf(world, entry.month).length === 0 && budgetFor(entry.month),
      );
      if (open.length === 0) {
        ctx.cov.hit('net-to-zero skipped');
        return;
      }
      const entry = open[op.mi % open.length]!;
      const due = entry.outstanding;
      if (!(await settleRequest(ctx, entry.month, { amount: due })))
        throw new Error('settle refused');
      await postSpending(ctx, budgetFor(entry.month)!.id, entry.month, 10, due);
      const after = ctx.prev.savings.outstanding.find(
        (candidate) => candidate.month === entry.month,
      );
      if (after?.outstanding !== -due) {
        throw new Error(`a spending of ${due} should leave ${entry.month} outstanding by ${-due}`);
      }
      if (!(await settleRequest(ctx, entry.month, { amount: -due })))
        throw new Error('settle refused');
      failIfAny(
        ctx.prev.savings.outstanding.some((candidate) => candidate.month === entry.month)
          ? ['the month is still listed']
          : [],
        'a month settled and then settled back to 0',
      );
      await execute(ctx, { t: 'revert' });
      const back = ctx.prev.savings.outstanding.find(
        (candidate) => candidate.month === entry.month,
      );
      failIfAny(
        diff(
          back && {
            settled: back.settled,
            outstanding: back.outstanding,
            adjustment: back.adjustment,
          },
          { settled: 0, outstanding: due, adjustment: true },
          `${entry.month} after the spending is taken back`,
        ),
        'a month whose settlements net to 0',
      );
      ctx.cov.hit('net-to-zero month');
      return;
    }

    case 'revert': {
      const edit = ctx.edits.pop();
      if (!edit) return;
      await send(
        ctx.server,
        'delete',
        `/api/${edit.kind === 'spending' ? 'spendings' : 'incomes'}/${edit.id}`,
        undefined,
        204,
      );
      if (edit.kind === 'spending')
        world.facts.spendings.splice(world.facts.spendings.indexOf(edit.fact as SpendingFact), 1);
      else world.facts.incomes.splice(world.facts.incomes.indexOf(edit.fact as IncomeFact), 1);
      ctx.cov.hit('a late edit reverted');
      await finish(ctx, { refused: false, months: true });
      return;
    }

    case 'salaryPut': {
      const low = monthIndex(world.facts.startMonth);
      const high = monthIndex(currentMonthOf(world));
      const month = monthKey(low + (op.mi % (high - low + 1)));
      await send(ctx.server, 'put', `/api/salary/${month}`, { amount: op.amount });
      const row = world.facts.salary.find((candidate) => candidate.effectiveMonth === month);
      if (row) row.amount = op.amount;
      else world.facts.salary.push({ effectiveMonth: month, amount: op.amount });
      await finish(ctx, { refused: false, months: true });
      return;
    }

    case 'salaryDelete': {
      const { salary } = world.facts;
      if (salary.length === 0) return;
      const row = salary[op.i % salary.length]!;
      await send(ctx.server, 'delete', `/api/salary/${row.effectiveMonth}`, undefined, 204);
      salary.splice(salary.indexOf(row), 1);
      await finish(ctx, { refused: false, months: true });
      return;
    }

    case 'opening': {
      const answer = await call(ctx.server, 'put', '/api/savings/opening', { amount: op.amount });
      failIfAny(
        answer.status === 200
          ? diff(
              answer.body,
              { amount: op.amount, date: firstDay(world.facts.startMonth) },
              'answer',
            )
          : [`status ${answer.status}`],
        'PUT /api/savings/opening',
      );
      world.rows.find((row) => row.kind === 'opening')!.amount = op.amount;
      ctx.cov.hit('opening balance changed');
      await finish(ctx, { refused: false, full: true });
      return;
    }

    case 'moveStart': {
      const target = monthKey(monthIndex(world.facts.startMonth) + op.delta);
      const verdict = predictMoveStart(world, target);
      const answer = await call(ctx.server, 'put', '/api/settings', {
        currency: 'EUR',
        locale: 'en-US',
        startMonth: target,
        theme: 'system',
        alertWarnPercent: 80,
      });
      checkAnswer(ctx, 'move-start', answer, verdict, 200);
      if (verdict.ok) {
        if (op.delta > 0) ctx.cov.hit('start month moved later');
        if (op.delta < 0) ctx.cov.hit('start month moved earlier');
        failIfAny(
          diff((answer.body as SettingsDto).startMonth, target, 'startMonth'),
          'PUT /api/settings',
        );
        moveStart(world, target);
      } else if (op.delta > 0) {
        ctx.cov.hit(`start month moved later, refused (${verdict.refusal.rule})`);
      }
      await finish(ctx, { refused: !verdict.ok, months: verdict.ok, full: true });
      return;
    }
  }
}

// -------------------------------------------------------------------------------------------------
// A run
// -------------------------------------------------------------------------------------------------

/** Builds the world of `setup` through the public endpoints, and the model of it. */
async function createContext(setup: Setup, cov: Coverage): Promise<Ctx> {
  const startIndex = monthIndex('2025-01') + setup.startOffset;
  const start = monthKey(startIndex);
  const today = `${monthKey(startIndex + setup.closed)}-${pad(setup.day)}`;
  const clock = mutableClock(`${today}T12:00:00Z`);
  const { app } = createTestApp(clock);
  const server = await serve(app);
  try {
    // Onboarding stores the first salary at the start month; the "later" worlds move it one month on.
    await send(
      server,
      'post',
      '/api/onboarding',
      {
        currency: 'EUR',
        locale: 'en-US',
        startMonth: start,
        alertWarnPercent: 80,
        salary: setup.later ? 0 : setup.salary,
        openingSavings: setup.opening,
      },
      201,
    );
    const salary: { effectiveMonth: string; amount: number }[] = [];
    if (setup.later) {
      await send(server, 'put', `/api/salary/${monthKey(startIndex + 1)}`, {
        amount: setup.salary,
      });
      await send(server, 'delete', `/api/salary/${start}`, undefined, 204);
      salary.push({ effectiveMonth: monthKey(startIndex + 1), amount: setup.salary });
    } else {
      salary.push({ effectiveMonth: start, amount: setup.salary });
    }
    if (setup.raise) {
      const amount = Math.round(setup.salary * 1.1);
      await send(server, 'put', `/api/salary/${monthKey(startIndex + 2)}`, { amount });
      salary.push({ effectiveMonth: monthKey(startIndex + 2), amount });
    }

    const first = monthKey(startIndex + (setup.later ? 1 : 0));
    const budgets: BudgetFact[] = [];
    for (const [index, budget] of setup.budgets.entries()) {
      const startMonth = index === 2 ? monthKey(startIndex + 1) : first;
      const created = await send(
        server,
        'post',
        '/api/budgets',
        {
          name: `Budget ${index}`,
          amount: budget.amount,
          incremental: budget.incremental,
          startMonth,
          sortOrder: index * 10,
        },
        201,
      );
      budgets.push({
        id: created.id,
        name: created.name,
        color: created.color,
        icon: created.icon,
        sortOrder: created.sortOrder,
        startMonth: created.startMonth,
        endMonth: null,
        alertWarnPercent: created.alertWarnPercent,
        versions: [
          {
            effectiveMonth: created.startMonth,
            amount: budget.amount,
            incremental: budget.incremental,
          },
        ],
      });
    }
    const subscriptions: SubscriptionFact[] = [];
    const subscriptionInputs = [
      {
        name: 'Netflix',
        frequency: 'monthly' as const,
        anchorDate: `${first}-15`,
        amount: setup.monthlySub,
      },
      {
        name: 'Insurance',
        frequency: 'yearly' as const,
        anchorDate: `${first.slice(0, 4)}-${pad(setup.yearlyMonth)}-15`,
        amount: setup.yearlySub,
      },
    ];
    for (const input of subscriptionInputs) {
      const created = await send(
        server,
        'post',
        '/api/subscriptions',
        { ...input, startMonth: first },
        201,
      );
      subscriptions.push({
        id: created.id,
        name: input.name,
        color: created.color ?? null,
        frequency: input.frequency,
        anchorDate: input.anchorDate,
        startMonth: first,
        endMonth: null,
        prices: [{ effectiveMonth: first, amount: input.amount }],
      });
    }

    const world: World = {
      today,
      facts: {
        startMonth: start,
        alertWarnPercent: 80,
        salary,
        incomes: [],
        subscriptions,
        budgets,
        spendings: [],
        transfers: [],
      },
      goals: [],
      rows: [],
    };
    for (const [index, goal] of setup.goals.entries()) {
      const deadline = goal.deadline ? `${monthKey(startIndex + setup.closed + 2)}-15` : undefined;
      const created = await send(
        server,
        'post',
        '/api/goals',
        {
          name: `Start goal ${index}`,
          targetAmount: goal.target,
          ...(deadline ? { deadline } : {}),
        },
        201,
      );
      if (goal.archived)
        await send(server, 'patch', `/api/goals/${created.id}`, { archived: true });
      world.goals.push({
        id: created.id,
        name: `Start goal ${index}`,
        targetAmount: goal.target,
        deadline: deadline ?? null,
        color: null,
        archived: goal.archived,
      });
    }
    // The one row of the world: onboarding's opening balance. Its id is the only thing taken from the API.
    const opening = await send(server, 'get', '/api/savings/transactions?kind=opening');
    failIfAny(
      diff(
        opening.items.map(({ id: _id, ...row }: ModelRow) => row),
        [
          {
            date: firstDay(start),
            kind: 'opening',
            amount: setup.opening,
            goalId: null,
            settlesMonth: null,
            note: null,
            groupId: null,
          },
        ],
        'the opening row',
      ),
      'onboarding',
    );
    world.rows.push(opening.items[0] as ModelRow);

    const ctx: Ctx = {
      server,
      clock,
      world,
      cov,
      edits: [],
      goneGoals: [],
      goneRows: [],
      seen: new Map(),
      prev: undefined as unknown as Snapshot,
      step: 0,
    };
    ctx.prev = await readSnapshot(ctx, true);
    await finish(ctx, { refused: false, months: true, full: true });
    return ctx;
  } catch (error) {
    await stop(server);
    throw error;
  }
}

/** Runs `ops` from the world of `setup`, checking everything after every operation. */
export async function runSequence(setup: Setup, ops: readonly Op[], cov: Coverage): Promise<void> {
  const ctx = await createContext(setup, cov);
  try {
    for (const [index, op] of ops.entries()) {
      ctx.step = index + 1;
      try {
        await execute(ctx, op);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `step ${ctx.step} of ${ops.length}, ${JSON.stringify(op)} (today ${ctx.world.today}): ${message}`,
          {
            cause: error,
          },
        );
      }
    }
    // Whatever the last operation was, end with every read and the month summaries.
    await finish(ctx, { refused: false, months: true, full: true });
  } finally {
    await stop(ctx.server);
  }
}
