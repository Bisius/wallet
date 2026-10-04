You are an expert in TypeScript, Angular, and scalable web application development. You write functional, maintainable, performant, and accessible code following Angular and TypeScript best practices.

## TypeScript Best Practices

- Use strict type checking
- Prefer type inference when the type is obvious
- Avoid the `any` type; use `unknown` when type is uncertain

## Angular Best Practices

- Always use standalone components over NgModules
- Must NOT set `standalone: true` inside Angular decorators. It's the default in Angular v20+.
- Use signals for state management
- Implement lazy loading for feature routes
- Do NOT use the `@HostBinding` and `@HostListener` decorators. Put host bindings inside the `host` object of the `@Component` or `@Directive` decorator instead
- Use `NgOptimizedImage` for all static images.
  - `NgOptimizedImage` does not work for inline base64 images.

## Accessibility Requirements

- It MUST pass all AXE checks.
- It MUST follow all WCAG AA minimums, including focus management, color contrast, and ARIA attributes.

### Components

- Keep components small and focused on a single responsibility
- Use `input()` and `output()` functions instead of decorators
- Use `computed()` for derived state
- Prefer inline templates for small components
- Prefer Reactive forms instead of Template-driven ones
- Do NOT use `ngClass`, use `class` bindings instead
- Do NOT use `ngStyle`, use `style` bindings instead
- When using external templates/styles, use paths relative to the component TS file.

## State Management

- Use signals for local component state
- Use `computed()` for derived state
- Keep state transformations pure and predictable
- Do NOT use `mutate` on signals, use `update` or `set` instead

## Templates

- Keep templates simple and avoid complex logic
- Use native control flow (`@if`, `@for`, `@switch`) instead of `*ngIf`, `*ngFor`, `*ngSwitch`
- Use the async pipe to handle observables
- Do not assume globals like (`new Date()`) are available.

## Services

- Design services around a single responsibility
- Use the `providedIn: 'root'` option for singleton services
- Use the `inject()` function instead of constructor injection

## UI conventions

One way to do each thing: every pattern has one primitive in `src/app/shared/ui/` (forms: `shared/forms/`), and features compose them. If a class string is repeated, a primitive is missing: add or extend it, don't copy it. `src/testing/ui-conventions.spec.ts` fails `npm test` on the patterns that belong in a primitive and names the one to use. The tokens (colors, radii, shadows, the type utilities `text-page-title`, `text-section-title`, `text-kpi`, `text-stat`, `text-label`) are in `src/styles.css`; use their semantic names, never raw palette colors.

- **Pages.** A page is `<app-page width="wide|narrow">` with `<app-page-header>`. `wide` (72rem) is for dashboards and tables, `narrow` (48rem) for forms and lists. The header has at most one primary action. Never put `max-w-*` on a page root, and pages add no bottom padding (the shell does).
- **Blocks.** Every titled block is an `app-section` (or `app-async-section` when it loads its own data: it owns the loading, error and ready states). Never style an `h2` or `h3` by hand. A section description is one line; a longer explanation goes in the `sectionHelp` slot ("How this works"). A section inside a card is `variant="plain"`: never nest a card in a card.
- **Messages and states.** Messages use `app-alert` (`tone="error|warning|info|success"`), request failures `app-error-state`, empty lists `app-empty-state`, loading `app-loading-state`. Status words use `app-badge` (Active is positive, Upcoming accent, Overdue warning, Cancelled and Ended neutral) and tags or budget chips `app-tag-chip`. Color is never the only signal.
- **Figures.** Money is `app-amount` (or the money pipe in plain text). Headline figures are `div[appStat]` in a `dl[appStatGrid]` (`size="lg"` for the main ones, `md` for the rest) or an `app-stat-strip`; label and value rows are `dl[appKeyValues]`.
- **Lists and cards.** Rows are `ul[appList]` with `li[appListRow]` (slots for leading, title, meta, amount and actions); an entity (budget, goal, subscription) is `article[appEntityCard]`; tables are `data-table` inside `app-table-scroll`.
- **Actions.** A card or row shows at most two actions. The rest, and every destructive action (always last, `destructive`, always behind a confirmation), go in `app-action-menu` with `button[appMenuItem]`. Buttons are `appButton`, links that look like buttons `a[appLinkButton]`; links to another page are `app-see-all-link`.
- **Create and edit** happen in an `app-dialog` (`variant="sheet"` is the phone bottom sheet). The only inline forms are the spending quick-add and the wizard steps (`app-stepper`, `wizard-actions`). Inline form actions use `form-actions`, dialog actions `dialog-footer`.
- **Other primitives.** `app-disclosure` for any show/hide (never a styled `<summary>`), `app-segmented` for a choice between a few options, `app-period-switcher` for month and year, `app-icon` for every icon (never a text glyph such as a check mark or an arrow), `span[appColorDot]` for a color marker (never a left border stripe), emoji get the `font-emoji` class.
- **Spacing.** `space-y-6` between sections (`app-page` does it), `p-4 md:p-5` inside cards, `px-4 py-3` for rows, `gap-4` for field grids, `space-y-4` inside forms. No new hand-written class string longer than about 6 utilities in a feature template: if you need one, add or extend a primitive.
- **Motion** is within 150 ms and gated by `motion-safe:`. Dark mode has no shadows: raised surfaces use `bg-surface-raised` and a visible `border-line`.
- **Tests.** Reach a row's actions through the menu helpers (`src/testing/menu.ts`: `rowAction`, `openActionMenu`, `clickMenuItem`; e2e: `rowAction` in `e2e/support/menu.ts`), never by copying menu-opening code. Every new primitive gets a spec with an `a11yProblems` check and, if it changes a page's look, a visual check (`npm run e2e:visual`, baselines are local; see `e2e/README.md`).
