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
import { AsyncSection } from '../../shared/ui/async-section';
import { Badge } from '../../shared/ui/badge';
import { LinkButton } from '../../shared/ui/link-button';
import { AppList, ListRow } from '../../shared/ui/list';
import { ProgressBar } from '../../shared/ui/progress-bar';
import { SectionHelp } from '../../shared/ui/section';
import { SeeAllLink } from '../../shared/ui/see-all-link';
import { EmptyState } from '../../shared/ui/states';
import { SubscriptionsApi } from '../subscriptions/subscriptions.api';

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
  imports: [
    Amount,
    AppList,
    AsyncSection,
    Badge,
    EmptyState,
    LinkButton,
    ListRow,
    MoneyPipe,
    ProgressBar,
    RouterLink,
    SectionHelp,
    SeeAllLink,
  ],
  template: `
    <app-async-section
      heading="Upcoming renewals"
      [description]="'Subscriptions billed in the next ' + days + ' days.'"
      [state]="state()"
      [error]="renewals.error()"
      loadingLabel="Loading the upcoming renewals…"
      errorTitle="Couldn't load the upcoming renewals"
      (retry)="renewals.reload()"
    >
      @if (items().length > 0) {
        <app-see-all-link
          sectionAction
          route="/subscriptions"
          what="subscriptions"
          [queryParams]="selected.linkParams()"
        />
      }
      @if (items().length > 0) {
        <p sectionHelp>
          Whichever month you are looking at. A yearly renewal shows how much of its price is
          already set aside.
        </p>
      }

      @if (renewals.hasValue()) {
        @if (items().length === 0) {
          <app-empty-state
            [title]="'Nothing renews in the next ' + days + ' days'"
            description="Subscriptions show up here a month or so before they are billed."
          >
            <a appLinkButton routerLink="/subscriptions" [queryParams]="selected.linkParams()">
              Go to subscriptions
            </a>
          </app-empty-state>
        } @else {
          <ul appList density="compact">
            @for (item of items(); track item.renewal.id) {
              <li
                appListRow
                [color]="item.renewal.color"
                [amountNote]="item.renewal.yearly ? 'a year' : 'a month'"
              >
                <span rowTitle>{{ item.renewal.name }}</span>
                <p rowMeta>
                  <span class="font-medium text-ink">{{ item.until }}</span>
                  <span>{{ item.date }}</span>
                  @if (item.renewal.yearly) {
                    <app-badge tone="accent">Yearly renewal</app-badge>
                  }
                </p>
                <app-amount rowAmount [cents]="item.renewal.amount" />

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
    </app-async-section>
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
