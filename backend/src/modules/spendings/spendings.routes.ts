import {
  idParamsSchema,
  spendingCreateSchema,
  spendingListQuerySchema,
  spendingUpdateSchema,
} from '@wallet/shared';
import { Router } from 'express';
import type { AppDeps } from '../../app';
import { createSpending, deleteSpending, listSpendings, updateSpending } from './spendings.service';

export function spendingRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get('/', (req, res) => {
    // Express 5: `req.query` is a read-only getter, so parse it into a local.
    const query = spendingListQuerySchema.parse(req.query);
    res.json(listSpendings(deps, query));
  });

  router.post('/', (req, res) => {
    const input = spendingCreateSchema.parse(req.body);
    res.status(201).json(createSpending(deps, input));
  });

  router.patch('/:id', (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const input = spendingUpdateSchema.parse(req.body);
    res.json(updateSpending(deps, id, input));
  });

  router.delete('/:id', (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    deleteSpending(deps, id);
    res.status(204).end();
  });

  return router;
}
