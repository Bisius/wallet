import type { Page } from '@playwright/test';
import { a11yScan, a11yViolations, expectNoA11yViolations, formatViolations } from '../support/axe';
import { expect, failedResponse, test } from '../support/fixtures';
import { openMenuItem } from '../support/menu';
import { goToPage, moreButton, moreSheet, type NavPage, tabBar } from '../support/nav';
import {
  type ScreenName,
  SCREENS,
  type ThemeName,
  apiStatus,
  eachStop,
  emptyStops,
  expectDialogOpen,
  expectTheme,
  onScreen,
  onboardingStops,
  openDialog,
  openPage,
  richStops,
  settle,
  walk,
} from '../support/pages';
import { type Dataset, seedWallet } from '../support/rich-data';

/*
 * Accessibility, with axe-core, of every page and every state a user opens, in both themes and on
 * both screens, plus the things axe cannot see: keyboard focus going into a dialog and coming back,
 * and focus never hidden.
 *
 * The frontend's rule (`frontend/.claude/CLAUDE.md`) is that the app MUST pass all axe checks and
 * follow WCAG AA, so these tests assert zero violations. They are not allowed to turn a rule off or
 * leave a page out to get green: see `support/axe.ts`.
 *
 * One test walks all the stops of one theme x screen x dataset (a server per test costs about a
 * second, a page costs less), as a `test.step` each. A violation is collected, not thrown, so one run
 * lists every page's trouble. The label of a failure reads "stop | theme | screen | dataset".
 *
 * The browser error guard stays on everywhere. Two tests allow what is by design: a wallet that was
 * never set up answers `GET /api/settings` with a 404, and a server that is stopped or made to fail
 * on purpose makes the browser log the refused or failed request.
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
const SCREEN_NAMES: ScreenName[] = ['desktop', 'phone'];

/** About 50 stops with an axe run each: more than the 45 seconds of a normal test, on a busy machine. */
const WALK_TIMEOUT_MS = 420_000;

