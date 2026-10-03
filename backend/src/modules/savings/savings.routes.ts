import {
  idParamsSchema,
  monthParamsSchema,
  savingsOpeningSchema,
  savingsSettleSchema,
  savingsTransactionCreateSchema,
  savingsTransactionListQuerySchema,
} from '@wallet/shared';
import { Router } from 'express';
import type { AppDeps } from '../../app';
import { getOpening, getSavings, setOpening } from './savings.service';
import { settleMonth, undoSettlement } from './savings.settlement.service';
import {
  createSavingsTransactions,
  deleteSavingsTransaction,
  listSavingsTransactions,
} from './savings.transactions.service';

export function savingsRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(getSavings(deps));
  });

  router.post('/settle/:month', (req, res) => {
    const { month } = monthParamsSchema.parse(req.params);
    const input = savingsSettleSchema.parse(req.body);
    res.status(201).json(settleMonth(deps, month, input));
  });

  router.delete('/settle/:month', (req, res) => {
    const { month } = monthParamsSchema.parse(req.params);
    undoSettlement(deps, month);
    res.status(204).end();
  });

  router.get('/transactions', (req, res) => {
    // Express 5: `req.query` is a read-only getter, so parse it into a local.
    const query = savingsTransactionListQuerySchema.parse(req.query);
    res.json(listSavingsTransactions(deps, query));
  });

  router.post('/transactions', (req, res) => {
    const input = savingsTransactionCreateSchema.parse(req.body);
    res.status(201).json(createSavingsTransactions(deps, input));
  });

  router.delete('/transactions/:id', (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    deleteSavingsTransaction(deps, id);
    res.status(204).end();
  });

  router.get('/opening', (_req, res) => {
    res.json(getOpening(deps));
  });

  router.put('/opening', (req, res) => {
    const input = savingsOpeningSchema.parse(req.body);
    res.json(setOpening(deps, input));
  });

  return router;
}
