// Vibemate web client. Fetches data from the backend HTTP API.
// Shared types from `../server/types` are pure-type (no runtime import).
// The big DATA literal that used to live here was the original mockup —
// see git history for the seed values.

import type {
  Decision,
  Document,
  DocumentKind,
  Feature,
  FeatureFile,
  FeatureStatus,
  Project,
  ProjectOverview,
  SearchKind,
  SearchResult,
  SessionDetail,
  Task,
  TaskStatus,
  WorkspaceFeature,
} from '../server/types';
import type {
  AdrCard,
  AppState,
  DataCache,
  DecisionListItem,
  DecisionPatch,
  ElChild,
  ElProps,
  EnrichedFeature,
  FeatureDetailResponse,
  FeatureFileRow,
  FeatureListItem,
  FeaturePatch,
  ProjectListEntry,
  ProjectListItem,
  RawSessionResponse,
  SearchState,
  SessionSummaryRow,
  Tab,
  TaskRow,
  WorkspaceFeatureRow,
} from './types';
import { readPersistedFlag, writePersistedFlag } from './persist.js';

// Sprint 18 (y8pr): localStorage key for the features-sidebar
// "hide completed" toggle. New keys use dot.camel namespacing — the older
// `vibemate_theme` key keeps its underscore form for backward compat.
const HIDE_COMPLETED_FEATURES_KEY = 'vibemate.hideCompletedFeatures';

// In-memory cache populated by API calls. Keyed by project id.
const DATA: DataCache = {
  projects: [],
  features: {},
  decisions: {},
  overviews: {},
  documents: {},
  documentsByFeature: {},
  sessionDetails: {},
};


// State — singleton, mutated in place. Every render*() reads from here.
const state: AppState = {
  currentProject: null,        // set after projects load
  // Workspace is the default landing tab — gives a cross-project overview
  // for new users (or users with several projects) before they pick one.
  currentTab: 'workspace',
  currentFeature: null,
  loading: true,               // initial fetch in flight
  error: null,
  loadedProjects: new Set<string>(),

  // Mutation UI flags
  addingFeature: false,
  addingTaskFor: null,         // feature id while inline form is open
  addingDecision: false,
  editingFeatureName: null,    // feature id while name is being inline-edited
  editingDecisionId: null,     // ADR id while edit form is open

  // Transient UI
  errorMsg: null,              // last toast banner text
  toastKind: 'error',          // tint for the transient banner

  // Workspace tab
  workspaceStatuses: ['in_progress'],
  workspaceFeatures: null,
  workspaceLoading: false,
  workspaceError: null,

  // Features sidebar — Sprint 18 (y8pr)
  hideCompletedFeatures: readPersistedFlag(HIDE_COMPLETED_FEATURES_KEY, true),

  // Docs tab — Sprint 22 (3wtr)
  currentDocument: null,
  addingDocument: false,
  editingDocumentId: null,
  documentPreview: false,

  // Sessions tab — Sprint 23 (h5uk)
  currentSession: null,
};

// (Removed in ADR-0016: FILE_DETAIL cache + fdKey helper. Code Map retired.)

// =================================================
// API helpers
// =================================================
async function fetchJSON<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// Translate noisy zod-shaped errors into something a user can actually read.
// Falls back to the original string if no pattern matches.
function humanizeServerError(raw: string): string {
  if (!raw) return raw;
  // <root>: Unrecognized key(s) in object: 'foo', 'bar'
  const unknown = raw.match(/Unrecognized key\(s\) in object: ([^;]+)/);
  if (unknown) return `알 수 없는 필드: ${unknown[1].replace(/'/g, '').trim()}`;
  // foo: Required
  if (/:\s*Required/.test(raw)) {
    const f = raw.split(':')[0]?.trim();
    return f ? `${f}: 필수 입력` : raw;
  }
  // Invalid enum value
  if (/Invalid enum value/.test(raw)) return `잘못된 값: ${raw.split(';')[0]}`;
  return raw;
}

// Transient banner. `kind` decides the border tint and dismiss timer. We use
// the same single slot (`state.errorMsg`) for any toast — only one shows at a
// time, the most recent wins.
function showToast(msg: string, kind: 'error' | 'success' | 'info' = 'error'): void {
  state.errorMsg = msg;
  state.toastKind = kind;
  render();
  const captured = msg;
  const ttl = kind === 'success' ? 1800 : 4500;
  setTimeout(() => {
    if (state.errorMsg === captured) {
      state.errorMsg = null;
      render();
    }
  }, ttl);
}
// Backwards-compat alias — most existing call sites are reporting failures.
function showError(msg: string): void { showToast(msg, 'error'); }

// Validate that each labeled value is non-empty after trim. Returns the
// human-readable error for the first failing field, or null if all pass.
// Caller decides whether to showError(...) the result and abort, or surface
// inline. Keep this side-effect-free so it composes either way.
function validateRequired(fields: Array<[string, string | undefined | null]>): string | null {
  for (const [label, val] of fields) {
    if (!val || !String(val).trim()) return `${label}: 필수 입력`;
  }
  return null;
}

// Single mutation entrypoint used by all the *UI() functions below. Centralizes
// the four things every mutation needs:
//   1. optional confirm dialog (silent abort on cancel — returns null)
//   2. fetch with appropriate headers/body
//   3. error handling: parse {error} body → humanize → toast
//   4. optional success toast
// On success returns the parsed JSON (or null if response had no body, e.g. some
// 204s — currently all our endpoints return at least {ok:true}). On failure or
// cancel returns null and the caller should bail without touching local cache.
// T defaults to `any` deliberately — most callers ignore the return value and
// only care about success/failure; an explicit default makes those sites
// (e.g. `mutate({ ... })` without generics) read cleanly. `body` stays `unknown`
// because it's `JSON.stringify`-ed and the caller knows the shape.
async function mutate<T = any>(opts: {
  method: 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  url: string;
  body?: unknown;
  confirm?: string;
  successToast?: string;
}): Promise<T | null> {
  if (opts.confirm && !window.confirm(opts.confirm)) return null;

  const init: RequestInit = { method: opts.method };
  if (opts.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(opts.url, init);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '네트워크 오류';
    showToast(msg, 'error');
    return null;
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error ?? ''; } catch { /* not JSON */ }
    showToast(humanizeServerError(detail) || `${opts.method} ${opts.url} → HTTP ${res.status}`, 'error');
    return null;
  }

  let data: unknown = null;
  try { data = await res.json(); } catch { /* empty body — fine */ }
  if (opts.successToast) showToast(opts.successToast, 'success');
  return data as T;
}

function progressFromTasks(tasks: Array<{ status: TaskStatus }> | undefined | null): number {
  if (!tasks || tasks.length === 0) return 0;
  const done = tasks.filter((t) => t.status === 'done').length;
  return Math.round((done / tasks.length) * 100);
}

// ---- Mutations ----
// Pattern: call mutate() — it owns confirm/network/error-toast. On null return
// (failure or user-cancelled confirm), bail without touching local cache. On
// success, update DATA in place and render(). Successful destructive actions
// fire a brief success toast so the user sees the action took.

async function createFeatureUI(name: string): Promise<void> {
  const projectId = state.currentProject;
  if (!projectId) return;
  const f = await mutate<Feature>({
    method: 'POST',
    url: `/api/projects/${projectId}/features`,
    body: { name },
  });
  if (!f) return;
  const enriched: EnrichedFeature = {
    id: f.id, name: f.name, goal: f.goal, spec_md: f.spec_md, status: f.status,
    progress: 0, tasks: [], files: [], sessions: [],
  };
  DATA.features[projectId] = [...(DATA.features[projectId] || []), enriched];
  state.currentFeature = f.id;
  state.addingFeature = false;
  invalidateOverview(projectId);
  render();
}

async function addTaskUI(featureId: string, name: string): Promise<void> {
  const t = await mutate<Task>({
    method: 'POST',
    url: `/api/features/${featureId}/tasks`,
    body: { name },
  });
  if (!t) return;
  const feat = (DATA.features[state.currentProject!] || []).find((x) => x.id === featureId);
  if (feat) {
    // Spread the full Task row so we satisfy TaskRow (Task + when). The server
    // sends position/notes/feature_id which we don't display but also don't
    // strip — keeps the row round-trippable.
    const tk: TaskRow = { ...t, when: null };
    tk.when = pickWhenForTask(tk);
    feat.tasks.push(tk);
    feat.progress = progressFromTasks(feat.tasks);
  }
  state.addingTaskFor = null;
  render();
}

async function deleteTaskUI(taskId: number): Promise<void> {
  const ok = await mutate({
    method: 'DELETE',
    url: `/api/tasks/${taskId}`,
    confirm: '이 태스크를 삭제할까요?',
    successToast: '태스크 삭제됨',
  });
  if (!ok) return;
  for (const feat of DATA.features[state.currentProject!] || []) {
    const before = (feat.tasks || []).length;
    feat.tasks = (feat.tasks || []).filter((x) => x.id !== taskId);
    if (feat.tasks.length !== before) {
      feat.progress = progressFromTasks(feat.tasks);
      break;
    }
  }
  render();
}

async function toggleTaskUI(taskId: number, currentStatus: TaskStatus): Promise<void> {
  const next: TaskStatus = currentStatus === 'done' ? 'todo' : 'done';
  const t = await mutate<Task>({
    method: 'PATCH',
    url: `/api/tasks/${taskId}`,
    body: { status: next },
  });
  if (!t) return;
  for (const feat of DATA.features[state.currentProject!] || []) {
    const tk = (feat.tasks || []).find((x) => x.id === taskId);
    if (tk) {
      tk.status = t.status;
      tk.completed_at = t.completed_at;
      tk.started_at = t.started_at;
      tk.when = pickWhenForTask(tk);
      feat.progress = progressFromTasks(feat.tasks);
      break;
    }
  }
  // Sprint 20 (u3zu): overview's next_task depends on task status, so a
  // toggle must invalidate the cached overview for this project.
  invalidateOverview(state.currentProject);
  render();
}

async function updateDecisionUI(adrId: string, patch: DecisionPatch): Promise<void> {
  // Strip empty optional strings — server's strict schema accepts the field
  // absent OR a non-empty string. feature_id allows null (clear) explicitly.
  const body: DecisionPatch = {};
  for (const k of ['title', 'context', 'decision', 'alternatives', 'consequences'] as const) {
    const v = patch[k];
    if (typeof v === 'string') body[k] = v.trim();
  }
  if ('feature_id' in patch) body.feature_id = patch.feature_id || null;

  const updated = await mutate<Decision>({
    method: 'PATCH',
    url: `/api/decisions/${adrId}`,
    body,
  });
  if (!updated) return;
  const list = DATA.decisions[state.currentProject!] || [];
  const idx = list.findIndex((d) => d.id === adrId);
  if (idx >= 0) {
    const featureName = updated.feature_id
      ? (DATA.features[state.currentProject!] || []).find((f) => f.id === updated.feature_id)?.name ?? null
      : null;
    list[idx] = {
      ...list[idx],
      title: updated.title,
      context: updated.context,
      decision: updated.decision,
      alternatives: updated.alternatives,
      consequences: updated.consequences,
      feature_id: updated.feature_id,
      feature: featureName,
    };
  }
  state.editingDecisionId = null;
  render();
}

async function deleteDecisionUI(adrId: string): Promise<void> {
  const ok = await mutate({
    method: 'DELETE',
    url: `/api/decisions/${adrId}`,
    confirm: `이 결정 기록(${adrId})을 삭제할까요?`,
    successToast: '결정 삭제됨',
  });
  if (!ok) return;
  DATA.decisions[state.currentProject!] =
    (DATA.decisions[state.currentProject!] || []).filter((d) => d.id !== adrId);
  if (state.editingDecisionId === adrId) state.editingDecisionId = null;
  render();
}

async function createDecisionUI(payload: {
  title: string;
  context?: string;
  alternatives?: string;
  decision?: string;
  consequences?: string;
  feature_id?: string;
}): Promise<void> {
  // Strip empty optional strings — strict schema accepts the field absent OR a string.
  const body: Record<string, string> = { title: payload.title };
  for (const k of ['context', 'alternatives', 'decision', 'consequences', 'feature_id'] as const) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) body[k] = v.trim();
  }
  const adr = await mutate<Decision>({
    method: 'POST',
    url: `/api/projects/${state.currentProject!}/decisions`,
    body,
  });
  if (!adr) return;
  const featureName = adr.feature_id
    ? ((DATA.features[state.currentProject!] || []).find((f) => f.id === adr.feature_id)?.name ?? null)
    : null;
  // Spread the server row so we don't drop project_id/created_at — both are
  // part of AdrCard via `extends Decision`. `date` is the only synthetic field.
  const enriched: AdrCard = {
    ...adr,
    date: '방금',
    feature: featureName,
  };
  DATA.decisions[state.currentProject!] = [enriched, ...(DATA.decisions[state.currentProject!] || [])];
  state.addingDecision = false;
  // Sprint 20 (u3zu): overview's recent_decisions list reflects this new row.
  invalidateOverview(state.currentProject);
  render();
}

// Edit a feature's name/status/etc. via PATCH. We merge the response into the
// cached enriched record (keeping tasks/files/sessions/progress) instead of
// replacing it — the API returns the bare Feature row, not the hydrated view.
async function updateFeatureUI(
  featureId: string,
  patch: FeaturePatch,
): Promise<void> {
  const updated = await mutate<Feature>({
    method: 'PATCH',
    url: `/api/features/${featureId}`,
    body: patch,
  });
  if (!updated) return;
  const list = DATA.features[state.currentProject!] || [];
  const idx = list.findIndex((x) => x.id === featureId);
  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      name: updated.name,
      goal: updated.goal,
      status: updated.status,
    };
  }
  state.editingFeatureName = null;
  // Sprint 20 (u3zu): a feature status change (todo→in_progress→done) reorders
  // the overview's active_features and can flip the health label.
  invalidateOverview(state.currentProject);
  render();
}

// (Removed in ADR-0016: clearExplanationUI. AI file-explanation workflow retired.)

async function unlinkFileUI(featureId: string, filePath: string): Promise<void> {
  const url = `/api/features/${encodeURIComponent(featureId)}/files?path=${encodeURIComponent(filePath)}`;
  const ok = await mutate({
    method: 'DELETE',
    url,
    confirm: `이 매핑을 해제할까요?\n${filePath}`,
    successToast: '매핑 해제됨',
  });
  if (!ok) return;
  // Remove from feature.files cache so the next render reflects the unlink.
  const feat = (DATA.features[state.currentProject!] || []).find((x) => x.id === featureId);
  if (feat) feat.files = (feat.files || []).filter((ff) => ff.path !== filePath);
  render();
}

