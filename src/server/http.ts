import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as domain from './domain.js';
import type { FeatureStatus } from './types.js';
import { relativeTime } from './lib.js';

// Body schemas. Wire format mirrors the domain layer field names — clients can
// take a GET response and round-trip it through a PATCH unchanged.
const FEATURE_STATUS = z.enum(['todo', 'in_progress', 'done', 'archived']);
const TASK_STATUS = z.enum(['todo', 'in_progress', 'done']);

// `.strict()` rejects unknown keys with a clear 400 error. Without it, zod
// silently strips extras — that lets typos and stale-client fields slip
// through unnoticed (Sprint 2 turned up real cases).
const createFeatureSchema = z.object({
  name: z.string().min(1),
  goal: z.string().optional(),
  spec_md: z.string().optional(),
  status: FEATURE_STATUS.optional(),
}).strict();

const updateFeatureSchema = z.object({
  name: z.string().min(1).optional(),
  goal: z.string().optional(),
  spec_md: z.string().optional(),
  status: FEATURE_STATUS.optional(),
  priority: z.number().optional(),
}).strict();

const addTaskSchema = z.object({
  name: z.string().min(1),
}).strict();

const updateTaskSchema = z.object({
  name: z.string().min(1).optional(),
  status: TASK_STATUS.optional(),
  notes: z.string().optional(),
  position: z.number().optional(),
}).strict();

const logDecisionSchema = z.object({
  title: z.string().min(1),
  context: z.string().optional(),
  decision: z.string().optional(),
  alternatives: z.string().optional(),
  consequences: z.string().optional(),
  feature_id: z.string().optional(),
}).strict();

// All fields optional for update — clients can patch one field at a time.
// title still rejects empty string when present (mirrors create-side `min(1)`).
const updateDecisionSchema = z.object({
  title: z.string().min(1).optional(),
  context: z.string().optional(),
  decision: z.string().optional(),
  alternatives: z.string().optional(),
  consequences: z.string().optional(),
  feature_id: z.string().nullable().optional(),
}).strict();

// Sprint 22 (3wtr) — Spec Hub schemas. kind enum mirrors the CHECK
// constraint in migrations/0006_documents.sql.
const DOCUMENT_KIND = z.enum([
  'prd', 'planning', 'architecture', 'retro', 'feature_spec', 'other',
]);

const createDocumentSchema = z.object({
  kind: DOCUMENT_KIND,
  title: z.string().min(1),
  content_md: z.string().optional(),
}).strict();

const updateDocumentSchema = z.object({
  kind: DOCUMENT_KIND.optional(),
  title: z.string().min(1).optional(),
  content_md: z.string().optional(),
}).strict();

const documentFeatureLinkSchema = z.object({
  document_id: z.string().min(1),
  feature_id: z.string().min(1),
}).strict();

