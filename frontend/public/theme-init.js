/*
 * Runs before first paint (see index.html) so the page never flashes the wrong theme while Angular
 * and GET /api/settings load. ThemeService writes the user's choice ('system' | 'light' | 'dark') to
 * localStorage under the same key whenever it changes. This file must stay a plain external script:
 * the API server's Content-Security-Policy does not allow inline scripts.
 *
 * It sets the `dark` class of <html> and the colour of <meta name="theme-color"> (the browser's
 * toolbar) for the theme that is in effect. The two colours are the `--color-surface` of each theme
 * in src/styles.css, the colour of the page header, and they are repeated in THEME_COLORS of
 * src/app/core/theme.service.ts.
 */
(function () {
  try {
    var choice = localStorage.getItem('wallet.theme');
    var dark =
      choice === 'dark' ||
      (choice !== 'light' &&
        typeof matchMedia === 'function' &&
        matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
    var toolbar = document.querySelector('meta[name="theme-color"]');
    if (toolbar) toolbar.setAttribute('content', dark ? '#0f172a' : '#ffffff');
  } catch (e) {
    /* Storage can be blocked; the app then applies the theme once it has loaded. */
  }
})();