// Map a file to a feature. After the API confirms, update the local feature
// cache so renderFeatureDetail's "관련 코드" section reflects the new link.
async function linkFileUI(featureId: string, filePath: string): Promise<void> {
  const link = await mutate<FeatureFile>({
    method: 'POST',
    url: '/api/feature-files',
    body: { feature_id: featureId, file_path: filePath },
  });
  if (!link) return;
  const feat = (DATA.features[state.currentProject!] || []).find((x) => x.id === featureId);
  if (feat) {
    feat.files = feat.files || [];
    if (!feat.files.some((ff) => ff.path === filePath)) {
      feat.files.push({ path: link.file_path, desc: link.description ?? '' });
    }
  }
  render();
}

// (Removed in ADR-0016: copyPathToClipboard. Sole caller was renderCodeMap's
// path-copy button; both retired together.)

// (Removed in ADR-0016: loadFileDetail. /files/detail endpoint retired.)

// Stable visual identity from project name/id (mockup used hand-picked values).
function makeMark(name: string): string {
  const stripped = name.replace(/\s+/g, '');
  return (stripped.slice(0, 2) || 'PR').toUpperCase();
}
function makeMarkColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 32%, 28%)`;
}

// (Removed in ADR-0016: adaptFileTree, computeHotFiles, SEVEN_DAYS_MS.
// File tree / hot-file affordances retired with Code Map.)

// Korean relative time. Buckets are coarse — "방금/5분 전/2시간 전/3일 전" etc.
function relTime(ts: number | null | undefined): string | null {
  if (!ts || typeof ts !== 'number') return null;
  const diff = Date.now() - ts;
  if (diff < 60_000) return '방금';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  if (d === 1) return '어제';
  if (d < 7) return `${d}일 전`;
  if (d < 30) return `${Math.floor(d / 7)}주 전`;
  return `${Math.floor(d / 30)}달 전`;
}

// Pick the most informative timestamp for a task row. Accepts any task-shaped
// object that exposes the three timestamps — both the server `Task` and the
// view-layer `TaskRow` qualify.
function pickWhenForTask(t: Pick<Task, 'completed_at' | 'started_at' | 'created_at'>): string | null {
  return relTime(t.completed_at) ?? relTime(t.started_at) ?? relTime(t.created_at);
}

async function loadProjectList(): Promise<void> {
  const projects = await fetchJSON<ProjectListItem[]>('/api/projects');
  DATA.projects = projects.map((p) => ({
    ...p,
    mark: makeMark(p.name),
    markColor: makeMarkColor(p.id),
  }));
}

/**
 * Pull the cross-project workspace view. Cached on `state.workspaceFeatures`;
 * caller invalidates by setting it to null (e.g. when the status filter
 * changes). loading / error flags drive the render() spinner / banner.
 */
async function loadWorkspaceFeatures(): Promise<void> {
  state.workspaceLoading = true;
  state.workspaceError = null;
  render();
  try {
    const qs = state.workspaceStatuses.map((s) => `status=${encodeURIComponent(s)}`).join('&');
    const rows = await fetchJSON<WorkspaceFeatureRow[]>(`/api/workspace/active-features?${qs}`);
    state.workspaceFeatures = rows;
  } catch (e) {
    state.workspaceError = (e as Error).message ?? '워크스페이스 로드 실패';
  } finally {
    state.workspaceLoading = false;
    render();
  }
}

/**
 * Switch into a project's feature detail view from anywhere (workspace card,
 * search palette, future cross-project entry points). Reuses `setActiveProject`
 * so the project's detail is lazily loaded the first time.
 */
async function navigateToFeature(projectId: string, featureId: string): Promise<void> {
  state.currentTab = 'features';
  state.currentFeature = featureId;
  await setActiveProject(projectId);
}

/**
 * Sprint 20 (u3zu): land on a project's Overview tab.
 *
 * Used as the "go look at this project" gesture from workspace cards
 * (project-mark / project-name click) — distinct from `navigateToFeature`
 * which drills into a specific feature. The renderOverview() side handles
 * the lazy /overview fetch on first view.
 */
async function navigateToOverview(projectId: string): Promise<void> {
  state.currentTab = 'overview';
  await setActiveProject(projectId);
}

async function loadProjectDetail(projectId: string): Promise<void> {
  if (state.loadedProjects.has(projectId)) return;

  // Per-route response shapes diverge from the raw server entities (the API
  // folds in derived fields like `progress`, `date`, etc.), so each fetchJSON
  // call gets a narrow generic. The richer "feature detail" shape comes from
  // `/api/features/:id` and lands in `featureDetails` below.
  const [features, decisions, sessions] = await Promise.all([
    fetchJSON<FeatureListItem[]>(`/api/projects/${projectId}/features`),
    fetchJSON<DecisionListItem[]>(`/api/projects/${projectId}/decisions`),
    fetchJSON<RawSessionResponse[]>(`/api/projects/${projectId}/sessions`),
  ]);

  // Hydrate each feature with tasks/files/sessions.
  const featureDetails = await Promise.all(
    features.map((f: Feature) => fetchJSON<FeatureDetailResponse>(`/api/features/${f.id}`)),
  );

  const featureNameById: Record<string, string> = {};
  const enrichedFeatures: EnrichedFeature[] = featureDetails.map((fd) => {
    featureNameById[fd.id] = fd.name;
    return {
      id: fd.id,
      name: fd.name,
      goal: fd.goal,
      spec_md: fd.spec_md,
      status: fd.status,
      progress: fd.progress,
      tasks: (fd.tasks || []).map((t): TaskRow => ({
        id: t.id, // numeric task id, used by PATCH /api/tasks/:id
        feature_id: t.feature_id,
        name: t.name,
        status: t.status,
        position: t.position,
        notes: t.notes,
        // Carry server timestamps so toggle re-renders pick the new "when".
        completed_at: t.completed_at,
        started_at: t.started_at,
        created_at: t.created_at,
        when: pickWhenForTask(t),
      })),
      files: (fd.files || []).map((ff): FeatureFileRow => ({
        path: ff.file_path,
        desc: ff.description ?? '',
      })),
      sessions: fd.sessions || [], // {time, summary, files}
    };
  });

  DATA.features[projectId] = enrichedFeatures;

  DATA.decisions[projectId] = decisions.map((d): AdrCard => ({
    ...d,
    feature: d.feature_id ? featureNameById[d.feature_id] ?? null : null,
  }));

  // Cache sessions for future tab queries (sessions tab, last-activity calcs).
  DATA.sessions = DATA.sessions || {};
  DATA.sessions[projectId] = sessions;

  state.loadedProjects.add(projectId);
}

// Sprint 20 (u3zu): fetch + cache the project overview payload. Separate
// from loadProjectDetail because the overview is a derived aggregate the
// server computes — re-fetching after any feature/task/decision mutation
// is cheaper than mirroring the derivation client-side.
async function loadProjectOverview(projectId: string): Promise<ProjectOverview> {
  const ov = await fetchJSON<ProjectOverview>(`/api/projects/${projectId}/overview`);
  DATA.overviews = DATA.overviews ?? {};
  DATA.overviews[projectId] = ov;
  return ov;
}

/**
 * Drop the cached overview for `projectId` so the next render refetches.
 * Called from mutation paths (task toggle, feature add, decision log) — the
 * overview's status / next_task / recent_* fields depend on those rows.
 *
 * MVP strategy: aggressive invalidation, no diff. The endpoint is cheap.
 */
function invalidateOverview(projectId: string | null): void {
  if (!projectId) return;
  if (DATA.overviews) delete DATA.overviews[projectId];
}

// =================================================
// Documents (Sprint 22, 3wtr — Spec Hub)
// =================================================

const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  prd:          'PRD',
  planning:     '기획서',
  architecture: '아키텍처',
  retro:        '회고',
  feature_spec: 'Feature Spec',
  other:        '기타',
};
/** Render order for the kind-grouped Docs list. Mirrors the label map order
 *  except 'other' is last (catch-all sinks to bottom). */
const DOCUMENT_KIND_ORDER: ReadonlyArray<DocumentKind> = [
  'prd', 'planning', 'architecture', 'feature_spec', 'retro', 'other',
];

async function loadDocuments(projectId: string): Promise<Document[]> {
  const docs = await fetchJSON<Document[]>(`/api/projects/${projectId}/documents`);
  DATA.documents = DATA.documents ?? {};
  DATA.documents[projectId] = docs;
  return docs;
}

async function loadDocumentsForFeature(featureId: string): Promise<Document[]> {
  const docs = await fetchJSON<Document[]>(`/api/features/${featureId}/documents`);
  DATA.documentsByFeature = DATA.documentsByFeature ?? {};
  DATA.documentsByFeature[featureId] = docs;
  return docs;
}

function invalidateDocuments(projectId: string | null): void {
  if (!projectId) return;
  if (DATA.documents) delete DATA.documents[projectId];
  // Overview surfaces "recent docs" implicitly via stats; just drop it too
  // so the Overview tab can reflect new doc counts on next paint.
  invalidateOverview(projectId);
}

async function createDocumentUI(payload: {
  kind: DocumentKind;
  title: string;
  content_md?: string;
}): Promise<void> {
  const pid = state.currentProject;
  if (!pid) return;
  const doc = await mutate<Document>({
    method: 'POST',
    url: `/api/projects/${pid}/documents`,
    body: payload,
    successToast: '문서 추가됨',
  });
  if (!doc) return;
  // Prepend so the new row shows up at the top of its kind group.
  DATA.documents = DATA.documents ?? {};
  DATA.documents[pid] = [doc, ...(DATA.documents[pid] ?? [])];
  state.addingDocument = false;
  state.currentDocument = doc.id;
  invalidateOverview(pid);
  render();
}

async function updateDocumentUI(docId: string, patch: Partial<Pick<Document, 'kind' | 'title' | 'content_md'>>): Promise<void> {
  const pid = state.currentProject;
  if (!pid) return;
  const updated = await mutate<Document>({
    method: 'PATCH',
    url: `/api/documents/${docId}`,
    body: patch,
  });
  if (!updated) return;
  const list = (DATA.documents ?? {})[pid] ?? [];
  const idx = list.findIndex((d) => d.id === docId);
  if (idx >= 0) list[idx] = updated;
  // updated_at moved the row to the front; keep the cached list sorted.
  list.sort((a, b) => b.updated_at - a.updated_at);
  state.editingDocumentId = null;
  state.documentPreview = false;
  invalidateOverview(pid);
  render();
}

async function deleteDocumentUI(docId: string): Promise<void> {
  const pid = state.currentProject;
  if (!pid) return;
  const ok = await mutate({
    method: 'DELETE',
    url: `/api/documents/${docId}`,
    confirm: '이 문서를 삭제할까요?',
    successToast: '문서 삭제됨',
  });
  if (!ok) return;
  DATA.documents = DATA.documents ?? {};
  DATA.documents[pid] = (DATA.documents[pid] ?? []).filter((d) => d.id !== docId);
  if (state.currentDocument === docId) state.currentDocument = null;
  if (state.editingDocumentId === docId) state.editingDocumentId = null;
  invalidateOverview(pid);
  render();
}

async function linkDocumentToFeatureUI(docId: string, featureId: string): Promise<void> {
  const ok = await mutate({
    method: 'POST',
    url: '/api/document-features',
    body: { document_id: docId, feature_id: featureId },
    successToast: '연결됨',
  });
  if (!ok) return;
  // Drop the feature-side cache so next paint refetches with the new row.
  if (DATA.documentsByFeature) delete DATA.documentsByFeature[featureId];
  render();
}

async function unlinkDocumentFromFeatureUI(docId: string, featureId: string): Promise<void> {
  const ok = await mutate({
    method: 'DELETE',
    url: '/api/document-features',
    body: { document_id: docId, feature_id: featureId },
    confirm: '이 연결을 해제할까요?',
    successToast: '연결 해제됨',
  });
  if (!ok) return;
  if (DATA.documentsByFeature) delete DATA.documentsByFeature[featureId];
  render();
}

/**
 * Minimal Markdown → HTML for the preview toggle. Intentionally tiny — no
 * external library (Sprint 22 design constraint, see #102 inventory). Covers
 * the formatting we actually use: headings, bullets, numbered lists, inline
 * `code`, `**bold**`, and code fences. Everything else falls through as a
 * paragraph. User-supplied text is HTML-escaped first so this is safe to
 * stick into innerHTML.
 */
function renderMarkdownLite(src: string): string {
  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const lines = src.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let listKind: 'ul' | 'ol' | null = null;
  let paragraphBuf: string[] = [];

  const flushParagraph = (): void => {
    if (paragraphBuf.length === 0) return;
    const joined = paragraphBuf.join(' ');
    out.push(`<p>${inlineFormat(joined)}</p>`);
    paragraphBuf = [];
  };
  const flushList = (): void => {
    if (listKind) {
      out.push(`</${listKind}>`);
      listKind = null;
    }
  };
  const inlineFormat = (s: string): string =>
    escape(s)
      .replace(/`([^`]+?)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');

  for (const raw of lines) {
    const line = raw;
    if (line.startsWith('```')) {
      flushParagraph(); flushList();
      if (inCodeBlock) {
        out.push('</code></pre>');
        inCodeBlock = false;
      } else {
        out.push('<pre><code>');
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      out.push(escape(line));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(); flushList();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inlineFormat(heading[2]!)}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (listKind !== 'ul') { flushList(); out.push('<ul>'); listKind = 'ul'; }
      out.push(`<li>${inlineFormat(bullet[1]!)}</li>`);
      continue;
    }
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (numbered) {
      flushParagraph();
      if (listKind !== 'ol') { flushList(); out.push('<ol>'); listKind = 'ol'; }
      out.push(`<li>${inlineFormat(numbered[1]!)}</li>`);
      continue;
    }
    if (line.trim() === '') {
      flushParagraph(); flushList();
      continue;
    }
    flushList();
    paragraphBuf.push(line);
  }
  flushParagraph(); flushList();
  if (inCodeBlock) out.push('</code></pre>');
  return out.join('\n');
}

