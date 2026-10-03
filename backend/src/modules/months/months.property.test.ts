/**
 * Property-based test of the whole path, through HTTP: generated facts are entered ONLY through the
 * public endpoints (onboarding, salary, incomes, budgets with versions, subscriptions with prices,
 * spendings, archive and cancel, a start month moved later), the clock is set to a generated
 * "today", and what `GET /api/months` and `GET /api/months/:month` answer must equal the independent
 * model of docs/DOMAIN.md computed from the same facts. The rows must also read back exactly as they
 * were entered: no version, price or salary row is lost or moved by archiving, cancelling or moving
 * a start month later ("Versioned values"), and SQL's month grouping and sums agree with plain
 * arithmetic. Transfers have no endpoint yet, so they are inserted into the database like the
 * other route tests do.
 *
 * Fixed seed (see testing/prop.ts), a few dozen runs because each one makes dozens of requests.
 */
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { mutableClock } from '../../testing/helpers';
import { config, diff, failIfAny, SLOW } from '../../testing/prop';
import {
  call,
  enterFacts,
  monthsProblems,
  readState,
  serve,
  stop,
  storedProblems,
  todayIndex,
} from '../../testing/prop-api';
import { scenarioArb, within } from '../../testing/prop-gen';
import { modelLedger, monthIndex, monthKey } from '../../testing/prop-model';
import { createTestApp } from '../../testing/test-app';

