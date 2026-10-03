import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Theme } from '@wallet/shared';
import { primeStores, SETTINGS, settle } from '../../testing/harness';
import { THEME_STORAGE_KEY, ThemeService } from './theme.service';

/** A controllable `prefers-color-scheme: dark` media query. */
function fakeSystemTheme(initiallyDark: boolean) {
  let dark = initiallyDark;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    get matches() {
      return dark;
    },
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.delete(listener),
  } as unknown as MediaQueryList;
  const original = window.matchMedia;
  window.matchMedia = () => query;
  return {
    set(value: boolean) {
      dark = value;
      listeners.forEach((listener) => listener({ matches: value } as MediaQueryListEvent));
    },
    restore: () => (window.matchMedia = original),
  };
}

describe('ThemeService', () => {
  let http: HttpTestingController;
  let root: HTMLElement;
  let system: ReturnType<typeof fakeSystemTheme>;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    root = TestBed.inject(DOCUMENT).documentElement;
    root.classList.remove('dark');
    system = fakeSystemTheme(false);
  });

  afterEach(() => {
    system.restore();
    root.classList.remove('dark');
    localStorage.clear();
    http.verify();
  });

  async function start(theme: Theme | null) {
    const service = TestBed.inject(ThemeService);
    await primeStores(
      http,
      theme === null ? { settings: null } : { settings: { ...SETTINGS, theme } },
    );
    await settle();
    return service;
  }

  it('applies a dark theme as the "dark" class on <html>', async () => {
    await start('dark');
    expect(root.classList.contains('dark')).toBe(true);
  });

  it('applies a light theme without it, whatever the system prefers', async () => {
    system.set(true);
    await start('light');
    expect(root.classList.contains('dark')).toBe(false);
  });

  it('follows the system for "system", and keeps following it', async () => {
    const service = await start('system');
    expect(root.classList.contains('dark')).toBe(false);
    expect(service.effective()).toBe('light');

    system.set(true);
    await settle();
    expect(root.classList.contains('dark')).toBe(true);
    expect(service.effective()).toBe('dark');

    system.set(false);
    await settle();
    expect(root.classList.contains('dark')).toBe(false);
  });

  it('starts dark when the system is dark and the theme is "system"', async () => {
    system.restore();
    system = fakeSystemTheme(true);
    await start('system');
    expect(root.classList.contains('dark')).toBe(true);
  });

  it('shows a previewed theme without saving it, and goes back when the preview ends', async () => {
    const service = await start('light');

    service.preview('dark');
    await settle();
    expect(root.classList.contains('dark')).toBe(true);
    expect(service.preference()).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    service.preview(null);
    await settle();
    expect(root.classList.contains('dark')).toBe(false);
  });

  it('follows a saved change of the theme', async () => {
    const { settings } = await primeStores(http);
    TestBed.inject(ThemeService);
    await settle();
    expect(root.classList.contains('dark')).toBe(false);

    settings.seed({ ...SETTINGS, theme: 'dark' });
    await settle();
    expect(root.classList.contains('dark')).toBe(true);
  });

  describe('remembering the choice for the next load (theme-init.js)', () => {
    it('stores the saved theme once the settings have loaded', async () => {
      await start('dark');
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    });

    it('does not overwrite it with the fallback before the settings have loaded', async () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'dark');
      TestBed.inject(ThemeService);
      await settle();
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
      http.expectOne('/api/settings').flush(SETTINGS);
    });

    it('leaves it alone when not onboarded', async () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'dark');
      await start(null);
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    });
  });
});
