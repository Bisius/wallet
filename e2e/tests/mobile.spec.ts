import type { Page } from '@playwright/test';
import { expect, failedResponse, test } from '../support/fixtures';
import {
  expectReachableTarget,
  measureBars,
  measureDialog,
  measureLayout,
  type LayoutReport,
} from '../support/layout';
import { moreButton, tabBar } from '../support/nav';
import {
  SCREENS,
  type Stop,
  type ThemeName,
  emptyStops,
  expectTheme,
  onScreen,
  onboardingStops,
  openPage,
  richStops,
  walk,
} from '../support/pages';
import { type Dataset, seedWallet } from '../support/rich-data';

/*
 * The wallet on a phone: 390 x 844 CSS px, `isMobile` (without it Chromium widens the layout viewport
 * to fit whatever overflows, and a page that scrolls sideways looks fine) and `hasTouch`.
 *
 * For every page and every dialog, in light and dark: nothing makes the page scroll sideways (when
 * something does, the test names the widest elements), everything a user presses is on the screen or
 * in a strip that scrolls to it, controls are at least 24 x 24 CSS px (WCAG 2.2, 2.5.8), the page's
 * main action can be seen and hit, and no amount of money is cut off.
 *
 * The content is ordinary (`rich`), then the worst a user can type, in two datasets so that a failure
 * says which kind it cannot take: `long-text` (a 60 character name with nothing to break at, a 200
 * character description likewise, a 1000 character note, ten tags on one spending) and `big-amounts`
 * (the most the API accepts, `MAX_CENTS`, 10 billion).
 */

const THEMES: ThemeName[] = ['light', 'dark'];

// Playwright waits for a missing button until the test times out. A stop that cannot be brought up
// must fail within seconds, so the walk can go on to the next one.
test.use({
  actionTimeout: 10_000,
  navigationTimeout: 30_000,
  // The yearly report of a year before the wallet started is a 404, by design: the page words it as
  // "No months to report" (docs/PLAN.md, Phase 6). The browser logs it like any failed request.
  allowedConsoleErrors: [failedResponse(404, /\/api\/reports\/yearly\/2025$/)],
});
const WALK_TIMEOUT_MS = 420_000;

/** Reports what `measureLayout` found for one stop, softly, so one run lists every stop's problems. */
async function expectPhoneLayout(page: Page, stop: Stop, label: string): Promise<LayoutReport> {
  const layout = await measureLayout(page);
  expect.soft(layout.overflow, `${label}: the page scrolls sideways`).toEqual([]);
  expect.soft(layout.unreachable, `${label}: controls outside the screen`).toEqual([]);
  expect.soft(layout.clippedAmounts, `${label}: amounts of money that are cut off`).toEqual([]);
  expect.soft(layout.clippedText, `${label}: text that is cut off`).toEqual([]);
  if (layout.smallTargets.length > 0) {
    // Under 24 x 24 CSS px is only a failure of WCAG 2.2 (2.5.8) when neighbouring targets are too
    // close, which is what axe's `target-size` rule decides (a11y.spec.ts, phone). Worth knowing.
    test.info().annotations.push({
      type: `small target, ${stop.name}`,
      description: layout.smallTargets.join('\n'),
    });
  }
  if (layout.truncatedText.length > 0) {
    // Shortened on purpose (an ellipsis). Worth knowing, not a failure.
    test.info().annotations.push({
      type: `truncated text, ${stop.name}`,
      description: layout.truncatedText.join('\n'),
    });
  }

  if (stop.modal) {
    expect
      .soft(await measureDialog(page), `${label}: the dialog does not fit the screen`)
      .toEqual([]);
  } else if (!stop.menu) {
    // The tab bar and the floating button are fixed over the end of the page: it has to leave room.
    // (An open menu closes when the page scrolls, so the stops that show one are left out.)
    const bars = await measureBars(page);
    expect.soft(bars.covered, `${label}: the bars cover the end of the page`).toEqual([]);
  }
  const primary = stop.primary?.(page);
  if (primary) {
    await expectReachableTarget(primary, `${label}: the main action`);
    // A dialog keeps its buttons in view without scrolling (a sticky footer).
    if (stop.modal) {
      await expect
        .soft(primary, `${label}: the dialog's main button is on screen without scrolling`)
        .toBeInViewport({ ratio: 1 });
    }
  }
  return layout;
}

