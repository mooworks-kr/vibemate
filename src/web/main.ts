// @ts-nocheck
// Vibemate web client. Fetches data from the backend HTTP API.
// Shared types from `../server/types` are pure-type (no runtime import).
// The big DATA literal that used to live here was the original mockup —
// see git history for the seed values.

import type { Project, Feature, FileNode } from '../server/types';

// In-memory cache populated by API calls. Keyed by project id.
const DATA: any = {
  projects: [] as Array<Project & { mark: string; markColor: string; stats?: any }>,
  features: {} as Record<string, any[]>,
  decisions: {} as Record<string, any[]>,
  fileTree: {} as Record<string, any[]>,
  fileExplanations: {} as Record<string, string>,
};


// State
const state: any = {
  currentProject: null,        // set after projects load
  currentTab: 'features',
  currentFeature: null,
  currentFile: null,
  loading: true,               // initial fetch in flight
  error: null as string | null,
  loadedProjects: new Set<string>(),
  // Mutation UI flags
  addingFeature: false,
  addingTaskFor: null as string | null, // feature id while inline form is open
  addingDecision: false,
  errorMsg: null as string | null,      // transient banner text
  fileDetailLoading: false,
};

// Per-(project,path) cache for `/files/detail`, populated lazily from codemap.
const FILE_DETAIL: Record<string, { features: any[]; sessions: any[] } | null> = {};

function fdKey(projectId: string, p: string): string {
  return `${projectId}::${p}`;
}

// =================================================
// API helpers
// =================================================
async function fetchJSON(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function sendJSON(method: string, url: string, body: any) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error ?? ''; } catch {}
    throw new Error(humanizeServerError(detail) || `${method} ${url} → HTTP ${res.status}`);
  }
  // DELETE may have empty body in some flows but ours returns {ok:true}
  return res.json();
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

function showError(msg: string): void {
  state.errorMsg = msg;
  render();
  const captured = msg;
  setTimeout(() => {
    if (state.errorMsg === captured) {
      state.errorMsg = null;
      render();
    }
  }, 4500);
}

function progressFromTasks(tasks: any[]): number {
  if (!tasks || tasks.length === 0) return 0;
  const done = tasks.filter((t) => t.status === 'done').length;
  return Math.round((done / tasks.length) * 100);
}

// ---- Mutations (optimistic-ish: update local cache after server confirms) ----

async function createFeatureUI(name: string): Promise<void> {
  const projectId = state.currentProject;
  try {
    const f = await sendJSON('POST', `/api/projects/${projectId}/features`, { name });
    const enriched = {
      id: f.id,
      name: f.name,
      goal: f.goal,
      status: f.status,
      progress: 0,
      tasks: [],
      files: [],
      sessions: [],
    };
    DATA.features[projectId] = [...(DATA.features[projectId] || []), enriched];
    state.currentFeature = f.id;
    state.addingFeature = false;
    render();
  } catch (e: any) {
    showError(e?.message ?? String(e));
  }
}

async function addTaskUI(featureId: string, name: string): Promise<void> {
  try {
    const t = await sendJSON('POST', `/api/features/${featureId}/tasks`, { name });
    const feat = (DATA.features[state.currentProject] || []).find((x: any) => x.id === featureId);
    if (feat) {
      const tk = {
        id: t.id, name: t.name, status: t.status,
        completed_at: t.completed_at, started_at: t.started_at, created_at: t.created_at,
        when: null as string | null,
      };
      tk.when = pickWhenForTask(tk);
      feat.tasks.push(tk);
      feat.progress = progressFromTasks(feat.tasks);
    }
    state.addingTaskFor = null;
    render();
  } catch (e: any) {
    showError(e?.message ?? String(e));
  }
}

