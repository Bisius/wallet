import {
  idParamsSchema,
  incomeCreateSchema,
  incomeListQuerySchema,
  incomeUpdateSchema,
} from '@wallet/shared';
import { Router } from 'express';
import type { AppDeps } from '../../app';
import { createIncome, deleteIncome, listIncomes, updateIncome } from './incomes.service';

export function incomeRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get('/', (req, res) => {
    // Express 5: `req.query` is a read-only getter, so parse it into a local.
    const query = incomeListQuerySchema.parse(req.query);
    res.json(listIncomes(deps, query));
  });

  router.post('/', (req, res) => {
    const input = incomeCreateSchema.parse(req.body);
    res.status(201).json(createIncome(deps, input));
  });

  router.patch('/:id', (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const input = incomeUpdateSchema.parse(req.body);
    res.json(updateIncome(deps, id, input));
  });

  router.delete('/:id', (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    deleteIncome(deps, id);
    res.status(204).end();
  });

  return router;
}
