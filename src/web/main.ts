// Vibemate web client. Fetches data from the backend HTTP API.
// Shared types from `../server/types` are pure-type (no runtime import).
// The big DATA literal that used to live here was the original mockup —
// see git history for the seed values.

import type {
  Decision,
  Feature,
  FeatureFile,
  FeatureStatus,
  FileNode,
  Project,
  SearchKind,
  SearchResult,
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
  FileDetailResponse,
  FileTreeNode,
  ProjectListEntry,
  ProjectListItem,
  RawSessionResponse,
  SearchState,
  SessionSummaryRow,
  Tab,
  TaskRow,
  WorkspaceFeatureRow,
} from './types';

// In-memory cache populated by API calls. Keyed by project id.
const DATA: DataCache = {
  projects: [],
  features: {},
  decisions: {},
  fileTree: {},
  fileExplanations: {},
};


// State — singleton, mutated in place. Every render*() reads from here.
const state: AppState = {
  currentProject: null,        // set after projects load
  // Workspace is the default landing tab — gives a cross-project overview
  // for new users (or users with several projects) before they pick one.
  currentTab: 'workspace',
  currentFeature: null,
  currentFile: null,
  loading: true,               // initial fetch in flight
  error: null,
  loadedProjects: new Set<string>(),

  // Mutation UI flags
  addingFeature: false,
  addingTaskFor: null,         // feature id while inline form is open
  addingDecision: false,
  linkingFile: null,           // codemap: file path while picker is open (null = closed)
  editingFeatureName: null,    // feature id while name is being inline-edited
  editingDecisionId: null,     // ADR id while edit form is open

  // Transient UI
  errorMsg: null,              // last toast banner text
  toastKind: 'error',          // tint for the transient banner
  fileDetailLoading: false,

  // Workspace tab
  workspaceStatuses: ['in_progress'],
  workspaceFeatures: null,
  workspaceLoading: false,
  workspaceError: null,
};

// Per-(project,path) cache for `/files/detail`, populated lazily from codemap.
const FILE_DETAIL: Record<string, FileDetailResponse | null> = {};

function fdKey(projectId: string, p: string): string {
  return `${projectId}::${p}`;
}

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
async function mutate<T = any>(opts: {
  method: 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  url: string;
  body?: any;
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
  } catch (e: any) {
    showToast(e?.message ?? '네트워크 오류', 'error');
    return null;
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error ?? ''; } catch { /* not JSON */ }
    showToast(humanizeServerError(detail) || `${opts.method} ${opts.url} → HTTP ${res.status}`, 'error');
    return null;
  }

  let data: any = null;
  try { data = await res.json(); } catch { /* empty body — fine */ }
  if (opts.successToast) showToast(opts.successToast, 'success');
  return data as T;
}

function progressFromTasks(tasks: any[]): number {
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
    id: f.id, name: f.name, goal: f.goal, status: f.status,
    progress: 0, tasks: [], files: [], sessions: [],
  };
  DATA.features[projectId] = [...(DATA.features[projectId] || []), enriched];
  state.currentFeature = f.id;
  state.addingFeature = false;
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
    feat.tasks = (feat.tasks || []).filter((x: any) => x.id !== taskId);
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
    const tk = (feat.tasks || []).find((x: any) => x.id === taskId);
    if (tk) {
      tk.status = t.status;
      tk.completed_at = t.completed_at;
      tk.started_at = t.started_at;
      tk.when = pickWhenForTask(tk);
      feat.progress = progressFromTasks(feat.tasks);
      break;
    }
  }
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
  const idx = list.findIndex((d: any) => d.id === adrId);
  if (idx >= 0) {
    const featureName = updated.feature_id
      ? (DATA.features[state.currentProject!] || []).find((f: any) => f.id === updated.feature_id)?.name ?? null
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
    (DATA.decisions[state.currentProject!] || []).filter((d: any) => d.id !== adrId);
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
  const idx = list.findIndex((x: any) => x.id === featureId);
  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      name: updated.name,
      goal: updated.goal,
      status: updated.status,
    };
  }
  state.editingFeatureName = null;
  render();
}

