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

The server reads these environment variables (see `.env.example`). The Docker and systemd setups below set them for you.

| Variable        | Default                          | What                                                                                                 |
| --------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `NODE_ENV`      | `development`                    | Set `production` to serve the built UI.                                                              |
| `HOST`, `PORT`  | `0.0.0.0`, `3400`                | Where it listens. `HOST=127.0.0.1` when a reverse proxy sits in front of it.                         |
| `DATABASE_PATH` | `./data/wallet.db`               | The SQLite file. Its folder must be writable: SQLite keeps `-wal` and `-shm` files next to it.       |
| `BACKUP_DIR`    | `backups` next to the database   | Where [backups](#backups-and-restore) go.                                                            |
| `STATIC_DIR`    | `frontend/dist/frontend/browser` | The built Angular app (served in production only).                                                   |
| `TZ`            | the server's zone                | An IANA name such as `Europe/Rome`. **Decides what "today" is and so when a month ends.** See below. |

## Run it at home

Two ways to keep Wallet running on a small always-on server (a mini PC, a NAS, a Raspberry Pi on a 64-bit OS): **Docker Compose**, or a **systemd** service. Both keep the data in one folder and make a backup every day.

Before you start:

- **There is no login.** Whoever can reach the port can read and change every number. Keep it on your home network or a VPN, and **never forward the port from your router**. Docker publishes ports straight into iptables, so `ufw` and `firewalld` rules on the host do **not** protect a published port: use `BIND_ADDRESS` (below) to narrow it.
- **Set `TZ` to the zone you live in.** There is no time zone in the app settings: the server takes today's date from its own clock in that zone, and that decides which month a new spending lands in and when a month closes. A container defaults to UTC, and a mistyped zone name also silently means UTC. If a new spending defaults to the wrong date or month late in the evening, this is why.
- Linux on x64 or arm64 with glibc (what the SQLite driver ships binaries for). That rules out Alpine's musl.

### Option 1: Docker Compose

```bash
git clone git@github.com:Bisius/wallet.git && cd wallet
cp .env.example .env              # then edit it: set TZ (and PORT or BIND_ADDRESS if you need them)
docker compose up -d --build
docker compose ps                 # "healthy" after a few seconds
```

Open `http://<server>:3400`. The first visit asks for your start month, salary and savings balance.

- The database and the backups live in the named volume `wallet-data`, mounted at `/data`.
- `BIND_ADDRESS=127.0.0.1` in `.env` publishes the port on the machine itself only, which is what you want in front of `tailscale serve` or a reverse proxy. `BIND_ADDRESS=<tailscale ip>` publishes it on the VPN only.
- Logs: `docker compose logs -f`. Stop: `docker compose stop`. Start: `docker compose start`.
- Everything that must survive is in the `wallet-data` volume: `docker compose down` keeps it, `docker compose down -v` **deletes your data**.

### Option 2: systemd

The unit files are in [`deploy/`](deploy). Both run the production build with the hardening that systemd offers (a read-only file system apart from the data folder, no extra privileges) and stop cleanly: on shutdown the app waits for a backup in flight and closes the database.

You need a Node that satisfies `engines` in `package.json` (22.22.3 or newer, or 24.15 or newer; check `node -v`). Debian and Ubuntu package an older one: install Node 24 from [nodejs.org](https://nodejs.org) or NodeSource, or use `nvm` with the user service below.

Building needs the Node from `.nvmrc` (24); running only needs one that satisfies `engines`.

#### As a system service (own user, needs sudo)

The service runs as a user `wallet` and keeps its data in `/var/lib/wallet` (readable by that user only). The unit sets `ProtectHome=true`, so the checkout must not be inside `/home`: put it in `/opt/wallet`.

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin wallet
sudo install -d -o "$USER" /opt/wallet
git clone git@github.com:Bisius/wallet.git /opt/wallet && cd /opt/wallet
nvm use && npm ci && npm run build

sudo cp deploy/wallet.service /etc/systemd/system/wallet.service
echo 'TZ=Europe/Rome' | sudo tee /etc/wallet.env       # your zone; add PORT= or HOST= here if you need to
sudo systemctl daemon-reload
sudo systemctl enable --now wallet

systemctl status wallet                                 # active (running)
curl -s localhost:3400/api/health                       # {"status":"ok",...}
journalctl -u wallet -f                                 # logs
```

If your Node is not `/usr/bin/node`, change `ExecStart` in the unit first (`command -v node`).
`/etc/wallet.env` is read after the defaults in the unit, so put **only** the variables you want to change in it, and do not create a folder `/etc/wallet`: systemd would take it for an old setup and store the data inside it.

#### As a user service (your own account, no sudo)

Runs under your login, so it can use a Node installed in your home (`nvm`) and needs no extra user. Data goes to `~/.local/state/wallet`.

```bash
git clone git@github.com:Bisius/wallet.git ~/wallet && cd ~/wallet
nvm use && npm ci && npm run build

mkdir -p ~/.config/systemd/user
cp deploy/wallet.user.service ~/.config/systemd/user/wallet.service
$EDITOR ~/.config/systemd/user/wallet.service           # set ExecStart to your node: `nvm use && command -v node`
echo 'TZ=Europe/Rome' > ~/.config/wallet.env            # a file, not a folder ~/.config/wallet (see the unit)
systemctl --user daemon-reload
systemctl --user enable --now wallet
loginctl enable-linger "$USER"                          # keep it running while you are logged out

systemctl --user status wallet
journalctl --user -u wallet -f
```

The path of the checkout (`~/wallet`) and of the Node are written into the unit: when you upgrade Node with `nvm`, the version in `ExecStart` changes with it.

### Reach it from your phone

The easiest private network is [Tailscale](https://tailscale.com): install it on the server and on your phone, then open `http://<server name>:3400`.

Installing Wallet as an app on the home screen (it has a manifest and an "Add spending" shortcut) and its service worker need **HTTPS**, or `localhost`. `tailscale serve` gives the server a real certificate with no router changes:

```bash
# Docker: BIND_ADDRESS=127.0.0.1 in .env.  systemd: HOST=127.0.0.1 in the env file.  Then:
tailscale serve --bg 3400            # https://<server name>.<tailnet>.ts.net
```

Any reverse proxy with a certificate (Caddy, nginx) works the same way. The app only caches its own files: every API call goes to the network, so it needs a connection to show or change a number.

### Updating

Take a backup first (Settings → Backups → **Back up now**) and download that file. Press the button once: a second backup on the same UTC day **replaces** the first one, so pressing it again after a failed update would throw away the good copy. Then:

```bash
# Docker
cd wallet && git pull && docker compose up -d --build

# systemd, with the Node from .nvmrc active (system service shown; for the user service
# use ~/wallet and `systemctl --user restart wallet`, without sudo)
cd /opt/wallet && git pull && npm ci && npm run build && sudo systemctl restart wallet
```

Database migrations run when the app starts. A database that a newer version has migrated can **not** be opened by an older one, so to go back to an older version, restore the backup you took before updating (below) and check out that version.

## Backups and restore

Wallet backs up its own database: at startup when the newest backup is 24 hours old or more, and then once a day while it runs. Each backup is one self-contained copy of the whole database, made while the app keeps working, checked after writing, and named `wallet-YYYYMMDD-HHmmss.db` (UTC). It keeps the newest backup of each of the last 14 days and of the last 12 months that have one, so at most 26 files. **Settings → Backups** shows them, makes one on demand and downloads any of them.

Where they are:

|                | Database and backups                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------- |
| Docker         | the `/data` volume: `/data/wallet.db` and `/data/backups/`                                      |
| System service | `/var/lib/wallet/wallet.db` and `/var/lib/wallet/backups/`                                      |
| User service   | `~/.local/state/wallet/wallet.db` and `~/.local/state/wallet/backups/`                          |
| `npm start`    | `./data/wallet.db` and `./data/backups/`, relative to where you started it (or `DATABASE_PATH`) |

**A backup next to the database does not survive the disk.** Copy the folder somewhere else now and then (another machine, a NAS, a USB drive), for example from a cron job:

```bash
# systemd system service
sudo rsync -a /var/lib/wallet/backups/ you@nas:/backups/wallet/
# Docker
docker compose cp wallet:/data/backups/. /mnt/nas/wallet-backups/
```

A backup holds every number you own, so keep the copies as private as the server.

### Restore

Restoring replaces the database file **while the app is stopped**. There is no restore button or endpoint. The steps keep the old files in a `before-restore` folder until you have checked the result.

**System service** (stop, move the old database aside with its `-wal` and `-shm` files, copy the backup in, start). The steps are chained: if `before-restore` is left from an earlier restore, the command stops at `mkdir` and changes nothing, so delete or rename that folder first (otherwise the old safety copy would be overwritten).

```bash
sudo systemctl stop wallet
sudo -u wallet sh -c '
  cd /var/lib/wallet &&
  mkdir before-restore &&
  mv wallet.db* before-restore/ &&
  cp backups/wallet-20261003-142530.db wallet.db'
sudo systemctl start wallet
```

**User service**: the same with `systemctl --user` and `~/.local/state/wallet`, without `sudo -u wallet`.

**Docker** (put the backup file in a folder, here `./restore`: download it from Settings, or `docker compose cp wallet:/data/backups/wallet-20261003-142530.db ./restore/`):

```bash
docker compose stop
docker compose run --rm --no-deps --entrypoint sh -v "$PWD/restore:/restore:ro" wallet -c '
  mkdir /data/before-restore &&
  mv /data/wallet.db* /data/before-restore/ &&
  cp /restore/wallet-20261003-142530.db /data/wallet.db'
docker compose start
```

Then check the dashboard and the month you care about, and look at the log for the startup line. The migrations bring a backup from an older version up to date. Once you are happy, delete `before-restore`.

Do not skip moving the `-wal` and `-shm` files. A database that was stopped cleanly has none, but after a crash or a `kill -9` they hold changes that are not in `wallet.db` yet, and SQLite applies them to whatever `wallet.db` it finds next to them. Left behind, they either silently undo the restore (the app starts without an error and shows the state from before it) or mix old and restored data in a database that still passes SQLite's integrity check. To open the old database from `before-restore` later, keep `wallet.db`, `wallet.db-wal` and `wallet.db-shm` together.

### Restore drill

A backup you have never restored is a hope, not a backup. Do this once now and again after big upgrades. It uses a **scratch copy** on another port, so the live data is never touched:

```bash
# systemd system service shown. Docker: download a backup from Settings and use the Docker command below.
mkdir -p /tmp/wallet-drill
sudo cp /var/lib/wallet/backups/wallet-20261003-142530.db /tmp/wallet-drill/wallet.db && sudo chown "$USER" /tmp/wallet-drill/wallet.db
cd /opt/wallet && NODE_ENV=production HOST=127.0.0.1 PORT=3500 TZ=Europe/Rome \
  DATABASE_PATH=/tmp/wallet-drill/wallet.db BACKUP_DIR=/tmp/wallet-drill/backups \
  node backend/dist/index.js
```

Use the same `TZ` as the live app: near midnight or a month end a different zone shows a different "today" and so different figures. Open `http://127.0.0.1:3500` and compare the dashboard, a past month, the savings balance and the spending count with the live app. Stop it with Ctrl-C and `rm -r /tmp/wallet-drill`.

With Docker, from the folder that holds the downloaded backup (the container keeps the `TZ` of your compose file):

```bash
docker compose run --rm --no-deps -p 127.0.0.1:3500:3400 -v "$PWD:/restore:ro" \
  -e DATABASE_PATH=/tmp/drill.db -e BACKUP_DIR=/tmp/drill-backups --entrypoint sh wallet -c \
  'cp /restore/wallet-20261003-142530.db /tmp/drill.db && exec node backend/dist/index.js'
```

The test suite runs the same drill against the real production build (`e2e/tests/restore-drill.spec.ts`, see Testing).

### If something goes wrong

| Symptom                                                        | Likely cause                                                                                                                                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exits at startup naming a folder                               | The database or backup folder is not writable by the user the app runs as (uid 1000 `node` in Docker). Fix the owner, or use the named volume. The message says which folder and which user. |
| `Cannot listen on ...: address already in use`                 | Another program uses the port. Set `PORT` (and, in Docker, the same value in `.env`).                                                                                                        |
| A spending lands in the wrong month near midnight              | `TZ` is not your zone (UTC is the default in a container).                                                                                                                                   |
| No "install app" prompt, or the app says it can't load offline | The page is not on HTTPS or `localhost`: see `tailscale serve` above.                                                                                                                        |
| Settings → Backups says there is no backup folder              | `BACKUP_DIR` points nowhere, or the in-memory database is in use.                                                                                                                            |

## Scripts

| Command                                  | What it does                                       |
| ---------------------------------------- | -------------------------------------------------- |
| `npm run dev`                            | API (watch mode) + Angular dev server              |
| `npm test`                               | All unit and API tests                             |
| `npm run typecheck`                      | TypeScript across all packages                     |
| `npm run build`                          | Production build of frontend and backend           |
| `npm run e2e`                            | Browser tests of the production build (see below)  |
| `npm run db:generate -- --name <change>` | Create a migration from `backend/src/db/schema.ts` |

## Testing

`npm test` runs the unit, API and component tests and needs no browser. `npm run typecheck` covers every workspace, the end-to-end tests included.

`npm run e2e` drives the **production build** in a real Chromium with [Playwright](https://playwright.dev): onboarding, a month with spendings, moving to the next month, settling savings, CSV import and export, the backup restore drill, and an accessibility (axe) and phone-width pass over every page in light and dark. Each test starts its own server with its own database and a clock it can move, so months really close.

```bash
npm run build                      # the suite never builds
npx playwright install chromium    # once per machine
npm run e2e                        # everything; or npm run e2e:flows (quick) / npm run e2e:sweep (slow)
```

The setup, the environment variables for a machine where Playwright's own browser can't run, and how to write a spec are in [`e2e/README.md`](e2e/README.md).

## Docs

- [`docs/PLAN.md`](docs/PLAN.md): roadmap and phases
- [`docs/DOMAIN.md`](docs/DOMAIN.md): how every number is calculated
- [`CLAUDE.md`](CLAUDE.md): conventions for Claude Code and its agents (`.claude/agents/`)
