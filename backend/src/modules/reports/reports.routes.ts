import { yearParamsSchema } from '@wallet/shared';
import { Router } from 'express';
import type { AppDeps } from '../../app';
import { getYearlyReport } from './reports.service';

export function reportRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get('/yearly/:year', (req, res) => {
    const { year } = yearParamsSchema.parse(req.params);
    res.json(getYearlyReport(deps, year));
  });

  return router;
}