// Drop the cached AI explanation for a file. The actual regeneration happens
// in Claude Code (MCP) — clearing the row just kicks the file back into the
// "needs explanation" queue so the next session's cleanup pass picks it up.
async function clearExplanationUI(filePath: string): Promise<void> {
  const projectId = state.currentProject;
  if (!projectId) return;
  const url = `/api/projects/${encodeURIComponent(projectId)}/file-explanations?path=${encodeURIComponent(filePath)}`;
  const ok = await mutate({
    method: 'DELETE',
    url,
    confirm: '이 파일의 AI 설명을 비울까요?\n다음 Claude Code 세션에서 다시 채워집니다.',
    successToast: '설명 캐시 비움',
  });
  if (!ok) return;
  // Drop & re-fetch the file detail so the panel flips back to the empty state.
  delete FILE_DETAIL[fdKey(projectId, filePath)];
  await loadFileDetail(filePath);
}

async function unlinkFileUI(featureId: string, filePath: string): Promise<void> {
  const url = `/api/features/${encodeURIComponent(featureId)}/files?path=${encodeURIComponent(filePath)}`;
  const ok = await mutate({
    method: 'DELETE',
    url,
    confirm: `이 매핑을 해제할까요?\n${filePath}`,
    successToast: '매핑 해제됨',
  });
  if (!ok) return;
  // Remove from feature.files
  const feat = (DATA.features[state.currentProject!] || []).find((x: any) => x.id === featureId);
  if (feat) feat.files = (feat.files || []).filter((ff: any) => ff.path !== filePath);
  // Drop & re-fetch the file detail
  delete FILE_DETAIL[fdKey(state.currentProject!, filePath)];
  await loadFileDetail(filePath);
}

// Map a file to a feature. Mirror of unlinkFileUI: hit the API, then keep the
// per-feature cache and the per-file detail cache in sync so render() shows
// the new link without a full reload.
async function linkFileUI(featureId: string, filePath: string): Promise<void> {
  const link = await mutate<FeatureFile>({
    method: 'POST',
    url: '/api/feature-files',
    body: { feature_id: featureId, file_path: filePath },
  });
  if (!link) return;
  // Add to feature.files (skip if already present — server upserts)
  const feat = (DATA.features[state.currentProject!] || []).find((x: any) => x.id === featureId);
  if (feat) {
    feat.files = feat.files || [];
    if (!feat.files.some((ff: any) => ff.path === filePath)) {
      feat.files.push({ path: link.file_path, desc: link.description ?? '' });
    }
  }
  // Drop & re-fetch the file detail so the chip list refreshes from server.
  delete FILE_DETAIL[fdKey(state.currentProject!, filePath)];
  state.linkingFile = null;
  await loadFileDetail(filePath);
}

// AI explanations now flow through Claude Code's MCP session — see the
// `pm_get_file_content` + `pm_save_file_explanation` tools. The web UI is
// read-only here: it shows the cached explanation when present, and a hint
// pointing the user at Claude Code when not. There's no in-app trigger.

// Copy `path` to the clipboard, then briefly swap the triggering button's
// label to "복사됨!" for ~1s so the user sees the action took. We avoid
// showError because it's a 4.5s warn-tinted toast — wrong tone for a
// successful copy.
async function copyPathToClipboard(path: string, btn?: HTMLButtonElement): Promise<void> {
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(path);
      ok = true;
    }
  } catch (_) { /* fall through to legacy path */ }
  if (!ok) {
    // Older fallback — selectable input + execCommand. Best-effort only.
    const ta = document.createElement('textarea');
    ta.value = path;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(ta);
  }
  if (btn) {
    const originalText = btn.textContent;
    btn.textContent = ok ? '복사됨!' : '복사 실패';
    btn.disabled = true;
    setTimeout(() => {
      // The DOM may have been re-rendered in the meantime — guard by checking
      // the button's still attached.
      if (btn.isConnected) {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    }, 1000);
  } else if (!ok) {
    showError('복사에 실패했습니다.');
  }
}

async function loadFileDetail(filePath: string): Promise<void> {
  const key = fdKey(state.currentProject!, filePath);
  if (FILE_DETAIL[key]) { render(); return; }
  state.fileDetailLoading = true;
  render();
  try {
    const d = await fetchJSON<FileDetailResponse>(
      `/api/projects/${state.currentProject!}/files/detail?path=${encodeURIComponent(filePath)}`,
    );
    FILE_DETAIL[key] = d;
  } catch {
    FILE_DETAIL[key] = { path: filePath, features: [], sessions: [], explanation: null };
  }
  state.fileDetailLoading = false;
  render();
}

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

