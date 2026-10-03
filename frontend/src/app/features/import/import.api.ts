import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  ImportCommitInput,
  ImportCommitResponse,
  ImportParseInput,
  ImportParseResponse,
  ImportPreviewInput,
  ImportPreviewResponse,
  ImportProfileDto,
  ImportProfileInput,
} from '@wallet/shared';
import type { Observable } from 'rxjs';

/**
 * `/api/import`: the CSV importer. It is stateless: every call carries the whole text of the file,
 * and the server is the only reader of it (the UI never parses a row). Bodies may be up to 10 MiB.
 */
@Injectable({ providedIn: 'root' })
export class ImportApi {
  private readonly http = inject(HttpClient);

  /** `POST /api/import/parse`: the delimiter, the first records and the profile that fits. Writes nothing. */
  parse(input: ImportParseInput): Observable<ImportParseResponse> {
    return this.http.post<ImportParseResponse>('/api/import/parse', input);
  }

  /** `POST /api/import/preview`: every data row of the file judged under the mapping. Writes nothing. */
  preview(input: ImportPreviewInput): Observable<ImportPreviewResponse> {
    return this.http.post<ImportPreviewResponse>('/api/import/preview', input);
  }

  /** `POST /api/import/commit`: stores the listed rows, all or nothing (422 `import_rows_rejected`). */
  commit(input: ImportCommitInput): Observable<ImportCommitResponse> {
    return this.http.post<ImportCommitResponse>('/api/import/commit', input);
  }

  /** `GET /api/import/profiles`, ascending by name. Create it where a resource may be created. */
  profiles(): HttpResourceRef<ImportProfileDto[] | undefined> {
    return httpResource<ImportProfileDto[]>(() => '/api/import/profiles');
  }

  /** `POST /api/import/profiles` (409 `import_profile_name_taken`). */
  createProfile(input: ImportProfileInput): Observable<ImportProfileDto> {
    return this.http.post<ImportProfileDto>('/api/import/profiles', input);
  }

  /** `PUT /api/import/profiles/:id`: replaces the whole profile, so every field is sent. */
  updateProfile(id: number, input: ImportProfileInput): Observable<ImportProfileDto> {
    return this.http.put<ImportProfileDto>(`/api/import/profiles/${id}`, input);
  }

  /** `DELETE /api/import/profiles/:id` */
  deleteProfile(id: number): Observable<void> {
    return this.http.delete<void>(`/api/import/profiles/${id}`);
  }
}
