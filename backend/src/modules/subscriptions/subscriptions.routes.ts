import {
  idMonthParamsSchema,
  idParamsSchema,
  subscriptionCancelSchema,
  subscriptionCreateSchema,
  subscriptionPriceSchema,
  subscriptionUpdateSchema,
} from '@wallet/shared';
import { Router } from 'express';
import type { AppDeps } from '../../app';
import {
  cancelSubscription,
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  updateSubscription,
  upsertSubscriptionPrice,
} from './subscriptions.service';

export function subscriptionRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(listSubscriptions(deps));
  });

  router.post('/', (req, res) => {
    const input = subscriptionCreateSchema.parse(req.body);
    res.status(201).json(createSubscription(deps, input));
  });

  router.patch('/:id', (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    const input = subscriptionUpdateSchema.parse(req.body);
    res.json(updateSubscription(deps, id, input));
  });

  router.put('/:id/prices/:month', (req, res) => {
    const { id, month } = idMonthParamsSchema.parse(req.params);
    const input = subscriptionPriceSchema.parse(req.body);
    res.json(upsertSubscriptionPrice(deps, id, month, input));
  });

  router.post('/:id/cancel', (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    // The body may be empty or absent (then `req.body` is undefined in Express 5).
    const input = subscriptionCancelSchema.parse(req.body ?? {});
    res.json(cancelSubscription(deps, id, input));
  });

  router.delete('/:id', (req, res) => {
    const { id } = idParamsSchema.parse(req.params);
    deleteSubscription(deps, id);
    res.status(204).end();
  });

  return router;
}
