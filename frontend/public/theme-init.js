/*
 * Runs before first paint (see index.html) so the page never flashes the wrong theme while Angular
 * and GET /api/settings load. ThemeService writes the user's choice ('system' | 'light' | 'dark') to
 * localStorage under the same key whenever it changes. This file must stay a plain external script:
 * the API server's Content-Security-Policy does not allow inline scripts.
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
  } catch (e) {
    /* Storage can be blocked; the app then applies the theme once it has loaded. */
  }
})();
