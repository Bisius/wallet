import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { flushError, primeStores, settle, StubPage } from '../../testing/harness';
import { notOnboardedInterceptor } from './not-onboarded.interceptor';

describe('notOnboardedInterceptor', () => {
  let http: HttpTestingController;
  let client: HttpClient;
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'onboarding', component: StubPage },
          { path: 'income', component: StubPage },
        ]),
        provideHttpClient(withInterceptors([notOnboardedInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    client = TestBed.inject(HttpClient);
    router = TestBed.inject(Router);
  });

  afterEach(() => http.verify());

  it('goes to onboarding on a 409 not_onboarded, and the caller still gets the error', async () => {
    const { settings } = await primeStores(http);
    await router.navigateByUrl('/income');

    const result = firstValueFrom(client.get('/api/budgets'));
    flushError(http.expectOne('/api/budgets'), 409, 'not_onboarded', 'Finish onboarding first');

    await expect(result).rejects.toMatchObject({ status: 409 });
    await settle();
    expect(settings.state()).toBe('not-onboarded');
    expect(router.url).toBe('/onboarding');
  });

  it('leaves other conflicts alone', async () => {
    const { settings } = await primeStores(http);
    await router.navigateByUrl('/income');

    const result = firstValueFrom(client.delete('/api/budgets/3'));
    flushError(http.expectOne('/api/budgets/3'), 409, 'has_history', 'Archive it instead');

    await expect(result).rejects.toMatchObject({ status: 409 });
    await settle();
    expect(settings.state()).toBe('onboarded');
    expect(router.url).toBe('/income');
  });

  it('leaves server errors and successful responses alone', async () => {
    const { settings } = await primeStores(http);
    await router.navigateByUrl('/income');

    const ok = firstValueFrom(client.get('/api/budgets'));
    http.expectOne('/api/budgets').flush([]);
    await expect(ok).resolves.toEqual([]);

    const failed = firstValueFrom(client.get('/api/budgets'));
    flushError(http.expectOne('/api/budgets'), 500, 'internal_error', 'Boom');
    await expect(failed).rejects.toMatchObject({ status: 500 });

    await settle();
    expect(settings.state()).toBe('onboarded');
    expect(router.url).toBe('/income');
  });
});
