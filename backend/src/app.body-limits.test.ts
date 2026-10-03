import {
  DEFAULT_BODY_LIMIT_BYTES,
  IMPORT_MAX_BODY_BYTES,
  type PayloadTooLargeDetails,
} from '@wallet/shared';
import type { Express } from 'express';
import request, { type Response } from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  expectApiError,
  expectNotFound,
  expectValidationPaths,
  mutableClock,
  onboard,
} from './testing/helpers';
import { createTestApp } from './testing/test-app';

/**
 * Body limits (docs/DOMAIN.md, "CSV import"): every JSON body is limited to 100 kB except the
 * `/api/import` ones, which may be 10 MiB. A body above the limit of its route is a 413
 * `payload_too_large` in the standard error format with the limit in `details.limitBytes`, and a
 * body that is not JSON is still a 400 `invalid_json`.
 */

/** A JSON body of exactly `bytes` bytes: `{"<key>":"xxxx"}`. */
function jsonOfSize(key: string, bytes: number): string {
  const overhead = Buffer.byteLength(JSON.stringify({ [key]: '' }));
  return JSON.stringify({ [key]: 'x'.repeat(bytes - overhead) });
}

const send = (app: Express, path: string, json: string): Promise<Response> =>
  request(app).post(path).set('Content-Type', 'application/json').send(json);

function expectPayloadTooLarge(res: Response, limitBytes: number): void {
  expectApiError(res, 'payload_too_large');
  expect(res.status).toBe(413);
  expect(res.body.error.details).toEqual({ limitBytes } satisfies PayloadTooLargeDetails);
  expect(res.body.error.message).toContain(String(limitBytes));
}