describe('the API shows the months the independent model predicts, for facts entered only through the endpoints', () => {
  it(
    'on a generated scenario: the stored rows, the month list, and a month view at the start, today, a generated month and the end',
    { timeout: SLOW },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          scenarioArb({ sequentialIds: true, maxMonths: 12, maxBudgets: 3, maxSubscriptions: 3 }),
          fc.integer({ min: 0, max: 9_999 }),
          async (scenario, pick) => {
            const { facts, through, today } = scenario;
            const clock = mutableClock(`${today}T12:00:00Z`);
            const { app: express, db } = createTestApp(clock);
            const app = await serve(express);
            try {
              await enterFacts(app, db, facts);

              const state = await readState(app, facts.transfers);
              const problems = storedProblems(state, facts);
              problems.push(
                ...(await monthsProblems(app, facts, through, today, [
                  0,
                  todayIndex(facts, today),
                  pick % 12,
                  Number.MAX_SAFE_INTEGER, // clamped to the last month
                ])),
              );
              failIfAny(problems, `the API differs from the model (today ${today})`);
            } finally {
              await stop(app);
            }
          },
        ),
        config(80),
      );
    },
  );

  it(
    'the window of GET /api/months (defaults, cuts at the start month and 120 months ahead, 400 for a bad range) and the 404s of GET /api/months/:month follow the contract',
    { timeout: SLOW },
    async () => {
      const seen = {
        empty: 0,
        cutAtStart: 0,
        cutAtHorizon: 0,
        defaulted: 0,
        refused: 0,
        listed: 0,
      };
      await fc.assert(
        fc.asyncProperty(
          scenarioArb({ sequentialIds: true, maxMonths: 12, maxBudgets: 2, maxSubscriptions: 2 }),
          fc.array(
            fc.record({
              from: fc.integer({ min: 0, max: 9_999 }),
              to: fc.integer({ min: 0, max: 9_999 }),
              fromKind: fc.integer({ min: 0, max: 4 }),
              toKind: fc.integer({ min: 0, max: 4 }),
            }),
            { minLength: 3, maxLength: 5 },
          ),
          async (scenario, queries) => {
            const { facts, today } = scenario;
            const clock = mutableClock(`${today}T12:00:00Z`);
            const { app: express, db } = createTestApp(clock);
            const app = await serve(express);
            try {
              await enterFacts(app, db, facts);
              const start = monthIndex(facts.startMonth);
              const current = monthIndex(today.slice(0, 7));
              const horizon = current + 120; // "Projections stop 120 months after the current month"
              // One model run through the horizon serves every query.
              const model = modelLedger(facts, monthKey(horizon), today);
              const problems: string[] = [];

              // A month for a query parameter: absent, or right at one of the edges that matter.
              const choose = (kind: number, pick: number): number | undefined => {
                const edges = [start, current, current + 11, horizon];
                if (kind === 0) return undefined;
                if (kind === 1) return within(pick, start - 3, horizon + 3);
                return edges[(kind + pick) % edges.length]! + within(pick, 0, 4) - 2;
              };
              for (const q of queries) {
                const from = choose(q.fromKind, q.from);
                const to = choose(q.toKind, q.to);
                const query = [
                  from === undefined ? '' : `from=${monthKey(from)}`,
                  to === undefined ? '' : `to=${monthKey(to)}`,
                ]
                  .filter(Boolean)
                  .join('&');
                const answer = await call(app, 'get', `/api/months${query ? `?${query}` : ''}`);
                // The contract (shared/src/months.ts): `to` defaults to the current month + 11, `from`
                // to the start month but never earlier than `to` - 119; `from` after `to`, or 120
                // months or more between them, is a 400; the range is then cut to the tracked months.
                const toEffective = to ?? current + 11;
                if (
                  (from !== undefined && from > toEffective) ||
                  (from !== undefined && toEffective - from >= 120)
                ) {
                  seen.refused++;
                  if (answer.status !== 400 || answer.body?.error?.code !== 'validation_error') {
                    problems.push(
                      `?${query}: expected a 400 validation_error, got ${answer.status}`,
                    );
                  }
                  continue;
                }
                const fromEffective = from ?? Math.max(start, toEffective - 119);
                const first = Math.max(fromEffective, start);
                const last = Math.min(toEffective, horizon);
                const expected =
                  first > last
                    ? []
                    : model
                        .filter(
                          (m) =>
                            monthIndex(m.view.month) >= first && monthIndex(m.view.month) <= last,
                        )
                        .map(({ view }) => ({
                          month: view.month,
                          status: view.status,
                          income: view.income.total,
                          fixedCosts: view.fixedCosts,
                          allocated: view.totals.allocated,
                          spent: view.totals.spent,
                          unallocated: view.unallocated,
                          savingsDue: view.savingsDue.total,
                        }));
                seen.listed++;
                if (expected.length === 0) seen.empty++;
                if (from !== undefined && from < start) seen.cutAtStart++;
                if (to !== undefined && to > horizon) seen.cutAtHorizon++;
                if (from === undefined || to === undefined) seen.defaulted++;
                if (answer.status !== 200) {
                  problems.push(
                    `?${query}: expected 200, got ${answer.status} ${JSON.stringify(answer.body)}`,
                  );
                } else {
                  problems.push(...diff(answer.body, expected, `GET /api/months?${query}`));
                }
              }

              // A month before the start month or after the horizon does not exist.
              for (const month of [start - 1, start - 20, horizon + 1, horizon + 50]) {
                const answer = await call(app, 'get', `/api/months/${monthKey(month)}`);
                if (answer.status !== 404)
                  problems.push(`${monthKey(month)}: expected 404, got ${answer.status}`);
              }
              // ... and the first and the last one do.
              for (const month of [start, horizon]) {
                const answer = await call(app, 'get', `/api/months/${monthKey(month)}`);
                if (answer.status !== 200)
                  problems.push(`${monthKey(month)}: expected 200, got ${answer.status}`);
              }
              failIfAny(problems, `the month window differs from the contract (today ${today})`);
            } finally {
              await stop(app);
            }
          },
        ),
        config(40),
      );
      // The generated queries covered every branch of the window logic.
      if (process.env['FC_RUNS_FACTOR'] === undefined) {
        const missing = Object.entries(seen)
          .filter(([, n]) => n === 0)
          .map(([name]) => name);
        if (missing.length > 0) throw new Error(`the queries never covered: ${missing.join(', ')}`);
      }
    },
  );
});
