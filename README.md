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

| Variable             | Default                          | What                                                                                                 |
| -------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `NODE_ENV`           | `development`                    | Set `production` to serve the built UI.                                                              |
| `HOST`, `PORT`       | `0.0.0.0`, `3400`                | Where it listens. `HOST=127.0.0.1` when a reverse proxy sits in front of it.                         |
| `DATABASE_PATH`      | `./data/wallet.db`               | The SQLite file. Its folder must be writable: SQLite keeps `-wal` and `-shm` files next to it.       |
| `BACKUP_DIR`         | `backups` next to the database   | Where [backups](#backups-and-restore) go.                                                            |
| `STATIC_DIR`         | `frontend/dist/frontend/browser` | The built Angular app (served in production only).                                                   |
| `TZ`                 | the server's zone                | An IANA name such as `Europe/Rome`. **Decides what "today" is and so when a month ends.** See below. |
| `TELEGRAM_BOT_TOKEN` | unset                            | The token of the optional [Telegram bot](#telegram-bot). Without it the bot is off. A secret.        |
| `APP_URL`            | unset                            | The address of Wallet as your phone reaches it. Adds links to the bot's messages.                    |
| `TELEGRAM_API_ROOT`  | `https://api.telegram.org`       | Tests only: where the bot's Telegram is. Leave it unset.                                             |

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

## Telegram bot

An optional bot that records spendings and incomes from your phone, and sends you alerts and reminders. It is **off unless `TELEGRAM_BOT_TOKEN` is set**: without it nothing else in Wallet changes, and Settings → Telegram only shows how to turn it on. The bot adds no rules of its own. It writes through the same checks as the web app, so what it records is an ordinary spending or income, and every amount it prints is a figure the app shows too. Messages are in English, with amounts and dates formatted by the currency and locale in Settings.

| You send           | What happens                                                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/spending`        | A guided entry: budget, amount, note (or Skip), date. Text after the amount is the note and skips that step, as in `12,50 lunch`. A negative amount is a refund.                                          |
| `12,50 lunch`      | Quick entry: an amount, with an optional note, and no command. Wallet asks for the budget (the one you usually use for that note comes first, marked with a star) and saves the spending **dated today**. |
| `/income`          | Amount, description, date.                                                                                                                                                                                |
| `/status`          | What is left in each budget this month.                                                                                                                                                                   |
| `/recent`          | Your last 10 spendings, from any source, each with a button to delete it.                                                                                                                                 |
| `/undo`            | Removes the last spending or income you added from Telegram, after asking.                                                                                                                                |
| `/cancel`, `/help` | Stop the entry in progress. List the commands.                                                                                                                                                            |

After it saves, the reply says what is left of that budget in the spending's month, marks a budget near its limit or over it, and offers **Undo** and **Change date**. The date buttons cover the last 7 days: for an older date use the web app. A date in a month that is already closed asks first, because it changes what is due to savings for that month. The bot also sends notifications (see below).

### Set it up

1. **Create the bot.** In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot` and answer its questions (a name, and a username that ends in `bot`). It replies with the bot token. Then turn groups off: send `/mybots`, pick your bot, **Bot Settings**, **Allow Groups?**, and switch it off. Wallet ignores groups anyway, and this keeps the bot out of them.
2. **Put the token in the env file** the server reads, as the line `TELEGRAM_BOT_TOKEN=<your token>` (no quotes, no spaces). Use an editor rather than `echo`, so the token stays out of your shell history. The file is the one that holds `TZ`:

   | How you run it | Env file                            | Then                                                                    |
   | -------------- | ----------------------------------- | ----------------------------------------------------------------------- |
   | Docker Compose | `.env` next to `docker-compose.yml` | `docker compose up -d` (not `restart`, which keeps the old environment) |
   | System service | `/etc/wallet.env`                   | `sudo systemctl restart wallet`                                         |
   | User service   | `~/.config/wallet.env`              | `systemctl --user restart wallet`                                       |
   | `npm start`    | export it in the shell              | start it again                                                          |

3. **Restart Wallet** as in the table. It reads the token only when it starts. The log (`journalctl -u wallet`, or `docker compose logs`) then says `Telegram: bot @yourbot is running`. Without a token it says `Telegram bot is off (TELEGRAM_BOT_TOKEN is not set)`.
4. **Link your account.** Open Settings → Telegram and press **Link Telegram**. Wallet shows a code and an **Open in Telegram** button. The code has 8 characters, works once and expires after 10 minutes. The button opens your bot with the code ready: press **Start** if Telegram asks. (You can also send `/start <code>` yourself.) The page switches to **Linked** by itself, and the bot greets you with the list of commands. Press **Send test message** to check that it arrives.

Only the linked account gets answers. Linking another account replaces the first one (Settings asks you first), and **Unlink** removes the link and keeps your notification settings. A code that expired, or that five wrong codes have cancelled, is replaced by pressing the button again for a new one. For the linked account a bare `/start` just shows the help.

These variables belong to the bot (`.env.example` lists them):

| Variable             | Default                    | What                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN` | unset                      | The token from @BotFather. Unset or empty: the bot is off. It is a secret, see below.                                                                                                                                                                                                                                                                                                                                                            |
| `APP_URL`            | unset                      | The address of Wallet as your phone reaches it, such as `https://wallet.<tailnet>.ts.net` (see [Reach it from your phone](#reach-it-from-your-phone)); a trailing slash is ignored. It adds links to Wallet: `/status` ends with one and the monthly recap gets an **Open savings** button. Without it they are left out. A value that is not an `http://` or `https://` address stops Wallet at startup with a message that names the variable. |
| `TELEGRAM_API_ROOT`  | `https://api.telegram.org` | **Tests only**: the end-to-end tests point it at a fake Telegram. Leave it unset. The token is part of every request address, so never point it at a server you do not control.                                                                                                                                                                                                                                                                  |

### How it connects

The bot uses **long polling**: Wallet opens an outbound HTTPS connection to `api.telegram.org` and asks for new messages, and Telegram never calls Wallet. So Wallet opens no port for the bot and needs no webhook, no public address and no router change, and it stays on your private network. The server only has to be able to reach Telegram on port 443 (the systemd units already allow outbound connections, and so does Docker by default). When it starts, Wallet removes any webhook that was set on the bot.

If Wallet is down or cannot reach Telegram, Telegram keeps your messages for 24 hours and hands them over when Wallet is back. An entry made that way is dated **the day Wallet handles it**, not the day you sent it: the reply shows the date, and **Change date** fixes it. Older messages are lost. Nothing else in Wallet depends on the bot, so the app works as usual while it cannot connect.

### Privacy and security

- **Telegram sees what goes through it.** Bot chats are **not end-to-end encrypted**. The budget names, amounts and notes you send, and the bot's replies and notifications, pass through Telegram's servers and are stored there. Your database stays on your own machine, but whatever you type to the bot does not. If that is not acceptable, leave the token unset: Wallet works fully without the bot.
- **Only you get answers.** The bot talks to the one account you link, in a private chat. Anyone else who finds it gets no reply (the one exception is "Invalid or expired code." to a wrong code while you have a code open), so they cannot even tell what it is. Groups and channels are ignored.
- **One bot per Wallet.** Telegram lets one program poll a bot at a time. Two Wallets with the same token (a second machine, a development copy, a restore drill) make each other's requests fail with 409 conflicts, take each other's messages and both show "Another program is using this bot". Give every instance a bot of its own (`/newbot` again). A development copy needs its own token, and a restore drill runs without any (see [Restore drill](#restore-drill)).
- **The token is a secret.** Whoever has it controls your bot. It lives only in the env file: Wallet never shows it, never stores it in the database (so it is **not in a backup**), and redacts it from the bot's log lines. Keep the env file out of version control (`.env` is already in `.gitignore`) and out of the backups and copies of your server's configuration where you do not want it. `sudo chmod 600 /etc/wallet.env` keeps other users of the server from reading it (systemd reads that file as root, so the `wallet` user does not need access); for the user service, run `chmod 600 ~/.config/wallet.env`. If it leaks, revoke it in BotFather (`/mybots`, your bot, **API Token**, **Revoke current token**) and put the new one in the env file.
- **Do not set `DEBUG=grammy*`** (or `DEBUG=*`). grammY, the library Wallet uses to talk to Telegram, writes its own debug output, which does not go through Wallet's token redaction, and what it can print includes network errors that carry the Bot API address, which contains the token.
- **A backup holds the link and the notification settings** (who you linked, and your choices below), so a restore brings them back, but never the token: set it again in the env file of the machine you restore on. If that Wallet uses a different bot, link again from Settings.

### Notifications

They go to the linked chat, and you choose them in Settings → Telegram → Notifications: **Budget alerts**, **Yearly renewals: days before**, **Monthly renewals: days before**, **Monthly recap** and **Time of day**.

- **Budget alerts.** When a spending, from the web app, an import or the bot, takes a budget to a higher level (its warning threshold, then over), you get one message for that budget. A budget is announced once per level and month: a refund that brings it down and a spending that takes it up again sends nothing more. Linking, or switching alerts on, does not announce budgets that are already over.
- **Renewal reminders.** Once a day, from 09:00 or the time of day you set (on the **server's** clock, so `TZ`), one message lists the subscriptions due soon with their price and, for yearly ones, what you have set aside. A yearly subscription is reminded **7 days** before it renews and a monthly one **1 day** before, each once. Set a number of days to 0 to turn that reminder off (the most is 30). A reminder missed because the server was off goes out when it is back, as long as the renewal has not passed.
- **Monthly recap.** From the same time on the 1st (later that month if the server was off), how the month that just closed went: spent, left over, budgets that went over, what carried into the new month, and what is due to savings. It is only sent for months that ended after you linked, so linking in the middle of a month does not send the recap of the one before.

Nothing is sent while no account is linked or the bot is not connected. What Telegram does not accept is tried again at the next check (every minute), and what it accepted is never sent twice.

### Troubleshooting

Settings → Telegram shows what is wrong. Find the row that matches:

| Settings shows                                   | What it means                                                                                                                                                                                                                                                                                                                      | What to do                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Telegram is off" and the four setup steps       | The server has no token: `TELEGRAM_BOT_TOKEN` is unset or empty where it runs.                                                                                                                                                                                                                                                     | Add it to the env file in the table above and restart as shown there. The usual slips are the wrong file for how you run Wallet, and `docker compose restart`, which does not read `.env` again.                                                                                                                      |
| "Connecting to Telegram…"                        | The bot has started and has not heard from Telegram yet. It takes a few seconds, and the page updates by itself.                                                                                                                                                                                                                   | Wait. If the server cannot reach Telegram, this turns into "Telegram can't be reached" within about a minute.                                                                                                                                                                                                         |
| "Telegram refused the bot token"                 | The token is wrong, was revoked, or is not a token at all. The bot stays off until Wallet restarts, because trying again would not help.                                                                                                                                                                                           | Copy the token from @BotFather again (`/mybots`, your bot, **API Token**), fix the env file and restart Wallet.                                                                                                                                                                                                       |
| "Another program is using this bot"              | Something else polls Telegram with the same token: a second Wallet (another machine, a development copy, a restore drill, a container you forgot) or any other program. Wallet tries again by itself, after 30 seconds and then less often, up to every 5 minutes.                                                                 | Stop the other one, or give it a bot of its own. If you cannot find it, revoke the token in BotFather and put the new one in this Wallet's env file: the other program loses access.                                                                                                                                  |
| "Telegram can't be reached"                      | The server could not connect to `api.telegram.org`, or Telegram answered with an error. Wallet tries again by itself, after 30 seconds and then less often, up to every 5 minutes, and the rest of Wallet is not affected.                                                                                                         | Nothing, unless it lasts. Then check the server's internet access, its DNS and any firewall that blocks `api.telegram.org` on port 443, with the test below the table.                                                                                                                                                |
| "You blocked the bot"                            | Telegram refused a message to your linked chat (a 403). You blocked the bot there, or the chat does not exist for this bot (a backup restored on a Wallet that uses another bot). Polling goes on.                                                                                                                                 | Unblock the bot in Telegram, then send it a message: the mark clears as soon as a message goes through (**Send test message** tries again too). If you moved to another bot, link again from Settings.                                                                                                                |
| Linked, with no error, but the bot never answers | Silence is how the bot treats everyone it does not know, so you are writing from somewhere it ignores: an account that is not the **Linked account**, a group or channel (only a private chat counts), a different bot than the **Bot** shown, or the link was removed. While you are not linked, it only answers `/start <code>`. | Compare the **Bot** and the **Linked account** in Settings with the chat you are using, and press **Send test message**. If the test arrives, your messages are not coming from the linked account's private chat. If it does not, Settings or the test's error says why. If you are not linked, link first (step 4). |

To test the connection from the server, run one of these. A status line or a number means Telegram is reachable; an error message says what stops it:

```bash
curl -sSI https://api.telegram.org                      # systemd
docker compose exec wallet node -e "fetch('https://api.telegram.org').then((r) => console.log(r.status), (e) => console.log(e.message))"   # Docker
```

A button on an old message that answers "This entry expired, start again with /spending" is not an error: the entry it belonged to was finished, timed out (after 15 minutes) or was lost in a restart, so start again with `/spending`.

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

The drill must **not** run the [Telegram bot](#telegram-bot): two programs with one token fight over its messages, and the backup holds your link. The command above does not read the env file, so the bot stays off as long as your shell has no `TELEGRAM_BOT_TOKEN` exported (`echo "${TELEGRAM_BOT_TOKEN:+set}"` prints an empty line when it has none).

With Docker, from the folder that holds the downloaded backup (the container keeps the `TZ` of your compose file, and `-e TELEGRAM_BOT_TOKEN=` empties the token that Compose would pass in, so the bot stays off):

```bash
docker compose run --rm --no-deps -p 127.0.0.1:3500:3400 -v "$PWD:/restore:ro" \
  -e DATABASE_PATH=/tmp/drill.db -e BACKUP_DIR=/tmp/drill-backups -e TELEGRAM_BOT_TOKEN= \
  --entrypoint sh wallet -c \
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
| Settings → Telegram shows an error, or the bot does not answer | See [Telegram bot, Troubleshooting](#troubleshooting).                                                                                                                                       |

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
- [`docs/TELEGRAM-PLAN.md`](docs/TELEGRAM-PLAN.md): the Telegram bot (how it fits, its conversations and notifications)
- [`CLAUDE.md`](CLAUDE.md): conventions for Claude Code and its agents (`.claude/agents/`)