// Convert backend `/file-tree` shape ({type:'dir'|'file'}) to renderer shape
// ({type:'folder'|'file'}). The `hot` flag is set if the file's path is in the
// caller-provided set (paths touched in the last 7 days of sessions).
function adaptFileTree(nodes: FileNode[], hot: Set<string>): any[] {
  return nodes.map((n) => ({
    type: n.type === 'dir' ? 'folder' : 'file',
    name: n.name,
    children: n.children ? adaptFileTree(n.children, hot) : undefined,
    features: [],
    hot: n.type === 'file' && hot.has(n.path),
  }));
}

// Files touched in the last 7 days, gathered from project-wide sessions.
const SEVEN_DAYS_MS = 7 * 86_400_000;
function computeHotFiles(sessions: any[]): Set<string> {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const hot = new Set<string>();
  for (const s of sessions || []) {
    const ts = s.started_at ?? 0;
    if (ts < cutoff) continue;
    for (const fp of s.files || []) hot.add(fp);
  }
  return hot;
}

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

// Pick the most informative timestamp for a task row.
function pickWhenForTask(t: any): string | null {
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

async function loadProjectDetail(projectId: string): Promise<void> {
  if (state.loadedProjects.has(projectId)) return;

  // Per-route response shapes diverge from the raw server entities (the API
  // folds in derived fields like `progress`, `date`, etc.), so each fetchJSON
  // call gets a narrow generic. The richer "feature detail" shape comes from
  // `/api/features/:id` and lands in `featureDetails` below.
  const [features, decisions, sessions, fileTree] = await Promise.all([
    fetchJSON<FeatureListItem[]>(`/api/projects/${projectId}/features`),
    fetchJSON<DecisionListItem[]>(`/api/projects/${projectId}/decisions`),
    fetchJSON<RawSessionResponse[]>(`/api/projects/${projectId}/sessions`),
    fetchJSON<FileNode[]>(`/api/projects/${projectId}/file-tree`),
  ]);

  // Hydrate each feature with tasks/files/sessions.
  const featureDetails = await Promise.all(
    features.map((f: Feature) => fetchJSON<FeatureDetailResponse>(`/api/features/${f.id}`)),
  );

  const featureNameById: Record<string, string> = {};
  const enrichedFeatures = featureDetails.map((fd: any) => {
    featureNameById[fd.id] = fd.name;
    return {
      id: fd.id,
      name: fd.name,
      goal: fd.goal,
      status: fd.status,
      progress: fd.progress,
      tasks: (fd.tasks || []).map((t: any) => ({
        id: t.id, // numeric task id, used by PATCH /api/tasks/:id
        name: t.name,
        status: t.status,
        // Carry server timestamps so toggle re-renders pick the new "when".
        completed_at: t.completed_at,
        started_at: t.started_at,
        created_at: t.created_at,
        when: pickWhenForTask(t),
      })),
      files: (fd.files || []).map((ff: any) => ({
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

  // Cache sessions for hot-file computation and future tab queries.
  DATA.sessions = DATA.sessions || {};
  DATA.sessions[projectId] = sessions;

  const hotSet = computeHotFiles(sessions);
  DATA.fileTree[projectId] = adaptFileTree(fileTree, hotSet);
  state.loadedProjects.add(projectId);
}

async function setActiveProject(projectId: string): Promise<void> {
  state.currentProject = projectId;
  state.error = null;
  if (!state.loadedProjects.has(projectId)) {
    state.loading = true;
    render();
    try {
      await loadProjectDetail(projectId);
    } catch (e: any) {
      state.error = e?.message ?? String(e);
      state.loading = false;
      render();
      return;
    }
  }
  state.loading = false;
  const fs = DATA.features[projectId] || [];
  state.currentFeature = fs[0]?.id ?? null;
  const ft = DATA.fileTree[projectId] || [];
  state.currentFile = firstFile(ft);
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
  input.addEventListener('keydown', (e: any) => {
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
function renderDecisionForm(editing?: any) {
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

  const inputs: Record<string, HTMLInputElement | HTMLTextAreaElement> = {};
  const mk = (key: string, label: string, multiline: boolean, required = false) => {
    const lab = el('label', { text: label });
    lab.style.cssText = labelStyle;
    const node = document.createElement(multiline ? 'textarea' : 'input') as any;
    if (!multiline) node.type = 'text';
    if (multiline) node.rows = 2;
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
    features.forEach((f: any) => sel.appendChild(new Option(f.name, f.id)));
    if (editing?.feature_id) sel.value = editing.feature_id;
    inputs['feature_id'] = sel as any;
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
  wrap.addEventListener('keydown', (e: any) => {
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
function getFileTree() {
  return DATA.fileTree[state.currentProject!] || [];
}
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
function firstFile(tree: FileTreeNode[], prefix = ''): string | null {
  for (const node of tree) {
    if (node.type === 'file') return prefix + node.name;
    if (node.children) {
      const found = firstFile(node.children, prefix + node.name + '/');
      if (found) return found;
    }
  }
  return null;
}

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
  { id: 'dashboard', label: '대시보드' },
  { id: 'features', label: '기능' },
  { id: 'codemap', label: '코드 맵' },
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
  const showFileSidebar = state.currentTab === 'codemap';

  if (!showFeatureSidebar && !showFileSidebar) {
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

    order.forEach(({ key, label }) => {
      if (grouped[key].length === 0) return;
      const subHeading = el('div', { class: 'sb-heading' });
      subHeading.style.marginTop = '10px';
      subHeading.style.fontSize = '10.5px';
      subHeading.appendChild(el('span', { text: label + ' · ' + grouped[key].length }));
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

  if (showFileSidebar) {
    const sec = el('div', { class: 'sb-section' });
    sec.appendChild(el('div', { class: 'sb-heading' }, [el('span', { text: '파일' })]));
    renderFileTree(getFileTree(), sec);
    sb.appendChild(sec);
  }
}

function renderFileTree(nodes: FileTreeNode[], parent: HTMLElement, prefix = ''): void {
  nodes.forEach((node) => {
    if (node.type === 'folder') {
      const folder = el('div', { class: 'tree-folder' });
      const header = el('div', { class: 'tree-folder-header' });
      header.appendChild(el('svg', { width: '10', height: '10', viewBox: '0 0 10 10', html: '<path d="M3 2 L6 5 L3 8" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/>' }));
      header.appendChild(el('span', { text: node.name }));
      folder.appendChild(header);
      const children = el('div', { class: 'tree-children' });
      renderFileTree(node.children ?? [], children, prefix + node.name + '/');
      folder.appendChild(children);
      parent.appendChild(folder);
    } else {
      const fullPath = prefix + node.name;
      const isActive = state.currentFile != null && fullPath === state.currentFile;
      const item = el('div', { class: 'tree-file' + (isActive ? ' active' : ''), onClick: () => { state.currentFile = fullPath; render(); } });
      item.appendChild(el('span', { text: node.name }));
      if (node.hot) item.appendChild(el('span', { class: 'tree-file-meta' }));
      parent.appendChild(item);
    }
  });
}

// =================================================
// Main: Dashboard
// =================================================
function renderDashboard(): void {
  const main = $('#main')!;
  main.innerHTML = '';
  const p = getProject()!;
  const stats = statsFor(state.currentProject);
  const fs = getFeatures();
  const inProgFeature = fs.find((f) => f.status === 'in_progress');

  const header = el('div', { class: 'page-header' }, [
    el('div', { class: 'breadcrumb', text: p.tagline ?? '' }),
    el('h1', { class: 'page-title', text: p.name }),
    el('p', { class: 'page-tagline', text: p.goal ?? '' }),
  ]);
  main.appendChild(header);

  const grid = el('div', { class: 'stat-grid' });
  const stats_ = [
    { label: '진행 중인 기능', value: stats.inProg, trend: '/ ' + fs.length + ' 전체' },
    { label: '미완료 태스크', value: stats.todo, trend: stats.done + '개 완료' },
    { label: '이번 주 세션', value: stats.sessions, trend: '+3 vs 지난주', up: true },
    { label: '결정 기록', value: stats.decisions, trend: '최근 ADR-' + (1000 + stats.decisions).toString().slice(1) }
  ];
  stats_.forEach((s) => {
    grid.appendChild(el('div', { class: 'stat-card' }, [
      el('div', { class: 'stat-label', text: s.label }),
      el('div', { class: 'stat-value', text: String(s.value) }),
      el('div', { class: 'stat-trend' + (s.up ? ' up' : ''), text: s.trend }),
    ]));
  });
  main.appendChild(grid);

  if (inProgFeature) {
    main.appendChild(el('div', { class: 'section-title' }, [
      el('span', { text: '지금 작업 중' }),
      el('a', { class: 'section-link', text: '전체 기능 →', onClick: () => { state.currentTab = 'features'; render(); } })
    ]));
    const card = el('div', { class: 'now-card', onClick: () => { state.currentTab = 'features'; state.currentFeature = inProgFeature.id; render(); } });
    card.style.cursor = 'pointer';
    card.appendChild(el('div', { class: 'now-header' }, [
      el('div', { class: 'now-meta' }, [
        el('div', { class: 'now-eyebrow', text: 'IN PROGRESS' }),
        el('h2', { class: 'now-title', text: inProgFeature.name })
      ]),
      pillEl(inProgFeature.status, '진행 중')
    ]));
    card.appendChild(el('p', { class: 'now-goal', text: inProgFeature.goal ?? '' }));
    const progRow = el('div', { class: 'progress-row' }, [
      el('div', { class: 'progress-bar' }, [el('div', { class: 'progress-fill', style: 'width:' + inProgFeature.progress + '%' })]),
      el('div', { class: 'progress-text', text: inProgFeature.progress + '%' })
    ]);
    card.appendChild(progRow);

    const nextTask = inProgFeature.tasks.find(t => t.status === 'in_progress') || inProgFeature.tasks.find(t => t.status === 'todo');
    if (nextTask) {
      const ntDiv = el('div', { class: 'next-task' }, [
        el('span', { class: 'next-task-label', text: '다음' }),
        el('span', { text: nextTask.name })
      ]);
      card.appendChild(ntDiv);
    }
    main.appendChild(card);
  }

  const cols = el('div', { class: 'two-col' });

  const left = el('div', {});
  left.appendChild(el('div', { class: 'section-title', text: '모든 기능' }));
  const flist = el('div', { class: 'feature-card-list' });
  fs.forEach(f => {
    const fcard = el('div', { class: 'feature-card', onClick: () => { state.currentTab = 'features'; state.currentFeature = f.id; render(); } });
    fcard.appendChild(el('div', { class: 'feature-card-header' }, [
      el('span', { class: 'sb-status-dot ' + f.status.replace('_', '-') }),
      el('span', { class: 'feature-card-name', text: f.name }),
      pillEl(f.status, statusLabel(f.status))
    ]));
    fcard.appendChild(el('div', { class: 'feature-card-meta' }, [
      el('div', { class: 'feature-card-progress' }, [
        el('div', { class: 'progress-bar' }, [el('div', { class: 'progress-fill', style: 'width:' + f.progress + '%' })]),
        el('span', { class: 'feature-card-progress-text', text: f.progress + '%' })
      ])
    ]));
    flist.appendChild(fcard);
  });
  left.appendChild(flist);

  const right = el('div', {});
  right.appendChild(el('div', { class: 'section-title' }, [
    el('span', { text: '최근 활동' }),
    el('a', { class: 'section-link', text: '세션 전체 →', onClick: () => { state.currentTab = 'sessions'; render(); } })
  ]));
  const acts = getAllSessions().slice(0, 8);
  const actList = el('div', { class: 'activity-list' });
  acts.forEach(a => {
    actList.appendChild(el('div', { class: 'activity-item' }, [
      el('div', { class: 'activity-time', text: a.time }),
      el('div', { class: 'activity-content' }, [
        el('div', { class: 'activity-summary', text: a.summary }),
        el('span', { class: 'activity-feature', text: a.feature })
      ])
    ]));
  });
  right.appendChild(actList);

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
    input.addEventListener('keydown', (e: any) => {
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
      dot.onclick = (e: any) => { e.stopPropagation(); toggleTaskUI(t.id, t.status); };
    }
    row.appendChild(dot);
    row.appendChild(el('span', { class: 'task-name' + (t.status === 'done' ? ' done' : ''), text: t.name }));
    if (t.when) row.appendChild(el('span', { class: 'task-when', text: t.when }));
    if (typeof t.id === 'number') {
      const delBtn = el('button', {
        text: '×',
        title: '태스크 삭제',
        onClick: (e: any) => { e.stopPropagation(); deleteTaskUI(t.id); },
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
      const row = el('div', { class: 'file-row', onClick: () => { state.currentTab = 'codemap'; state.currentFile = file.path; render(); } });
      row.appendChild(el('div', { class: 'file-path' }, [el('code', { text: file.path })]));
      row.appendChild(el('div', { class: 'file-desc', text: file.desc }));
      const unlinkBtn = el('button', {
        text: '매핑 해제',
        title: '이 기능에서 파일 매핑을 해제',
        onClick: (e: any) => { e.stopPropagation(); unlinkFileUI(f.id, file.path); },
      });
      unlinkBtn.style.cssText = 'margin-left: auto; padding: 4px 8px; background: transparent; border: 1px solid var(--border); color: var(--text-3); border-radius: 4px; font-size: 11px; cursor: pointer;';
      row.appendChild(unlinkBtn);
      flist.appendChild(row);
    });
    files.appendChild(flist);
    main.appendChild(files);
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

// =================================================
// Main: Code map
// =================================================
function renderCodeMap() {
  const main = $('#main')!;
  main.innerHTML = '';
  const path = state.currentFile;
  if (!path) {
    main.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-title', text: '파일을 선택해주세요' }),
      el('div', { class: 'empty-state-text', text: '왼쪽 트리에서 파일을 클릭하면 어떤 기능에 속하는지, AI가 생성한 설명이 표시됩니다.' })
    ]));
    return;
  }

  const p = getProject()!;
  const header = el('div', { class: 'page-header' });
  header.appendChild(el('div', { class: 'breadcrumb', text: p.name + ' / 코드 맵' }));
  main.appendChild(header);

  const ch = el('div', { class: 'codemap-detail-header' });
  ch.appendChild(el('h2', { class: 'codemap-path', text: path }));
  const meta = el('div', { class: 'codemap-meta' }, [
    el('div', { class: 'codemap-meta-item' }, [el('span', { text: '최근 수정 · 오늘 14:30' })]),
    el('div', { class: 'codemap-meta-item' }, [el('span', { text: '124 라인' })]),
    el('div', { class: 'codemap-meta-item' }, [el('span', { text: '7 세션 동안 수정' })])
  ]);
  ch.appendChild(meta);
  main.appendChild(ch);

  // Connected features (and the AI explanation, if cached) come from
  // `/api/projects/:id/files/detail`. Lazily fetched the first time the user
  // views this file in the codemap.
  const detail = FILE_DETAIL[fdKey(state.currentProject!, path)];
  if (!detail && !state.fileDetailLoading) {
    // kick off; render() runs again on completion
    loadFileDetail(path);
  }

  // AI explanation block. Generation is no longer in-app — Claude Code does
  // it via MCP (pm_get_file_content + pm_save_file_explanation). The web UI
  // is read-only: shows cached text when present, otherwise a hint pointing
  // the user at Claude Code with a copyable path.
  const cached = detail?.explanation;
  const expBox = el('div', { class: 'ai-explanation' });
  const eyebrow = el('div', { class: 'ai-explanation-eyebrow' });
  eyebrow.style.cssText = 'display: flex; align-items: center; gap: 8px;';

  if (cached) {
    eyebrow.appendChild(el('span', { text: 'AI 설명 · ' + (relTime(cached.generated_at) ?? '캐시됨') }));
    // "재생성" clears the cache; the next Claude Code cleanup pass refills it.
    // We don't trigger an LLM call from the web — vibemate stays a data store.
    const regenBtn = el('button', {
      text: '재생성',
      title: '캐시를 비우고 다음 Claude Code 세션에서 재생성',
      onClick: () => clearExplanationUI(path),
    });
    regenBtn.style.cssText = 'margin-left: auto; padding: 3px 10px; background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text-2); border-radius: 4px; font: inherit; font-size: 11px; cursor: pointer;';
    eyebrow.appendChild(regenBtn);
    expBox.appendChild(eyebrow);
    // Server stores plain text from Claude Code — render as textContent.
    const body = el('p', { class: 'ai-explanation-text', text: cached.text });
    body.style.whiteSpace = 'pre-wrap';
    expBox.appendChild(body);
  } else {
    eyebrow.appendChild(el('span', { text: 'AI 설명' }));
    expBox.appendChild(eyebrow);
    if (state.fileDetailLoading && !detail) {
      expBox.appendChild(el('p', { class: 'ai-explanation-text', text: '불러오는 중…', style: 'color: var(--text-3);' }));
    } else {
      expBox.appendChild(el('p', {
        class: 'ai-explanation-text',
        text: `Claude Code 세션에서 "${path} 파일 설명을 생성해줘" 라고 요청하면 자동으로 pm_get_file_content + pm_save_file_explanation을 호출합니다.`,
        style: 'color: var(--text-2);',
      }));
      // Path-copy button: lets users paste the path into a Claude Code prompt.
      const copyRow = el('div');
      copyRow.style.cssText = 'margin-top: 8px; display: flex; gap: 8px; align-items: center;';
      const copyBtn = el('button', {
        text: 'path 복사',
        title: '경로를 클립보드에 복사',
      }) as HTMLButtonElement;
      copyBtn.style.cssText = 'padding: 4px 10px; background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text-2); border-radius: 4px; font: inherit; font-size: 11px; cursor: pointer;';
      copyBtn.addEventListener('click', () => copyPathToClipboard(path, copyBtn));
      copyRow.appendChild(copyBtn);
      const pathLabel = el('code', { text: path });
      pathLabel.style.cssText = 'font-size: 11px; color: var(--text-3);';
      copyRow.appendChild(pathLabel);
      expBox.appendChild(copyRow);
    }
  }
  main.appendChild(expBox);

  const sec = el('div', { class: 'detail-section' });
  // "연결된 기능" header gets a "+ 기능에 매핑" toggle on the right.
  const pickerOpen = state.linkingFile === path;
  const linkBtn = el('button', {
    text: pickerOpen ? '취소' : '+ 기능에 매핑',
    onClick: () => { state.linkingFile = pickerOpen ? null : path; render(); },
  });
  linkBtn.style.cssText = 'margin-left: auto; padding: 4px 10px; background: var(--bg-elevated); border: 1px solid var(--border); color: var(--text-2); border-radius: 4px; font: inherit; font-size: 11px; cursor: pointer;';
  const secTitle = el('div', { class: 'detail-section-title' });
  secTitle.style.cssText = 'display: flex; align-items: center; gap: 8px;';
  secTitle.appendChild(el('span', { text: '연결된 기능' }));
  secTitle.appendChild(linkBtn);
  sec.appendChild(secTitle);

  // Inline picker: dropdown of features in this project, excluding ones
  // already linked to this file. Selecting one calls linkFileUI().
  if (pickerOpen) {
    const linkedIds = new Set((detail?.features || []).map((ff: any) => ff.feature_id));
    const candidates = getFeatures().filter((f: any) => !linkedIds.has(f.id));
    const picker = el('div');
    picker.style.cssText = 'display: flex; gap: 8px; margin: 8px 0; align-items: center;';
    if (candidates.length === 0) {
      picker.appendChild(el('span', {
        text: '매핑할 수 있는 기능이 없습니다 (모든 기능이 이미 연결됨).',
        style: 'color: var(--text-3); font-size: 12px;',
      }));
    } else {
      const sel = document.createElement('select');
      sel.style.cssText = [
        'padding: 6px 8px',
        'background: var(--bg-elevated)',
        'border: 1px solid var(--border-strong, var(--border))',
        'color: var(--text)',
        'border-radius: 4px',
        'font: inherit',
        'min-width: 220px',
      ].join('; ');
      sel.appendChild(new Option('— 기능 선택 —', ''));
      candidates.forEach((f: any) => sel.appendChild(new Option(f.name, f.id)));
      const submit = el('button', {
        text: '매핑',
        onClick: () => {
          const fid = (sel as HTMLSelectElement).value;
          const err = validateRequired([['기능', fid]]);
          if (err) { showError(err); return; }
          linkFileUI(fid, path);
        },
      });
      submit.style.cssText = 'padding: 6px 12px; background: var(--accent); border: 1px solid var(--accent); color: var(--text); border-radius: 4px; font: inherit; font-size: 12px; cursor: pointer;';
      picker.appendChild(sel);
      picker.appendChild(submit);
      queueMicrotask(() => sel.focus());
    }
    sec.appendChild(picker);
  }

  if (state.fileDetailLoading && !detail) {
    sec.appendChild(el('div', { class: 'empty-state-text', text: '불러오는 중…', style: 'padding: 8px 0; color: var(--text-3)' }));
  } else if (!detail || detail.features.length === 0) {
    sec.appendChild(el('div', { class: 'empty-state-text', text: '아직 매핑된 기능이 없습니다. 세션 종료 시 자동 매핑되거나, 기능 상세에서 직접 연결할 수 있습니다.', style: 'padding: 8px 0; color: var(--text-3)' }));
  } else {
    const chips = el('div', { class: 'feature-chip-list' });
    detail.features.forEach((ff: any, i: number) => {
      const chip = el('div', { class: 'feature-chip' + (i === 0 ? ' primary' : '') });
      chip.appendChild(el('span', {
        text: ff.name,
        style: 'cursor: pointer',
        onClick: () => { state.currentTab = 'features'; state.currentFeature = ff.feature_id; render(); },
      }));
      const x = el('span', {
        text: '×',
        title: '매핑 해제',
        onClick: (e: any) => { e.stopPropagation(); unlinkFileUI(ff.feature_id, path); },
      });
      x.style.cssText = 'margin-left: 6px; padding: 0 4px; cursor: pointer; color: var(--text-3); font-weight: 600;';
      chip.appendChild(x);
      chips.appendChild(chip);
    });
    sec.appendChild(chips);
  }
  main.appendChild(sec);

  if (detail && detail.sessions.length > 0) {
    const ssec = el('div', { class: 'detail-section' });
    ssec.appendChild(el('div', { class: 'detail-section-title' }, [
      el('span', { text: '이 파일을 건드린 세션' }),
      el('span', { class: 'detail-section-count', text: String(detail.sessions.length) }),
    ]));
    const slist = el('div', { class: 'session-list' });
    detail.sessions.forEach((s) => {
      const row = el('div', { class: 'session-row' });
      row.appendChild(el('div', { class: 'session-time', text: s.time }));
      row.appendChild(el('div', { class: 'session-summary', text: s.summary }));
      slist.appendChild(row);
    });
    ssec.appendChild(slist);
    main.appendChild(ssec);
  }
}

// Currently unused — kept as a forward-looking helper for codemap leaf clicks.
// `node.features` is always [] on the wire; this would surface confirmed links.
function featuresForFile(path: string): FeatureFile[] {
  const fname = path.split('/').pop() ?? '';
  const found: FeatureFile[] = [];
  function walk(nodes: FileTreeNode[]): void {
    nodes.forEach((n) => {
      if (n.type === 'file' && n.name === fname) {
        (n.features || []).forEach((f) => { if (!found.includes(f)) found.push(f); });
      }
      if (n.children) walk(n.children);
    });
  }
  walk(getFileTree());
  return found;
}

function sessionsForFile(path: string): SessionSummaryRow[] {
  const fname = path.split('/').pop() ?? '';
  const out: SessionSummaryRow[] = [];
  getFeatures().forEach((f) => {
    (f.sessions || []).forEach((s) => {
      if ((s.files || []).some((sf) => sf === fname || sf.endsWith('/' + fname))) {
        out.push({ ...s, feature: f.name });
      }
    });
  });
  return out;
}

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
      onClick: (e: any) => {
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
      onClick: (e: any) => { e.stopPropagation(); deleteDecisionUI(adr.id); },
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
      const card = el('div', {
        class: 'session-card',
        ...(s.id ? { 'data-ref-id': s.id, 'data-kind': 'session' } : {}),
      });
      card.appendChild(el('div', { class: 'session-card-time', text: s.time }));
      const right = el('div', {});
      right.appendChild(el('p', { class: 'session-card-summary', text: s.summary }));
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
    const projColor = makeMarkColor(r.project_id);
    const projMark = makeMark(r.project_name);
    const headerLine = el('div', { class: 'feature-card-header' }, [
      (() => {
        const m = el('span', { class: 'project-mark', text: projMark });
        m.style.cssText = `background: ${projColor}; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600;`;
        return m;
      })(),
      el('span', { class: 'feature-card-project', text: r.project_name, style: 'color: var(--text-3); font-size: 11px;' }),
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
  else if (state.currentTab === 'dashboard') renderDashboard();
  else if (state.currentTab === 'features') renderFeatureDetail();
  else if (state.currentTab === 'codemap') renderCodeMap();
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
const KIND_GROUP_ORDER: ReadonlyArray<SearchKind> = ['feature', 'decision', 'file', 'session'];

const KIND_LABEL: Record<SearchKind, string> = {
  feature: '기능',
  decision: '결정',
  session: '세션',
  file: '파일',
};
const KIND_CLASS: Record<SearchKind, string> = {
  feature: 'kind-feature',
  decision: 'kind-decision',
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
  overlay.addEventListener('click', (e: any) => {
    if (e.target === overlay) closeSearchPalette();
  });
  const input = overlay.querySelector('#searchPaletteInput') as HTMLInputElement;
  input.addEventListener('input', (e: any) => onSearchInput(e.target.value));
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
  } catch (e: any) {
    if (e?.name === 'AbortError') return;
    searchState.results = [];
    searchState.loading = false;
    searchState.error = e?.message ?? '검색에 실패했습니다';
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
    case 'file':
      state.currentTab = 'codemap';
      state.currentFile = r.ref_id; // ref_id IS the file_path
      render();
      break;
  }
  // Clear the query so reopening the palette starts fresh.
  searchState.query = '';
  searchState.results = [];
}

// Global keyboard wiring. Cmd+K / Ctrl+K toggles. Esc closes when open.
// While the palette is open, ↑/↓ move the selection and Enter routes.
document.addEventListener('keydown', (e: any) => {
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
  topbarSearchInput.addEventListener('focus', (e: any) => {
    e.target.blur();
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
  } catch (e: any) {
    state.error = e?.message ?? String(e);
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
