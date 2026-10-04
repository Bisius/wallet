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
import { AppSection, SectionHelp } from '../../shared/ui/section';
import { Alert } from '../../shared/ui/alert';
import { Button } from '../../shared/ui/button';
import { Icon } from '../../shared/ui/icon';
import { KeyValue, KeyValues } from '../../shared/ui/key-values';
import { LinkButton } from '../../shared/ui/link-button';
import { AppList, ListRow } from '../../shared/ui/list';
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
 * done outside the app, which the section's help says: there is no restore button.
 *
 * It is a block of the "Data" section of the settings, so its heading is a level 3 one (still a named
 * region).
 */
@Component({
  selector: 'app-backups-section',
  imports: [
    AppList,
    AppSection,
    Alert,
    Button,
    EmptyState,
    ErrorState,
    Icon,
    KeyValue,
    KeyValues,
    LinkButton,
    ListRow,
    LoadingState,
    SectionHelp,
  ],
  template: `
    <app-section
      level="3"
      landmark
      heading="Backups"
      description="A complete copy of your database, made while the app keeps running."
    >
      <p sectionHelp>
        A backup holds all your data, so keep it private. To restore one, stop the app and follow
        the steps in the README under “Backups and restore”: they move the old database aside before
        the backup is copied in. There is no restore button.
      </p>

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
            <dl appKeyValues>
              <div appKeyValue label="Automatic backups">
                @if (info.automatic) {
                  On: one a day, and one when the app starts if the last is older than a day.
                } @else {
                  Off: this server has no backup folder.
                }
              </div>
              <div appKeyValue label="Last backup">
                {{ info.lastBackupAt ? when(info.lastBackupAt) : 'None yet' }}
              </div>
              @if (info.nextDueAt) {
                <div appKeyValue label="Next due">
                  {{ when(info.nextDueAt) }}
                  <span class="text-muted"
                    >(a time that has passed means it runs at the next check)</span
                  >
                </div>
              }
            </dl>

            @if (!info.automatic) {
              <app-alert tone="warning">{{ unavailable }}</app-alert>
            }

            <div class="flex flex-col items-start gap-2">
              <button
                #backUp
                appButton
                [loading]="making()"
                [disabled]="!info.automatic"
                [attr.aria-describedby]="info.automatic ? 'backup-same-day-note' : null"
                (click)="backUpNow()"
              >
                Back up now
              </button>
              @if (info.automatic) {
                <p id="backup-same-day-note" class="text-sm text-muted">
                  Only the newest backup of each day is kept, so a second one on the same day
                  replaces the first. Download the one you want to keep before making another.
                </p>
              }
            </div>

            @if (failure(); as problem) {
              <app-alert tone="error">
                @if (problem.unavailable) {
                  <strong class="font-semibold">Backups are not available on this server.</strong>
                  {{ unavailable }}
                } @else {
                  <strong class="font-semibold">The backup was not made.</strong>
                  {{ problem.message }}
                }
              </app-alert>
            }

            @if (info.backups.length === 0) {
              <app-empty-state
                title="No backups yet"
                description="The first one is made when you press Back up now, or by the daily schedule."
              />
            } @else {
              <ul appList aria-label="Backups, newest first">
                @for (backup of info.backups; track backup.name) {
                  <li appListRow actionsBelow>
                    <span rowTitle>{{ when(backup.createdAt) }}</span>
                    <p rowMeta>
                      <span class="break-all"
                        >{{ backup.name }} · {{ size(backup.sizeBytes) }}</span
                      >
                    </p>
                    <a
                      rowActions
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
    </app-section>
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
      this.failure.set({
        unavailable: parsed.code === 'backups_unavailable',
        message: parsed.message,
      });
    } finally {
      this.making.set(false);
      // The button was disabled while the request was out, which took focus away: give it back.
      afterNextRender(() => this.backUp()?.nativeElement.focus(), { injector: this.injector });
    }
  }
}
