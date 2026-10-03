import {
  computed,
  DestroyRef,
  effect,
  inject,
  Injectable,
  Injector,
  signal,
  untracked,
} from '@angular/core';
import type { GoalDto, SavingsTransactionDto } from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import { reloaded, resourceState } from '../../core/resource-state';
import { SavingsStore } from '../../core/savings.store';
import { type HistoryFilter, NO_HISTORY_FILTER, SavingsApi } from './savings.api';

/** What every place that holds no goal is called. */
export const UNASSIGNED_LABEL = 'Unassigned savings';

/** Rows that "Load more" added to the first page, for the filter they belong to. */
interface Extras {
  key: string;
  rows: SavingsTransactionDto[];
}

const NO_EXTRAS: Extras = { key: '', rows: [] };

const keyOf = (filter: HistoryFilter) => `${filter.place}|${filter.kind ?? ''}`;

/**
 * What the Savings page reads: the overview (`SavingsStore`, shared with the navigation badge and
 * the Dashboard), the opening balance and the history. It is provided by the page, so the opening
 * balance and the history live and die with it (each visit loads fresh data) and every block of the
 * page shares them instead of asking again.
 *
 * Each source has a state of its own, so one failing request only takes down the block that needs
 * it. After anything changed on the server, `reload()` loads all of them again.
 */
@Injectable()
export class SavingsData {
  private readonly store = inject(SavingsStore);
  private readonly api = inject(SavingsApi);
  private readonly injector = inject(Injector);
  private destroyed = false;

  // --- the overview ----------------------------------------------------------------------------

  readonly state = this.store.state;
  readonly error = this.store.error;
  /** The balance, the goals and the months to settle, as the API computed them. */
  readonly savings = this.store.savings;

  /** Every goal by id, archived ones too: the history names them. */
  private readonly goalsById = computed(
    () => new Map<number, GoalDto>((this.savings()?.goals ?? []).map((goal) => [goal.id, goal])),
  );

  /** Loads the overview again, for the retry button of its error state. The rest of the page is not asked again. */
  reloadOverview(): Promise<void> {
    return this.store.reload();
  }

  /** Where money sits, in words: the goal's name, or "Unassigned savings" for no goal. */
  placeName(goalId: number | null): string {
    if (goalId === null) return UNASSIGNED_LABEL;
    return this.goalsById().get(goalId)?.name ?? 'a deleted goal';
  }

  // --- the opening balance ---------------------------------------------------------------------

  readonly opening = this.api.opening();
  readonly openingState = resourceState(this.opening);
  readonly openingValue = computed(() =>
    this.opening.hasValue() ? this.opening.value() : undefined,
  );

  // --- the history -----------------------------------------------------------------------------

  readonly filter = signal<HistoryFilter>(NO_HISTORY_FILTER);
  readonly history = this.api.firstPage(this.filter);
  readonly historyState = resourceState(this.history);

  private readonly extras = signal<Extras>(NO_EXTRAS);
  readonly loadingMore = signal(false);
  readonly moreError = signal<string | null>(null);

  /** Every row loaded so far: the first page, then what "Load more" added. */
  readonly rows = computed<readonly SavingsTransactionDto[]>(() => {
    const head = this.history.hasValue() ? this.history.value().items : [];
    const extras = this.extras();
    return extras.key === keyOf(this.filter()) ? [...head, ...extras.rows] : head;
  });
  /** How many rows match the filter. */
  readonly total = computed(() => (this.history.hasValue() ? this.history.value().total : 0));
  readonly hasMore = computed(() => this.rows().length < this.total());
  readonly filtered = computed(() => {
    const { place, kind } = this.filter();
    return place !== 'all' || kind !== null;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.destroyed = true));

    // A goal the history is limited to can be deleted meanwhile: its entries moved to unassigned
    // savings, so the filter would match nothing and its picker would show a place that is gone.
    effect(() => {
      const goals = this.savings()?.goals;
      const { place } = this.filter();
      if (goals && typeof place === 'number' && !goals.some((goal) => goal.id === place)) {
        untracked(() => this.setFilter({ ...this.filter(), place: 'all' }));
      }
    });
  }

  setFilter(filter: HistoryFilter): void {
    this.filter.set(filter);
    this.extras.set(NO_EXTRAS);
    this.moreError.set(null);
  }

  /**
   * Something changed on the server: load the overview, the opening balance and the history (from
   * its first page) again. Safe to call after the page is gone (an "Undo" on a toast outlives it):
   * then only the shared overview is loaded.
   */
  async reload(): Promise<void> {
    if (this.destroyed) {
      await this.store.reload();
      return;
    }
    this.extras.set(NO_EXTRAS);
    this.moreError.set(null);
    await Promise.all([
      this.store.reload(),
      reloaded(this.opening, this.injector),
      reloaded(this.history, this.injector),
    ]);
  }

  /** Appends the next page of the history to what is shown. */
  async loadMore(): Promise<void> {
    if (this.loadingMore()) return;
    const filter = this.filter();
    const key = keyOf(filter);

    this.loadingMore.set(true);
    this.moreError.set(null);
    try {
      const page = await firstValueFrom(this.api.pageAt(filter, this.rows().length));
      // The filter changed while the page was coming: it is not for this list.
      if (keyOf(this.filter()) !== key) return;
      if (page.items.length === 0) {
        // The list got shorter on the server since it was loaded: start again.
        await this.reload();
        return;
      }
      this.extras.update((extras) => ({
        key,
        rows: [...(extras.key === key ? extras.rows : []), ...page.items],
      }));
    } catch (error) {
      this.moreError.set(parseApiError(error).message);
    } finally {
      this.loadingMore.set(false);
    }
  }
}
