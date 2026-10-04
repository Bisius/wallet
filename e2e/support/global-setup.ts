import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BACKEND_ENTRY, FAKE_CLOCK_PRELOAD, FRONTEND_DIST, REPO_ROOT } from './server';

/**
 * The suite drives the production build, and it never builds it itself: a build takes a minute and
 * a stale one would make a failing test look like an app bug. So check that it is there and say
 * what to do if not.
 */
export default function globalSetup(): void {
  const required = [BACKEND_ENTRY, join(FRONTEND_DIST, 'index.html'), FAKE_CLOCK_PRELOAD];
  const missing = required.filter((path) => !existsSync(path));
  if (missing.length === 0) return;

  const list = missing.map((path) => `  - ${path.replace(`${REPO_ROOT}/`, '')}`).join('\n');
  const error = new Error(
    `The E2E suite needs the production build, and this is missing:\n${list}\n` +
      `Run \`npm run build\` in ${REPO_ROOT} first (and again after changing the app: the tests use dist/).`,
  );
  // The message is the whole story: a stack trace of this file would only bury it.
  error.stack = `Error: ${error.message}`;
  throw error;
}
