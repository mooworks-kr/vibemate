import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as domain from '../domain.js';
import { createApp } from '../http.js';
import { createTempDb } from './helpers.js';

// Sprint 28 (pax6) — first HTTP smoke test file. CLAUDE.md notes that HTTP
// routes have historically been covered manually; the deletion surface is
// destructive enough that we want a wire-level guard. Pattern: hit the Hono
// app directly with `app.request()` — no `serve()`, no port, no fetch.

let t: ReturnType<typeof createTempDb>;

beforeEach(() => { t = createTempDb(); });
afterEach(() => { t.cleanup(); });

describe('HTTP — project deletion', () => {
  it('GET /api/projects/:id/deletion-impact returns counts', async () => {
    const app = createApp();
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: proj.id, name: 'feat' });
    domain.addTask(f.id, 'task');

    const res = await app.request(`/api/projects/${proj.id}/deletion-impact`);
    expect(res.status).toBe(200);
    const body = await res.json() as { features: number; tasks: number; active_sessions: number };
    expect(body.features).toBe(1);
    expect(body.tasks).toBe(1);
    expect(body.active_sessions).toBe(0);
  });

  it('GET /api/projects/:id/deletion-impact 404 on unknown id', async () => {
    const app = createApp();
    const res = await app.request('/api/projects/nope/deletion-impact');
    expect(res.status).toBe(404);
  });

  it('DELETE /api/projects/:id removes the project (clean state)', async () => {
    const app = createApp();
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });

    const res = await app.request(`/api/projects/${proj.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(domain.getProject(proj.id)).toBeNull();
  });

  it('DELETE /api/projects/:id returns 409 when an active session exists', async () => {
    const app = createApp();
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    domain.startSession({ projectId: proj.id });

    const res = await app.request(`/api/projects/${proj.id}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/active session/i);
    // Project still here.
    expect(domain.getProject(proj.id)).not.toBeNull();
  });

  it('DELETE /api/projects/:id?force=true bypasses active-session guard', async () => {
    const app = createApp();
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    domain.startSession({ projectId: proj.id });

    const res = await app.request(`/api/projects/${proj.id}?force=true`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(domain.getProject(proj.id)).toBeNull();
  });

  it('DELETE /api/projects/:id returns 404 on unknown id', async () => {
    const app = createApp();
    const res = await app.request('/api/projects/nope', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
