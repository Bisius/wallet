# Wallet: implementation plan

Personal finance manager covering salary, extra income, monthly and yearly subscriptions, budgets with optional rollover, spendings, savings and savings goals.

- **Stack**: Node 24 · Express 5 · Drizzle ORM · SQLite (better-sqlite3) · Angular 22 (zoneless, signals) · Tailwind CSS v4 · zod · vitest.
- **Specification**: [`DOMAIN.md`](./DOMAIN.md) is the source of truth for every calculation.
- **Agents**: `.claude/agents/` defines `backend-engineer`, `frontend-engineer`, `finance-domain-reviewer` and `test-engineer`.

---

## Architecture

```
browser ──HTTP──▶ Express (one Node process, port 3400)
                   ├─ /api/*   JSON API ─▶ services ─▶ ledger engine (pure) ─▶ Drizzle ─▶ SQLite file
                   └─ /*       built Angular app (production)
```

- **Monorepo** with npm workspaces: `shared/` (API contract and pure helpers, consumed as TS source), `backend/` and `frontend/`.
- **Derived ledger.** The database stores facts only (salary history, incomes, subscriptions, budgets, spendings, transfers and savings transactions). All balances, carry-overs, reserves and savings due are computed by one pure function, `computeLedger(facts, throughMonth, today)` in `backend/src/domain/ledger.ts`. This means:
  - there is no cron job or "close month" process that can fail, run twice or be skipped
  - late edits flow through correctly
  - everything is unit-testable without a database
  - at personal scale (hundreds of months × tens of budgets) recomputing on each request costs well under a millisecond, so caching can wait until it's measured.