for (const theme of THEMES) {
  for (const screen of SCREEN_NAMES) {
    test.describe(`axe, ${theme} theme, ${screen}`, () => {
      test.use({ ...SCREENS[screen], colorScheme: theme });

      const where = (stop: string, dataset: Dataset | 'new') =>
        `${stop} | ${theme} | ${screen} | ${dataset}`;

      /** Dark must really be dark (and light light) before any colour is judged. */
      const themeIsApplied = async (page: Page, stop: string) => {
        const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
        expect
          .soft(dark, `${stop}: <html class="dark"> is ${theme === 'dark' ? 'set' : 'absent'}`)
          .toBe(theme === 'dark');
      };

      for (const dataset of ['rich', 'empty'] as const) {
        test(`every page and state of a ${dataset === 'rich' ? 'full' : 'new, empty'} wallet`, async ({
          page,
          wallet,
        }) => {
          test.setTimeout(WALK_TIMEOUT_MS);
          await seedWallet(wallet.api, { dataset, theme });
          const stops = dataset === 'rich' ? onScreen(richStops(), screen) : emptyStops();

          await openPage(page, '/dashboard', 'Dashboard');
          await expectTheme(page, theme);

          await walk(page, stops, async (stop) => {
            await themeIsApplied(page, stop.name);
            await expectNoA11yViolations(page, where(stop.name, dataset));
          });
        });
      }

      test.describe('a wallet that was never set up', () => {
        // `GET /api/settings` is a 404 until the wizard is done, by design (see onboarding.spec.ts).
        test.use({ allowedConsoleErrors: [failedResponse(404, /\/api\/settings$/)] });

        test('the welcome wizard, step by step', async ({ page }) => {
          test.setTimeout(WALK_TIMEOUT_MS);
          await walk(page, onboardingStops(), async (stop) => {
            await themeIsApplied(page, stop.name);
            await expectNoA11yViolations(page, where(stop.name, 'new'));
          });
        });
      });

      test('every page, when the server stops answering', async ({
        page,
        wallet,
        browserErrors,
      }) => {
        test.setTimeout(WALK_TIMEOUT_MS);
        // The browser logs each refused request. That is the situation under test.
        browserErrors.allow(/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE/);
        await seedWallet(wallet.api, { dataset: 'rich', theme });

        const pages: { link: NavPage; heading: string }[] = [
          { link: 'Dashboard', heading: 'Dashboard' },
          { link: 'Budgets', heading: 'Budgets' },
          { link: 'Spendings', heading: 'Spendings' },
          { link: 'Subscriptions', heading: 'Subscriptions' },
          { link: 'Income', heading: 'Income' },
          { link: 'Savings', heading: 'Savings' },
          { link: 'Report', heading: 'Yearly report' },
          { link: 'Settings', heading: 'Settings' },
        ];

        // A user whose server dies while the app is open has visited the pages: their code is loaded.
        // (A phone reaches the last four through the "More" sheet: `goToPage` does it either way.)
        await openPage(page, '/dashboard', 'Dashboard');
        for (const { link, heading } of pages) {
          await goToPage(page, link);
          await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
          await settle(page);
        }

        await wallet.stop();
        // The browser tells the app it is offline, which makes it ask the server and say so.
        await page.evaluate(() => window.dispatchEvent(new Event('offline')));
        await expect(apiStatus(page, 'API offline')).toBeVisible();

        await eachStop(
          pages.map(({ link, heading }) => ({
            name: `${heading} (server down)`,
            open: async (target: Page) => {
              await goToPage(target, link);
              await expect(target.getByRole('heading', { level: 1, name: heading })).toBeVisible();
              // Every page that loads something says what failed, in an alert with a way to retry.
              await expect(target.getByRole('alert').first()).toBeVisible();
              await expect(
                target.getByRole('status').filter({ hasText: /^\s*Loading/ }),
              ).toHaveCount(0);
            },
          })),
          async (stop) => {
            await stop.open(page);
            await themeIsApplied(page, stop.name);
            await expectNoA11yViolations(page, where(stop.name, 'rich'));
          },
        );
      });

      test('the "Wallet can\'t load" page', async ({ page, wallet, browserErrors }) => {
        // This is the one state that needs a server that fails on `GET /api/settings`, which a healthy
        // real one never does, so this single route answers 500 like a broken database would.
        browserErrors.allow(failedResponse(500, /\/api\/settings$/));
        await seedWallet(wallet.api, { dataset: 'empty', theme });
        await page.route('**/api/settings', (route) =>
          route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'internal_error', message: 'The database is locked.' },
            }),
          }),
        );

        await page.goto('/dashboard');
        await expect(page).toHaveURL(/\/unavailable/);
        await expect(
          page.getByRole('heading', { level: 1, name: "Wallet can't load" }),
        ).toBeVisible();
        await expect(page.getByRole('alert').filter({ hasText: 'What went wrong' })).toContainText(
          'The database is locked.',
        );
        await settle(page);
        await themeIsApplied(page, 'unavailable');
        await expectNoA11yViolations(page, where('unavailable', 'empty'));
      });
    });
  }
}

