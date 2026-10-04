import type { IconName } from '../shared/ui/icon';

/** One destination of the main navigation. */
export interface NavItem {
  path: string;
  label: string;
  icon: IconName;
  /** Shows how many months wait to be moved to savings, next to the label. */
  savingsBadge?: boolean;
}

const DASHBOARD: NavItem = { path: '/dashboard', label: 'Dashboard', icon: 'dashboard' };
const REPORT: NavItem = { path: '/report', label: 'Report', icon: 'report' };
const BUDGETS: NavItem = { path: '/budgets', label: 'Budgets', icon: 'budgets' };
const SPENDINGS: NavItem = { path: '/spendings', label: 'Spendings', icon: 'spendings' };
const SUBSCRIPTIONS: NavItem = {
  path: '/subscriptions',
  label: 'Subscriptions',
  icon: 'subscriptions',
};
const INCOME: NavItem = { path: '/income', label: 'Income', icon: 'income' };
const SAVINGS: NavItem = {
  path: '/savings',
  label: 'Savings',
  icon: 'savings',
  savingsBadge: true,
};
const SETTINGS: NavItem = { path: '/settings', label: 'Settings', icon: 'settings' };
const IMPORT: NavItem = { path: '/import', label: 'Import CSV', icon: 'upload' };

export interface NavGroup {
  /** Names the list for a screen reader and is shown above it. */
  label: string;
  items: readonly NavItem[];
}

/** The sidebar of a wide screen: two labelled groups (Settings sits apart, at the bottom). */
export const SIDEBAR_GROUPS: readonly NavGroup[] = [
  { label: 'Overview', items: [DASHBOARD, REPORT] },
  { label: 'Money', items: [BUDGETS, SPENDINGS, SUBSCRIPTIONS, INCOME, SAVINGS] },
];
export const SIDEBAR_SETTINGS: NavItem = SETTINGS;

/** The tabs of a phone's bottom bar, before "More". */
export const TAB_ITEMS: readonly NavItem[] = [DASHBOARD, BUDGETS, SPENDINGS, SAVINGS];

/** What "More" opens on a phone: everything the tab bar has no room for. */
export const MORE_ITEMS: readonly NavItem[] = [SUBSCRIPTIONS, INCOME, REPORT, SETTINGS, IMPORT];

/**
 * What makes a link the current page: the link's path is a prefix of the address (a page with a
 * deeper address is still that page) and its query and fragment are ignored (the month switcher
 * changes the query only). `ariaCurrentWhenActive="page"` on the link says it to a screen reader.
 */
export const ACTIVE_LINK_OPTIONS = {
  paths: 'subset',
  queryParams: 'ignored',
  fragment: 'ignored',
  matrixParams: 'ignored',
} as const;
