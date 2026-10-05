/**
 * The texts of the bot: pure builders and constants, no I/O. Messages are HTML (the runtime sets
 * `parse_mode: 'HTML'` on every `sendMessage` and `editMessageText` that does not choose one), so
 * every name and every note that goes into one MUST go through `escapeHtml` first.
 *
 * T1 wrote what it needs here (the command list, help, the link greeting, the escaping); T2 owns the
 * file from then on and adds the builders of the flows. Money and dates are formatted with
 * `telegram.format.ts`.
 */
import type { Cents, IsoDate, MonthBudgetLine, MonthKey } from '@wallet/shared';
import { MAX_CENTS, addDays, daysInMonth } from '@wallet/shared';
import { type MessageFormat, formatDay, formatMoney, formatMonth } from './telegram.format';

/** The commands, in the order Telegram's menu and `/help` show them (`/start` is not a menu entry). */
export const BOT_COMMANDS = [
  { command: 'spending', description: 'Record a spending' },
  { command: 'income', description: 'Record an income' },
  { command: 'status', description: 'What is left in each budget' },
  { command: 'recent', description: 'Last spendings, delete one' },
  { command: 'undo', description: 'Remove what you added last' },
  { command: 'cancel', description: 'Stop the entry in progress' },
  { command: 'help', description: 'What I can do' },
] as const;

/** Escapes text for Telegram's HTML formatting: only `&`, `<` and `>` need it. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The list of commands, the text of `/help`. */
export function helpText(): string {
  const lines = BOT_COMMANDS.map(({ command, description }) => `/${command} – ${description}`);
  return [
    '<b>Wallet</b>',
    '',
    ...lines,
    '',
    'Quick entry: send an amount, like <code>12,50 lunch</code>, and pick the budget.',
  ].join('\n');
}

/** What the bot says when a code links an account: a greeting, then the help. */
export function linkGreeting(firstName: string): string {
  return `✅ Linked to Wallet, ${escapeHtml(firstName)}.\n\n${helpText()}`;
}

/** The answer to a wrong or expired code, while a code is open. */
export const INVALID_CODE_TEXT = 'Invalid or expired code.';

/** Sent, best effort, to the chat that was unlinked or replaced. */
export const NO_LONGER_LINKED_TEXT = 'This chat is no longer linked to Wallet';

/** The test message of Settings (`POST /api/telegram/test`). */
export const WALLET_CONNECTED_TEXT = '✅ Wallet is connected';

/** Unknown commands and text that is nothing else. */
export const UNKNOWN_INPUT_TEXT = "I didn't understand that. Send /help to see what I can do.";

/** The toast of a button whose flow is finished or expired. */
export const STALE_BUTTON_TEXT = 'This entry expired, start again with /spending';

export const NOTHING_TO_CANCEL_TEXT = 'Nothing to cancel.';
export const CANCELLED_TEXT = 'Cancelled.';

// =================================================================================================
// T2: the recording flows (docs/DOMAIN.md, "The `/spending` flow" and the sections after it)
//
// Pure builders of text. Everything a user typed or named (a budget, a note, a description, an icon)
// goes through `escapeHtml`; money and dates go through `telegram.format.ts` only, from integer
// cents. Every figure a builder prints is a field it is given (a line of the month view, a stored
// row): nothing here computes a balance, a percentage or a price.
// =================================================================================================

/** Telegram's limit for the text of a message, in characters. */
export const MESSAGE_MAX_CHARS = 4096;
/** Telegram's limit for the buttons of one inline keyboard. */
export const KEYBOARD_MAX_BUTTONS = 100;
/** The name of a budget is cut to this many characters on a button (and kept whole in messages). */
export const BUTTON_NAME_MAX_CHARS = 24;
/** How many days back the date buttons go: today and the 6 days before (docs/DOMAIN.md, owner). */
export const DATE_CHOICE_DAYS = 7;

