import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  signal,
} from '@angular/core';
import type { MonthSubscriptionLine, SubscriptionDto, SubscriptionStatus } from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import { reloaded, resourceState } from '../../core/resource-state';
import { SelectedMonth } from '../../core/selected-month';
import { SettingsStore } from '../../core/settings.store';
import { TodayStore } from '../../core/today.store';
import { formatMonth } from '../../shared/format';
import { PageHeader } from '../../shared/page-header';
import { Amount } from '../../shared/ui/amount';
import { Button } from '../../shared/ui/button';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { Icon } from '../../shared/ui/icon';
import { MonthStatusBadge } from '../../shared/ui/month-status';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/states';
import { ToastService } from '../../shared/ui/toast.service';
import { MonthsApi } from '../months/months.api';
import { PriceForm } from './price-form';
import { SubscriptionCard } from './subscription-card';
import { SubscriptionForm } from './subscription-form';
import { SubscriptionsApi } from './subscriptions.api';

interface Section {
  status: SubscriptionStatus;
  title: string;
  description: string;
}

const SECTIONS: readonly Section[] = [
  { status: 'active', title: 'Active', description: 'Charged now, or until the end month shown.' },
  { status: 'upcoming', title: 'Upcoming', description: 'Not charged yet: they start later.' },
  {
    status: 'cancelled',
    title: 'Cancelled',
    description: 'No longer charged. The months they were charged in keep their figures.',
  },
];

/**
 * The subscriptions: active, upcoming and cancelled ones, with their prices and renewals. For the
 * selected month it also says how much of each yearly renewal is already set aside, from the month
 * view (`GET /api/months/:month`). The page shows what the API reports and sends requests; the
 * reserve, the renewals and the fixed costs are the ledger's.
 */
@Component({
  selector: 'app-subscriptions-page',
  imports: [
    PageHeader,
    Amount,
    Button,
    Icon,
    MonthStatusBadge,
    EmptyState,
    ErrorState,
    LoadingState,
    SubscriptionCard,
    SubscriptionForm,
    PriceForm,
  ],
  templateUrl: './subscriptions-page.html',
})
export class SubscriptionsPage {
  private readonly api = inject(SubscriptionsApi);
  private readonly settings = inject(SettingsStore);
  private readonly today = inject(TodayStore);
  private readonly confirm = inject(ConfirmService);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly month = inject(SelectedMonth).month;

  // Resources belong to the page: each visit loads fresh data.
  protected readonly view = inject(MonthsApi).view(this.month);
  protected readonly subscriptions = this.api.list();

  protected readonly viewState = resourceState(this.view);
  protected readonly listState = resourceState(this.subscriptions);

  protected readonly monthView = computed(() =>
    this.view.hasValue() ? this.view.value() : undefined,
  );
  protected readonly list = computed(() =>
    this.subscriptions.hasValue() ? this.subscriptions.value() : undefined,
  );

  protected readonly monthLabel = computed(() => {
    const month = this.month();
    return month ? formatMonth(month, this.settings.locale()) : '';
  });

  /** The month's line for each subscription that is charged in it, by subscription id. */
  private readonly lines = computed(
    () => new Map((this.monthView()?.subscriptions ?? []).map((line) => [line.id, line])),
  );

  /** The sections that have something in them, in the order active, upcoming, cancelled. */
  protected readonly sections = computed(() => {
    const all = this.list() ?? [];
    return SECTIONS.map((section) => ({
      ...section,
      items: all.filter((subscription) => subscription.status === section.status),
    })).filter((section) => section.items.length > 0);
  });

  /** The dialog that is open: adding, editing, or changing a price. `null` while none is. */
  protected readonly dialog = signal<
    | { kind: 'form'; subscription: SubscriptionDto | undefined }
    | { kind: 'price'; subscription: SubscriptionDto }
    | null
  >(null);

  protected lineOf(subscription: SubscriptionDto): MonthSubscriptionLine | undefined {
    return this.lines().get(subscription.id);
  }

  protected closeDialog(): void {
    this.dialog.set(null);
  }

  /** Something changed on the server: load what this page shows again. */
  protected async reload(): Promise<void> {
    await Promise.all([
      reloaded(this.subscriptions, this.injector),
      reloaded(this.view, this.injector),
    ]);
  }

  protected async cancel(subscription: SubscriptionDto): Promise<void> {
    const current = this.today.month();
    const last = current ? formatMonth(current, this.settings.locale()) : 'this month';
    const confirmed = await this.confirm.confirm({
      title: `Cancel "${subscription.name}"?`,
      message:
        `It is still charged through ${last}, its last month, and not after. ` +
        (subscription.frequency === 'yearly'
          ? 'Whatever you have set aside for its next renewal goes back to savings. '
          : '') +
        "The months it was charged in keep their figures. You can't undo this.",
      confirmLabel: 'Cancel subscription',
      cancelLabel: 'Keep subscription',
    });
    if (!confirmed) return;

    try {
      await firstValueFrom(this.api.cancel(subscription.id));
      this.toast.success(`${subscription.name} cancelled. It is charged through ${last}.`);
      await this.reload();
      // The Cancel button that had focus is gone: go back to the card.
      this.focus(() => this.byAction(`edit-${subscription.id}`));
    } catch (error) {
      this.toast.error(parseApiError(error).message);
      await this.reload();
    }
  }

  protected async remove(subscription: SubscriptionDto): Promise<void> {
    const confirmed = await this.confirm.confirm({
      title: `Delete "${subscription.name}" for good?`,
      message:
        'Deleting removes it from every month, including months that are already closed. Their ' +
        'fixed costs change, and so does what was due to savings. If you only want to stop paying ' +
        'for it, cancel it instead: that keeps the past as it was.',
      confirmLabel: 'Delete from every month',
      cancelLabel: 'Keep subscription',
      tone: 'danger',
    });
    if (!confirmed) return;

    try {
      await firstValueFrom(this.api.remove(subscription.id));
      this.toast.success(`${subscription.name} deleted.`);
      await this.reload();
      // The card that had focus is gone: the page title is the nearest stable place.
      this.focus(() => this.host.nativeElement.querySelector<HTMLElement>('h1'));
    } catch (error) {
      this.toast.error(parseApiError(error).message);
      await this.reload();
    }
  }

  private byAction(action: string): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>(`[data-action="${action}"]`);
  }

  private focus(find: () => HTMLElement | null): void {
    afterNextRender(() => find()?.focus(), { injector: this.injector });
  }
}