for (const theme of THEMES) {
  test.describe(`phone, ${theme} theme`, () => {
    test.use({ ...SCREENS.phone, colorScheme: theme });

    const label = (stop: string, dataset: Dataset | 'new') =>
      `${stop} | ${theme} | phone | ${dataset}`;

    for (const dataset of ['rich', 'long-text', 'big-amounts', 'empty'] as const) {
      test(`every page and state ${
        {
          rich: 'with ordinary content',
          'long-text': 'with the longest names, descriptions and notes',
          'big-amounts': 'with the largest amounts',
          empty: 'of a new, empty wallet',
        }[dataset]
      }`, async ({ page, wallet }) => {
        test.setTimeout(WALK_TIMEOUT_MS);
        await seedWallet(wallet.api, { dataset, theme });
        const stops = dataset === 'empty' ? emptyStops() : onScreen(richStops(), 'phone');

        await openPage(page, '/dashboard', 'Dashboard');
        await expectTheme(page, theme);

        await walk(page, stops, async (stop) => {
          await expectPhoneLayout(page, stop, label(stop.name, dataset));
        });
      });
    }

    test.describe('a wallet that was never set up', () => {
      // `GET /api/settings` is a 404 until the wizard is done, by design (see onboarding.spec.ts).
      test.use({ allowedConsoleErrors: [failedResponse(404, /\/api\/settings$/)] });

      test('the welcome wizard', async ({ page }) => {
        test.setTimeout(WALK_TIMEOUT_MS);
        await walk(page, onboardingStops(), async (stop) => {
          await expectPhoneLayout(page, stop, label(stop.name, 'new'));
        });
      });
    });
  });
}

test.describe('the narrowest phone, 320 px (WCAG 1.4.10 Reflow)', () => {
  // 320 CSS px is what a 1280 px window shows at 400% zoom. Reflow asks for no sideways scrolling
  // there, except for what is a table or a chart in its own scrolling box.
  test.use({
    viewport: { width: 320, height: 568 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'light',
  });

  test('every page and state with ordinary content', async ({ page, wallet }) => {
    test.setTimeout(WALK_TIMEOUT_MS);
    await seedWallet(wallet.api, { dataset: 'rich', theme: 'light' });
    await openPage(page, '/dashboard', 'Dashboard');
    await walk(page, onScreen(richStops(), 'phone'), async (stop) => {
      await expectPhoneLayout(page, stop, `${stop.name} | light | 320 px | rich`);
    });
  });
});

test.describe('the shell on a phone: one short top bar, a tab bar, a floating button', () => {
  test.use({ ...SCREENS.phone, colorScheme: 'light' });

  test('the chrome is a bar of about 60 px on top and a tab bar below, with the button above it', async ({
    page,
    wallet,
  }) => {
    await seedWallet(wallet.api, { dataset: 'rich', theme: 'light' });
    await openPage(page, '/dashboard', 'Dashboard');

    const bars = await measureBars(page);
    const screen = SCREENS.phone.viewport;
    // It was about 170 px above the content (the brand row, a strip of links, the month bar).
    expect(bars.topBarHeight, 'the top bar').toBeLessThanOrEqual(64);
    expect(bars.topBarTopWhenScrolled, 'the top bar sticks to the top of the window').toBe(0);
    expect(bars.tabBar, 'a tab bar').not.toBeNull();
    const tabs = bars.tabBar ?? { top: 0, height: 0 };
    expect(tabs.height, 'tabs are at least 56 px tall').toBeGreaterThanOrEqual(56);
    expect(tabs.top + tabs.height, 'the tab bar is fixed to the bottom edge').toBeCloseTo(
      screen.height,
      0,
    );
    const fab = bars.fab ?? { top: 0, height: 0 };
    expect(fab.height, 'the floating button is 56 px').toBe(56);
    expect(fab.top + fab.height, 'the button floats above the tab bar').toBeLessThan(tabs.top);

    // Each tab is a target a thumb finds: 44 px or more both ways.
    for (const control of [...(await tabBar(page).getByRole('link').all()), moreButton(page)]) {
      const box = await control.boundingBox();
      expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(44);
    }

    // A focused control is scrolled clear of the bars: the window leaves room for all of them.
    const padding = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        top: parseFloat(style.scrollPaddingTop),
        bottom: parseFloat(style.scrollPaddingBottom),
      };
    });
    expect(padding.top, 'scroll padding above').toBeGreaterThanOrEqual(bars.topBarHeight);
    expect(padding.bottom, 'scroll padding below').toBeGreaterThanOrEqual(screen.height - fab.top);
  });

  test('the check for the bars sees content that is under them when there is some', async ({
    page,
    wallet,
  }) => {
    await seedWallet(wallet.api, { dataset: 'rich', theme: 'light' });
    await openPage(page, '/dashboard', 'Dashboard');
    expect((await measureBars(page)).covered, 'a clean page').toEqual([]);

    // Take away the room that the page leaves under its content: the end of it is under the bars.
    await page.evaluate(() => {
      const main = document.querySelector('main');
      if (main) main.style.paddingBottom = '0';
    });
    const covered = (await measureBars(page)).covered;
    expect(covered.join('\n')).toContain('under the bar that starts at');
  });

  test('a toast sits above the tab bar and the button, so neither is covered', async ({
    page,
    wallet,
  }) => {
    await seedWallet(wallet.api, { dataset: 'rich', theme: 'light' });
    await openPage(page, '/settings', 'Settings');
    await page.getByRole('button', { name: 'Back up now' }).click();
    const toast = page
      .getByRole('status')
      .filter({ hasText: /backup/i })
      .last();
    await expect(toast).toBeVisible();

    const bars = await measureBars(page);
    const box = await toast.boundingBox();
    expect(box, 'the toast has a box').not.toBeNull();
    const limit = Math.min(bars.tabBar?.top ?? Infinity, bars.fab?.top ?? Infinity);
    expect((box?.y ?? 0) + (box?.height ?? 0), 'the toast ends above the bars').toBeLessThanOrEqual(
      limit,
    );
  });

  test('the bars never make the page scroll sideways, whichever period the page has', async ({
    page,
    wallet,
  }) => {
    await seedWallet(wallet.api, { dataset: 'rich', theme: 'light' });
    for (const [path, heading] of [
      ['/dashboard', 'Dashboard'],
      ['/report', 'Yearly report'],
      ['/savings', 'Savings'],
    ] as const) {
      await openPage(page, path, heading);
      const layout = await measureLayout(page);
      expect(layout.overflow, `${path}: the page scrolls sideways`).toEqual([]);
      expect(layout.unreachable, `${path}: controls outside the screen`).toEqual([]);
    }
  });
});