test.describe('keyboard, light theme, desktop', () => {
  test.use({ ...SCREENS.desktop, colorScheme: 'light' });

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

  test('every dialog takes focus, keeps it, and gives it back to what opened it', async ({
    page,
    wallet,
  }) => {
    test.setTimeout(WALK_TIMEOUT_MS);
    await seedWallet(wallet.api, { dataset: 'rich', theme: 'light' });
    const insideDialog = () =>
      page.evaluate(() => document.activeElement?.closest('dialog[open]') !== null);

    const dialogs = onScreen(richStops(), 'desktop').filter((stop) => stop.dialog);
    expect(dialogs.length, 'dialogs to check').toBeGreaterThan(25);

    await eachStop(dialogs, async ({ dialog }) => {
      if (!dialog) return;
      await openPage(page, dialog.path, dialog.heading);
      await dialog.prepare?.(page);

      // Open it as a keyboard user does: focus the control and press Enter. A dialog that an item of
      // a "More actions" menu opens takes two: Enter opens the menu, then the item is reached and
      // pressed. `opener` is then the button of the menu, which is where focus comes back to.
      const opener = dialog.opener(page);
      await opener.focus();
      await expect(opener).toBeFocused();
      await page.keyboard.press('Enter');
      if (dialog.menuItem !== undefined) {
        const item = openMenuItem(opener, dialog.menuItem);
        await expect(item).toBeVisible();
        await item.focus();
        await page.keyboard.press('Enter');
      }
      await expectDialogOpen(page);
      const box = openDialog(page);

      // 1. Focus moved into the dialog.
      await expect.poll(insideDialog, { message: 'focus is inside the dialog' }).toBe(true);

      // 2. It cannot leave: more Tab presses than there are controls, and the same backwards. A native
      // modal dialog hands focus to the browser's own controls after its last one, which is no
      // control of the page (`<body>`), and then comes back to its first. What must never happen is
      // focus landing on the page behind it, and every control of the dialog must be reachable.
      const reachable = await box.locator(FOCUSABLE).evaluateAll((nodes) => {
        const shown = nodes.filter(
          (node) =>
            node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden',
        );
        // A group of radio buttons is one stop of the Tab key, whatever its size: the arrow keys
        // move inside it.
        const radios = shown.filter(
          (node): node is HTMLInputElement =>
            node instanceof HTMLInputElement && node.type === 'radio',
        );
        const groups = new Set(radios.map((radio) => radio.name));
        // A date takes three presses (day, month, year) and a month two: their fields are stops too.
        const fields = shown.reduce(
          (sum, node) =>
            sum + (node instanceof HTMLInputElement ? ({ date: 2, month: 1 }[node.type] ?? 0) : 0),
          0,
        );
        return { stops: shown.length - radios.length + groups.size, fields };
      });
      const visit = () =>
        page.evaluate(() => {
          const active = document.activeElement;
          if (!active || active === document.body) return 'browser';
          if (!active.closest('dialog[open]')) {
            return `outside: <${active.tagName.toLowerCase()}> "${(active.textContent ?? '').trim().slice(0, 30)}"`;
          }
          active.setAttribute('data-keyboard-visited', '');
          return 'dialog';
        });
      for (const key of ['Tab', 'Shift+Tab']) {
        for (let press = 0; press < reachable.stops + reachable.fields + 2; press += 1) {
          await page.keyboard.press(key);
          expect(await visit(), `where focus is after ${key} ${press + 1}`).not.toMatch(/^outside/);
        }
      }
      const visited = await box.locator('[data-keyboard-visited]').evaluateAll((nodes) => {
        const radios = nodes.filter(
          (node): node is HTMLInputElement =>
            node instanceof HTMLInputElement && node.type === 'radio',
        );
        return nodes.length - radios.length + new Set(radios.map((radio) => radio.name)).size;
      });
      const missed = await box.locator(FOCUSABLE).evaluateAll((nodes) =>
        nodes
          .filter(
            (node) =>
              node.getClientRects().length > 0 && !node.hasAttribute('data-keyboard-visited'),
          )
          .filter((node) => !(node instanceof HTMLInputElement && node.type === 'radio'))
          .map(
            (node) =>
              `<${node.tagName.toLowerCase()}${node instanceof HTMLInputElement ? ` type=${node.type}` : ''}> "${(node.getAttribute('aria-label') ?? node.textContent ?? '').trim().slice(0, 30)}"`,
          ),
      );
      expect(
        visited,
        `controls of the dialog that Tab reached, of ${reachable.stops}; not reached: ${missed.join(', ')}`,
      ).toBe(reachable.stops);

      // 3. Escape closes it, and focus is back on the control that opened it.
      await page.keyboard.press('Escape');
      await expect(box).toBeHidden();
      await expect(opener, 'focus returns to the control that opened the dialog').toBeFocused();
    });
  });

  test('a new page takes focus on its heading, so a keyboard user knows where they are', async ({
    page,
    wallet,
  }) => {
    await seedWallet(wallet.api, { dataset: 'rich', theme: 'light' });
    await openPage(page, '/dashboard', 'Dashboard');
    const nav = page.getByRole('navigation', { name: 'Main' });

    for (const [link, heading] of [
      ['Budgets', 'Budgets'],
      ['Spendings', 'Spendings'],
      ['Subscriptions', 'Subscriptions'],
      ['Income', 'Income'],
      ['Settings', 'Settings'],
    ] as const) {
      await nav.getByRole('link', { name: link }).focus();
      await page.keyboard.press('Enter');
      const title = page.getByRole('heading', { level: 1, name: heading });
      await expect(
        title,
        `focus is on the "${heading}" heading after Enter on its link`,
      ).toBeFocused();
      // The link of the page you are on says so.
      await expect(nav.getByRole('link', { name: link })).toHaveAttribute('aria-current', 'page');
    }
  });
});

