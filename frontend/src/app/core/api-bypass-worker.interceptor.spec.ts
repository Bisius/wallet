import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { apiBypassWorkerInterceptor, WORKER_BYPASS_HEADER } from './api-bypass-worker.interceptor';

describe('apiBypassWorkerInterceptor', () => {
  let http: HttpTestingController;
  let client: HttpClient;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([apiBypassWorkerInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    client = TestBed.inject(HttpClient);
  });

  afterEach(() => http.verify());

  it.each(['/api/health', '/api/spendings?month=2026-10', '/api'])(
    'tells the service worker to leave %s alone',
    (url) => {
      client.get(url).subscribe();

      const request = http.expectOne((candidate) => candidate.urlWithParams === url);
      expect(request.request.headers.get(WORKER_BYPASS_HEADER)).toBe('true');
      request.flush({});
    },
  );

  it('does it for writes too', () => {
    client.post('/api/spendings', {}).subscribe();

    const request = http.expectOne('/api/spendings');
    expect(request.request.headers.get(WORKER_BYPASS_HEADER)).toBe('true');
    request.flush({});
  });

  it.each(['/spendings', '/apiary', '/assets/api/x.json'])(
    'leaves a request for %s as it is',
    (url) => {
      client.get(url).subscribe();

      const request = http.expectOne(url);
      expect(request.request.headers.has(WORKER_BYPASS_HEADER)).toBe(false);
      request.flush({});
    },
  );
});
