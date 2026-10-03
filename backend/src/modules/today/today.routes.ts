import { Router } from 'express';
import type { AppDeps } from '../../app';
import { getToday } from './today.service';

export function todayRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(getToday(deps));
  });

  return router;
}
