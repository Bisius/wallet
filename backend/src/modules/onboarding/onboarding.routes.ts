import { onboardingSchema } from '@wallet/shared';
import { Router } from 'express';
import type { AppDeps } from '../../app';
import { onboard } from './onboarding.service';

export function onboardingRoutes(deps: AppDeps): Router {
  const router = Router();

  router.post('/', (req, res) => {
    const input = onboardingSchema.parse(req.body);
    res.status(201).json(onboard(deps, input));
  });

  return router;
}