function formatZodError(err: z.ZodError): string {
  return err.errors.map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`).join('; ');
}

// Resolve dist/web/ relative to this file, in a way that works
// both in dev (src/server/http.ts) and prod (dist/server/http.js).
// Both locations are 2 dirs deep, so `../../dist/web` is consistent.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const WEB_BUILD_DIR = path.resolve(PROJECT_ROOT, 'dist', 'web');

export function createApp() {
  const app = new Hono();
  app.use('*', cors());

  app.get('/api/status', (c) => c.json({ name: 'vibemate', version: '0.1.0', status: 'ok' }));

  // ----- Projects -----

  app.get('/api/projects', (c) => {
    const projects = domain.listProjects();
    return c.json(
      projects.map((p) => ({
        ...p,
        stats: domain.getProjectStats(p.id),
      })),
    );
  });

  app.get('/api/projects/:id', (c) => {
    const id = c.req.param('id');
    const project = domain.getProject(id);
    if (!project) return c.json({ error: 'Project not found' }, 404);
    return c.json({ ...project, stats: domain.getProjectStats(id) });
  });

  // Sprint 28 (pax6) — pre-flight summary the UI / CLI calls before showing
  // the destructive confirm. Returns 404 if the project is already gone so
  // the client can recover (e.g. close the modal + refetch the list).
  app.get('/api/projects/:id/deletion-impact', (c) => {
    const id = c.req.param('id');
    if (!domain.getProject(id)) {
      return c.json({ error: `Project not found: ${id}` }, 404);
    }
    return c.json(domain.getProjectDeletionImpact(id));
  });

  // Sprint 28 (pax6) — hard delete + cascade. `?force=true` bypasses the
  // active-session guard; the server still does the guard check first so
  // a client that forgets the param can't accidentally delete in-progress
  // sessions. 409 surfaces the guard failure so the UI can show the
  // "활성 세션이 있습니다" branch.
  app.delete('/api/projects/:id', (c) => {
    const id = c.req.param('id');
    if (!domain.getProject(id)) {
      return c.json({ error: `Project not found: ${id}` }, 404);
    }
    const force = c.req.query('force') === 'true';
    try {
      const removed = domain.deleteProject(id, { force });
      if (!removed) return c.json({ error: `Project not found: ${id}` }, 404);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  });

  // Sprint 20 (u3zu): aggregate "Project Overview" — first screen when
  // entering a project. See domain.getProjectOverview / types.ProjectOverview.
  // Follows the same single-endpoint pattern as Sprint 15's workspace view.
  app.get('/api/projects/:id/overview', (c) => {
    const id = c.req.param('id');
    try {
      return c.json(domain.getProjectOverview(id));
    } catch (e) {
      const msg = (e as Error).message ?? 'Project not found';
      return c.json({ error: msg }, 404);
    }
  });

  // ----- Features -----

  app.get('/api/projects/:id/features', (c) => {
    const projectId = c.req.param('id');
    const status = c.req.query('status') as FeatureStatus | undefined;
    const features = domain.listFeatures(projectId, status);
    return c.json(
      features.map((f) => {
        const { progress, done, total } = domain.getFeatureProgress(f.id);
        return { ...f, progress, tasks_done: done, tasks_total: total };
      }),
    );
  });

  app.get('/api/features/:id', (c) => {
    const id = c.req.param('id');
    const feature = domain.getFeature(id);
    if (!feature) return c.json({ error: 'Feature not found' }, 404);

    const tasks = domain.listTasks(id);
    // Sprint 25 / T2: include per-file session-edit aggregates so the
    // "관련 코드" UI can render a "마지막 수정: <시간> (총 N건)" indicator.
    const files = domain.listFeatureFilesWithEditStats(id);
    const { progress, done, total } = domain.getFeatureProgress(id);

    // Sessions for this feature, with their session_files. `id` is included
    // so the UI can attach data-ref-id to each card — used by the search
    // palette's scroll-to-row + flash on navigateToResult('session', …).
    const sessions = domain
      .listSessions(feature.project_id, 100)
      .filter((s) => s.feature_id === id)
      .slice(0, 20)
      .map((s) => ({
        id: s.id,
        time: relativeTime(s.started_at),
        summary: s.summary,
        files: s.files,
      }));

    // Decisions linked to this feature (created_at DESC). NULL-feature_id
    // ADRs are excluded by the domain helper. Surfaced as the "관련 결정"
    // section in renderFeatureDetail — mirrors the `sessions` folding pattern.
    const decisions = domain.listDecisionsForFeature(id);

    return c.json({
      ...feature,
      progress,
      tasks_done: done,
      tasks_total: total,
      tasks,
      files,
      sessions,
      decisions,
    });
  });

  // ----- Decisions -----

  app.get('/api/projects/:id/decisions', (c) => {
    const projectId = c.req.param('id');
    const decisions = domain.listDecisions(projectId);
    return c.json(
      decisions.map((d) => ({
        ...d,
        date: relativeTime(d.created_at),
      })),
    );
  });

  // ----- Sessions -----

  // Sprint 23 (h5uk): single session detail — feeds the renderSessionDetail
  // sub-view with files / prev-next nav / labeled timestamps.
  app.get('/api/sessions/:id', (c) => {
    const id = c.req.param('id');
    try {
      return c.json(domain.getSessionDetail(id));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  app.get('/api/projects/:id/sessions', (c) => {
    const projectId = c.req.param('id');
    const limit = Number(c.req.query('limit') ?? 50);
    const sessions = domain.listSessions(projectId, limit);
    return c.json(
      sessions.map((s) => ({
        id: s.id,
        time: relativeTime(s.started_at),
        started_at: s.started_at,
        ended_at: s.ended_at,
        summary: s.summary,
        feature_id: s.feature_id,
        feature_name: s.feature_name,
        files: s.files,
      })),
    );
  });

  // ----- Search (FTS5 across features/decisions/sessions/files) -----

  app.get('/api/projects/:id/search', (c) => {
    const projectId = c.req.param('id');
    if (!domain.getProject(projectId)) {
      return c.json({ error: `Project not found: ${projectId}` }, 404);
    }
    const q = c.req.query('q') ?? '';
    const limitRaw = c.req.query('limit');
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      const n = Number(limitRaw);
      if (!Number.isFinite(n) || n <= 0) {
        return c.json({ error: 'limit must be a positive number' }, 400);
      }
      limit = n;
    }
    const results = domain.searchProject(projectId, q, limit);
    return c.json(results);
  });

  // ----- File tree -----

  app.get('/api/projects/:id/file-tree', (c) => {
    const projectId = c.req.param('id');
    if (!domain.getProject(projectId)) {
      return c.json({ error: `Project not found: ${projectId}` }, 404);
    }
    const tree = domain.getFileTree(projectId);
    return c.json(tree);
  });

  // ----- Documents (Sprint 22, 3wtr — Spec Hub) -----

  app.get('/api/projects/:id/documents', (c) => {
    const projectId = c.req.param('id');
    if (!domain.getProject(projectId)) {
      return c.json({ error: `Project not found: ${projectId}` }, 404);
    }
    const kindRaw = c.req.query('kind');
    let kind: z.infer<typeof DOCUMENT_KIND> | undefined;
    if (kindRaw !== undefined) {
      const parsed = DOCUMENT_KIND.safeParse(kindRaw);
      if (!parsed.success) {
        return c.json({ error: `invalid kind: ${kindRaw}` }, 400);
      }
      kind = parsed.data;
    }
    const limitRaw = c.req.query('limit');
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      const n = Number(limitRaw);
      if (!Number.isFinite(n) || n <= 0) {
        return c.json({ error: 'limit must be a positive number' }, 400);
      }
      limit = n;
    }
    return c.json(domain.listDocuments(projectId, { kind, limit }));
  });

  app.get('/api/documents/:id', (c) => {
    const id = c.req.param('id');
    const doc = domain.getDocument(id);
    if (!doc) return c.json({ error: 'Document not found' }, 404);
    return c.json(doc);
  });

  app.post('/api/projects/:id/documents', async (c) => {
    const projectId = c.req.param('id');
    if (!domain.getProject(projectId)) {
      return c.json({ error: `Project not found: ${projectId}` }, 404);
    }
    const parsed = createDocumentSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: formatZodError(parsed.error) }, 400);
    const doc = domain.createDocument({ projectId, ...parsed.data });
    return c.json(doc, 201);
  });

  app.patch('/api/documents/:id', async (c) => {
    const id = c.req.param('id');
    const parsed = updateDocumentSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: formatZodError(parsed.error) }, 400);
    const updated = domain.updateDocument(id, parsed.data);
    if (!updated) return c.json({ error: 'Document not found' }, 404);
    return c.json(updated);
  });

  app.delete('/api/documents/:id', (c) => {
    const id = c.req.param('id');
    const ok = domain.deleteDocument(id);
    if (!ok) return c.json({ error: 'Document not found' }, 404);
    return c.json({ ok: true });
  });

  // Document ↔ feature link/unlink. Sprint 5 feature_files pattern: body-based
  // (rather than path-based) because both ids are first-class — neither is a
  // sub-resource of the other.
  app.post('/api/document-features', async (c) => {
    const parsed = documentFeatureLinkSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: formatZodError(parsed.error) }, 400);
    try {
      domain.linkDocumentToFeature(parsed.data.document_id, parsed.data.feature_id);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  app.delete('/api/document-features', async (c) => {
    const parsed = documentFeatureLinkSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: formatZodError(parsed.error) }, 400);
    const ok = domain.unlinkDocumentFromFeature(parsed.data.document_id, parsed.data.feature_id);
    return c.json({ ok });
  });

  app.get('/api/features/:id/documents', (c) => {
    const id = c.req.param('id');
    if (!domain.getFeature(id)) return c.json({ error: 'Feature not found' }, 404);
    return c.json(domain.listDocumentsForFeature(id));
  });

  // Sprint 24 (ijze) — AI Context Pack. Returns the agent-ready Markdown
  // bundle for a feature; the structured `sections` payload feeds the
  // web UI's per-section counts without re-parsing the body.
  app.get('/api/features/:id/context-brief', (c) => {
    const id = c.req.param('id');
    try {
      return c.json(domain.getContextBrief(id));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  // ----- Workspace (cross-project active-features view) -----

  app.get('/api/workspace/active-features', (c) => {
    const queryStatuses = c.req.queries('status') ?? [];
    // Accept both `?status=in_progress&status=todo` (Hono's queries() returns
    // the array) and CSV `?status=in_progress,todo`. Flatten + dedupe.
    const flat = queryStatuses.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
    const statuses = flat.length > 0 ? (flat as FeatureStatus[]) : undefined;

    const limitRaw = c.req.query('limit');
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      const n = Number(limitRaw);
      if (!Number.isFinite(n) || n <= 0) {
        return c.json({ error: 'limit must be a positive number' }, 400);
      }
      limit = n;
    }

    return c.json(domain.listWorkspaceFeatures({ statuses, limit }));
  });

  // (Removed in ADR-0016: GET /api/projects/:id/files/needs-explanation,
  // DELETE /api/projects/:id/file-explanations, GET /api/projects/:id/files/detail.
  // Code Map UI retired; AI file-explanation workflow retired.)

  // ----- File-feature links (manual override) -----

  app.post('/api/feature-files', async (c) => {
    const body = await c.req.json<{ feature_id: string; file_path: string; description?: string }>();
    const link = domain.linkFile({
      featureId: body.feature_id,
      filePath: body.file_path,
      description: body.description,
    });
    return c.json(link);
  });

  app.delete('/api/feature-files', async (c) => {
    const body = await c.req.json<{ feature_id: string; file_path: string }>();
    domain.unlinkFile(body.feature_id, body.file_path);
    return c.json({ ok: true });
  });

  // Cleaner URL-shaped variant of the unlink above. The feature-files row is
  // keyed by (feature_id, file_path), and file_path can contain slashes — so
  // we put feature_id in the path and accept file_path via query param rather
  // than carving it into the URL.
  app.delete('/api/features/:fid/files', (c) => {
    const featureId = c.req.param('fid');
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'path query param required' }, 400);
    if (!domain.getFeature(featureId)) {
      return c.json({ error: `Feature not found: ${featureId}` }, 404);
    }
    domain.unlinkFile(featureId, filePath);
    return c.json({ ok: true });
  });

  // ----- Mutations: features -----

  app.post('/api/projects/:id/features', async (c) => {
    const projectId = c.req.param('id');
    if (!domain.getProject(projectId)) {
      return c.json({ error: `Project not found: ${projectId}` }, 404);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const parsed = createFeatureSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: formatZodError(parsed.error) }, 400);

    const f = domain.createFeature({ projectId, ...parsed.data });
    return c.json(f, 201);
  });

  app.patch('/api/features/:id', async (c) => {
    const id = c.req.param('id');
    if (!domain.getFeature(id)) {
      return c.json({ error: `Feature not found: ${id}` }, 404);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const parsed = updateFeatureSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: formatZodError(parsed.error) }, 400);

    const updated = domain.updateFeature(id, parsed.data);
    if (!updated) return c.json({ error: `Feature not found: ${id}` }, 404);
    return c.json(updated);
  });

  // ----- Mutations: tasks -----

  app.post('/api/features/:id/tasks', async (c) => {
    const featureId = c.req.param('id');
    if (!domain.getFeature(featureId)) {
      return c.json({ error: `Feature not found: ${featureId}` }, 404);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const parsed = addTaskSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: formatZodError(parsed.error) }, 400);

    const task = domain.addTask(featureId, parsed.data.name);
    return c.json(task, 201);
  });

  app.patch('/api/tasks/:id', async (c) => {
    const idParam = c.req.param('id');
    const id = Number(idParam);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: `Invalid task id: ${idParam}` }, 400);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const parsed = updateTaskSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: formatZodError(parsed.error) }, 400);

    const updated = domain.updateTask(id, parsed.data);
    if (!updated) return c.json({ error: `Task not found: ${id}` }, 404);
    return c.json(updated);
  });

  app.delete('/api/tasks/:id', (c) => {
    const idParam = c.req.param('id');
    const id = Number(idParam);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: `Invalid task id: ${idParam}` }, 400);
    }
    const removed = domain.deleteTask(id);
    if (!removed) return c.json({ error: `Task not found: ${id}` }, 404);
    return c.json({ ok: true });
  });

  // ----- Mutations: decisions -----

  app.post('/api/projects/:id/decisions', async (c) => {
    const projectId = c.req.param('id');
    if (!domain.getProject(projectId)) {
      return c.json({ error: `Project not found: ${projectId}` }, 404);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const parsed = logDecisionSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: formatZodError(parsed.error) }, 400);

    const { feature_id, ...rest } = parsed.data;
    const adr = domain.logDecision({ projectId, featureId: feature_id, ...rest });
    return c.json(adr, 201);
  });

  app.patch('/api/decisions/:id', async (c) => {
    const id = c.req.param('id');
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const parsed = updateDecisionSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: formatZodError(parsed.error) }, 400);

    const updated = domain.updateDecision(id, parsed.data);
    if (!updated) return c.json({ error: `Decision not found: ${id}` }, 404);
    return c.json(updated);
  });

  app.delete('/api/decisions/:id', (c) => {
    const id = c.req.param('id');
    const removed = domain.deleteDecision(id);
    if (!removed) return c.json({ error: `Decision not found: ${id}` }, 404);
    return c.json({ ok: true });
  });

  // Serve built web app from dist/web/ when present.
  // Skipped silently in dev mode (no build yet) — use Vite's port 5173 there.
  if (fs.existsSync(path.join(WEB_BUILD_DIR, 'index.html'))) {
    app.use('/*', serveStatic({ root: WEB_BUILD_DIR }));
  }

  return app;
}

export function startHttpServer(port: number = 7321): void {
  const app = createApp();
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[vibemate] HTTP server listening on http://localhost:${info.port}`);
  });
}
