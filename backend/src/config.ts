import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { BACKEND_ROOT } from './lib/paths';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3400),
  DATABASE_PATH: z.string().default('./data/wallet.db'),
  STATIC_DIR: z.string().optional(),
});

export interface Config {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  databasePath: string;
  /** Built Angular app to serve, if any. */
  staticDir: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  const defaultStaticDir = resolve(BACKEND_ROOT, '../frontend/dist/frontend/browser');
  const staticDir = parsed.STATIC_DIR
    ? resolve(parsed.STATIC_DIR)
    : parsed.NODE_ENV === 'production' && existsSync(defaultStaticDir)
      ? defaultStaticDir
      : undefined;

  return {
    env: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    databasePath: parsed.DATABASE_PATH === ':memory:' ? ':memory:' : resolve(parsed.DATABASE_PATH),
    staticDir,
  };
}
