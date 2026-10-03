import type { RuleViolationRule } from '@wallet/shared';
import { MAX_START_MONTH_AGE_MONTHS } from '@wallet/shared/limits';

/** How far back the start month may be, in years (the API counts months). */
const MAX_YEARS_BACK = MAX_START_MONTH_AGE_MONTHS / 12;

/**
 * What to tell the user about a start month, under its field, before they have tried anything. It
 * does not promise that every move works: moving it later is refused while an entry is dated before
 * the new month (docs/DOMAIN.md, "Start month").
 */
export const START_MONTH_HINT =
  `The first month Wallet tracks: not after the current month and not more than ${MAX_YEARS_BACK} years back. ` +
  'Moving it later only works while nothing is dated before the new month. ' +
  'Your opening savings balance is the balance on its first day.';

/** What to do about each rule a start month can break (a 422 `rule_violation` of onboarding or of the settings). */
export const START_MONTH_RULE_HELP: Partial<Record<RuleViolationRule, string>> = {
  start_month_in_future:
    "The start month can't be after the current month, or the current month would not be tracked. Choose this month or an earlier one.",
  start_month_too_old: `The start month can't be more than ${MAX_YEARS_BACK} years before the current month. Choose a more recent one.`,
  start_month_after_facts:
    'Some of your entries are dated before that month, for example your first salary entry. ' +
    'The start month can only move later once every salary change, income, budget, subscription, spending and savings entry is dated in or after it: ' +
    'move or delete the earlier ones first, or choose an earlier month.',
};
