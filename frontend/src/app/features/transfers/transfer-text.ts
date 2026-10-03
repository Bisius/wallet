/** What the unallocated pool of a month is called wherever a transfer names its sides. */
export const POOL_LABEL = 'Unallocated';

/**
 * What changing a transfer in a closed month does, in a sentence. The same words for creating one and
 * for deleting one, because it is the same change in either direction. Nothing here is calculated:
 * the savings amount is the API's, and the Savings page shows the adjustment.
 */
export function closedMonthEffect(monthLabel: string): string {
  return (
    `${monthLabel} is already closed, so this changes that month's budgets and the amount due to ` +
    `savings for it. If you already moved that month's savings, the difference shows up on the ` +
    `Savings page as an adjustment.`
  );
}
