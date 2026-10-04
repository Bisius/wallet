import { type PlaywrightTestProject, defineConfig, devices } from '@playwright/test';

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
 *   PW_VISUAL=1                        define the `visual` project (screenshot comparison, see below). Only
 *                                      `npm run e2e:visual` sets it, so nothing else ever runs that project.
 */
const executablePath = process.env['PW_CHROMIUM_PATH'] || undefined;
const args = process.env['PW_NO_SANDBOX'] === '1' ? ['--no-sandbox'] : [];
const workers = Number(process.env['PW_WORKERS']) || 2;
const SWEEP_SPECS = /(a11y|mobile)\.spec\.ts$/;
const VISUAL_SPEC = /visual\.spec\.ts$/;
const withVisual = process.env['PW_VISUAL'] === '1';
const outputDir = process.env['PW_OUTPUT_DIR'] || './test-results';

/**
 * Screenshots of every page and main dialog (`visual.spec.ts`), compared with baselines that are NOT in
 * git: pixels depend on the machine's fonts and rasteriser, so each developer records their own with
 * `npm run e2e:visual -- --update-snapshots`, and a pull request that changes the look re-records them
 * on purpose. The project only exists with PW_VISUAL=1 (what `npm run e2e:visual` sets), so
 * `npm run e2e`, `e2e:flows`, `e2e:sweep` and a plain `npx playwright test` never run it.
 */
const visualProject: PlaywrightTestProject = {
  name: 'visual',
  testMatch: VISUAL_SPEC,
  // One fresh server and browser page per shot, so a shot that fails says so by name and one that
  // crashes cannot take another with it. Retries stay off on purpose: a shot that only passes the
  // second time is a flake to fix, not to hide.
  timeout: 90_000,
  retries: 0,
  snapshotDir: './visual-baselines',
  // `budgets-desktop-light.png`: the name carries the page and the variant, no platform suffix.
  snapshotPathTemplate: '{snapshotDir}/{arg}{ext}',
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      // How far two colours may be apart (0 to 1, YIQ) before a pixel counts as different: small enough
      // that a shade of blue or a grey border that changed shows up, large enough to let the grey halo
      // of an anti-aliased edge through.
      threshold: 0.05,
      // How many pixels may differ at all. Two runs of the same build on the same machine differ by at
      // most a handful (up to 7 were seen, always single pixels on the rounded corner of a card), so 30
      // is noise that never fails, while a changed digit, a recoloured status dot, a moved line or a
      // restyled button does. A ratio would grow with the page: on a 4 million pixel page it would let
      // a small badge change through.
      maxDiffPixels: 30,
    },
  },
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    // No transition or animation to catch half way (also set for every project above).
    contextOptions: { reducedMotion: 'reduce' },
  },
};

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
      testIgnore: [SWEEP_SPECS, VISUAL_SPEC],
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
    ...(withVisual ? [visualProject] : []),
  ],
});
