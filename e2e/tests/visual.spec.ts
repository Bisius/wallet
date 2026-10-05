import type { Page } from '@playwright/test';
import { DEFAULT_NOW, expect, failedResponse, test } from '../support/fixtures';
import {
  SCREENS,
  type ScreenName,
  type ThemeName,
  expectTheme,
  richStops,
  settle,
} from '../support/pages';
import { seedWallet } from '../support/rich-data';
import { type TelegramWorld, telegramStops } from '../support/telegram-stops';

/*
 * Screenshots of the whole app, to see what a change to the look did and to catch a page that a
 * migration forgot. This is the `visual` project, which `npm run e2e` does not run (see
 * `playwright.config.ts` and the README): `npm run e2e:visual`.
 *
 * What it looks at is what the sweeps (`a11y.spec.ts`, `mobile.spec.ts`) look at: every stop of
 * `richStops()` from `support/pages.ts`, with the `rich` dataset, so the pages and dialogs are listed
 * in one place only. A stop that is a page is shot full-page in three variants (desktop light,
 * desktop dark, a 390 px phone); a stop that is a modal dialog is shot as the user sees it, the
 * viewport with the dialog over a dimmed page, on desktop light and on the phone. A stop that has a
 * "More actions" menu open is shot the same way: the window, with the menu in front of the page.
 *
 * Each shot is its own test, with its own server, database and clock. The picture is the same on
 * every run of the same app on the same machine, so a difference means the app changed:
 *
 *  - the clock is the harness default (`2026-03-10`), so every date and "today" is the same;
 *  - animations are off (`reducedMotion`, and Playwright finishes the rest before it shoots), the
 *    caret does not blink in a screenshot, and a toast does not time out under the camera;
 *  - before the shot the page is "settled": no loading indicator, fonts loaded, layout unchanged for
 *    a few frames (the charts measure themselves after the first paint), scrolled to the top, the
 *    mouse out of the way so nothing is hovered. A phone's page is shot with a window as tall as the
 *    page, so that its fixed tab bar and floating button sit at the end of the picture, where they are,
 *    instead of over its middle;
 *  - what comes from the real clock of the server is pinned: the time of day in the backups section
 *    and in the name of a backup (`wallet-20260310-090013.db`) is replaced by a constant, which is
 *    better than a mask because the text keeps its width. The API status and the server date are not
 *    volatile (the date is the fake one and the status is awaited), so they are in the picture.
 *
 * The baselines are not in git (`e2e/visual-baselines/`): see the README on how to record and update them.
 */

interface Variant {
  /** Ends the name of every shot of the variant: `budgets-desktop-light.png`. */
  name: string;
  screen: ScreenName;
  theme: ThemeName;
  /** Whether the dialogs and the open menus are shot too (the dark theme is for pages only). */
  dialogs: boolean;
}

const VARIANTS: readonly Variant[] = [
  { name: 'desktop-light', screen: 'desktop', theme: 'light', dialogs: true },
  { name: 'desktop-dark', screen: 'desktop', theme: 'dark', dialogs: false },
  { name: 'phone-light', screen: 'phone', theme: 'light', dialogs: true },
];

/** `budgets > New budget dialog, validation errors` becomes `budgets-new-budget-dialog-validation-errors`. */
function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const STOPS = richStops();

/**
 * The Telegram section of Settings in each state of the bot: these need a server with the bot and its
 * fake Telegram, so they are their own tests (below). The world is the one of the test that runs.
 */
let world: TelegramWorld | undefined;
const TELEGRAM_STOPS = telegramStops(() => {
  if (!world) throw new Error('A Telegram stop was opened outside a test');
  return world;
});

// Two stops with one name would share a baseline and silently overwrite each other.
const slugs = [...STOPS, ...TELEGRAM_STOPS].map((stop) => slug(stop.name));
const duplicates = slugs.filter((name, index) => slugs.indexOf(name) !== index);
if (duplicates.length > 0) {
  throw new Error(
    `Stops whose names give the same file name: ${[...new Set(duplicates)].join(', ')}`,
  );
}

test.use({
  walletNow: DEFAULT_NOW,
  // The yearly report of a year before the wallet started is a 404, by design: the page words it as
  // "No months to report" (docs/PLAN.md, Phase 6). The browser logs it like any failed request.
  allowedConsoleErrors: [failedResponse(404, /\/api\/reports\/yearly\/2025$/)],
});

/**
 * Text that comes from the server's clock, which ticks while a test runs (it is the fake instant plus
 * the time that passed), so the minutes and seconds of two runs differ. Each is replaced by a constant.
 */
const VOLATILE_TEXT: readonly [pattern: RegExp, replacement: string][] = [
  // `Mar 10, 2026, 9:00 AM`: only the time of day moves, the date is the fake one. Keeps the space
  // that ICU puts before AM (a narrow no-break space in recent versions).
  [/\b\d{1,2}:\d{2}(\s)([AP]M)\b/g, '9:00$1$2'],
  // A backup is named after the second it was made: `wallet-20260310-090013.db`.
  [/\bwallet-\d{8}-\d{6}\.db\b/g, 'wallet-20260310-090000.db'],
];

/**
 * The pairing code of Settings is random, and 8 characters of it are in the picture: it becomes a
 * constant of the same length.
 */
async function pinPairingCode(page: Page): Promise<void> {
  await page
    .locator('[data-pairing] code')
    .evaluateAll((codes) => codes.forEach((code) => (code.textContent = 'ABCD2345')));
}

