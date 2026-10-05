import { telegramNotificationSettingsInputSchema } from '@wallet/shared';
import { Router } from 'express';
import {
  cancelTelegramPairing,
  createTelegramPairing,
  getTelegramStatus,
  saveTelegramNotificationSettings,
  sendTelegramTest,
  type TelegramServiceDeps,
  unlinkTelegram,
} from './telegram.service';

/**
 * `/api/telegram`: the Settings side of the bot (contract: `shared/src/telegram.ts`). Mounted behind
 * `requireOnboarded`. None of these ever returns or logs the bot token.
 */
export function telegramRoutes(deps: TelegramServiceDeps): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(getTelegramStatus(deps));
  });

  router.post('/pairing', (_req, res) => {
    res.status(201).json(createTelegramPairing(deps));
  });

  router.delete('/pairing', (_req, res) => {
    cancelTelegramPairing(deps);
    res.status(204).end();
  });

  router.delete('/link', (_req, res) => {
    unlinkTelegram(deps);
    res.status(204).end();
  });

  router.put('/notifications', (req, res) => {
    const input = telegramNotificationSettingsInputSchema.parse(req.body);
    res.json(saveTelegramNotificationSettings(deps, input));
  });

  router.post('/test', async (_req, res) => {
    await sendTelegramTest(deps);
    res.status(204).end();
  });

  return router;
}
