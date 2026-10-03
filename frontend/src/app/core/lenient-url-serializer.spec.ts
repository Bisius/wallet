import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlSerializer } from '@angular/router';
import { settle, StubPage } from '../../testing/harness';
import { LenientUrlSerializer } from './lenient-url-serializer';

describe('LenientUrlSerializer', () => {
  const serializer = new LenientUrlSerializer();

  it('reads an address as the router does', () => {
    const tree = serializer.parse('/spendings?q=caf%C3%A9&tagId=3#top');

    expect(serializer.serialize(tree)).toBe('/spendings?q=caf%C3%A9&tagId=3#top');
    expect(tree.queryParams).toEqual({ q: 'café', tagId: '3' });
  });

  it('keeps the page when the query cannot be decoded: a % that starts no escape', () => {
    expect(serializer.serialize(serializer.parse('/spendings?q=50%'))).toBe('/spendings');
    expect(serializer.serialize(serializer.parse('/spendings?q=%E0%A4%A&month=2026-09'))).toBe(
      '/spendings',
    );
    expect(serializer.serialize(serializer.parse('/budgets?month=2026-09#%'))).toBe('/budgets');
  });

  it('still refuses an address whose path cannot be read, so the router falls back to /', () => {
    expect(() => serializer.parse('/spend%ings')).toThrow();
    expect(() => serializer.parse('/spend%ings?q=ok')).toThrow();
  });

  describe('in the router', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            { path: 'dashboard', component: StubPage },
            { path: 'spendings', component: StubPage },
          ]),
          { provide: UrlSerializer, useClass: LenientUrlSerializer },
        ],
      });
    });

    it('opens the Spendings page for a link whose search ends in a raw %, not the Dashboard', async () => {
      const router = TestBed.inject(Router);

      await router.navigateByUrl('/spendings?q=50%');
      await settle();

      expect(router.url).toBe('/spendings');
    });
  });
});
