import {
  idMonthParamsSchema,
  idParamsSchema,
  subscriptionCancelSchema,
  subscriptionCreateSchema,
  subscriptionPriceSchema,
  subscriptionUpdateSchema,
  upcomingRenewalsQuerySchema,
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
import { listUpcomingRenewals } from './subscriptions.upcoming.service';

export function subscriptionRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(listSubscriptions(deps));
  });

  // Registered before `/:id` routes so that "upcoming" is never read as an id.
  router.get('/upcoming', (req, res) => {
    // Express 5: `req.query` is a read-only getter, so parse it into a local.
    const query = upcomingRenewalsQuerySchema.parse(req.query);
    res.json(listUpcomingRenewals(deps, query));
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
