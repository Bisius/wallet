import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { createDb } from './db/client';
import { fixedClock } from './lib/clock';

/**
 * How the built Angular app is served. The installed app (PWA) depends on it: the service worker
 * script, its manifest of files and the web app manifest must come with the right type, be
 * revalidated on every request, and be allowed by the Content-Security-Policy; and nothing under
 * /api may ever be answered with the app's index.html (the worker has to leave /api alone, and the
 * server must not take over a download or an API error by falling back to the page).
 */
describe('serving the built app', () => {
  let staticDir: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    staticDir = mkdtempSync(join(tmpdir(), 'wallet-static-'));
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Wallet</title>');
    writeFileSync(join(staticDir, 'ngsw.json'), '{"configVersion":1}');
    writeFileSync(join(staticDir, 'ngsw-worker.js'), '// service worker');
    writeFileSync(join(staticDir, 'manifest.webmanifest'), '{"name":"Wallet"}');
    mkdirSync(join(staticDir, 'icons'));
    writeFileSync(join(staticDir, 'icons', 'icon-192x192.png'), 'png');

    const db = createDb(':memory:');
    app = createApp({
      db,
      clock: fixedClock('2026-01-15T12:00:00Z'),
      config: { env: 'test', staticDir },
    });
  });

  afterAll(() => rmSync(staticDir, { recursive: true, force: true }));

  it('serves the web app manifest, the worker and its file list with the right types', async () => {
    const manifest = await request(app).get('/manifest.webmanifest').expect(200);
    expect(manifest.headers['content-type']).toMatch(/^application\/manifest\+json/);

    const files = await request(app).get('/ngsw.json').expect(200);
    expect(files.headers['content-type']).toMatch(/^application\/json/);

    const worker = await request(app).get('/ngsw-worker.js').expect(200);
    expect(worker.headers['content-type']).toMatch(/^(text|application)\/javascript/);

    const icon = await request(app).get('/icons/icon-192x192.png').expect(200);
    expect(icon.headers['content-type']).toBe('image/png');
  });

  it.each(['/ngsw.json', '/ngsw-worker.js', '/manifest.webmanifest', '/index.html', '/spendings'])(
    'revalidates %s on every request and never marks it immutable',
    async (path) => {
      const res = await request(app).get(path).expect(200);
      const cacheControl = String(res.headers['cache-control']);

      expect(cacheControl).toMatch(/max-age=0|no-cache|no-store/);
      expect(cacheControl).not.toMatch(/immutable|max-age=[1-9]/);
      // Revalidation needs a validator.
      expect(res.headers['etag']).toBeTruthy();
    },
  );

  it('opens a route of the app with index.html, so a reload or a shortcut lands on the page', async () => {
    const res = await request(app).get('/spendings?add=1').expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.text).toContain('<title>Wallet</title>');
  });

  it('never answers /api with the app: JSON from the API, JSON errors for what it does not have', async () => {
    const health = await request(app).get('/api/health').expect(200);
    expect(health.headers['content-type']).toMatch(/^application\/json/);
    expect(health.body.status).toBe('ok');

    const missing = await request(app).get('/api/nope').expect(404);
    expect(missing.headers['content-type']).toMatch(/^application\/json/);
    expect(missing.body.error.code).toBe('not_found');
  });

  describe('the Content-Security-Policy', () => {
    /** The sources a directive allows, following the fallbacks the browser uses when it is missing. */
    function allowed(csp: string, directive: string, fallbacks: string[]): string[] {
      const policy = new Map(
        csp
          .split(';')
          .map((part) => part.trim().split(/\s+/))
          .map(([name, ...sources]) => [name, sources] as const),
      );
      for (const name of [directive, ...fallbacks]) {
        const sources = policy.get(name);
        if (sources) return sources;
      }
      return [];
    }

    it('lets the page register its own service worker and read its own manifest', async () => {
      const res = await request(app).get('/').expect(200);
      const csp = String(res.headers['content-security-policy']);

      expect(allowed(csp, 'worker-src', ['child-src', 'script-src', 'default-src'])).toContain(
        "'self'",
      );
      expect(allowed(csp, 'manifest-src', ['default-src'])).toContain("'self'");
      expect(allowed(csp, 'img-src', ['default-src'])).toContain("'self'");
    });

    it('also covers the worker script, whose policy the worker runs under', async () => {
      const res = await request(app).get('/ngsw-worker.js').expect(200);
      const csp = String(res.headers['content-security-policy']);

      // The worker fetches the app's files and the API from its own origin.
      expect(allowed(csp, 'connect-src', ['default-src'])).toContain("'self'");
    });
  });
});
