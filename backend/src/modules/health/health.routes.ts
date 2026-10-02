import type { HealthResponse } from '@wallet/shared';
import { sql } from 'drizzle-orm';
import { Router } from 'express';
import type { AppDeps } from '../../app';

export function healthRoutes({ db, clock }: AppDeps): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    db.get(sql`select 1`);
    const body: HealthResponse = { status: 'ok', time: clock.now().toISOString() };
    res.json(body);
  });

  return router;
}