test.describe('keyboard, light theme, phone', () => {
  test.use({ ...SCREENS.phone, colorScheme: 'light' });

  test('the tab bar and the "More" sheet work with keys, and a new page takes focus on its heading', async ({
    page,
    wallet,
  }) => {
    await seedWallet(wallet.api, { dataset: 'rich', theme: 'light' });
    await openPage(page, '/dashboard', 'Dashboard');
    const title = (name: string) => page.getByRole('heading', { level: 1, name });

    // A tab: Enter on its link, focus on the heading, and the tab says it is the page.
    const budgets = tabBar(page).getByRole('link', { name: 'Budgets' });
    await budgets.focus();
    await page.keyboard.press('Enter');
    await expect(title('Budgets'), 'focus is on the "Budgets" heading after Enter').toBeFocused();
    await expect(budgets).toHaveAttribute('aria-current', 'page');

    // "More": Enter opens the sheet and focus goes into it. Escape closes it and gives focus back.
    const more = moreButton(page);
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(moreSheet(page)).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('dialog[open]') !== null), {
        message: 'focus is inside the sheet',
      })
      .toBe(true);
    await page.keyboard.press('Escape');
    await expect(moreSheet(page)).toBeHidden();
    await expect(more, 'focus returns to the More button').toBeFocused();

    // An item of the sheet with Enter: the page takes focus on its heading, and "More" says the page
    // is one of its items (in words: aria-current is for links).
    for (const [name, heading] of [
      ['Subscriptions', 'Subscriptions'],
      ['Income', 'Income'],
      ['Report', 'Yearly report'],
      ['Settings', 'Settings'],
    ] as const) {
      await more.focus();
      await page.keyboard.press('Enter');
      const item = moreSheet(page).getByRole('link', { name });
      await expect(item).toBeVisible();
      await item.focus();
      await page.keyboard.press('Enter');
      await expect(
        title(heading),
        `focus is on the "${heading}" heading after Enter`,
      ).toBeFocused();
      await expect(moreSheet(page)).toBeHidden();
      await expect(more).toHaveAccessibleName(new RegExp(`^More\\s*,\\s*current page: ${name}$`));
      await expect(more).not.toHaveAttribute('aria-current');
    }
  });
});

