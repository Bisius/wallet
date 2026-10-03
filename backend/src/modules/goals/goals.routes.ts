import { goalCreateSchema, goalUpdateSchema, idParamsSchema } from '@wallet/shared';
import { Router } from 'express';
import type { AppDeps } from '../../app';
import { createGoal, deleteGoal, listGoals, updateGoal } from './goals.service';

export function goalRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(listGoals(deps));
  });

  router.post('/', (req, res) => {
    const input = goalCreateSchema.parse(req.body);
    res.status(201).json(createGoal(deps, input));
  });

  router.patch('/:id', (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const input = goalUpdateSchema.parse(req.body);
    res.json(updateGoal(deps, id, input));
  });

  router.delete('/:id', (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    deleteGoal(deps, id);
    res.status(204).end();
  });

  return router;
}
