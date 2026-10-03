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

/**
 * Inserts a budget transfer straight into the database: there is no transfers endpoint before
 * Phase 5, but budgets must already treat transfers as history and as activity.
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

export function expectNotFound(res: Response): void {
  expectApiError(res, 'not_found');
}
