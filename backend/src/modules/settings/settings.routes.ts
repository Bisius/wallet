import { settingsInputSchema } from '@wallet/shared';
import { Router } from 'express';
import type { AppDeps } from '../../app';
import { getSettings, saveSettings } from './settings.service';

export function settingsRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(getSettings(deps));
  });

  router.put('/', (req, res) => {
    const input = settingsInputSchema.parse(req.body);
    res.json(saveSettings(deps, input));
  });

  return router;
}
