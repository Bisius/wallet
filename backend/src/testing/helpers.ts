/**
 * Helpers shared by the route tests: a movable clock, a time-zone switcher, typed shortcuts for the
 * setup calls (each asserts its own success) and assertions for the `ApiError` shape.
 */
import {
  API_ERROR_STATUS,
  type ApiErrorCode,
  type BudgetCreateInput,
  type BudgetDto,
  type IncomeCreateInput,
  type IncomeDto,
  type OnboardingInput,
  type OnboardingResponse,
  type RuleViolationRule,
  type SpendingCreateInput,
  type SpendingDto,
  type SubscriptionCreateInput,
  type SubscriptionDto,
  type TagCreateInput,
  type TagDto,
  type TransferCreateInput,
  type TransferDto,
} from '@wallet/shared';
import type { Express } from 'express';
import request, { type Response } from 'supertest';
import { expect } from 'vitest';
import type { Db } from '../db/client';
import { budgetTransfers } from '../db/schema';
import type { Clock } from '../lib/clock';

// -------------------------------------------------------------------------------------------------
// Time
// -------------------------------------------------------------------------------------------------

/** A clock a test can move forward ("move the clock forward, then assert"). */
export interface MutableClock extends Clock {
  set(iso: string): void;
}

export function mutableClock(iso: string): MutableClock {
  let current = new Date(iso);
  return {
    now: () => new Date(current),
    set: (next) => {
      current = new Date(next);
    },
  };
}

/**
 * Runs `fn` with the process time zone (`TZ`) switched to `timeZone`, then restores it. The tests
 * run pinned to UTC (see vitest.config.ts); this is for the ones that need the server's local
 * calendar to differ from UTC.
 */
export async function withTimeZone<T>(timeZone: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = process.env['TZ'];
  process.env['TZ'] = timeZone;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env['TZ'];
    else process.env['TZ'] = previous;
  }
}

// -------------------------------------------------------------------------------------------------
// Setup calls (they assert the 2xx they expect, so a broken setup fails loudly and early)
// -------------------------------------------------------------------------------------------------

export const ONBOARDING: OnboardingInput = {
  currency: 'EUR',
  locale: 'en-US',
  startMonth: '2026-01',
  salary: 300000,
  openingSavings: 50000,
};

/** POST /api/onboarding with sensible defaults (start month 2026-01, salary 3000.00). */
export async function onboard(
  app: Express,
  overrides: Partial<OnboardingInput> = {},
): Promise<OnboardingResponse> {
  const res = await request(app)
    .post('/api/onboarding')
    .send({ ...ONBOARDING, ...overrides })
    .expect(201);
  return res.body as OnboardingResponse;
}

export async function addBudget(
  app: Express,
  body: Partial<BudgetCreateInput> = {},
): Promise<BudgetDto> {
  const res = await request(app)
    .post('/api/budgets')
    .send({ name: 'Groceries', amount: 40000, incremental: false, ...body })
    .expect(201);
  return res.body as BudgetDto;
}

export async function addSubscription(
  app: Express,
  body: Partial<SubscriptionCreateInput> = {},
): Promise<SubscriptionDto> {
  const res = await request(app)
    .post('/api/subscriptions')
    .send({
      name: 'Netflix',
      frequency: 'monthly',
      anchorDate: '2026-01-15',
      amount: 1299,
      ...body,
    })
    .expect(201);
  return res.body as SubscriptionDto;
}

export async function addSpending(
  app: Express,
  body: Pick<SpendingCreateInput, 'budgetId'> & Partial<SpendingCreateInput>,
): Promise<SpendingDto> {
  const res = await request(app)
    .post('/api/spendings')
    .send({ date: '2026-03-10', amount: 1250, description: 'Lunch', ...body })
    .expect(201);
  return res.body as SpendingDto;
}

