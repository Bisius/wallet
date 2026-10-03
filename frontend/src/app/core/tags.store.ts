import { HttpClient, httpResource } from '@angular/common/http';
import { computed, DestroyRef, DOCUMENT, inject, Injectable, Injector } from '@angular/core';
import type { TagCreateInput, TagDto, TagUpdateInput } from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { reloaded, resourceState } from './resource-state';
import { SettingsStore } from './settings.store';

// The comparison the API sorts the list with and decides "the same name" by (docs/DOMAIN.md, "Tags
// and search"): `Groceries` and `groceries` are one name, `Café` and `Cafe` are two.
const nameCollator = new Intl.Collator('en', { sensitivity: 'accent' });

/** Whether the API would call these two names the same (ignoring case, surrounding spaces too). */
export function sameTagName(a: string, b: string): boolean {
  return nameCollator.compare(a.trim(), b.trim()) === 0;
}

/**
 * The tags (`GET /api/tags`) as signals, and the writes that keep the list fresh. Spendings refer to
 * tags by id, so this one list gives every name and color in the app: the chips on the spendings, the
 * tag input, the filter and the Settings section all read it, and they never disagree.
 *
 * Nothing is requested before the settings exist (a first-run user gets `not_onboarded`). Each write
 * (`create`, `update`, `remove`) sends its request, then loads the list again and resolves once the
 * fresh list is in; a failed request rejects with the `HttpErrorResponse`, for the caller to show.
 * The list is also loaded again when the tab becomes visible, because another tab may have changed it.
 */
@Injectable({ providedIn: 'root' })
export class TagsStore {
  private readonly http = inject(HttpClient);
  private readonly settings = inject(SettingsStore);
  private readonly injector = inject(Injector);
  private readonly resource = httpResource<TagDto[]>(() =>
    this.settings.onboarded() ? '/api/tags' : undefined,
  );

  readonly state = resourceState(this.resource);
  /** Why loading failed, while `state()` is `error`. */
  readonly error = computed(() => (this.state() === 'error' ? this.resource.error() : undefined));
  /** Ascending by name ignoring case, as the API lists them. Empty until loaded. */
  readonly tags = computed<readonly TagDto[]>(() =>
    this.resource.hasValue() ? this.resource.value() : [],
  );
  readonly byId = computed<ReadonlyMap<number, TagDto>>(
    () => new Map(this.tags().map((tag) => [tag.id, tag])),
  );

  constructor() {
    const doc = inject(DOCUMENT);
    const refresh = () => {
      if (!doc.hidden && this.state() === 'ready') this.resource.reload();
    };
    doc.addEventListener('visibilitychange', refresh);
    inject(DestroyRef).onDestroy(() => doc.removeEventListener('visibilitychange', refresh));
  }

  /**
   * Fetches the list again in the background; the old list stays until the new one arrives. Does
   * nothing while a load is under way. For a page that shows `usageCount`, which changes whenever a
   * spending is added, edited or deleted, without the tags themselves being touched.
   */
  refresh(): void {
    if (this.settings.onboarded()) this.resource.reload();
  }

  /** Fetches the list again and resolves once the fresh answer is in (a failed reload also counts). */
  reload(): Promise<void> {
    return reloaded(this.resource, this.injector);
  }

  /** `POST /api/tags`. 409 `tag_name_taken` when another tag has the name, ignoring case. */
  async create(input: TagCreateInput): Promise<TagDto> {
    const created = await firstValueFrom(this.http.post<TagDto>('/api/tags', input));
    await this.reload();
    return created;
  }

  /** `PATCH /api/tags/:id`: a new name and/or color (`null` clears the color). */
  async update(id: number, input: TagUpdateInput): Promise<TagDto> {
    const updated = await firstValueFrom(this.http.patch<TagDto>(`/api/tags/${id}`, input));
    await this.reload();
    return updated;
  }

  /** `DELETE /api/tags/:id`: the spendings that carry it stay, without it. */
  async remove(id: number): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`/api/tags/${id}`));
    await this.reload();
  }
}