export const NO_ACTIVE_BUDGETS_TEXT = 'No active budgets this month. Add one in the app.';
export const PREVIOUS_ENTRY_CANCELLED_TEXT = 'Previous entry cancelled';
export const ALREADY_REMOVED_TEXT = 'Already removed.';
export const NOTHING_TO_UNDO_TEXT = 'Nothing to undo.';
export const NO_SPENDINGS_TEXT = 'No spendings yet.';
export const KEPT_TEXT = 'Kept.';
export const SAME_DATE_TEXT = 'It is dated that day already.';
export const SOMETHING_WENT_WRONG_TEXT = 'Something went wrong. Nothing was changed.';
export const NOT_ONBOARDED_TEXT = 'Finish setting up Wallet in the app first.';
export const UNKNOWN_BUDGET_TEXT = 'That budget is no longer available. Pick another one.';
/** Said when a write was made but its confirmation could not be shown: never "nothing was changed". */
export const SAVED_NOT_SHOWN_TEXT =
  "Saved, but I couldn't show the confirmation. /recent lists it.";
export const INCOME_SAVED_NOT_SHOWN_TEXT =
  "Saved, but I couldn't show the confirmation. /undo takes it back.";
export const MOVED_NOT_SHOWN_TEXT = "Moved, but I couldn't show the result.";
export const REMOVED_NOT_SHOWN_TEXT = "Removed, but I couldn't show the result.";
export const WHICH_BUDGET_TEXT = 'Which budget?';
export const AMOUNT_PROMPT_TEXT = 'How much? You can add a note after the amount, like 12,50 lunch';
export const NOTE_PROMPT_TEXT = 'A note?';
export const DATE_PROMPT_TEXT = 'When?';
export const INCOME_AMOUNT_PROMPT_TEXT =
  'How much was the income? You can add a description after the amount, like 200 Bonus';
export const INCOME_DESCRIPTION_PROMPT_TEXT = 'What was it? A description, like Bonus';

// --- Small helpers ----------------------------------------------------------------------------

/** `text` cut to `max` characters (code points, never inside an emoji), with `…` when it was cut. */
export function truncateLabel(text: string, max = BUTTON_NAME_MAX_CHARS): string {
  const chars = Array.from(text);
  return chars.length <= max
    ? text
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}

/** The weekday and the day of the month as the locale writes them: "Wed 30" (en-US, en-GB). */
export function dayLabel(date: IsoDate, { locale }: Pick<MessageFormat, 'locale'>): string {
  const instant = new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))),
  );
  const options: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', timeZone: 'UTC' };
  try {
    return new Intl.DateTimeFormat(locale, options).format(instant);
  } catch {
    return new Intl.DateTimeFormat('en-US', options).format(instant);
  }
}

/**
 * A month's name for a message: "September", and "September 2025" when it is not in the year of
 * `current` (a spending can be years old when it is deleted from `/recent`).
 */
export function monthLabel(
  month: MonthKey,
  current: MonthKey,
  format: Pick<MessageFormat, 'locale'>,
): string {
  return formatMonth(month, format, month.slice(0, 4) !== current.slice(0, 4));
}

/**
 * The days the date buttons offer, newest first: today and the 6 days before it, except the days of a
 * month before `startMonth` (nothing before the start month is accepted, so it is not offered).
 */
export function recentDates(today: IsoDate, startMonth: MonthKey): IsoDate[] {
  const days: IsoDate[] = [];
  for (let back = 0; back < DATE_CHOICE_DAYS; back++) {
    const day = addDays(today, -back);
    if (day.slice(0, 7) >= startMonth) days.push(day);
  }
  return days;
}

/** The visible length of a text: tags dropped, each entity one character (what Telegram counts). */
export function visibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt);/g, '.').length;
}

/**
 * Groups `lines` into messages of at most `limit` characters (visible, one line never split), joined
 * by newlines. A message always has at least one line, so a single line over the limit stays alone.
 */