for (const screen of SCREEN_NAMES) {
  test.describe(`focus, ${screen}`, () => {
    test.use({ ...SCREENS[screen], colorScheme: 'light' });

    // WCAG 2.4.7 (a focused control shows it) and 2.4.11, new in 2.2 (it is not hidden behind a
    // sticky bar or a toast). Axe tests neither, and both fail silently: tabbing just seems to lose
    // the place.
    test('every control that takes focus shows it and is not covered', async ({ page, wallet }) => {
      test.setTimeout(WALK_TIMEOUT_MS);
      await seedWallet(wallet.api, { dataset: 'rich', theme: 'light' });

      const pages = [
        ['/dashboard', 'Dashboard'],
        ['/budgets', 'Budgets'],
        ['/spendings', 'Spendings'],
        ['/subscriptions', 'Subscriptions'],
        ['/income', 'Income'],
        ['/savings', 'Savings'],
        ['/report', 'Yearly report'],
        ['/settings', 'Settings'],
        ['/import', 'Import CSV'],
      ] as const;

      await eachStop(
        pages.map(([path, heading]) => ({
          name: path,
          open: (target: Page) => openPage(target, path, heading),
        })),
        async (stop) => {
          await stop.open(page);
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          const problems: string[] = [];
          const seen = new Set<string>();
          for (let press = 0; press < 90; press += 1) {
            await page.keyboard.press('Tab');
            const focus = await page.evaluate(() => {
              const element = document.activeElement;
              if (!element || element === document.body) return null;
              const style = getComputedStyle(element);
              const box = element.getBoundingClientRect();
              const x = Math.min(Math.max(box.left + box.width / 2, 1), window.innerWidth - 1);
              const y = Math.min(Math.max(box.top + box.height / 2, 1), window.innerHeight - 1);
              const top = document.elementFromPoint(x, y);
              const labelled = (element as HTMLInputElement).labels?.[0]?.textContent;
              const name = (
                element.getAttribute('aria-label') ??
                labelled ??
                element.textContent ??
                ''
              )
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 40);
              // A radio or checkbox that is visually hidden shows its focus on the box that follows it.
              const hidden = box.width <= 1.5 || box.height <= 1.5;
              const sibling = hidden
                ? (element.nextElementSibling ?? element.parentElement?.nextElementSibling)
                : null;
              const ringOf = (target: Element | null) => {
                if (!target) return false;
                const css = getComputedStyle(target);
                const outline = css.outlineStyle !== 'none' && parseFloat(css.outlineWidth) > 0;
                return outline || css.boxShadow !== 'none';
              };
              // A control may show its focus on the box around it (`has-[:focus-visible]`).
              const wrapperRing =
                ringOf(element.parentElement) ||
                ringOf(element.parentElement?.parentElement ?? null);
              const label = element.closest('label');
              return {
                key: `${element.tagName}|${name}|${Math.round(box.left)}|${Math.round(box.top + window.scrollY)}`,
                name: `<${element.tagName.toLowerCase()}> "${name}"`,
                ring:
                  ringOf(element) ||
                  wrapperRing ||
                  (hidden &&
                    ((sibling && ringOf(sibling)) ||
                      (label !== null && label.querySelector('[class*="peer-focus"]') !== null))),
                covered:
                  top !== null &&
                  !(top === element || element.contains(top) || top.contains(element)) &&
                  !hidden,
                coveredBy: top
                  ? `<${top.tagName.toLowerCase()}.${[...top.classList].slice(0, 3).join('.')}>`
                  : 'nothing',
                offscreen: box.bottom < 0 || box.top > window.innerHeight,
                outlineStyle: style.outlineStyle,
              };
            });
            if (focus === null) break;
            if (seen.has(focus.key)) break;
            seen.add(focus.key);
            if (!focus.ring) problems.push(`${focus.name} shows no focus ring`);
            if (focus.covered) problems.push(`${focus.name} is covered by ${focus.coveredBy}`);
            if (focus.offscreen) problems.push(`${focus.name} was not scrolled into view`);
          }
          expect.soft(problems, `${stop.name} | ${screen}: keyboard focus`).toEqual([]);
        },
      );
    });
  });
}

test.describe('reading, light theme, desktop', () => {
  test.use({ ...SCREENS.desktop, colorScheme: 'light' });

  // What assistive technology gets is the accessibility tree, not the picture: a label and its amount
  // that are side by side only because of a CSS margin come out as one word ("Remaining€300.00"),
  // which a braille display, a search of the page and a copy of the text all show. Axe does not look.
  test('a word and the amount after it are never run together', async ({ page, wallet }) => {
    test.setTimeout(WALK_TIMEOUT_MS);
    await seedWallet(wallet.api, { dataset: 'rich', theme: 'light' });
    const pages = [
      ['/dashboard', 'Dashboard'],
      ['/budgets', 'Budgets'],
      ['/spendings', 'Spendings'],
      ['/subscriptions', 'Subscriptions'],
      ['/income', 'Income'],
      ['/savings', 'Savings'],
      ['/report', 'Yearly report'],
      ['/settings', 'Settings'],
    ] as const;
    // A letter or a digit, then straight away a sign and a currency symbol and a digit.
    const glued = /[\p{L}\p{N}][-+−]?[€$£]\d/gu;

    await eachStop(
      pages.map(([path, heading]) => ({
        name: path,
        open: (target: Page) => openPage(target, path, heading),
      })),
      async (stop) => {
        await stop.open(page);
        const tree = await page.locator('body').ariaSnapshot();
        const found = tree
          .split('\n')
          .filter((line) => !line.includes('/url:') && glued.test(line))
          .map((line) => line.trim());
        // `test` keeps the regex's position: start every line from the beginning.
        glued.lastIndex = 0;
        expect
          .soft(found, `${stop.name}: text in the accessibility tree that runs together`)
          .toEqual([]);
      },
    );
  });
});

