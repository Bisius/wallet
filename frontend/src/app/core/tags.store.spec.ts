import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { TagDto } from '@wallet/shared';
import { flushError, primeStores, settle, TODAY } from '../../testing/harness';
import { tagDto } from '../../testing/fixtures';
import { sameTagName, TagsStore } from './tags.store';

const GROCERIES = tagDto({ id: 1, name: 'Groceries', color: '#15803d', usageCount: 4 });
const TRAVEL = tagDto({ id: 2, name: 'Travel', usageCount: 0 });

describe('sameTagName', () => {
  it.each([
    ['Groceries', 'groceries', true],
    ['Groceries', 'GROCERIES', true],
    ['  Groceries ', 'groceries', true],
    ['Café', 'CAFÉ', true],
    // Accents tell names apart, as in the API: "Café" and "Cafe" are two tags.
    ['Café', 'Cafe', false],
    ['Groceries', 'Grocery', false],
    ['', 'x', false],
  ])('%j and %j: %s', (a, b, expected) => {
    expect(sameTagName(a, b)).toBe(expected);
  });
});

describe('TagsStore', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  /** Starts the app onboarded, creates the store and answers its first request. */
  async function setup(tags: TagDto[] = [GROCERIES, TRAVEL]) {
    await primeStores(http);
    const store = TestBed.inject(TagsStore);
    await settle();
    http.expectOne('/api/tags').flush(tags);
    await settle();
    return store;
  }

  it('does not ask before the settings exist: a first-run user would get not_onboarded', async () => {
    await primeStores(http, { settings: null });
    const store = TestBed.inject(TagsStore);
    await settle();

    http.expectNone('/api/tags');
    expect(store.tags()).toEqual([]);
  });

  it('holds the tags in the order the API gave them, and by id', async () => {
    const store = await setup();

    expect(store.state()).toBe('ready');
    expect(store.tags().map((tag) => tag.name)).toEqual(['Groceries', 'Travel']);
    expect(store.byId().get(2)?.name).toBe('Travel');
    expect(store.byId().get(99)).toBeUndefined();
  });

  it('is loading until the list arrives, and empty meanwhile', async () => {
    await primeStores(http);
    const store = TestBed.inject(TagsStore);
    await settle();

    expect(store.state()).toBe('loading');
    expect(store.tags()).toEqual([]);
    http.expectOne('/api/tags').flush([GROCERIES]);
    await settle();
    expect(store.state()).toBe('ready');
  });

  it('says why the list could not be loaded', async () => {
    await primeStores(http);
    const store = TestBed.inject(TagsStore);
    await settle();
    flushError(http.expectOne('/api/tags'), 500, 'internal_error', 'No tag table');
    await settle();

    expect(store.state()).toBe('error');
    expect(store.error()).toBeTruthy();
  });

  describe('writing', () => {
    it('creates a tag with POST, then loads the list again and hands back what the API stored', async () => {
      const store = await setup();

      const created = store.create({ name: 'Holiday', color: '#2563eb' });
      await settle();
      const post = http.expectOne('/api/tags');
      expect(post.request.method).toBe('POST');
      expect(post.request.body).toEqual({ name: 'Holiday', color: '#2563eb' });
      post.flush(tagDto({ id: 3, name: 'Holiday', color: '#2563eb' }), {
        status: 201,
        statusText: 'Created',
      });
      await settle();
      // The list is loaded again, and the call resolves only once the fresh list is in.
      http
        .expectOne('/api/tags')
        .flush([GROCERIES, tagDto({ id: 3, name: 'Holiday', color: '#2563eb' }), TRAVEL]);

      expect((await created).id).toBe(3);
      expect(store.tags().map((tag) => tag.name)).toEqual(['Groceries', 'Holiday', 'Travel']);
    });

    it('renames and recolors with PATCH, and clears a color with null', async () => {
      const store = await setup();

      const renamed = store.update(1, { name: 'Food', color: null });
      await settle();
      const patch = http.expectOne('/api/tags/1');
      expect(patch.request.method).toBe('PATCH');
      expect(patch.request.body).toEqual({ name: 'Food', color: null });
      patch.flush({ ...GROCERIES, name: 'Food', color: null });
      await settle();
      http.expectOne('/api/tags').flush([{ ...GROCERIES, name: 'Food', color: null }, TRAVEL]);

      await renamed;
      expect(store.byId().get(1)?.name).toBe('Food');
      expect(store.byId().get(1)?.color).toBeNull();
    });

    it('deletes with DELETE and loads the list again', async () => {
      const store = await setup();

      const removed = store.remove(2);
      await settle();
      const request = http.expectOne('/api/tags/2');
      expect(request.request.method).toBe('DELETE');
      request.flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      http.expectOne('/api/tags').flush([GROCERIES]);

      await removed;
      expect(store.tags().map((tag) => tag.name)).toEqual(['Groceries']);
    });

    it('rejects with the API error, for the caller to show, and does not load the list again', async () => {
      const store = await setup();

      const created = store.create({ name: 'groceries' });
      const outcome = created.then(
        () => 'created',
        (error: unknown) => error,
      );
      await settle();
      flushError(
        http.expectOne('/api/tags'),
        409,
        'tag_name_taken',
        'A tag named "groceries" already exists',
      );
      await settle();

      expect(await outcome).toMatchObject({ status: 409 });
    });
  });

  describe('refresh', () => {
    it('loads the list again in the background and keeps showing the old one meanwhile', async () => {
      const store = await setup();

      store.refresh();
      await settle();

      expect(store.state()).toBe('ready');
      expect(store.tags()).toHaveLength(2);
      http.expectOne('/api/tags').flush([GROCERIES, { ...TRAVEL, usageCount: 9 }]);
      await settle();
      expect(store.byId().get(2)?.usageCount).toBe(9);
    });

    it('does not ask again while the list is still loading', async () => {
      await primeStores(http);
      const store = TestBed.inject(TagsStore);
      await settle();

      store.refresh();
      await settle();

      http.expectOne('/api/tags').flush([GROCERIES]);
      await settle();
      expect(store.tags()).toHaveLength(1);
    });

    it('does nothing before the settings exist', async () => {
      await primeStores(http, { settings: null });
      const store = TestBed.inject(TagsStore);

      store.refresh();
      await settle();

      http.expectNone('/api/tags');
    });
  });

  it('loads the list again when the tab becomes visible, because another tab may have changed it', async () => {
    const store = await setup();
    const doc = TestBed.inject(DOCUMENT);

    doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    // Today's date is refreshed on the same event.
    http.expectOne('/api/today').flush(TODAY);
    http.expectOne('/api/tags').flush([GROCERIES, TRAVEL, tagDto({ id: 3, name: 'New' })]);
    await settle();

    expect(store.tags()).toHaveLength(3);
  });
});