function renderDocs(): void {
  const main = $('#main')!;
  main.innerHTML = '';
  const projectId = state.currentProject;
  if (!projectId) {
    main.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-title', text: '프로젝트를 선택해주세요' }),
    ]));
    return;
  }

  // Detail view? Drill into a single document.
  if (state.currentDocument) {
    renderDocumentDetail(state.currentDocument);
    return;
  }

  // Lazy fetch on first view.
  if (!(DATA.documents ?? {})[projectId]) {
    loadDocuments(projectId).then(() => render()).catch((e) => {
      state.error = e instanceof Error ? e.message : '문서 로드 실패';
      render();
    });
    main.appendChild(el('div', { class: 'page-header' }, [
      el('h1', { class: 'page-title', text: '문서 불러오는 중…' }),
    ]));
    return;
  }
  const docs = DATA.documents![projectId]!;
  const p = getProject()!;

  // Page header + "+ 문서 추가" toolbar.
  main.appendChild(el('div', { class: 'page-header' }, [
    el('div', { class: 'breadcrumb', text: p.name + ' / 문서' }),
    el('h1', { class: 'page-title', text: '문서 (Spec Hub)' }),
    el('p', { class: 'page-tagline', text: 'PRD / 기획서 / 아키텍처 노트 / 회고 / feature spec — feature 와 연결해 작업 컨텍스트를 보존합니다.' }),
  ]));

  const toolbar = el('div');
  toolbar.style.cssText = 'display: flex; justify-content: flex-end; margin-bottom: 12px;';
  const addBtn = el('button', {
    text: state.addingDocument ? '취소' : '+ 문서 추가',
    onClick: () => { state.addingDocument = !state.addingDocument; render(); },
  });
  addBtn.style.cssText = 'padding: 6px 12px; background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text); border-radius: 4px; font: inherit; cursor: pointer;';
  toolbar.appendChild(addBtn);
  main.appendChild(toolbar);

  if (state.addingDocument) {
    main.appendChild(renderDocumentForm(null));
  }

  if (docs.length === 0 && !state.addingDocument) {
    main.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-title', text: '아직 문서가 없습니다' }),
      el('div', { class: 'empty-state-text', text: '`+ 문서 추가` 로 PRD / 기획서 / 아키텍처 메모를 등록할 수 있어요. 작성한 문서는 검색(Cmd+K) 에서도 잡힙니다.' }),
    ]));
    return;
  }

  // kind 별 그룹.
  const grouped: Record<DocumentKind, Document[]> = {
    prd: [], planning: [], architecture: [], retro: [], feature_spec: [], other: [],
  };
  for (const d of docs) grouped[d.kind].push(d);

  DOCUMENT_KIND_ORDER.forEach((kind) => {
    const list = grouped[kind];
    if (list.length === 0) return;
    main.appendChild(el('div', { class: 'section-title' }, [
      el('span', { text: `${DOCUMENT_KIND_LABEL[kind]} · ${list.length}` }),
    ]));
    const cards = el('div', { class: 'feature-card-list' });
    list.forEach((d) => {
      const card = el('div', {
        class: 'feature-card',
        onClick: () => { state.currentDocument = d.id; render(); },
      });
      card.appendChild(el('div', { class: 'feature-card-header' }, [
        el('span', { class: 'feature-card-name', text: d.title, style: 'flex: 1;' }),
        el('span', {
          text: relTime(d.updated_at) ?? '',
          style: 'color: var(--text-3); font-size: 11px;',
        }),
      ]));
      // Preview snippet — first non-empty line, trimmed to 140 chars.
      const preview = (d.content_md || '').split('\n').find((l) => l.trim()) ?? '';
      if (preview) {
        card.appendChild(el('div', { class: 'feature-card-meta' }, [
          el('span', {
            text: preview.length > 140 ? preview.slice(0, 140) + '…' : preview,
            style: 'color: var(--text-2); font-size: 12px;',
          }),
        ]));
      }
      cards.appendChild(card);
    });
    main.appendChild(cards);
  });
}

function renderDocumentDetail(docId: string): void {
  const main = $('#main')!;
  main.innerHTML = '';
  const projectId = state.currentProject!;
  const docs = (DATA.documents ?? {})[projectId] ?? [];
  const doc = docs.find((d) => d.id === docId);
  if (!doc) {
    main.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-title', text: '문서를 찾지 못했습니다' }),
      el('button', {
        text: '← 문서 목록',
        onClick: () => { state.currentDocument = null; render(); },
      }),
    ]));
    return;
  }

  // Back-link header.
  const header = el('div', { class: 'page-header' });
  const back = el('a', {
    class: 'breadcrumb',
    text: '← 문서 목록',
    onClick: () => {
      state.currentDocument = null;
      state.editingDocumentId = null;
      render();
    },
  });
  back.style.cursor = 'pointer';
  header.appendChild(back);

  const titleRow = el('div');
  titleRow.style.cssText = 'display: flex; align-items: center; gap: 12px;';
  titleRow.appendChild(el('h1', { class: 'page-title', text: doc.title }));
  titleRow.appendChild(pillEl('todo', DOCUMENT_KIND_LABEL[doc.kind]));
  header.appendChild(titleRow);
  header.appendChild(el('p', {
    class: 'page-tagline',
    text: '업데이트 ' + (relTime(doc.updated_at) ?? '방금'),
  }));
  main.appendChild(header);

  // Edit / delete affordances.
  const actions = el('div');
  actions.style.cssText = 'display: flex; gap: 8px; margin-bottom: 16px;';
  if (state.editingDocumentId === doc.id) {
    actions.appendChild(el('button', {
      text: state.documentPreview ? '편집' : '미리보기',
      onClick: () => { state.documentPreview = !state.documentPreview; render(); },
    }));
  } else {
    actions.appendChild(el('button', {
      text: '수정',
      onClick: () => {
        state.editingDocumentId = doc.id;
        state.documentPreview = false;
        render();
      },
    }));
  }
  actions.appendChild(el('button', {
    text: '삭제',
    onClick: () => deleteDocumentUI(doc.id),
  }));
  for (const btn of Array.from(actions.children)) {
    (btn as HTMLElement).style.cssText = 'padding: 4px 10px; background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text-2); border-radius: 4px; font: inherit; font-size: 12px; cursor: pointer;';
  }
  main.appendChild(actions);

  // Body — read-only or edit-mode.
  if (state.editingDocumentId === doc.id && !state.documentPreview) {
    main.appendChild(renderDocumentForm(doc));
  } else if (state.documentPreview && state.editingDocumentId === doc.id) {
    const previewBox = el('div', { class: 'feature-spec-section' });
    previewBox.appendChild(el('div', { class: 'detail-section-title' }, [el('span', { text: '미리보기' })]));
    const body = el('div', { class: 'feature-spec-body markdown-preview' });
    body.style.cssText = 'background: var(--bg-elevated); padding: 12px 16px; border-radius: 6px;';
    body.innerHTML = renderMarkdownLite(doc.content_md);
    previewBox.appendChild(body);
    main.appendChild(previewBox);
  } else {
    const readBox = el('div', { class: 'feature-spec-section' });
    if (doc.content_md.trim()) {
      readBox.appendChild(el('pre', { class: 'feature-spec-body', text: doc.content_md }));
    } else {
      readBox.appendChild(el('div', { class: 'empty-state-text', text: '본문이 비어있습니다. "수정" 으로 작성하세요.' }));
    }
    main.appendChild(readBox);
  }
}

/**
 * Reusable form for create + edit. When `doc` is null we're creating; the
 * submit handler routes to createDocumentUI vs updateDocumentUI accordingly.
 */
function renderDocumentForm(doc: Document | null): HTMLElement {
  const wrap = el('div');
  wrap.style.cssText = [
    'background: var(--bg-elevated)',
    'border: 1px solid var(--border)',
    'border-radius: 6px',
    'padding: 16px',
    'margin-bottom: 16px',
    'display: flex',
    'flex-direction: column',
    'gap: 10px',
  ].join('; ');

  const fieldStyle = [
    'width: 100%', 'padding: 8px 10px', 'background: var(--bg)',
    'border: 1px solid var(--border)', 'color: var(--text)', 'border-radius: 4px',
    'font: inherit', 'box-sizing: border-box',
  ].join('; ');
  const labelStyle = 'font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.05em;';

  // title
  wrap.appendChild(el('label', { text: '제목', style: labelStyle }));
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.value = doc?.title ?? '';
  titleInput.placeholder = '문서 제목 (필수)';
  titleInput.style.cssText = fieldStyle;
  wrap.appendChild(titleInput);

  // kind
  wrap.appendChild(el('label', { text: '종류', style: labelStyle }));
  const kindSel = document.createElement('select');
  kindSel.style.cssText = fieldStyle;
  DOCUMENT_KIND_ORDER.forEach((k) => {
    const opt = new Option(DOCUMENT_KIND_LABEL[k], k);
    if ((doc?.kind ?? 'planning') === k) opt.selected = true;
    kindSel.appendChild(opt);
  });
  wrap.appendChild(kindSel);

  // content_md
  wrap.appendChild(el('label', { text: 'Markdown 본문', style: labelStyle }));
  const textarea = document.createElement('textarea');
  textarea.rows = 16;
  textarea.value = doc?.content_md ?? '';
  textarea.placeholder = '## 배경\n...\n## 비범위\n...';
  textarea.style.cssText = fieldStyle + '; resize: vertical; min-height: 240px; font-family: var(--font-mono, monospace);';
  wrap.appendChild(textarea);

  const actions = el('div');
  actions.style.cssText = 'display: flex; gap: 8px; margin-top: 4px;';
  const submit = el('button', {
    text: doc ? '저장' : '생성',
    onClick: () => {
      const title = titleInput.value.trim();
      const err = validateRequired([['제목', title]]);
      if (err) { showError(err); titleInput.focus(); return; }
      const kind = kindSel.value as DocumentKind;
      const content_md = textarea.value;
      if (doc) {
        updateDocumentUI(doc.id, { title, kind, content_md });
      } else {
        createDocumentUI({ title, kind, content_md });
      }
    },
  });
  submit.style.cssText = 'padding: 6px 14px; background: var(--accent); border: 1px solid var(--accent); color: var(--text); border-radius: 4px; font: inherit; cursor: pointer;';
  const cancel = el('button', {
    text: '취소',
    onClick: () => {
      if (doc) {
        state.editingDocumentId = null;
        state.documentPreview = false;
      } else {
        state.addingDocument = false;
      }
      render();
    },
  });
  cancel.style.cssText = 'padding: 6px 14px; background: transparent; border: 1px solid var(--border); color: var(--text-2); border-radius: 4px; font: inherit; cursor: pointer;';
  actions.appendChild(submit);
  actions.appendChild(cancel);
  wrap.appendChild(actions);

  // Cmd/Ctrl+Enter to submit, ESC to cancel.
  wrap.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (doc) {
        state.editingDocumentId = null;
        state.documentPreview = false;
      } else {
        state.addingDocument = false;
      }
      render();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      (submit as HTMLButtonElement).click();
    }
  });
  queueMicrotask(() => titleInput.focus());
  return wrap;
}

// =================================================
// Sessions (Sprint 23, h5uk — Session Intelligence)
// =================================================

/**
 * Sprint 23 (h5uk): extract the "## 남은 일" section from a notes blob so
 * the sessions tab card can show a one-line preview of the "what's
 * unfinished?" hint. Falls back to empty string when the section is
 * absent — claudeMdTemplate v4 nudges users to write it but doesn't
 * force the shape. Section ends at the next `## ` header or end-of-text.
 */
function extractRemainingPreview(notes: string | null | undefined): string {
  if (!notes) return '';
  const re = /^##\s*남은\s*일\s*$([\s\S]*?)(?=^##\s|$(?![\r\n]))/mi;
  const m = re.exec(notes);
  if (!m) return '';
  // First non-empty line in the section, trimmed of bullet markers, capped.
  const body = m[1]!.trim();
  const firstLine = body.split('\n').map((l) => l.trim()).find((l) => l) ?? '';
  const cleaned = firstLine.replace(/^[-*]\s*/, '');
  return cleaned.length > 100 ? cleaned.slice(0, 100) + '…' : cleaned;
}

async function loadSessionDetail(sessionId: string): Promise<SessionDetail> {
  const detail = await fetchJSON<SessionDetail>(`/api/sessions/${sessionId}`);
  DATA.sessionDetails = DATA.sessionDetails ?? {};
  DATA.sessionDetails[sessionId] = detail;
  return detail;
}

async function setActiveProject(projectId: string): Promise<void> {
  state.currentProject = projectId;
  state.error = null;
  // ADR-0018: when switching into a project from the cross-project workspace
  // view, drop the user on the project's Overview first — that's the "what
  // is this project doing?" first screen. Other tabs (features/decisions/
  // sessions) carry over so deep-link / drill-down flows stay intact.
  if (state.currentTab === 'workspace') {
    state.currentTab = 'overview';
  }
  if (!state.loadedProjects.has(projectId)) {
    state.loading = true;
    render();
    try {
      await loadProjectDetail(projectId);
    } catch (e: unknown) {
      state.error = e instanceof Error ? e.message : String(e);
      state.loading = false;
      render();
      return;
    }
  }
  state.loading = false;
  const fs = DATA.features[projectId] || [];
  state.currentFeature = fs[0]?.id ?? null;
  render();
}

// =================================================
// Helpers
// =================================================
// querySelector shorthand. `T extends Element` so callers can narrow without
// the verbose `<HTMLInputElement>` cast at every site.
function $<T extends Element = HTMLElement>(sel: string): T | null {
  return document.querySelector<T>(sel);
}

// Element factory. Takes a tag, an optional props bag (see ElProps), and
// children (string | Node | null, or an array of those).
//
// Recognised props:
//   class    → className
//   text     → textContent
//   html     → innerHTML  (only used in a handful of trusted spots)
//   style    → style.cssText
//   onClick  → onclick
//   anything else → setAttribute(key, String(value))
//
// Two overloads: the first gives precise return types for known HTML tags
// (so `el('input', …).value` works without casting); the second falls back
// to HTMLElement for dynamic tag strings ('svg' etc.).
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps,
  children?: ElChild | ElChild[],
): HTMLElementTagNameMap[K];
function el(
  tag: string,
  props?: ElProps,
  children?: ElChild | ElChild[],
): HTMLElement;
function el(
  tag: string,
  props: ElProps = {},
  children: ElChild | ElChild[] = [],
): HTMLElement {
  const e = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === 'class') e.className = v as string;
    else if (k === 'onClick') e.onclick = v as (e: MouseEvent) => void;
    else if (k === 'html') e.innerHTML = v as string;
    else if (k === 'text') e.textContent = v as string;
    else if (k === 'style') e.style.cssText = v as string;
    else if (v != null) e.setAttribute(k, String(v));
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null) return;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return e;
}

