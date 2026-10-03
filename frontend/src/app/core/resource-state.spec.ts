import { httpResource, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { flushError, settle } from '../../testing/harness';
import { reloaded, resourceState } from './resource-state';

describe('resource state', () => {
  let http: HttpTestingController;
  let injector: Injector;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    injector = TestBed.inject(Injector);
  });

  afterEach(() => http.verify());

  const create = (url: () => string | undefined = () => '/api/thing') =>
    TestBed.runInInjectionContext(() => httpResource<string>(url));

  describe('resourceState', () => {
    it('is loading until there is a value, ready after, and error when the request failed', async () => {
      const failing = create(() => '/api/failing');
      const working = create(() => '/api/working');
      const failingState = TestBed.runInInjectionContext(() => resourceState(failing));
      const workingState = TestBed.runInInjectionContext(() => resourceState(working));
      await settle();
      expect(workingState()).toBe('loading');

      http.expectOne('/api/working').flush('ok');
      flushError(http.expectOne('/api/failing'), 500, 'internal_error', 'Boom');
      await settle();

      expect(workingState()).toBe('ready');
      expect(failingState()).toBe('error');
    });

    it('stays ready while the resource reloads with its value: the page keeps showing the data', async () => {
      const resource = create();
      const state = TestBed.runInInjectionContext(() => resourceState(resource));
      await settle();
      http.expectOne('/api/thing').flush('one');
      await settle();

      resource.reload();
      await settle();

      expect(state()).toBe('ready');
      http.expectOne('/api/thing').flush('two');
    });
  });

  describe('reloaded', () => {
    it('loads the resource again and resolves once the fresh answer is in', async () => {
      const resource = create();
      await settle();
      http.expectOne('/api/thing').flush('before');
      await settle();

      let resolved = false;
      const done = reloaded(resource, injector).then(() => (resolved = true));
      await settle();
      expect(resolved).toBe(false);

      http.expectOne('/api/thing').flush('after');
      await settle();
      await done;
      expect(resolved).toBe(true);
      expect(resource.value()).toBe('after');
    });

    it('reloads once more when a load was already running, because that one may predate the change', async () => {
      const resource = create();
      await settle();
      http.expectOne('/api/thing').flush('first');
      await settle();

      // Another reload is in flight: it was sent before the change we are about to reload for.
      resource.reload();
      await settle();
      const stale = http.expectOne('/api/thing');

      let resolved = false;
      const done = reloaded(resource, injector).then(() => (resolved = true));
      await settle();
      stale.flush('stale');
      await settle();

      // The stale answer is not trusted: a second request goes out, and only its answer counts.
      expect(resolved).toBe(false);
      http.expectOne('/api/thing').flush('fresh');
      await settle();
      await done;
      expect(resource.value()).toBe('fresh');
    });

    it('resolves when the reload fails, leaving the error in the resource', async () => {
      const resource = create();
      await settle();
      http.expectOne('/api/thing').flush('before');
      await settle();

      const done = reloaded(resource, injector);
      await settle();
      flushError(http.expectOne('/api/thing'), 500, 'internal_error', 'Boom');
      await settle();
      await done;

      expect(resource.status()).toBe('error');
    });

    it('resolves at once for a resource that has nothing to load', async () => {
      const resource = create(() => undefined);
      await settle();

      await reloaded(resource, injector);

      http.expectNone('/api/thing');
      expect(resource.status()).toBe('idle');
    });

    it('follows the resource it was given when its parameters have changed', async () => {
      const id = signal(1);
      const resource = create(() => `/api/thing/${id()}`);
      await settle();
      http.expectOne('/api/thing/1').flush('one');
      await settle();

      id.set(2);
      await settle();
      http.expectOne('/api/thing/2').flush('two');
      await settle();
      const done = reloaded(resource, injector);
      await settle();
      http.expectOne('/api/thing/2').flush('two again');
      await settle();
      await done;

      expect(resource.value()).toBe('two again');
    });
  });
});
