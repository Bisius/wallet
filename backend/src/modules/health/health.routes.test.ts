import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../testing/test-app';

describe('GET /api/health', () => {
  it('reports ok with the current time', async () => {
    const { app } = createTestApp();
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', time: '2026-01-15T12:00:00.000Z' });
  });

  it('returns a JSON 404 for unknown API routes', async () => {
    const { app } = createTestApp();
    const res = await request(app).get('/api/nope').expect(404);
    expect(res.body.error.code).toBe('not_found');
  });
});
