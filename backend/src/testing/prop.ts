/**
 * Plumbing shared by the property tests: the fixed seed and run counts, a structural diff that
 * names the first differing figures, a canonical string for exact comparison, and a coverage
 * counter so a property cannot pass because the generator never produced the case it is about.
 *
 * Reproducing a failure: fast-check prints the seed, the path and the shrunk counterexample. The
 * seed is fixed (`FC_SEED`, default below) so CI is stable; a deeper sweep is
 * `FC_RUNS_FACTOR=20 npx vitest run src/domain/ledger.property.test.ts`, and a different seed is
 * `FC_SEED=123 ...`. To replay one failure pass the printed `seed` and `path` to `fc.assert`.
 */
import { expect } from 'vitest';

export const SEED = Number(process.env['FC_SEED'] ?? 20261002);

/** Multiplies every property's run count (default 1), for a deeper sweep than CI runs. */
const FACTOR = Number(process.env['FC_RUNS_FACTOR'] ?? 1);

/** `fc.assert` parameters: the fixed seed and `runs` iterations (times the sweep factor). */
export const config = (runs: number) => ({
  seed: SEED,
  numRuns: Math.max(1, Math.round(runs * FACTOR)),
});

/** Per-test timeout (ms): generous, because a loaded machine runs several packages at once (and a deeper sweep takes longer). */
export const SLOW = 120_000 * Math.max(1, FACTOR);

/** JSON with the keys of every object sorted, so equal values give equal strings. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/**
 * The paths at which two values differ, as `path: actual, expected` strings (at most `limit`), for a
 * failure message that names the figure. Numbers and strings are compared with `Object.is`.
 */
export function diff(actual: unknown, expected: unknown, path = '', limit = 6): string[] {
  const found: string[] = [];
  const walk = (a: unknown, e: unknown, at: string): void => {
    if (found.length >= limit) return;
    if (Array.isArray(a) && Array.isArray(e)) {
      if (a.length !== e.length) {
        found.push(`${at}.length: ${a.length}, expected ${e.length}`);
        return;
      }
      a.forEach((item, index) => walk(item, e[index], `${at}[${index}]`));
    } else if (
      a !== null &&
      e !== null &&
      typeof a === 'object' &&
      typeof e === 'object' &&
      !Array.isArray(a) &&
      !Array.isArray(e)
    ) {
      const keys = new Set([...Object.keys(a), ...Object.keys(e)]);
      for (const key of keys) {
        walk(
          (a as Record<string, unknown>)[key],
          (e as Record<string, unknown>)[key],
          `${at}.${key}`,
        );
      }
    } else if (!Object.is(a, e)) {
      found.push(`${at}: ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`);
    }
  };
  walk(actual, expected, path);
  return found;
}

/** Throws one error listing `problems` (nothing happens when there are none). */
export function failIfAny(problems: readonly string[], what: string): void {
  if (problems.length > 0) {
    throw new Error(`${what}:\n  ${problems.slice(0, 8).join('\n  ')}`);
  }
}

/**
 * Counts how often the generated data had each interesting feature, then asserts a minimum for
 * each, so a property that quietly stopped exercising a case fails loudly.
 */
export function coverage<K extends string>() {
  const counts = new Map<K, number>();
  return {
    hit(name: K, by = 1): void {
      counts.set(name, (counts.get(name) ?? 0) + by);
    },
    expectAtLeast(minimums: Record<K, number>): void {
      // `FC_COVERAGE=1` prints how often each case was generated, to calibrate the minimums.
      if (process.env['FC_COVERAGE']) {
        const rows = [...counts.entries()].map(([name, n]) => `${String(n).padStart(8)}  ${name}`);
        console.log(`coverage:\n${rows.sort().join('\n')}`);
      }
      for (const [name, minimum] of Object.entries<number>(minimums)) {
        const seen = counts.get(name as K) ?? 0;
        expect(
          seen,
          `the generated data had ${seen} x "${name}", wanted at least ${minimum}`,
        ).toBeGreaterThanOrEqual(minimum * Math.min(1, FACTOR));
      }
    },
  };
}