// Single-line input that submits on Enter, cancels on ESC. Used for inline
// "add feature"/"add task" forms — keep markup simple to avoid CSS work.
function inlineInputRow(opts: { placeholder: string; onSubmit: (v: string) => void; onCancel: () => void; initial?: string }) {
  const wrap = el('div', { class: 'inline-input-row' });
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = opts.placeholder;
  input.value = opts.initial ?? '';
  input.style.cssText = [
    'width: 100%',
    'padding: 6px 8px',
    'background: var(--bg-elevated)',
    'border: 1px solid var(--border-strong, var(--border))',
    'color: var(--text)',
    'border-radius: 4px',
    'font: inherit',
    'box-sizing: border-box',
    'margin-top: 6px',
  ].join('; ');
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      const v = input.value.trim();
      if (v) opts.onSubmit(v);
    } else if (e.key === 'Escape') {
      opts.onCancel();
    }
  });
  wrap.appendChild(input);
  // Defer focus until after the DOM insert.
  queueMicrotask(() => input.focus());
  return wrap;
}

// Inline ADR form. Five textareas stacked + optional feature dropdown. Title
// is required, others optional. Cmd/Ctrl+Enter submits; ESC cancels.
// `editing`: when present, the form is in update mode — fields are pre-filled
// and submit calls updateDecisionUI instead of createDecisionUI.
function renderDecisionForm(editing?: AdrCard) {
  const wrap = el('div');
  wrap.style.cssText = [
    'background: var(--bg-elevated)',
    'border: 1px solid var(--border)',
    'border-radius: 6px',
    'padding: 16px',
    'margin-bottom: 16px',
    'display: flex',
    'flex-direction: column',
    'gap: 10px',
  ].join('; ');

  const fieldStyle = [
    'width: 100%',
    'padding: 8px 10px',
    'background: var(--bg)',
    'border: 1px solid var(--border)',
    'color: var(--text)',
    'border-radius: 4px',
    'font: inherit',
    'box-sizing: border-box',
    'resize: vertical',
  ].join('; ');
  const labelStyle = 'font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.05em;';

  const inputs: Record<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement> = {};
  const mk = (key: string, label: string, multiline: boolean, required = false) => {
    const lab = el('label', { text: label });
    lab.style.cssText = labelStyle;
    const node = document.createElement(multiline ? 'textarea' : 'input') as
      HTMLInputElement | HTMLTextAreaElement;
    if (node instanceof HTMLInputElement) node.type = 'text';
    if (node instanceof HTMLTextAreaElement) node.rows = 2;
    node.placeholder = required ? `${label} (필수)` : label;
    node.style.cssText = fieldStyle;
    inputs[key] = node;
    const grp = el('div');
    grp.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
    grp.appendChild(lab);
    grp.appendChild(node);
    return grp;
  };

  wrap.appendChild(mk('title', '제목', false, true));
  wrap.appendChild(mk('context', '배경', true));
  wrap.appendChild(mk('alternatives', '대안', true));
  wrap.appendChild(mk('decision', '결정', true));
  wrap.appendChild(mk('consequences', '결과/영향', true));

  // Pre-fill when editing.
  if (editing) {
    inputs.title.value = editing.title ?? '';
    inputs.context.value = editing.context ?? '';
    inputs.alternatives.value = editing.alternatives ?? '';
    inputs.decision.value = editing.decision ?? '';
    inputs.consequences.value = editing.consequences ?? '';
  }

  // Optional: feature dropdown.
  const features = getFeatures();
  if (features.length > 0) {
    const lab = el('label', { text: '관련 기능 (선택)' });
    lab.style.cssText = labelStyle;
    const sel = document.createElement('select');
    sel.style.cssText = fieldStyle;
    sel.appendChild(new Option('— 없음 —', ''));
    features.forEach((f) => sel.appendChild(new Option(f.name, f.id)));
    if (editing?.feature_id) sel.value = editing.feature_id;
    inputs['feature_id'] = sel;
    const grp = el('div');
    grp.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
    grp.appendChild(lab);
    grp.appendChild(sel);
    wrap.appendChild(grp);
  }

  const closeForm = () => {
    if (editing) state.editingDecisionId = null;
    else state.addingDecision = false;
    render();
  };

  // Action buttons.
  const submit = () => {
    const title = inputs.title.value.trim();
    const err = validateRequired([['제목', title]]);
    if (err) {
      showError(err);
      inputs.title.focus();
      return;
    }
    if (editing) {
      updateDecisionUI(editing.id, {
        title,
        context: inputs.context.value,
        alternatives: inputs.alternatives.value,
        decision: inputs.decision.value,
        consequences: inputs.consequences.value,
        feature_id: inputs.feature_id?.value || null,
      });
    } else {
      createDecisionUI({
        title,
        context: inputs.context.value,
        alternatives: inputs.alternatives.value,
        decision: inputs.decision.value,
        consequences: inputs.consequences.value,
        feature_id: (inputs.feature_id?.value) || undefined,
      });
    }
  };
  const actions = el('div');
  actions.style.cssText = 'display: flex; gap: 8px; margin-top: 6px;';
  const submitBtn = el('button', { text: editing ? '수정 저장' : '저장', onClick: submit });
  submitBtn.style.cssText = 'padding: 6px 14px; background: var(--accent); border: 1px solid var(--accent); color: var(--text); border-radius: 4px; font: inherit; cursor: pointer;';
  const cancelBtn = el('button', { text: '취소', onClick: closeForm });
  cancelBtn.style.cssText = 'padding: 6px 14px; background: transparent; border: 1px solid var(--border); color: var(--text-2); border-radius: 4px; font: inherit; cursor: pointer;';
  actions.appendChild(submitBtn);
  actions.appendChild(cancelBtn);
  wrap.appendChild(actions);

  // Keybindings: ESC cancels anywhere; Cmd/Ctrl+Enter on any field submits.
  wrap.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeForm();
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
  });

  queueMicrotask(() => inputs.title.focus());
  return wrap;
}

function getProject() {
  return DATA.projects.find(p => p.id === state.currentProject);
}
function getFeatures() {
  return DATA.features[state.currentProject!] || [];
}
function getFeature() {
  return getFeatures().find(f => f.id === state.currentFeature);
}
function getDecisions() {
  return DATA.decisions[state.currentProject!] || [];
}
// (Removed in ADR-0016: getFileTree. file-tree retired.)
function getAllSessions(): SessionSummaryRow[] {
  const projId = state.currentProject;
  if (!projId) return [];
  // Use raw API response so unmapped (feature_id=null) sessions also show up —
  // e.g. those imported via `pm import-history`. The previous walk over
  // feature.sessions silently dropped them.
  const raw = (DATA.sessions && DATA.sessions[projId]) || [];
  return raw.map((s) => ({
    id: s.id,
    time: s.time,
    summary: s.summary,
    files: s.files || [],
    feature: s.feature_name ?? undefined,
    featureId: s.feature_id ?? undefined,
  }));
}
function statsFor(projId: string | null): { inProg: number; todo: number; done: number; sessions: number; decisions: number } {
  if (!projId) return { inProg: 0, todo: 0, done: 0, sessions: 0, decisions: 0 };
  const fs = DATA.features[projId] || [];
  const inProg = fs.filter((f) => f.status === 'in_progress').length;
  let todo = 0, done = 0;
  fs.forEach((f) => f.tasks.forEach((t) => {
    if (t.status === 'todo' || t.status === 'in_progress') todo++;
    if (t.status === 'done') done++;
  }));
  // "이번 주 세션" — count from raw sessions within last 7 days, including
  // unmapped (feature_id=null) ones.
  const raw = (DATA.sessions && DATA.sessions[projId]) || [];
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const sessions = raw.filter((s) => s.started_at >= cutoff).length;
  const decisions = (DATA.decisions[projId] || []).length;
  return { inProg, todo, done, sessions, decisions };
}

// =================================================
// Top bar — project switcher
// =================================================
function renderProjectSwitcher(): void {
  const p = getProject();
  $('#currentProjectName')!.textContent = p ? p.name : '프로젝트 없음';
  const mark = $('#currentProjectMark')!;
  mark.style.background = p ? p.markColor : 'var(--bg-soft)';
  mark.textContent = p ? p.mark : '–';

  const dd = $('#projectDropdown')!;
  dd.innerHTML = '';
  DATA.projects.forEach((proj) => {
    const opt = el('div', { class: 'project-option' + (proj.id === state.currentProject ? ' current' : ''),
      onClick: () => { dd.classList.remove('open'); setActiveProject(proj.id); } });
    const m = el('span', { class: 'project-mark' }); m.style.background = proj.markColor; m.textContent = proj.mark;
    opt.appendChild(m);
    const info = el('div', { class: 'project-option-info' }, [
      el('div', { class: 'project-option-name', text: proj.name }),
      el('div', { class: 'project-option-tagline', text: proj.tagline ?? '' }),
    ]);
    opt.appendChild(info);
    dd.appendChild(opt);
  });
}
// (Removed in ADR-0016: firstFile. Code Map file-tree auto-select retired.)

$('#projectBtn')!.onclick = (e) => {
  e.stopPropagation();
  $('#projectDropdown')!.classList.toggle('open');
};
document.addEventListener('click', () => $('#projectDropdown')!.classList.remove('open'));

// =================================================
// Tabs
// =================================================
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'workspace', label: '📋 내 작업' },
  // Sprint 20 (u3zu): 'dashboard' → 'overview'. Single project-detail
  // first screen; consumes /api/projects/:id/overview directly.
  { id: 'overview', label: '오버뷰' },
  // Sprint 22 (3wtr): Spec Hub. Free-form per-project documents.
  { id: 'docs', label: '문서' },
  { id: 'features', label: '기능' },
  { id: 'decisions', label: '결정 기록' },
  { id: 'sessions', label: '세션 로그' },
];
function renderTabs(): void {
  const tabs = $('#tabs')!;
  tabs.innerHTML = '';
  const stats = statsFor(state.currentProject);
  const counts: Partial<Record<Tab, number>> = {
    features: getFeatures().length,
    decisions: stats.decisions,
    sessions: stats.sessions,
  };
  TABS.forEach((t) => {
    const btn = el('button', { class: 'tab' + (t.id === state.currentTab ? ' active' : ''), onClick: () => { state.currentTab = t.id; render(); } });
    btn.appendChild(document.createTextNode(t.label));
    if (counts[t.id] != null) {
      const c = el('span', { class: 'tab-count', text: String(counts[t.id]) });
      btn.appendChild(c);
    }
    tabs.appendChild(btn);
  });
}

// =================================================
// Sidebar
// =================================================
function renderSidebar() {
  const sb = $('#sidebar')!;
  sb.innerHTML = '';
  const showFeatureSidebar = state.currentTab === 'features';

  if (!showFeatureSidebar) {
    sb.classList.remove('visible');
    return;
  }
  sb.classList.add('visible');

  if (showFeatureSidebar) {
    const sec = el('div', { class: 'sb-section' });
    sec.appendChild(el('div', { class: 'sb-heading' }, [
      el('span', { text: '기능' }),
      el('button', {
        class: 'sb-add-btn',
        text: state.addingFeature ? '×' : '+',
        onClick: () => { state.addingFeature = !state.addingFeature; render(); },
      }),
    ]));

    if (state.addingFeature) {
      sec.appendChild(inlineInputRow({
        placeholder: '새 기능 이름…',
        onSubmit: (val) => createFeatureUI(val),
        onCancel: () => { state.addingFeature = false; render(); },
      }));
    }

    type GroupKey = 'in_progress' | 'todo' | 'done';
    const grouped: Record<GroupKey, EnrichedFeature[]> = { in_progress: [], todo: [], done: [] };
    // Archived features are intentionally hidden from the sidebar list. They're
    // still reachable from the dashboard or direct URL, and the detail view's
    // status dropdown can flip them back.
    getFeatures().forEach((f) => {
      if (f.status in grouped) grouped[f.status as GroupKey].push(f);
    });

    const order: ReadonlyArray<{ key: GroupKey; label: string }> = [
      { key: 'in_progress', label: '진행 중' },
      { key: 'todo', label: '할 일' },
      { key: 'done', label: '완료' },
    ];

    // Sprint 18 (y8pr): the "완료" group is collapsible behind a single hint
    // row. Two visual states depending on `state.hideCompletedFeatures`:
    //   * true  + done > 0 → "완료 N개 (숨김 · 보이기)" hint only (no items)
    //   * false + done > 0 → full group, heading carries a "숨기기" affordance
    //   * done = 0         → nothing rendered (same as before)
    const toggleHideCompleted = (): void => {
      state.hideCompletedFeatures = !state.hideCompletedFeatures;
      writePersistedFlag(HIDE_COMPLETED_FEATURES_KEY, state.hideCompletedFeatures);
      render();
    };

    order.forEach(({ key, label }) => {
      if (grouped[key].length === 0) return;

      // Collapsed-hint branch for the done group.
      if (key === 'done' && state.hideCompletedFeatures) {
        const hint = el('div', {
          class: 'sb-heading sb-collapsed-hint',
          onClick: toggleHideCompleted,
          title: '완료된 기능 보이기',
        });
        hint.style.cssText = [
          'margin-top: 10px',
          'font-size: 10.5px',
          'cursor: pointer',
          'color: var(--text-3)',
        ].join('; ');
        hint.appendChild(el('span', { text: `완료 ${grouped[key].length}개 (숨김 · 보이기)` }));
        sec.appendChild(hint);
        return; // skip rendering the items themselves
      }

      const subHeading = el('div', { class: 'sb-heading' });
      subHeading.style.marginTop = '10px';
      subHeading.style.fontSize = '10.5px';
      subHeading.appendChild(el('span', { text: label + ' · ' + grouped[key].length }));
      // Inverse affordance: when done is currently expanded, offer a quick
      // "숨기기" link inside its heading so the user can collapse it back
      // without hunting for a setting elsewhere.
      if (key === 'done') {
        const hideBtn = el('span', {
          text: '숨기기',
          title: '완료된 기능 숨기기',
          onClick: (e: MouseEvent) => { e.stopPropagation(); toggleHideCompleted(); },
        });
        hideBtn.style.cssText = [
          'margin-left: 6px',
          'cursor: pointer',
          'color: var(--text-3)',
          'text-decoration: underline',
        ].join('; ');
        subHeading.appendChild(hideBtn);
      }
      sec.appendChild(subHeading);

      grouped[key].forEach((f) => {
        const item = el('div', { class: 'sb-item' + (f.id === state.currentFeature ? ' active' : ''), onClick: () => { state.currentFeature = f.id; render(); } });
        item.appendChild(el('span', { class: 'sb-status-dot ' + f.status.replace('_', '-') }));
        item.appendChild(el('span', { class: 'sb-item-name', text: f.name }));
        if (f.progress > 0 && f.progress < 100) {
          item.appendChild(el('span', { class: 'sb-item-progress', text: f.progress + '%' }));
        }
        sec.appendChild(item);
      });
    });
    sb.appendChild(sec);
  }
  // (Removed in ADR-0016: file-tree sidebar branch. Code Map retired.)
}

// (Removed in ADR-0016: renderFileTree. File-tree sidebar retired.)

