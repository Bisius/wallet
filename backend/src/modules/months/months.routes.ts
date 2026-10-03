import { monthListQuerySchema, monthParamsSchema } from '@wallet/shared';
import { Router } from 'express';
import type { AppDeps } from '../../app';
import { getMonthView, listMonthSummaries } from './months.service';

export function monthRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get('/', (req, res) => {
    // Express 5: `req.query` is a read-only getter, so parse it into a local.
    const query = monthListQuerySchema.parse(req.query);
    res.json(listMonthSummaries(deps, query));
  });

  router.get('/:month', (req, res) => {
    const { month } = monthParamsSchema.parse(req.params);
    res.json(getMonthView(deps, month));
  });

  return router;
}
