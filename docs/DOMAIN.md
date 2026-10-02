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

"Today" comes from the backend clock in the server's time zone (`TZ` env). Nothing before `settings.startMonth` is computed or accepted.

There is **no stored "close month" step**. Every month's figures are computed from the stored facts (salary history, incomes, subscriptions, budgets, spendings, transfers). Because of that, a late edit to a closed month simply changes that month's savings due, and the difference shows up as an outstanding adjustment (see [Savings](#savings)).

## Versioned values

Salary, budget amount/mode and subscription price are stored as rows that are _effective from_ a month. The value for month M is taken from the latest row with `effectiveMonth <= M`. Editing one of these values upserts a row at the chosen month, which defaults to the **current month**, so closed months never change by accident. Backdating is allowed, but only when the user explicitly asks for it.

New budgets and subscriptions also default `startMonth` to the current month.

## Income

```
salary(M)  = amount of the salary_changes row effective at M (0 if none)
income(M)  = salary(M) + Σ incomes dated in M
```

## Subscriptions (fixed costs)

A subscription is active in M when `startMonth <= M <= endMonth` (a null `endMonth` means it never ends). Cancelling sets `endMonth`. `price(S, M)` comes from `subscription_prices`.

The **billing day** is the day of `anchorDate`, clamped to the length of the month (31 becomes 30 in April, and 28 or 29 in February).

**Monthly** subscriptions cost `price(S, M)` in every active month.

**Yearly** subscriptions renew in the month-of-year of `anchorDate`. Each yearly subscription has a **reserve** that starts at 0 in its `startMonth`. For each active month M:

```
N            = first renewal month >= M that is <= endMonth   (none → contribution 0)
p            = price(S, N)
monthsLeft   = N − M + 1
contribution = max(0, ceilDiv(p − reserveBefore(M), monthsLeft))
reserve     += contribution
if M == N:   reserve −= p                                     (the renewal is paid)
```

- The reserve reaches exactly `p` in the renewal month. Ceiling division never falls behind, and the last month tops it up exactly.
- If the reserve is still positive after a renewal (the price dropped), or at `endMonth` with no renewal left, it is **released**: that amount is added to M's savings due and the reserve goes back to 0.
- If a subscription renews in its own `startMonth`, the full price is charged in that month.

```
fixedCosts(M) = Σ monthly prices + Σ yearly contributions        (over active subscriptions)
```

**Example: 120.00/year renewing in March, added in October.** October to March is 6 months, so the subscription costs 20.00 per month, and the March renewal is paid from the 120.00 reserve.

**Example: 100.00/year with 12 months to go.** The contributions are 8.34 × 4, then 8.33 × 8, which adds up to exactly 100.00.

## Budgets

A budget is active in M when `startMonth <= M <= endMonth`. Archiving sets `endMonth`. `version(B, M)` gives `amount` and `incremental`.

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

For the current month, `carriedOut` is projected as if the month ended today. Future months use that projection.

**Alerts**: `usage = spent / available`. A budget shows a warning at `usage >= alertWarnPercent` (budget override, else settings, default 80%). It is **over budget** when `spent > available`.

## Transfers

A transfer moves an amount between two budgets, or between a budget and the month's **unallocated pool** (the null side). Its date decides its month. Budget-to-budget transfers don't change any month total. They only move money between the two budgets.

## Unallocated

```
unallocated(M) = income(M) − fixedCosts(M) − Σ allocated(M)
                 − Σ pool→budget transfers in M + Σ budget→pool transfers in M
```

A negative value means the month is **over-allocated**, and the UI must warn about it. When M is closed, `unallocated(M)` goes to M's savings due, whether it is positive or negative.

## Savings

```
savingsDue(M)  = unallocated(M)
               + Σ remaining of budgets settled to savings in M
               + Σ subscription reserves released in M
settled(M)     = Σ savings_transactions with kind = 'settlement' and settlesMonth = M
outstanding(M) = savingsDue(M) − settled(M)                (closed months only)
```

The **move to savings** list shows every closed month with a non-zero `outstanding`. A positive amount means "move X to savings". A negative amount means "take X from savings". Marking a month as done creates settlement transactions that sum to `outstanding`, optionally split across goals. A forgotten spending added later makes `outstanding` non-zero again, and it shows up as an adjustment.

`savings_transactions` record money that actually moved:

- `opening`: the savings balance when tracking started.
- `settlement`: settles a month's due amount.
- `deposit` / `withdrawal`: manual money in or out, for example paying for the holiday from its goal.
- `reallocation`: moves money between goals (or between a goal and unassigned savings) as a pair of rows that sum to 0.

```
savingsBalance = Σ all savings_transactions
goalBalance(G) = Σ rows with goalId = G
unassigned     = Σ rows with goalId null
```

A goal has a `targetAmount` and an optional `deadline`. Progress is `goalBalance / targetAmount`. When a deadline is set, the UI also shows the monthly amount needed to reach the target in time.

## Invariants (enforced by tests)

1. **Per budget, per closed month:** `carriedIn + allocated + transfersNet − spent = carriedOut + toSavings`.
2. **Conservation, from startMonth to any closed month M:**
   `Σ income = Σ spendings + Σ subscription charges paid + Σ savingsDue + Σ incremental carriedOut(M) + Σ subscription reserves held at end of M`.
   Every cent of income is either spent, sent to savings, or still held in a budget or reserve.
3. **Exact splits:** the yearly contributions for one renewal cycle sum exactly to the price.
4. **Determinism:** computing any month twice from the same facts gives identical results, and results don't depend on the order of rows.

## Editing rules

- Budgets that have spendings or transfers can't be deleted, only archived. Subscriptions can be cancelled (`endMonth`). A hard delete removes them from every past month too, so the UI warns before doing it.
- A spending must be dated within its budget's active months, and on or after `settings.startMonth`.
- A budget's `startMonth` can't be moved past its earliest spending or transfer.
- Deleting a goal moves its balance back to unassigned savings (`goalId` becomes null). No money is lost.

## Upcoming renewals

For every active subscription, the next billing date (clamped billing day) within the next N days (default 30), with its price. Yearly renewals are highlighted, together with how much of the price is already reserved.