async function toggleTaskUI(taskId: number, currentStatus: string): Promise<void> {
  const next = currentStatus === 'done' ? 'todo' : 'done';
  try {
    const t = await sendJSON('PATCH', `/api/tasks/${taskId}`, { status: next });
    for (const feat of DATA.features[state.currentProject] || []) {
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
  } catch (e: any) {
    showError(e?.message ?? String(e));
  }
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
  const body: any = { title: payload.title };
  for (const k of ['context', 'alternatives', 'decision', 'consequences', 'feature_id']) {
    const v = (payload as any)[k];
    if (typeof v === 'string' && v.trim()) body[k] = v.trim();
  }
  try {
    const adr = await sendJSON('POST', `/api/projects/${state.currentProject}/decisions`, body);
    const featureName = adr.feature_id
      ? ((DATA.features[state.currentProject] || []).find((f: any) => f.id === adr.feature_id)?.name ?? null)
      : null;
    const enriched = {
      id: adr.id,
      date: '방금', // server response includes created_at but no formatted date
      feature_id: adr.feature_id,
      feature: featureName,
      title: adr.title,
      context: adr.context,
      decision: adr.decision,
      alternatives: adr.alternatives,
      consequences: adr.consequences,
    };
    DATA.decisions[state.currentProject] = [enriched, ...(DATA.decisions[state.currentProject] || [])];
    state.addingDecision = false;
    render();
  } catch (e: any) {
    showError(e?.message ?? String(e));
  }
}

async function unlinkFileUI(featureId: string, filePath: string): Promise<void> {
  try {
    await sendJSON('DELETE', '/api/feature-files', {
      feature_id: featureId,
      file_path: filePath,
    });
    // Remove from feature.files
    const feat = (DATA.features[state.currentProject] || []).find((x: any) => x.id === featureId);
    if (feat) feat.files = (feat.files || []).filter((ff: any) => ff.path !== filePath);
    // Drop & re-fetch the file detail
    delete FILE_DETAIL[fdKey(state.currentProject, filePath)];
    await loadFileDetail(filePath);
  } catch (e: any) {
    showError(e?.message ?? String(e));
  }
}

async function loadFileDetail(filePath: string): Promise<void> {
  const key = fdKey(state.currentProject, filePath);
  if (FILE_DETAIL[key]) { render(); return; }
  state.fileDetailLoading = true;
  render();
  try {
    const d = await fetchJSON(
      `/api/projects/${state.currentProject}/files/detail?path=${encodeURIComponent(filePath)}`,
    );
    FILE_DETAIL[key] = d;
  } catch {
    FILE_DETAIL[key] = { features: [], sessions: [] };
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
  const projects = await fetchJSON('/api/projects');
  DATA.projects = projects.map((p: any) => ({
    ...p,
    mark: makeMark(p.name),
    markColor: makeMarkColor(p.id),
  }));
}

async function loadProjectDetail(projectId: string): Promise<void> {
  if (state.loadedProjects.has(projectId)) return;

  const [features, decisions, sessions, fileTree] = await Promise.all([
    fetchJSON(`/api/projects/${projectId}/features`),
    fetchJSON(`/api/projects/${projectId}/decisions`),
    fetchJSON(`/api/projects/${projectId}/sessions`),
    fetchJSON(`/api/projects/${projectId}/file-tree`),
  ]);

  // Hydrate each feature with tasks/files/sessions.
  const featureDetails = await Promise.all(
    features.map((f: Feature) => fetchJSON(`/api/features/${f.id}`)),
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

  DATA.decisions[projectId] = decisions.map((d: any) => ({
    id: d.id,
    date: d.date,
    feature_id: d.feature_id,
    feature: d.feature_id ? featureNameById[d.feature_id] ?? null : null,
    title: d.title,
    context: d.context,
    decision: d.decision,
    alternatives: d.alternatives,
    consequences: d.consequences,
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
const $ = sel => document.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const e = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === 'class') e.className = v;
    else if (k === 'onClick') e.onclick = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style') e.style.cssText = v;
    else e.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach(c => {
    if (c == null) return;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return e;
};

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
function renderDecisionForm() {
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

  // Optional: feature dropdown.
  const features = getFeatures();
  if (features.length > 0) {
    const lab = el('label', { text: '관련 기능 (선택)' });
    lab.style.cssText = labelStyle;
    const sel = document.createElement('select');
    sel.style.cssText = fieldStyle;
    sel.appendChild(new Option('— 없음 —', ''));
    features.forEach((f: any) => sel.appendChild(new Option(f.name, f.id)));
    inputs['feature_id'] = sel as any;
    const grp = el('div');
    grp.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
    grp.appendChild(lab);
    grp.appendChild(sel);
    wrap.appendChild(grp);
  }

  // Action buttons.
  const submit = () => {
    const title = inputs.title.value.trim();
    if (!title) {
      showError('제목은 필수입니다');
      inputs.title.focus();
      return;
    }
    createDecisionUI({
      title,
      context: inputs.context.value,
      alternatives: inputs.alternatives.value,
      decision: inputs.decision.value,
      consequences: inputs.consequences.value,
      feature_id: (inputs.feature_id?.value) || undefined,
    });
  };
  const actions = el('div');
  actions.style.cssText = 'display: flex; gap: 8px; margin-top: 6px;';
  const submitBtn = el('button', { text: '저장', onClick: submit });
  submitBtn.style.cssText = 'padding: 6px 14px; background: var(--accent); border: 1px solid var(--accent); color: var(--text); border-radius: 4px; font: inherit; cursor: pointer;';
  const cancelBtn = el('button', { text: '취소', onClick: () => { state.addingDecision = false; render(); } });
  cancelBtn.style.cssText = 'padding: 6px 14px; background: transparent; border: 1px solid var(--border); color: var(--text-2); border-radius: 4px; font: inherit; cursor: pointer;';
  actions.appendChild(submitBtn);
  actions.appendChild(cancelBtn);
  wrap.appendChild(actions);

  // Keybindings: ESC cancels anywhere; Cmd/Ctrl+Enter on any field submits.
  wrap.addEventListener('keydown', (e: any) => {
    if (e.key === 'Escape') { state.addingDecision = false; render(); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
  });

  queueMicrotask(() => inputs.title.focus());
  return wrap;
}

function getProject() {
  return DATA.projects.find(p => p.id === state.currentProject);
}
function getFeatures() {
  return DATA.features[state.currentProject] || [];
}
function getFeature() {
  return getFeatures().find(f => f.id === state.currentFeature);
}
function getDecisions() {
  return DATA.decisions[state.currentProject] || [];
}
function getFileTree() {
  return DATA.fileTree[state.currentProject] || [];
}
function getAllSessions() {
  const all = [];
  getFeatures().forEach(f => {
    (f.sessions || []).forEach(s => all.push({ ...s, feature: f.name, featureId: f.id }));
  });
  return all;
}
function statsFor(projId) {
  const fs = DATA.features[projId] || [];
  const inProg = fs.filter(f => f.status === 'in_progress').length;
  let todo = 0, done = 0;
  fs.forEach(f => f.tasks.forEach(t => { if (t.status === 'todo' || t.status === 'in_progress') todo++; if (t.status === 'done') done++; }));
  let sessions = 0;
  fs.forEach(f => sessions += (f.sessions || []).length);
  const decisions = (DATA.decisions[projId] || []).length;
  return { inProg, todo, done, sessions, decisions };
}

// =================================================
// Top bar — project switcher
// =================================================
function renderProjectSwitcher() {
  const p = getProject();
  $('#currentProjectName').textContent = p ? p.name : '프로젝트 없음';
  const mark = $('#currentProjectMark');
  mark.style.background = p ? p.markColor : 'var(--bg-soft)';
  mark.textContent = p ? p.mark : '–';

  const dd = $('#projectDropdown');
  dd.innerHTML = '';
  DATA.projects.forEach(proj => {
    const opt = el('div', { class: 'project-option' + (proj.id === state.currentProject ? ' current' : ''),
      onClick: () => { dd.classList.remove('open'); setActiveProject(proj.id); } });
    const m = el('span', { class: 'project-mark' }); m.style.background = proj.markColor; m.textContent = proj.mark;
    opt.appendChild(m);
    const info = el('div', { class: 'project-option-info' }, [
      el('div', { class: 'project-option-name', text: proj.name }),
      el('div', { class: 'project-option-tagline', text: proj.tagline })
    ]);
    opt.appendChild(info);
    dd.appendChild(opt);
  });
}
function firstFile(tree, prefix = '') {
  for (const node of tree) {
    if (node.type === 'file') return prefix + node.name;
    if (node.children) {
      const found = firstFile(node.children, prefix + node.name + '/');
      if (found) return found;
    }
  }
  return null;
}

$('#projectBtn').onclick = e => {
  e.stopPropagation();
  $('#projectDropdown').classList.toggle('open');
};
document.addEventListener('click', () => $('#projectDropdown').classList.remove('open'));

// =================================================
// Tabs
// =================================================
const TABS = [
  { id: 'dashboard', label: '대시보드' },
  { id: 'features', label: '기능' },
  { id: 'codemap', label: '코드 맵' },
  { id: 'decisions', label: '결정 기록' },
  { id: 'sessions', label: '세션 로그' }
];
function renderTabs() {
  const tabs = $('#tabs');
  tabs.innerHTML = '';
  const stats = statsFor(state.currentProject);
  const counts = { features: getFeatures().length, decisions: stats.decisions, sessions: stats.sessions };
  TABS.forEach(t => {
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
  const sb = $('#sidebar');
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

    const grouped = { in_progress: [], todo: [], done: [] };
    getFeatures().forEach(f => grouped[f.status].push(f));

    const order = [
      { key: 'in_progress', label: '진행 중' },
      { key: 'todo', label: '할 일' },
      { key: 'done', label: '완료' }
    ];

    order.forEach(({ key, label }) => {
      if (grouped[key].length === 0) return;
      const subHeading = el('div', { class: 'sb-heading' });
      subHeading.style.marginTop = '10px';
      subHeading.style.fontSize = '10.5px';
      subHeading.appendChild(el('span', { text: label + ' · ' + grouped[key].length }));
      sec.appendChild(subHeading);

      grouped[key].forEach(f => {
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

function renderFileTree(nodes, parent, prefix = '') {
  nodes.forEach(node => {
    if (node.type === 'folder') {
      const folder = el('div', { class: 'tree-folder' });
      const header = el('div', { class: 'tree-folder-header' });
      header.appendChild(el('svg', { width: 10, height: 10, viewBox: '0 0 10 10', html: '<path d="M3 2 L6 5 L3 8" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/>' }));
      header.appendChild(el('span', { text: node.name }));
      folder.appendChild(header);
      const children = el('div', { class: 'tree-children' });
      renderFileTree(node.children, children, prefix + node.name + '/');
      folder.appendChild(children);
      parent.appendChild(folder);
    } else {
      const fullPath = prefix + node.name;
      const item = el('div', { class: 'tree-file' + (fullPath.endsWith(state.currentFile?.split('/').pop() || '') && state.currentFile && fullPath === state.currentFile ? ' active' : ''), onClick: () => { state.currentFile = fullPath; render(); } });
      item.appendChild(el('span', { text: node.name }));
      if (node.hot) item.appendChild(el('span', { class: 'tree-file-meta' }));
      parent.appendChild(item);
    }
  });
}

// =================================================
// Main: Dashboard
// =================================================
function renderDashboard() {
  const main = $('#main');
  main.innerHTML = '';
  const p = getProject();
  const stats = statsFor(state.currentProject);
  const fs = getFeatures();
  const inProgFeature = fs.find(f => f.status === 'in_progress');

  const header = el('div', { class: 'page-header' }, [
    el('div', { class: 'breadcrumb', text: p.tagline }),
    el('h1', { class: 'page-title', text: p.name }),
    el('p', { class: 'page-tagline', text: p.goal })
  ]);
  main.appendChild(header);

  const grid = el('div', { class: 'stat-grid' });
  const stats_ = [
    { label: '진행 중인 기능', value: stats.inProg, trend: '/ ' + fs.length + ' 전체' },
    { label: '미완료 태스크', value: stats.todo, trend: stats.done + '개 완료' },
    { label: '이번 주 세션', value: stats.sessions, trend: '+3 vs 지난주', up: true },
    { label: '결정 기록', value: stats.decisions, trend: '최근 ADR-' + (1000 + stats.decisions).toString().slice(1) }
  ];
  stats_.forEach(s => {
    grid.appendChild(el('div', { class: 'stat-card' }, [
      el('div', { class: 'stat-label', text: s.label }),
      el('div', { class: 'stat-value', text: s.value }),
      el('div', { class: 'stat-trend' + (s.up ? ' up' : ''), text: s.trend })
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
    card.appendChild(el('p', { class: 'now-goal', text: inProgFeature.goal }));
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

function pillEl(status, label) {
  return el('span', { class: 'pill ' + status.replace('_', '-') }, [
    el('span', { class: 'pill-dot' }),
    el('span', { text: label })
  ]);
}
function statusLabel(s) {
  return s === 'done' ? '완료' : s === 'in_progress' ? '진행 중' : '할 일';
}

// =================================================
// Main: Feature detail
// =================================================
function renderFeatureDetail() {
  const main = $('#main');
  main.innerHTML = '';
  const f = getFeature();
  if (!f) {
    main.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-title', text: '기능을 선택해주세요' }),
      el('div', { class: 'empty-state-text', text: '왼쪽에서 기능을 클릭하면 상세 정보가 표시됩니다.' })
    ]));
    return;
  }

  const p = getProject();
  const header = el('div', { class: 'page-header' });
  header.appendChild(el('div', { class: 'breadcrumb', text: p.name + ' / 기능' }));
  const titleRow = el('h1', { class: 'page-title' }, [
    el('span', { text: f.name }),
    pillEl(f.status, statusLabel(f.status))
  ]);
  header.appendChild(titleRow);
  header.appendChild(el('p', { class: 'page-tagline', text: f.goal }));
  main.appendChild(header);

  const progRow = el('div', { class: 'progress-row' }, [
    el('div', { class: 'progress-bar' }, [el('div', { class: 'progress-fill', style: 'width:' + f.progress + '%' })]),
    el('div', { class: 'progress-text', text: f.tasks.filter(t => t.status === 'done').length + ' / ' + f.tasks.length + ' · ' + f.progress + '%' })
  ]);
  progRow.style.marginBottom = '32px';
  main.appendChild(progRow);

  const tasks = el('div', { class: 'detail-section' });
  tasks.appendChild(el('div', { class: 'detail-section-title' }, [
    el('span', { text: '할 일' }),
    el('span', { class: 'detail-section-count', text: f.tasks.length })
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
      el('span', { class: 'detail-section-count', text: f.files.length })
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
      el('span', { class: 'detail-section-count', text: f.sessions.length })
    ]));
    const slist = el('div', { class: 'session-list' });
    f.sessions.forEach(s => {
      const row = el('div', { class: 'session-row' });
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
  const main = $('#main');
  main.innerHTML = '';
  const path = state.currentFile;
  if (!path) {
    main.appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-title', text: '파일을 선택해주세요' }),
      el('div', { class: 'empty-state-text', text: '왼쪽 트리에서 파일을 클릭하면 어떤 기능에 속하는지, AI가 생성한 설명이 표시됩니다.' })
    ]));
    return;
  }

  const p = getProject();
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

  const explanation = DATA.fileExplanations[path] || '이 파일에 대한 AI 설명은 다음 세션 종료 시 자동 생성됩니다. 코드 변경 사항이 감지되면 캐시가 무효화되고 재생성됩니다.';
  const exp = el('div', { class: 'ai-explanation' }, [
    el('div', { class: 'ai-explanation-eyebrow' }, [el('span', { text: 'AI 설명 · 캐시됨' })]),
    el('p', { class: 'ai-explanation-text', text: explanation })
  ]);
  main.appendChild(exp);

  // Connected features come from `/api/projects/:id/files/detail`. Lazily
  // fetched the first time the user views this file in the codemap.
  const detail = FILE_DETAIL[fdKey(state.currentProject, path)];
  if (!detail && !state.fileDetailLoading) {
    // kick off; render() runs again on completion
    loadFileDetail(path);
  }

  const sec = el('div', { class: 'detail-section' });
  sec.appendChild(el('div', { class: 'detail-section-title' }, [el('span', { text: '연결된 기능' })]));
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
      el('span', { class: 'detail-section-count', text: detail.sessions.length }),
    ]));
    const slist = el('div', { class: 'session-list' });
    detail.sessions.forEach((s: any) => {
      const row = el('div', { class: 'session-row' });
      row.appendChild(el('div', { class: 'session-time', text: s.time }));
      row.appendChild(el('div', { class: 'session-summary', text: s.summary }));
      slist.appendChild(row);
    });
    ssec.appendChild(slist);
    main.appendChild(ssec);
  }
}

function featuresForFile(path) {
  const fname = path.split('/').pop();
  const found = [];
  function walk(nodes) {
    nodes.forEach(n => {
      if (n.type === 'file' && n.name === fname) {
        (n.features || []).forEach(f => { if (!found.includes(f)) found.push(f); });
      }
      if (n.children) walk(n.children);
    });
  }
  walk(getFileTree());
  return found;
}

function sessionsForFile(path) {
  const fname = path.split('/').pop();
  const out = [];
  getFeatures().forEach(f => {
    (f.sessions || []).forEach(s => {
      if ((s.files || []).some(sf => sf === fname || sf.endsWith('/' + fname))) {
        out.push({ ...s, feature: f.name });
      }
    });
  });
  return out;
}

// =================================================
// Main: Decisions (ADRs)
// =================================================
function renderDecisions() {
  const main = $('#main');
  main.innerHTML = '';
  const p = getProject();

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
    const card = el('div', { class: 'adr-card' });
    card.appendChild(el('div', { class: 'adr-header' }, [
      el('span', { class: 'adr-id', text: adr.id }),
      el('span', { class: 'adr-date', text: adr.date })
    ]));
    card.appendChild(el('h3', { class: 'adr-title', text: adr.title }));
    const body = el('div', { class: 'adr-body' });
    [
      ['배경', adr.context],
      ['결정', adr.decision],
      ['대안', adr.alternatives]
    ].forEach(([k, v]) => {
      body.appendChild(el('div', { class: 'adr-key', text: k }));
      body.appendChild(el('div', { class: 'adr-val', text: v }));
    });
    card.appendChild(body);
    if (adr.feature) {
      card.appendChild(el('div', { class: 'adr-feature-tag' }, [
        el('span', { text: '관련 기능 · ' }),
        el('span', { style: 'color: var(--accent); cursor:pointer', text: adr.feature, onClick: (e) => {
          e.stopPropagation();
          const f = getFeatures().find(ff => ff.name === adr.feature);
          if (f) { state.currentTab = 'features'; state.currentFeature = f.id; render(); }
        }})
      ]));
    }
    list.appendChild(card);
  });
  main.appendChild(list);
}

// =================================================
// Main: Sessions
// =================================================
function renderSessions() {
  const main = $('#main');
  main.innerHTML = '';
  const p = getProject();

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

  const groups = {};
  sessions.forEach(s => {
    const key = s.time.startsWith('오늘') ? '오늘' : s.time.startsWith('어제') ? '어제' : '이전';
    (groups[key] = groups[key] || []).push(s);
  });

  ['오늘', '어제', '이전'].forEach(g => {
    if (!groups[g]) return;
    const grp = el('div', { class: 'session-day-group' });
    grp.appendChild(el('div', { class: 'session-day-label', text: g }));
    groups[g].forEach(s => {
      const card = el('div', { class: 'session-card' });
      card.appendChild(el('div', { class: 'session-card-time', text: s.time }));
      const right = el('div', {});
      right.appendChild(el('p', { class: 'session-card-summary', text: s.summary }));
      const meta = el('div', { class: 'session-card-meta' });
      const fchip = el('span', { class: 'activity-feature', text: s.feature, onClick: (e) => {
        e.stopPropagation(); state.currentTab = 'features'; state.currentFeature = s.featureId; render();
      } });
      fchip.style.cursor = 'pointer';
      meta.appendChild(fchip);
      (s.files || []).forEach(fname => {
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
// Render
// =================================================
function render() {
  renderProjectSwitcher();
  renderTabs();
  renderSidebar();

  if (state.error) {
    $('#main').innerHTML = '';
    $('#main').appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-title', text: '데이터를 불러오지 못했습니다' }),
      el('div', { class: 'empty-state-text', text: state.error }),
    ]));
    return;
  }
  if (state.loading) {
    $('#main').innerHTML = '';
    $('#main').appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-title', text: '불러오는 중…' }),
    ]));
    return;
  }
  if (DATA.projects.length === 0) {
    $('#main').innerHTML = '';
    $('#main').appendChild(el('div', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-title', text: '등록된 프로젝트가 없습니다' }),
      el('div', { class: 'empty-state-text', text: 'CLI로 프로젝트를 초기화하세요: `pm init --name "<프로젝트>"`' }),
    ]));
    return;
  }

  if (state.currentTab === 'dashboard') renderDashboard();
  else if (state.currentTab === 'features') renderFeatureDetail();
  else if (state.currentTab === 'codemap') renderCodeMap();
  else if (state.currentTab === 'decisions') renderDecisions();
  else if (state.currentTab === 'sessions') renderSessions();

  // Transient error toast — fixed top-right, click to dismiss, auto-clears
  // after 4.5s via showError(). We reconstruct on every render but dedupe by
  // class name so old copies don't accumulate.
  document.querySelectorAll('.vm-error-banner').forEach((n) => n.remove());
  if (state.errorMsg) {
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
      'border: 1px solid var(--warn, #b08300)',
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
