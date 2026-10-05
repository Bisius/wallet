# Telegram bot: record spendings from the phone

**Status: implemented (October 2026), not yet tried with a real bot; what was built and found is in [Phase 10 of `PLAN.md`](./PLAN.md#phase-10--telegram-bot-backend-engineer-frontend-engineer-test-engineer). The text below is the original plan: where it differs from the build, `DOMAIN.md` ("Telegram bot") is the source of truth. Original status: planned (October 2026), [Phase 10 in `PLAN.md`](./PLAN.md#phase-10--telegram-bot-backend-engineer-frontend-engineer-test-engineer).** The owner agreed the decisions below on 2026-10-05. The bot adds a second way to enter spendings and incomes, and a channel for notifications. It adds **no new money rule**. It writes through the existing spending and income services, so the same validation and 422 rules apply. Every figure it prints is a field (or a sum of fields) that the month view, the upcoming renewals or the savings read model already returns. The usual gate applies: `npm run typecheck && npm test && npm run build`, plus `npm run e2e:flows`.

---

## What it looks like

The guided flow:

```
You  /spending
Bot  Which budget?
     [🛒 Groceries · €187.50] [🍝 Eating out · €42.00]
     [⛽ Fuel · −€12.40]       [✖ Cancel]
You  (taps Groceries)
Bot  How much? You can add a note after the amount, like 12,50 lunch
You  23,40
Bot  A note?                         [Skip]
You  Lidl
Bot  When?                           [Today] [Yesterday] [Earlier…]
You  (taps Today)
Bot  ✅ €23.40 · Groceries · Lidl · Mon 5 Oct
     Groceries: €164.10 left of €300.00 (45% used)
                                     [↩ Undo] [📅 Change date]
```

Quick entry (no command, the message starts with an amount):

```
You  4,50 coffee
Bot  €4.50 · coffee. Which budget?
     [⭐ Eating out · €42.00] [🛒 Groceries · €164.10] … [✖ Cancel]
You  (taps Eating out)
Bot  ✅ €4.50 · Eating out · coffee · Mon 5 Oct
     ⚠️ Eating out: €37.50 left of €200.00 (81% used)
                                     [↩ Undo] [📅 Change date]
```

## Decisions (agreed with the owner, 2026-10-05)

| Topic         | Decision                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who           | Only the owner. One Telegram account is linked from **Settings → Telegram** with a one-time code. Every other account is ignored.                                                                                                                       |
| Connection    | **Long polling**: the server calls Telegram and Telegram never calls the server, so Wallet stays on the private network. The token is `TELEGRAM_BOT_TOKEN` in the env file. Without it the bot is off and nothing else changes.                         |
| `/spending`   | Guided: budget → amount → note (Skip) → date (Today, Yesterday, Earlier) → saved. Text after the amount is the note and skips the note step. There is no tags step.                                                                                     |
| Dates         | Buttons for the **last 7 days** only (today and the 6 days before). An older date goes through the web app.                                                                                                                                             |
| Quick entry   | A message that starts with an amount and has no command (`12,50 lunch`) asks for the budget, with the usual one for that description first (the CSV import's suggestion). One tap saves it **dated today**. The reply offers Undo and Change date.      |
| The reply     | What is left of the budget **in the spending's month**, the % used, and the warning or over mark.                                                                                                                                                       |
| More commands | `/status`, `/recent`, `/undo` and `/income`, plus `/cancel` and `/help`.                                                                                                                                                                                |
| `/income`     | Amount → description (required, as in the web form) → date, with the same buttons.                                                                                                                                                                      |
| Notifications | **Budget alerts** when a spending from any source (web, import, bot) crosses a threshold. **Renewal reminders**: yearly subscriptions 7 days before, monthly ones 1 day before, both adjustable. A **recap** of the month that just closed, on the 1st. |
| Language      | English, with amounts and dates formatted by the currency and locale in Settings.                                                                                                                                                                       |

Every other rule in this file is an **engineering decision (2026-10-05, not yet reviewed with the owner)**. In T0 these rules move into `DOMAIN.md` ("Telegram bot") with that mark, as the transfer and tag rules were.

## How it fits

```
Telegram ◀──HTTPS, long polling (outbound only)── Wallet process (:3400)
                                                   ├─ Express  /api/*  (+ /api/telegram)
                                                   ├─ backup scheduler
                                                   └─ Telegram bot ─▶ services ─▶ SQLite
                                                        └─ notification scheduler
```

- **Same process.** `index.ts` starts the bot after `listen`, next to the backup scheduler, and only when the token is set. It stops it in `shutdown()` before the database closes. `createApp` and the tests never start it: routes get an optional `telegram` handle, and the tests pass a fake.
- **Services, not HTTP.** The bot calls `createSpending`, `updateSpending`, `deleteSpending`, `createIncome`, `deleteIncome`, `getMonthView`, `listUpcomingRenewals`, `getSavings` and the import's `loadSuggester`. It reads "now" only from the injected `Clock`.
- **Library: [grammY](https://grammy.dev)** (`grammy`, backend only). It is TypeScript-first and supports `apiRoot` (needed for the fake Bot API in e2e), `bot.handleUpdate()` and API transformers (needed for unit tests without a network). The conversations plugin is **not** used: a small explicit state machine is easier to test and reason about.
- **Module** `backend/src/modules/telegram/`:

| File                               | What                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `telegram.runtime.ts`              | grammY setup, polling, `deleteWebhook`, `getMe`, `setMyCommands`, connection status, backoff, token redaction, `stop()` |
| `telegram.access.ts`               | the sender guard, pairing (`/start <code>`), linking and unlinking                                                      |
| `telegram.flows.ts`                | the state machine for `/spending`, quick entry, `/income`, Change date, confirmations                                   |
| `telegram.commands.ts`             | `/status`, `/recent`, `/undo`, `/help`, `/cancel`                                                                       |
| `telegram.messages.ts`             | pure builders of message text and keyboards (formatting, HTML escaping, label truncation)                               |
| `telegram.parse.ts`                | pure parser of an amount message: `{ amount, note }` or null, built on `parseCents`                                     |
| `telegram.notifications.ts`        | budget-alert watcher, renewal reminders and monthly recap, plus the dedupe log                                          |
| `telegram.scheduler.ts`            | one-minute `unref`'d tick, the same pattern as `backups.scheduler.ts`                                                   |
| `telegram.routes.ts`/`.service.ts` | `/api/telegram`                                                                                                         |

## Conversations

### Linking and access

- **Pairing.** `POST /api/telegram/pairing` creates a code: 8 characters from an unambiguous alphabet (no `0 O 1 I`), single use, valid for 10 minutes. A new code replaces a pending one. Settings shows the code and an **Open in Telegram** button (`https://t.me/<bot>?start=<code>`), which sends `/start <code>` by itself. The bot links the sender when the code is valid. It refuses groups and channels, and only accepts a private chat.
- **Re-linking** while an account is linked replaces it once the new code is used, and the UI confirms this first. **Unlinking** removes the link. The bot sends a best-effort "This chat is no longer linked to Wallet" to the old chat.
- **Wrong codes.** `/start <wrong>` gets "Invalid or expired code." After 5 wrong codes from any sender, the pending code is cancelled.
- **Every other update from anyone but the linked user is ignored without a reply.** The bot stays silent, so strangers can't even tell what it is. The check is on `from.id` and the chat type, for every message and every button tap.
- On link, the bot greets with `/help`. It also records a **baseline** of the budget alert levels (see [Budget alerts](#budget-alerts)).

### `/spending`

1. **Budget.** It offers the budgets active in the current month, in the month view's order (`sortOrder`, then id), two per row. Each button shows the icon, the name (cut at about 24 characters) and that month's `remaining`. A `[✖ Cancel]` button closes the flow. With no active budget, the bot answers "No active budgets this month. Add one in the app."
2. **Amount.** It accepts `12.50`, `12,50`, `€12.50`, `12.50€` and `-5`, read by `parseCents`, never 0. Negative is a refund. Text after the number is the note (up to 200 characters, as for every description), and step 3 is skipped. Anything else gets a re-prompt that gives an example.
3. **Note.** Free text, or `[Skip]` for an empty description.
4. **Date.** `[Today] [Yesterday] [Earlier…]`. Earlier swaps in one button per day from 2 to 6 days ago (`Wed 30`, …). Days before `settings.startMonth` are not offered. Each button carries its **explicit date**, so a button tapped after midnight saves the date it showed.
5. **Closed month.** A date in a closed month asks first: "September is closed. Adding this changes what is due to savings for September. [Save] [Other date]". This matches the [Editing rules](./DOMAIN.md#editing-rules) ("the UI confirms them").
6. **Saved.** The bot calls `createSpending`. A 422 from the service becomes a sentence and a way back. `outside_active_months` returns to the date step ("Groceries isn't active in September"), and `unknown_budget` (budget deleted meanwhile) returns to step 1.

### The confirmation

```
✅ €23.40 · Groceries · Lidl · Mon 5 Oct
Groceries: €164.10 left of €300.00 (45% used)
[↩ Undo] [📅 Change date]
```

- The figures are the budget's line in `getMonthView(month of the spending)`: `remaining`, `available` and `usagePercent`, read **after** the write. A spending in a closed month says so: "Groceries in September (closed): …".
- `alert` decides the mark: `warning` → `⚠️` and "(81% used, warning at 80%)", `over` → `🔴 Over by €12.40`. When `available <= 0` there is no %, as in the web app.
- A refund reads "↩ Refund €5.00 · Groceries".
- **Undo** deletes that spending if it still exists and shows "Removed" plus the new figure. If the spending is dated in a closed month, it confirms first. If it was already deleted on the web: "Already removed."
- **Change date** offers the same 7 days in one keyboard, then calls `updateSpending({ date })`, with the same closed-month confirmation. It rewrites the confirmation with the new figures.
- These buttons act on the stored row, not on a flow, so they keep working after a restart.

### Quick entry

- A text message that `telegram.parse.ts` reads as an amount (with an optional note), sent while no flow is waiting for text, starts a quick entry.
- It offers the budgets as in `/spending`, step 1. The **suggested budget** comes first, marked `⭐`. It is the import's rule ([Suggested budget](./DOMAIN.md#suggested-budget)): the budget most used by stored spendings with the same normalized description, if it is active this month. It comes from `loadSuggester`. With no note or no suggestion, the order is the usual one.
- One tap saves the spending **dated today** (the `Clock` when the tap is processed) and shows the confirmation. Change date fixes a spending typed the night before.

### `/income`

Amount (positive only) → description (required, 1 to 200 characters, so no Skip; text after the amount fills it) → date with the same buttons and closed-month confirmation → `createIncome`. The reply is "✅ Income €200.00 · Bonus · Mon 5 Oct", followed by the month's `income.total` and `unallocated`, with Undo and Change date.

### `/status`

One line per active budget in the current month view: `🛒 Groceries · €164.10 left of €300.00 (45%)` with `⚠️`/`🔴` marks. The footer reads `26 days left in October · Unallocated €320.00`, and a link to the app follows when `APP_URL` is set.

### `/recent` and `/undo`

- `/recent` lists the last 10 spendings from **any source** (`listSpendings`, newest first), numbered, with `[🗑 1] … [🗑 10]` buttons in rows of five. A tap asks "Delete €12.50 · Groceries · lunch (Sat 3 Oct)? [Delete] [Keep]". After deleting, the bot shows the budget's new figure.
- `/undo` takes the **latest spending or income created from Telegram** that still exists (table `telegram_entries`), shows it, and asks `[Remove] [Keep]`. It always asks, because it acts on something not on screen.

### `/cancel`, `/help` and stray input

- `/cancel` ends the flow in progress and removes its keyboard.
- `/help` lists the commands. The list is also registered with `setMyCommands` at startup, so Telegram shows it in the menu.
- A button from a finished or expired flow answers "This entry expired, start again with /spending" (a callback toast) and removes its keyboard.
- Text sent while a flow is waiting for a button cancels that flow ("Previous entry cancelled"). The text is then handled from scratch, as a quick entry or a command.
- Unknown commands and other text get a short pointer to `/help`.

### Flow state

- In memory, one flow per chat, keyed by chat id, with a 15-minute timeout. Each flow has a short id that its `callback_data` carries (well under Telegram's 64-byte limit), so stale buttons are detected.
- A restart loses only a flow in progress. Nothing has been written until the last step.

## Notifications

All of them go to the linked chat and can be switched in Settings. They are logged in `telegram_notifications`, and a row is written only **after** Telegram accepted the message. A failed send is therefore retried on the next tick and never lost, and a sent one is never repeated.

### Budget alerts

- **When it fires.** For each budget of the **current** month, the bot remembers the highest alert level it has notified this month (`ok < warning < over`). When the month view shows a higher level, it sends one message for every budget that went up in that check:
  - "⚠️ Groceries: 84% used, €48.00 left of €300.00"
  - "🔴 Eating out is over by €12.40"
- A level that goes down (a refund) sends nothing. Rising again to a level already notified this month sends nothing either, so there is no flapping.
- **When it checks.**
  - After every successful mutating `/api` request (a `res.on('finish')` hook for `POST`, `PUT`, `PATCH` and `DELETE` with a status below 400), debounced by 2 seconds, so a CSV import commit sends one message.
  - After every write by the bot.
  - On every scheduler tick, as a safety net.
- **No duplicates.** A level the bot's own confirmation already showed is recorded as notified, so the alert isn't sent twice.
- **Baseline.** Linking, and switching alerts on, record the current levels without sending them. The first check after linking therefore doesn't flood the chat with budgets that were already over.

### Renewal reminders

- **When.** Once a day, at the notify time (default `09:00`, server `TZ`). The bot calls `listUpcomingRenewals({ days: max lead })` and reminds about each renewal whose billing date is at most its lead away: **yearly 7 days, monthly 1 day** by default, 0 turns it off, range 0 to 30.
- **Once.** Each renewal is reminded once, keyed by `(subscriptionId, billingDate)`.
- **Catch-up.** If the server was off on the exact day, the reminder goes out at the next tick, as long as the date has not passed. All renewals due in one run share one message:

```
🔔 Renewals
Netflix · tomorrow (Tue 6 Oct) · €13.99
Domain · in 7 days (Mon 12 Oct) · €15.00 · set aside ✅
Insurance · in 6 days (Sun 11 Oct) · €480.00 · €400.00 set aside, €80.00 not covered
```

- The price, `reserved` and `unreserved` come from `listUpcomingRenewals`, never from `nextRenewalPrice` ([Upcoming renewals](./DOMAIN.md#upcoming-renewals)).

### Monthly recap

- **When.** At the first tick on or after the notify time on any day of month M, for M − 1, once per month.
- **Only for months linked before they ended.** It is sent only if the account was linked before M began, and M − 1 is not before `startMonth`. Linking mid-month does not trigger a recap of the month before.
- Figures from `getMonthView(M − 1)` and `getSavings`:

```
📅 September 2026 is closed
Spent €1,820.00 · €280.00 left over
🔴 Over: Eating out by €42.00, Fuel by €12.40
↪ Carried into October: €180.00
💰 Due to savings: €630.00 · not settled yet   [Open savings]
```

- **Where each figure comes from:**
  - "Spent" and "left over": `totals.spent` and `totals.remaining`.
  - "Over": the lines with `alert = over`, by `−remaining`.
  - "Carried": the sum of `carriedOut`.
  - "Due": `savingsDue.total`. "Not settled yet" and "settled" come from that month's outstanding in `getSavings`.
  - The button appears only when `APP_URL` is set.

### Scheduler

- `startTelegramScheduler` runs a one-minute `unref`'d timer. Each tick runs the alert check, then the renewals and the recap when they are due.
- A tick never throws. It logs and leaves the rest to the next tick. A tick that finds the previous one still running is skipped.
- It exposes `tick()` for tests and `stop()` for shutdown, like `backups.scheduler.ts`.

## Data: migration `0003_telegram`

None of these tables is a fact. They are not in `earliestFactMonth`, the exports or the ledger. They are in the backups, so a restore brings back the link and the preferences.

| Table                    | Columns                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `telegram_link`          | one row (`id = 1`): `user_id`, `chat_id`, `first_name`, `username` (nullable), `linked_at`. Telegram ids fit in 52 bits, a safe JS integer.                                                                                    |
| `telegram_pairing`       | one row (`id = 1`) while a code is pending: `code`, `expires_at`, `failed_attempts`                                                                                                                                            |
| `telegram_settings`      | one row (`id = 1`), created with the defaults: `budget_alerts` (1), `renewal_yearly_days` (7), `renewal_monthly_days` (1), `monthly_recap` (1), `notify_at` (`'09:00'`). Unlinking keeps it.                                   |
| `telegram_entries`       | what the bot created, for `/undo`: `id`, `spending_id` → `spendings` and `income_id` → `incomes` (both `ON DELETE CASCADE`, exactly one set, a `check`), `created_at`                                                          |
| `telegram_notifications` | dedupe log: `kind` (`budget_alert`, `renewal`, `recap`), `key`, `value` (nullable), `sent_at`, unique `(kind, key)`. The keys are `<month>:<budgetId>` (value: highest level), `<subscriptionId>:<billingDate>` and `<month>`. |

The preferences live in their own table rather than in `settings`, because `PUT /api/settings` replaces exactly five fields and that contract stays as it is.

## API: `shared/src/telegram.ts`

Every endpoint is behind `requireOnboarded`, and none of them ever returns or logs the token.

| Endpoint                          | Notes                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/telegram`               | 200 `TelegramStatusDto` (below)                                                                                                                                                                  |
| `POST /api/telegram/pairing`      | 201 `{ code, expiresAt, deepLink }` (`deepLink` is null until `getMe` has given the bot's username). It replaces a pending code. 409 `telegram_not_configured` without a token.                  |
| `DELETE /api/telegram/pairing`    | 204, also when no code is pending                                                                                                                                                                |
| `DELETE /api/telegram/link`       | 204. 404 `not_found` when nothing is linked.                                                                                                                                                     |
| `PUT /api/telegram/notifications` | 200 the settings. Body `{ budgetAlerts, renewalYearlyDays (0–30), renewalMonthlyDays (0–30), monthlyRecap, notifyAt ("HH:MM") }`. Switching alerts on records the baseline.                      |
| `POST /api/telegram/test`         | 204 after Telegram accepted a "Wallet is connected" message. 409 `telegram_not_configured`, 409 `telegram_not_linked`, 503 `telegram_unavailable` (the bot is not running, or Telegram refused). |

```ts
interface TelegramStatusDto {
  /** TELEGRAM_BOT_TOKEN is set. */
  configured: boolean;
  connection: 'off' | 'connecting' | 'running' | 'error';
  /** Why `connection` is 'error'; null otherwise. */
  problem: 'invalid_token' | 'conflict' | 'unreachable' | 'blocked' | null;
  /** From getMe, once connected. */
  bot: { username: string } | null;
  link: { name: string; username: string | null; linkedAt: string } | null;
  pairing: { code: string; expiresAt: string; deepLink: string | null } | null;
  notifications: TelegramNotificationSettingsDto;
}
```

There are three new `ApiErrorCode`s: `telegram_not_configured` (409), `telegram_not_linked` (409) and `telegram_unavailable` (503). They go into `API_ERROR_STATUS` and into the error table of `PLAN.md`.

## Configuration

| Variable             | Default                    | What                                                                                                         |
| -------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN` | unset                      | The token from @BotFather. Unset or empty: the bot is off.                                                   |
| `TELEGRAM_API_ROOT`  | `https://api.telegram.org` | Only for tests (the e2e fake Bot API).                                                                       |
| `APP_URL`            | unset                      | The address of the app from the phone (`https://wallet.<tailnet>.ts.net`). It adds "Open" links to messages. |

They go into `config.ts` (with tests), `docker-compose.yml` and the comments of both systemd units. The units already allow outbound IPv4 and IPv6 (`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`), so nothing else changes there.

## Settings → Telegram (frontend)

A new **Telegram** part of Settings, next to General, Tags and Data (`features/settings/telegram-section.ts` and `telegram.api.ts`). It uses the shared primitives (`app-section`, `app-alert`, `dl[appKeyValues]`, `app-action-menu`), as the UI conventions require.

| State                       | Shows                                                                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Not configured              | How to set it up in four steps (BotFather → token in the env file → restart → link), with a link to the README section                                                                              |
| Error                       | An `app-alert` per `problem`: wrong token; another program uses this bot (usually a second Wallet: use a separate bot for development); Telegram unreachable; you blocked the bot                   |
| Configured, not linked      | **Link Telegram** → the code, its expiry, **Open in Telegram** (the deep link) and Cancel. It polls `GET /api/telegram` every 3 s while a code is pending and switches to "Linked" when it is used. |
| Linked                      | Name, @username, linked since. **Send test message**. **Unlink** sits in the action menu, behind a confirm dialog. Re-linking also confirms.                                                        |
| Notifications (when linked) | Budget alerts (switch), yearly renewals "days before" and monthly renewals "days before" (0 = off), monthly recap (switch), time of day (server time zone, shown). Save.                            |

## Security and privacy

- **The bot is the only way into Wallet from the internet**, and it only ever talks to the one linked account. Strangers get no reply at all. Pairing codes are short-lived, single use, and cancelled after 5 wrong tries.
- **The token never leaves the server.** It stays out of the API, the frontend, backups and the logs. Every logged bot error goes through `redact()`, because Bot API URLs contain the token, and a test checks that nothing logged contains it.
- **Telegram sees what goes through it.** Bot chats are not end-to-end encrypted, so budget names, amounts and notes are stored on Telegram's servers. The README says so plainly.
- **Groups are refused**, and the README tells you to turn off "Allow Groups" in BotFather.
- **One running Wallet per token.** Two pollers on the same token get 409 conflicts and steal each other's updates. Development uses a second bot.

## Phases

### T0 · Rules and contract (`backend-engineer`) · S

- `DOMAIN.md`: a new "Telegram bot" section with every rule above, the owner decisions dated 2026-10-05, and the rest marked as engineering decisions.
- `shared/src/telegram.ts`: zod schemas and DTOs, each with its method, path and status in JSDoc. The new error codes go in `api.ts`. Contract tests.
- `PLAN.md`: the endpoint rows and the three error codes.

**Done when** the contract typechecks and is tested. The frontend can start.

### T1 · Bot platform (`backend-engineer`) · M

- `grammy` dependency; the three env variables in `config.ts` (an empty token is off) with tests.
- Migration `0003_telegram` (`npm run db:generate -- --name telegram`).
- Runtime: `deleteWebhook`, `getMe`, `setMyCommands`, then long polling with `allowed_updates: ['message', 'callback_query']`. On a network error or a 409 it retries with backoff (30 s up to 5 min) and shows `conflict`/`unreachable`. On a 401 it stops (`invalid_token`) until restart. A 403 "blocked by the user" shows `blocked`. Token redaction, and `stop()` wired into `shutdown()`.
- Access guard, pairing, link and unlink, `/help`, `/cancel`.
- `/api/telegram` routes, and `createApp({ telegram })` with an optional handle.

**Done when** the route tests and guard tests pass, and a real bot links from Settings (or curl) and answers `/help` on a phone.

### T2 · Recording (`backend-engineer`) · L

- The flow state machine: `/spending`, quick entry with the suggestion, `/income`, the date step, the closed-month confirmation, the confirmation with Undo and Change date.
- `/status`, `/recent`, `/undo`.
- `telegram.parse.ts`, with property tests against `parseCents`.
- `telegram.messages.ts` as pure functions, with HTML escaping tested on names like `<b>&`.

**Done when** every flow has `handleUpdate` tests (in-memory database, `fixedClock`, a transformer that records the API calls). The tests cover each step, Skip, Earlier, every 422 path, a stale button, an unknown sender, Undo after a web delete, and a figure equal to the month view's to the cent.

### T3 · Notifications (`backend-engineer`) · M

- The alert watcher: the `/api` write hook (debounced), the bot's own writes, the baseline, and the escalation rule.
- The scheduler: alerts, renewals, the recap, the dedupe log, and retry after a failed send.

**Done when** the tick tests with a `fixedClock` cover every rule. That includes warning then over, a refund and a rise again, the baseline at link, catch-up after a day off, no repeat after a restart, no recap for a month that started before linking, and a failed send retried.

### T4 · Settings → Telegram (`frontend-engineer`, after T0, in parallel with T1 to T3) · M

**Done when** every state in the table above has a spec and an axe check, it fits a 390 px phone, and the `ui-conventions` guard passes.

### T5 · Review and end-to-end (`finance-domain-reviewer`, `test-engineer`) · M

- **Domain review.**
  - Every amount the bot prints equals a field of the month view, the upcoming renewals or the savings read model, for the right month.
  - Writes go only through the services.
  - Closed-month writes, Change date and deletes confirm first.
  - Undo and `/undo` remove exactly one row.
  - Quick entry dates by the `Clock`.
- **E2E.**
  - A fake Bot API (`e2e/support/fake-telegram.ts`) implements `getMe`, `getUpdates`, `sendMessage`, `editMessageText`, `editMessageReplyMarkup`, `answerCallbackQuery`, `setMyCommands` and `deleteWebhook`. It records what the bot sent and lets a test "type" as a user.
  - A fixture option starts the server with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_API_ROOT`.
  - `telegram.spec.ts`:
    - linking from Settings in the browser
    - a `/spending` flow whose figure matches the Spendings page and the Budgets page to the cent
    - quick entry with a suggestion, and Undo
    - a closed-month confirmation after moving the clock
    - an alert caused by a spending entered on the web
    - a renewal reminder and the recap after moving the clock to the 1st at 09:00
  - The Telegram states join the a11y sweep and the visual baselines.

### T6 · Docs and deploy (`backend-engineer`) · S

- A README section "Telegram bot":
  - creating the bot (`/newbot`, Allow Groups off), the token in `/etc/wallet.env` or `~/.config/wallet.env` or compose, restart, and linking
  - `APP_URL`, the privacy note and one bot per instance
  - troubleshooting by the status shown in Settings
- `docker-compose.yml` and the units' comments.
- Phase 10 in `PLAN.md` marked done, with what was found.

## Edge cases to test

- **Midnight between steps.** The date buttons carry explicit dates. Quick entry takes the `Clock` date when the budget is tapped.
- **Messages queued while the server was down** (Telegram keeps them 24 h) are handled when it comes back, dated that day. The confirmation always shows the date, and Change date is one tap.
- **The budget is archived, deleted or not active on the chosen date** between steps: the service's 422 becomes a message and a way back.
- **Undo on a spending edited on the web since** deletes it as it is now, and the message shows its current values.
- **Many budgets**: two per row (Telegram allows 100 buttons). Long names are cut on the button but kept in messages.
- **A restored backup** brings the link back. With a different token, the bot answers nobody until you re-link (the stored user id still guards).
- **Two instances, one token**: `conflict` in Settings, and the app itself is unaffected.

## Not in this phase

Tags in the bot, receipt photos, voice, transfers or savings settlement from the bot, several people, a webhook mode, quiet hours, and a daily or weekly digest. Each can be added later on the same runtime.

## Done when

`npm run typecheck && npm test && npm run build` and `npm run e2e:flows` pass, the reviewer signs off, and a real bot on a real phone has linked, recorded a spending, undone it, and sent one reminder.
