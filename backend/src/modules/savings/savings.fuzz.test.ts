/**
 * The savings operation fuzz: random sequences of operations over HTTP, with the fixed clock moving
 * forward between them, checked after EVERY operation against the independent model
 * (`testing/savings-model.ts`), which is written from docs/DOMAIN.md alone. See
 * `testing/savings-fuzz.ts` for what is asserted at each step.
 *
 * Reproducing a failure: fast-check prints the seed, the path and the shrunk counterexample (the
 * setup and the operations, as data). The seed is fixed (`FC_SEED`, default in `testing/prop.ts`) so
 * CI is stable; a deeper sweep is `FC_RUNS_FACTOR=10 npx vitest run src/modules/savings/savings.fuzz.test.ts`.
 * `FC_COVERAGE=1` prints how often each interesting case was generated.
 */
import * as fc from 'fast-check';
import { describe, it } from 'vitest';
import { SLOW, config, coverage } from '../../testing/prop';
import { runSequence } from '../../testing/savings-fuzz';
import { opArbOf, setupArb } from '../../testing/savings-fuzz-gen';

describe('savings operation fuzz', () => {
  it(
    'the API is what docs/DOMAIN.md says after every operation, and a refused request changes nothing',
    async () => {
      const cov = coverage<string>();
      await fc.assert(
        fc.asyncProperty(
          setupArb,
          fc.array(opArbOf('general'), { minLength: 20, maxLength: 50 }),
          async (setup, ops) => {
            await runSequence(setup, ops, cov);
          },
        ),
        config(36),
      );
      // The cases this property is about must really have been generated (see `FC_COVERAGE=1`).
      cov.expectAtLeast({
        'settle accepted': 25,
        'settle accepted, split': 6,
        'settle accepted, negative (take from savings)': 7,
        'settle accepted, to a goal': 6,
        'settle accepted, an adjustment of a settled month': 6,
        'settle refused outstanding_changed': 10,
        'settle refused rule_violation allocation_mismatch allocations': 3,
        'settle refused rule_violation month_not_closed month': 8,
        'settle refused nothing_to_settle': 2,
        'settle refused not_found': 3,
        'settle refused validation_error': 20,
        'undo accepted': 10,
        'settle then undo at once': 9,
        'net-to-zero month': 6,
        'a late edit to a settled month': 12,
        'a late edit reverted': 10,
        'a late refund in a closed month': 4,
        'a late income in a closed month': 6,
        'deposit accepted': 20,
        'withdrawal accepted': 5,
        'reallocation accepted': 2,
        'withdrawal of exactly the whole balance': 2,
        'withdrawal refused rule_violation insufficient_balance amount': 10,
        'reallocation refused rule_violation insufficient_balance amount': 8,
        'a goal deleted with money in it': 1,
        'a goal below 0': 3,
        'unassigned below 0': 8,
        'total balance below 0': 5,
        'delete-row accepted': 3,
        'delete-row refused not_deletable': 2,
        'delete-row accepted, a reallocation (both rows)': 2,
        'start month moved later': 1,
        'start month moved earlier': 6,
        'start month moved later, refused (start_month_after_facts)': 3,
        'opening balance changed': 10,
        'the clock crossed a month boundary': 25,
        'adjustment month whose settlements net to 0': 50,
        'three or more outstanding months at once': 100,
      });
    },
    SLOW,
  );
});
