import { createApp } from '../app';
import { createDb, runMigrations } from '../db/client';
import { type Clock, fixedClock } from '../lib/clock';

/** Fresh in-memory database with all migrations applied, plus an app wired to it. */
export function createTestApp(clock: Clock = fixedClock('2026-01-15T12:00:00Z')) {
  const db = createDb(':memory:');
  runMigrations(db);
  const app = createApp({ db, clock, config: { env: 'test', staticDir: undefined } });
  return { app, db, clock };
}
