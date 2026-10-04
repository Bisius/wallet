import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  importCommitSchema,
  importParseSchema,
  importPreviewSchema,
  importProfileSchema,
} from '@wallet/shared';
import {
  importMapping,
  importProfileDto,
  parseResponse,
  previewResponse,
  previewRow,
} from '../../../testing/fixtures';
import { settle } from '../../../testing/harness';
import { ImportApi } from './import.api';

/** The requests are the contract's: bodies are validated with the contract's own schemas. */
describe('ImportApi', () => {
  let http: HttpTestingController;
  let api: ImportApi;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(ImportApi);
  });

  afterEach(() => http.verify());

  it('parse: POST /api/import/parse with the text, and the delimiter only when it is named', () => {
    const answers: unknown[] = [];
    api.parse({ csv: 'a;b\n1;2\n' }).subscribe((r) => answers.push(r));
    const detected = http.expectOne('/api/import/parse');
    expect(detected.request.method).toBe('POST');
    expect(detected.request.body).toEqual({ csv: 'a;b\n1;2\n' });
    expect(importParseSchema.safeParse(detected.request.body).success).toBe(true);
    detected.flush(parseResponse());

    api.parse({ csv: 'a;b', delimiter: ';' }).subscribe();
    const named = http.expectOne('/api/import/parse');
    expect(named.request.body).toEqual({ csv: 'a;b', delimiter: ';' });
    expect(importParseSchema.safeParse(named.request.body).success).toBe(true);
    named.flush(parseResponse());

    expect(answers).toEqual([parseResponse()]);
  });

  it('preview: POST /api/import/preview with the text and the mapping', () => {
    const body = { csv: 'x', mapping: importMapping() };
    const answers: unknown[] = [];
    api.preview(body).subscribe((r) => answers.push(r));

    const request = http.expectOne('/api/import/preview');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual(body);
    expect(importPreviewSchema.safeParse(request.request.body).success).toBe(true);
    request.flush(previewResponse([previewRow()]));
    expect(answers).toEqual([previewResponse([previewRow()])]);
  });

  it('commit: POST /api/import/commit with the text, the mapping and only line and budgetId per row', () => {
    const body = {
      csv: 'x',
      mapping: importMapping(),
      rows: [
        { line: 2, budgetId: 1 },
        { line: 5, budgetId: 3 },
      ],
    };
    const answers: unknown[] = [];
    api.commit(body).subscribe((r) => answers.push(r));

    const request = http.expectOne('/api/import/commit');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual(body);
    expect(importCommitSchema.safeParse(request.request.body).success).toBe(true);
    request.flush({
      created: 2,
      items: [
        { line: 2, id: 10 },
        { line: 5, id: 11 },
      ],
    });
    expect(answers).toEqual([
      {
        created: 2,
        items: [
          { line: 2, id: 10 },
          { line: 5, id: 11 },
        ],
      },
    ]);
  });

  it('profiles: GET /api/import/profiles as a resource', async () => {
    const resource = TestBed.runInInjectionContext(() => api.profiles());
    await settle();

    const request = http.expectOne('/api/import/profiles');
    expect(request.request.method).toBe('GET');
    request.flush([importProfileDto()]);
    await settle();
    expect(resource.value()).toEqual([importProfileDto()]);
  });

  it('createProfile: POST /api/import/profiles with name, mapping and header', () => {
    const body = {
      name: 'My bank',
      mapping: importMapping(),
      header: ['date', 'amount', 'description'],
    };
    api.createProfile(body).subscribe();

    const request = http.expectOne('/api/import/profiles');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual(body);
    expect(importProfileSchema.safeParse(request.request.body).success).toBe(true);
    request.flush(importProfileDto());
  });

  it('updateProfile: PUT /api/import/profiles/:id with the whole profile', () => {
    const body = { name: 'Renamed', mapping: importMapping(), header: null };
    api.updateProfile(7, body).subscribe();

    const request = http.expectOne('/api/import/profiles/7');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual(body);
    expect(importProfileSchema.safeParse(request.request.body).success).toBe(true);
    request.flush(importProfileDto({ id: 7, name: 'Renamed', header: null }));
  });

  it('deleteProfile: DELETE /api/import/profiles/:id', () => {
    api.deleteProfile(7).subscribe();

    const request = http.expectOne('/api/import/profiles/7');
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
  });
});
