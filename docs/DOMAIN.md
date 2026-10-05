# Domain rules

This is the specification for every number Wallet shows. When the code disagrees with this file, the code is wrong, or this file must be updated first (deliberately, in the same change).

All amounts are **integer cents**. Months are `YYYY-MM` and dates are `YYYY-MM-DD` (calendar dates with no time zone). The month of a date is its first 7 characters.

## Decisions (agreed with the owner, 2026-10-02)

| Topic                  | Decision                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Users                  | Single user, **no login**. The app must only be reachable on a trusted network (LAN or VPN).                                                           |
| Month cycle            | **Calendar month** (1st to last day).                                                                                                                  |
| Subscriptions          | Paid **off the top** of income, before budgets. **Yearly** subscriptions reserve money every month (a sinking fund) so the renewal is already covered. |
| Incremental budget     | Leftover **or deficit** carries into the next month.                                                                                                   |
| Non-incremental budget | At month end the leftover goes to **move to savings**. If it is **overspent**, the deficit is **taken from savings** and the next month starts clean.  |
| Unassigned income      | Goes to **move to savings** at month end. If it is negative (over-allocated), that amount is taken from savings.                                       |

## Month states

- **Closed**: every month before the current month. Its results are final, and its savings amount is due.
- **Current**: the month containing today. Its values are provisional and update live.
- **Future**: a projection that assumes the current month ends as it stands now.

"Today" comes from the backend clock in the server's time zone (`TZ` env). The UI reads it from `GET /api/today` and never uses the browser clock. Nothing before `settings.startMonth` is computed or accepted (see [Start month](#start-month)). Projections stop 120 months after the current month: a month before `startMonth` or beyond that horizon does not exist (404).

