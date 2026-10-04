import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { UpcomingRenewalDto } from '@wallet/shared';
import { UPCOMING_DEFAULT_DAYS } from '@wallet/shared/limits';
import { resourceState } from '../../core/resource-state';
import { SelectedMonth } from '../../core/selected-month';
import { SettingsStore } from '../../core/settings.store';
import { TodayStore } from '../../core/today.store';
import { formatDate } from '../../shared/format';
import { MoneyPipe } from '../../shared/money.pipe';
import { Amount } from '../../shared/ui/amount';
import { Icon } from '../../shared/ui/icon';
import { ProgressBar } from '../../shared/ui/progress-bar';
import { EmptyState } from '../../shared/ui/states';
import { SubscriptionsApi } from '../subscriptions/subscriptions.api';
import { DashboardCard } from './dashboard-card';

/** "Today", "Tomorrow" or "In 12 days": `daysUntil` is the API's. */
function untilText(daysUntil: number): string {
  if (daysUntil <= 0) return 'Today';
  if (daysUntil === 1) return 'Tomorrow';
  return `In ${daysUntil} days`;
}

/**
 * The subscriptions that bill in the next 30 days, soonest first, from `GET /api/subscriptions/
 * upcoming`. It is about today, not about the month the switcher selects. A yearly renewal is
 * highlighted and shows how much of its price is already reserved and how much is still missing:
 * `reserved` and `unreserved` are the API's figures (the bar only draws their ratio), so the page
 * never works out a reserve itself. The amount of a renewal is its price on that date.
 */
@Component({
  selector: 'app-upcoming-renewals-section',
  imports: [Amount, DashboardCard, EmptyState, Icon, MoneyPipe, ProgressBar, RouterLink],
  template: `
    <app-dashboard-card
      title="Upcoming renewals"
      [description]="
        'Subscriptions billed in the next ' +
        days +
        ' days, whichever month you are looking at. A yearly renewal shows how much of its price is already set aside.'
      "
      [state]="state()"
      [error]="renewals.error()"
      loadingLabel="Loading the upcoming renewals…"
      errorTitle="Couldn't load the upcoming renewals"
      (retry)="renewals.reload()"
    >
      @if (items().length > 0) {
        <a
          cardAction
          routerLink="/subscriptions"
          [queryParams]="selected.linkParams()"
          class="inline-flex min-h-9 items-center gap-1 rounded-control px-3 py-1.5 text-sm font-semibold text-accent hover:bg-subtle"
        >
          Open subscriptions
          <app-icon name="chevron-right" />
        </a>
      }

      @if (renewals.hasValue()) {
        @if (items().length === 0) {
          <app-empty-state
            [title]="'Nothing renews in the next ' + days + ' days'"
            description="Subscriptions show up here a month or so before they are billed."
          >
            <a
              routerLink="/subscriptions"
              [queryParams]="selected.linkParams()"
              class="inline-flex min-h-11 items-center justify-center rounded-control border border-line-strong bg-surface px-4 py-2 text-sm font-semibold text-ink hover:bg-subtle"
            >
              Go to subscriptions
            </a>
          </app-empty-state>
        } @else {
          <ul class="grid grid-cols-1 gap-3 lg:grid-cols-2">
            @for (item of items(); track item.renewal.id) {
              <li
                class="space-y-2 rounded-control border-l-4 border-line-strong bg-subtle p-3"
                [class.ring-2]="item.renewal.yearly"
                [class.ring-accent]="item.renewal.yearly"
                [style.border-left-color]="item.renewal.color"
              >
                <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                  <div class="min-w-0">
                    <h3 class="font-semibold break-words">{{ item.renewal.name }}</h3>
                    <p class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <span class="font-medium">{{ item.until }}</span>
                      <span class="text-muted">{{ item.date }}</span>
                      @if (item.renewal.yearly) {
                        <span
                          class="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent-text ring-1 ring-accent-text/40"
                          >Yearly renewal</span
                        >
                      }
                    </p>
                  </div>
                  <p class="font-semibold">
                    <app-amount [cents]="item.renewal.amount" />
                    <span class="text-sm font-normal text-muted">{{
                      item.renewal.yearly ? ' a year' : ' a month'
                    }}</span>
                  </p>
                </div>

                @if (item.renewal.yearly && item.renewal.reserved !== null) {
                  <app-progress-bar
                    [label]="item.renewal.name + ' reserve'"
                    [percent]="item.percent"
                    [valueText]="item.valueText"
                  />
                  <p class="text-sm">
                    <span class="font-semibold">{{ item.renewal.reserved | money }}</span>
                    of {{ item.renewal.amount | money }} reserved.
                    @if ((item.renewal.unreserved ?? 0) > 0) {
                      <span class="text-muted"
                        >Still to set aside: {{ item.renewal.unreserved ?? 0 | money }}.</span
                      >
                    } @else {
                      <span class="text-muted">Fully reserved.</span>
                    }
                  </p>
                }
              </li>
            }
          </ul>
        }
      }
    </app-dashboard-card>
  `,
  host: { class: 'block' },
})
export class UpcomingRenewalsSection {
  private readonly settings = inject(SettingsStore);
  protected readonly selected = inject(SelectedMonth);

  protected readonly days = UPCOMING_DEFAULT_DAYS;

  protected readonly renewals = inject(SubscriptionsApi).upcoming(
    inject(TodayStore).date,
    UPCOMING_DEFAULT_DAYS,
  );
  protected readonly state = resourceState(this.renewals);

  protected readonly items = computed(() => {
    const locale = this.settings.locale();
    const renewals = this.renewals.hasValue() ? this.renewals.value() : [];
    return renewals.map((renewal) => this.item(renewal, locale));
  });

  private item(renewal: UpcomingRenewalDto, locale: string) {
    // The bar only draws reserved against the price; the figures beside it are the API's.
    const percent =
      renewal.reserved === null || renewal.amount <= 0
        ? 0
        : Math.floor((renewal.reserved * 100) / renewal.amount);
    return {
      renewal,
      until: untilText(renewal.daysUntil),
      date: formatDate(renewal.date, locale, 'day'),
      percent,
      valueText: `${percent}% reserved`,
    };
  }
}
