import { monthParamsSchema, salaryUpsertSchema } from '@wallet/shared';
import { Router } from 'express';
import type { AppDeps } from '../../app';
import { deleteSalary, listSalary, putSalary } from './salary.service';

export function salaryRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(listSalary(deps));
  });

  router.put('/:month', (req, res) => {
    const { month } = monthParamsSchema.parse(req.params);
    const input = salaryUpsertSchema.parse(req.body);
    res.json(putSalary(deps, month, input));
  });

  router.delete('/:month', (req, res) => {
    const { month } = monthParamsSchema.parse(req.params);
    deleteSalary(deps, month);
    res.status(204).end();
  });

  return router;
}
