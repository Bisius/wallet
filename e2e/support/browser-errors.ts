import type { BrowserContext } from '@playwright/test';

/**
 * Something the browser reported that no user should ever trigger: a `console.error` (which is also
 * where Chromium logs a failed `fetch`, such as "Failed to load resource: ... status of 404") or an
 * uncaught exception.
 */
export interface BrowserErrorEntry {
  kind: 'console' | 'pageerror';
  text: string;
  /** For an uncaught exception, where it was thrown. */
  stack?: string;
  /** For a console message, the script or resource it points at (for a failed request, its URL). */
  url?: string;
  /** The address of the page when it happened. */
  page: string;
}

/**
 * Tells the guard that a message is expected. A `RegExp` is tested against the message text; with an
 * object, every given part must match (a string part must be contained in the text or the URL).
 */
export type BrowserErrorMatcher = RegExp | { text?: string | RegExp; url?: string | RegExp };

/**
 * The browser's own log of a response with this status, for a request whose URL matches: what
 * Chromium prints when a page's `fetch` gets a 4xx or 5xx. Pass it to `allowedConsoleErrors` (or
 * `browserErrors.allow`) where the app is expected to see one, for example the 404 that
 * `GET /api/settings` answers before onboarding:
 *
 *     test.use({ allowedConsoleErrors: [failedResponse(404, /\/api\/settings$/)] });
 */
export function failedResponse(status: number, url: RegExp): BrowserErrorMatcher {
  return { text: new RegExp(`status of ${status}\\b`), url };
}

function matches(part: string | RegExp | undefined, value: string | undefined): boolean {
  if (part === undefined) return true;
  if (value === undefined) return false;
  return typeof part === 'string' ? value.includes(part) : part.test(value);
}

function allows(matcher: BrowserErrorMatcher, entry: BrowserErrorEntry): boolean {
  if (matcher instanceof RegExp) return matcher.test(entry.text);
  return matches(matcher.text, entry.text) && matches(matcher.url, entry.url);
}

/**
 * Collects the console errors and uncaught exceptions of every page of a browser context, so that a
 * test fails on one instead of passing over a broken page. The `wallet` fixtures do the wiring: use
 * the `browserErrors` fixture to allow an expected message for one test, and the
 * `allowedConsoleErrors` and `failOnConsoleErrors` options (`test.use`) for a whole file.
 */
export class BrowserErrors {
  private readonly allowed: BrowserErrorMatcher[];
  private readonly seen: BrowserErrorEntry[] = [];

  constructor(allowed: readonly BrowserErrorMatcher[] = []) {
    this.allowed = [...allowed];
  }

  /** Starts listening to every page of the context, now and later. */
  watch(context: BrowserContext): void {
    context.on('console', (message) => {
      if (message.type() !== 'error') return;
      this.seen.push({
        kind: 'console',
        text: message.text(),
        url: message.location().url || undefined,
        page: message.page()?.url() ?? '',
      });
    });
    context.on('weberror', (webError) => {
      const error = webError.error();
      this.seen.push({
        kind: 'pageerror',
        text: error.message,
        stack: error.stack,
        page: webError.page()?.url() ?? '',
      });
    });
  }

  /** Expects these messages for the rest of the test: they no longer count. */
  allow(...matchers: BrowserErrorMatcher[]): void {
    this.allowed.push(...matchers);
  }

  /** Everything seen so far, allowed or not. */
  get all(): readonly BrowserErrorEntry[] {
    return this.seen;
  }

  /** What was seen so far and is not allowed. */
  get unexpected(): BrowserErrorEntry[] {
    return this.seen.filter((entry) => !this.allowed.some((matcher) => allows(matcher, entry)));
  }

  /** Throws, listing every unexpected message, if there is one. */
  assertNone(): void {
    const unexpected = this.unexpected;
    if (unexpected.length === 0) return;
    const lines = unexpected.map((entry) => {
      const where = entry.url ? ` (${entry.url})` : '';
      const head = `  [${entry.kind}] ${entry.text}${where} on ${entry.page || 'no page'}`;
      // The first line of a stack repeats the message.
      const stack = (entry.stack ?? '').split('\n').slice(1).join('\n');
      return stack ? `${head}\n${stack}` : head;
    });
    throw new Error(
      `The browser reported ${unexpected.length} error(s) that no test expected:\n${lines.join('\n')}\n` +
        'If one is expected, allow it with `browserErrors.allow(...)` or the `allowedConsoleErrors` option.',
    );
  }
}