export function chunkLines(lines: readonly string[], limit = MESSAGE_MAX_CHARS - 96): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const line of lines) {
    const added = visibleLength(line) + 1;
    if (current.length > 0 && length + added > limit) {
      chunks.push(current.join('\n'));
      current = [];
      length = 0;
    }
    current.push(line);
    length += added;
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}

const joinNames = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

// --- Spendings --------------------------------------------------------------------------------

/** A stored spending as a message shows it: the budget by name, the note as it is. */
export interface SpendingFacts {
  /** Signed cents: negative is a refund. */
  amount: Cents;
  budgetName: string;
  /** The description; may be empty. */
  note: string;
  date: IsoDate;
}

/** `€23.40 · Groceries · Lidl · Mon 5 Oct`, or `↩ Refund €5.00 · Groceries · Mon 5 Oct`. */
export function spendingText(
  facts: SpendingFacts,
  format: MessageFormat,
  { withDate = true }: { withDate?: boolean } = {},
): string {
  const parts = [
    facts.amount < 0
      ? `↩ Refund ${formatMoney(-facts.amount, format)}`
      : formatMoney(facts.amount, format),
    escapeHtml(facts.budgetName),
  ];
  if (facts.note !== '') parts.push(escapeHtml(facts.note));
  if (withDate) parts.push(formatDay(facts.date, format));
  return parts.join(' · ');
}

/** The amount and the note of a message that has no budget yet: `€4.50 · coffee`. */
export function amountNoteText(amount: Cents, note: string, format: MessageFormat): string {
  const money =
    amount < 0 ? `↩ Refund ${formatMoney(-amount, format)}` : formatMoney(amount, format);
  return note === '' ? money : `${money} · ${escapeHtml(note)}`;
}

/** The title of a budget in a message: its icon (when it has one) and its whole name. */
export const budgetTitle = (budget: { icon: string | null; name: string }): string =>
  budget.icon ? `${escapeHtml(budget.icon)} ${escapeHtml(budget.name)}` : escapeHtml(budget.name);

/** The budget's line of the month view, as far as the messages print it. */
export type BudgetFigure = Pick<
  MonthBudgetLine,
  'name' | 'remaining' | 'available' | 'usagePercent' | 'alert' | 'warnPercent'
>;

/**
 * `Groceries: €164.10 left of €300.00 (45% used)`. The mark is the line's `alert`: `⚠️` and "(81%
 * used, warning at 80%)" for a warning, `🔴 ... over by €12.40` for `over` (that is `-remaining`),
 * and no percentage when `usagePercent` is null (`available <= 0`). `closedMonth` names the month of
 * a spending in a closed month: `Groceries in September (closed): ...`, and `thisMonth` names the
 * current month when the line is the one where a closed month's effect lands: `Fuel in October (this
 * month): ...`.
 */
export function budgetFigureText(
  figure: BudgetFigure,
  format: MessageFormat,
  closedMonth?: string,
  thisMonth?: string,
): string {
  const money = (cents: Cents) => formatMoney(cents, format);
  const name = escapeHtml(figure.name);
  const subject =
    closedMonth !== undefined
      ? `${name} in ${closedMonth} (closed)`
      : thisMonth !== undefined
        ? `${name} in ${thisMonth} (this month)`
        : name;
  const percent = figure.usagePercent;
  if (figure.alert === 'over') {
    const detail =
      percent === null || figure.available <= 0
        ? ''
        : ` (${percent}% of ${money(figure.available)} used)`;
    return `🔴 ${subject}: over by ${money(-figure.remaining)}${detail}`;
  }
  const left = `${money(figure.remaining)} left of ${money(figure.available)}`;
  if (figure.alert === 'warning') {
    const used = percent === null ? '' : ` (${percent}% used, warning at ${figure.warnPercent}%)`;
    return `⚠️ ${subject}: ${left}${used}`;
  }
  return `${subject}: ${left}${percent === null ? '' : ` (${percent}% used)`}`;
}

