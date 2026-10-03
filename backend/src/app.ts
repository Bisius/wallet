import express, { Router } from 'express';
import helmet from 'helmet';
import { join } from 'node:path';
import type { Config } from './config';
import type { Db } from './db/client';
import { type Clock, systemClock } from './lib/clock';
import { errorHandler, notFound } from './lib/errors';
import { requestLogger } from './lib/request-logger';
import { budgetRoutes } from './modules/budgets/budgets.routes';
import { goalRoutes } from './modules/goals/goals.routes';
import { healthRoutes } from './modules/health/health.routes';
import { incomeRoutes } from './modules/incomes/incomes.routes';
import { monthRoutes } from './modules/months/months.routes';
import { onboardingRoutes } from './modules/onboarding/onboarding.routes';
import { salaryRoutes } from './modules/salary/salary.routes';
import { savingsRoutes } from './modules/savings/savings.routes';
import { requireOnboarded } from './modules/settings/require-onboarded';
import { settingsRoutes } from './modules/settings/settings.routes';
import { spendingRoutes } from './modules/spendings/spendings.routes';
import { subscriptionRoutes } from './modules/subscriptions/subscriptions.routes';
import { todayRoutes } from './modules/today/today.routes';

export interface AppDeps {
  db: Db;
  clock: Clock;
}

export interface CreateAppOptions {
  db: Db;
  clock?: Clock;
  config: Pick<Config, 'env' | 'staticDir'>;
}

export function createApp({ db, clock = systemClock, config }: CreateAppOptions) {
  const deps: AppDeps = { db, clock };
  const app = express();

  app.disable('x-powered-by');
  app.use(
    helmet({
      // The app is often reached over plain HTTP on a LAN; upgrading requests to HTTPS would break it.
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
    }),
  );
  app.use(express.json());
  if (config.env === 'development') app.use(requestLogger);

  const api = Router();
  // Reachable before onboarding.
  api.use('/health', healthRoutes(deps));
  api.use('/today', todayRoutes(deps));
  api.use('/settings', settingsRoutes(deps));
  api.use('/onboarding', onboardingRoutes(deps));
  // Everything else answers 409 `not_onboarded` until the settings exist.
  const onboarded = requireOnboarded(deps);
  api.use('/salary', onboarded, salaryRoutes(deps));
  api.use('/incomes', onboarded, incomeRoutes(deps));
  api.use('/budgets', onboarded, budgetRoutes(deps));
  api.use('/subscriptions', onboarded, subscriptionRoutes(deps));
  api.use('/spendings', onboarded, spendingRoutes(deps));
  api.use('/months', onboarded, monthRoutes(deps));
  api.use('/savings', onboarded, savingsRoutes(deps));
  api.use('/goals', onboarded, goalRoutes(deps));
  api.use((_req, _res, next) => next(notFound('Route')));
  app.use('/api', api);

  const { staticDir } = config;
  if (staticDir) {
    app.use(express.static(staticDir));
    // Single-page app fallback: let Angular's router handle every other path.
    app.get('/{*path}', (_req, res) => res.sendFile(join(staticDir, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
