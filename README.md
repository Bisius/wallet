# Wallet

A self-hosted personal finance manager for salary, subscriptions, budgets with optional rollover, spendings and savings goals.

- Node 24 · Express 5 · SQLite (Drizzle ORM)
- Angular 22 · Tailwind CSS v4

> **No login.** Run Wallet only on a trusted network (home LAN, or a VPN such as Tailscale).

## Getting started

```bash
nvm use            # Node 24 (see .nvmrc)
npm install
npm run dev        # API → http://localhost:3400, UI → http://localhost:4200
```

The SQLite database is created at `backend/data/wallet.db` on first start, and migrations run automatically.

## Production (single process)

```bash
npm run build
NODE_ENV=production npm start   # UI + API on http://0.0.0.0:3400
```

The server reads these environment variables (see `.env.example`):

- `HOST`, `PORT`
- `DATABASE_PATH`
- `STATIC_DIR`
- `TZ`: decides when a month ends.

## Scripts

| Command                                  | What it does                                       |
| ---------------------------------------- | -------------------------------------------------- |
| `npm run dev`                            | API (watch mode) + Angular dev server              |
| `npm test`                               | All unit and API tests                             |
| `npm run typecheck`                      | TypeScript across all packages                     |
| `npm run build`                          | Production build of frontend and backend           |
| `npm run db:generate -- --name <change>` | Create a migration from `backend/src/db/schema.ts` |

## Docs

- [`docs/PLAN.md`](docs/PLAN.md): roadmap and phases
- [`docs/DOMAIN.md`](docs/DOMAIN.md): how every number is calculated
- [`CLAUDE.md`](CLAUDE.md): conventions for Claude Code and its agents (`.claude/agents/`)