/**
 * The line where the effect of an entry in a closed month lands, for a budget that carries on there:
 * the closed month where the carried money settles (its savings due move), or the current month.
 */
export interface LandingFigure {
  figure: BudgetFigure;
  /** The landing month's name. */
  label: string;
  /** A closed month where it settles ("in September (closed)"); false: the current month ("(this month)"). */
  closed: boolean;
}

/** The figure lines under a spending: the month of the spending, then (when there is one) where its effect lands. */
function figureLines(
  figure: BudgetFigure | null,
  format: MessageFormat,
  closedMonth: string | undefined,
  landing: LandingFigure | undefined,
): string[] {
  const lines: string[] = [];
  if (figure) lines.push(budgetFigureText(figure, format, closedMonth));
  if (landing) {
    lines.push(
      budgetFigureText(
        landing.figure,
        format,
        landing.closed ? landing.label : undefined,
        landing.closed ? undefined : landing.label,
      ),
    );
  }
  return lines;
}

/** The confirmation of a saved spending: the row as stored, then the budget's figure (when it has one). */
export function spendingConfirmationText(
  facts: SpendingFacts,
  figure: BudgetFigure | null,
  format: MessageFormat,
  closedMonth?: string,
  landing?: LandingFigure,
): string {
  const summary = spendingText(facts, format);
  const first = facts.amount < 0 ? summary : `✅ ${summary}`;
  return [first, ...figureLines(figure, format, closedMonth, landing)].join('\n');
}

/** What follows an Undo or a delete: "Removed", the row as it was, the budget's new figure. */
export function spendingRemovedText(
  facts: SpendingFacts,
  figure: BudgetFigure | null,
  format: MessageFormat,
  closedMonth?: string,
  landing?: LandingFigure,
): string {
  const first = `🗑 Removed ${spendingText(facts, format)}`;
  return [first, ...figureLines(figure, format, closedMonth, landing)].join('\n');
}

/** The verb of the question before a delete: `/recent` asks "Delete", Undo and `/undo` ask "Remove". */
export type QuestionVerb = 'Delete' | 'Remove';

/** The question before a delete: `Delete €12.50 · Groceries · lunch (Sat 3 Oct)?`. */
export function spendingQuestionText(
  facts: SpendingFacts,
  format: MessageFormat,
  verb: QuestionVerb,
): string {
  return `${verb} ${spendingText(facts, format, { withDate: false })} (${formatDay(facts.date, format)})?`;
}

// --- Incomes ----------------------------------------------------------------------------------

export interface IncomeFacts {
  /** Positive cents. */
  amount: Cents;
  description: string;
  date: IsoDate;
}

/** The part of the month view an income's message prints. */
export interface IncomeFigures {
  total: Cents;
  unallocated: Cents;
  overAllocated: boolean;
}

/** `Income €200.00 · Bonus · Mon 5 Oct`. */
export function incomeText(
  facts: IncomeFacts,
  format: MessageFormat,
  { withDate = true }: { withDate?: boolean } = {},
): string {
  const parts = [`Income ${formatMoney(facts.amount, format)}`, escapeHtml(facts.description)];
  if (withDate) parts.push(formatDay(facts.date, format));
  return parts.join(' · ');
}

/** `October: income €3,200.00 · Unallocated €320.00`, with `⚠️` when the month is over-allocated. */
export function incomeFiguresText(
  figures: IncomeFigures,
  month: string,
  format: MessageFormat,
  closed: boolean,
): string {
  const label = closed ? `${month} (closed)` : month;
  const warn = figures.overAllocated ? '⚠️ ' : '';
  return (
    `${label}: income ${formatMoney(figures.total, format)} · ` +
    `${warn}Unallocated ${formatMoney(figures.unallocated, format)}`
  );
}

export function incomeConfirmationText(
  facts: IncomeFacts,
  figuresText: string | null,
  format: MessageFormat,
): string {
  const first = `✅ ${incomeText(facts, format)}`;
  return figuresText === null ? first : `${first}\n${figuresText}`;
}