test.describe('the narrowest phone: the top bar may take two rows, and fits', () => {
  test.use({
    viewport: { width: 320, height: 568 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'light',
  });

  test('the brand and the switcher do not overflow, and the window keeps room for the two rows', async ({
    page,
    wallet,
  }) => {
    await seedWallet(wallet.api, { dataset: 'rich', theme: 'light' });
    for (const [path, heading] of [
      ['/dashboard', 'Dashboard'],
      ['/report', 'Yearly report'],
    ] as const) {
      await openPage(page, path, heading);
      const layout = await measureLayout(page);
      expect(layout.overflow, `${path}: the page scrolls sideways`).toEqual([]);
      const bars = await measureBars(page);
      expect(bars.topBarHeight, `${path}: the top bar`).toBeLessThanOrEqual(100);
      const top = await page.evaluate(() =>
        parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop),
      );
      expect(top, `${path}: scroll padding above`).toBeGreaterThanOrEqual(bars.topBarHeight);
    }
  });
});

test.describe('the phone checks themselves', () => {
  test.use({ ...SCREENS.phone, colorScheme: 'light' });

  // A check that cannot fail proves nothing. Make the page wrong on purpose and see that it says so.
  test('see an overflow, a tiny control and a cut-off amount when there is one', async ({
    page,
    wallet,
  }) => {
    await seedWallet(wallet.api, { dataset: 'empty', theme: 'light' });
    await openPage(page, '/dashboard', 'Dashboard');
    const clean = await measureLayout(page);
    expect(clean.overflow).toEqual([]);
    expect(clean.smallTargets).toEqual([]);
    expect(clean.clippedAmounts).toEqual([]);

    await page.evaluate(() => {
      const wide = document.createElement('div');
      wide.id = 'wider-than-the-screen';
      wide.style.cssText = 'width: 640px; height: 8px; background: red';
      const tiny = document.createElement('button');
      tiny.textContent = 'x';
      tiny.style.cssText = 'width: 10px; height: 10px; padding: 0';
      const cut = document.createElement('p');
      cut.textContent = '€10,000,000,000.00';
      cut.style.cssText = 'width: 40px; overflow: hidden; white-space: nowrap';
      document.querySelector('main')?.append(wide, tiny, cut);
    });
    const broken = await measureLayout(page);
    expect(broken.overflow.join('\n')).toContain('wider-than-the-screen');
    expect(broken.smallTargets.join('\n')).toContain('10 x 10');
    expect(broken.clippedAmounts.join('\n')).toContain('€10,000,000,000.00');
  });
});

