/**
 * Guards the contract between docs/PLAN.md, the code and the tests: every `rule` listed for
 * `rule_violation` (422) in the PLAN.md table is a member of the shared type, is raised somewhere
 * in the modules, and is asserted in at least one route test.
 *
 * `NOT_YET_IMPLEMENTED` below is where a phase parks the rules whose contract and docs are written
 * before the endpoints that raise them. It is empty now: every rule of the PLAN.md table has its
 * service and its route test.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKEND_ROOT } from './lib/paths';

const REPO_ROOT = resolve(BACKEND_ROOT, '..');
const MODULES_DIR = join(BACKEND_ROOT, 'src', 'modules');

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

/** The rules of the PLAN.md table headed "| `rule` (422)". */
function rulesInPlan(): string[] {
  const lines = readFileSync(join(REPO_ROOT, 'docs', 'PLAN.md'), 'utf8').split('\n');
  const header = lines.findIndex((line) => line.startsWith('| `rule` (422)'));
  expect(header, 'the rule table in docs/PLAN.md').toBeGreaterThanOrEqual(0);
  const rules: string[] = [];
  for (const line of lines.slice(header + 2)) {
    const match = /^\|\s*`([a-z_]+)`\s*\|/.exec(line);
    if (!match?.[1]) break;
    rules.push(match[1]);
  }
  return rules;
}

/** The members of `RuleViolationRule` in shared/src/api.ts. */
function rulesInContract(): string[] {
  const source = readFileSync(join(REPO_ROOT, 'shared', 'src', 'api.ts'), 'utf8');
  const start = source.indexOf('export type RuleViolationRule');
  const end = source.indexOf(';', start);
  return [...source.slice(start, end).matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1] as string);
}

const files = filesUnder(MODULES_DIR).filter((file) => file.endsWith('.ts'));
const sources = files
  .filter((file) => !file.endsWith('.test.ts'))
  .map((f) => readFileSync(f, 'utf8'));
const tests = files.filter((file) => file.endsWith('.test.ts')).map((f) => readFileSync(f, 'utf8'));

/**
 * Rules that the shared contract and docs/PLAN.md already list but no service raises yet: a phase
 * writes its contracts first, and the services come in the next step. Their "raised" and "asserted"
 * checks are todos until then. The list is empty: Phase 4 raised and asserted every rule of its
 * contract (`start_month_too_old` in settings and onboarding, the rest in `modules/savings`), and
 * Phase 5 did the same for `unknown_tag` (the spendings service, for a `tagIds` entry that is no
 * tag) and for the transfer rules (`modules/transfers`).
 *
 * Add a rule here when a phase's contract lists it before its service exists, and remove it when
 * its service and route test land. The last test below fails for an entry that is raised and
 * asserted already, so the list cannot go stale.
 */
const NOT_YET_IMPLEMENTED: readonly string[] = [];

/**
 * Rules a module must raise and assert ITSELF, per module directory under `src/modules`. The
 * checks on the whole table pass as soon as ANY module raises and asserts a rule, so they cannot
 * see it missing from a second endpoint the contract also gives it: the transfer endpoints reuse
 * three rules that the spendings already raise, and `outside_active_months` is the one that keeps
 * the ledger from ignoring a stored transfer (docs/DOMAIN.md, "Transfers"). A module with no
 * source file (only tests, or no directory at all) is a todo, and as soon as it has one its rules
 * are enforced, so a module cannot gain its endpoints and leave one of these rules out.
 */
const RULES_OF_MODULE: Readonly<Record<string, readonly string[]>> = {
  transfers: ['unknown_budget', 'before_start_month', 'outside_active_months'],
};

const isRaised = (rule: string, among: readonly string[] = sources): boolean =>
  among.some((source) => new RegExp(`ruleViolation\\(\\s*'${rule}'`).test(source));

const isAsserted = (rule: string, among: readonly string[] = tests): boolean =>
  among.some((source) => {
    for (const match of source.matchAll(new RegExp(`'${rule}'`, 'g'))) {
      const before = source.slice(Math.max(0, match.index - 400), match.index);
      if (before.includes('expectRuleViolation(')) return true;
    }
    return false;
  });

describe('rule_violation rules', () => {
  const planned = rulesInPlan();

  it('docs/PLAN.md and the shared contract list the same rules', () => {
    expect(planned.length).toBeGreaterThan(0);
    expect([...planned].sort()).toEqual([...rulesInContract()].sort());
  });

  it('documents every rule of the shared contract with a JSDoc comment', () => {
    const source = readFileSync(join(REPO_ROOT, 'shared', 'src', 'api.ts'), 'utf8');
    const start = source.indexOf('export type RuleViolationRule');
    const block = source.slice(start, source.indexOf(';', start));
    for (const rule of rulesInContract()) {
      const before = block.slice(0, block.indexOf(`| '${rule}'`)).trimEnd();
      expect(before.endsWith('*/'), `'${rule}' has no JSDoc comment in shared/src/api.ts`).toBe(
        true,
      );
    }
  });

  const implemented = planned.filter((rule) => !NOT_YET_IMPLEMENTED.includes(rule));

  it.each(implemented)('%s is raised by a service', (rule) => {
    expect(isRaised(rule), `no ruleViolation('${rule}', ...) under src/modules`).toBe(true);
  });

  it.each(implemented)('%s is asserted by a route test', (rule) => {
    expect(
      isAsserted(rule),
      `no expectRuleViolation(res, '${rule}', ...) in a test under src/modules`,
    ).toBe(true);
  });

  for (const rule of NOT_YET_IMPLEMENTED) {
    it.todo(`${rule} is raised by a service and asserted by a route test`);
  }

  it('lists as not yet implemented only planned rules that are not fully covered yet', () => {
    for (const rule of NOT_YET_IMPLEMENTED) {
      expect(planned, `'${rule}' is not in the PLAN.md rule table`).toContain(rule);
      expect(
        isRaised(rule) && isAsserted(rule),
        `'${rule}' is raised and asserted now: remove it from NOT_YET_IMPLEMENTED`,
      ).toBe(false);
    }
  });
});

describe('rules a module raises itself', () => {
  const inModule = (name: string, selected: (file: string) => boolean): string[] =>
    files
      .filter((file) => file.startsWith(join(MODULES_DIR, name) + sep) && selected(file))
      .map((file) => readFileSync(file, 'utf8'));

  for (const [name, rules] of Object.entries(RULES_OF_MODULE)) {
    const own = inModule(name, (file) => !file.endsWith('.test.ts'));
    if (own.length === 0) {
      for (const rule of rules) it.todo(`${name} raises ${rule} and a route test asserts it`);
      continue;
    }
    const ownTests = inModule(name, (file) => file.endsWith('.test.ts'));

    it.each(rules)(`${name} raises %s`, (rule) => {
      expect(isRaised(rule, own), `no ruleViolation('${rule}', ...) under modules/${name}`).toBe(
        true,
      );
    });

    it.each(rules)(`${name} asserts %s in a route test`, (rule) => {
      expect(
        isAsserted(rule, ownTests),
        `no expectRuleViolation(res, '${rule}', ...) in a test under modules/${name}`,
      ).toBe(true);
    });
  }

  it('lists only rules that the PLAN.md table has', () => {
    const planned = rulesInPlan();
    for (const rules of Object.values(RULES_OF_MODULE)) {
      for (const rule of rules) expect(planned).toContain(rule);
    }
  });
});
