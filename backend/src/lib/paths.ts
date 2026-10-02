import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walks up from this module to the nearest package.json, so paths work from both src/ and the bundled dist/. */
function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not locate the backend package root');
    dir = parent;
  }
  return dir;
}

export const BACKEND_ROOT = findPackageRoot();
export const MIGRATIONS_DIR = join(BACKEND_ROOT, 'drizzle');