test.describe('installing on a phone', () => {
  test.use({ ...SCREENS.phone, colorScheme: 'light' });

  /** The width and height that a PNG file says it has, from its header. */
  function pngSize(bytes: Buffer): { width: number; height: number } | null {
    const signature = '89504e470d0a1a0a';
    if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== signature) return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  interface Icon {
    src: string;
    sizes?: string;
    type?: string;
    purpose?: string;
  }
  interface Manifest {
    name?: string;
    short_name?: string;
    start_url?: string;
    scope?: string;
    display?: string;
    theme_color?: string;
    background_color?: string;
    icons?: Icon[];
    shortcuts?: { name: string; url: string; icons?: Icon[] }[];
  }

  test('the manifest is linked, valid, and its icons and shortcut work', async ({
    page,
    wallet,
  }) => {
    await seedWallet(wallet.api, { dataset: 'empty', theme: 'light' });
    await openPage(page, '/dashboard', 'Dashboard');

    // The page links to it, and it is where the link says.
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href, '<link rel="manifest"> in the page').not.toBeNull();
    const manifestUrl = new URL(href ?? '', page.url()).toString();
    const response = await page.request.get(manifestUrl);
    expect(response.status(), 'GET the manifest').toBe(200);
    expect(response.headers()['content-type'] ?? '', 'manifest content type').toMatch(/json/);
    const manifest = (await response.json()) as Manifest;

    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name, 'a short name for the home screen').toBeTruthy();
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBeTruthy();
    expect(manifest.scope).toBeTruthy();

    // Icons: the two sizes an install needs, each one a real PNG of the size it claims, and one that
    // is safe to crop (maskable).
    const icons = manifest.icons ?? [];
    expect(icons.length, 'icons in the manifest').toBeGreaterThan(0);
    for (const icon of icons) {
      const file = await page.request.get(new URL(icon.src, manifestUrl).toString());
      expect(file.status(), `GET ${icon.src}`).toBe(200);
      const size = pngSize(await file.body());
      expect(size, `${icon.src} is a PNG`).not.toBeNull();
      expect(`${size?.width}x${size?.height}`, `${icon.src} is the size the manifest says`).toBe(
        icon.sizes,
      );
    }
    const claimed = icons.map((icon) => icon.sizes);
    expect(claimed, 'a 192 px icon').toContain('192x192');
    expect(claimed, 'a 512 px icon').toContain('512x512');
    expect(
      icons.some((icon) => icon.purpose?.split(' ').includes('maskable')),
      'a maskable icon',
    ).toBe(true);

    // The "Add spending" shortcut points at a page that does that.
    const shortcut = manifest.shortcuts?.find((candidate) => candidate.name === 'Add spending');
    expect(shortcut, 'an "Add spending" shortcut').toBeDefined();
    for (const icon of shortcut?.icons ?? []) {
      const file = await page.request.get(new URL(icon.src, manifestUrl).toString());
      expect(file.status(), `GET the shortcut icon ${icon.src}`).toBe(200);
    }
    await page.goto(new URL(shortcut?.url ?? '/', manifestUrl).toString());
    await expect(page.getByRole('heading', { level: 1, name: 'Spendings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Add a spending' })).toBeVisible();

    // The apple touch icon, which iOS uses instead of the manifest.
    const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
    expect(apple, '<link rel="apple-touch-icon">').not.toBeNull();
    const appleFile = await page.request.get(new URL(apple ?? '', page.url()).toString());
    expect(appleFile.status(), 'GET the apple touch icon').toBe(200);
    expect(pngSize(await appleFile.body())).toEqual({ width: 180, height: 180 });
  });

  test('the toolbar colour is set', async ({ page, wallet }) => {
    await seedWallet(wallet.api, { dataset: 'empty', theme: 'light' });
    await openPage(page, '/dashboard', 'Dashboard');

    const metas = await page.evaluate(() =>
      [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => ({
        content: meta.getAttribute('content') ?? '',
        media: meta.getAttribute('media') ?? '',
      })),
    );
    expect(metas.length, '<meta name="theme-color"> in the page').toBeGreaterThan(0);
    for (const meta of metas) expect(meta.content).toMatch(/^#[0-9a-f]{6}$/i);
  });

  // The browser colours its toolbar from the first <meta name="theme-color"> whose media query
  // matches, and the queries ask about the operating system. A user who picked a theme in the settings
  // that differs from their system gets a toolbar that clashes with the page unless the app follows.
  for (const [saved, system] of [
    ['light', 'light'],
    ['dark', 'dark'],
    ['dark', 'light'],
    ['light', 'dark'],
  ] as const) {
    test.describe(`theme ${saved} in the settings, system ${system}`, () => {
      test.use({ colorScheme: system });

      test('the toolbar colour is the colour of the page', async ({ page, wallet }) => {
        await seedWallet(wallet.api, { dataset: 'empty', theme: saved });
        await openPage(page, '/dashboard', 'Dashboard');
        await expectTheme(page, saved, system);

        const seen = await page.evaluate(() => {
          const applied = [...document.querySelectorAll('meta[name="theme-color"]')].find(
            (meta) =>
              !meta.getAttribute('media') || matchMedia(meta.getAttribute('media') ?? '').matches,
          );
          const rootStyle = getComputedStyle(document.documentElement);
          const colour = (name: string) => {
            // Normalise through a canvas: the variable is "#0f172a", the answer is "rgb(15, 23, 42)".
            const probe = document.createElement('i');
            probe.style.color = rootStyle.getPropertyValue(name).trim();
            document.body.append(probe);
            const rgb = getComputedStyle(probe).color;
            probe.remove();
            return rgb;
          };
          const toRgb = (hex: string) => {
            const probe = document.createElement('i');
            probe.style.color = hex;
            document.body.append(probe);
            const rgb = getComputedStyle(probe).color;
            probe.remove();
            return rgb;
          };
          return {
            toolbar: applied ? toRgb(applied.getAttribute('content') ?? '') : null,
            surface: colour('--color-surface'),
            canvas: colour('--color-canvas'),
          };
        });
        expect(
          [seen.surface, seen.canvas],
          `the toolbar is ${seen.toolbar}, the page is ${seen.surface} (header) and ${seen.canvas} (background)`,
        ).toContain(seen.toolbar);
      });
    });
  }

  test('zooming is not switched off', async ({ page, request, wallet }) => {
    await seedWallet(wallet.api, { dataset: 'empty', theme: 'light' });
    // The file as the server sends it, and the page after the app started: both must allow zoom
    // (WCAG 1.4.4 Resize Text). `user-scalable=no` and `maximum-scale=1` are what take it away.
    const served = await (await request.get('/')).text();
    const sentContent = /<meta[^>]*name="viewport"[^>]*content="([^"]*)"/i.exec(served)?.[1];
    expect(sentContent, '<meta name="viewport"> in the HTML that the server sends').toBeDefined();

    await openPage(page, '/dashboard', 'Dashboard');
    const live = await page
      .locator('meta[name="viewport"]')
      .evaluateAll((metas) => metas.map((meta) => meta.getAttribute('content') ?? ''));
    expect(live, 'exactly one viewport meta tag in the page').toHaveLength(1);

    for (const content of [sentContent ?? '', ...live]) {
      expect(content).toContain('width=device-width');
      expect(content, 'user-scalable').not.toMatch(/user-scalable\s*=\s*(no|0)/i);
      const maximum = /maximum-scale\s*=\s*([\d.]+)/i.exec(content)?.[1];
      // WCAG asks for at least 200% (and 500% is what Android allows when it is not limited).
      expect(maximum === undefined || Number(maximum) >= 2, `maximum-scale ${maximum}`).toBe(true);
      expect(content, 'minimum-scale').not.toMatch(/minimum-scale\s*=\s*(?!0\.|1\b)\d/i);
    }
  });
});
