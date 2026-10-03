/**
 * The savings operation fuzz, weighted towards the "move to savings" list: settling, undoing,
 * correcting a settled month after a late edit, the optimistic lock, a month settled back to 0, and
 * the clock moving on. Same driver and same checks as `savings.fuzz.test.ts` (see
 * `testing/savings-fuzz.ts`), another mix of operations (`testing/savings-fuzz-gen.ts`).
 *
 * A deeper sweep: `FC_RUNS_FACTOR=10 npx vitest run src/modules/savings/savings.fuzz.books.test.ts`.
 * `FC_COVERAGE=1` prints how often each interesting case was generated.
 */
import * as fc from 'fast-check';
import { describe, it } from 'vitest';
import { SLOW, config, coverage } from '../../testing/prop';
import { runSequence } from '../../testing/savings-fuzz';
import { opArbOf, setupArb } from '../../testing/savings-fuzz-gen';

describe('savings operation fuzz, the books', () => {
  it(
    'every settlement, undo and adjustment is what docs/DOMAIN.md says, and the lock fires exactly when the figure is stale',
    async () => {
      const cov = coverage<string>();
      await fc.assert(
        fc.asyncProperty(
          setupArb,
          fc.array(opArbOf('books'), { minLength: 25, maxLength: 60 }),
          async (setup, ops) => {
            await runSequence(setup, ops, cov);
          },
        ),
        config(30),
      );
      // The cases this property is about must really have been generated (see `FC_COVERAGE=1`).
      cov.expectAtLeast({
        'settle accepted': 50,
        'settle accepted, split': 10,
        'settle accepted, negative (take from savings)': 15,
        'settle accepted, to a goal': 10,
        'settle accepted, an adjustment of a settled month': 15,
        'settle refused outstanding_changed': 15,
        'settle refused rule_violation allocation_mismatch allocations': 6,
        'settle refused rule_violation month_not_closed month': 10,
        'settle refused nothing_to_settle': 3,
        'a settle with a figure seen earlier that is stale now': 7,
        'undo accepted': 20,
        'settle then undo at once': 12,
        'net-to-zero month': 12,
        'a late edit to a settled month': 40,
        'a late edit reverted': 25,
        'adjustment month whose settlements net to 0': 100,
      });
    },
    SLOW,
  );
});
