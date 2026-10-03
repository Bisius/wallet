import { computed, inject, Injectable, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import {
  filtersFromParams,
  NO_FILTERS,
  paramsFromFilters,
  sameFilters,
  type SpendingFilters,
} from './spending-filters';

/**
 * The query parameter of the "Add spending" shortcut of the installed app: `/spendings?add=1` opens
 * the page with the cursor on the form. It is not a filter, and it is taken out of the address once
 * the form has the cursor.
 */
export const ADD_PARAM = 'add';

/**
 * The filters of the spendings list, kept in the URL next to `?month=`: `?q=coffee&tagId=3&scope=all`.
 * The URL is the one source of truth. The page reads `filters()`, and a change is a navigation, so the
 * browser's back and forward buttons walk through the filters, a reload keeps them, and a link to a
 * filtered list works. Values in the URL that cannot be a filter are ignored (see `filtersFromParams`).
 *
 * Provided by the page, so the bar and the page share it.
 */
@Injectable()
export class SpendingQuery {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });

  /** The filters the URL asks for. The same object while they do not change, so nothing reloads for nothing. */
  readonly filters = computed<SpendingFilters>(
    () => filtersFromParams((name) => this.params().get(name)),
    { equal: sameFilters },
  );

  /** The address asks for the form (`?add=1`): the link of the home-screen shortcut. */
  readonly addRequested = computed(() => this.params().get(ADD_PARAM) === '1');

  /** Ticks each time the filters are cleared, for a box that holds text of its own to empty itself. */
  readonly cleared = signal(0);

  /**
   * Changes some filters, keeping the rest of the URL (the month, the other filters). A change made by
   * typing `replace`s the history entry, so a search does not leave one entry per keystroke; a choice
   * (a budget, a tag, the scope) adds one, and Back undoes it.
   */
  update(patch: Partial<SpendingFilters>, options: { replace?: boolean } = {}): Promise<boolean> {
    return this.router.navigate([], {
      queryParams: paramsFromFilters(patch),
      queryParamsHandling: 'merge',
      replaceUrl: options.replace === true,
    });
  }

  /** Takes `?add=1` out of the address, in place of its history entry, keeping the month and the filters. */
  consumeAdd(): Promise<boolean> {
    return this.router.navigate([], {
      queryParams: { [ADD_PARAM]: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** Turns every filter off, and searching all months too. */
  clear(): Promise<boolean> {
    this.cleared.update((count) => count + 1);
    return this.update(NO_FILTERS);
  }
}