// =================================================
// Main: Overview (Sprint 20, u3zu — replaces the old dashboard)
// =================================================

// Human-readable health label + pill class. Kept here so the renderer is
// the only place that needs to think about strings — domain side just
// emits the discriminator.
const HEALTH_LABEL: Record<ProjectOverview['status'], string> = {
  active:    '진행 중',
  todo_only: '시작 대기',
  stale:     '정체',
  empty:     '비어 있음',
};
const HEALTH_PILL_CLASS: Record<ProjectOverview['status'], string> = {
  active:    'in-progress',
  todo_only: 'todo',
  stale:     'archived',
  empty:     'archived',
};

function renderOverview(): void {
  const main = $('#main')!;
  main.innerHTML = '';
  const projectId = state.currentProject;
  if (!projectId) {
    main.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-title', text: '프로젝트를 선택해주세요' }),
    ]));
    return;
  }

  const ov = (DATA.overviews ?? {})[projectId];

  // Lazy fetch on first view. Triggers a render() once the response lands —
  // the page paints with a placeholder until then to avoid layout jank.
  if (!ov) {
    loadProjectOverview(projectId).then(() => render()).catch((e) => {
      state.error = e instanceof Error ? e.message : '오버뷰 로드 실패';
      render();
    });
    main.appendChild(el('div', { class: 'page-header' }, [
      el('h1', { class: 'page-title', text: '오버뷰 불러오는 중…' }),
    ]));
    return;
  }

  // Header — project name + goal + health pill on the right.
  const header = el('div', { class: 'page-header' });
  if (ov.project.tagline) {
    header.appendChild(el('div', { class: 'breadcrumb', text: ov.project.tagline }));
  }
  const titleRow = el('div');
  titleRow.style.cssText = 'display: flex; align-items: center; gap: 12px;';
  titleRow.appendChild(el('h1', { class: 'page-title', text: ov.project.name }));
  titleRow.appendChild(pillEl(HEALTH_PILL_CLASS[ov.status], HEALTH_LABEL[ov.status]));
  header.appendChild(titleRow);
  if (ov.project.goal) {
    header.appendChild(el('p', { class: 'page-tagline', text: ov.project.goal }));
  }
  main.appendChild(header);

  // Stat grid — driven by server `stats`. No mock trend strings.
  const grid = el('div', { class: 'stat-grid' });
  const lastActivityText = ov.last_activity_at
    ? '최근 활동 ' + (relTime(ov.last_activity_at) ?? '')
    : '활동 기록 없음';
  ([
    { label: '진행 중인 기능', value: ov.project.stats.active_features, trend: '/ ' + ov.project.stats.total_features + ' 전체' },
    { label: '미완료 태스크', value: ov.project.stats.todo_tasks, trend: ov.project.stats.done_tasks + '개 완료' },
    { label: '이번 주 세션', value: ov.project.stats.sessions_this_week, trend: lastActivityText },
    { label: '결정 기록', value: ov.project.stats.decisions, trend: '' },
  ]).forEach((s) => {
    grid.appendChild(el('div', { class: 'stat-card' }, [
      el('div', { class: 'stat-label', text: s.label }),
      el('div', { class: 'stat-value', text: String(s.value) }),
      el('div', { class: 'stat-trend', text: s.trend }),
    ]));
  });
  main.appendChild(grid);

  // Empty-state guidance — Sprint 14/15 onboarding pattern.
  if (ov.status === 'empty') {
    main.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-title', text: '아직 기능이 없습니다' }),
      el('div', {
        class: 'empty-state-text',
        text:
          'CLI 에서 시작하기:'
          + '\n  • `pm import-history` — git history 로 sessions 가져오기'
          + '\n  • `pm extract-features` — commit prefix 로 feature 추출'
          + '\n또는 사이드바에서 기능을 직접 추가하세요.',
      }),
    ]));
    return;
  }

  // Next action — single most-likely "what should I do?" prompt.
  if (ov.next_task) {
    const next = ov.next_task;
    const card = el('div', {
      class: 'now-card',
      onClick: () => { state.currentTab = 'features'; state.currentFeature = next.feature_id; render(); },
    });
    card.style.cursor = 'pointer';
    card.appendChild(el('div', { class: 'now-header' }, [
      el('div', { class: 'now-meta' }, [
        el('div', { class: 'now-eyebrow', text: '다음 액션' }),
        el('h2', { class: 'now-title', text: next.task_name }),
      ]),
    ]));
    card.appendChild(el('p', { class: 'now-goal', text: next.feature_name }));
    main.appendChild(card);
  }

  const cols = el('div', { class: 'two-col' });

  // Left: active features (in_progress + todo, Sprint 19 sort).
  const left = el('div', {});
  left.appendChild(el('div', { class: 'section-title' }, [
    el('span', { text: '활성 기능 · ' + ov.active_features.length }),
    el('a', { class: 'section-link', text: '전체 기능 →', onClick: () => { state.currentTab = 'features'; render(); } }),
  ]));
  const flist = el('div', { class: 'feature-card-list' });
  if (ov.active_features.length === 0) {
    flist.appendChild(el('div', { class: 'empty-state-text', text: '진행 중이거나 todo 인 기능이 없습니다.', style: 'padding: 8px 0; color: var(--text-3);' }));
  } else {
    ov.active_features.forEach((f) => {
      const fcard = el('div', {
        class: 'feature-card',
        onClick: () => { state.currentTab = 'features'; state.currentFeature = f.id; render(); },
      });
      fcard.appendChild(el('div', { class: 'feature-card-header' }, [
        el('span', { class: 'sb-status-dot ' + f.status.replace('_', '-') }),
        el('span', { class: 'feature-card-name', text: f.name }),
        pillEl(f.status, statusLabel(f.status)),
      ]));
      fcard.appendChild(el('div', { class: 'feature-card-meta' }, [
        el('div', { class: 'feature-card-progress' }, [
          el('div', { class: 'progress-bar' }, [el('div', { class: 'progress-fill', style: 'width:' + f.progress + '%' })]),
          el('span', { class: 'feature-card-progress-text', text: f.progress + '%' }),
        ]),
      ]));
      flist.appendChild(fcard);
    });
  }
  left.appendChild(flist);

  // Right: stacked recent sessions + recent decisions.
  const right = el('div', {});
  right.appendChild(el('div', { class: 'section-title' }, [
    el('span', { text: '최근 세션' }),
    el('a', { class: 'section-link', text: '세션 전체 →', onClick: () => { state.currentTab = 'sessions'; render(); } }),
  ]));
  const sList = el('div', { class: 'activity-list' });
  if (ov.recent_sessions.length === 0) {
    sList.appendChild(el('div', { class: 'empty-state-text', text: '아직 세션 기록이 없습니다.', style: 'padding: 8px 0; color: var(--text-3);' }));
  } else {
    ov.recent_sessions.forEach((s) => {
      // Sprint 23 (h5uk): each row navigates to renderSessionDetail.
      const row = el('div', {
        class: 'activity-item',
        onClick: () => {
          state.currentTab = 'sessions';
          state.currentSession = s.id;
          render();
        },
      });
      row.style.cursor = 'pointer';
      row.appendChild(el('div', { class: 'activity-time', text: s.time }));
      row.appendChild(el('div', { class: 'activity-content' }, [
        el('div', { class: 'activity-summary', text: s.summary }),
        el('span', { class: 'activity-feature', text: s.feature_name ?? '' }),
      ]));
      sList.appendChild(row);
    });
  }
  right.appendChild(sList);

  right.appendChild(el('div', { class: 'section-title', style: 'margin-top: 16px;' }, [
    el('span', { text: '최근 결정' }),
    el('a', { class: 'section-link', text: '결정 전체 →', onClick: () => { state.currentTab = 'decisions'; render(); } }),
  ]));
  const dList = el('div', { class: 'activity-list' });
  if (ov.recent_decisions.length === 0) {
    dList.appendChild(el('div', { class: 'empty-state-text', text: '아직 결정 기록이 없습니다.', style: 'padding: 8px 0; color: var(--text-3);' }));
  } else {
    ov.recent_decisions.forEach((d) => {
      dList.appendChild(el('div', { class: 'activity-item' }, [
        el('div', { class: 'activity-time', text: d.date }),
        el('div', { class: 'activity-content' }, [
          el('div', { class: 'activity-summary', text: d.id + ' — ' + d.title }),
          el('span', { class: 'activity-feature', text: d.feature_name ?? '' }),
        ]),
      ]));
    });
  }
  right.appendChild(dList);

  cols.appendChild(left);
  cols.appendChild(right);
  main.appendChild(cols);
}

function pillEl(status: string, label: string): HTMLSpanElement {
  return el('span', { class: 'pill ' + status.replace('_', '-') }, [
    el('span', { class: 'pill-dot' }),
    el('span', { text: label }),
  ]);
}
function statusLabel(s: string): string {
  return s === 'done' ? '완료' : s === 'in_progress' ? '진행 중' : '할 일';
}

