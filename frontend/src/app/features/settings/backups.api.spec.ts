import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { backupDto, backupsDto } from '../../../testing/fixtures';
import { settle } from '../../../testing/harness';
import { BackupsApi } from './backups.api';

describe('BackupsApi', () => {
  let http: HttpTestingController;
  let api: BackupsApi;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(BackupsApi);
  });

  afterEach(() => http.verify());

  it('list: GET /api/backups as a resource', async () => {
    const resource = TestBed.runInInjectionContext(() => api.list());
    await settle();

    const request = http.expectOne('/api/backups');
    expect(request.request.method).toBe('GET');
    request.flush(backupsDto({ backups: [backupDto()] }));
    await settle();
    expect(resource.value()?.backups).toEqual([backupDto()]);
  });

  it('create: POST /api/backups with no body', () => {
    const answers: unknown[] = [];
    api.create().subscribe((backup) => answers.push(backup));

    const request = http.expectOne('/api/backups');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toBeNull();
    request.flush(backupDto());
    expect(answers).toEqual([backupDto()]);
  });

  it('downloadUrl: /api/backups/:name', () => {
    expect(api.downloadUrl('wallet-20261003-142530.db')).toBe(
      '/api/backups/wallet-20261003-142530.db',
    );
  });
});
