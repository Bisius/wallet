import type { BudgetAlert, BudgetVersionDto, MonthKey } from '@wallet/shared';

/** The alert state of a budget line in words. The state itself comes from the API. */
export const ALERT_LABELS: Record<BudgetAlert, string> = {
  ok: 'On track',
  warning: 'Warning',
  over: 'Over budget',
};

/**
 * The version in effect in `month`: the latest one whose `effectiveMonth` is not after it. It only
 * looks up what the API stored (`BudgetDto.versions`, ascending). Before the first version, which
 * a form never asks for, it falls back to that first one.
 */
export function versionAt(
  versions: readonly BudgetVersionDto[],
  month: MonthKey,
): BudgetVersionDto | undefined {
  let found: BudgetVersionDto | undefined;
  for (const version of versions) {
    if (version.effectiveMonth <= month) found = version;
  }
  return found ?? versions[0];
}