// =================================================
// Main: Feature detail
// =================================================
function renderFeatureDetail() {
  const main = $('#main')!;
  main.innerHTML = '';
  const f = getFeature();
  if (!f) {
    main.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-title', text: '기능을 선택해주세요' }),
      el('div', { class: 'empty-state-text', text: '왼쪽에서 기능을 클릭하면 상세 정보가 표시됩니다.' })
    ]));
    return;
  }

  const p = getProject()!;
  const header = el('div', { class: 'page-header' });
  header.appendChild(el('div', { class: 'breadcrumb', text: p.name + ' / 기능' }));

  const titleRow = el('h1', { class: 'page-title' });

  // Name: inline-editable. Click pencil → input replaces the span. Enter saves,
  // ESC cancels. Empty values are rejected client-side (server also enforces).
  if (state.editingFeatureName === f.id) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = f.name;
    input.style.cssText = [
      'padding: 4px 8px',
      'background: var(--bg-elevated)',
      'border: 1px solid var(--border-strong, var(--border))',
      'color: var(--text)',
      'border-radius: 4px',
      'font: inherit',
      'font-size: inherit',
      'min-width: 280px',
    ].join('; ');
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        const v = input.value.trim();
        const err = validateRequired([['이름', v]]);
        if (err) { showError(err); return; }
        if (v === f.name) { state.editingFeatureName = null; render(); return; }
        updateFeatureUI(f.id, { name: v });
      } else if (e.key === 'Escape') {
        state.editingFeatureName = null;
        render();
      }
    });
    titleRow.appendChild(input);
    queueMicrotask(() => { input.focus(); input.select(); });
  } else {
    titleRow.appendChild(el('span', { text: f.name }));
    const editBtn = el('button', {
      text: '수정',
      title: '이름 수정',
      onClick: () => { state.editingFeatureName = f.id; render(); },
    });
    editBtn.style.cssText = 'margin-left: 4px; padding: 2px 8px; background: transparent; border: 1px solid var(--border); color: var(--text-3); border-radius: 4px; font: inherit; font-size: 11px; cursor: pointer;';
    titleRow.appendChild(editBtn);
  }

  // Status: dropdown that PATCHes on change. All four states are exposed —
  // sidebar grouping silently skips archived (see renderSidebar) so the feature
  // disappears from the list once archived. Dashboard / direct URL still reach it.
  const statusSel = document.createElement('select');
  statusSel.title = '상태 변경';
  const STATUS_OPTS: Array<[string, string]> = [
    ['todo', '할 일'],
    ['in_progress', '진행 중'],
    ['done', '완료'],
    ['archived', '보관됨'],
  ];
  STATUS_OPTS.forEach(([v, label]) => {
    const opt = new Option(label, v);
    if (v === f.status) opt.selected = true;
    statusSel.appendChild(opt);
  });
  statusSel.style.cssText = 'margin-left: 8px; padding: 3px 6px; background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text-2); border-radius: 4px; font: inherit; font-size: 12px; cursor: pointer;';
  statusSel.addEventListener('change', () => {
    const next = statusSel.value as FeatureStatus;
    if (next !== f.status) updateFeatureUI(f.id, { status: next });
  });
  titleRow.appendChild(statusSel);

  header.appendChild(titleRow);
  header.appendChild(el('p', { class: 'page-tagline', text: f.goal ?? '' }));
  main.appendChild(header);

  if (f.spec_md && f.spec_md.trim()) {
    const spec = el('div', { class: 'detail-section feature-spec-section' });
    spec.appendChild(el('div', { class: 'detail-section-title' }, [
      el('span', { text: '스펙' }),
    ]));
    spec.appendChild(el('pre', { class: 'feature-spec-body', text: f.spec_md.trim() }));
    main.appendChild(spec);
  }

  const progRow = el('div', { class: 'progress-row' }, [
    el('div', { class: 'progress-bar' }, [el('div', { class: 'progress-fill', style: 'width:' + f.progress + '%' })]),
    el('div', { class: 'progress-text', text: f.tasks.filter((t) => t.status === 'done').length + ' / ' + f.tasks.length + ' · ' + f.progress + '%' }),
  ]);
  progRow.style.marginBottom = '32px';
  main.appendChild(progRow);

  const tasks = el('div', { class: 'detail-section' });
  tasks.appendChild(el('div', { class: 'detail-section-title' }, [
    el('span', { text: '할 일' }),
    el('span', { class: 'detail-section-count', text: String(f.tasks.length) }),
  ]));
  const tlist = el('div', { class: 'task-list' });
  f.tasks.forEach(t => {
    const row = el('div', { class: 'task-row' + (t.status === 'in_progress' ? ' in-progress' : '') });
    const dot = el('span', {
      class: 'task-status ' + t.status.replace('_', '-'),
      title: t.status === 'done' ? '완료 해제' : '완료로 표시',
    });
    if (typeof t.id === 'number') {
      dot.style.cursor = 'pointer';
      dot.onclick = (e: MouseEvent) => { e.stopPropagation(); toggleTaskUI(t.id, t.status); };
    }
    row.appendChild(dot);
    row.appendChild(el('span', { class: 'task-name' + (t.status === 'done' ? ' done' : ''), text: t.name }));
    if (t.when) row.appendChild(el('span', { class: 'task-when', text: t.when }));
    if (typeof t.id === 'number') {
      const delBtn = el('button', {
        text: '×',
        title: '태스크 삭제',
        onClick: (e: MouseEvent) => { e.stopPropagation(); deleteTaskUI(t.id); },
      });
      delBtn.style.cssText = 'margin-left: auto; padding: 0 6px; background: transparent; border: 1px solid var(--border); color: var(--text-3); border-radius: 4px; font-size: 12px; line-height: 18px; cursor: pointer;';
      row.appendChild(delBtn);
    }
    tlist.appendChild(row);
  });

  // Inline "+ 태스크 추가" affordance.
  if (state.addingTaskFor === f.id) {
    tlist.appendChild(inlineInputRow({
      placeholder: '새 태스크 이름…',
      onSubmit: (val) => addTaskUI(f.id, val),
      onCancel: () => { state.addingTaskFor = null; render(); },
    }));
  } else {
    const addRow = el('div', {
      class: 'task-row task-add-row',
      onClick: () => { state.addingTaskFor = f.id; render(); },
    });
    addRow.style.cursor = 'pointer';
    addRow.style.opacity = '0.7';
    addRow.appendChild(el('span', { class: 'task-status', text: '+' , style: 'display:flex; align-items:center; justify-content:center; font-size:12px; color: var(--text-3)' }));
    addRow.appendChild(el('span', { class: 'task-name', text: '태스크 추가', style: 'color: var(--text-3)' }));
    tlist.appendChild(addRow);
  }
  tasks.appendChild(tlist);
  main.appendChild(tasks);

  if (f.files.length > 0) {
    const files = el('div', { class: 'detail-section' });
    files.appendChild(el('div', { class: 'detail-section-title' }, [
      el('span', { text: '관련 코드' }),
      el('span', { class: 'detail-section-count', text: String(f.files.length) }),
    ]));
    const flist = el('div', { class: 'file-list' });
    f.files.forEach(file => {
      // ADR-0016: code-map drilldown retired — row no longer navigates.
      // Path stays visible as plain text so users can still copy it manually
      // for Claude Code prompts.
      const row = el('div', { class: 'file-row' });
      row.appendChild(el('div', { class: 'file-path' }, [el('code', { text: file.path })]));
      row.appendChild(el('div', { class: 'file-desc', text: file.desc }));
      const unlinkBtn = el('button', {
        text: '매핑 해제',
        title: '이 기능에서 파일 매핑을 해제',
        onClick: (e: MouseEvent) => { e.stopPropagation(); unlinkFileUI(f.id, file.path); },
      });
      unlinkBtn.style.cssText = 'margin-left: auto; padding: 4px 8px; background: transparent; border: 1px solid var(--border); color: var(--text-3); border-radius: 4px; font-size: 11px; cursor: pointer;';
      row.appendChild(unlinkBtn);
      flist.appendChild(row);
    });
    files.appendChild(flist);
    main.appendChild(files);
  }

  // Sprint 22 (3wtr): "관련 문서" — documents linked to this feature via
  // the document_features junction. Lazy-fetched on first paint; renders
  // a placeholder line until the response lands. Clicking a row jumps to
  // the Docs tab focused on that doc.
  const linkedDocs = (DATA.documentsByFeature ?? {})[f.id];
  if (!linkedDocs) {
    loadDocumentsForFeature(f.id).then(() => render()).catch(() => { /* swallow */ });
  } else if (linkedDocs.length > 0 || DATA.documents?.[state.currentProject!]?.length) {
    // Always show the section if either: there are links, or there's at
    // least one document in the project (so the "+ 문서 연결" affordance
    // shows up and the user can attach without leaving feature detail).
    const docsSec = el('div', { class: 'detail-section' });
    docsSec.appendChild(el('div', { class: 'detail-section-title' }, [
      el('span', { text: '관련 문서' }),
      el('span', { class: 'detail-section-count', text: String(linkedDocs.length) }),
    ]));
    if (linkedDocs.length === 0) {
      docsSec.appendChild(el('div', {
        class: 'empty-state-text',
        text: '연결된 문서가 없습니다. 문서 탭에서 작성한 PRD/기획서를 이 기능에 매핑할 수 있어요.',
        style: 'padding: 8px 0; color: var(--text-3);',
      }));
    } else {
      const dlist = el('div', { class: 'file-list' });
      linkedDocs.forEach((d) => {
        const row = el('div', {
          class: 'file-row',
          onClick: () => {
            state.currentTab = 'docs';
            state.currentDocument = d.id;
            // ensure cached for renderDocumentDetail
            if (state.currentProject && !(DATA.documents ?? {})[state.currentProject]) {
              loadDocuments(state.currentProject).catch(() => { /* render handles */ });
            }
            render();
          },
        });
        row.style.cursor = 'pointer';
        row.appendChild(el('div', { class: 'file-path' }, [
          el('span', { text: DOCUMENT_KIND_LABEL[d.kind], style: 'color: var(--text-3); font-size: 10px; margin-right: 8px;' }),
          el('code', { text: d.title }),
        ]));
        const unlink = el('button', {
          text: '연결 해제',
          title: '이 문서와의 연결을 해제',
          onClick: (e: MouseEvent) => { e.stopPropagation(); unlinkDocumentFromFeatureUI(d.id, f.id); },
        });
        unlink.style.cssText = 'margin-left: auto; padding: 4px 8px; background: transparent; border: 1px solid var(--border); color: var(--text-3); border-radius: 4px; font-size: 11px; cursor: pointer;';
        row.appendChild(unlink);
        dlist.appendChild(row);
      });
      docsSec.appendChild(dlist);
    }
    // "+ 문서 연결" picker — drops down a select of remaining documents in
    // the project, mirroring Sprint 6's file linkage pattern.
    const linkedIds = new Set(linkedDocs.map((d) => d.id));
    const availableDocs = ((DATA.documents ?? {})[state.currentProject!] ?? [])
      .filter((d) => !linkedIds.has(d.id));
    if (availableDocs.length > 0) {
      const picker = el('div');
      picker.style.cssText = 'display: flex; gap: 8px; margin-top: 8px; align-items: center;';
      const sel = document.createElement('select');
      sel.style.cssText = 'padding: 6px 8px; background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text); border-radius: 4px; font: inherit; min-width: 220px;';
      sel.appendChild(new Option('— 문서 연결 —', ''));
      availableDocs.forEach((d) => sel.appendChild(new Option(`[${DOCUMENT_KIND_LABEL[d.kind]}] ${d.title}`, d.id)));
      const submit = el('button', {
        text: '+ 연결',
        onClick: () => {
          const did = sel.value;
          if (!did) return;
          linkDocumentToFeatureUI(did, f.id);
        },
      });
      submit.style.cssText = 'padding: 6px 12px; background: var(--accent); border: 1px solid var(--accent); color: var(--text); border-radius: 4px; font: inherit; font-size: 12px; cursor: pointer;';
      picker.appendChild(sel);
      picker.appendChild(submit);
      docsSec.appendChild(picker);
    }
    main.appendChild(docsSec);
  }

  if (f.sessions.length > 0) {
    const sessions = el('div', { class: 'detail-section' });
    sessions.appendChild(el('div', { class: 'detail-section-title' }, [
      el('span', { text: '작업 기록' }),
      el('span', { class: 'detail-section-count', text: String(f.sessions.length) }),
    ]));
    const slist = el('div', { class: 'session-list' });
    f.sessions.forEach(s => {
      // data-* attrs let the search palette scrollIntoView this row after navigating.
      const row = el('div', {
        class: 'session-row',
        ...(s.id ? { 'data-ref-id': s.id, 'data-kind': 'session' } : {}),
      });
      row.appendChild(el('div', { class: 'session-time', text: s.time }));
      const content = el('div', { class: 'session-summary' }, [el('span', { text: s.summary })]);
      if (s.files && s.files.length) {
        const chips = el('div', { class: 'session-files' });
        s.files.forEach(fname => chips.appendChild(el('span', { class: 'session-file-chip', text: fname })));
        content.appendChild(chips);
      }
      row.appendChild(content);
      slist.appendChild(row);
    });
    sessions.appendChild(slist);
    main.appendChild(sessions);
  }
}

// (Removed in ADR-0016: renderCodeMap + featuresForFile + sessionsForFile.
// Code Map view, AI file-explanation surface, and file-tree helpers retired.
// The "관련 코드" row in feature detail is now read-only — see renderFeatures.)

// =================================================
// Main: Decisions (ADRs)
// =================================================
function renderDecisions(): void {
  const main = $('#main')!;
  main.innerHTML = '';
  const p = getProject()!;

  main.appendChild(el('div', { class: 'page-header' }, [
    el('div', { class: 'breadcrumb', text: p.name + ' / 결정 기록' }),
    el('h1', { class: 'page-title', text: '결정 기록 (ADR)' }),
    el('p', { class: 'page-tagline', text: '아키텍처 결정 사항. Claude가 세션 중 의사결정을 감지해 자동 기록하거나, 직접 작성할 수 있습니다.' })
  ]));

  // Add toolbar with "+ 결정 기록" toggle.
  const toolbar = el('div');
  toolbar.style.cssText = 'display: flex; justify-content: flex-end; margin-bottom: 12px;';
  const addBtn = el('button', {
    text: state.addingDecision ? '취소' : '+ 결정 기록',
    onClick: () => { state.addingDecision = !state.addingDecision; render(); },
  });
  addBtn.style.cssText = 'padding: 6px 12px; background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text); border-radius: 4px; font: inherit; cursor: pointer;';
  toolbar.appendChild(addBtn);
  main.appendChild(toolbar);

  if (state.addingDecision) {
    main.appendChild(renderDecisionForm());
  }

  const adrs = getDecisions();
  if (adrs.length === 0) {
    if (!state.addingDecision) {
      main.appendChild(el('div', { class: 'empty-state' }, [
        el('div', { class: 'empty-state-title', text: '아직 결정 기록이 없습니다' }),
        el('div', { class: 'empty-state-text', text: 'Claude 세션 중 의미있는 결정이 감지되면 여기에 자동으로 기록됩니다.' })
      ]));
    }
    return;
  }

  const list = el('div', { class: 'adr-list' });
  adrs.forEach(adr => {
    // If this card is the one being edited, render the prefilled form in its
    // place — keeps focus near the user's click target instead of jumping to
    // the top toolbar form.
    if (state.editingDecisionId === adr.id) {
      list.appendChild(renderDecisionForm(adr));
      return;
    }

    // data-* attrs let the search palette scrollIntoView this card after navigating.
    const card = el('div', { class: 'adr-card', 'data-ref-id': adr.id, 'data-kind': 'decision' });
    const headerRow = el('div', { class: 'adr-header' }, [
      el('span', { class: 'adr-id', text: adr.id }),
      el('span', { class: 'adr-date', text: adr.date }),
    ]);
    const actionGroup = el('span');
    actionGroup.style.cssText = 'margin-left: auto; display: flex; gap: 6px;';
    const editBtn = el('button', {
      text: '수정',
      title: '결정 수정',
      onClick: (e: MouseEvent) => {
        e.stopPropagation();
        state.editingDecisionId = adr.id;
        state.addingDecision = false;
        render();
      },
    });
    editBtn.style.cssText = 'padding: 2px 8px; background: transparent; border: 1px solid var(--border); color: var(--text-3); border-radius: 4px; font-size: 11px; cursor: pointer;';
    const delBtn = el('button', {
      text: '삭제',
      title: '결정 삭제',
      onClick: (e: MouseEvent) => { e.stopPropagation(); deleteDecisionUI(adr.id); },
    });
    delBtn.style.cssText = 'padding: 2px 8px; background: transparent; border: 1px solid var(--border); color: var(--text-3); border-radius: 4px; font-size: 11px; cursor: pointer;';
    actionGroup.appendChild(editBtn);
    actionGroup.appendChild(delBtn);
    headerRow.appendChild(actionGroup);
    card.appendChild(headerRow);
    card.appendChild(el('h3', { class: 'adr-title', text: adr.title }));
    const body = el('div', { class: 'adr-body' });
    const adrFields: ReadonlyArray<[string, string | null]> = [
      ['배경', adr.context],
      ['결정', adr.decision],
      ['대안', adr.alternatives],
    ];
    adrFields.forEach(([k, v]) => {
      body.appendChild(el('div', { class: 'adr-key', text: k }));
      body.appendChild(el('div', { class: 'adr-val', text: v ?? '' }));
    });
    card.appendChild(body);
    if (adr.feature_id) {
      // Live lookup against current DATA.features so a rename via the inline
      // editor reflects here without a full reload. Falls back to the cached
      // snapshot if the feature was deleted (or somehow not in cache).
      const liveName = getFeatures().find((ff) => ff.id === adr.feature_id)?.name ?? adr.feature;
      if (liveName) {
        card.appendChild(el('div', { class: 'adr-feature-tag' }, [
          el('span', { text: '관련 기능 · ' }),
          el('span', { style: 'color: var(--accent); cursor:pointer', text: liveName, onClick: (e) => {
            e.stopPropagation();
            state.currentTab = 'features';
            state.currentFeature = adr.feature_id;
            render();
          }})
        ]));
      }
    }
    list.appendChild(card);
  });
  main.appendChild(list);
}

// =================================================
// Main: Sessions
// =================================================
function renderSessions(): void {
  // Sprint 23 (h5uk): detail sub-view dispatch — when a session is
  // selected, swap the list for the detail page. Matches Sprint 22's
  // Docs tab pattern (currentDocument drilldown).
  if (state.currentSession) {
    renderSessionDetail(state.currentSession);
    return;
  }

  const main = $('#main')!;
  main.innerHTML = '';
  const p = getProject()!;

  main.appendChild(el('div', { class: 'page-header' }, [
    el('div', { class: 'breadcrumb', text: p.name + ' / 세션 로그' }),
    el('h1', { class: 'page-title', text: '세션 로그' }),
    el('p', { class: 'page-tagline', text: 'Claude Code로 작업한 모든 세션의 기록. 세션 종료 시 요약이 자동 저장됩니다.' })
  ]));

  const sessions = getAllSessions();
  if (sessions.length === 0) {
    main.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-title', text: '세션 기록이 없습니다' }),
      el('div', { class: 'empty-state-text', text: 'Claude Code로 작업을 시작하면 세션이 자동 기록됩니다.' })
    ]));
    return;
  }

  type DayBucket = '오늘' | '어제' | '이전';
  const groups: Partial<Record<DayBucket, SessionSummaryRow[]>> = {};
  sessions.forEach((s) => {
    const key: DayBucket = s.time.startsWith('오늘') ? '오늘' : s.time.startsWith('어제') ? '어제' : '이전';
    (groups[key] = groups[key] || []).push(s);
  });

  const dayOrder: ReadonlyArray<DayBucket> = ['오늘', '어제', '이전'];
  dayOrder.forEach((g) => {
    const bucket = groups[g];
    if (!bucket) return;
    const grp = el('div', { class: 'session-day-group' });
    grp.appendChild(el('div', { class: 'session-day-label', text: g }));
    bucket.forEach((s) => {
      // Match the dataset on session-row in renderFeatureDetail so the search
      // palette can scroll-to-row regardless of which tab the user lands on.
      // Sprint 23 (h5uk): cards drill into renderSessionDetail on click.
      const card = el('div', {
        class: 'session-card',
        ...(s.id ? { 'data-ref-id': s.id, 'data-kind': 'session' } : {}),
        onClick: () => {
          if (!s.id) return;
          state.currentSession = s.id;
          render();
        },
      });
      card.style.cursor = s.id ? 'pointer' : 'default';
      card.appendChild(el('div', { class: 'session-card-time', text: s.time }));
      const right = el('div', {});
      right.appendChild(el('p', { class: 'session-card-summary', text: s.summary }));
      // Sprint 23 (h5uk): if the cached detail has notes with a "## 남은 일"
      // section, surface the first bullet as a preview line so the user can
      // tell at a glance which sessions left work unfinished. The cards
      // page itself doesn't fetch detail (cost would be N round-trips for
      // a long list); preview only appears when the detail has been viewed
      // at least once and is in the cache.
      const cachedDetail = (DATA.sessionDetails ?? {})[s.id ?? ''];
      const remaining = cachedDetail ? extractRemainingPreview(cachedDetail.notes) : '';
      if (remaining) {
        right.appendChild(el('div', {
          class: 'session-card-remaining',
          text: '남은 일: ' + remaining,
          style: 'color: var(--text-3); font-size: 11px; margin-top: 4px;',
        }));
      }
      const meta = el('div', { class: 'session-card-meta' });
      const fchip = el('span', { class: 'activity-feature', text: s.feature ?? '', onClick: (e) => {
        e.stopPropagation();
        state.currentTab = 'features';
        if (s.featureId) state.currentFeature = s.featureId;
        render();
      } });
      fchip.style.cursor = 'pointer';
      meta.appendChild(fchip);
      (s.files || []).forEach((fname) => {
        meta.appendChild(el('span', { class: 'session-file-chip', text: fname }));
      });
      right.appendChild(meta);
      card.appendChild(right);
      grp.appendChild(card);
    });
    main.appendChild(grp);
  });
}