export async function addIncome(
  app: Express,
  body: Partial<IncomeCreateInput> = {},
): Promise<IncomeDto> {
  const res = await request(app)
    .post('/api/incomes')
    .send({ date: '2026-03-05', amount: 50000, description: 'Bonus', ...body })
    .expect(201);
  return res.body as IncomeDto;
}

/** POST /api/transfers, which must answer 201. Both sides are required: `null` is the pool. */
export async function addTransfer(
  app: Express,
  body: Pick<TransferCreateInput, 'fromBudgetId' | 'toBudgetId'> & Partial<TransferCreateInput>,
): Promise<TransferDto> {
  const res = await request(app)
    .post('/api/transfers')
    .send({ date: '2026-03-10', amount: 2500, ...body })
    .expect(201);
  return res.body as TransferDto;
}

/** POST /api/tags, which must answer 201. */
export async function addTag(app: Express, body: Partial<TagCreateInput> = {}): Promise<TagDto> {
  const res = await request(app)
    .post('/api/tags')
    .send({ name: 'Groceries', ...body })
    .expect(201);
  return res.body as TagDto;
}

/**
 * Inserts a budget transfer straight into the database, skipping the rules of
 * `POST /api/transfers`. Use the endpoint for a transfer the API accepts; use this one for data
 * the API never stores (a transfer dated outside the active months of a budget, say), to test what
 * the ledger and the other rules do with it, and for bulk setup.
 */
export function insertTransfer(
  db: Db,
  transfer: { date: string; amount?: number; fromBudgetId?: number; toBudgetId?: number },
): void {
  db.insert(budgetTransfers)
    .values({
      date: transfer.date,
      amount: transfer.amount ?? 100,
      fromBudgetId: transfer.fromBudgetId ?? null,
      toBudgetId: transfer.toBudgetId ?? null,
    })
    .run();
}

// -------------------------------------------------------------------------------------------------
// Assertions
// -------------------------------------------------------------------------------------------------

/** The response is an `ApiError` with `code` and the status that goes with it. */
export function expectApiError(res: Response, code: ApiErrorCode): void {
  expect(res.status, JSON.stringify(res.body)).toBe(API_ERROR_STATUS[code]);
  expect(Object.keys(res.body)).toEqual(['error']);
  expect(res.body.error.code).toBe(code);
  expect(typeof res.body.error.message).toBe('string');
  expect(res.body.error.message.length).toBeGreaterThan(0);
}

/** 422 `rule_violation` for `rule`, pointing at `field` when one is given. */
export function expectRuleViolation(res: Response, rule: RuleViolationRule, field?: string): void {
  expectApiError(res, 'rule_violation');
  expect(res.body.error.details).toEqual(field === undefined ? { rule } : { rule, field });
}

/** 400 `validation_error` with at least one issue at each of `paths` ('' = the whole body). */
export function expectValidationError(res: Response, ...paths: string[]): void {
  expectApiError(res, 'validation_error');
  const issues = res.body.error.details as { path: string; message: string }[];
  expect(Array.isArray(issues)).toBe(true);
  for (const issue of issues) {
    expect(typeof issue.path).toBe('string');
    expect(typeof issue.message).toBe('string');
  }
  for (const path of paths) expect(issues.map((issue) => issue.path)).toContain(path);
}

/**
 * 400 `validation_error` whose issues are at exactly these `paths` ('' = the whole body), once
 * each and in any order. The stricter form of `expectValidationError`, for a request with a known
 * set of mistakes: it also fails when an issue is reported somewhere unexpected.
 */
export function expectValidationPaths(res: Response, ...paths: string[]): void {
  expectValidationError(res, ...paths);
  const issues = res.body.error.details as { path: string }[];
  expect([...new Set(issues.map((issue) => issue.path))].sort()).toEqual(
    [...new Set(paths)].sort(),
  );
}

export function expectNotFound(res: Response): void {
  expectApiError(res, 'not_found');
}
