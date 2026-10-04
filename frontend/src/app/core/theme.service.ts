import { computed, DestroyRef, DOCUMENT, effect, inject, Injectable, signal } from '@angular/core';
import type { Theme } from '@wallet/shared';
import { SettingsStore } from './settings.store';

/** localStorage key read by public/theme-init.js before the first paint. */
export const THEME_STORAGE_KEY = 'wallet.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The choice that the last visit remembered (`'system'` too), or null when there is none. */
function rememberedTheme(doc: Document): Theme | null {
  try {
    const value = doc.defaultView?.localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' || value === 'system' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The colour of the browser's toolbar for each theme: the page header's colour, which is
 * `--color-surface` in styles.css. public/theme-init.js sets the same two before the first paint.
 */
export const THEME_COLORS = { light: '#ffffff', dark: '#0f172a' } as const;

/**
 * Applies `settings.theme` to the page: the `dark` class on `<html>` (Tailwind's class strategy) and
 * the toolbar colour (`<meta name="theme-color">`) of the theme in effect, which is not always the
 * one the operating system prefers. `system` follows the operating system setting live. The settings
 * page can preview a theme before it is saved with `preview()`.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly doc = inject(DOCUMENT);
  private readonly settings = inject(SettingsStore);

  private readonly previewed = signal<Theme | null>(null);
  private readonly systemDark = signal(false);
  /**
   * What theme-init.js applied before the first paint. It stands in for the saved setting until
   * `GET /api/settings` has answered, so the page does not switch to the system theme for that
   * moment and back (a flash for whoever chose a theme other than their system's).
   */
  private readonly remembered = rememberedTheme(this.doc);

  /** The theme asked for: the preview if there is one, else the saved setting. */
  readonly preference = computed<Theme>(
    () => this.previewed() ?? this.settings.settings()?.theme ?? this.remembered ?? 'system',
  );

  /** The theme actually shown. */
  readonly effective = computed<'light' | 'dark'>(() => {
    const preference = this.preference();
    if (preference === 'system') return this.systemDark() ? 'dark' : 'light';
    return preference;
  });

  constructor() {
    const media = this.doc.defaultView?.matchMedia?.(DARK_QUERY);
    if (media) {
      this.systemDark.set(media.matches);
      const onChange = (event: MediaQueryListEvent) => this.systemDark.set(event.matches);
      media.addEventListener('change', onChange);
      inject(DestroyRef).onDestroy(() => media.removeEventListener('change', onChange));
    }

    effect(() => {
      const theme = this.effective();
      this.doc.documentElement.classList.toggle('dark', theme === 'dark');
      this.showToolbarColor(THEME_COLORS[theme]);
    });

    // Remember the saved choice (never a preview) for theme-init.js, which applies it before first
    // paint on the next load. Only once the settings exist, so the fallback never overwrites it.
    effect(() => {
      const saved = this.settings.settings()?.theme;
      if (!saved) return;
      try {
        this.doc.defaultView?.localStorage.setItem(THEME_STORAGE_KEY, saved);
      } catch {
        // Storage can be blocked. The theme still applies once the settings have loaded.
      }
    });
  }

  /** Shows a theme without saving it. `null` goes back to the saved one. */
  preview(theme: Theme | null): void {
    this.previewed.set(theme);
  }

  /** Sets the one `<meta name="theme-color">` of the page (index.html has it), adding it if missing. */
  private showToolbarColor(color: string): void {
    let meta = this.doc.head.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = this.doc.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      this.doc.head.append(meta);
    }
    meta.setAttribute('content', color);
  }
}