/**
 * Sprint 23 (h5uk): session detail sub-view. Lazily fetches the rich
 * `SessionDetail` shape (joined feature_name + files + prev/next) on first
 * paint, renders the structured `notes` as Markdown (reuses Sprint 22's
 * `renderMarkdownLite`), and exposes "← 이전 세션 / 다음 세션 →" nav.
 */
function renderSessionDetail(sessionId: string): void {
  const main = $('#main')!;
  main.innerHTML = '';
  const detail = (DATA.sessionDetails ?? {})[sessionId];

  if (!detail) {
    loadSessionDetail(sessionId).then(() => render()).catch((e) => {
      state.error = e instanceof Error ? e.message : '세션 로드 실패';
      render();
    });
    main.appendChild(el('div', { class: 'page-header' }, [
      el('h1', { class: 'page-title', text: '세션 불러오는 중…' }),
    ]));
    return;
  }

  // Header — back link + summary + feature link + timestamps.
  const header = el('div', { class: 'page-header' });
  const back = el('a', {
    class: 'breadcrumb',
    text: '← 세션 목록',
    onClick: () => { state.currentSession = null; render(); },
  });
  back.style.cursor = 'pointer';
  header.appendChild(back);
  header.appendChild(el('h1', { class: 'page-title', text: detail.summary ?? '(요약 없음)' }));
  const timeRow = el('p', { class: 'page-tagline' });
  const startedText = '시작 ' + detail.started_at_label;
  const endedText = detail.ended_at_label ? ' · 종료 ' + detail.ended_at_label : ' · 진행 중';
  timeRow.textContent = startedText + endedText;
  header.appendChild(timeRow);
  if (detail.feature_name && detail.feature_id) {
    const featLink = el('a', {
      text: '연결된 기능: ' + detail.feature_name,
      onClick: () => {
        state.currentTab = 'features';
        state.currentFeature = detail.feature_id;
        state.currentSession = null;
        render();
      },
    });
    featLink.style.cssText = 'cursor: pointer; color: var(--accent); font-size: 12px;';
    header.appendChild(featLink);
  }
  main.appendChild(header);

  // Notes body — render as Markdown if non-empty, else hint.
  const notesSec = el('div', { class: 'detail-section feature-spec-section' });
  notesSec.appendChild(el('div', { class: 'detail-section-title' }, [el('span', { text: '메모' })]));
  if (detail.notes && detail.notes.trim()) {
    const body = el('div', { class: 'feature-spec-body markdown-preview' });
    body.style.cssText = 'background: var(--bg-elevated); padding: 12px 16px; border-radius: 6px;';
    body.innerHTML = renderMarkdownLite(detail.notes);
    notesSec.appendChild(body);
  } else {
    notesSec.appendChild(el('div', {
      class: 'empty-state-text',
      text: '메모가 없습니다. claudeMdTemplate v4 가이드에 따라 `## 완료 / ## 남은 일 / ## 결정` 형태로 작성하면 다음 세션에서 자동 노출됩니다.',
      style: 'padding: 8px 0; color: var(--text-3);',
    }));
  }
  main.appendChild(notesSec);

  // Files touched — edit_type chip for each.
  if (detail.files.length > 0) {
    const filesSec = el('div', { class: 'detail-section' });
    filesSec.appendChild(el('div', { class: 'detail-section-title' }, [
      el('span', { text: '수정한 파일' }),
      el('span', { class: 'detail-section-count', text: String(detail.files.length) }),
    ]));
    const flist = el('div', { class: 'file-list' });
    detail.files.forEach((f) => {
      const row = el('div', { class: 'file-row' });
      row.appendChild(el('span', {
        text: f.edit_type,
        style: 'color: var(--text-3); font-size: 10px; margin-right: 8px; min-width: 56px; display: inline-block;',
      }));
      row.appendChild(el('div', { class: 'file-path' }, [el('code', { text: f.file_path })]));
      flist.appendChild(row);
    });
    filesSec.appendChild(flist);
    main.appendChild(filesSec);
  }

  // Prev / next nav within same feature.
  if (detail.prev_session || detail.next_session) {
    const nav = el('div');
    nav.style.cssText = 'display: flex; justify-content: space-between; margin-top: 16px; gap: 12px;';
    const prevBtn = el('button', {
      text: detail.prev_session
        ? '← 이전 세션 (' + detail.prev_session.time + ')'
        : '이전 세션 없음',
      onClick: () => {
        if (detail.prev_session) {
          state.currentSession = detail.prev_session.id;
          render();
        }
      },
    });
    prevBtn.disabled = !detail.prev_session;
    prevBtn.style.cssText = 'flex: 1; padding: 8px 12px; background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text-2); border-radius: 4px; font: inherit; font-size: 12px; cursor: ' + (detail.prev_session ? 'pointer' : 'not-allowed') + '; opacity: ' + (detail.prev_session ? '1' : '0.5') + ';';
    nav.appendChild(prevBtn);

    const nextBtn = el('button', {
      text: detail.next_session
        ? '다음 세션 (' + detail.next_session.time + ') →'
        : '다음 세션 없음',
      onClick: () => {
        if (detail.next_session) {
          state.currentSession = detail.next_session.id;
          render();
        }
      },
    });
    nextBtn.disabled = !detail.next_session;
    nextBtn.style.cssText = 'flex: 1; padding: 8px 12px; background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text-2); border-radius: 4px; font: inherit; font-size: 12px; cursor: ' + (detail.next_session ? 'pointer' : 'not-allowed') + '; opacity: ' + (detail.next_session ? '1' : '0.5') + ';';
    nav.appendChild(nextBtn);
    main.appendChild(nav);
  }
}

// =================================================
// Main: Workspace (cross-project "내 작업")
// =================================================
function renderWorkspace(): void {
  const main = $('#main')!;
  main.innerHTML = '';

  // Lazy fire — first entry to the tab kicks off the fetch, status-toggle
  // also clears `workspaceFeatures` so this branch refetches.
  if (state.workspaceFeatures === null && !state.workspaceLoading && !state.workspaceError) {
    loadWorkspaceFeatures();
  }

  const header = el('div', { class: 'page-header' }, [
    el('div', { class: 'breadcrumb', text: '워크스페이스' }),
    el('h1', { class: 'page-title', text: '내 작업' }),
    el('p', { class: 'page-tagline', text: '등록된 모든 프로젝트의 진행 중인 기능을 한 곳에서.' }),
  ]);
  main.appendChild(header);

  // Status filter toggle. Two segmented buttons for now; checking 'todo' adds
  // todo features to the list.
  const filterRow = el('div');
  filterRow.style.cssText = 'display: flex; gap: 8px; margin-bottom: 16px; align-items: center;';
  filterRow.appendChild(el('span', { text: '필터:', style: 'color: var(--text-3); font-size: 12px;' }));
  const STATUS_OPTS: ReadonlyArray<{ key: FeatureStatus; label: string }> = [
    { key: 'in_progress', label: '진행 중' },
    { key: 'todo', label: '할 일' },
    { key: 'done', label: '완료' },
  ];
  STATUS_OPTS.forEach(({ key, label }) => {
    const active = state.workspaceStatuses.includes(key);
    const btn = el('button', {
      text: label,
      onClick: () => {
        // Toggle membership but always keep at least one — empty selection
        // would render confusingly with "0건". Re-select the only remaining
        // tag if user tries to drop it.
        const isOn = state.workspaceStatuses.includes(key);
        if (isOn && state.workspaceStatuses.length === 1) return;
        state.workspaceStatuses = isOn
          ? state.workspaceStatuses.filter((s) => s !== key)
          : [...state.workspaceStatuses, key];
        state.workspaceFeatures = null;
        loadWorkspaceFeatures();
      },
    });
    btn.style.cssText = [
      'padding: 4px 10px',
      'border-radius: 999px',
      'border: 1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
      'background: ' + (active ? 'var(--accent)' : 'transparent'),
      'color: ' + (active ? 'var(--text)' : 'var(--text-2)'),
      'font-size: 12px',
      'cursor: pointer',
    ].join('; ');
    filterRow.appendChild(btn);
  });
  main.appendChild(filterRow);

  // Loading / error / empty / data branches.
  if (state.workspaceError) {
    main.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-title', text: '워크스페이스를 불러오지 못했습니다' }),
      el('div', { class: 'empty-state-text', text: state.workspaceError }),
    ]));
    return;
  }
  if (state.workspaceLoading || state.workspaceFeatures === null) {
    main.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-title', text: '불러오는 중…' }),
    ]));
    return;
  }
  const rows = state.workspaceFeatures;
  if (rows.length === 0) {
    main.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-title', text: '진행 중인 기능이 없습니다' }),
      el('div', {
        class: 'empty-state-text',
        text:
          '`pm import-history`로 git history를 sessions로 가져오거나, '
          + '`pm extract-features`로 commit prefix에서 feature를 추출하거나, '
          + '사이드바에서 프로젝트를 선택해 수동으로 기능을 추가하세요.',
      }),
    ]));
    return;
  }

  // Cards grid — one per workspace feature row.
  const list = el('div', { class: 'feature-card-list' });
  for (const r of rows) {
    const card = el('div', {
      class: 'feature-card',
      onClick: () => { navigateToFeature(r.project_id, r.feature_id); },
    });
    // Header line: project mark + project label + feature name pill.
    // Sprint 20 (u3zu): the project mark + name pair is clickable on its own,
    // navigating to the project's Overview tab (instead of the feature
    // detail the rest of the card triggers). stopPropagation keeps the two
    // gestures distinct so users get the "go look at the project" vs
    // "drill into this feature" affordances side by side.
    const projColor = makeMarkColor(r.project_id);
    const projMark = makeMark(r.project_name);
    const projGroup = el('span', {
      onClick: (e: MouseEvent) => { e.stopPropagation(); navigateToOverview(r.project_id); },
      title: '프로젝트 오버뷰로 이동',
    });
    projGroup.style.cssText = 'display: inline-flex; align-items: center; gap: 6px; cursor: pointer;';
    const m = el('span', { class: 'project-mark', text: projMark });
    m.style.cssText = `background: ${projColor}; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600;`;
    projGroup.appendChild(m);
    projGroup.appendChild(el('span', { class: 'feature-card-project', text: r.project_name, style: 'color: var(--text-3); font-size: 11px;' }));
    const headerLine = el('div', { class: 'feature-card-header' }, [
      projGroup,
      el('span', { class: 'feature-card-name', text: r.feature_name, style: 'font-weight: 600; flex: 1;' }),
      pillEl(r.status, statusLabel(r.status)),
    ]);
    card.appendChild(headerLine);
    const meta = el('div', { class: 'feature-card-meta' }, [
      el('div', { class: 'feature-card-progress' }, [
        el('div', { class: 'progress-bar' }, [el('div', { class: 'progress-fill', style: 'width:' + r.progress + '%' })]),
        el('span', { class: 'feature-card-progress-text', text: `${r.tasks_done}/${r.tasks_done + r.tasks_todo} · ${r.progress}%` }),
      ]),
      el('span', {
        text: r.last_activity_at ? (relTime(r.last_activity_at) ?? '활동 없음') : '활동 없음',
        style: 'color: var(--text-3); font-size: 11px; margin-left: auto;',
      }),
    ]);
    card.appendChild(meta);
    list.appendChild(card);
  }
  main.appendChild(list);
}

// =================================================
// Render
// =================================================
function render() {
  renderProjectSwitcher();
  renderTabs();
  renderSidebar();

  if (state.error) {
    $('#main')!.innerHTML = '';
    $('#main')!.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-title', text: '데이터를 불러오지 못했습니다' }),
      el('div', { class: 'empty-state-text', text: state.error }),
    ]));
    return;
  }
  if (state.loading) {
    $('#main')!.innerHTML = '';
    $('#main')!.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-title', text: '불러오는 중…' }),
    ]));
    return;
  }
  if (DATA.projects.length === 0) {
    $('#main')!.innerHTML = '';
    $('#main')!.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-title', text: '등록된 프로젝트가 없습니다' }),
      el('div', { class: 'empty-state-text', text: 'CLI로 프로젝트를 초기화하세요: `pm init --name "<프로젝트>"`' }),
    ]));
    return;
  }

  if (state.currentTab === 'workspace') renderWorkspace();
  else if (state.currentTab === 'overview') renderOverview();
  else if (state.currentTab === 'docs') renderDocs();
  else if (state.currentTab === 'features') renderFeatureDetail();
  // ADR-0016: 'codemap' tab retired.
  else if (state.currentTab === 'decisions') renderDecisions();
  else if (state.currentTab === 'sessions') renderSessions();

  // Transient toast — fixed top-right, click to dismiss, auto-clears after a
  // kind-dependent timeout via showToast(). We reconstruct on every render but
  // dedupe by class name so old copies don't accumulate.
  document.querySelectorAll('.vm-error-banner').forEach((n) => n.remove());
  if (state.errorMsg) {
    const borderVar =
      state.toastKind === 'success' ? 'var(--accent, #2f8a4a)'
      : state.toastKind === 'info' ? 'var(--info, #5a6acf)'
      : 'var(--warn, #b08300)';
    const banner = el('div', {
      class: 'vm-error-banner',
      text: state.errorMsg,
      onClick: () => { state.errorMsg = null; render(); },
    });
    banner.style.cssText = [
      'position: fixed',
      'top: 16px',
      'right: 16px',
      'max-width: 420px',
      'padding: 10px 14px',
      'background: var(--bg-elevated)',
      `border: 1px solid ${borderVar}`,
      'color: var(--text)',
      'border-radius: 6px',
      'font-size: 12px',
      'box-shadow: 0 4px 12px rgba(0,0,0,0.3)',
      'cursor: pointer',
      'z-index: 1000',
    ].join('; ');
    document.body.appendChild(banner);
  }
}

