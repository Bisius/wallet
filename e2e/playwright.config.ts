import { defineConfig, devices } from '@playwright/test';

const isCI = Boolean(process.env['CI']);

/**
 * On a normal machine `npx playwright install chromium` is all it takes. Where the browser that
 * Playwright would download cannot run, point at another Chromium and, if it needs it, drop the sandbox:
 *
 *   PW_CHROMIUM_PATH=/path/to/chrome   use this executable instead of Playwright's own
 *   PW_NO_SANDBOX=1                    launch with --no-sandbox (containers, no user namespaces)
 *   PW_WORKERS=4                       more parallel workers (the default is 2, kind to shared machines)
 *   PW_OUTPUT_DIR=/tmp/pw-out          where traces and screenshots go. Playwright empties this folder at the
 *                                      start of every run, so two runs at once (two people, two agents) need
 *                                      different ones.
 */
const executablePath = process.env['PW_CHROMIUM_PATH'] || undefined;
const args = process.env['PW_NO_SANDBOX'] === '1' ? ['--no-sandbox'] : [];
const workers = Number(process.env['PW_WORKERS']) || 2;
const SWEEP_SPECS = /(a11y|mobile)\.spec\.ts$/;
const outputDir = process.env['PW_OUTPUT_DIR'] || './test-results';

export default defineConfig({
  testDir: './tests',
  // Every test starts its own server, database and clock, so nothing is shared and they can overlap.
  fullyParallel: true,
  workers,
  retries: isCI ? 1 : 0,
  forbidOnly: isCI,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './support/global-setup.ts',
  outputDir,

  use: {
    // A control that is not there fails after 10 s, not after the whole test timeout.
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The app takes its dates from the server, but formatting and animations should not vary by machine.
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    contextOptions: { reducedMotion: 'reduce' },
    launchOptions: { executablePath, args },
  },

  // `flows` is the quick part (a few minutes): what a person does, with exact money. `sweep` is the
  // slow part (about 25 minutes at one worker): axe and the phone layout over every page and state,
  // in light and dark. Both have to pass; `npm run e2e:flows` and `npm run e2e:sweep` run one each.
  projects: [
    {
      name: 'flows',
      testIgnore: SWEEP_SPECS,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      // These specs choose their own viewport (desktop or a 390 px phone with `isMobile`).
      name: 'sweep',
      testMatch: SWEEP_SPECS,
      // A walk is one long test on one browser page: when the browser dies under it ("Page crashed",
      // net::ERR_INSUFFICIENT_RESOURCES on a small machine that is busy with other things), a retry
      // starts a fresh browser instead of losing the walk. A real finding fails both attempts, and a
      // pass on the retry is reported as "flaky", not as a plain pass.
      retries: 1,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
});
