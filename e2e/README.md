# Wallet end-to-end tests

Playwright drives the **production build** (`npm run build`) in a real browser. Every test gets its own server, database and clock, so tests never share state and can run side by side.

## Run

```sh
npm run build                       # once, and again after changing the app: the suite never builds
npx playwright install chromium     # once per machine
npm run e2e                         # from the repo root: the whole suite (flows, then sweep)
npm run e2e:flows                   # the quick part: what a person does, with exact money
npm run e2e:sweep                   # the slow part: axe and the phone layout over every page and state
npm run e2e -- onboarding.spec.ts   # one file (any `playwright test` argument works)
npm run e2e -- --headed -g "wizard" # watch it
npm run e2e -- --ui                 # Playwright's UI mode
```

`npm test` does not run these (they need a build and a browser). `npm run typecheck` does check them.

## What is tested

Two Playwright projects: **`flows`** (every spec except the two below) and **`sweep`** (`a11y.spec.ts` and `mobile.spec.ts`, which pick their own viewport). The sweep takes about 25 minutes at one worker, the flows a few minutes.

| Spec                     | What it drives                                                                                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onboarding.spec.ts`     | A fresh database, the welcome wizard, the dashboard it produces, a reload, no second onboarding, locale formatting                                                                                                                |
| `month.spec.ts`          | A month with spendings through the form: warning and over states to the cent, refunds, edit, delete, search and filters, validation, dialogs                                                                                      |
| `next-month.spec.ts`     | The clock passing a month: carry-over of incremental budgets (leftover and deficit), what goes to and comes from savings, the yearly reserve, late spendings in a closed month and their correction, skipping several months      |
| `savings.spec.ts`        | The "Move to savings" inbox and badge, settle and undo, the split dialog, goals, negative settlements, deposits, withdrawals and reallocation                                                                                     |
| `import.spec.ts`         | CSV import through all four steps (a windows-1252 bank file), duplicates, saved profiles, closed and current months, CSV export byte for byte, the export-import round trip                                                       |
| `restore-drill.spec.ts`  | The README's restore procedure word for word, a backup taken under load, the scratch-instance drill next to the live server, a backup from an older schema, and what stale `-wal`/`-shm` files do (see `docs/DOMAIN.md`, Backups) |
| `a11y.spec.ts` (sweep)   | axe (WCAG 2.2 AA and best practice, no exclusions) on every page and dialog, filled and empty, light and dark, desktop and phone; keyboard, focus and theme checks                                                                |
| `mobile.spec.ts` (sweep) | A 390 px phone (`isMobile`) and 320 px: no horizontal overflow, reachable controls, target sizes, with ordinary, extreme-text and maximum-amount content; the PWA manifest, zoom and the toolbar colour                           |
| `harness.spec.ts`        | The harness itself: server, clock, API client, error guard, service workers                                                                                                                                                       |

Data for the sweep comes from `support/rich-data.ts` (four datasets: `empty`, `rich`, `long-text`, `big-amounts`) and the list of pages and states from `support/pages.ts`.

Settings from the environment, for machines where Playwright's own browser cannot run:

| Variable           | Effect                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PW_CHROMIUM_PATH` | Use this Chromium executable instead of Playwright's download                                                                                             |
| `PW_NO_SANDBOX=1`  | Launch with `--no-sandbox` (containers, no user namespaces)                                                                                               |
| `PW_WORKERS=4`     | Parallel workers (default 2, to be kind to shared machines)                                                                                               |
| `PW_OUTPUT_DIR=…`  | Where traces and screenshots go (default `e2e/test-results`). Playwright empties it at the start of every run, so two runs at once need different folders |
| `CI=1`             | One retry, and an HTML report in `e2e/playwright-report/`                                                                                                 |

`tests/harness.spec.ts` checks the harness itself (server, clock, API client, error guard, service workers). Its `✘` lines are `test.fail()` tests that pass by failing, as they should.

A report, traces and screenshots of failures land in `e2e/test-results/` (`npx playwright show-trace <trace.zip>`). A failed test also keeps its server's temp folder (the path is in the `wallet-server.log` attachment, next to the server's output): delete the `wallet-e2e-*` folders in your temp directory when you are done with them.

## How it works

- **`support/fixtures.ts`** exports `test` and `expect`. The `wallet` fixture starts `node --import support/fake-clock.mjs backend/dist/index.js` with `NODE_ENV=production`, `TZ=UTC`, a free port and a private `DATABASE_PATH` and `BACKUP_DIR` in a temp folder, waits for it, and stops it (SIGTERM) and deletes the folder afterwards. `page`, `context` and `request` point at it, and service workers are blocked.
- **The clock.** The backend reads "now" only from its `Clock`, which is `new Date()`. The preload replaces the global `Date` with "real time plus an offset", and the test moves it through a unix socket: `await wallet.setNow('2026-04-01T09:00:00')`. Months close by the clock passing them, so this is how a spec closes one. The clock keeps ticking from where it was set. A zone-less instant is UTC, which is the server's time zone. No code of the app knows about any of this.
- **Seeding.** `wallet.api` is a Playwright `APIRequestContext` bound to the server. A response outside 2xx throws an `ApiRequestError` that shows the request and the response body; pass `{ failOnStatusCode: false }` to a call to get an expected error back. `support/seed.ts` has typed helpers (`onboard`, `createBudget`, `createSubscription`, `addIncome`, `addSpending`, `createGoal`, `addTransfer`, `settleMonth`, `getMonth`, `getSavings`, ...) that take the request types of `@wallet/shared`.
- **Console errors fail the test.** Any `console.error` (which is also where Chromium logs a failed `fetch`, such as a 404) and any uncaught exception of a page fails the test. Allow what is expected with `browserErrors.allow(...)` in a test, or `test.use({ allowedConsoleErrors: [...] })` for a file (`failedResponse(404, /\/api\/settings$/)` is the matcher for a failed request), or turn the guard off with `test.use({ failOnConsoleErrors: false })`.
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
