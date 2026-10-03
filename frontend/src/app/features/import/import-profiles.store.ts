import { computed, inject, Injectable, Injector } from '@angular/core';
import type { ImportProfileDto, ImportProfileInput } from '@wallet/shared';
import { firstValueFrom } from 'rxjs';
import { reloaded, resourceState } from '../../core/resource-state';
import { ImportApi } from './import.api';

/**
 * The saved import profiles (`GET /api/import/profiles`), a named mapping for each bank. Each write
 * sends its request, loads the list again and resolves once the fresh list is in; a failed request
 * rejects with the `HttpErrorResponse`, for the caller to show.
 *
 * Provided by the import page: each visit loads the list fresh.
 */
@Injectable()
export class ImportProfilesStore {
  private readonly api = inject(ImportApi);
  private readonly injector = inject(Injector);
  private readonly resource = this.api.profiles();

  readonly state = resourceState(this.resource);
  /** Why loading failed, while `state()` is `error`. */
  readonly error = computed(() => (this.state() === 'error' ? this.resource.error() : undefined));
  /** Ascending by name, as the API lists them. Empty until loaded. */
  readonly profiles = computed<readonly ImportProfileDto[]>(() =>
    this.resource.hasValue() ? this.resource.value() : [],
  );

  reload(): void {
    this.resource.reload();
  }

  async create(input: ImportProfileInput): Promise<ImportProfileDto> {
    const created = await firstValueFrom(this.api.createProfile(input));
    await reloaded(this.resource, this.injector);
    return created;
  }

  async update(id: number, input: ImportProfileInput): Promise<ImportProfileDto> {
    const updated = await firstValueFrom(this.api.updateProfile(id, input));
    await reloaded(this.resource, this.injector);
    return updated;
  }

  async remove(id: number): Promise<void> {
    await firstValueFrom(this.api.deleteProfile(id));
    await reloaded(this.resource, this.injector);
  }
}
