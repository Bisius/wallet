# UI refresh: a uniform, modern look

**Status: done (October 2026), see [Phase 9 in `PLAN.md`](./PLAN.md#phase-9--ui-refresh-frontend-engineer-test-engineer-).** This is frontend work only. It changes no API, schema or money logic, so it needs no `finance-domain-reviewer` pass. `frontend-engineer` does the work and `test-engineer` keeps the suites green. The usual gate still applies: `npm run typecheck && npm test && npm run build`, plus `npm run e2e` (flows and sweep).

---

## Where it stands (October 2026)

These findings come from screenshots of every page (desktop light and dark, and a 390 px phone, using the `rich` e2e dataset) and from an audit of `frontend/src/app/features/**`.

**Keep these. The foundations are sound:**

- The semantic tokens in `styles.css` are used everywhere. No feature uses a raw palette color, a hex value or an inline SVG.
- 112 of the 116 buttons use `appButton`, and all 55 text, number, date and select controls use `appInput`.
- The empty, loading and error states, `app-amount`, `app-icon` and `app-dialog` are used throughout.
- WCAG AA contrast is checked in both themes, and the axe and phone sweep covers every page.

The problem is not the tokens. The layer between tokens and pages is missing, so every feature hand-builds its own section headers, alerts, pills, rows and tiles. On top of that the visual language is flat: every box is drawn with a 1px border.

### Not uniform

| What              | Today                                                                                                                                                                                                          | Examples                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Page width        | 5 widths: none (Dashboard, Budgets, Subscriptions), `2xl` (Settings, Onboarding), `3xl` (Spendings, Income), `5xl` (Savings, Import), `6xl` (Report)                                                           | Moving between pages makes the content jump                                             |
| Inline messages   | The error box is copied by hand **23 times in 20 files**. 5 more copy `ErrorState`'s look. There are 3 hand-made warning boxes and 6 info boxes                                                                | `budget-summary.ts:71`, `spendings-page.html:113`, `import-preview-step.ts:62`          |
| Pills and badges  | 8 hand-rolled pill styles. The `badge` utility is used in one file. A `BADGE` const is copied between budget and subscription cards. Status pills are all grey outlines, whatever they mean                    | `budget-card.ts:11`, `goal-card.ts:17`, `upcoming-renewals-section.ts:92`               |
| Section headers   | 5 flex layouts for a title with an action. Headings are `text-lg` or `text-xl`. Descriptions are written 3 ways                                                                                                | `dashboard-card.ts`, `goals-section`, `transaction-history`                             |
| Lists             | 7 row layouts, 5 layouts for row actions, 5 key/value (`dl`) styles. No row has a hover state                                                                                                                  | `transfers-section`, `settle-inbox.html`, `report-glance`                               |
| Figures           | Stat tiles come in 2 sizes (`text-lg` and `text-2xl`) with 4 grid layouts, and `dt` labels in 4 styles                                                                                                         | `budget-summary`, `savings-summary`, `income-page`                                      |
| Actions           | Cards show 3 to 5 ghost actions that wrap (Delete ends up alone on a second line). Goal cards mix secondary and ghost buttons. Each of 29 spending rows shows Edit and Delete                                  | `budget-card.html`, `goal-card.html`, `spendings-page.html`                             |
| Create and edit   | Some edits open in dialogs, some in forms that are always open inline (Change salary, Add income), some in a panel nested in a card                                                                            | `salary-section.html:65`, `income-form.ts:46`                                           |
| Copied blocks     | The stepper (about 30 lines) is copied between onboarding and import. The month and year switchers share a copied `BUTTON` const. 8 `<a>` elements style themselves as buttons although `appLinkButton` exists | `onboarding-page.html:7`, `import-page.ts:51`, `year-switcher.ts:4`, dashboard sections |
| Period switcher   | The month switcher sits in a sticky bar above the page. Report's year switcher sits in its page header                                                                                                         | `app.html`, `yearly-report-page.ts`                                                     |
| Disclosures       | 6 `<summary>` elements in 3 styles, all with the browser's own triangle                                                                                                                                        | `budgets-page.html:110`, `budget-form.html:48`                                          |
| Spacing           | Forms use `space-y-2/3/4/5`. Inline forms end with 8 different action rows. Fields are lined up with magic offsets (`sm:pt-7`, `mt-[1.875rem]`)                                                                | `import-mapping-step.ts:90`, `settle-split-dialog.html:32`                              |
| Duplicate content | The same "March 2026 at a glance" card is on both Dashboard and Budgets                                                                                                                                        | `glance-section.ts`, `budget-summary.ts`                                                |

### Looks dated

- It uses the system font and has no type scale. Big figures (`text-lg` to `text-2xl`) hardly stand out from labels.
- Every surface is a card with a 1px border, and forms and panels sit inside cards as bordered boxes (cards in cards). There is no depth, so nothing leads the eye.
- On a phone, the navigation is a strip of 8 links that scrolls sideways ("Subscriptio" is cut off). With the brand row and the month bar, about 170 px of chrome sits above the content.
- The navigation has no icons, the API status takes the brand's place in the sidebar, and the disclosures use the browser's triangle.
- Pages are long and full of text. Many sections open with a two-line explanation, and the same idea is repeated across Dashboard, Budgets and Subscriptions.
- Budget emoji show as empty boxes where the system has no emoji font (seen on this Linux machine).

---

## Target

### Principles

1. **One way to do each thing.** Each pattern (page, section, alert, badge, row, stat, menu, stepper) has one primitive in `shared/ui/`, and features compose them. If a class string is repeated, a primitive is missing.
2. **Hierarchy through type and space, not boxes.** Use fewer borders, a real type scale, large tabular figures and soft elevation. Never nest a card inside a card.
3. **Calm actions.** A page header has at most one primary action. A card or row shows at most two actions, and the rest go in a "More" menu. Destructive actions always live in the menu and always ask first.
4. **Create and edit in dialogs.** The only inline forms are the spending quick-add (fast entry is the point of that page) and the wizards.
5. **Short copy on screen, the rest on demand.** A section description is one line. A longer explanation goes in a "How this works" disclosure.
6. **Accessibility does not regress.** The axe sweep (light and dark, desktop and phone, 320 px) and the focus rules in `app.ts` and `dialog.ts` stay exactly as strict.

### Visual language (token changes in `styles.css`)

| Token                                | Change                                                                                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--font-sans`                        | **Inter Variable**, self-hosted (`@fontsource-variable/inter`, about 50 KB woff2, cached by the service worker). No CDN, because the app runs on a private network. Money uses `tnum`                 |
| Type scale                           | Page title `text-2xl/semibold`, section title `text-base/semibold`, KPI `text-3xl/semibold tabular-nums`, stat `text-xl`, label `text-xs/medium text-muted`. These are defined once in the primitives |
| `--shadow-card`, `--shadow-overlay`  | New. Cards get a soft shadow and a fainter border. Dialogs, menus and toasts get the overlay shadow. Dark mode gets no shadow and uses a lighter surface instead                                      |
| `--color-surface-raised`             | New, mainly for dark mode: dialogs, menus, toasts and the bottom bar, where a shadow would not show                                                                                                   |
| `--radius-card` / `--radius-control` | `0.75rem` becomes `1rem`, and `0.5rem` becomes `0.625rem`                                                                                                                                             |
| Badge tones                          | Use the existing `*-soft` / text pairs (neutral, accent, positive, warning, negative). These are already AA-checked, so no new colors are needed                                                      |
| Accent                               | Stays blue: the contrast is already checked. Revisit after U4 if it still feels generic (see the decisions below)                                                                                     |
| Motion                               | Dialogs fade and scale, toasts slide and the menu fades, all within 150 ms and gated by `motion-safe:`. The e2e suite already runs with `reducedMotion: 'reduce'`                                     |

---

## Phases

Each phase lands as its own pull request (U2 and U4 as several) and passes the full gate. Sizes are relative: S is about a day, M a few days, L about a week.

### U0 · Baseline screenshots (`test-engineer`) · S

- Add `e2e/tests/visual.spec.ts` in a third Playwright project, `visual`, that `npm run e2e` does not run. It covers every page from the `rich` dataset, desktop light, desktop dark and phone, plus the main dialogs, using `toHaveScreenshot` with full-page shots. Run it once before U1 to record the "before" state.
- Baselines depend on the machine (fonts, antialiasing). Keep them on the development machine and update them on purpose in each U pull request, so a reviewer can see the visual diff.
- This also catches a page that a migration forgets.

### U1 · Foundations (`frontend-engineer`) · M

- Make the token changes above in `styles.css`. Re-run the contrast check for every pair that changes (the a11y sweep, plus the dataviz validator for chart series on the new surfaces).
- Add Inter and use `tnum` for figures.
- Add icons to `icon.ts`: navigation icons (dashboard, budgets, spendings, subscriptions, income, savings, report, settings), plus `more-horizontal`, `arrow-right`, `search`, `filter`, `chevron-up`, `circle-help` and `menu`.
- Emoji: give budget icons an emoji font stack (`"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"`).
- No feature templates change in this phase. It should already look better through the tokens alone (card, button and input primitives).

### U2 · Primitives (`frontend-engineer`) · L, several pull requests

Each primitive gets a spec and an axe check, and **replaces every copy listed** in the same pull request. That last part is what makes the UI uniform.

| Primitive                                              | What it is                                                                                                                                                                                                       | Replaces                                                                                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `app-page`                                             | Page container, `width="wide"` (72rem) or `"narrow"` (48rem), centered. Owns the vertical rhythm (`space-y-6`) and holds `app-page-header`                                                                       | The 5 page widths, and Settings' three `mt-6` siblings                                                                                     |
| `app-section`                                          | A titled block: heading (level as an input), one-line description, an action slot, an optional help disclosure, and `variant="card" \| "plain"`. `app-async-section` adds the loading, error and ready switch    | `DashboardCard` (which becomes an `app-async-section`), the 5 header layouts, and the 24 hand-styled `h2`s plus 5 wizard `h2`s             |
| `app-alert`                                            | `tone="error \| warning \| info \| success"`, icon, optional title, action slot. `ErrorState` is built on it                                                                                                     | The 23 inline error copies, 5 copied error panels, 3 warning boxes, 6 info boxes, and the box on the unavailable page                      |
| `app-badge`                                            | `tone` and an optional icon. Status words get a meaning: Active is positive, Upcoming is accent, Overdue is warning, Cancelled and Ended are neutral                                                             | The 8 pill styles, `month-status`, the `BADGE` consts and `CHIP_BASE`. `app-tag-chip` gets a `color` mode for the budget chip on spendings |
| `app-stat` + `app-stat-grid`                           | Label, value (`app-amount`), hint, `size="lg" \| "md"`, tone. The grid is responsive, from 2 to 5 columns                                                                                                        | The glance and summary tiles (budgets, income, report, savings, import preview) and the stat rows of budget, goal and subscription cards   |
| `app-list` / `app-list-row`                            | A list with dividers. A row has slots for leading (dot, icon), title, meta, amount (right-aligned, tabular) and actions. It gets a hover background, and the title can open an edit dialog                       | The 7 row layouts, the 5 action-row layouts and the 4 kinds of amount styling                                                              |
| `app-entity-card`                                      | A card with a color marker (a dot next to the title instead of the 4px left stripe), title, badges, stats, body and a footer with at most 2 actions plus `app-action-menu`                                       | Budget, goal and subscription cards. Upcoming renewals and budget progress on the dashboard use a list-row variant                         |
| `app-action-menu`                                      | A "More actions" button (`aria-expanded`) that opens a native `popover` list of buttons. It is a disclosure, not an ARIA menu, so it needs no new dependency. Destructive items come last, in the negative color | Wrapping ghost-button rows, budget reorder arrows (they become "Move up" and "Move down"), and per-row Edit and Delete                     |
| `app-stepper`                                          | Numbered steps, with the `check` icon for finished steps                                                                                                                                                         | The copied block in onboarding and import, and the `✓` glyphs                                                                              |
| `app-period-switcher`                                  | Previous, label, next and "This …" for a month or a year, using `buttonClasses('secondary','sm')`                                                                                                                | `month-switcher.ts` and `year-switcher.ts`, and their copied `BUTTON` const                                                                |
| `app-segmented`                                        | A radio group that looks like a segmented control                                                                                                                                                                | The hand-made control in `spending-filter-bar.html:44`                                                                                     |
| `app-disclosure`                                       | A styled `<details>` with a rotating chevron icon, `size="section" \| "inline"`                                                                                                                                  | The 6 `<summary>` elements in 3 styles                                                                                                     |
| `app-key-values`                                       | A `dl` laid out as label and value rows                                                                                                                                                                          | The 5 `dl` styles                                                                                                                          |
| `@utility data-table`, `form-actions`, `dialog-footer` | `data-table`: the table look the 4 tables already share, plus one wrapper. `form-actions`: the action row of an inline form. `dialog-footer` absorbs `grid grid-cols-[auto_1fr] gap-2 sm:flex sm:justify-end`    | The copied table wrappers, the 8 inline action rows and the 10 copied dialog footers                                                       |

Small fixes in the same phase:

- Replace the 8 hand-styled `<a>` elements with `appLinkButton`.
- `budget-card.html:151` uses its own disabled opacity. Use the shared one.
- `import-mapping-step.ts:91` copies the toggle by hand. Use `app-toggle`.
- Add `arrow-right` for transfers instead of the `→` text.
- Drop the redundant `tabular-nums` next to `app-amount`.

### U3 · Shell and navigation (`frontend-engineer`) · M

- **Desktop sidebar:**
  - Brand at the top.
  - Navigation with icons, in groups: _Overview_: Dashboard, Report. _Money_: Budgets, Spendings, Subscriptions, Income, Savings (the badge stays). Settings sits at the bottom.
  - The API status and server date move to the sidebar footer.
  - The active item becomes `bg-accent-soft text-accent-text` with an icon, instead of a solid accent block.
- **Phone:**
  - A bottom tab bar with Dashboard, Budgets, Spendings, Savings (with the badge) and More. More opens a sheet with Subscriptions, Income, Report, Settings and Import.
  - The bar respects `env(safe-area-inset-bottom)` and gets a `scroll-padding-bottom` (like the existing `scroll-padding-top` fix). Toasts sit above it.
  - The brand row shrinks into the top bar.
- **One sticky top bar on every page.** It holds the period switcher when the page has one (month pages: the month; Report: the year) and the global **Add spending** button. That button opens the spending form in a dialog from anywhere, and on a phone it is a floating button above the tab bar. Report's year switcher moves out of its page header, so both periods live in the same place.
- Keep what the a11y work established: skip link, focus on `h1` after navigation, `aria-current`, the badge's screen reader text, and targets of 44 px or more.

### U4 · Pages (`frontend-engineer`, one pull request per row, in parallel once U2 and U3 are in) · L

| Page          | Changes                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard     | `wide`. A KPI strip at the top (Income, Spent, Unallocated large; Fixed costs and Budgeted medium), then a 2-column grid from `xl` (currently `2xl`). Savings to move, renewals and budget progress become compact list sections with a "See all" link. Charts stay as they are                                                                                               |
| Budgets       | `wide`. Replace the duplicated glance card with a slim stat strip (Budgeted, Unallocated) and move the explanation into help. Entity cards: Edit and Move money are visible; Archive, Move up, Move down and Delete go in the menu. "Upcoming and ended" becomes an `app-disclosure`                                                                                          |
| Spendings     | `narrow`. The quick-add becomes a compact card (amount, budget and date on one row on desktop; tags and description under a "More" disclosure). The filters become a toolbar: the search field is always visible, and a "Filters" button with a count of active filters opens the rest. Rows use `app-list-row` (budget chip, tags, amount, menu), and the date headers stick |
| Subscriptions | `wide`. Entity cards with toned badges. The fixed costs KPI joins the stat strip. The yearly reserve uses `app-stat` plus `app-progress-bar`                                                                                                                                                                                                                                  |
| Income        | `narrow`. Stat strip. Salary history as a list, with a "Change salary" button that opens a dialog (no more form open inside a card). One-off incomes as a list, with "Add income" in a dialog                                                                                                                                                                                 |
| Savings       | `wide`. Stat strip with Deposit, Withdraw and Reallocate as a button group. The "Move to savings" inbox becomes `app-list-row` with `app-alert` for corrections. Goal cards: Deposit is visible; Withdraw, Edit, Archive and Delete go in the menu. History becomes `app-list` with a filter toolbar                                                                          |
| Report        | `wide`. The year switcher moves to the top bar. Stat strip. Tables use `data-table`                                                                                                                                                                                                                                                                                           |
| Settings      | `narrow`. Sections: General, Tags, Data (Export, Import, Backups), each an `app-section` with a title. The first card gets the "General" title it lacks today                                                                                                                                                                                                                 |
| Import        | `narrow` for steps 1 and 4, `wide` for mapping and review. `app-stepper`, `form-actions`, and `app-alert` for the duplicate and closed-month notices                                                                                                                                                                                                                          |
| Onboarding    | `narrow`. `app-stepper`. Same footer as Import                                                                                                                                                                                                                                                                                                                                |

Every new layout is checked at 390 px and 320 px. The e2e `mobile.spec.ts` already fails on horizontal overflow and small targets.

**Test impact.** Moving Edit and Delete into the menu changes how specs find them. `e2e/support/month-ui.ts` and `savings-ui.ts`, and about 20 frontend spec files, look for those buttons. Each U4 pull request updates its own helpers: open the row's "More actions", then pick the item. Prefer one helper (`rowAction(row, 'Delete')`) over copies.

### U5 · Guardrails (`frontend-engineer`) · S

- Add the rules below to `frontend/.claude/CLAUDE.md` under "UI conventions", so the agents follow them.
- Add `src/testing/ui-conventions.spec.ts`, a plain unit test that reads the templates under `features/` and fails on patterns that belong in a primitive:
  - `rounded-full border` (a pill)
  - `bg-negative-soft`, `bg-warning-soft` (an alert)
  - `<summary class=`
  - `<a` with `inline-flex … rounded-control`
  - `divide-y divide-line rounded-card`
  - `max-w-` on a page root
  - text glyphs used as icons (`✓`, `→`)

  Each failure names the primitive to use instead. It needs no browser, so it runs in `npm test`.

---

## UI conventions (goes into `frontend/.claude/CLAUDE.md` in U5)

- A page is `<app-page width="wide|narrow">` with `<app-page-header>`. The header has at most one primary action.
- Every titled block is an `app-section` (or `app-async-section` when it loads its own data). Never style an `h2` or `h3` by hand.
- Messages use `app-alert`, states use `app-badge`, figures use `app-stat` or `app-amount`, lists use `app-list`, and entity cards use `app-entity-card`.
- Create and edit happen in an `app-dialog`. The only inline forms are the spending quick-add and the wizard steps.
- A card or row shows at most two actions. The rest, and every destructive action, go in `app-action-menu`.
- Spacing: `space-y-6` between sections, `p-4 md:p-5` inside cards, `px-4 py-3` for rows, `gap-4` for field grids, `space-y-4` inside forms.
- No new hand-written class string longer than about 6 utilities in a feature template. If you need one, add or extend a primitive.

---

## Decisions for the owner

1. **Phone navigation:** a bottom tab bar with a More sheet _(recommended)_, or keep the top strip, restyled.
2. **Inline forms:** move Change salary and Add income into dialogs _(recommended)_. The spending quick-add stays inline in every case.
3. **Font:** self-hosted Inter _(recommended)_, or keep `system-ui` (no download, but less control over figures).
4. **Accent color:** keep the current blue _(recommended, contrast already checked)_, or pick a new hue now (a new contrast pass and new chart series checks).
5. **Explanatory copy:** move long explanations behind "How this works" disclosures _(recommended)_, or keep them all visible.
6. **Screenshot baselines (U0):** keep them out of git and update them locally _(recommended)_, or commit them.

## Done when

- All pages use `app-page`, and every pattern in the "Not uniform" table has exactly one implementation.
- `ui-conventions.spec.ts` passes with no allow-list entries left for `features/`.
- `npm run typecheck && npm test && npm run build` and `npm run e2e` (flows and sweep) are green, and the U0 visual diffs were reviewed in each pull request.
- `docs/PLAN.md` gets a "Phase 9 · UI refresh ✅" entry that links here.
