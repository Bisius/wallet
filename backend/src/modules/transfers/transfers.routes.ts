import { idParamsSchema, transferCreateSchema, transferListQuerySchema } from '@wallet/shared';
import { Router } from 'express';
import type { AppDeps } from '../../app';
import { createTransfer, deleteTransfer, listTransfers } from './transfers.service';

export function transferRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get('/', (req, res) => {
    // Express 5: `req.query` is a read-only getter, so parse it into a local.
    const query = transferListQuerySchema.parse(req.query);
    res.json(listTransfers(deps, query));
  });

  router.post('/', (req, res) => {
    const input = transferCreateSchema.parse(req.body);
    res.status(201).json(createTransfer(deps, input));
  });

  router.delete('/:id', (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    deleteTransfer(deps, id);
    res.status(204).end();
  });

  return router;
}
