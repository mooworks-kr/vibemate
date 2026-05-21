import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as domain from '../domain.js';
import { createApp } from '../http.js';
import { createTempDb } from './helpers.js';

// Sprint 30 (wkq6, ADR-0027) — POST /api/mcp/:tool dispatches against the
// MCP tool registry shared with the stdio MCP server. We verify a handful
// of representative tools (read / write / unknown) so an HTTP-side
// regression in the dispatch wiring fails fast.

let t: ReturnType<typeof createTempDb>;
beforeEach(() => { t = createTempDb(); });
afterEach(() => { t.cleanup(); });

describe('HTTP MCP passthrough — POST /api/mcp/:tool', () => {
  it('dispatches pm_search (read tool) and returns the MCP result envelope', async () => {
    const app = createApp();
    const proj = domain.createProject({ name: 'P-pass', rootPath: t.dir });
    domain.createFeature({ projectId: proj.id, name: 'searchable feature' });

    const res = await app.request('/api/mcp/pm_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: proj.id, query: 'searchable' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { content: Array<{ type: string; text: string }> };
    expect(Array.isArray(body.content)).toBe(true);
    // The pm_search formatter prefixes "<n>건 매칭:" — exercises the
    // text-mode path of the registry (not just okResult/JSON).
    expect(body.content[0]!.text).toMatch(/매칭/);
  });

  it('dispatches pm_create_feature (write tool) and writes to the DB', async () => {
    const app = createApp();
    const proj = domain.createProject({ name: 'P-write', rootPath: t.dir });

    const res = await app.request('/api/mcp/pm_create_feature', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: proj.id, name: 'new feature via passthrough' }),
    });
    expect(res.status).toBe(200);

    // The body should carry the JSON-ified feature in MCP envelope form.
    const body = await res.json() as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(body.content[0]!.text);
    expect(data.feature_id).toBeTruthy();
    expect(data.name).toBe('new feature via passthrough');

    // Verify the write actually landed.
    expect(domain.listFeatures(proj.id)).toHaveLength(1);
  });

  it('returns 404 for an unknown tool name', async () => {
    const app = createApp();
    const res = await app.request('/api/mcp/pm_definitely_not_a_tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/Unknown MCP tool/);
  });

  it('returns 400 on a schema-mismatched body (e.g. missing required field)', async () => {
    const app = createApp();
    // pm_search requires `query`. Omitting it must surface as a 400, not a 500.
    const res = await app.request('/api/mcp/pm_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 500 when the handler throws (e.g. unknown project_id)', async () => {
    const app = createApp();
    const res = await app.request('/api/mcp/pm_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: 'does-not-exist', query: 'x' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/Unknown project/);
  });
});
