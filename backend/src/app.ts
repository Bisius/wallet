import express, { Router } from 'express';
import helmet from 'helmet';
import { join } from 'node:path';
import type { Config } from './config';
import type { Db } from './db/client';
import { type Clock, systemClock } from './lib/clock';
import { errorHandler, notFound } from './lib/errors';
import { requestLogger } from './lib/request-logger';
import { healthRoutes } from './modules/health/health.routes';

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
  api.use('/health', healthRoutes(deps));
  // Feature modules are mounted here, e.g. api.use('/budgets', budgetRoutes(deps));
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
