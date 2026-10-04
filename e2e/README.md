# Wallet end-to-end tests

Playwright drives the **production build** (`npm run build`) in a real browser. Every test gets its own server, database and clock, so tests never share state and can run side by side.

## Run

```sh
npm run build                       # once, and again after changing the app: the suite never builds
npx playwright install chromium     # once per machine
npm run e2e                         # from the repo root: the whole suite (flows, then sweep)
npm run e2e:flows                   # the quick part: what a person does, with exact money
npm run e2e:sweep                   # the slow part: axe and the phone layout over every page and state
npm run e2e:visual                  # screenshots against your own baselines (not part of `npm run e2e`, see below)
npm run e2e -- onboarding.spec.ts   # one file (any `playwright test` argument works)
npm run e2e -- --headed -g "wizard" # watch it
npm run e2e -- --ui                 # Playwright's UI mode
```

`npm test` does not run these (they need a build and a browser). `npm run typecheck` does check them.

## What is tested

Three Playwright projects: **`flows`** (every spec except the ones of the other two) and **`sweep`** (`a11y.spec.ts` and `mobile.spec.ts`, which pick their own viewport) make up `npm run e2e`. The sweep takes about 25 minutes at one worker, the flows a few minutes. **`visual`** (`visual.spec.ts`) is separate: it compares screenshots with baselines that only exist on your machine, so `npm run e2e` never runs it (see [Visual baselines](#visual-baselines)).

| Spec                      | What it drives                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `onboarding.spec.ts`      | A fresh database, the welcome wizard, the dashboard it produces, a reload, no second onboarding, locale formatting                                                                                                                                                                                                 |
| `month.spec.ts`           | A month with spendings through the form: warning and over states to the cent, refunds, edit, delete, search and filters, validation, dialogs                                                                                                                                                                       |
| `next-month.spec.ts`      | The clock passing a month: carry-over of incremental budgets (leftover and deficit), what goes to and comes from savings, the yearly reserve, late spendings in a closed month and their correction, skipping several months                                                                                       |
| `savings.spec.ts`         | The "Move to savings" inbox and badge, settle and undo, the split dialog, goals, negative settlements, deposits, withdrawals and reallocation                                                                                                                                                                      |
| `import.spec.ts`          | CSV import through all four steps (a windows-1252 bank file), duplicates, saved profiles, closed and current months, CSV export byte for byte, the export-import round trip                                                                                                                                        |
| `restore-drill.spec.ts`   | The README's restore procedure word for word, a backup taken under load, the scratch-instance drill next to the live server, a backup from an older schema, and what stale `-wal`/`-shm` files do (see `docs/DOMAIN.md`, Backups)                                                                                  |
| `shell.spec.ts`           | The app shell on a wide screen and on a phone: the one navigation of each (sidebar with groups; tab bar and the "More" sheet), the period in the top bar (month, year, none), the global Add spending (dialog from any page, the figures behind it move, closed month, Report), the welcome wizard's bare shell    |
| `a11y.spec.ts` (sweep)    | axe (WCAG 2.2 AA and best practice, no exclusions) on every page and dialog, filled and empty, light and dark, desktop and phone (the "More" sheet and the Add spending dialog among them); keyboard, focus and theme checks, the tab bar and the sheet from the keyboard                                          |
| `mobile.spec.ts` (sweep)  | A 390 px phone (`isMobile`) and 320 px: no horizontal overflow, reachable controls, target sizes, with ordinary, extreme-text and maximum-amount content; the fixed bars (a top bar of about 60 px, the tab bar, the floating button) never cover the end of a page; the PWA manifest, zoom and the toolbar colour |
| `harness.spec.ts`         | The harness itself: server, clock, API client, error guard, service workers                                                                                                                                                                                                                                        |
| `visual.spec.ts` (visual) | Full-page screenshots of every page and the main dialogs of the `rich` dataset, desktop light and dark and a 390 px phone, against local baselines that are not in git                                                                                                                                             |

Data for the sweep comes from `support/rich-data.ts` (four datasets: `empty`, `rich`, `long-text`, `big-amounts`) and the list of pages and states from `support/pages.ts`.

Settings from the environment, for machines where Playwright's own browser cannot run:

| Variable           | Effect                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PW_CHROMIUM_PATH` | Use this Chromium executable instead of Playwright's download                                                                                             |
| `PW_NO_SANDBOX=1`  | Launch with `--no-sandbox` (containers, no user namespaces)                                                                                               |
| `PW_WORKERS=4`     | Parallel workers (default 2, to be kind to shared machines)                                                                                               |
| `PW_OUTPUT_DIR=…`  | Where traces and screenshots go (default `e2e/test-results`). Playwright empties it at the start of every run, so two runs at once need different folders |
| `CI=1`             | One retry, and an HTML report in `e2e/playwright-report/`                                                                                                 |
| `PW_VISUAL=1`      | Define the `visual` project. Only `npm run e2e:visual` sets it: without it that project does not exist, so no other command can run it                    |

`tests/harness.spec.ts` checks the harness itself (server, clock, API client, error guard, service workers). Its `✘` lines are `test.fail()` tests that pass by failing, as they should.

A report, traces and screenshots of failures land in `e2e/test-results/` (`npx playwright show-trace <trace.zip>`). A failed test also keeps its server's temp folder (the path is in the `wallet-server.log` attachment, next to the server's output): delete the `wallet-e2e-*` folders in your temp directory when you are done with them.

## Visual baselines

`visual.spec.ts` (the **`visual`** project) takes screenshots of the whole app and compares them with baselines, so that a change to the look shows up as a picture instead of a hunch, and so that a page a migration forgets does not go unnoticed. It is for U-phase work on the look (`docs/UI-PLAN.md`) and any change to templates or tokens. It is not part of `npm run e2e`.

**The baselines are not in git.** Pixels depend on the machine (fonts, rasteriser, Chromium build), so every developer records their own in `e2e/visual-baselines/` (ignored by git), from the unmodified app, and updates them on purpose. A pull request that changes the look re-records them and says so in its description, so the reviewer looks at the new pictures (or runs the project) instead of at binary files in the diff.

```sh
npm run build                                  # the suite never builds, see above
npm run e2e:visual -- --update-snapshots       # record every baseline (about 5 minutes)
npm run e2e:visual                             # compare: every shot has to match
npm run e2e:visual -- -g "budgets"             # a few shots (the test title is the file name, without .png)
npm run e2e:visual -- --update-snapshots -g "budgets-desktop-light"   # re-record one, or a few, on purpose
```

Without a baseline a shot fails with "A snapshot doesn't exist, writing actual" and writes the file, so record first, from the app as it is before your change, and compare after it.

**What it shoots.** Every stop of `richStops()` in `support/pages.ts` (so a page or dialog that is added there is added here, and the list is not copied), with the `rich` dataset, one test and one server per shot:

| Variant         | Viewport                     | Stops                      | Shots |
| --------------- | ---------------------------- | -------------------------- | ----- |
| `desktop-light` | 1280 x 800                   | pages (full page), dialogs | 78    |
| `desktop-dark`  | 1280 x 800                   | pages (full page)          | 33    |
| `phone-light`   | 390 x 844, `isMobile`, touch | pages (full page), dialogs | 79    |

The files are named after the stop and the variant: `budgets-desktop-light.png`, `budgets-new-budget-dialog-phone-light.png`, `savings-split-a-month-dialog-validation-errors-desktop-light.png`. A page is shot full-page (`dashboard (closed month)`, `import > review the rows`, a toast on screen, ...); a modal dialog is shot as the window shows it, over its dimmed backdrop, and so is a page with a "More actions" menu open. If a stop is renamed in `support/pages.ts` its shot is a new file and the old one stays in the folder: delete `e2e/visual-baselines/` and record again.

**What keeps it deterministic.** The same build on the same machine gives the same picture, so a difference means the app changed:

- The clock is the harness default, `2026-03-10`, so every date, "today" and "in 5 days" is the same. The text that comes from the server's ticking clock, the time of day of a backup and its file name (`wallet-20260310-090013.db`), is replaced by a constant before the shot (the text keeps its width, which a mask would not). The API status and the server date are in the picture: neither moves.
- Animations are off (`reducedMotion: 'reduce'`, and Playwright finishes the rest before it shoots), the caret is hidden, and a toast stays on screen (no timer of 4 seconds or more fires in the page) instead of timing out under the camera.
- Before the shot the page is settled: nothing loading, `document.fonts.ready`, no change of the page or its size for six frames in a row (the charts measure themselves after the first paint), scrolled to the top, the mouse in a corner so nothing is hovered.
- A phone's page is shot with a window as tall as the page. The tab bar and the floating Add spending button are fixed to the bottom of the window, and a full-page capture would leave them over the middle of the content (hiding what is under them); a tall window puts them at the end of the picture, where a person meets them, with the sticky top bar at its top.
- The tolerance is 30 pixels and a per-pixel colour distance of 0.05 (`playwright.config.ts`). At zero tolerance, 21 of 173 shots differed between two runs, by 1 to 7 single pixels each at the rounded corner of a card. A changed digit, a moved line, a darker border or a different shade of blue is well above that and fails. There are no retries: a shot that only passes the second time is a flake to fix.

**When a shot fails.** The reporter prints the path of each. Playwright writes `<name>-expected.png`, `<name>-actual.png` and `<name>-diff.png` (the differing pixels in red) into the test's folder under `e2e/test-results/`, or `PW_OUTPUT_DIR` (it empties that folder at the start of every run, so look before you run again). `CI=1` also makes an HTML report in `e2e/playwright-report/` with a slider between expected and actual. If the new look is what you meant, run the update command for that shot (or all of them) and look at the result before you keep it; if not, the diff shows what moved. A failed shot keeps its server's `wallet-e2e-*` temp folder like any failed test: delete them afterwards.

Re-record everything after anything that changes how this machine draws: a Playwright or Chromium upgrade, new system fonts, a different OS.

## How it works

- **`support/fixtures.ts`** exports `test` and `expect`. The `wallet` fixture starts `node --import support/fake-clock.mjs backend/dist/index.js` with `NODE_ENV=production`, `TZ=UTC`, a free port and a private `DATABASE_PATH` and `BACKUP_DIR` in a temp folder, waits for it, and stops it (SIGTERM) and deletes the folder afterwards. `page`, `context` and `request` point at it, and service workers are blocked.
- **The clock.** The backend reads "now" only from its `Clock`, which is `new Date()`. The preload replaces the global `Date` with "real time plus an offset", and the test moves it through a unix socket: `await wallet.setNow('2026-04-01T09:00:00')`. Months close by the clock passing them, so this is how a spec closes one. The clock keeps ticking from where it was set. A zone-less instant is UTC, which is the server's time zone. No code of the app knows about any of this.
- **Seeding.** `wallet.api` is a Playwright `APIRequestContext` bound to the server. A response outside 2xx throws an `ApiRequestError` that shows the request and the response body; pass `{ failOnStatusCode: false }` to a call to get an expected error back. `support/seed.ts` has typed helpers (`onboard`, `createBudget`, `createSubscription`, `addIncome`, `addSpending`, `createGoal`, `addTransfer`, `settleMonth`, `getMonth`, `getSavings`, ...) that take the request types of `@wallet/shared`.
- **Console errors fail the test.** Any `console.error` (which is also where Chromium logs a failed `fetch`, such as a 404) and any uncaught exception of a page fails the test. Allow what is expected with `browserErrors.allow(...)` in a test, or `test.use({ allowedConsoleErrors: [...] })` for a file (`failedResponse(404, /\/api\/settings$/)` is the matcher for a failed request), or turn the guard off with `test.use({ failOnConsoleErrors: false })`.
- **Moving between pages.** `support/nav.ts` has one helper, `goToPage(page, 'Subscriptions')`, for what a person does with the navigation, on either screen: the sidebar link on a wide screen, the tab on a phone, and for the pages the tab bar has no room for (Subscriptions, Income, Report, Settings, Import CSV) "More" and then the link in the sheet. `month-ui.ts`'s `openPage` is it plus a wait for the heading. There is exactly one navigation to find at a time (the other is `display: none`, which `getByRole` does not see): `sidebar(page)` ("Main") or `tabBar(page)` ("Main (tabs)"). Import has no link in the sidebar, so `goToPage(page, 'Import CSV')` is for a phone.
- **The API status.** The sidebar and the top bar of a phone both say `API online`, and CSS hides the one that does not fit the screen, so `getByText('API online')` alone finds two. Use `apiStatus(page, 'API online')` (`support/pages.ts`): it keeps the one that is on screen, and `settle` waits for it.
- **Stops for one screen.** A `Stop` with `screen: 'phone'` (the "More" sheet) only exists on that screen. Walkers take `onScreen(richStops(), screen)`, and `visual.spec.ts` skips it for the other variants.
- **The fixed bars.** `support/layout.ts`'s `measureBars` scrolls to the end of a page, finds the lowest content and reports what is under the tab bar or the floating button (it puts the scroll position back). `mobile.spec.ts` runs it on every page stop.
- **Menus.** `support/menu.ts` has one helper, `rowAction(scope, 'Delete')`: it opens the "More actions" button inside a row or card and presses the item with that name. Use it for every action that lives in an `app-action-menu`, so that moving an action into or out of a menu changes one place. A stop of `support/pages.ts` whose dialog an item of a menu opens says so with `menuItem` (its `opener` is then the button of the menu, which gets focus back when the dialog closes), and a stop with a menu open on screen is `menu: true` (it is shot as the window shows it, because a menu closes when the page scrolls).
- **Restart drills.** `wallet.stop()` and `wallet.start()` restart the same server on the same folder, port and clock, with `wallet.dbPath` and `wallet.backupDir` in between (replace the database after `stop()` to restore a backup). `support/restore.ts` has the README's restore steps as Node file operations.
- **More than one server.** `import { test } from '../support/servers'` adds a `servers` fixture: `servers.start()` (an empty wallet next to `wallet`), `servers.startOnCopyOf(backupFile)` (the scratch drill) and `kill()` on each (SIGKILL, what a crash leaves behind).

Options for `test.use`: `walletNow` (where the clock starts, default `2026-03-10T09:00:00`), `failOnConsoleErrors`, `allowedConsoleErrors`, and Playwright's own, such as `serviceWorkers: 'allow'`.

## Writing a spec

```ts
import { expect, test } from '../support/fixtures';
import { createBudget, onboard } from '../support/seed';

test('a month with a budget', async ({ page, wallet }) => {
  await onboard(wallet.api, { startMonth: '2026-03', salary: 250000 });
  await createBudget(wallet.api, { name: 'Groceries', amount: 40000, incremental: false });

  await page.goto('/budgets');
  await expect(page.getByRole('heading', { name: 'Groceries' })).toBeVisible();
});
```

- Find things the way a user does: `getByRole`, `getByLabel`, visible text. Add a `data-testid` to the app only when there is no accessible handle.
- Write expected money literally, as the user reads it (`'€2,500.00'`), and work the numbers out from `docs/DOMAIN.md` by hand in a comment. Do not compute them with the code under test.
- A visually hidden checkbox (the switches) cannot be hit by `check()`: click its label text, then assert `toBeChecked()`.
- The server is real: nothing is mocked, and `page.route` should stay out of specs.
- A test is its own universe: do not rely on another test, and do not read the real clock. Move the fake one.
