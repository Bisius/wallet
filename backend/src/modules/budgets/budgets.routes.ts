import {
  budgetArchiveSchema,
  budgetCreateSchema,
  budgetUpdateSchema,
  budgetVersionSchema,
  idMonthParamsSchema,
  idParamsSchema,
} from '@wallet/shared';
import { Router } from 'express';
import type { AppDeps } from '../../app';
import {
  archiveBudget,
  createBudget,
  deleteBudget,
  listBudgets,
  updateBudget,
  upsertBudgetVersion,
} from './budgets.service';

export function budgetRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(listBudgets(deps));
  });

  router.post('/', (req, res) => {
    const input = budgetCreateSchema.parse(req.body);
    res.status(201).json(createBudget(deps, input));
  });

  router.patch('/:id', (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const input = budgetUpdateSchema.parse(req.body);
    res.json(updateBudget(deps, id, input));
  });

  router.put('/:id/versions/:month', (req, res) => {
    const { id, month } = idMonthParamsSchema.parse(req.params);
    const input = budgetVersionSchema.parse(req.body);
    res.json(upsertBudgetVersion(deps, id, month, input));
  });

  router.post('/:id/archive', (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    // The body may be empty or absent (then `req.body` is undefined in Express 5).
    const input = budgetArchiveSchema.parse(req.body ?? {});
    res.json(archiveBudget(deps, id, input));
  });

  router.delete('/:id', (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    deleteBudget(deps, id);
    res.status(204).end();
  });

  return router;
}
