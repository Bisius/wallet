import { computed, DestroyRef, DOCUMENT, effect, inject, Injectable, signal } from '@angular/core';
import type { Theme } from '@wallet/shared';
import { SettingsStore } from './settings.store';

/** localStorage key read by public/theme-init.js before the first paint. */
export const THEME_STORAGE_KEY = 'wallet.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Applies `settings.theme` to the page: the `dark` class on `<html>` (Tailwind's class strategy).
 * `system` follows the operating system setting live. The settings page can preview a theme before
 * it is saved with `preview()`.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly doc = inject(DOCUMENT);
  private readonly settings = inject(SettingsStore);

  private readonly previewed = signal<Theme | null>(null);
  private readonly systemDark = signal(false);

  /** The theme asked for: the preview if there is one, else the saved setting. */
  readonly preference = computed<Theme>(() => this.previewed() ?? this.settings.theme());

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
      this.doc.documentElement.classList.toggle('dark', this.effective() === 'dark');
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
}
