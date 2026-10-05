import { DEFAULT_BODY_LIMIT_BYTES, IMPORT_MAX_BODY_BYTES } from '@wallet/shared';
import express, { Router } from 'express';
import helmet from 'helmet';
import { join } from 'node:path';
import type { Config } from './config';
import type { Db } from './db/client';
import { type Clock, systemClock } from './lib/clock';
import { errorHandler, notFound } from './lib/errors';
import { requestLogger } from './lib/request-logger';
import { backupRoutes } from './modules/backups/backups.routes';
import { budgetRoutes } from './modules/budgets/budgets.routes';
import { exportRoutes } from './modules/export/export.routes';
import { goalRoutes } from './modules/goals/goals.routes';
import { healthRoutes } from './modules/health/health.routes';
import { importRoutes } from './modules/import/import.routes';
import { incomeRoutes } from './modules/incomes/incomes.routes';
import { monthRoutes } from './modules/months/months.routes';
import { onboardingRoutes } from './modules/onboarding/onboarding.routes';
import { reportRoutes } from './modules/reports/reports.routes';
import { salaryRoutes } from './modules/salary/salary.routes';
import { savingsRoutes } from './modules/savings/savings.routes';
import { requireOnboarded } from './modules/settings/require-onboarded';
import { settingsRoutes } from './modules/settings/settings.routes';
import { spendingRoutes } from './modules/spendings/spendings.routes';
import { subscriptionRoutes } from './modules/subscriptions/subscriptions.routes';
import { tagRoutes } from './modules/tags/tags.routes';
import { budgetAlertWriteHook } from './modules/telegram/telegram.notifications';
import { telegramRoutes } from './modules/telegram/telegram.routes';
import type { TelegramHandle } from './modules/telegram/telegram.types';
import { todayRoutes } from './modules/today/today.routes';
import { transferRoutes } from './modules/transfers/transfers.routes';

export interface AppDeps {
  db: Db;
  clock: Clock;
}

export interface CreateAppOptions {
  db: Db;
  clock?: Clock;
  /** `backupDir` is optional here: without it there is no backup directory (tests, in-memory database). */
  config: Pick<Config, 'env' | 'staticDir'> & Partial<Pick<Config, 'backupDir'>>;
  /**
   * The Telegram bot, when one runs (`index.ts` passes it when `TELEGRAM_BOT_TOKEN` is set). Without
   * it the bot is off: `GET /api/telegram` says so and the endpoints that need a bot answer 409
   * `telegram_not_configured`. `createApp` never starts a bot, and neither does any test: they pass
   * a fake (`src/testing/fake-telegram.ts`) or nothing.
   */
  telegram?: TelegramHandle;
}

export function createApp({ db, clock = systemClock, config, telegram }: CreateAppOptions) {
  const deps: AppDeps = { db, clock };
  const app = express();

  app.disable('x-powered-by');
  app.use(
    helmet({
      // The app is often reached over plain HTTP on a LAN; upgrading requests to HTTPS would break it.
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
    }),
  );
  // The import endpoints carry a whole CSV file in a string, so they get the larger limit. That
  // parser MUST come first: it reads the body, and the global one (which would refuse anything above
  // its limit) then finds it already parsed.
  app.use('/api/import', express.json({ limit: IMPORT_MAX_BODY_BYTES }));
  app.use(express.json({ limit: DEFAULT_BODY_LIMIT_BYTES }));
  if (config.env === 'development') app.use(requestLogger);

  const api = Router();
  // Budget alerts (docs/DOMAIN.md, "Budget alerts"): after every write that succeeded, on any route
  // (a settings change moves the warning threshold, a restore changes everything), ask the Telegram
  // watcher for a check (debounced, 2 s). Only with a bot; it never fails a request.
  if (telegram) api.use(budgetAlertWriteHook(telegram.notify));
  // Reachable before onboarding.
  api.use('/health', healthRoutes(deps));
  api.use('/today', todayRoutes(deps));
  api.use('/settings', settingsRoutes(deps));
  api.use('/backups', backupRoutes({ ...deps, backupDir: config.backupDir }));
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
  api.use('/transfers', onboarded, transferRoutes(deps));
  api.use('/tags', onboarded, tagRoutes(deps));
  api.use('/reports', onboarded, reportRoutes(deps));
  api.use('/export', onboarded, exportRoutes(deps));
  api.use('/import', onboarded, importRoutes(deps));
  api.use('/telegram', onboarded, telegramRoutes({ ...deps, telegram }));
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
