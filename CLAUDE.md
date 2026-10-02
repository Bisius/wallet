# Wallet

Personal finance manager: salary, extra income, monthly/yearly subscriptions, budgets with optional rollover, spendings, savings and savings goals. Single user, no login, self-hosted on a private network.

- **Plan / roadmap:** `docs/PLAN.md` (phases, endpoints, what's done)
- **Money rules:** `docs/DOMAIN.md`. It is the source of truth for every calculation. Read it before touching balances.

## Layout

| Path        | Package            | What                                                                                                                                                                                              |
| ----------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/`   | `@wallet/shared`   | API contract (zod schemas + DTO types) and pure helpers (`Cents`, `MonthKey`). Shipped as TS source, so there is no build step.                                                                   |
| `backend/`  | `@wallet/backend`  | Express 5 + Drizzle ORM + better-sqlite3. `src/modules/<feature>/` holds routes, services and tests. `src/domain/` holds the pure ledger engine. `src/db/schema.ts` holds all tables.             |
| `frontend/` | `@wallet/frontend` | Angular 22 (standalone, zoneless, OnPush by default, signals) + Tailwind v4. `src/app/features/<feature>/` holds pages and API services. Angular conventions are in `frontend/.claude/CLAUDE.md`. |

## Commands (repo root, Node 24: `nvm use`)

- `npm run dev`: API on http://localhost:3400 (tsx watch) + Angular on http://localhost:4200 (proxies `/api`)
- `npm test` · `npm run typecheck`: all workspaces. Run a single package with `-w @wallet/backend`.
- `npm run build && NODE_ENV=production npm start`: one process on :3400 serving the API and the UI
- `npm run db:generate -- --name <change>`: create a migration after editing `backend/src/db/schema.ts`. Migrations apply automatically on startup.

## Rules

- Money is **integer cents** (`Cents`). Never use floats or `toFixed` for arithmetic. Format only at the UI edge (`MoneyPipe`) and parse with `parseCents`.
- Months are `MonthKey` (`YYYY-MM`) and dates are `YYYY-MM-DD` strings. The backend reads "now" only from the injected `Clock`.
- Balances are **derived** (computed from facts by the ledger engine), never stored. Values that change over time are stored as effective-from-month version rows.
- Business rules live in the backend. The frontend shows what the API returns.
- Change API contracts in `shared/` first, then implement both sides.
- Never edit a committed migration. Add a new one instead.
- Default port is **3400** (3000 is used by another app on this machine).

## Agents (`.claude/agents/`)

- `backend-engineer`: API, schema, migrations, ledger engine
- `frontend-engineer`: Angular UI
- `finance-domain-reviewer`: read-only correctness review of money logic against `docs/DOMAIN.md`. Use it after any change to balances.
- `test-engineer`: scenario, property and E2E tests

Typical feature flow: backend contract + API → frontend (in parallel once the contract exists) → domain review when money logic changed → tests. A phase is done when `npm run typecheck && npm test && npm run build` pass.