test.describe('theme "system", the default', () => {
  test.use({ ...SCREENS.desktop, colorScheme: 'dark' });

  test('follows the operating system, live', async ({ page, wallet }) => {
    // No theme in the seed: the wallet keeps what onboarding gives it, "system".
    await seedWallet(wallet.api, { dataset: 'empty', theme: 'system' });
    await openPage(page, '/dashboard', 'Dashboard');
    await expectTheme(page, 'dark');
    await expectNoA11yViolations(page, 'dashboard | system theme, OS dark | desktop | empty');

    await page.emulateMedia({ colorScheme: 'light' });
    await expectTheme(page, 'light');
    await expectNoA11yViolations(page, 'dashboard | system theme, OS light | desktop | empty');
  });
});

test.describe('the axe check itself', () => {
  // A check that cannot fail proves nothing. Make the page wrong on purpose and see that it says so.
  test('finds what is wrong, and says where', async ({ page, wallet }) => {
    await seedWallet(wallet.api, { dataset: 'empty', theme: 'light' });
    await openPage(page, '/dashboard', 'Dashboard');
    expect(await a11yViolations(page), 'a clean page').toEqual([]);

    await page.evaluate(() => {
      const main = document.querySelector('main');
      const image = document.createElement('img');
      image.id = 'no-alt';
      image.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
      const faint = document.createElement('p');
      faint.id = 'faint';
      faint.textContent = 'Faint text that nobody can read';
      faint.style.color = '#cccccc';
      // Two undersized targets side by side: alone, a small one is allowed (WCAG's spacing exception).
      const tiny = document.createElement('div');
      tiny.id = 'tiny';
      tiny.style.cssText = 'display: flex; gap: 2px';
      for (const name of ['One', 'Two']) {
        const button = document.createElement('button');
        button.setAttribute('aria-label', name);
        button.style.cssText = 'width: 10px; height: 10px; padding: 0';
        tiny.append(button);
      }
      main?.append(image, faint, tiny);
    });
    const violations = await a11yViolations(page);
    const rules = violations.map((violation) => violation.id);
    expect(rules).toEqual(expect.arrayContaining(['image-alt', 'color-contrast', 'target-size']));

    // The report names the rule, its impact, the node count, the selector, the HTML and the help.
    const report = formatViolations('dashboard | light | desktop | new', violations);
    expect(report).toContain('[dashboard | light | desktop | new]');
    expect(report).toMatch(/image-alt \(critical, 1 node\)/);
    expect(report).toContain('#no-alt');
    expect(report).toContain('<img id="no-alt"');
    expect(report).toContain('https://dequeuniversity.com/rules/axe/');
    expect(report).toMatch(/contrast of 1\.53 \(foreground color: #cccccc/);
  });

  // Axe answers "needs review" for a colour it cannot work out (text under another element) and that
  // would pass silently. The check measures those itself.
  test('measures the contrast that axe leaves for review', async ({ page, wallet }) => {
    await seedWallet(wallet.api, { dataset: 'empty', theme: 'light' });
    await openPage(page, '/dashboard', 'Dashboard');
    await page.evaluate(() => {
      const holder = document.createElement('div');
      holder.style.cssText = 'position: relative; height: 40px';
      holder.innerHTML =
        '<p id="obscured" style="color: #cccccc; margin: 0">Faint text under a veil</p>' +
        '<div style="position: absolute; inset: 0; background: rgba(255, 255, 255, 0.01)"></div>';
      document.querySelector('main')?.append(holder);
    });
    const { issues } = await a11yScan(page);
    const contrast = issues.filter((issue) => issue.id === 'color-contrast');
    expect(JSON.stringify(contrast), 'a contrast issue for #obscured').toContain('#obscured');
    expect(JSON.stringify(contrast), 'found by measuring, not by axe').toContain(
      'measured by hand',
    );
  });
});