async function pinVolatileText(page: Page): Promise<void> {
  await page.evaluate(
    (rules) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const before = node.nodeValue ?? '';
        let after = before;
        for (const [source, flags, replacement] of rules) {
          after = after.replace(new RegExp(source, flags), replacement);
        }
        if (after !== before) node.nodeValue = after;
      }
    },
    VOLATILE_TEXT.map(
      ([pattern, replacement]) => [pattern.source, pattern.flags, replacement] as const,
    ),
  );
}

/** Resolves when the page has not changed for a few frames: what it holds and how big it is. */
async function waitForStillLayout(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const fingerprint = () =>
          `${document.body.innerHTML.length}|${document.documentElement.scrollWidth}x${document.documentElement.scrollHeight}`;
        const started = performance.now();
        let last = '';
        let still = 0;
        const frame = () => {
          const now = fingerprint();
          still = now === last ? still + 1 : 0;
          last = now;
          // The upper bound only keeps a page that never rests from hanging the test: the screenshot
          // itself still insists on two identical pictures in a row.
          if (still >= 6 || performance.now() - started > 4000) resolve();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
}

/**
 * A toast goes away by itself after 5 seconds (12 with an "Undo"), and a shot of a page that has one
 * is taken somewhere between a fraction of a second and a few seconds after it appeared, depending on
 * how busy the machine is. So in these tests a toast stays: no timer of 4 seconds or more ever fires
 * in the page. Toasts are the only `setTimeout` of the app that long (the API check is a
 * `setInterval`, which is left alone), and the shot of a toast, which has to be the same every time,
 * is the one that needs it.
 */
async function keepToastsOnScreen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const setTimeoutOfPage = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
      typeof delay === 'number' && delay >= 4000
        ? 0
        : setTimeoutOfPage(handler, delay, ...args)) as typeof window.setTimeout;
  });
}

/**
 * Makes the window as tall as the page, for the full-page shot of a phone. The tab bar and the floating
 * "Add spending" button are fixed to the bottom of the window, and a full-page capture leaves them where
 * they are in the first screenful, over the middle of the content (and hides what is under them). A
 * window as tall as the page puts them where a person meets them, at the end of the page, with the sticky
 * top bar at its top, so the shot shows that nothing is hidden under the bars. Sizes that depend on the
 * window (the charts measure it) are given a few rounds to settle.
 */
async function growToPage(page: Page): Promise<void> {
  const width = page.viewportSize()?.width;
  if (width === undefined) return;
  for (let round = 0; round < 3; round++) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    if (height === page.viewportSize()?.height) return;
    await page.setViewportSize({ width, height });
    await waitForStillLayout(page);
  }
}

/** Brings the page, as the stop left it, to the state that a screenshot can compare. */
async function settleForShot(
  page: Page,
  options: { toTop: boolean; grow?: boolean },
): Promise<void> {
  await settle(page);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await waitForStillLayout(page);
  await pinVolatileText(page);
  await pinPairingCode(page);
  // Nothing hovered, and sticky bars where they belong: the stop may have scrolled to a button.
  await page.mouse.move(0, 0);
  // Not with a menu open: it closes when the page scrolls, and the shot is of what the window shows.
  if (options.toTop) {
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
  }
  if (options.grow) await growToPage(page);
  await waitForStillLayout(page);
}

for (const variant of VARIANTS) {
  test.describe(variant.name, () => {
    test.use({ ...SCREENS[variant.screen], colorScheme: variant.theme });

    for (const stop of STOPS) {
      if ((stop.modal || stop.menu) && !variant.dialogs) continue;
      // The "More" sheet is the tab bar's: only the phone has it.
      if (stop.screen !== undefined && stop.screen !== variant.screen) continue;
      const shot = `${slug(stop.name)}-${variant.name}`;

      test(shot, async ({ page, wallet }) => {
        test.info().annotations.push({ type: 'stop', description: stop.name });
        await seedWallet(wallet.api, { dataset: 'rich', theme: variant.theme });
        await keepToastsOnScreen(page);
        await stop.open(page);
        await expectTheme(page, variant.theme);
        // A phone's page is shot with a window as tall as the page (see `growToPage`); a dialog or a
        // menu is shot as the window shows it.
        await settleForShot(page, {
          toTop: !stop.menu,
          grow: variant.screen === 'phone' && !stop.modal && !stop.menu,
        });

        // A full page for a page. A modal dialog is positioned in the window, over a backdrop, and a
        // menu is placed in the window beside its button, so those are shot as the window shows them.
        await expect(page).toHaveScreenshot(`${shot}.png`, { fullPage: !stop.modal && !stop.menu });
      });
    }
  });
}

// The Telegram section of Settings, in each state of the bot (a server with the bot and its fake Telegram).
for (const variant of VARIANTS) {
  test.describe(`${variant.name}, Telegram`, () => {
    test.use({ ...SCREENS[variant.screen], colorScheme: variant.theme, telegramBot: true });

    for (const stop of TELEGRAM_STOPS) {
      if ((stop.modal || stop.menu) && !variant.dialogs) continue;
      const shot = `${slug(stop.name)}-${variant.name}`;

      test(shot, async ({ page, wallet, telegram }) => {
        test.info().annotations.push({ type: 'stop', description: stop.name });
        world = { wallet, telegram };
        await seedWallet(wallet.api, { dataset: 'rich', theme: variant.theme });
        await keepToastsOnScreen(page);
        await stop.open(page);
        await expectTheme(page, variant.theme);
        await settleForShot(page, {
          toTop: !stop.menu,
          grow: variant.screen === 'phone' && !stop.modal && !stop.menu,
        });
        await expect(page).toHaveScreenshot(`${shot}.png`, { fullPage: !stop.modal && !stop.menu });
      });
    }
  });
}
