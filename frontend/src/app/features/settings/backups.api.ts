import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { BackupDto, BackupsDto } from '@wallet/shared';
import type { Observable } from 'rxjs';

/** `/api/backups`: copies of the database file. Restoring is done outside the app. */
@Injectable({ providedIn: 'root' })
export class BackupsApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/backups`: the backups newest first and the state of the automatic ones. */
  list(): HttpResourceRef<BackupsDto | undefined> {
    return httpResource<BackupsDto>(() => '/api/backups');
  }

  /** `POST /api/backups` (no body): makes a backup now. 409 `backups_unavailable` without a backup folder. */
  create(): Observable<BackupDto> {
    return this.http.post<BackupDto>('/api/backups', null);
  }

  /** The address of a backup's download, `GET /api/backups/:name`, for a plain `<a download>`. */
  downloadUrl(name: string): string {
    return `/api/backups/${encodeURIComponent(name)}`;
  }
}