describe('body limits', () => {
  let app: Express;

  beforeAll(async () => {
    ({ app } = createTestApp(mutableClock('2026-03-15T10:00:00Z')));
    await onboard(app, { startMonth: '2026-01' });
  });

  it('the contract says 100 kB and 10 MiB', () => {
    expect(DEFAULT_BODY_LIMIT_BYTES).toBe(102_400);
    expect(IMPORT_MAX_BODY_BYTES).toBe(10_485_760);
  });

  describe('every endpoint but the import ones: 100 kB', () => {
    it('reads a body of exactly the limit (and then judges it as usual)', async () => {
      const res = await send(app, '/api/tags', jsonOfSize('name', DEFAULT_BODY_LIMIT_BYTES));
      expectValidationPaths(res, 'name'); // read fine; the name is too long
    });

    it('refuses a body one byte over the limit with 413 and the limit in the details', async () => {
      const res = await send(app, '/api/tags', jsonOfSize('name', DEFAULT_BODY_LIMIT_BYTES + 1));
      expectPayloadTooLarge(res, DEFAULT_BODY_LIMIT_BYTES);
    });

    it('refuses a big body on any route, also a PATCH and a PUT, in the same format', async () => {
      const big = jsonOfSize('description', 1_000_000);
      expectPayloadTooLarge(await send(app, '/api/spendings', big), DEFAULT_BODY_LIMIT_BYTES);
      const patch = await request(app)
        .patch('/api/spendings/1')
        .set('Content-Type', 'application/json')
        .send(big);
      expectPayloadTooLarge(patch, DEFAULT_BODY_LIMIT_BYTES);
      const put = await request(app)
        .put('/api/salary/2026-03')
        .set('Content-Type', 'application/json')
        .send(big);
      expectPayloadTooLarge(put, DEFAULT_BODY_LIMIT_BYTES);
    });

    it('refuses a body that is only a little over the limit on a route that does not exist, like the others', async () => {
      // The parser runs before the routes, so the size is judged first.
      expectPayloadTooLarge(
        await send(app, '/api/no-such-route', jsonOfSize('x', DEFAULT_BODY_LIMIT_BYTES + 1)),
        DEFAULT_BODY_LIMIT_BYTES,
      );
    });

    it('does not let a path that only starts like /api/import share the larger limit', async () => {
      const big = jsonOfSize('csv', 1_000_000);
      expectPayloadTooLarge(await send(app, '/api/imports', big), DEFAULT_BODY_LIMIT_BYTES);
    });
  });

  describe('the import endpoints: 10 MiB', () => {
    it('read a body of exactly 10 MiB', async () => {
      const res = await send(app, '/api/import/parse', jsonOfSize('csv', IMPORT_MAX_BODY_BYTES));
      expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(200);
      expect(res.body.recordCount).toBe(1);
    });

    it('refuse a body one byte over 10 MiB with 413 and that limit in the details', async () => {
      const res = await send(
        app,
        '/api/import/parse',
        jsonOfSize('csv', IMPORT_MAX_BODY_BYTES + 1),
      );
      expectPayloadTooLarge(res, IMPORT_MAX_BODY_BYTES);
    });

    it('accept a body far above 100 kB on all three steps and the profiles', async () => {
      const csv = 'date,amount,description\n' + '2026-03-01,-1,A\n'.repeat(60_000); // about 1 MB
      expect(Buffer.byteLength(csv)).toBeGreaterThan(DEFAULT_BODY_LIMIT_BYTES * 8);
      // 60,000 rows is above the 10,000-row limit: a 400 about the rows, not a 413 about the size.
      const mapping = {
        delimiter: ',',
        hasHeader: true,
        dateColumn: 0,
        amountColumn: 1,
        descriptionColumn: 2,
        dateFormat: 'YYYY-MM-DD',
        decimalSeparator: '.',
        signConvention: 'expenses_negative',
      };
      const parse = await request(app).post('/api/import/parse').send({ csv });
      expect(parse.status).toBe(200);
      const preview = await request(app).post('/api/import/preview').send({ csv, mapping });
      expectValidationPaths(preview, 'csv');
      const commit = await request(app)
        .post('/api/import/commit')
        .send({ csv, mapping, rows: [{ line: 2, budgetId: 1 }] });
      expectValidationPaths(commit, 'csv');
      // A profile is small, but the same parser reads it.
      const profile = await request(app)
        .post('/api/import/profiles')
        .send({ name: 'big', mapping, padding: 'x'.repeat(200_000) });
      expectValidationPaths(profile, ''); // read (unknown key), not refused for its size
    });

    it('judge the size before the onboarding guard, as every body parser does', async () => {
      const fresh = createTestApp(mutableClock('2026-03-15T10:00:00Z')).app;
      const small = await send(fresh, '/api/import/parse', JSON.stringify({ csv: 'a' }));
      expectApiError(small, 'not_onboarded');
      const big = await send(
        fresh,
        '/api/import/parse',
        jsonOfSize('csv', IMPORT_MAX_BODY_BYTES + 1),
      );
      expectPayloadTooLarge(big, IMPORT_MAX_BODY_BYTES);
    });
  });

  describe('a body that is not JSON', () => {
    it.each([
      ['/api/tags'],
      ['/api/import/parse'],
      ['/api/import/preview'],
      ['/api/import/commit'],
      ['/api/import/profiles'],
    ])('is still a 400 invalid_json on %s', async (path) => {
      const res = await send(app, path, '{"csv": ');
      expectApiError(res, 'invalid_json');
      expect(res.body.error.message).toBe('Request body is not valid JSON');
      expect(res.body.error.details).toBeUndefined();
    });

    it('is a 400 invalid_json for a plain text body that says it is JSON, big or small', async () => {
      expectApiError(await send(app, '/api/import/parse', 'not json at all'), 'invalid_json');
      expectApiError(await send(app, '/api/tags', 'x'.repeat(50_000)), 'invalid_json');
    });
  });

  it('leaves an unknown route under /api/import a plain 404', async () => {
    expectNotFound(await request(app).get('/api/import/nothing'));
    expectNotFound(await request(app).post('/api/import/nothing').send({}));
  });
});
