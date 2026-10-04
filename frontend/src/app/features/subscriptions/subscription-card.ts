import { Component, computed, inject, input, output, viewChild } from '@angular/core';
import type {
  MonthKey,
  MonthSubscriptionLine,
  SubscriptionDto,
  SubscriptionStatus,
} from '@wallet/shared';
import { SettingsStore } from '../../core/settings.store';
import { formatDate, formatMonth } from '../../shared/format';
import { formatMoney, MoneyPipe } from '../../shared/money.pipe';
import { ActionMenu, MenuItem } from '../../shared/ui/action-menu';
import { Amount } from '../../shared/ui/amount';
import { Badge, type BadgeTone } from '../../shared/ui/badge';
import { Button } from '../../shared/ui/button';
import { EntityCard } from '../../shared/ui/entity-card';
import { Icon } from '../../shared/ui/icon';
import { ProgressBar } from '../../shared/ui/progress-bar';
import { Stat } from '../../shared/ui/stat';
import { StatGrid } from '../../shared/ui/stat-grid';

/** What each status is called, and what it means: running, not started yet, over. */
const STATUSES: Record<SubscriptionStatus, { label: string; tone: BadgeTone }> = {
  active: { label: 'Active', tone: 'positive' },
  upcoming: { label: 'Upcoming', tone: 'accent' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/**
 * One subscription: its price, what it costs per month, when it renews and, for a yearly one, how
 * much of the next renewal is already set aside in the selected month (`line`, from the month view).
 *
 * Nothing is calculated here. The reserve, the renewal month and the release come from the month
 * view; the card says them in plain words. The bar only draws `reserveBalance` against
 * `nextRenewalPrice`. The actions are requests: the page does the work. Edit and Change price are
 * buttons; Cancel and Delete are in the card's menu.
 */
@Component({
  selector: 'app-subscription-card',
  imports: [
    ActionMenu,
    Amount,
    Badge,
    Button,
    EntityCard,
    Icon,
    MenuItem,
    MoneyPipe,
    ProgressBar,
    Stat,
    StatGrid,
  ],
  templateUrl: './subscription-card.html',
  host: { class: 'block h-full' },
})
export class SubscriptionCard {
  private readonly settings = inject(SettingsStore);

  readonly subscription = input.required<SubscriptionDto>();
  /** What the shown month does with it (`MonthView.subscriptions[]`). Missing when it is not active then. */
  readonly line = input<MonthSubscriptionLine>();
  /** The month the page shows. */
  readonly month = input.required<MonthKey>();

  readonly edit = output<void>();
  readonly changePrice = output<void>();
  readonly cancel = output<void>();
  readonly remove = output<void>();

  private readonly menu = viewChild(ActionMenu);
  /** Puts the keyboard on the card's "More actions" button (the page does after Cancel). */
  focusMenu(): void {
    this.menu()?.focus();
  }

  protected readonly status = computed(() => STATUSES[this.subscription().status]);
  protected readonly yearly = computed(() => this.subscription().frequency === 'yearly');

  protected readonly monthLabel = computed(() => formatMonth(this.month(), this.settings.locale()));

  protected readonly endLabel = computed(() => {
    const { endMonth, status } = this.subscription();
    if (!endMonth) return null;
    const label = formatMonth(endMonth, this.settings.locale(), 'short');
    return status === 'cancelled' ? `Ended ${label}` : `Ends ${label}`;
  });
  protected readonly startsLabel = computed(() => {
    const { status, startMonth } = this.subscription();
    return status === 'upcoming'
      ? `Starts ${formatMonth(startMonth, this.settings.locale(), 'short')}`
      : null;
  });

  /** The price now, or the first one for a subscription that has not started. */
  protected readonly price = computed(() => {
    const { currentPrice, prices } = this.subscription();
    return currentPrice ?? prices[0]?.amount ?? null;
  });

  /** Only an active subscription can be cancelled, and only once. Delete is for the rest. */
  protected readonly canCancel = computed(() => {
    const { status, endMonth } = this.subscription();
    return status === 'active' && endMonth === null;
  });
  protected readonly canChangePrice = computed(() => this.subscription().status !== 'cancelled');

  /** When it is charged, read from the charge date the subscription was created with. */
  protected readonly schedule = computed(() => {
    const { anchorDate, frequency } = this.subscription();
    const locale = this.settings.locale();
    const day = Number(anchorDate.slice(8, 10));
    if (frequency === 'yearly') {
      return `Renews every year on ${formatDate(anchorDate, locale, 'monthDay')}.`;
    }
    return day > 28
      ? `Charged on day ${day} of each month, or the last day of a shorter month.`
      : `Charged on day ${day} of each month.`;
  });

  /** What the yearly reserve is doing in the shown month, in the shape the template needs. */
  protected readonly reserve = computed(() => {
    const line = this.line();
    if (!line || line.frequency !== 'yearly') return null;
    const locale = this.settings.locale();
    const none = { percent: 0, renewal: '', valueText: '' };

    if (line.renewalThisMonth) return { kind: 'renewal' as const, ...none };
    if (line.nextRenewalMonth === null || line.nextRenewalPrice === null) {
      return { kind: 'ends-first' as const, ...none };
    }
    // A picture of reserve against price. Both are the API's figures; the text says them exactly.
    const percent =
      line.nextRenewalPrice > 0
        ? Math.floor((line.reserveBalance * 100) / line.nextRenewalPrice)
        : 0;
    const price = formatMoney(line.nextRenewalPrice, locale, this.settings.currency());
    return {
      kind: 'saving' as const,
      percent,
      renewal: formatMonth(line.nextRenewalMonth, locale),
      valueText: `${percent}% of the ${price} renewal set aside`,
    };
  });

  /** "Next renewal March 2027 (€120.00)" for a yearly subscription, from the month view. */
  protected readonly nextRenewal = computed(() => {
    const line = this.line();
    if (!line || line.nextRenewalMonth === null || line.nextRenewalPrice === null) return null;
    return {
      month: formatMonth(line.nextRenewalMonth, this.settings.locale()),
      price: line.nextRenewalPrice,
    };
  });
}
