import type { RequestHandler } from 'express';
import type { Deps } from '../../lib/deps';
import { notOnboarded } from '../../lib/errors';
import { isOnboarded } from './settings.service';

/**
 * Guard for every endpoint except health, today, settings and onboarding: until the settings
 * exist they answer 409 `not_onboarded`, before the request is even validated.
 */
export function requireOnboarded({ db }: Deps): RequestHandler {
  return (_req, _res, next) => {
    if (!isOnboarded(db)) throw notOnboarded();
    next();
  };
}
