import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { parseApiError } from '../../core/api-error';
import { reloaded, resourceState } from '../../core/resource-state';
import { SettingsStore } from '../../core/settings.store';
import { formatBytes, formatDateTime } from '../../shared/format';
import { Button } from '../../shared/ui/button';
import { Icon } from '../../shared/ui/icon';
import { LinkButton } from '../../shared/ui/link-button';
import { EmptyState, ErrorState, LoadingState } from '../../shared/ui/states';
import { ToastService } from '../../shared/ui/toast.service';
import { BackupsApi } from './backups.api';

/** Why the last "Back up now" did not work. `unavailable` is the server having no backup folder. */
interface Failure {
  unavailable: boolean;
  message: string;
}

const UNAVAILABLE =
  'This server has no backup folder, so it cannot make backups. Set BACKUP_DIR (or run it with a ' +
  'database file instead of the in-memory one) and restart the app.';

/**
 * The backups of the database (`GET /api/backups`): whether the automatic ones are on, when the last
 * one was made and when the next is due, a "Back up now" button (`POST /api/backups`) and the files,
 * newest first, each with a plain download link. A backup holds all the data, and restoring one is
 * done outside the app, which the section says in one line: there is no restore button.
 */
@Component({
  selector: 'app-backups-section',
  imports: [Button, EmptyState, ErrorState, Icon, LinkButton, LoadingState],
  template: `
    <section aria-labelledby="backups-heading" class="card space-y-4">
      <div>
        <h2 id="backups-heading" tabindex="-1" class="text-lg font-semibold">Backups</h2>
        <p class="mt-1 text-sm text-muted">
          A backup is a complete copy of your database, made while the app keeps running.
        </p>
      </div>

      @switch (state()) {
        @case ('loading') {
          <app-loading-state label="Loading backups…" />
        }
        @case ('error') {
          <app-error-state
            title="Couldn't load the backups"
            [error]="backups.error()"
            (retry)="backups.reload()"
          />
        }
        @default {
          @if (data(); as info) {
            <dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
              <dt class="font-medium">Automatic backups</dt>
              <dd>
                @if (info.automatic) {
                  On: one a day, and one when the app starts if the last is older than a day.
                } @else {
                  Off: this server has no backup folder.
                }
              </dd>
              <dt class="font-medium">Last backup</dt>
              <dd>{{ info.lastBackupAt ? when(info.lastBackupAt) : 'None yet' }}</dd>
              @if (info.nextDueAt) {
                <dt class="font-medium">Next due</dt>
                <dd>
                  {{ when(info.nextDueAt) }}
                  <span class="text-muted">(a time that has passed means it runs at the next check)</span>
                </dd>
              }
            </dl>

            @if (!info.automatic) {
              <p class="rounded-control border border-line-strong bg-subtle p-3 text-sm">
                {{ unavailable }}
              </p>
            }

            <div class="flex flex-wrap items-center gap-3">
              <button
                #backUp
                appButton
                [loading]="making()"
                [disabled]="!info.automatic"
                (click)="backUpNow()"
              >
                Back up now
              </button>
            </div>

            @if (failure(); as problem) {
              <p
                role="alert"
                class="flex items-start gap-2 rounded-control border border-negative bg-negative-soft p-3 text-sm text-ink"
              >
                <app-icon name="alert" class="mt-0.5 text-negative" />
                <span>
                  @if (problem.unavailable) {
                    <strong class="font-semibold">Backups are not available on this server.</strong>
                    {{ unavailable }}
                  } @else {
                    <strong class="font-semibold">The backup was not made.</strong>
                    {{ problem.message }}
                  }
                </span>
              </p>
            }

            @if (info.backups.length === 0) {
              <app-empty-state
                title="No backups yet"
                description="The first one is made when you press Back up now, or by the daily schedule."
              />
            } @else {
              <ul aria-label="Backups, newest first" class="divide-y divide-line rounded-card border border-line">
                @for (backup of info.backups; track backup.name) {
                  <li class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 p-3">
                    <div class="min-w-0 flex-1">
                      <p class="font-medium">{{ when(backup.createdAt) }}</p>
                      <p class="text-sm break-all text-muted">
                        {{ backup.name }} · {{ size(backup.sizeBytes) }}
                      </p>
                    </div>
                    <a
                      appLinkButton
                      variant="ghost"
                      size="sm"
                      download
                      [href]="url(backup.name)"
                      [attr.aria-label]="'Download the backup of ' + when(backup.createdAt)"
                    >
                      <app-icon name="download" />
                      Download
                    </a>
                  </li>
                }
              </ul>
            }
          }
        }
      }

      <p class="text-sm text-muted">
        A backup holds all your data, so keep it private. To restore one, stop the app, copy the
        backup over the database file, delete the <code>-wal</code> and <code>-shm</code> files next
        to it, and start the app again. There is no restore button.
      </p>
    </section>
  `,
  host: { class: 'block' },
})
export class BackupsSection {
  private readonly api = inject(BackupsApi);
  private readonly settings = inject(SettingsStore);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  // `read`: the button is a component (`appButton`), so without it the query returns that instance.
  private readonly backUp = viewChild('backUp', { read: ElementRef<HTMLElement> });

  protected readonly backups = this.api.list();
  protected readonly state = resourceState(this.backups);
  protected readonly data = computed(() =>
    this.backups.hasValue() ? this.backups.value() : undefined,
  );
  protected readonly unavailable = UNAVAILABLE;

  protected readonly making = signal(false);
  protected readonly failure = signal<Failure | null>(null);

  protected when(iso: string): string {
    return formatDateTime(iso, this.settings.locale());
  }

  protected size(bytes: number): string {
    return formatBytes(bytes, this.settings.locale());
  }

  protected url(name: string): string {
    return this.api.downloadUrl(name);
  }

  protected async backUpNow(): Promise<void> {
    if (this.making()) return;
    this.making.set(true);
    this.failure.set(null);
    try {
      const made = await firstValueFrom(this.api.create());
      this.toast.success(`Backup made: ${made.name}.`);
      await reloaded(this.backups, this.injector);
    } catch (error) {
      const parsed = parseApiError(error);
      this.failure.set({ unavailable: parsed.code === 'backups_unavailable', message: parsed.message });
    } finally {
      this.making.set(false);
      // The button was disabled while the request was out, which took focus away: give it back.
      afterNextRender(() => this.backUp()?.nativeElement.focus(), { injector: this.injector });
    }
  }
}