- **Versioned values** (salary, budget amount and mode, subscription price) mean history never changes by accident.
- **No auth** (single user, by decision). Run it on a LAN or VPN only. [Tailscale](https://tailscale.com) is the easiest option, and `tailscale serve` also provides the HTTPS that the PWA needs.

---

## Phase 0 · Scaffold ✅

- npm workspaces, shared package with `Cents`/`MonthKey` helpers and tests.
- Express app factory, error format, injectable clock, health endpoint, SQLite with WAL and foreign keys, Drizzle migrations that run on startup, and an in-memory test harness.
- Full schema for all core features (`backend/src/db/schema.ts`, migration `0000_init`).
- Angular shell with lazy routes for every section, an API health indicator, `MoneyPipe` and `PageHeader`.
- Dev setup: `npm run dev` (API on :3400 with watch, Angular on :4200 with an `/api` proxy). Production: `npm run build && NODE_ENV=production npm start` serves everything on :3400.
- Agents, `CLAUDE.md`, this plan, and `DOMAIN.md`.

## Phase 1 · Core data API (`backend-engineer`)

Contracts go in `shared/src/<feature>.ts` first, so the frontend can start in parallel.

| Endpoint                                                                                                         | Notes                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET/PUT /api/settings`                                                                                          | `GET` returns 404 until onboarding is done. `PUT` creates or updates (currency, locale, startMonth, theme, alertWarnPercent). |
| `POST /api/onboarding`                                                                                           | One transaction: settings, first salary, opening savings balance.                                                             |
| `GET/PUT/DELETE /api/salary[/:month]`                                                                            | Salary history; `PUT /api/salary/2026-10 {amount}` upserts.                                                                   |
| `GET/POST/PATCH/DELETE /api/incomes`                                                                             | Filter by `month`.                                                                                                            |
| `GET/POST/PATCH /api/budgets`, `PUT /api/budgets/:id/versions/:month`, `POST /api/budgets/:id/archive`, `DELETE` | Delete only when there is no history (409 otherwise). Reorder via `sortOrder`.                                                |
| `GET/POST/PATCH /api/subscriptions`, `PUT …/:id/prices/:month`, `POST …/:id/cancel`, `DELETE`                    |                                                                                                                               |
| `GET/POST/PATCH/DELETE /api/spendings`                                                                           | Filters: `month`, `from`, `to`, `budgetId`; paginated. The date must be inside the budget's active range.                     |

Done when every endpoint has route tests (happy path, validation, 404, rule violations such as a spending outside the budget's range).

## Phase 2 · Ledger engine (`backend-engineer` → `finance-domain-reviewer` → `test-engineer`)

- `shared/src/money.ts`: add `ceilDiv` and `splitEvenly`.
- `backend/src/domain/ledger.ts`: pure `computeLedger`, implementing every rule in DOMAIN.md. `backend/src/domain/facts.ts` loads facts from the DB in a few queries.
- `GET /api/months/:month` returns income, fixed costs (per subscription), budgets (carriedIn, allocated, transfersNet, available, spent, remaining, usage, alert state), unallocated, savings due breakdown and status (closed/current/future).
- `GET /api/months?from=&to=` returns compact per-month totals, used for charts and history.
- Tests: table-driven unit tests per rule, multi-month scenario tests, and property-based tests (fast-check) for the four invariants in DOMAIN.md.
- **Gate:** the reviewer signs off before Phase 4 starts.

## Phase 3 · Core UI (`frontend-engineer`, can start once the Phase 1 contracts exist)

- **Foundations**: design tokens in `styles.css` (`@theme`), **dark mode** (class strategy, following `settings.theme` or the system setting), a form field component, a money input (`parseCents`), toasts, a confirm dialog, empty, loading and error states, and a settings store (currency and locale drive `MoneyPipe`).
- **Onboarding wizard** (shown while `/api/settings` returns 404): start month, currency, salary, opening savings, first budgets.
- **Month switcher** in the shell (← Oct 2026 →). The selected month is in the URL query (`?month=2026-10`).
- **Budgets**: cards showing available, spent, remaining and a progress bar, plus an incremental badge. Create, edit (amount from this month on), archive and reorder.
- **Spendings**: a fast "add spending" flow (amount, budget, today's date, description), and a list grouped by day with edit and delete.
- **Subscriptions**: list with monthly equivalent cost, cancel, price change, and yearly reserve progress.
- **Income**: salary history plus one-off incomes.
- **Settings**: currency, locale, theme and alert threshold.

## Phase 4 · Savings and goals (backend + frontend)

- `GET /api/savings` returns balance, unassigned amount, goals with progress, and the outstanding list per closed month with its breakdown.
- `POST /api/savings/settle/:month` takes an optional split across goals. `POST /api/savings/transactions` handles deposits, withdrawals and reallocations.
- `GET/POST/PATCH/DELETE /api/goals`.
- UI: the "Move to savings" inbox ("September: move €312.40 · Done"), the savings balance, goal cards (progress, deadline, monthly amount needed), and reallocate and withdraw dialogs.

## Phase 5 · Transfers, tags and search

- `GET/POST/DELETE /api/transfers` covers budget↔budget and budget↔unallocated pool. UI: a "Move money" action on a budget card.
- `GET/POST/PATCH/DELETE /api/tags`. Spendings accept `tagIds`. Tag chips appear in the add/edit form, with autocomplete.
- `GET /api/spendings` gains search: `q` (description and notes), `tagId`, `minAmount`/`maxAmount`. UI: a filter bar on the spendings page, with filters kept in the URL.

## Phase 6 · Insights

- **Dashboard**: this month's income, fixed costs, budgeted, spent and unallocated. Budget progress bars with **alerts** (warning or over). Savings outstanding. **Upcoming renewals** for the next 30 days (`GET /api/subscriptions/upcoming?days=30`).
- **Charts**: spending per budget (bars), and income vs spent vs saved over 12 months (lines). Use small hand-rolled SVG components so they follow Tailwind and dark mode and keep the bundle small. Switch to a chart library only if the needs outgrow that.
- **Yearly report**: `GET /api/reports/yearly/:year` returns income, fixed costs, spent per budget, subscription cost per subscription, and saved per month and in total.

## Phase 7 · Data and platform

- **CSV export**: `GET /api/export/spendings.csv?from=&to=` (also incomes and savings).
- **CSV import**: upload, then column mapping (date, amount, description, date format, decimal separator, sign convention), then a preview where each row gets a suggested budget (from earlier spendings with the same description) and duplicates are flagged (`importHash`), then commit. Mapping profiles are saved per bank (new table `import_profiles`).
- **Backups**: better-sqlite3 `db.backup()` daily and on startup if the last backup is older than 24 h. Rotation keeps 14 daily and 12 monthly backups in `BACKUP_DIR`. `GET /api/backups` lists them, `POST /api/backups` runs one now, and a download link is available in Settings.
- **Docker**: multi-stage `Dockerfile` (node:24-slim), `docker-compose.yml` with a `/data` volume and the `TZ`, `PORT` and `DATABASE_PATH` environment variables, and a healthcheck on `/api/health`.
- **PWA**: `ng add @angular/pwa`, a manifest with icons, an app-shell cache, and a home-screen shortcut straight to "Add spending". API calls are network-only for now (no offline queue in v1). Service workers require HTTPS (or localhost), so use `tailscale serve` or a reverse proxy.

## Phase 8 · Hardening (`test-engineer`)

- Playwright E2E for onboarding, a month with spendings, moving to the next month, settling savings, and CSV import.
- Accessibility pass (axe) on every page, plus a mobile viewport check.
- README "run it at home" guide (systemd and Docker), and a backup restore drill.

---

## How to run a phase with the agents

1. `backend-engineer`: contracts in `shared/`, then schema/migration, endpoints and tests.
2. `frontend-engineer` (in parallel once the contracts exist): the pages for that phase.
3. `finance-domain-reviewer`, whenever money logic changed (always for Phases 2, 4 and 5).
4. `test-engineer`: scenario tests and E2E for what landed.
5. `npm run typecheck && npm test && npm run build` must be green before the phase is called done.

## Possible later additions (not planned)

- Optional password login, if the app ever needs to leave the private network.
- Multi-currency (accounts in different currencies, exchange rates).
- Bank sync (PSD2 aggregators) instead of CSV import.
- A spending "planned vs actual" view per subscription (record the real charge amount).
- A max rollover cap per incremental budget (anything above the cap goes to savings).
- Notifications (e-mail or web push) for renewals and budget alerts.
- UI translation (Italian, …): Angular i18n. Number and currency formatting already follow the locale setting.