export function incomeRemovedText(
  facts: IncomeFacts,
  figuresText: string | null,
  format: MessageFormat,
): string {
  const first = `🗑 Removed ${incomeText(facts, format)}`;
  return figuresText === null ? first : `${first}\n${figuresText}`;
}

export function incomeQuestionText(
  facts: IncomeFacts,
  format: MessageFormat,
  verb: QuestionVerb,
): string {
  return `${verb} ${incomeText(facts, format, { withDate: false })} (${formatDay(facts.date, format)})?`;
}

// --- The steps of a flow ----------------------------------------------------------------------

/** What a spending flow has collected so far, as the prompts echo it so a wrong amount shows at once. */
export interface SpendingDraft {
  amount: Cents;
  budgetName: string;
  note: string;
}

/** `€23.40 · Groceries · Lidl`: the draft without a date. */
export const spendingDraftText = (draft: SpendingDraft, format: MessageFormat): string =>
  spendingText({ ...draft, date: '1970-01-01' }, format, { withDate: false });

export const notePromptText = (draft: SpendingDraft, format: MessageFormat): string =>
  `${spendingDraftText(draft, format)}\n${NOTE_PROMPT_TEXT}`;

export const datePromptText = (summary: string): string => `${summary}\n${DATE_PROMPT_TEXT}`;

/** `Income €200.00 · Bonus` (the description once there is one): an income flow's draft, with no date. */
export const incomeDraftText = (
  amount: Cents,
  description: string,
  format: MessageFormat,
): string =>
  description === ''
    ? `Income ${formatMoney(amount, format)}`
    : `Income ${formatMoney(amount, format)} · ${escapeHtml(description)}`;

/** `€4.50 · coffee. Which budget?` (quick entry). */
export const quickBudgetPromptText = (amount: Cents, note: string, format: MessageFormat): string =>
  `${amountNoteText(amount, note, format)}. ${WHICH_BUDGET_TEXT}`;

export const incomeDescriptionPromptText = (amount: Cents, format: MessageFormat): string =>
  `Income ${formatMoney(amount, format)}\n${INCOME_DESCRIPTION_PROMPT_TEXT}`;

/** A closed month that an action touches, as the question names it. */
export interface ClosedMonthName {
  name: string;
  /**
   * The name of the closed month whose savings due the action moves (this month's own name where the
   * budget settles with savings there, a later month where a carry settles); null where the carry
   * reaches the current month, so that what changes is what the budget carries forward.
   */
  savingsFor: string | null;
}

/**
 * The closed-month question (docs/DOMAIN.md, step 5): "September is closed. Adding this changes what
 * is due to savings for September." The effect is worded by where it settles, which comes from the
 * budget's lines of the month views: savings due of the month named (a month that carries on settles
 * in the first later month that does not, which is named even when the action did not touch it), and
 * "what Fuel carries forward from September" where the carry reaches the current month. An income only
 * ever moves savings due. `budgetName` is needed when any month carries into the current one.
 */
export function closedMonthText(
  action: 'Adding' | 'Moving' | 'Removing',
  months: readonly ClosedMonthName[],
  budgetName?: string,
): string {
  const all = joinNames(months.map((month) => month.name));
  const savings = [
    ...new Set(months.flatMap((month) => (month.savingsFor === null ? [] : [month.savingsFor]))),
  ];
  const carried = months.filter((month) => month.savingsFor === null).map((month) => month.name);
  const effects: string[] = [];
  if (savings.length > 0) effects.push(`what is due to savings for ${joinNames(savings)}`);
  if (carried.length > 0) {
    effects.push(
      `what ${escapeHtml(budgetName ?? 'the budget')} carries forward from ${joinNames(carried)}`,
    );
  }
  return `${all} ${months.length === 1 ? 'is' : 'are'} closed. ${action} this changes ${effects.join(' and ')}.`;
}

