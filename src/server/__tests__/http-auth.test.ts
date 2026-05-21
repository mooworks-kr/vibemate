import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../http.js';
import { createTempDb } from './helpers.js';

// Sprint 30 (wkq6, ADR-0027) — opt-in bearer auth on /api/*.
// We don't spin up a real port; Hono's `app.request()` runs the middleware
// in-process so the assertions are deterministic.

let t: ReturnType<typeof createTempDb>;
beforeEach(() => { t = createTempDb(); });
afterEach(() => { t.cleanup(); });

describe('HTTP auth — token NOT configured (loopback default)', () => {
  it('allows /api/status without an Authorization header', async () => {
    const app = createApp({ authToken: null });
    const res = await app.request('/api/status');
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('ok');
  });

  it('allows /api/projects without an Authorization header', async () => {
    // Sanity that the middleware doesn't accidentally engage with a falsy
    // empty-string token. Default loopback shouldn't enforce auth.
    const app = createApp({ authToken: '' });
    const res = await app.request('/api/projects');
    expect(res.status).toBe(200);
  });
});

describe('HTTP auth — token configured', () => {
  const TOKEN = 'test-token-deadbeef';

  it('returns 401 when the Authorization header is missing', async () => {
    const app = createApp({ authToken: TOKEN });
    const res = await app.request('/api/status');
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 401 when the token is wrong', async () => {
    const app = createApp({ authToken: TOKEN });
    const res = await app.request('/api/status', {
      headers: { Authorization: 'Bearer not-the-right-token' },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the scheme isn't Bearer", async () => {
    // Be strict on the auth scheme — `Basic` / `Token` / etc. all reject.
    const app = createApp({ authToken: TOKEN });
    const res = await app.request('/api/status', {
      headers: { Authorization: `Token ${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it('passes through with the correct Bearer token', async () => {
    const app = createApp({ authToken: TOKEN });
    const res = await app.request('/api/status', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});
