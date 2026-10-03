/** Helpers for the table-driven schema tests. Test-only: not exported from index.ts. */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

/** `[label, input]`: the input must parse. */
export type ValidCase = [label: string, input: unknown];
/** `[label, input, issuePath]`: parsing must fail with an issue at `issuePath` ('' = whole body). */
export type InvalidCase = [label: string, input: unknown, issuePath: string];

/**
 * Runs one `it` per row. Invalid rows also pin the path of the issue, so a case cannot pass because
 * of a typo elsewhere in the input.
 */
export function schemaCases(
  name: string,
  schema: z.ZodType,
  valid: ValidCase[],
  invalid: InvalidCase[],
): void {
  describe(name, () => {
    it.each(valid)('accepts %s', (_label, input) => {
      const result = schema.safeParse(input);
      expect(result.error?.issues).toBeUndefined();
    });

    it.each(invalid)('rejects %s', (_label, input, issuePath) => {
      const result = schema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(issuePath);
    });
  });
}

/** `[label, input, expectedOutput]`: the parsed value must equal `expectedOutput`. */
export type ParseCase = [label: string, input: unknown, expected: unknown];

/** Runs one `it` per row asserting the parsed (normalized) output. */
export function parseCases(name: string, schema: z.ZodType, cases: ParseCase[]): void {
  describe(name, () => {
    it.each(cases)('parses %s', (_label, input, expected) => {
      expect(schema.parse(input)).toEqual(expected);
    });
  });
}

/** `'x'.repeat(n)`, for length-limit cases. */
export const chars = (n: number): string => 'x'.repeat(n);