/** Why an amount was refused, with an example to copy (`kind`: what the flow records). */
export function amountProblemText(
  problem: 'not_an_amount' | 'zero' | 'too_large' | 'note_too_long' | 'not_positive',
  kind: 'spending' | 'income',
  format: MessageFormat,
): string {
  const example = kind === 'income' ? '200 Bonus' : '12,50 lunch';
  switch (problem) {
    case 'not_an_amount':
      return `I couldn't read an amount there. Try ${kind === 'income' ? '200' : '12.50'} or ${example}.`;
    case 'zero':
      return kind === 'income'
        ? "The amount can't be 0. Try 200 Bonus."
        : "The amount can't be 0. Try 12.50, or -5 for a refund.";
    case 'not_positive':
      return 'An income is a positive amount. Try 200 Bonus.';
    case 'too_large':
      return `That amount is too large: the most is ${formatMoney(MAX_CENTS, format)}.`;
    case 'note_too_long':
      return `That ${kind === 'income' ? 'description' : 'note'} is too long: 200 characters at most.`;
  }
}

export const noteTooLongText = (kind: 'note' | 'description'): string =>
  `That ${kind} is too long: 200 characters at most.`;

/** `Groceries isn't active in September. Pick another date.` */
export const outsideActiveMonthsText = (budgetName: string, month: string): string =>
  `${escapeHtml(budgetName)} isn't active in ${month}. Pick another date.`;

/** The start month is the first one Wallet tracks. */
export const beforeStartMonthText = (startMonth: string): string =>
  `That date is before the first month Wallet tracks (${startMonth}). Pick another date.`;

// --- /status ----------------------------------------------------------------------------------

/** A budget line of `/status`: its icon, and the figure of the month view. */
export type StatusLine = BudgetFigure & { icon: string | null };

/**
 * `🛒 Groceries · €164.10 left of €300.00 (45%)`, with `⚠️` or `🔴` at the end, and `over by` for a
 * budget that is over. No percentage when `usagePercent` is null.
 */
export function statusLineText(line: StatusLine, format: MessageFormat): string {
  const money = (cents: Cents) => formatMoney(cents, format);
  const lead = line.icon ? `${escapeHtml(line.icon)} ` : '• ';
  const percent = line.usagePercent === null ? '' : ` (${line.usagePercent}%)`;
  const name = escapeHtml(line.name);
  if (line.alert === 'over') {
    const of = line.available > 0 ? ` of ${money(line.available)}` : '';
    return `${lead}${name} · over by ${money(-line.remaining)}${of}${percent} 🔴`;
  }
  const text = `${lead}${name} · ${money(line.remaining)} left of ${money(line.available)}${percent}`;
  return line.alert === 'warning' ? `${text} ⚠️` : text;
}

/**
 * `26 days left in October · Unallocated €320.00` (`⚠️` before Unallocated when over-allocated). On the
 * last day it reads "Last day of October" and the day before it "1 day left in October".
 */
export function statusFooterText(
  month: MonthKey,
  today: IsoDate,
  figures: { unallocated: Cents; overAllocated: boolean },
  format: MessageFormat,
): string {
  const name = formatMonth(month, format);
  const left = daysInMonth(month) - Number(today.slice(8, 10));
  const days =
    left <= 0
      ? `Last day of ${name}`
      : left === 1
        ? `1 day left in ${name}`
        : `${left} days left in ${name}`;
  const warn = figures.overAllocated ? '⚠️ ' : '';
  return `${days} · ${warn}Unallocated ${formatMoney(figures.unallocated, format)}`;
}

// --- /recent ----------------------------------------------------------------------------------

/** The numbered list of `/recent`. */
export function recentText(rows: readonly SpendingFacts[], format: MessageFormat): string {
  if (rows.length === 0) return NO_SPENDINGS_TEXT;
  const lines = rows.map((row, index) => `${index + 1}. ${spendingText(row, format)}`);
  return ['Last spendings', ...lines].join('\n');
}
