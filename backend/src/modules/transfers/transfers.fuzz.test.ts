/**
 * The transfers operation fuzz: random sequences of operations over HTTP, with the clock moving
 * forward between them, checked after every one against independent models of docs/DOMAIN.md.
 *
 * The operations are transfers (created, deleted, created and deleted at once, dated in a settled
 * month, in a budget's last month), spendings and incomes, salary, budget edits (versions, start
 * and end months, creation, deletion), settling and undoing, the start month, and the clock. A
 * request is often wrong on purpose, in one way or in several at once (and now and then on both
 * sides of the transfer, which the doc says is reported on the source), and the first rule broken
 * in the documented order is predicted. See `testing/transfers-fuzz.ts` for what is asserted:
 * the answer, that a refusal changed nothing, the month list and the months around the fact after
 * every operation (and every month and every stored row every seventh step and at the end), the
 * savings, invariants 1, 2, 5 and 8, "a stored transfer is counted", and "delete restores".
 *
 * Reproducing a failure: fast-check prints the seed, the path and the shrunk counterexample (the
 * setup and the operations, as data), and the error names the step, the operation and today's
 * date. The seed is fixed (`FC_SEED`, default in `testing/prop.ts`) so CI is stable; a deeper sweep
 * is `FC_RUNS_FACTOR=10 npx vitest run src/modules/transfers/transfers.fuzz.test.ts`, another seed
 * `FC_SEED=123 ...`. `FC_COVERAGE=1` prints how often each interesting case was generated. The
 * minimums at the end are calibrated for the default seed (and kept under what seven seeds gave):
 * with another seed a rare case can come up fewer times, and the message then says which, which
 * is a miss of the generator and not a failure of the property. A failing run is shrunk for at
 * most half of the test's timeout (`boundedConfig`) and then reports the smallest it found.
 */
import * as fc from 'fast-check';
import { describe, it } from 'vitest';
import { SLOW, boundedConfig, coverage } from '../../testing/prop';
import { opArb, seedArb, setupArb } from '../../testing/transfers-fuzz-gen';
import { runSequence } from '../../testing/transfers-fuzz';

describe('transfers operation fuzz', () => {
  it(
    'after every operation the API is what docs/DOMAIN.md says, a refused request changes nothing, and the identities hold',
    async () => {
      const cov = coverage<string>();
      await fc.assert(
        fc.asyncProperty(
          setupArb,
          fc.array(seedArb, { minLength: 3, maxLength: 6 }),
          fc.array(opArb, { minLength: 10, maxLength: 18 }),
          async (setup, seed, ops) => {
            await runSequence(setup, [...seed, ...ops], cov);
          },
        ),
        boundedConfig(12),
      );
      // The cases this property is about must really have been generated (see `FC_COVERAGE=1`).
      cov.expectAtLeast({
        // Every kind of transfer, in a closed, the current and a future month (the scenario tests
        // check each of the nine cells by hand; here they come up at random among everything else).
        'transfer accepted pool->budget': 9,
        'transfer accepted budget->pool': 7,
        'transfer accepted budget->budget': 15,
        'transfer accepted in a closed month': 15,
        'transfer accepted in a current month': 6,
        'transfer accepted in a future month': 6,
        'transfer accepted across modes': 2,
        'transfer accepted over what the source holds': 12,
        'transfer accepted into a settled month': 3,
        "transfer accepted in a budget's last month": 2,
        'transfer accepted with a note': 2,
        'transfer deleted': 8,
        'transfer delete refused not_found': 1,
        // The first rule broken is reported, and when both sides break the same rule the source is
        // named (the scenario file transfers.rules.scenario.test.ts pins each case by hand; the
        // `sideProbe` operation sends them in random worlds, and the plain transfers add more).
        'transfer refused validation_error': 2,
        'transfer refused unknown_budget': 8,
        'transfer refused before_start_month': 1,
        'transfer refused outside_active_months': 7,
        'transfer refused unknown_budget at fromBudgetId': 6,
        'transfer refused unknown_budget at toBudgetId': 2,
        'transfer refused outside_active_months at fromBudgetId': 3,
        'transfer refused outside_active_months at toBudgetId': 3,
        'transfer refused unknown_budget, both sides': 3,
        'transfer refused outside_active_months, both sides': 2,
        'side probe': 1,
        // Delete restores.
        'round trip of a transfer': 1,
        'round trip of a spending': 1,
        'round trip of an income': 2,
        // The rules that keep a stored transfer counted: a budget's months, and deleting a budget.
        'budget archive refused because of a transfer': 2,
        'budget start refused because of a transfer': 3,
        'budget delete refused because of a transfer only': 1,
        'budget delete refused has_history': 1,
        'budget archive refused end_before_activity': 4,
        'budget start refused start_after_activity': 5,
        "budget archived in a transfer's month": 3,
        "a budget's last month": 2,
        'edge probe': 3,
        // Settling, and a late transfer into a settled month.
        'settle accepted': 6,
        'settle accepted, an adjustment': 1,
        'settle accepted, negative': 1,
        'settle refused outstanding_changed': 1,
        'undo accepted': 2,
        'late transfer: the month is settled': 4,
        'late transfer: the month showed an adjustment': 1,
        'late transfer: the adjustment is settled': 1,
        'late transfer: the deletion is settled': 1,
        'the clock crossed a month boundary': 3,
        'start month moved earlier': 1,
        'everything was compared': 30,
      });
    },
    SLOW,
  );
});