There is **no stored "close month" step**. Every month's figures are computed from the stored facts (salary history, incomes, subscriptions, budgets, spendings, transfers). Because of that, a late edit to a closed month simply changes that month's savings due, and the difference shows up as an outstanding adjustment (see [Savings](#savings)).

## Start month

`settings.startMonth` is the first month the app tracks. It is chosen at onboarding and can be changed later with `PUT /api/settings`. The rules below make sure it never silently invalidates stored facts (an engineering decision, 2026-10-02, not yet reviewed with the owner).

- It can't be after the current month. Otherwise the current month would be untracked and have no figures (422 `start_month_in_future`).
- It can't be more than `MAX_START_MONTH_AGE_MONTHS` (240, that is 20 years) before the current month (422 `start_month_too_old`; engineering decision, 2026-10-02). Every request recomputes the ledger from the start month, so an accidental `0001-01` would make each request take seconds. The rule is checked when a start month is **set or changed**, on the new value: in onboarding, and in `PUT /api/settings` when `startMonth` differs from the stored one. A start month that stays as it is is never refused, so the settings of an old installation stay editable as time passes, and a database that already has an older one keeps working.
- A **fact** is anything with a date or an effective month: salary changes, incomes, subscriptions (their start month), budgets (their start month), spendings, transfers, and savings transactions other than `opening`. A price or a version row is not a fact of its own: it only matters from its item's start month on, so a row dated before the item's start month (an older row that is still in effect at the start month, see [Versioned values](#versioned-values)) is inert here, and a row dated at or after the start month can never be earlier than the item itself (engineering decision, 2026-10-02).
- Moving `startMonth` **earlier** is allowed within the age limit above. The added months are simply empty: no salary, no budgets, nothing due.
- Moving it **later** is allowed only while every fact is dated in or after the new value. Otherwise the request fails with 422 `start_month_after_facts` and nothing changes. To move it later anyway, first delete or re-date the facts before the new month.
- The `opening` savings transaction follows `startMonth`: its date is always the 1st of that month, but its amount does not change, so the user must be asked for the balance on the new first day (see [Opening balance](#opening-balance)).
- Every fact created afterwards must be dated in or after `startMonth` (422 `before_start_month`). Together with the rule above, `startMonth` stays the lower bound of everything stored.

Onboarding (`POST /api/onboarding`) is one transaction. It stores the settings, the first salary change (effective from `startMonth`), the `opening` savings transaction and any first budgets (each with a first version effective from `startMonth`), or nothing at all. It fails with 409 `already_onboarded` once the settings exist. Until then, every other endpoint answers 409 `not_onboarded` (health, today, settings and onboarding excepted). "Onboarded" simply means the settings exist, so a first `PUT /api/settings` also completes onboarding.

## Versioned values

Salary, budget amount/mode and subscription price are stored as rows that are _effective from_ a month. The value for month M is taken from the latest row with `effectiveMonth <= M`. Editing one of these values upserts a row at the chosen month, which defaults to the **current month**, so closed months never change by accident. Backdating is allowed, but only when the user explicitly asks for it.

New budgets and subscriptions also default `startMonth` to the current month.

A budget always starts with a version effective exactly at its `startMonth`, and a subscription with a price effective exactly at its `startMonth`. After that **version and price rows are never deleted** by archive, cancel or a move of the start month (engineering decision, 2026-10-02): a destructive edit would silently rewrite closed months for good and could not be undone, for example by archiving with a month that is too early and then archiving again. Instead a row is read as "the latest row effective at or before M", and only the months inside the item's active range (`startMonth..endMonth`) are ever computed. So:

- A row dated **after `endMonth`** is inert. It applies again if `endMonth` moves later (archiving or cancelling again with a later month restores the months and figures the item had).
- A row dated **before `startMonth`** may be the row in effect at `startMonth`: a start moved later leaves the older rows where they were, so moving it back to where it was gives the item back exactly as it was.
- The only mutation left: moving `startMonth` **earlier than the item's first row** re-dates that first row to the new start month, so that a row is in effect at `startMonth`. Moving it later, or to a month at or after the first row, changes nothing.
- `PUT .../versions/:month` and `PUT .../prices/:month` still reject a month outside the active range (422 `outside_active_months`). A row can only be replaced or added inside the range.

The API lists every stored row (`versions`, `prices`). `current` and `currentPrice` are the row in effect in `min(current month, endMonth)`, or null while the item is upcoming, so an ended item shows its last row and an inert one is never shown.

## Causality

The figures of a month M depend only on the facts effective in or before M, plus the item's own `endMonth`, which only matters in that month (engineering decision, 2026-10-02). So a change dated in month X never moves a month before X: a salary entry, an income, a spending, a transfer, a budget version, a subscription price, an `endMonth` (archive, cancel) or a new item moves the months from X on and leaves the earlier ones exactly as they were. This is what "closed months never change by accident" rests on: nothing looks ahead from a closed month to a fact entered later. The only way to change a closed month is an explicit edit dated in it (see [Editing rules](#editing-rules)), and an `endMonth` that moves later changes the month it used to end in.

It is a property of the whole ledger, and the tests check it on generated facts of every kind (invariant 5). The yearly reserve below is written so that it holds.

**Accepted simplification (2026-10-02): the warning threshold is not dated.** `alertWarnPercent`, in the settings and per budget, is a single value, not a version row: changing it relabels `alert` and `warnPercent` on the budget lines of **every** month, closed ones included. It is a display threshold and not a money figure (no amount, carry-over or savings due depends on it), so it is excluded from the causality guarantee and from invariant 5, which covers every figure except those two fields.

## Income

```
salary(M)  = amount of the salary_changes row effective at M (0 if none)
income(M)  = salary(M) + Σ incomes dated in M
```

## Subscriptions (fixed costs)

A subscription is active in M when `startMonth <= M <= endMonth` (a null `endMonth` means it never ends). Cancelling sets `endMonth`. `price(S, M)` comes from `subscription_prices`.

The **billing day** is the day of `anchorDate`, clamped to the length of the month (31 becomes 30 in April, and 28 or 29 in February).

**Monthly** subscriptions cost `price(S, M)` in every active month.

**Yearly** subscriptions renew in the month-of-year of `anchorDate`. Each yearly subscription has a **reserve** that starts at 0 in its `startMonth`. The reserve is **causal** (engineering decision, 2026-10-02, see [Causality](#causality)): it saves towards the price in effect in each month, and never looks at a price or an end date dated later. For each active month M:

```
N            = first renewal month >= M                       (the renewal this month saves towards)
p            = price(S, M)                                    (the price in effect this month)
monthsLeft   = N − M + 1
contribution = max(0, ceilDiv(p − reserveBefore(M), monthsLeft))
reserve     += contribution
if M == N:   reserve −= p                                     (the renewal is paid, at the price in effect in N)
```

- Each month tops the reserve up to the price in effect **in that month**, spread over the months left to the renewal; ceiling division never falls behind, and the last month tops it up exactly. With a constant price the contributions of a cycle add up to the price exactly.
- A price **rise** dated in month X is spread over the months from X to the renewal, and the months before X keep their figures. A rise dated in the renewal month is topped up in that month alone.
- A price **drop** can leave the reserve above the price. Nothing more is set aside (the contribution is clamped at 0) until the renewal. After paying a renewal, a leftover reserve is **released**: it is added to M's savings due and the reserve goes back to 0. So the reserve is exactly 0 after every renewal.
- `endMonth` E only matters in E itself. Months before E are computed as if the subscription went on. In E, if the next renewal N is after E there is no renewal left: the contribution is 0 and the **whole reserve is released** into E's savings due. If E is itself a renewal month the normal rule applies (the renewal is paid, a leftover is released). Moving E, earlier or later, changes the months from the earlier of the old and the new E on, never the months before it. Nothing set aside is ever lost: it is either paid to the provider at a renewal or given back through the savings due of E.
- If a subscription renews in its own `startMonth`, the full price is charged in that month.

```
fixedCosts(M) = Σ monthly prices + Σ yearly contributions        (over active subscriptions)
```

**Accepted simplification (2026-10-02): the year of `anchorDate` is ignored.** Only its day, and for a yearly subscription its month-of-year, count. The ledger renews a yearly subscription in every month, from its `startMonth` on, that has the month-of-year of the `anchorDate`, whatever year the date is in. So a subscription whose first real charge is more than a year after its `startMonth` would be charged in each matching month before it. Workaround: give it a `startMonth` after the previous matching month, that is the month after the last occurrence of the renewal month that comes before the first real charge. It is `upcoming` until then, and from that month on it saves towards the real first charge. For a first charge on 2028-03-15, added in 2026-10, the ledger would renew it in 2027-03 as well, so the `startMonth` is 2027-04.

**Example: 120.00/year renewing in March, added in October.** October to March is 6 months, so the subscription costs 20.00 per month, and the March renewal is paid from the 120.00 reserve.

**Example: 100.00/year with 12 months to go.** The contributions are 8.34 × 4, then 8.33 × 8, which adds up to exactly 100.00.

**Example: the same 120.00/year, with the price rising to 180.00 in January.** October to December stay at 20.00 each (60.00 held), whenever the rise was entered. January to March split the 120.00 still to find: 40.00 each, and the March renewal pays 180.00. If the price drops to 40.00 in January instead, January to March set nothing aside, March pays 40.00, and the other 20.00 of the 60.00 held goes back to savings in March.

**Example: the same 120.00/year, cancelled with `endMonth` December.** October and November are 20.00 each (40.00 held). December sets nothing aside and gives the 40.00 back to its savings due. Cancelling again with `endMonth` March gives December its 20.00 again and the renewal is paid in March: nothing was lost in between.

**Status.** Relative to the current month C, a subscription is `upcoming` (C < startMonth), `active` (startMonth <= C <= endMonth, or no `endMonth`) or `cancelled` (C > endMonth). One cancelled with `endMonth = C` is still `active` until the month is over. Cancelling defaults `endMonth` to C, and cancelling again simply moves it. What the last month costs depends on the frequency. A **monthly** subscription is charged in full in its `endMonth`, whatever its billing day (a deliberate simplification: the app does not compare the billing day with the day it was cancelled). A **yearly** one follows the reserve rule above: in its `endMonth` nothing more is set aside and the reserve is released, unless `endMonth` is its renewal month, when the renewal is paid as usual.

**Accepted simplification (2026-10-02): cancelling in the renewal month.** Cancelling a yearly subscription in its renewal month with the default `endMonth` (the current month) counts the renewal as paid, even when the user cancelled before the billing day and the provider never charged it: like a monthly one, the app does not compare the billing day with the day it was cancelled. To get the reserve back instead, the user cancels with the **previous month** as `endMonth`. Nothing more is set aside then and the whole reserve is released to savings, which changes that month's savings due, so it is an explicit edit of a closed month (see [Editing rules](#editing-rules)).

**Monthly equivalent** (display only): the price for a monthly subscription, and `ceilDiv(price, 12)` for a yearly one, so 100.00/year shows as 8.34. It is not what the ledger sets aside. The reserve schedule above is authoritative.

The month view reports, for each yearly subscription, `reserveBalance` (the reserve at the **end** of M, after any renewal paid and any release, so it is 0 in a renewal month), `renewalThisMonth`, `nextRenewalMonth` (the N above) and `nextRenewalPrice` (the p above: the price in effect in M, the amount the reserve is saving towards). In an `endMonth` with no renewal left, `nextRenewalMonth` and `nextRenewalPrice` are null.

## Budgets

A budget is active in M when `startMonth <= M <= endMonth`. Archiving sets `endMonth`. `version(B, M)` gives `amount` and `incremental`.

**Status.** Relative to the current month C, a budget is `upcoming` (C < startMonth), `active` (startMonth <= C <= endMonth, or no `endMonth`) or `ended` (C > endMonth). One archived with `endMonth = C` is still `active` until the month is over. Archiving defaults `endMonth` to C, and archiving again simply moves it.

```
carriedIn(M)    = carriedOut(M − 1)                     (0 in the budget's first month)
allocated(M)    = version(B, M).amount
transfersNet(M) = Σ transfers into B dated in M − Σ transfers out of B dated in M
available(M)    = carriedIn + allocated + transfersNet
spent(M)        = Σ spendings of B dated in M           (refunds are negative)
remaining(M)    = available − spent
```

When M is closed:

| Case                                               | carriedOut(M)                 | To savings due of M                                                  |
| -------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------- |
| `incremental` and M is not `endMonth`              | `remaining` (can be negative) | 0                                                                    |
| non-incremental, **or** M is `endMonth` (archived) | 0                             | `remaining` (positive: move to savings, negative: take from savings) |

The mode used is the one in effect for M. So switching a budget from incremental to non-incremental releases its accumulated balance at the end of that month.

For the current month, `carriedOut` is projected as if the month ended today. Future months use that projection. "As if it ended today" means nothing more is assumed to happen: facts already entered are counted in the month they are dated in, even when that is after today (a spending dated tomorrow counts in the current month, one dated next month counts in next month), and no further spending is invented (engineering decision, 2026-10-02).

**Alerts**: `usage = spent / available`. A budget shows a warning at `usage >= alertWarnPercent` (budget override, else settings, default 80%). It is **over budget** when `spent > available`, which is the same as `remaining < 0`. A budget with `available <= 0` has no usage figure and is either `ok` or `over`.

The month view reports `usagePercent = max(0, floor(100 × spent / available))`, or null when `available <= 0`. It is not capped (150 means 50% over). It rounds **down** on purpose, so a displayed 79% never comes with a warning at 80%. In integer arithmetic the alert is `over` if `spent > available`, else `warning` if `available > 0` and `100 × spent >= warnPercent × available`, else `ok`.

## Transfers

A transfer moves an amount between two budgets, or between a budget and the month's **unallocated pool** (the null side). Its date decides its month. Budget-to-budget transfers change no total of the month (no field of the month's `totals`, and not `unallocated`). They only move money between the two budgets.

The ledger counts a transfer only when every budget it names is active in the transfer's month (engine decision, 2026-10-02). Otherwise the money would leave one side and arrive nowhere, so the whole transfer, pool side included, is ignored. A transfer from a budget to itself, or between the pool and the pool, moves nothing. The API never stores any of these (see below), so for stored data they are only a safety net of the engine.

The rules from here to the end of this section are engineering decisions (2026-10-02, not yet reviewed with the owner), written down before the endpoints so that the API and the UI are built to the same rules. The contract is in `shared/src/transfers.ts`.

| `fromBudgetId` | `toBudgetId` | In the month of `date`                                                                     |
| -------------- | ------------ | ------------------------------------------------------------------------------------------ |
| budget A       | budget B     | `transfersNet` of A goes down and that of B up by `amount`. `unallocated` stays as it was. |
| null (pool)    | budget B     | `transfersNet` of B goes up by `amount`. `unallocated` goes down by `amount`.              |
| budget A       | null (pool)  | `transfersNet` of A goes down by `amount`. `unallocated` goes up by `amount`.              |

`amount` is positive. The direction is in the two sides and never in a sign, so there is no negative transfer: to take one back, delete it, or make the opposite one.

**Creating one** (`POST /api/transfers`) is checked in this order:

1. The shape (400). `date` is a real date and `amount` a positive whole number of cents. Both side keys are present: an omitted side is an error and not the pool, `null` is the pool. At least one side is a budget (a transfer from the pool to the pool moves nothing), and the two sides are not the same budget (field `toBudgetId` for both).
2. Every budget side exists (422 `unknown_budget`, field `fromBudgetId`, then `toBudgetId`).
3. The date is not before `settings.startMonth` (422 `before_start_month`, field `date`), like every fact.
4. Every budget side is active in the month of `date`, that is `startMonth <= month <= endMonth` (422 `outside_active_months`, field `fromBudgetId`, then `toBudgetId`). This closes the gap with the engine above: a transfer that the ledger would ignore is never stored, so the money of a stored transfer always arrives.

**It stays valid.** The rules that change a budget's active months, and the one that moves `settings.startMonth`, already count the transfers on both sides of a budget: its `startMonth` can't move past its earliest spending or transfer (`start_after_activity`), archiving can't set an `endMonth` before its latest spending or transfer (`end_before_activity`), a budget with a transfer can't be deleted (409 `has_history`), and `settings.startMonth` can't move past a transfer (`start_month_after_facts`). So a transfer created inside the active months of its budgets stays inside them, and the ledger counts **every** transfer the API has stored (invariant 8 below holds for the stored data, and not only for what the engine happens to accept).

**It is never edited.** There is no `PATCH`: a transfer is deleted (`DELETE /api/transfers/:id`) and entered again. Its date, its two sides and its amount all decide which months and budgets it moves, so an edit would be that pair anyway.

**Any month.** A transfer may be dated in a closed month, in the current one (also after today) or in a future one, like any fact: it counts in the month it is dated in, and through the carry-over in the months after it, never in one before it (see [Causality](#causality)). In a closed month it is an explicit, dated edit (see [Editing rules](#editing-rules)) that changes that month's budgets, its `unallocated` and so its savings due: if the month was settled already, the difference shows up as an adjustment (see [Savings](#savings)). **Deleting** a transfer undoes exactly that, so the UI asks for confirmation both when it creates and when it deletes a transfer dated in a closed month.

A date beyond the 120-month horizon is accepted too, like for a spending (engineering decision, 2026-10-03): no month view exists for it, so it shows in none, but it still counts as activity of its budget (`end_before_activity`, `has_history`) until it is deleted, and `GET /api/transfers` finds it by its own month, with no filter, or by budget. The UI keeps its date picker inside the tracked range (`startMonth` to the current month plus 120), so that this can only come from a direct API call.

**Not limited by the balances.** A transfer is never refused for lack of money. Moving more than the source holds is allowed, where "holds" is the `remaining` of the source budget, or the `unallocated` of the pool, in the month of `date` as it stands without the transfer. The source budget's `available` and `remaining` then go negative, as after any overspending (alert `over`, and the deficit is carried on by an incremental budget or taken from savings otherwise). The pool becomes over-allocated (`overAllocated`). The UI warns before it sends such a transfer, and the month view shows the result as it shows any other. A manual savings withdrawal is different: it is refused beyond what its source holds, because that money has really moved, while a transfer only moves a plan inside the month.

## Unallocated

```
unallocated(M) = income(M) − fixedCosts(M) − Σ allocated(M)
                 − Σ pool→budget transfers in M + Σ budget→pool transfers in M
```

A negative value means the month is **over-allocated**, and the UI must warn about it. When M is closed, `unallocated(M)` goes to M's savings due, whether it is positive or negative.

## Tags and search

Tags and search only help to find spendings. They never change a number: no budget line, month figure, balance or savings amount depends on a tag. The rules are engineering decisions (2026-10-02, not yet reviewed with the owner). The contract is in `shared/src/tags.ts` and `shared/src/spendings.ts`.

- A **tag** has a name, an optional color and a `usageCount`, the number of spendings that carry it. A tag belongs to no budget: any spending can carry any tag.
- A **name** is trimmed and has 1 to `TAG_NAME_MAX_LENGTH` (30) characters. Names are **unique ignoring case**: two names are the same when they compare as equal under the comparison that also sorts the list (`Intl.Collator('en', { sensitivity: 'accent' })`, the one of the subscription list), so `Groceries` and `groceries` clash while `Café` and `Cafe` do not. That comparison is wider than case (engineering decision, 2026-10-03): names that differ only by Unicode normalization (`é` as one character or as `e` plus an accent), by full-width or ligature forms, by a non-breaking space or by invisible characters also clash, which is wanted because they look the same. A name made only of invisible characters (a zero-width space, say) is refused like an empty one: 400 `validation_error` at `name`. A create or a rename that clashes with another tag is a 409 `tag_name_taken`. Changing only the capitalization of a tag's own name is allowed. The list is ordered by that comparison, then by id. SQLite's unique index on the name is case-sensitive, so the service checks this rule itself.
- **Deleting a tag** removes it from every spending that carries it. The spendings, and every figure, stay as they are.
- A spending carries at most `MAX_TAGS_PER_SPENDING` (10) tags, none twice (`tagIds`, on create and on update). Each must exist (422 `unknown_tag`, field `tagIds.<i>`), checked after the budget and date rules of the spending. On update the given `tagIds` **replace** the set (`[]` removes every tag), and leaving them out keeps the tags. A spending's `tagIds` are listed ascending by id, whatever order they were sent in.
- **Search** (`GET /api/spendings`) has four new filters, which combine with each other and with `month`, `from`, `to` and `budgetId` by AND.
  - `q` is trimmed and has 1 to `SPENDING_SEARCH_MAX_LENGTH` (100) characters. It matches a spending whose description **or** notes contain it, ignoring case for every alphabet (`café` finds `CAFÉ`; SQLite's own `LIKE` and `lower()` only fold ASCII, so the service must fold the case itself). The fold (`backend/src/lib/fold.ts`; engineering decision, 2026-10-03) is applied to both sides: normalize to NFC, then lower case, upper case and lower case again (Unicode's full case mappings, so `STRASSE` finds `Straße` and `ſ` is an `s`), then the Greek final sigma `ς` is written `σ`, so that a fragment of a word is found as well as the whole word. Accents are never stripped (`cafe` does not find `CAFÉ`). There are no locale rules: dotless `ı` and `i` find each other, and the Turkish `İ` does not find `i`. It is not the tag-name comparison above, on purpose: `ß` and `ss` are two tag names but find each other in a search, while full-width letters clash as tag names and are not found by their plain spelling. The typographic ligatures `ﬁ`, `ﬂ`, `ﬃ` and their kin (U+FB00 to U+FB06) are the exception: upper case spells them out (`ﬁ` becomes `FI`), so a search for `file` finds `ﬁle`, which suits text copied from a PDF. The letters `æ`, `œ` and `ĳ` stay themselves. `%` and `_` are ordinary characters, and the spaces inside `q` count. Tag names are not searched: use `tagId`.
  - `tagId` matches the spendings that carry that tag. Each item still lists all of its tags, and an unknown tag matches nothing.
  - `minAmount` and `maxAmount` bound the **signed** amount, as stored, both inclusive. A refund is negative, so `minAmount=0` hides the refunds and `maxAmount=-1` shows only them. `minAmount` greater than `maxAmount` is a 400.
  - `totalAmount` is still the net sum over **all** the rows that match, whatever page is shown.

## Savings

```
savingsDue(M)  = unallocated(M)
               + Σ remaining of budgets settled to savings in M
               + Σ subscription reserves released in M
settled(M)     = Σ savings_transactions with kind = 'settlement' and settlesMonth = M
outstanding(M) = savingsDue(M) − settled(M)                (closed months only)
```

The **move to savings** list shows every closed month with a non-zero `outstanding`. A positive amount means "move X to savings". A negative amount means "take X from savings". Marking a month as done creates settlement transactions that sum to `outstanding`, optionally split across goals. A forgotten spending added later makes `outstanding` non-zero again, and it shows up as an adjustment.

The rules from here to the end of this section are engineering decisions (2026-10-02, not yet reviewed with the owner), written down before the endpoints so that the API and the UI are built to the same rules. The contract is in `shared/src/savings.ts` and `shared/src/goals.ts`.

`savings_transactions` record money that actually moved:

- `opening`: the savings balance on the first day of the start month (see [Opening balance](#opening-balance)).
- `settlement`: settles a month's due amount.
- `deposit` / `withdrawal`: manual money in or out, for example paying for the holiday from its goal.
- `reallocation`: moves money between goals (or between a goal and unassigned savings) as a pair of rows that sum to 0.

An amount is **signed**: positive moves money into savings (or into the goal the row belongs to), negative takes it out. A row's `date` is the day the money moved (a settlement is dated the day it was made, not the month it settles). Its `goalId` says where the money sits, and no goal means **unassigned** savings (not to be confused with a month's **unallocated** income). The two rows of a reallocation share a `groupId`, which is null on every other row.

```
savingsBalance = Σ all savings_transactions
goalBalance(G) = Σ rows with goalId = G
unassigned     = Σ rows with goalId null
savingsBalance = unassigned + Σ goalBalance(G)            (over every goal, archived ones too)
```

**A balance can be negative.** Only a manual action is checked against what a balance holds (`insufficient_balance`, see [Manual money](#manual-money)). A settlement that takes money from savings records what really happened and is never refused, and deleting a row or undoing a settlement is not checked either. So a goal, the unassigned savings or the whole balance can be below 0, and the UI shows it as it is.

### Outstanding months

`GET /api/savings` derives the "move to savings" list from the ledger and the settlement rows. Nothing about it is stored.

- It has one entry for every closed month M (`startMonth <= M < current month`) whose `outstanding(M)` is not 0, ascending by month. A month that is settled exactly is not listed.
- An entry carries `savingsDue`, `settled`, `outstanding`, `direction` (`move` when `outstanding` is positive, `take` when it is negative) and the `breakdown` of `savingsDue`: its three lines in the formula above (`unallocated`, `budgetsSettled`, `reservesReleased`).
- `adjustment` is true when M has at least one settlement row. The month was settled before and later edits (a forgotten spending, a changed salary) moved its `savingsDue`, so what is outstanding is a correction of the earlier settlement and not a first move. It is normally the same as `settled <> 0`, and differs only when earlier settlements netted to 0.
- `outstandingTotal` is the signed sum of the listed `outstanding` amounts.
- A settlement row of a month that is not closed (only possible if the server clock moves backwards) counts in the balances and is ignored by the list.
- The same response carries `balance`, `unassigned` and the goals (see [Goals](#goals)).

### Settling a month

`POST /api/savings/settle/:month` takes `{ amount, allocations? }` and runs these checks in order:

1. The month must exist (from `startMonth` to 120 months after the current month, else 404) and be closed (422 `month_not_closed` for the current month or a future one).
2. Its current `outstanding` must not be 0 (409 `nothing_to_settle`).
3. `amount` is required and must equal the current `outstanding`, an optimistic lock. The user confirms the figure they saw, and if an edit moved it in the meantime the request fails with 409 `outstanding_changed`. Its `details` (`{ month, outstanding }`) carry the current value, so the UI can show it and ask again.
4. `allocations` split the amount: `[{ goalId, amount }]`, where a null `goalId` is unassigned savings. Every allocation has the sign of `amount` and they add up to it exactly (422 `allocation_mismatch`). No goal appears twice (400), and every goal must exist and not be archived (422 `unknown_goal`, `goal_archived`; the first offending allocation, in order, decides). An archived goal can't be named even by an allocation that takes money from savings: its money is taken out with a withdrawal or a reallocation (see [Manual money](#manual-money)). Omitted `allocations` mean one allocation of the whole `amount` to unassigned savings.

It then stores one `settlement` row per allocation, in order, with `settlesMonth` = M, dated today (the server clock) and with no note. Everything is one transaction, so either all the rows are stored or none is. A negative `amount` ("take from savings") gives negative rows, which take the money from each allocation's goal or from unassigned savings. It is exempt from the non-negative balance rule: it records what really happened, even when that takes a goal below 0.

`DELETE /api/savings/settle/:month` undoes it. It removes every settlement row of M in one transaction (204, or 404 when M has none), and M is outstanding by its whole `savingsDue` again, no longer as an adjustment. A settlement is never edited row by row (see `not_deletable` below): undo it and settle again.

### Manual money

`POST /api/savings/transactions` takes a body discriminated by `kind`:

| `kind`         | Body                                                                            | Rows stored                                                                                 |
| -------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `deposit`      | `amount > 0`, `goalId?` (null or omitted: unassigned savings), `date?`, `note?` | one row, `+amount`                                                                          |
| `withdrawal`   | the same                                                                        | one row, `−amount` (the amount in the body is positive)                                     |
| `reallocation` | `amount > 0`, `fromGoalId`, `toGoalId` (null: unassigned), `date?`, `note?`     | two rows with a shared `groupId`: `−amount` for `fromGoalId`, then `+amount` for `toGoalId` |

- `fromGoalId` and `toGoalId` must differ (400), so a reallocation always moves money. It never changes `savingsBalance`, because its two rows sum to 0, and both rows carry the same date and note.
- `date` defaults to today. It can't be before the first day of `startMonth` (422 `before_start_month`, like every fact) nor after today (422 `date_in_future`): these rows record money that has already moved.
- Goals must exist (422 `unknown_goal`). Money can't go **into** an archived goal: the `goalId` of a deposit and the `toGoalId` of a reallocation must not be archived (422 `goal_archived`). An archived goal can still be the **source** of money: the `goalId` of a withdrawal and the `fromGoalId` of a reallocation may be archived (engineering decision, 2026-10-02: the money left in an archived goal must never be frozen).
- A withdrawal or a reallocation can't take more than its source holds (422 `insufficient_balance`, field `amount`). The source is a goal or the unassigned savings, and what it holds is its balance **as it is now**, counting every row whatever its date.
- The checks run in this order: date, goals (for a reallocation: `fromGoalId` exists, `toGoalId` exists, `toGoalId` is not archived), balance. The rows are stored in one transaction.

`DELETE /api/savings/transactions/:id` removes a deposit, a withdrawal or a reallocation (both rows, whichever row's id is given) and answers 204. It is not limited by the balances, so it can leave one below 0. An `opening` row and a `settlement` row answer 409 `not_deletable`: the opening balance is changed with `PUT /api/savings/opening`, and a settlement is undone with `DELETE /api/savings/settle/:month`. An unknown id is a 404.

`GET /api/savings/transactions` lists the rows, newest first (date, then id, descending), as a `Page`. It filters by `goalId`, by `unassigned=true` (the rows with no goal) and by `kind`, and the filters combine. A transaction can't be edited: delete it and enter it again.

### Opening balance

The `opening` transaction is the savings balance **on the first day of the start month**. It belongs to no goal, so it is part of the unassigned savings. `PUT /api/savings/opening` with `{ amount }` (not negative) creates or updates it, always dated the 1st of `settings.startMonth`, and `GET /api/savings/opening` reads it. Without an `opening` row, which is the case after a first `PUT /api/settings` created the settings, the opening balance is 0.

Moving the start month moves the row's date but **does not change its amount**. The amount was the balance on the old first day, and the balance on the new first day can be different: moving the start month earlier would claim savings that did not exist yet. So after a change of the start month the UI must prompt the user for the balance on the new first day and send it with `PUT /api/savings/opening`.

### Goals

A goal has a `name`, a positive `targetAmount`, an optional `deadline` (a date, of which only the month counts), an optional color, and can be archived. `GET/POST/PATCH/DELETE /api/goals` manage them, and the list shows archived goals last, each group in creation order. Its figures are derived from the savings transactions and the current month:

```
balance          = goalBalance(G)                                     (can be negative)
progressPercent  = max(0, floor(100 × balance / targetAmount))        (not capped: 150 means 50% over)
remaining        = max(0, targetAmount − balance)
reached          = balance >= targetAmount                            (same as remaining = 0 and progressPercent >= 100)
```

`progressPercent` rounds down on purpose, so a displayed 100 always means reached. Like `usagePercent` it is an exact integer floor, with no floating point.

**Monthly amount needed.** When a deadline is set, the UI shows what to put aside each month to reach the target in time:

```
deadlineMonth = month of the deadline                                 (its first 7 characters)
monthsLeft    = max(1, monthDiff(current month, deadlineMonth) + 1)   (the current month and the deadline's month both count)
monthlyNeeded = ceilDiv(remaining, monthsLeft)
```

`monthlyNeeded` is null without a deadline, once the goal is reached, and when it is archived. Both months count because money put aside in the current month counts towards the goal, and the deadline's month is still on time. Once the deadline's month has passed, `monthsLeft` stays at 1, so a goal that missed its deadline needs all of `remaining` now. Ceiling division never falls short, so the last month may need a few cents less.

**Example: 1,000.00 by 15 March 2027, with nothing saved on 2026-10-02.** The deadline's month, 2027-03, is 5 months after 2026-10, so `monthsLeft` is 6 (October to March) and `monthlyNeeded` is `ceilDiv(100000, 6)`, that is 166.67. With 300.00 saved, `remaining` is 700.00 and `monthlyNeeded` is 116.67. In February 2027 `monthsLeft` is 2 and in March it is 1, so the whole remainder is needed. From April 2027 it stays at 1, and the goal is `overdue` unless it is reached.

**Status**, the first that applies: `archived`, `reached`, `overdue` (it has a deadline and the deadline's month is before the current month), `active`. A reached goal past its deadline is `reached`, not overdue.

An **archived** goal keeps its balance, which still counts in `savingsBalance` (and not in `unassigned`), but it can't **receive** money: no deposit, reallocation destination or settlement allocation can name it (422 `goal_archived`), and a settlement allocation can't name it even to take money from savings. It can still **give** money: it may be the source of a withdrawal or of a reallocation, so what is left in it is never frozen (engineering decision, 2026-10-02). Un-archiving the goal (`PATCH` with `archived: false`) makes it receive money again, and deleting it moves its balance to unassigned savings.

**Deleting** a goal moves its balance to unassigned savings (its rows get `goalId` null). No money is lost and `savingsBalance` does not change.

## Engine conventions

The ledger (`computeLedger` in `backend/src/domain/ledger.ts`) is a pure function of the stored facts and the current month. The rules above apply to every month the same way; the status only labels it. A few conventions keep it total and deterministic (engine decisions, 2026-10-02):

- It never fails a request over data the API cannot store. A subscription with no price in effect counts as 0, a budget with no version as an allocation of 0 in a non-incremental budget, and a spending for an unknown budget, or dated outside its budget's active months, is shown nowhere.
- Nothing is carried into the first month an item is computed in: its first active month, or `settings.startMonth` when the item starts before it (which the API does not allow).
- The lines of a month are ordered like the lists they come from: budgets by `sortOrder`, then id; subscriptions by name ignoring case, then id. The same facts therefore give the same month in any row order.
- Money is never rounded: the only divisions of an amount are the `ceilDiv` of the yearly reserve and of a goal's monthly amount needed, and the percentages of Alerts and of goal progress are exact integer floors.

## Invariants (enforced by tests)

1. **Per budget, per month:** `carriedIn + allocated + transfersNet − spent = carriedOut + toSavings`. The engine applies it to closed, current and future months alike.
2. **Conservation, from startMonth to any month M:**
   `Σ income = Σ spendings + Σ subscription charges paid + Σ savingsDue + Σ incremental carriedOut(M) + Σ subscription reserves held at end of M`.
   Every cent of income is either spent, sent to savings, or still held in a budget or reserve. "Charges paid" is what the providers were paid: the monthly prices plus each yearly renewal (taken out of the reserve), not the contributions. The last two terms are summed over the budgets and the subscriptions at the end of M. Month by month it reads `income = spent + paid + savingsDue + Δ held in budgets + Δ held in reserves`.
3. **Exact splits:** the yearly contributions of a renewal cycle sum exactly to the renewal price when the price does not change within the cycle. In every case the reserve is exactly 0 after a renewal: what a cycle sets aside is the renewal paid plus what is released.
4. **Determinism:** computing any month twice from the same facts gives identical results, and results don't depend on the order of rows.
5. **Causality:** a fact dated in month X never changes a month before X (see [Causality](#causality)).
6. **Savings (Phase 4):** `savingsBalance = unassigned + Σ goal balances` over every goal; a reallocation never changes `savingsBalance`; deleting a goal changes neither `savingsBalance` nor any other goal's balance.
7. **Settling (Phase 4):** after a settlement of a closed month M, `outstanding(M)` is 0. After the undo of M no settlement row of M is left and `outstanding(M) = savingsDue(M)`, and settling a month that had no settlement and undoing it at once leaves every balance as it was. A month is in the outstanding list if and only if its `outstanding` is not 0.
8. **Transfers (Phase 5):** in every month, `Σ transfersNet` over the budget lines (`totals.transfersNet`) equals the transfers from the pool into budgets minus the transfers from budgets into the pool dated in that month, so `unallocated = income − fixedCosts − Σ allocated − Σ transfersNet`. A transfer between two budgets adds 0 to it: it changes no field of `totals` and not `unallocated`, and only moves `available` and `remaining` from one budget to the other. When the two budgets are in different modes it also moves that amount between the `carriedOut` and the `toSavings` of the month, and the sum of `savingsDue` and of the carry-overs, which invariant 2 balances, does not change (engineering decision, 2026-10-02).

9. **Reports (Phase 6):** every figure of the yearly report is the sum of the same figure over the month views of its included months (`GET /api/months/:month`), line by line and in total, and `saved` is the sum of the `savingsDue` of those months whatever was settled (engineering decision, 2026-10-03).

10. **Import and export (Phase 7):** (a) an import is all or nothing: a commit that is rejected, or that fails, leaves the spendings table exactly as it was; (b) a file that was committed is flagged **duplicate on every imported row** when previewed again, and committing it again with every line listed is rejected without storing anything; (c) the rows a commit stores have exactly the dates, amounts (in spending sign) and cleaned descriptions that the preview showed for those lines, whatever the order of `rows`; (d) every date and amount of an export reads back to the same date and cents through the importer; (e) no cell of an export that is text begins with `=`, `+`, `-`, `@`, a tab or a carriage return, and neither does a piece of such a cell after a `;` (the cells a spreadsheet with `;` as its list separator makes of it) (engineering decision, 2026-10-03). The money consequence is in the spendings: an imported spending counts in its budget like any other, so the ledger invariants above hold for imported data.

Invariants 6 and 7 are checked by the Phase 4 route and scenario tests, which assert the savings identities after every step (`expectSavingsIdentities` in `backend/src/testing/savings-helpers.ts`).

Invariant 9 is checked by `expectReportMatchesMonthViews` (`backend/src/testing/report-helpers.ts`) on every report of the Phase 6 route and scenario tests.

Invariant 10 is checked by the Phase 7 tests: the pure helpers by `shared/src/csv.test.ts`, `csv.property.test.ts` and `export.test.ts` (the round trip, the guard), and the endpoints by the route and scenario tests of `backend/src/modules/import` and `modules/export`, which commit, preview again and compare with the rows the preview showed.

Invariant 8 is checked on generated transfers by the ledger tests (`monthViolations` in `backend/src/testing/month-identities.ts` and the independent model in `backend/src/testing/prop-model.ts`) and, from Phase 5 on, by the route and scenario tests on transfers made through the API.

## Editing rules

- Budgets that have spendings or transfers can't be deleted, only archived. Subscriptions can be cancelled (`endMonth`). A hard delete removes them from every past month too, so the UI warns before doing it.
- A spending must be dated within its budget's active months, and on or after `settings.startMonth`.
- A budget's `startMonth` can't be moved past its earliest spending or transfer, and its `endMonth` can't be set before its latest spending or transfer.
- An `endMonth` (archive, cancel) can't be before the item's `startMonth`, and a `startMonth` can't be moved past an existing `endMonth`.
- Salary changes, incomes, new budgets and subscriptions, and budget versions and subscription prices can't be dated before `settings.startMonth`. Versions and prices must also fall within the item's active months.
- There is no way to reopen an archived budget or a cancelled subscription in v1 (no way to clear `endMonth`). Archiving or cancelling again only moves `endMonth`, earlier or later, and moving it later brings back the months, versions and prices it had (see [Versioned values](#versioned-values)).
- Changing or deleting a **salary entry** dated in a closed month rewrites those months. So does an explicit `endMonth` in the past, a backdated version or price, a start month moved earlier, and a spending or income added to a closed month. These are explicit, dated edits (the UI confirms them, and so does the Telegram bot: see [The `/spending` flow](#the-spending-flow)), not accidents, so they stay allowed (engineering decision, 2026-10-02). What the rules prevent is a change that moves closed months without being dated in them (see [Causality](#causality)).
- The **renewal month** of a yearly subscription (the month of its `anchorDate`) can't be changed once the subscription has a closed month, that is when its `startMonth` is before the current month (422 `renewal_month_in_history`, `field: "anchorDate"`). Every cycle is computed towards the renewal month, so changing it would re-spread the closed months with no explicit backdating. The user cancels the subscription and adds a new one instead. Changing only the billing day (the day of `anchorDate`, or its year) is always allowed, and so is any change while no month has closed and any change to a monthly subscription (engineering decision, 2026-10-02).
- A manual savings transaction can't be dated before the first day of `settings.startMonth` or after today. `opening` and `settlement` rows are never deleted one by one: the opening balance is replaced, and a settlement is undone for its whole month (see [Savings](#savings)).
- Deleting a goal moves its balance back to unassigned savings (`goalId` becomes null). No money is lost.
- A spending created by [CSV import](#csv-import) is an ordinary spending: it is edited and deleted like any other and follows every rule above. It keeps its `importHash` when edited, so its file row still counts as imported, and deleting it frees the hash so that row can be imported again.

## Upcoming renewals

`GET /api/subscriptions/upcoming?days=N` lists, for each subscription, its **next billing date** when that date is from today to today + N days, both inclusive, in the server's time zone. The rules are engineering decisions (2026-10-03, not yet reviewed with the owner). The contract is in `shared/src/subscriptions.ts`. The Telegram renewal reminders read this list (see [Renewal reminders](#renewal-reminders)).

- **N** is a whole number from 1 to 366 (`UPCOMING_MIN_DAYS`, `UPCOMING_MAX_DAYS`), 30 when omitted, and anything else is a 400. No started subscription is more than 366 days from its next billing date (the longest gap between two renewals of a yearly one), so `days=366` lists the next billing date of every subscription that has started and still has one, and of those that start within the window. One whose `startMonth` is further ahead is not listed yet.
- **The date.** The billing day is clamped to the month as above, and a yearly subscription bills only in the month-of-year of its `anchorDate` (the year of `anchorDate` is ignored, as in [Subscriptions](#subscriptions-fixed-costs)). The next date is the earliest one that is today or later. A subscription is listed **at most once**, even when a wide window holds several of its dates.
- **Active in the month of the date.** The date's month must be within `startMonth..endMonth`. So a subscription cancelled in an earlier month is never listed, one whose `endMonth` is before its next billing date is not listed (a monthly one cancelled this month still shows a date that is ahead this month, because its `endMonth` is a charged month, and a yearly one ends in its renewal month with the renewal paid as usual), and one that has not started yet **is** listed once its first billing date is in the window, in a month from its `startMonth` on. Its status therefore does not matter, only the month of the date.
- **The price comes from the price rows**: the row in effect in the month of the date (`effectiveAt`), never `nextRenewalPrice` of the month view (see below). A row dated after the date's month does not apply to it, and a row dated after `endMonth` is inert as always.
- **`reserved`** (yearly only, null for monthly) is what is already set aside towards that renewal **as of today**, from the same ledger run as the month view. It is the reserve **after the current month's top-up and before the renewal's payment**, because the current month is already planned (its contribution is part of its fixed costs, and the ledger counts it in `reserveBalance` of the month), and it is never more than the price. Precisely, with C the current month and N the month of the date:
  - **N = C (a renewal this month):** the reserve of C's line before the payment, that is its `reserveBalance` after the payment, plus the `price` paid, plus the `reserveReleased` (so it follows the ledger rule, and not an assumed one). Top-ups bring it to the price, so it is always the whole price: the renewal is fully covered, and what is left after a price drop is released after the payment, which is why it is capped at the price.
  - **N > C (a later renewal):** `reserveBalance` at the end of C. It is 0 when the renewal of this year has just been paid (C is the renewal month and the date is next year's), and 0 when the subscription has no line in C (it starts later: its reserve starts at 0 in its `startMonth`).
  - The cap is the price **of the renewal**, read from the price rows. When a rise is dated in N, the months before it saved towards the old price, so `reserved` is below the price and the rest is `unreserved` (`amount - reserved`). When a drop is dated in N, the reserve can exceed the price, and `reserved` is the price (the rest is released after the payment).

**Accepted simplification (2026-10-02): a price row means "save towards it from this month on".** The month of a price row is never "the renewal it applies to": that would make an earlier month look ahead at a later price and break [causality](#causality). The reserve of a month saves towards the price in effect **in that month**. So `nextRenewalPrice` and the month line's `price` can differ from what a renewal will really cost when a price change is dated in the renewal month itself: the months before it save towards the old price, and the renewal month pays the new one (a rise is topped up in that month alone, and a drop releases the difference). Anything that shows the price a renewal **will** charge, such as this list, must read the price rows, taking the one in effect in the renewal's month, and never `nextRenewalPrice`.

## Yearly report

`GET /api/reports/yearly/:year` sums a calendar year. The rules are engineering decisions (2026-10-03, not yet reviewed with the owner). The contract is in `shared/src/reports.ts`.

**It adds nothing of its own.** The report is built from the rows of the same ledger run as `GET /api/months/:month` (`computeLedger`, one run from `startMonth` through the last included month), so every figure is a sum of month-view figures and it can never disagree with them. A late edit to a closed month moves the report exactly as it moves the month.

- **Which months are included**: the months of the year from `startMonth` to the current month + 120 (the months that exist, see [Month states](#month-states)). A month before `startMonth` is not tracked, so it is **not counted, and not shown as zero**: `firstMonth` of a year that holds the start month is the start month. A month beyond the horizon does not exist. Each included month carries its `status`, and the totals cover **all included months**, projections too (a future month assumes the current month ends as it stands). A year with **no** included month, one before the start month's year or after the horizon's, is a 404; a malformed year is a 400 first.
- **Income**: `salary`, `extra` and `total` summed over the included months.
- **Fixed costs**: `total` is the sum of the months' `fixedCosts`, which is what the subscriptions took off the income. There is one line per subscription that has a month line in the included months, with its **`cost`** (the sum of its `charge`, so the costs add up to `total`: for a yearly one this is the money set aside, the top-ups, and not what the provider was paid) and its **`paid`** (what the provider was paid in those months: a monthly price every month, a yearly renewal price in its renewal month, so a yearly subscription of the year whose renewal falls outside it has `paid` 0). `fixedCosts.paid` is the sum of `paid`. A reserve still held at the end of the year is neither (it carries into the next one), and a reserve released is not a cost, it is part of `saved`.
- **Spent per budget**: one line per budget that has a month line in the included months, even with no spending, with the sum of its `allocated` and of its `spent` (refunds subtract). A budget's spendings dated outside its active months are shown nowhere, as in the month view. The lines of all budgets add up to the report's `spent` and `allocated`, ascending by `sortOrder`, then id.
- **Saved** is the month's **savings due** (`savingsDue.total`: the unallocated income, plus the budgets settled to savings, plus the reserves released), per month and summed, with its three lines as `savedBreakdown`. It is the amount **due** to savings when the month closes, derived from the ledger, **not** what was moved: the settlement rows (see [Savings](#savings)) are never read, so settling or undoing a settlement does not change the report, and a month's figure is the `savingsDue` of the savings inbox for that month. A negative month is money taken from savings. It is also what the dashboard chart calls "saved".
- **Allocated** and **unallocated** are summed the same way. A month's `unallocated` is the month view's, so it already includes the pool's side of the transfers (see [Unallocated](#unallocated)), and `saved = unallocated + budgetsSettled + reservesReleased` holds for every month and for the year.

## CSV export

`GET /api/export/spendings.csv`, `GET /api/export/incomes.csv` and `GET /api/export/savings.csv` give the stored facts to a spreadsheet or an accountant. The rules are engineering decisions (2026-10-03, not yet reviewed with the owner). The contract is in `shared/src/export.ts` and the pure helpers (cents as text, the injection guard, the writer) in `shared/src/csv.ts`. An export reads stored rows and computes nothing: it never changes a figure, and it is not a backup (see [Backups](#backups), the lossless copy).

- **Range.** `from` and `to` are dates (`YYYY-MM-DD`), both inclusive and both optional (an omitted bound is open). A row is in range by its own `date`, which for a savings transaction is the day the money moved. `from` after `to` is a 400 at `to`, like the spending list. A range with no row is still a file: the byte order mark and the header row.
- **Which rows.**
  - `spendings.csv`: every spending in range, with the **name** of its budget and the **names** of its tags. The `importHash` and the timestamps are not exported (they are bookkeeping, and the importer recomputes the hash from the file).
  - `incomes.csv`: the rows of the `incomes` table, the extra one-off incomes of `GET /api/incomes`. The **salary is not in it**: it is a monthly value with an effective-from month, not a set of dated rows, and exporting it would mean inventing one row per month. Wallet has no recurring extra income, so there is nothing else to decide.
  - `savings.csv`: every savings transaction in range, of every kind (`opening`, `settlement`, `deposit`, `withdrawal`, `reallocation`), with the goal's id and name.
- **Columns** are fixed, in this order, and the header row names them (`EXPORT_SPENDINGS_COLUMNS`, `EXPORT_INCOMES_COLUMNS`, `EXPORT_SAVINGS_COLUMNS`): `id,date,amount,budget,description,notes,tags` · `id,date,amount,description` · `id,date,kind,amount,goal_id,goal,settles_month,note,group_id`. A missing value (no notes, no goal) is an empty cell. The `tags` cell holds the tag names ascending under the tag-name comparison, then by id, joined by `|` with nothing around it; a name that itself holds a `|` is not escaped, because the cell is for reading and the backup is the lossless copy.
- **Order**: ascending by date, then id, so a spreadsheet reads as time passes (the API lists show newest first).
- **Amounts** are plain decimal text built from integer cents with no floating point (`formatCentsPlain`): an optional `-`, the whole units with **no thousands separator**, a `.` and always two digits, so `1230` is `12.30`, `-5` is `-0.05`, `0` is `0.00` and a negative zero is never written. The sign is the one stored: in `spendings.csv` an expense is positive and a refund negative (**spending sign**), in `incomes.csv` it is positive, in `savings.csv` it is signed as stored (a withdrawal is negative). `parseCents` and `parseImportAmount` read the text back to the same cents for every amount, which `shared/src/csv.property.test.ts` checks.
- **Format.** `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="..."` and `Cache-Control: no-store`. The body is UTF-8 with a **byte order mark**, so Excel reads the accents. Records are separated by **CRLF** (the last one too), fields by `,`, and a field is quoted per RFC 4180, that is only when it holds a `"`, a `,`, a CR or an LF, with the quotes inside doubled. The file name holds the range (`exportFilename`): `wallet-spendings-all.csv`, `wallet-spendings-from-2026-01-01.csv`, `wallet-spendings-until-2026-03-31.csv` or `wallet-spendings-2026-01-01_to_2026-03-31.csv`.
- **Formula injection.** A spreadsheet runs a cell that begins with `=`, `+`, `-`, `@`, a tab or a carriage return as a formula, and a description or a note comes from outside (a bank file, a shared link). So every **text** cell that begins with one of those characters gets a leading `'` (`guardCsvText`), which a spreadsheet shows as nothing and which makes the cell text. The same holds **right after a `;` inside the text**: a spreadsheet whose list separator is `;` (most euro locales, so Excel on an Italian computer) splits a double-clicked file at every `;` of a cell, and quoting does not protect it there (the quote is not at the start of the field), so `Shop;=cmd` is written `Shop;'=cmd`. A `,` needs no such rule: a cell with a comma is quoted, and a spreadsheet that splits on commas reads the quotes. The text cells are `budget`, `description`, `notes` and `tags` of the spendings, `description` of the incomes, `goal` and `note` of the savings (`EXPORT_TEXT_COLUMNS`), each guarded **as a whole**, after the tag names are joined. **Amounts are numbers, not text, and are never guarded**: `-12.30` stays `-12.30`. Ids, dates, months and the kind are never guarded either. The guard changes the text of a cell that has one of the characters at one of those places, so such a description reads back with its `'` (accepted: it is what makes the file safe to open).
- **Round trip.** `spendings.csv` imports again with `EXPORT_SPENDINGS_IMPORT_MAPPING` (`,`, a header row, ISO dates, `.` decimals, `expenses_positive`): every date and amount comes back exactly, refunds as credits. Spendings entered by hand have no `importHash`, so importing the export into the same database does not flag them as duplicates and creates a second copy. The one spending the round trip cannot bring back is one with **no description** (`POST /api/spendings` allows an empty one): its cell is empty and the importer refuses the row with `empty_description` (see [The description, the hash and duplicates](#the-description-the-hash-and-duplicates)).

## CSV import

The importer turns a bank's CSV file into spendings in three steps: **parse** (look at the file), **preview** (judge every row under a mapping) and **commit** (store the rows the user chose). Saved **profiles** let the next file of a bank skip the mapping. The rules are engineering decisions (2026-10-03, not yet reviewed with the owner). The contract is in `shared/src/import.ts`, and the one reader of a file is `readImportRows` in `shared/src/csv.ts`.

**Stateless.** The server keeps no uploaded file. The client holds the text of the file and sends it again with every call (`parse`, `preview`, `commit`). The server only ever sees **text** (a JSON string): turning the bytes of the file into text is the client's job. The UI reads the file as UTF-8 and, when it is not valid UTF-8, as windows-1252, which is what the exports of most banks use when they are not UTF-8; a file that begins with a UTF-16 byte order mark (little or big endian) is read as UTF-16. `commit` receives the file and the mapping and a list of `{ line, budgetId }`, **never an amount, a date or a description**: the server reads the file again with the same function the preview used, so there is one parser and a `line` means the same row in both. The `/api/import` bodies may be up to `IMPORT_MAX_BODY_BYTES` (10 MiB). A larger body is a 413 `payload_too_large` with `details.limitBytes` in the standard error format. Every other endpoint keeps `express.json()`'s 100 kB (`DEFAULT_BODY_LIMIT_BYTES`), and a body above that is the same 413 there. (`express.json({ limit })` must be mounted on `/api/import` **before** the global parser, which would refuse the body first.) A file may have at most `IMPORT_MAX_ROWS` (10,000) data rows: `preview` and `commit` answer 400 at `csv` for more. Every endpoint answers 409 `not_onboarded` until the settings exist.

### Reading the file

- A leading **byte order mark** is dropped. A record ends at **CRLF, LF or CR**. Lines are counted from 1, each break counting once, also inside a quoted field, so the **`line` of a record is the line it starts on** as an editor shows it (a quoted description with a line break spans two lines, and the next record's line accounts for it).
- A field is **quoted** only when its first character is a `"`. Inside it `""` is a quote, and delimiters and line breaks are text. Characters after the closing quote up to the next delimiter are kept as they are. A quote anywhere else is an ordinary character. A quoted field that is never closed is a 400 `validation_error` at `csv` that names its line (on `parse`, `preview` and `commit` alike).
- The **delimiter** is `,`, `;`, a tab or `|`. `parse` takes `delimiter` from the request or detects it (`detectDelimiter`): each candidate reads the first 20 non-blank records and scores the records with as many cells as the first one, provided that is two or more; the highest score wins, then the delimiter that gives the first record more cells, then the order `,` `;` tab `|`, and a file no delimiter splits is `,`. `preview` and `commit` use `mapping.delimiter` and detect nothing.
- A **blank record** (an empty line, or every cell empty or blank, like `;;;`) is skipped everywhere: it is no data row and no header, and it is not counted, but the line numbers still count its line. With `hasHeader` the **first non-blank record** is the header and is not a data row. A cell that a record does not have is read as empty. There is no support for lines before the header (a statement preamble): the user deletes them.
- `POST /api/import/parse` has no mapping, so it does not know whether the file has a header. It answers with the delimiter used, the cells of the **first** non-blank record as `header` (the header row of a file that has one), up to `IMPORT_SAMPLE_ROWS` (5) records after it as `sample` (each with its `line`), `recordCount` (every non-blank record, the first included: the data rows are `recordCount - 1` with a header and `recordCount` without) and `columnCount` (the widest record), and `suggestedProfileId` (see [Profiles](#profiles)). It writes nothing.
- **Columns are 0-based positions** (`dateColumn`, `amountColumn`, `descriptionColumn`), so a file with no header works. They must be three different columns. There is **one amount column**: debit and credit columns in two places are not supported in this phase.

### Dates

`dateFormat` is one of a closed set. The cell is trimmed first, and the separators are exactly those of the name.

| Format       | Reads                                   |
| ------------ | --------------------------------------- |
| `YYYY-MM-DD` | `2026-03-05`, `2026-3-5`                |
| `YYYY/MM/DD` | `2026/03/05`                            |
| `YYYYMMDD`   | `20260305`, exactly eight digits        |
| `DD/MM/YYYY` | `05/03/2026` and `5/3/2026` are 5 March |
| `MM/DD/YYYY` | `03/05/2026` and `3/5/2026` are 5 March |
| `DD.MM.YYYY` | `05.03.2026`                            |
| `DD-MM-YYYY` | `05-03-2026`                            |
| `MM-DD-YYYY` | `03-05-2026`                            |

`YYYY` is **exactly four digits** (and at least 0001), so a **two-digit year (`5/3/26`) is never accepted**: it is `invalid_date`, because guessing the century would silently misdate money. `DD` and `MM` take one or two digits (so there is no separate `D/M/YYYY`), except in `YYYYMMDD`. The date must exist (no 31 April, no 29 February in a common year). A **time of day after the date is ignored** and not converted to any time zone: a space or `T`, then `H:MM`, optionally `:SS` and a fraction, optionally `Z` or an offset (`2026-03-05T23:30:00Z` is 5 March). The time is thrown away, so it is not checked: `2026-03-05 99:99` is read as 5 March. Anything else after the date is `invalid_date`.

### Amounts and the sign

`decimalSeparator` is `.` or `,`. After trimming, an amount is an optional sign (`+`, `-` or the typographic minus U+2212), **at least one digit** of whole units, and optionally the decimal separator and digits. The whole part may be written with **thousands separators**: a space (also the no-break, narrow no-break and thin spaces), an apostrophe (`'` or `’`) or **the other one of `.` and `,`**, with groups of exactly three digits after a first group of one to three, and the same separator every time (`1,234,567.89`, `1.234.567,89`, `1 234,50`, `1'234.50`); the four kinds of space count as one separator, and so do the two apostrophes (`1 234 567,00` is 1,234,567.00). No currency symbol or code, no parentheses, no trailing sign, no exponent, and no whitespace except as a thousands separator. The chosen decimal separator decides an ambiguous cell: `1.234` is 1234.00 with `,` and invalid with `.`.

At most two decimals count: more are accepted only when every digit after the second is `0` (`12.300` is 12.30), and a value is **never rounded**: `12.345` is `invalid_amount`. The result is exact integer cents with no floating point (`parseImportAmount`). `0.00` and `-0` are `zero_amount`, and an amount above `MAX_CENTS` (1e12 cents) in absolute terms is `amount_too_large`, the same limits as `POST /api/spendings`.

`signConvention` says which sign the bank puts on money that **leaves** the account. The row's `amount` in the preview is always in **spending sign**: positive is an expense, negative is a refund.

| `signConvention`    | A bank amount of `-12.30` | A bank amount of `+5.00` |
| ------------------- | ------------------------- | ------------------------ |
| `expenses_negative` | the spending `1230`       | the spending `-500`      |
| `expenses_positive` | the spending `-1230`      | the spending `500`       |

A row on the "wrong" side of the convention, that is **a negative spending amount**, is a **credit** (`credit: true`): in a real bank file mostly a salary or a transfer in, rarely a refund. A credit is not an error, and it is **not imported unless the commit lists it** with a budget, so the preview marks it and the UI leaves it unchecked. Imported into a budget it is an ordinary refund and lowers that budget's `spent`. The importer never creates an income: a salary row is left unchecked and is entered as salary or income.

### The description, the hash and duplicates

- The **description** that is stored is the cell with every run of whitespace (spaces, tabs, line breaks, no-break spaces) collapsed to one space and the ends trimmed (`cleanImportText`), cut to 200 characters (`limitImportDescription`: UTF-16 code units, never inside a surrogate pair, the new end trimmed). An empty result is `empty_description`: the importer wants a text, an empty cell is almost always the wrong column. The notes are null and there are no tags.
- The **normalized description** is the cleaned text (before the cut) run through the case fold of the spendings search (`foldText`, `backend/src/lib/fold.ts`). The normalization is idempotent, so a client can send a normalized text back. It is used for the hash, and it is the one normalization of this section. The suggestions use the same normalization of the text **after the cut**, because that is the text a stored spending holds: a description longer than 200 characters would otherwise never be found again.
- **`importHash`** is the lower-case hex **SHA-256** of `importHashPreimage(date, amount, normalizedDescription, occurrence)`: the version tag `wallet-import-v1`, the date as `YYYY-MM-DD`, the amount in cents in spending sign, the normalized description and the **occurrence index**, one per line. The occurrence index of a row is how many rows **before it in the file** have the same date, amount and normalized description (0 for the first). Only rows that have a hash count: one with a valid date, a non-zero amount in range and a description, whatever its other errors, so a row's hash does not change with the start month or with what the user selects. The occurrence is counted over the whole file, not over the selected rows.
- So two identical coffees on one day both import (occurrences 0 and 1), and importing the same file again flags **every** row. A row is a **duplicate** (`duplicate: true`) when a spending with its hash is already stored (`spendings.importHash`, which is `unique`). A spending created by hand has no hash, and **editing an imported spending keeps its hash**, so the row still counts as imported. Deleting the spending frees the hash, and the row can be imported again.
- **Accepted limitation (2026-10-03):** the occurrence index is counted per file. Two statements that overlap, where the boundary falls inside a day that has repeated identical rows, can disagree about the occurrence: if the later file holds only the second of two identical coffees of that day, it is numbered 0 and looks like the first one, which was imported already, so it is flagged a duplicate and not imported. The same file imported twice, and statements that split between days, are always exact.

### Suggested budget

The Telegram bot's quick entry uses the same rule (see [Quick entry](#quick-entry)). `suggestedBudgetId` of a row is the budget **most often used by the stored spendings with the same normalized description** (every stored spending counts, with its own description normalized the same way, whatever its date and whether it was imported or entered by hand), ties broken by the **most recent use** (the latest date, then the highest id of a spending of that description in that budget), and **only when that budget is active in the month of the row's date** (`startMonth <= month <= endMonth`), otherwise null: the importer does not fall back to the second most used budget. A row with no valid date or no description has none. It reads the spendings table only (not the rows of the same file, not the budget names), so the same description always gets the same suggestion in one preview. It is a suggestion: the commit takes whatever budget the user chose.

### Preview

`POST /api/import/preview` reads the file with the mapping and returns **one result row per data row**, in file order, and counts. A row has `line`, `date` and `amount` (spending sign; null when unreadable, 0 for a zero amount), the trimmed `raw` text of the two cells, the cleaned `description`, `suggestedBudgetId`, `duplicate`, `credit` and `errors`: every code that applies, in the order `invalid_date`, one of `invalid_amount` / `zero_amount` / `amount_too_large`, `empty_description`, `before_start_month` (a date before `settings.startMonth`, like every fact). `summary` counts the rows with each property (`total`, `invalid`, `duplicates`, `credits`, and `importable`: no error, not a duplicate, not a credit). The counts overlap and are not a partition. A row with an error cannot be committed. Nothing is written.

### Commit

`POST /api/import/commit` takes `{ csv, mapping, rows: [{ line, budgetId }] }` and stores the listed rows, **all or nothing**. The checks run in this order:

1. **The shape (400)**: the body, one to `IMPORT_MAX_ROWS` rows, positive whole numbers, **no line listed twice** (at `rows.<i>.line`, the second one). Then the file: an unterminated quote, or more than `IMPORT_MAX_ROWS` data rows (400 at `csv`).
2. **The rows (422 `import_rows_rejected`)**: every listed row is checked, and all the failing ones are reported together, ascending by line, each with **every code that applies in this order**. The response's `details` is `{ rows: [{ line, errors }] }` and nothing is imported if there is one:

   | Code                    | The row                                                                                                                    |
   | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
   | `unknown_line`          | `line` does not start a data row of the file (the header, a blank line, past the end, inside a field). Alone.              |
   | `invalid_date`          | its date is not valid in the mapping's format.                                                                             |
   | `invalid_amount`        | its amount is not valid.                                                                                                   |
   | `zero_amount`           | its amount is zero.                                                                                                        |
   | `amount_too_large`      | its amount is above `MAX_CENTS`.                                                                                           |
   | `empty_description`     | its description is empty.                                                                                                  |
   | `unknown_budget`        | its `budgetId` is no budget.                                                                                               |
   | `before_start_month`    | its date is before `settings.startMonth`.                                                                                  |
   | `outside_active_months` | its budget exists and the date is not within its active months (checked only when the date is not before the start month). |
   | `duplicate`             | a spending with its hash is stored already.                                                                                |

   `unknown_budget`, `before_start_month` and `outside_active_months` are the rules of `POST /api/spendings` under the same names and in the same order (`unknown_budget`, then `before_start_month`, then `outside_active_months`): the importer must call the same check as the spendings service and not copy it. `zero_amount` and `amount_too_large` are what `POST /api/spendings` refuses as a 400 at `amount` (never 0, at most `MAX_CENTS`). A date beyond the 120-month horizon is accepted as for a spending (see [Transfers](#transfers)). A credit is not rejected: it is stored as a refund.

3. **The write (201)**: one transaction stores the rows **ascending by line**, each with its `importHash`, a null note and no tags, `createdAt` and `updatedAt` from the clock, and the duplicate check is repeated inside it. Any failure stores nothing. The response is `{ created, items: [{ line, id }] }`, ascending by line (and so by id). `created` equals the number of rows listed.

### Profiles

A **profile** is a named mapping, saved so that the next file of a bank needs no remapping (table `import_profiles`: name, the mapping as JSON, a header signature, timestamps). `GET /api/import/profiles` lists them ascending by name under the tag-name comparison, then id. `POST` creates one (201) and `PUT /api/import/profiles/:id` **replaces** it (200), both with `{ name, mapping, header? }`. `DELETE` answers 204 and touches nothing else. An unknown id is 404 (PUT, DELETE).

- The **name** is trimmed, 1 to 60 characters, and **unique under the same comparison as tag names** (case is ignored, accents are not, `Intl.Collator('en', { sensitivity: 'accent' })`, the check of `backend/src/lib/names.ts`): another profile's name is a 409 `import_profile_name_taken`, a profile never clashes with itself, and a name of invisible characters is a 400 at `name` as for a tag. Checks in order: 400 (shape), 404 (PUT), 409.
- The **mapping** is validated like a request's (`importMappingSchema`), also when stored, and read back with the same schema.
- **`header`** (the first record of the file, as `parse` returns it) gives the profile its **header signature**: each cell is normalized (see above) and kept. It is stored only when `mapping.hasHeader` is true and must reach the highest of the three mapped columns (400 at `header` otherwise). Omitted or null means no signature.
- **`suggestedProfileId`** of `parse`: the id of a profile whose signature matches the file's header, that is, for each of the profile's three mapped columns the **normalized header cell of the file at that position equals the profile's**. The mapped columns appear in the header, where the profile expects them, so the mapping applies as it was saved. Several matches: the most recently updated profile, then the highest id. A profile with no signature is never suggested.

## Backups

`GET /api/backups`, `POST /api/backups` and `GET /api/backups/:name` expose the backups of the database file (the contract is in `shared/src/backups.ts`, the schedule and the rotation are in [`PLAN.md`](./PLAN.md), Phase 7). The rules are engineering decisions (2026-10-03, not yet reviewed with the owner).

- **Consistency.** A backup is a **transactionally consistent copy** of the whole database, made with SQLite's online backup API (better-sqlite3 `db.backup()`) while the app keeps serving: it holds exactly the committed state at one moment (the one at which the copy finishes: a write made while it runs is in it completely or not at all), never half of a multi-statement write, and it needs no `-wal` or `-shm` file, because the copy is switched from write-ahead logging to the plain rollback journal, which makes it one self-contained file. It contains every table, the import profiles included, so whoever can download it can read all the data, which fits the app's trusted-network decision. The copy is written under a temporary name (`<name>.tmp`, which is not a backup name, so a half-written file is never listed or rotated), then **verified** by opening it read-only (`PRAGMA integrity_check` says `ok`, every table of the live database is there, and as many migrations are listed as applied), and only then renamed to its final name (`wallet-YYYYMMDD-HHmmss.db`, in UTC), which is atomic. A failure at any step deletes the temporary file, leaves nothing under a final name and is a 500.
- **Restoring** replaces the database file, and is done **while the app is stopped**: stop it, copy the backup over `DATABASE_PATH` (`./data/wallet.db`), **move the `wallet.db-wal` and `wallet.db-shm` files next to it away** (a cleanly stopped database has none; after a crash they hold changes that are not in the main file, and SQLite applies them to whatever `wallet.db` sits next to them: the restore is then either silently undone, or the result mixes old and restored data and still passes `integrity_check`, both observed in `e2e/tests/restore-drill.spec.ts`), start it. The migrations run at startup, so a backup from an older version is brought up to date, and one from a **newer** version than the running app is not supported. There is no restore endpoint.
- **Where.** `BACKUP_DIR` (an empty value counts as not set), by default `backups` next to the database file. With the in-memory database and no `BACKUP_DIR` there is none: `automatic` is false, `POST` is a 409 `backups_unavailable` and a download is a 404. The server creates the directory (with its parents) when it needs it, and at startup it checks that the database folder and the backup folder are writable: otherwise it exits with a message that names the path and the likely cause (permissions, a read-only disk, a path that is a file) instead of a bare SQLite error.
- **The name** is the only thing a client names, and it must be `wallet-YYYYMMDD-HHmmss.db` for a real UTC date and time, else 400 at `name`: path traversal is impossible by construction, because the pattern has no separator and the server looks the name up among the regular files it lists in the directory instead of building a path from it. A well-formed name that is not there is a 404.
- **Naming.** A backup is named after the current second of the server's clock (UTC). When that is not later than the newest backup name in the directory (two backups in the same second, or a clock that was set back) it takes the second after that name instead, so a name is **never reused**, not even one that rotation has just removed, and names keep the order of creation. `createdAt` is read from the name, never from the file's modification time. Only a **regular file** with a backup name counts: a symbolic link, a folder, a `*.tmp` file or anything else is not listed, never served and never touched by rotation.
- **Rotation** runs after every successful backup, manual ones included, and keeps the **union** of
  - the newest backup of each of the **14 most recent UTC calendar days** that have at least one backup (`BACKUP_KEEP_DAILY`), and
  - the newest backup of each of the **12 most recent UTC calendar months** that have at least one backup (`BACKUP_KEEP_MONTHLY`);

  every other backup is deleted, so at most 26 files are kept. It is decided by the names alone (no clock, no time zone, no modification time), and it counts days and months **that have a backup**, not days back from today, so a server that was off for a month loses nothing for it. A second backup on the same day replaces the older one of that day (the older one is never the newest of its month), so pressing "back up now" repeatedly does not fill the folder. The backup just made is never deleted, whatever the names say, and a file that cannot be deleted is logged without failing the backup. Rotation is idempotent: applying it to what it kept deletes nothing.

- **Automatic backups** (only with a backup directory, `automatic`). At startup, in the background (it never delays the server listening, and a failure is logged, not fatal), the server removes the temporary files a crash left behind and makes a backup when there is none or the newest is **24 hours old or more** (`BACKUP_INTERVAL_HOURS`). It then checks **once an hour** and backs up on the same rule, so with the server running there is one a day. The age is the server's clock against the time in the newest backup's name; `nextDueAt` is that time plus 24 hours (a newest backup dated in the future of the clock, after the clock was set back, waits until the clock catches up). A failed attempt is logged and tried again at the next check. The timer does not keep the process alive, and it only exists in the server process: building the app (and so every test) starts none.
- **One at a time.** Backups of a directory run through one queue shared by `POST /api/backups` and the scheduler, so overlapping requests and the scheduled one never collide, each choosing its name and rotating after the one before it. The scheduled check decides whether a backup is due when its turn comes, so one that a request just made counts. On shutdown the server stops the timer and **waits for a backup in flight** before it closes the database.
- **A backup is not a figure.** Nothing in the ledger reads it, and taking one writes no table.

## Telegram bot

A Telegram bot is a second way to enter spendings and incomes, and a channel for notifications. Only the owner uses it: one Telegram account is linked from Settings. The contract of the Settings side (the status, the pairing code, the link, the notification preferences and the test message) is in `shared/src/telegram.ts`, and the plan is [`TELEGRAM-PLAN.md`](./TELEGRAM-PLAN.md). The rules the owner agreed on 2026-10-05 are in the first table below, and a rule that repeats one of them is tagged **(owner)**. **Every other rule in this section is an engineering decision (2026-10-05, not yet reviewed with the owner)**, written down before the bot so that the bot, Settings and the tests are built to the same rules.

### Owner decisions (2026-10-05)

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

The rest of this section works these decisions out and fills in what they leave open.

### It adds no money rule

**The bot adds no money rule.** It is another way to write facts and another way to read the read models, and nothing it does changes how a figure is computed.

- **Writes go through the services.** A spending or an income that the bot stores, changes or removes goes through the same service as `POST`, `PATCH` and `DELETE` of `/api/spendings` and `/api/incomes` (`createSpending`, `updateSpending`, `deleteSpending`, `createIncome`, `updateIncome`, `deleteIncome`), never straight through the tables. So every validation and every 422 rule of this file applies unchanged (the dates, the active months of the budget, `startMonth`, the [Editing rules](#editing-rules)), and what the bot creates is an ordinary spending or income, edited and deleted like any other. The one thing the bot adds is the confirmation it asks for before a change to a closed month (below).
- **Every printed figure is a field of a read model.** Each amount, percentage and date that a message shows is a field, or a sum of fields, that the month view (`GET /api/months/:month`, see [Month states](#month-states)), the [upcoming renewals](#upcoming-renewals) (`GET /api/subscriptions/upcoming`) or the [savings](#savings) read model (`GET /api/savings`) already returns. It is taken from the service behind each (`getMonthView`, `listUpcomingRenewals`, `getSavings`) and printed as it is. The bot never computes a balance, a carry-over, a reserve, a percentage or a price itself, so a message can never disagree with the app: for the month it names, it equals the field to the cent. A figure that follows a write is read **after** the write. The table below names the field of each one, and the tests of the bot compare what it prints with that field.
- **Time** comes only from the `Clock`: the date of an entry, "today", "yesterday" and the days left in a month are the server's, in its time zone (`TZ`), as in [Month states](#month-states). The time of a Telegram message is never used.
- **Formatting.** Messages are in English, and amounts and dates are formatted with the currency and the locale of Settings **(owner)**: an amount is formatted from its integer cents and is never computed with as a float, and a date is a calendar date, written with no time-zone conversion.
- **Marks.** `alert` decides the mark wherever a budget line is printed: `warning` is `⚠️`, `over` is `🔴`, and `ok` has none.
- **Not facts.** What the bot stores (the link, the pending code, the preferences, what it created and what it sent: see [The stored data and the dedupe log](#the-stored-data-and-the-dedupe-log)) is not a fact in the sense of [Start month](#start-month). It is in no ledger figure, no CSV export and no check of `start_month_after_facts`, and it never changes a figure. It is in the backups (see [Backups](#backups)), so a restore brings the link and the preferences back.

**Where each printed figure comes from.** The month view of M is `getMonthView(M)`, and the budget's line is its element of `budgets`.

| Message                                                               | What it prints                                                  | Field it is                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Budget buttons of `/spending` and of quick entry                      | what is left                                                    | `remaining` of the budget's line in `getMonthView(current month)`                                                                                                                                                                                                                                  |
| Confirmation of a spending, and the message after an Undo or a delete | left, of, % used, the mark, "over by"                           | `remaining`, `available`, `usagePercent`, `alert` and `warnPercent` of the budget's line in `getMonthView(month of the spending)`, read after the write. "Over by" is `-remaining` of a line with `alert = over`                                                                                   |
| Confirmation of an income                                             | income and unallocated of the month                             | `income.total`, `unallocated` and `overAllocated` of `getMonthView(month of the income)`, read after the write                                                                                                                                                                                     |
| `/status`                                                             | a line per budget, and the footer                               | `remaining`, `available`, `usagePercent` and `alert` of each line of `getMonthView(current month)`, and its `unallocated` and `overAllocated`. The days left in the month are a calendar count, not money                                                                                          |
| `/recent`, `/undo`, and the first line of a confirmation              | amount, date, note, budget name                                 | the stored row as it is (`listSpendings`, the row just written): a fact, not a computed figure                                                                                                                                                                                                     |
| Budget alert                                                          | % used, left, available, "over by"                              | `usagePercent`, `remaining`, `available` and `alert` of the budget's line in `getMonthView(current month)`                                                                                                                                                                                         |
| Renewal reminder                                                      | date, days away, price, set aside, not covered                  | `date`, `daysUntil`, `amount`, `reserved` and `unreserved` of `UpcomingRenewalDto` (`listUpcomingRenewals`), never `nextRenewalPrice`                                                                                                                                                              |
| Monthly recap                                                         | spent, left over, over, carried, due to savings, settled or not | `totals.spent` and `totals.remaining`, the lines with `alert = over` (by `-remaining`), the sum of `carriedOut` over the lines, `savingsDue.total`, all of `getMonthView(M − 1)`, and that month's entry in `outstanding` of `getSavings` (`settled`, `outstanding`, `direction` and `adjustment`) |

### Connection and configuration

- **Off unless configured** **(owner)**. The bot runs only when `TELEGRAM_BOT_TOKEN`, the token @BotFather gives, is set to a non-empty value in the environment file. Without it the bot is off and nothing else in Wallet changes: Settings says so, nothing is sent, and every other endpoint behaves as before.
- **Long polling** **(owner)**: the server calls Telegram and Telegram never calls the server, so Wallet stays on the private network and opens no port. At start the bot removes any webhook (`deleteWebhook`), asks who it is (`getMe`), registers its command list (`setMyCommands`, the commands of `/help`), and then polls for messages and button taps only (`allowed_updates` is `message` and `callback_query`).
- **Failures** never reach the rest of Wallet. A network error or a 409 conflict (another program polls with the same token) is retried with a growing delay, from 30 seconds up to 5 minutes, and Settings shows `unreachable` or `conflict`. A 401 stops the bot until the server restarts (`invalid_token`), and so does a 404, which is what Telegram answers to a token that is not even well formed. A 403 "blocked by the user" on a message to the linked chat shows `blocked` while polling goes on, and a message that goes through afterwards (or one from the owner, which the bot answers) clears it: a `blocked` bot still tries the test message of Settings, because that is how it finds out.
- **Same process.** The server starts the bot after it listens, only when the token is set, and stops it on shutdown before it closes the database. Building the app, and so every test, never starts it: the tests give the routes a fake in its place.
- **Other variables.** `TELEGRAM_API_ROOT` (default `https://api.telegram.org`) is only for tests, which point it at a fake Bot API. `APP_URL`, the address of the app as the phone reaches it, adds "Open" links to some messages, which are left out when it is not set.
- **One running Wallet per token.** Two programs that poll the same token get conflicts and take each other's messages. A development instance uses a bot of its own.

### Linking and access

- **One account, one-time code** **(owner)**. At most one account is linked, from Settings → Telegram. `POST /api/telegram/pairing` creates the code: 8 characters from an alphabet without the look-alikes `0`, `O`, `1` and `I`, single use, valid for 10 minutes (409 `telegram_not_configured` without a token). A new code replaces a pending one, and `DELETE /api/telegram/pairing` cancels it (204, also when none is pending). Settings shows the code and an **Open in Telegram** button, the link `https://t.me/<bot>?start=<code>`, which sends `/start <code>` by itself (`deepLink`, null until the bot has told its username). `GET /api/telegram` reports a code as pending until it is used, replaced or cancelled, and not any more once it has expired.
- **Linking.** The bot links the sender when `/start <code>` arrives with a valid code **in a private chat**. A group, a supergroup or a channel never links. The link keeps the Telegram user id, the chat id, the first name, the username (an account may have none) and the time it was made, and everything the bot sends goes to that chat.
- **Re-linking** while an account is linked replaces it once the new code is used, and Settings asks the owner to confirm first. **Unlinking** (`DELETE /api/telegram/link`: 204, and 404 `not_found` when nothing is linked) removes the link, again behind a confirmation in Settings, and keeps the notification preferences. When a link is removed or replaced by another account, the bot sends a best-effort "This chat is no longer linked to Wallet" to the old chat, and a failure to send it changes nothing.
- **Wrong codes.** While a code is open (created and not yet used, replaced or cancelled, whether it has expired or not), `/start <wrong code>` from a private chat gets "Invalid or expired code." A wrong code, and the right one after it has expired, counts as a failed attempt, and after **5 failed attempts, from any senders**, the pending code is cancelled. While no code is open the bot says nothing, like to any other stranger, except to the linked user, whose `/start <anything>` is then `/help`. A message from a group, a supergroup or a channel is ignored whatever it says and is not counted as a wrong code, and a bare `/start` from a stranger is no code, so it is ignored and not counted either.
- **Everyone else is ignored** **(owner)**. Every update that does not come from the linked user in a private chat is ignored **without a reply**: the bot stays silent, so a stranger can't even tell what it is. The only answer a stranger can get is the one to a wrong code above. The check is on the sender's id (`from.id`) and the chat type, for every message and every button tap, and the stored user id is the only one it accepts, so the linked user writing in a group is ignored too.
- **On link** the bot greets with `/help` and records the **baseline** of the alert levels (see [Budget alerts](#budget-alerts)).

### The `/spending` flow

The flow is budget, amount, note, date, saved **(owner)**, and it has no tags step **(owner)**. The bot's "note" is the spending's `description` (it never sets `notes`), so it is 0 to 200 characters like every description.

1. **Budget.** The budgets active in the **current** month, in the order of the month view (`sortOrder`, then id), two per row. A button shows the budget's icon when it has one, its name (cut at about 24 characters) and that month's `remaining`, which can be negative. `[✖ Cancel]` closes the flow. With no active budget the bot answers "No active budgets this month. Add one in the app."
2. **Amount.** `12.50`, `12,50`, `€12.50`, `12.50€` and `-5` are accepted. The amount is read with `parseCents`, after dropping one currency symbol before or after the number: `€` always, and the symbol of the currency in Settings (read from `Intl`, so `$` for USD) and no other, so that an amount in another currency (`£12.50`, `12.50 $`) is refused and never stored as if it were in the currency of Settings (engineering decision, 2026-10-05). A space ends the amount (`1 2` is 1 with the note "2"), and a number with a thousands separator (`1 234,50`) is refused, never read as 1 with a note: a whole number of up to three digits followed by a note that starts with exactly three digits is refused whatever follows those digits, so `1 234,50`, `1 234,50€`, `1 234€`, `1 234,50EUR` and `1 234.567` are refused, and so is `5 200ml` (a safe refusal; engineering decision, 2026-10-05). The amount is never 0. A negative amount is a refund. Text after the number is the note, and then step 3 is skipped **(owner)**. Anything else gets a re-prompt that gives an example. So does an amount above `MAX_CENTS` and a note of more than 200 characters (the bot never cuts a note), and nothing is stored.
3. **Note.** Free text, or `[Skip]` for an empty description **(owner)**.
4. **Date.** `[Today] [Yesterday] [Earlier…]` **(owner)**. Only the **last 7 days** are offered, today and the 6 days before, and an older date goes through the web app **(owner)**. `Earlier…` swaps in one button per day from 2 to 6 days ago (`Wed 30`, …). A day before the first day of `settings.startMonth` is not offered. Each button carries its **explicit date**, so a button tapped after midnight saves the date it showed.
5. **Closed month.** A date in a closed month (see [Month states](#month-states)) asks first: "September is closed. Adding this changes what is due to savings for September. [Save] [Other date]". This is the confirmation that the [Editing rules](#editing-rules) ask of a spending or an income added to a closed month ("the UI confirms them"), given as a button and not as a notice. `[Other date]` returns to the date step. **The effect is worded by the budget's mode in that month** (engineering decision, 2026-10-05, not yet reviewed with the owner), read from the budget's line of the month view: the sentence above holds where the budget settles with savings (the line is not `incremental`, or the month is its `endMonth`: `remaining` goes to `toSavings`, see [Budgets](#budgets)), and where it carries its remainder on (the line is `incremental` and not `endsThisMonth`: `remaining` is `carriedOut`, and that month's `savingsDue` does not move) the effect is followed month by month: the carry goes on for as long as the budget's line of each later month carries on, and **stops at the first later month that does not** (the line is not `incremental`, or is its `endsThisMonth`, or the budget has no line), where the remainder goes to `toSavings` and that month's `savingsDue` moves. If that month is closed the question names it, even though the action was dated earlier ("August is closed. Removing this changes what is due to savings for September."), and if every month up to the one before the current month carries on, the effect reaches the current month and the question reads "September is closed. Adding this changes what Fuel carries forward from September." The walk reads one month view per month, at most 60 months back, and past that it takes the carry to reach the current month. When the action touches several closed months in different modes the effects are named together. An income only ever moves its own month's savings due.
6. **Saved.** The bot calls `createSpending` and shows [the confirmation](#the-confirmation). A 422 from the service becomes a sentence and a way back to the step that can fix it: `outside_active_months` returns to the date step ("Groceries isn't active in September"), `unknown_budget` (the budget was deleted meanwhile) returns to step 1 (a budget that is no longer active this month is refused the same way when it is tapped), where the amount and the note are kept, so the next budget goes straight to the date step, and `before_start_month` returns to the date step.

### The confirmation

```
✅ €23.40 · Groceries · Lidl · Mon 5 Oct
Groceries: €164.10 left of €300.00 (45% used)
[↩ Undo] [📅 Change date]
```

- The first line is the stored spending: amount, budget, note (left out when empty) and date.
- **The figures** are the budget's line in `getMonthView(month of the spending)`: `remaining`, `available` and `usagePercent`, read **after** the write. They show what is left of the budget in the spending's month, the % used, and the mark **(owner)**. A spending in a closed month says so: "Groceries in September (closed): …". When that budget carries its remainder on in that month (step 5), the effect lands where the carry ends, so a second line follows with the budget's line of THAT month (`remaining`, `available`, `usagePercent`, `alert`): the first later month that does not carry on, a closed month where it settles with savings ("Fuel in September (closed): …"), or else the current month ("Fuel in October (this month): …"), as step 5 walks it. Both lines are fields of their month view, and the alert level of each, in its own month, is what the bot records as shown (engineering decision, 2026-10-05, not yet reviewed with the owner). The same two lines follow an Undo or a delete.
- **The mark.** `alert` decides it: `warning` adds `⚠️` and "(81% used, warning at 80%)", where 80 is the line's `warnPercent`, and `over` adds `🔴 Over by €12.40`, which is `-remaining`. When `available <= 0` there is no percentage (`usagePercent` is null), as in the app.
- **A refund** reads "↩ Refund €5.00 · Groceries".
- **Undo** deletes that spending if it still exists and answers "Removed" with the budget's new figure, read after the delete. If it is dated in a closed month it asks first, worded as in step 5. If it was already deleted on the web it answers "Already removed."
- **Change date** offers the same 7 days in one keyboard, then calls `updateSpending({ date })` and rewrites the confirmation with the new figures. It asks first, like adding does, whenever the edit changes a closed month: the old and the new date are in **different** months and one of them is closed (the spending leaves one, or goes into one). The question names each closed month and its effect, as in step 5. A move inside one month, closed or not, changes no figure of any month and asks nothing (engineering decision, 2026-10-05, not yet reviewed with the owner). A 422 (`outside_active_months` when the budget is not active on that day, for example) becomes a sentence and a way back to the date choice.
- **A confirmed tap asks again when it must.** `[Save]`, `[Delete]` and `[Remove]` work out the closed months again when the tap is processed (the `Clock` of that moment, the row as it is then) and ask once more if one is closed that the question did not name: the month ended while the question was on screen, or the row was moved into a closed month on the web (engineering decision, 2026-10-05, not yet reviewed with the owner).
- **When the confirmation cannot be shown.** The write has happened, so the bot never says that nothing was changed. If Telegram refuses the edit and the new message, it says what happened ("Saved, but I couldn't show the confirmation. /recent lists it.", "Moved, …", "Removed, …"), and where even that cannot be sent it logs it.
- **Before it is sent**, the levels the confirmation shows are recorded as notified (see [Budget alerts](#budget-alerts), "No duplicates"): the bot reads the month view after the write, records the levels at once, and only then sends, so that a check that runs while the message is in flight does not announce the same level again. That record is **provisional**: when the confirmation is not delivered at all (Telegram refuses the edit and the new message), the bot puts each level back to what it was before it recorded it, only for a record that still holds the value it wrote, and asks for a check, so the alert is announced when Telegram answers again. The "Saved, but …" text carries no level, so it does not count as the confirmation (engineering decision, 2026-10-05, not yet reviewed with the owner).
- **A button names its row by id and fingerprint.** These buttons act on the **stored row**, not on a flow, so they carry the row's id and keep working after a restart. An id is not reused while the database lives (`AUTOINCREMENT`), but restoring a backup brings the id counter back, and a new row can then get the id of a row the chat still has a button for. So a button also carries the row's **fingerprint**, its `createdAt` in milliseconds in base 36: it is set once and never edited, so it survives every edit on the web, and another row under the same id was created at another time. This **assumes that the clock does not repeat a millisecond** between the row a restore took away and the new row that got its id: a restore always takes time (the server is stopped, the file copied, the server started, and only then is something entered), so on a real clock the two are seconds or minutes apart. Two rows created in one millisecond, as a test with a frozen clock makes them, have one fingerprint, and then nothing in the row tells them apart (`createdAt` is the only column an edit cannot change). A button whose fingerprint is not the stored row's answers "Already removed.", takes its keyboard away and changes nothing (engineering decision, 2026-10-05, not yet reviewed with the owner).

### Quick entry

- A text message that reads as an amount, with an optional note after it (the reading of step 2 above), and is no command, starts a quick entry when no flow is waiting for text **(owner)**. `4,50 coffee`, `12.50` and `-5 refund` start one. `0 coffee` and `coffee 4` don't, and get the pointer to `/help`.
- It asks for the budget as step 1 does, and puts the **suggested budget** first, marked `⭐` **(owner)**. That is the [import's rule](#suggested-budget): the budget most used by the stored spendings with the same normalized description, if it is active in the month of the date the spending will get (today). The suggestion comes from `loadSuggester`. With no note, or no suggestion, the order is the usual one.
- One tap on a budget saves the spending **dated today**, which is the `Clock`'s date **when the tap is processed** **(owner)**, and shows [the confirmation](#the-confirmation) with Undo and Change date **(owner)**. There is no note step and no date step, and nothing is stored before the tap. Change date fixes a spending typed the night before.

### The `/income` command

An income goes amount, description, date, with the same date buttons **(owner)**. The amount is positive only (a zero or a negative one gets a re-prompt). The description is required, 1 to 200 characters as in the web form, so there is no Skip, and text after the amount fills it. The date step has the same buttons and the same closed-month confirmation as `/spending`, and then the bot calls `createIncome`.

The reply is "✅ Income €200.00 · Bonus · Mon 5 Oct", followed by the `income.total` and the `unallocated` of the income's month, read after the write (with `⚠️` when `overAllocated`, as the UI must warn, see [Unallocated](#unallocated)), and the buttons Undo and Change date. Undo calls `deleteIncome` and Change date calls `updateIncome({ date })`. Both confirm in a closed month exactly as for a spending, and a deleted income answers "Already removed."

### The `/status` command

One line per active budget of the current month view, for example `🛒 Groceries · €164.10 left of €300.00 (45%)`, with the marks `⚠️` and `🔴` of `alert`, and no percentage when `usagePercent` is null. The footer reads `26 days left in October · Unallocated €320.00`, with `⚠️` when `overAllocated`, and a link to the app follows when `APP_URL` is set.

The days left are the days after today up to the last day of the month (the month's last day minus today's day, from the `Clock`), so on 5 October there are 26. On the last day the footer says "Last day of October" and on the one before it "1 day left".

### The `/recent` and `/undo` commands

- `/recent` lists the last 10 spendings **from any source** (`listSpendings`, newest first), numbered, with the buttons `[🗑 1] … [🗑 10]` in rows of five. A tap asks "Delete €12.50 · Groceries · lunch (Sat 3 Oct)? [Delete] [Keep]", and after deleting the bot shows the budget's new figure, read after the delete. The buttons carry the spending's id and its fingerprint (see [The confirmation](#the-confirmation)), so a list that has gone stale, or a backup that was restored, never deletes another row, and a spending already deleted answers "Already removed."
- `/undo` takes the **latest spending or income created from Telegram** that still exists (the entries the bot keeps, see [The stored data and the dedupe log](#the-stored-data-and-the-dedupe-log)), shows it as it is now, and asks `[Remove] [Keep]`. It always asks, because it acts on something that is not on screen. Repeating it takes the next latest. With nothing to undo the bot says so.
- Both ask first, always, and when the row is in a closed month the question names the month and what changes in it (step 5 of [the `/spending` flow](#the-spending-flow)), as for Change date. The answer `[Delete]` or `[Remove]` asks again if a month has closed since that the question did not name.

### Commands, cancel and stray input

- **The commands** are `/spending`, `/income`, `/status`, `/recent`, `/undo`, `/cancel` and `/help` **(owner)**. `/start <code>` is the one that links (see [Linking and access](#linking-and-access)).
- `/cancel` ends the flow in progress and removes its keyboard. With none in progress it says so.
- `/help` lists the commands. The same list is registered with `setMyCommands` at startup, so Telegram shows it in its menu. `/start` from the linked user answers like `/help`.
- A button of a finished or expired flow answers "This entry expired, start again with /spending", a callback toast, and removes its keyboard.
- Text sent while a flow is waiting for a button cancels that flow ("Previous entry cancelled"). The text is then handled from scratch, as a quick entry or a command.
- A command is never an answer to a step. While a flow waits for text, a command ends the flow with the same "Previous entry cancelled" (`/cancel` has its own reply) and then runs.
- Unknown commands and other text get a short pointer to `/help`.

### Flow state

- A flow lives in memory, one per chat, keyed by chat id, with a 15-minute timeout counted from its last step. Starting another flow replaces the one in progress. Each flow has a short id, which the `callback_data` of its buttons carries (well under Telegram's limit of 64 bytes), so a stale button is detected.
- A restart loses only a flow in progress. Nothing has been written until its last step.

### Notifications

- Notifications go to the linked chat and are switched in Settings **(owner)**: **budget alerts**, **renewal reminders** and the monthly **recap**. `PUT /api/telegram/notifications` replaces five preferences: `budgetAlerts` and `monthlyRecap` (on or off), `renewalYearlyDays` and `renewalMonthlyDays` (whole days from 0 to 30, 0 turning that reminder off), and `notifyAt` (strictly `HH:MM`, 24-hour, in the server's time zone). The defaults are on, 7, 1, on and `09:00` (`DEFAULT_TELEGRAM_NOTIFICATIONS` in `shared/src/telegram.ts`): 7 days before a yearly renewal and 1 day before a monthly one are the owner's choice **(owner)**, the notify time and the range are not. They can be saved with no link and no token, and unlinking keeps them.
- Nothing is sent while no account is linked, or while the bot is not running.
- **Logged, sent once, retried when it fails.** Every notification is logged (see [The stored data and the dedupe log](#the-stored-data-and-the-dedupe-log)), and its row is written only **after** Telegram has accepted the message. A message that fails is therefore tried again at the next tick and never lost, and one that was sent is not repeated. The one gap is a stop in the instant between Telegram's acceptance and the row, which can send that message a second time, the price of never losing one. The baseline below writes rows without sending anything.

### Budget alerts

A budget alert is sent when a spending, **from any source (web, import or bot)**, takes a budget to a higher alert level **(owner)**.

- **When it fires.** For each budget of the **current** month the bot remembers the highest alert level it has notified this month (`ok` < `warning` < `over`; a budget with no record counts as `ok`). When the month view shows a higher level, it sends **one message for every budget that went up** in that check. A budget that goes straight from `ok` to `over` gets the message for `over`:
  - `⚠️ Groceries: 84% used, €48.00 left of €300.00`
  - `🔴 Eating out is over by €12.40`
- **No flapping.** A level that goes down (a refund) sends nothing and does not lower what was notified. Rising again to a level already notified this month sends nothing either.
- **When it checks.**
  - After every successful mutating `/api` request (a `POST`, `PUT`, `PATCH` or `DELETE` that answers below 400), debounced by 2 seconds, so that a CSV import commit sends one message and not one per row.
  - After every write by the bot.
  - On every scheduler tick, as a safety net (for what the other two miss, such as a change of the warning threshold in Settings).
- **The debounce** is counted from the **last** request that asked for a check, so a burst of writes is one check. Only one check runs at a time: a request that arrives while one is running makes it run once more when it ends, so a write that came in during the run is never missed. A request to `/api/telegram` itself does not ask for a check (it changes the bot, not a figure).
- **No duplicates.** A level that the bot's own confirmation already showed counts as notified, so the alert is not sent twice. That row is written at once, because nothing is sent, and it is written **before** the bot sends the confirmation, so that a check running while the message is in flight does not announce it too. It is **provisional**: if the confirmation never reaches the user, the bot puts the row back as it was (see [The confirmation](#the-confirmation)), and the next check announces the level. One race is known and accepted (engineering decision, 2026-10-05, not yet reviewed with the owner): when a real alert for the same level is in flight at the very moment of a bot write, and that write's confirmation then fails on every send, the row is put back and the next check announces the level once more, so the owner can see one duplicate alert. It never shows a wrong figure and never loses an alert.
- **Baseline.** Linking, and switching `budgetAlerts` on, record the current levels without sending anything, so the first check afterwards does not flood the chat with budgets that were already over. Both record every budget of the current month, `ok` ones included, and neither ever lowers a level that is already recorded.
- **Only when it can be sent.** A check does nothing, and records nothing, while `budgetAlerts` is off, no account is linked or the bot is not `running`. Once all three hold, the budgets that are up are announced at the next check, so nothing is lost for having been offline.
- **A message that is not accepted** stops the check there: the budgets after it wait for the next check, and the ones before it, already sent and recorded, are not repeated.
- A new month starts with no record. A budget that begins it over (an incremental budget that carried a deficit in) is therefore announced once, at the **first check at or after the notify time** (`notifyAt`) of the month, and not at the turn of the month, so that the owner's phone does not buzz at 00:01. The test is on two fields of the budget's line in the month view: a budget that is at `warning` or `over` and whose `spent` is 0 (net of refunds) and `transfersNet` is 0, so that no spending and no transfer dated in the month put it there. A carried-in `warning` cannot happen (a warning needs something spent: `warnPercent` is at least 1), so in practice this is a budget that is `over`. Until the notify time such a budget is skipped and **no row is written for it**, so nothing is lost: the first check at or after the notify time announces it, and so does the first tick after a server that was off at that time comes back. A spending, a refund or a transfer dated in the month gives the alert a cause, and it is announced at once, whatever the time. Every other alert is announced at once, at any hour. The test looks at those two fields only, so it cannot tell a deficit that was carried in from an edit of what the budget has: an allocation or mode changed for the month, or a late spending added to the month before, made in the early hours and taking the budget over, is announced at the notify time too (delayed, not lost). The simpler rule was chosen over trying to find such an edit, because nothing in the month view dates one.

### Renewal reminders

A reminder tells about a subscription renewal ahead of time: **yearly ones 7 days before, monthly ones 1 day before, both adjustable** **(owner)**.

- **What is reminded.** The bot reads `listUpcomingRenewals({ days })`, where `days` is the larger of the two leads (when both are 0 it reads nothing), and reminds about each renewal whose `daysUntil` is at most the lead of its frequency: `renewalYearlyDays` for a yearly one, `renewalMonthlyDays` for a monthly one. 0 turns that frequency off, and the range is 0 to 30.
- **When.** Once a day, at the notify time (`notifyAt`, default `09:00`, in the server's time zone). Concretely, every tick at or after that time of the day reminds each renewal that is within its lead and has no row in the log yet. There is no "ran today" mark, so the same rule catches up a missed day, and a lead raised after the notify time reminds at the next tick.
- **Once.** Each renewal is reminded once, keyed by `(subscriptionId, billingDate)`.
- **Catch-up.** If the server was off at the notify time, the reminder goes out at the next tick, as long as the billing date has not passed (the list starts at today). All the renewals that are due in one run share **one** message:

```
🔔 Renewals
Netflix · tomorrow (Tue 6 Oct) · €13.99
Domain · in 7 days (Mon 12 Oct) · €15.00 · set aside ✅
Insurance · in 6 days (Sun 11 Oct) · €480.00 · €400.00 set aside, €80.00 not covered
```

- **Where each figure comes from.** The price, `reserved` and `unreserved` come from `listUpcomingRenewals` (`amount`, `reserved`, `unreserved`), never from `nextRenewalPrice` (see [Upcoming renewals](#upcoming-renewals)). `daysUntil` 0 reads "today", 1 "tomorrow", and n "in n days". A yearly renewal reads "set aside ✅" when `unreserved` is 0, and otherwise the two amounts, as in the last line above. A monthly one (`reserved` is null) says nothing about it.
- **A long list** (more than Telegram's limit of 4096 characters in one message, which takes dozens of renewals) is sent as several messages in the order of the list, the later ones headed "🔔 Renewals (continued)". Each renewal is logged once the message that names it was accepted, so a failure of the second message leaves the first one's renewals logged and sends only the rest at the next tick. A message that is not accepted stops the pass there.

### Monthly recap

A recap of the month that just closed is sent on the 1st **(owner)**.

- **When.** At the first tick on or after the notify time on any day of the month M, it recaps M − 1, once per recapped month. Normally that is the 1st, and a recap that was missed (the server was off) goes out on a later day of M and never after M ends.
- **Only for months that ended after the link.** It is sent only when the account was linked before M began (the `linkedAt` of the current link, so linking another account starts again), and M − 1 is not before `startMonth`. Linking in the middle of M does not trigger a recap of the month before.
- **The figures** are from `getMonthView(M − 1)` and `getSavings`:

```
📅 September 2026 is closed
Spent €1,820.00 · €280.00 left over
🔴 Over: Eating out by €42.00, Fuel by €12.40
↪ Carried into October: €180.00
💰 Due to savings: €630.00 · not settled yet   [Open savings]
```

- **Where each figure comes from.**
  - "Spent" and "left over": `totals.spent` and `totals.remaining`. The second is the sum as the month view gives it, so a budget that is over lowers it.
  - "Over": the lines with `alert = over`, each by `-remaining`. The line is left out when no budget is over.
  - "Carried": the sum of `carriedOut` over the lines.
  - "Due": `savingsDue.total`. A positive total reads "Due to savings", a negative one "To take from savings", with its absolute value, as the savings inbox words a `direction` (see [Outstanding months](#outstanding-months)). What follows it is the first of these that holds, with `entry` the month's entry in `outstanding` of `getSavings`:
    - `entry` exists and its `adjustment` is false (no settlement was made): " · not settled yet".
    - `entry` exists and its `adjustment` is true (the month has settlement rows, so it was settled before and a later edit, such as a forgotten spending, moved what it is due; the savings inbox shows a "Correction" for it, see [Outstanding months](#outstanding-months)): what was settled, in words and with no sign, and what is still to do, worded as the inbox words a correction. `settled` is worded "already moved to savings" when it is positive and "already taken from savings" when it is negative (its absolute value), then comes `move` or `take` by `direction`, the absolute value of `outstanding`, and "more to savings" or "more from savings". For example, September moved to savings for 600.00 and then a forgotten 30.00 spending dated in it: `💰 Due to savings: €570.00 · €600.00 already moved to savings, take €30.00 more from savings`. A month that was settled for 200.00 taken from savings, with 30.00 more to take: `💰 To take from savings: €230.00 · €200.00 already taken from savings, take €30.00 more from savings`. When the earlier settlements cancel out (`settled` is 0 although the month has settlement rows) it reads " · settled before, move €30.00 more to savings". The total alone ("not settled yet" over 570.00) would hide that 600.00 already moved.
    - no `entry` and `savingsDue.total` is not 0: " · settled".
    - otherwise nothing (`savingsDue.total` is 0 and nothing is outstanding).
  - The button appears only when `APP_URL` is set: **Open savings**, a link to `APP_URL/savings`. If Telegram answers **400** to the message with the button (it does not accept every address), the recap is sent once more without it, so that it is never lost over a link. Any other failure (a timeout or other network error with no answer, a 429, a 5xx, a 403) is not sent a second time: the first message may have gone out, so the recap waits for the next tick with its button and no dedupe row, and arrives once.
  - "Left over" is the total as it is. When `totals.remaining` is negative (the month was overspent as a whole) the line reads "€40.00 over" (its absolute value) instead of a negative "left over".
  - The "Carried" and "Due" lines are always there (`€0.00` when nothing is carried or due), and the marker after "Due" is the first of the four rules above that holds, in the order written.
  - A list of budgets that are over too long for Telegram's 4096 characters is cut and ends with "and N more".

### The scheduler

- One timer ticks every minute and does not keep the process alive (the pattern of the backup scheduler, see [Backups](#backups)). Each tick runs the alert check, then the renewals and the recap when they are due.
- A tick never throws: it logs and leaves the rest to the next tick, and a step that fails does not stop the ones after it. A tick that finds the previous one still running is skipped (it returns at once and does nothing), so a tick that waits on a slow Telegram never piles up.
- The first tick comes one interval after the scheduler starts, not at start: right after the bot starts it is still connecting and could send nothing yet.
- It offers a way to run one tick and a way to stop, for the tests and for shutdown. Stopping drops an alert check that has not started and waits for the tick in flight and for an alert check that is running, so that the database is not closed under them. It only exists in the server process.

### The stored data and the dedupe log

The tables of the bot, created by migration `0003_telegram`, hold no fact (see above). All of them are in the backups.

| What                 | Holds                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The link             | One row at most: the Telegram user id and chat id, the first name, the username and when it was linked.                                                                                                        |
| The pending code     | One row at most: the code, when it expires and how many wrong codes were tried.                                                                                                                                |
| The preferences      | One row, created by the first save (until then they read as the defaults). Unlinking keeps it. They live apart from the settings, because `PUT /api/settings` replaces exactly five fields and stays as it is. |
| What the bot created | For `/undo`: one entry per spending or income the bot stored, with the time. Exactly one of the two is set, and deleting the spending or the income removes its entry.                                         |
| The dedupe log       | One row per notification, unique by kind and key (below).                                                                                                                                                      |

| Kind           | Key                              | Value                      | It means                                                                  |
| -------------- | -------------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| `budget_alert` | `<month>:<budgetId>`             | the highest level notified | what a budget was announced at this month, and what the baseline recorded |
| `renewal`      | `<subscriptionId>:<billingDate>` | none                       | that this renewal was reminded                                            |
| `recap`        | `<month>`, the month recapped    | none                       | that this month's recap was sent                                          |

### Security and privacy

- **The bot is the only way into Wallet from the internet**, and it only ever talks to the one linked account. Strangers get no reply at all (see [Linking and access](#linking-and-access)), and pairing codes are short-lived, single use, and cancelled after 5 wrong tries.
- **The token never leaves the server.** It is in no endpoint, no frontend, no backup and no log. Every bot error that is logged goes through a redaction first, because the URLs of the Bot API contain the token, and a test checks that nothing logged contains it.
- **Telegram sees what goes through it.** Bot chats are not end-to-end encrypted, so budget names, amounts and notes are stored on Telegram's servers. The README says so plainly.
- **Groups are refused**, and the README tells the owner to turn off "Allow Groups" in BotFather.

### Edge cases

- **Midnight between steps.** The date buttons carry explicit dates, and quick entry takes the `Clock`'s date when the budget is tapped.
- **Messages queued while the server was down** (Telegram keeps them for 24 hours) are handled when it comes back and dated the day they are handled, never the day they were sent. The confirmation always shows the date, and Change date is one tap.
- **The budget changed between steps.** It was archived, deleted, or is not active on the chosen date: the service's 422 becomes a message and a way back (step 6 of `/spending`).
- **Undo after an edit on the web.** It deletes the spending as it is now, and the message shows its current values.
- **Many budgets.** Two per row (Telegram allows 100 buttons). Long names are cut on the button and kept whole in messages, and every name and note is escaped for Telegram's HTML formatting, so a name like `<b>&` is shown as typed.
- **A restored backup** brings the link and the preferences back. With the token of another bot, the owner links again from Settings: the stored user id stays the only one the guard accepts.
- **Two instances, one token**: Settings shows `conflict`, and the app itself is unaffected.

### Not in the bot

Tags, receipt photos, voice, transfers, settling savings, several people, a webhook mode, quiet hours, and a daily or weekly digest. Each can be added later on the same runtime, and each would need its rules written here first.
