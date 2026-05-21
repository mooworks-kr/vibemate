import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../http.js';
import { loadConfig, saveConfig } from '../config.js';
import { createTempDb } from './helpers.js';

// Sprint 31 (v5ln / ADR-0028) — settings panel endpoints. Each test gets its
// own throwaway config file under os.tmpdir() (passed via createApp's
// `configPath` opt) so the developer's ~/.vibemate/config.json stays clean.

let t: ReturnType<typeof createTempDb>;
let tmpDir: string;
let configPath: string;

beforeEach(() => {
  t = createTempDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibemate-cfg-test-'));
  configPath = path.join(tmpDir, 'config.json');
});

afterEach(() => {
  t.cleanup();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('GET /api/config', () => {
  it('returns defaults when no config file exists yet', async () => {
    const app = createApp({ configPath });
    const res = await app.request('/api/config');
    expect(res.status).toBe(200);
    const body = await res.json() as { server: { host: string; hasToken: boolean }; remote: { url: string | null; hasToken: boolean } };
    expect(body).toEqual({
      server: { host: '127.0.0.1', hasToken: false },
      remote: { url: null, hasToken: false },
    });
  });

  it('exposes server.hasToken without leaking the token bytes', async () => {
    saveConfig({ server: { token: 'super-secret-32-bytes-or-whatever' } }, configPath);
    const app = createApp({ configPath });
    const res = await app.request('/api/config');
    const body = await res.json() as { server: { hasToken: boolean }; [k: string]: unknown };
    expect(body.server.hasToken).toBe(true);
    // Belt-and-braces: a regression that returns the full token would
    // show up in the JSON payload — sanity check against any field.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('super-secret');
  });

  it('exposes remote.url as-is + remote.hasToken (no token leak)', async () => {
    saveConfig({
      remote: { url: 'http://100.x.y.z:7321', token: 'remote-secret' },
    }, configPath);
    const app = createApp({ configPath });
    const res = await app.request('/api/config');
    const body = await res.json() as { remote: { url: string | null; hasToken: boolean } };
    expect(body.remote.url).toBe('http://100.x.y.z:7321');
    expect(body.remote.hasToken).toBe(true);
    expect(JSON.stringify(body)).not.toContain('remote-secret');
  });
});

describe('PUT /api/config/remote', () => {
  it('sets the remote pair atomically (enter remote mode)', async () => {
    const app = createApp({ configPath });
    const res = await app.request('/api/config/remote', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://homeserver:7321', token: 'tk-deadbeef' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { remote: { url: string | null; hasToken: boolean } };
    expect(body.remote.url).toBe('http://homeserver:7321');
    expect(body.remote.hasToken).toBe(true);
    // Persistence: file on disk holds the real token, even though wire
    // shape masks it.
    expect(loadConfig(configPath).remote).toEqual({
      url: 'http://homeserver:7321',
      token: 'tk-deadbeef',
    });
  });

  it('clears both fields with { url: null, token: null } (exit remote mode)', async () => {
    saveConfig({ remote: { url: 'http://x:7321', token: 't' } }, configPath);
    const app = createApp({ configPath });
    const res = await app.request('/api/config/remote', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: null, token: null }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { remote: { url: string | null; hasToken: boolean } };
    expect(body.remote.url).toBeNull();
    expect(body.remote.hasToken).toBe(false);
  });

  it('rejects partial null (url string + token null) as 400', async () => {
    const app = createApp({ configPath });
    const res = await app.request('/api/config/remote', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://x:7321', token: null }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/both/i);
  });

  it('rejects partial null (url null + token string) as 400', async () => {
    const app = createApp({ configPath });
    const res = await app.request('/api/config/remote', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: null, token: 'tk' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a body missing required keys (e.g. only url)', async () => {
    const app = createApp({ configPath });
    const res = await app.request('/api/config/remote', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://x:7321' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON as 400', async () => {
    const app = createApp({ configPath });
    const res = await app.request('/api/config/remote', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/config/test-remote', () => {
  it('reports ok=true / status=200 / latency when the remote responds 200', async () => {
    // Stub fetch — returns a Response-like with .status = 200.
    const fakeFetch = (async () => new Response('{"status":"ok"}', { status: 200 })) as unknown as typeof fetch;
    const app = createApp({ configPath, fetchImpl: fakeFetch });
    const res = await app.request('/api/config/test-remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://homeserver:7321', token: 'tk' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; status: number; latency_ms: number };
    expect(body.ok).toBe(true);
    expect(body.status).toBe(200);
    expect(typeof body.latency_ms).toBe('number');
  });

  it('reports ok=false / status=401 when the remote rejects the token', async () => {
    const fakeFetch = (async () => new Response('{"error":"Unauthorized"}', { status: 401 })) as unknown as typeof fetch;
    const app = createApp({ configPath, fetchImpl: fakeFetch });
    const res = await app.request('/api/config/test-remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://homeserver:7321', token: 'wrong' }),
    });
    expect(res.status).toBe(200); // 200 wrapping a structured "ok=false"
    const body = await res.json() as { ok: boolean; status: number };
    expect(body.ok).toBe(false);
    expect(body.status).toBe(401);
  });

  it('reports ok=false / status=null / error when the connection fails', async () => {
    const fakeFetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const app = createApp({ configPath, fetchImpl: fakeFetch });
    const res = await app.request('/api/config/test-remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://nope:7321', token: 'tk' }),
    });
    const body = await res.json() as { ok: boolean; status: number | null; error?: string };
    expect(body.ok).toBe(false);
    expect(body.status).toBeNull();
    expect(body.error).toMatch(/ECONNREFUSED/);
  });

  it('sends Bearer token + hits <url>/api/status (strips trailing slash)', async () => {
    let capturedUrl: string | null = null;
    let capturedAuth: string | null = null;
    const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const app = createApp({ configPath, fetchImpl: fakeFetch });
    await app.request('/api/config/test-remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://homeserver:7321/', token: 'tk-xyz' }),
    });
    // Trailing slash must be stripped so we hit `…/api/status`, not `…//api/status`.
    expect(capturedUrl).toBe('http://homeserver:7321/api/status');
    expect(capturedAuth).toBe('Bearer tk-xyz');
  });

  it('omits the Authorization header when no token is supplied', async () => {
    let capturedAuth: string | null = null;
    const fakeFetch = (async (_input: string | URL, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const app = createApp({ configPath, fetchImpl: fakeFetch });
    await app.request('/api/config/test-remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://homeserver:7321' }),
    });
    expect(capturedAuth).toBeNull();
  });
});

describe('config endpoints — auth middleware integration', () => {
  // The new routes live under /api/* and therefore inherit the same
  // Bearer-token enforcement as the rest of the surface. We don't add
  // separate exemptions; assertions here lock that in.
  const TOKEN = 'local-auth-token';

  it('GET /api/config requires Authorization when authToken is set', async () => {
    const app = createApp({ configPath, authToken: TOKEN });
    const denied = await app.request('/api/config');
    expect(denied.status).toBe(401);
    const allowed = await app.request('/api/config', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(allowed.status).toBe(200);
  });

  it('PUT /api/config/remote requires Authorization when authToken is set', async () => {
    const app = createApp({ configPath, authToken: TOKEN });
    const denied = await app.request('/api/config/remote', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: null, token: null }),
    });
    expect(denied.status).toBe(401);
  });
});