// =================================================
// Search palette (Cmd+K / Ctrl+K)
// =================================================
// The palette is a singleton overlay appended to <body> on first open and
// re-used afterwards (display: none vs. flex). Wiring contract:
//   - Input is debounced; in-flight fetches are aborted on new keystrokes.
//   - Stale results: if the query changed while a fetch was in flight, the
//     resolved response is dropped instead of clobbering newer state.
//   - Server already HTML-escapes title/snippet and inserts `<mark>` for
//     match highlights, so we innerHTML them directly. See domain.ts
//     `escapeHtml` + sentinel swap in `searchProject`.
// Click/keyboard navigation on result rows is intentionally NOT in this
// task — that's #16. Rows render but do nothing on click for now.

// Debounce window for the global palette. Long enough to coalesce a typed
// word but short enough that typing quickly still feels responsive — Sprint 7
// spec called for 250-350ms, 280ms sits comfortably in that band.
const SEARCH_DEBOUNCE_MS = 280;

// Display order for kind group headers. Matches the kind weight tier in the
// domain layer (feature most boosted → session least). Within each group
// rows preserve the server-provided score order.
// Sprint 22 (3wtr): 'document' slots between decision and file, mirroring
// the KIND_WEIGHT order in domain.ts.
const KIND_GROUP_ORDER: ReadonlyArray<SearchKind> = ['feature', 'decision', 'document', 'file', 'session'];

const KIND_LABEL: Record<SearchKind, string> = {
  feature: '기능',
  decision: '결정',
  document: '문서',
  session: '세션',
  file: '파일',
};
const KIND_CLASS: Record<SearchKind, string> = {
  feature: 'kind-feature',
  decision: 'kind-decision',
  document: 'kind-document',
  session: 'kind-session',
  file: 'kind-file',
};

const searchState: SearchState = {
  open: false,
  query: '',
  loading: false,
  results: [],
  error: null,
  selectedIndex: 0,
};
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let searchAbortController: AbortController | null = null;

function ensureSearchPaletteDom(): void {
  if (document.getElementById('searchPalette')) return;
  const overlay = document.createElement('div');
  overlay.id = 'searchPalette';
  overlay.className = 'search-palette-overlay';
  overlay.style.display = 'none';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '검색');
  overlay.innerHTML = `
    <div class="search-palette">
      <div class="search-palette-input-row">
        <svg width="16" height="16" viewBox="0 0 14 14">
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.4" fill="none"/>
          <path d="M9.5 9.5 L12 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
        <input type="text" id="searchPaletteInput" class="search-palette-input"
               placeholder="기능, 결정, 세션, 파일 검색…" autocomplete="off" spellcheck="false">
        <span class="kbd-hint">Esc</span>
      </div>
      <div class="search-palette-results" id="searchPaletteResults"></div>
    </div>
  `;
  // Click-on-backdrop closes; clicks inside the panel don't bubble to here.
  overlay.addEventListener('click', (e: MouseEvent) => {
    if (e.target === overlay) closeSearchPalette();
  });
  const input = overlay.querySelector('#searchPaletteInput') as HTMLInputElement;
  input.addEventListener('input', (e: Event) => onSearchInput((e.target as HTMLInputElement).value));
  document.body.appendChild(overlay);
}

function openSearchPalette(): void {
  ensureSearchPaletteDom();
  searchState.open = true;
  const overlay = document.getElementById('searchPalette')!;
  overlay.style.display = 'flex';
  const input = document.getElementById('searchPaletteInput') as HTMLInputElement;
  input.value = searchState.query;
  // Defer focus so the browser doesn't fight the keydown that triggered us.
  setTimeout(() => input.focus(), 0);
  renderSearchResults();
}

function closeSearchPalette(): void {
  searchState.open = false;
  const overlay = document.getElementById('searchPalette');
  if (overlay) overlay.style.display = 'none';
  if (searchAbortController) {
    searchAbortController.abort();
    searchAbortController = null;
  }
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
}

function onSearchInput(value: string): void {
  searchState.query = value;
  searchState.error = null;
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);

  searchState.selectedIndex = 0;
  if (!value.trim()) {
    searchState.results = [];
    searchState.loading = false;
    if (searchAbortController) { searchAbortController.abort(); searchAbortController = null; }
    renderSearchResults();
    return;
  }
  searchState.loading = true;
  renderSearchResults();
  searchDebounceTimer = setTimeout(() => doSearch(value), SEARCH_DEBOUNCE_MS);
}

async function doSearch(q: string): Promise<void> {
  const projectId = state.currentProject;
  if (!projectId) {
    searchState.loading = false;
    searchState.results = [];
    renderSearchResults();
    return;
  }
  if (searchAbortController) searchAbortController.abort();
  searchAbortController = new AbortController();
  const url = `/api/projects/${encodeURIComponent(projectId)}/search?q=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url, { signal: searchAbortController.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const results = await res.json();
    // Drop stale responses: if the user kept typing, `query` no longer matches.
    if (searchState.query !== q) return;
    // Re-order by kind tier first, then preserve server score order within
    // each tier. The flat array is what selectedIndex / arrow navigation
    // walks, so it has to match the visual order we render.
    searchState.results = sortResultsByKindGroup(results);
    searchState.loading = false;
    searchState.error = null;
    searchState.selectedIndex = 0;
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    searchState.results = [];
    searchState.loading = false;
    searchState.error = e instanceof Error ? e.message : '검색에 실패했습니다';
  }
  renderSearchResults();
}

// Bucket results by kind in the display order, preserving relative score
// order inside each bucket. Stable on the JS array sort since we use a key
// that only differs across kinds. Unknown kinds (defensive) fall to the end.
function sortResultsByKindGroup(results: SearchResult[]): SearchResult[] {
  const orderOf = (kind: string): number => {
    const idx = KIND_GROUP_ORDER.indexOf(kind as SearchKind);
    return idx === -1 ? KIND_GROUP_ORDER.length : idx;
  };
  // Tag with original index so the sort stays stable across V8 versions.
  return results
    .map((r, i) => ({ r, i, k: orderOf(r.kind) }))
    .sort((a, b) => (a.k - b.k) || (a.i - b.i))
    .map(({ r }) => r);
}

function renderSearchResults(): void {
  const list = document.getElementById('searchPaletteResults');
  if (!list) return;
  list.innerHTML = '';

  if (!state.currentProject) {
    list.appendChild(el('div', { class: 'search-empty', text: '프로젝트를 먼저 선택하세요.' }));
    return;
  }
  if (!searchState.query.trim()) {
    list.appendChild(el('div', { class: 'search-empty', text: '검색어를 입력하세요. (한국어/영문 모두 지원)' }));
    return;
  }
  if (searchState.loading) {
    list.appendChild(el('div', { class: 'search-empty', text: '검색 중…' }));
    return;
  }
  if (searchState.error) {
    list.appendChild(el('div', { class: 'search-empty search-error', text: '검색에 실패했습니다: ' + searchState.error }));
    return;
  }
  if (searchState.results.length === 0) {
    list.appendChild(el('div', { class: 'search-empty', text: '검색 결과가 없습니다.' }));
    return;
  }

  // Clamp in case selectedIndex was set higher than current results length.
  if (searchState.selectedIndex >= searchState.results.length) searchState.selectedIndex = 0;

  let lastKind: SearchKind | null = null;
  searchState.results.forEach((r, i) => {
    // Insert a group header whenever the kind changes from the prior row.
    // Headers are non-interactive (no click/hover handlers), so keyboard
    // navigation still walks the rows in the same flat order.
    if (r.kind !== lastKind) {
      const header = document.createElement('div');
      header.className = 'search-group-header';
      header.textContent = KIND_LABEL[r.kind] ?? r.kind;
      list.appendChild(header);
      lastKind = r.kind;
    }

    const row = document.createElement('div');
    row.className = 'search-result' + (i === searchState.selectedIndex ? ' selected' : '');
    row.dataset.searchIndex = String(i);

    const badge = document.createElement('span');
    badge.className = 'search-result-kind ' + (KIND_CLASS[r.kind] ?? 'kind-file');
    badge.textContent = KIND_LABEL[r.kind] ?? r.kind;

    const body = document.createElement('div');
    body.className = 'search-result-body';

    const title = document.createElement('div');
    title.className = 'search-result-title';
    // Server pre-escapes user content + injects only its own <mark> tags.
    title.innerHTML = r.title ?? '';

    const snippet = document.createElement('div');
    snippet.className = 'search-result-snippet';
    snippet.innerHTML = r.snippet ?? '';

    body.appendChild(title);
    body.appendChild(snippet);
    row.appendChild(badge);
    row.appendChild(body);

    // Mouse hover steers the same selectedIndex that ↑↓ moves — single source
    // of truth, so keyboard and mouse can never disagree about "what's active".
    row.addEventListener('mouseenter', () => {
      if (searchState.selectedIndex !== i) {
        searchState.selectedIndex = i;
        applySelectedRowClass();
      }
    });
    row.addEventListener('click', () => navigateToResult(r));

    list.appendChild(row);
  });
}

// Cheap class-only re-render for selection changes — avoids the cost (and
// visual flash) of rebuilding the whole list on every arrow press / mouseenter.
function applySelectedRowClass(): void {
  const list = document.getElementById('searchPaletteResults');
  if (!list) return;
  const rows = list.querySelectorAll<HTMLElement>('.search-result');
  rows.forEach((row, i) => row.classList.toggle('selected', i === searchState.selectedIndex));
  const target = rows[searchState.selectedIndex];
  if (target) target.scrollIntoView({ block: 'nearest' });
}

// Route to the selected result. Each kind lands on its tab and either selects
// the right entity (feature/file) or scrolls to a marker (decision/session).
// Sessions don't have stable IDs in the current DATA cache, so for now we
// only switch tabs — accepted limitation, see comment.
function navigateToResult(r: SearchResult): void {
  if (!r) return;
  closeSearchPalette();

  const flashRefId = (kind: SearchKind, refId: string) => {
    // Wait for the next paint so render() has installed the new tab's DOM.
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-kind="${kind}"][data-ref-id="${CSS.escape(refId)}"]`,
      );
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.remove('search-flash');
      // Force reflow so the animation re-fires if the same row is targeted twice.
      void el.offsetWidth;
      el.classList.add('search-flash');
    });
  };

  switch (r.kind) {
    case 'feature':
      state.currentTab = 'features';
      state.currentFeature = r.ref_id;
      render();
      break;
    case 'decision':
      state.currentTab = 'decisions';
      render();
      flashRefId('decision', r.ref_id);
      break;
    case 'session':
      // session.id is now threaded through both the sessions tab cards and
      // the feature-detail nested session rows (matching decision pattern).
      state.currentTab = 'sessions';
      render();
      flashRefId('session', r.ref_id);
      break;
    case 'document':
      // Sprint 22 (3wtr): drop into Docs tab + detail view for the matched
      // document. Background-load the project's docs cache so the detail
      // resolves cleanly even on first hit from the search palette.
      state.currentTab = 'docs';
      state.currentDocument = r.ref_id;
      if (state.currentProject && !(DATA.documents ?? {})[state.currentProject]) {
        loadDocuments(state.currentProject).catch(() => { /* render handles */ });
      }
      render();
      break;
    case 'file':
      // ADR-0016: 'file' kind retired on the server (search_fts purged in
      // migration 0005). Defensive branch in case a stale row sneaks in:
      // no-op rather than navigate to a removed tab.
      break;
  }
  // Clear the query so reopening the palette starts fresh.
  searchState.query = '';
  searchState.results = [];
}

// Global keyboard wiring. Cmd+K / Ctrl+K toggles. Esc closes when open.
// While the palette is open, ↑/↓ move the selection and Enter routes.
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if (searchState.open) closeSearchPalette();
    else openSearchPalette();
    return;
  }
  if (!searchState.open) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    closeSearchPalette();
    return;
  }
  const n = searchState.results.length;
  if (e.key === 'ArrowDown') {
    if (n === 0) return;
    e.preventDefault();
    searchState.selectedIndex = (searchState.selectedIndex + 1) % n;
    applySelectedRowClass();
  } else if (e.key === 'ArrowUp') {
    if (n === 0) return;
    e.preventDefault();
    searchState.selectedIndex = (searchState.selectedIndex - 1 + n) % n;
    applySelectedRowClass();
  } else if (e.key === 'Enter') {
    if (n === 0) return;
    e.preventDefault();
    const target = searchState.results[searchState.selectedIndex];
    if (target) navigateToResult(target);
  }
});

// The topbar input is decorative (placeholder + ⌘K hint). Clicking/focusing
// it should open the palette rather than accept typing inline.
const topbarSearchInput = document.querySelector('.global-search input') as HTMLInputElement | null;
if (topbarSearchInput) {
  topbarSearchInput.readOnly = true;
  topbarSearchInput.addEventListener('focus', (e: FocusEvent) => {
    (e.target as HTMLInputElement).blur();
    openSearchPalette();
  });
  topbarSearchInput.addEventListener('click', () => openSearchPalette());
}

// Theme toggle. Initial value already set by the inline <head> script
// (FOUC-safe). This handler only flips and persists the user's choice.
const themeToggleBtn = document.getElementById('themeToggle');
if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('vibemate_theme', next);
    } catch (_) { /* private mode / quota — ignore, theme still applied for the session */ }
  });
}

// Bootstrap: load project list, pick the first, fetch detail, render.
(async () => {
  render(); // initial paint with loading state
  try {
    await loadProjectList();
  } catch (e: unknown) {
    state.error = e instanceof Error ? e.message : String(e);
    state.loading = false;
    render();
    return;
  }
  if (DATA.projects.length === 0) {
    state.loading = false;
    render();
    return;
  }
  await setActiveProject(DATA.projects[0].id);
})();
