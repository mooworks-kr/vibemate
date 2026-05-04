import fs from 'node:fs';
import path from 'node:path';
import { getDb, transact } from './db.js';
import {
  formatAdrId,
  makeSlug,
  newSessionId,
  now,
  relativeTime,
  relativizeToProject,
  shouldIgnoreFile,
} from './lib.js';
import type {
  Decision,
  EditType,
  Feature,
  FeatureContext,
  FeatureFile,
  FeatureStatus,
  FileNode,
  Project,
  ProjectStats,
  Session,
  SessionStartContext,
  Task,
  TaskStatus,
} from './types.js';

// ============================================================
// Projects
// ============================================================

export function listProjects(): Project[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as any[];
  return rows.map(rowToProject);
}

export function getProject(id: string): Project | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
  return row ? rowToProject(row) : null;
}

export function getProjectByRoot(rootPath: string): Project | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM projects WHERE root_path = ?').get(rootPath) as any;
  return row ? rowToProject(row) : null;
}

export function createProject(args: {
  name: string;
  rootPath: string;
  tagline?: string;
  goal?: string;
  tech?: string[];
}): Project {
  const db = getDb();
  const existingSlugs = new Set(
    (db.prepare('SELECT id FROM projects').all() as { id: string }[]).map((r) => r.id),
  );
  const id = makeSlug(args.name, existingSlugs);
  const t = now();
  db.prepare(
    `INSERT INTO projects (id, name, tagline, goal, root_path, tech, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.name,
    args.tagline ?? null,
    args.goal ?? null,
    args.rootPath,
    args.tech ? JSON.stringify(args.tech) : null,
    t,
    t,
  );
  return getProject(id)!;
}

export function getProjectStats(projectId: string): ProjectStats {
  const db = getDb();
  const oneWeekAgo = now() - 7 * 86_400_000;

  const featureCounts = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS active
       FROM features WHERE project_id = ? AND status != 'archived'`,
    )
    .get(projectId) as { total: number; active: number };

  const taskCounts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN t.status IN ('todo','in_progress') THEN 1 ELSE 0 END) AS todo,
         SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
       FROM tasks t JOIN features f ON f.id = t.feature_id
       WHERE f.project_id = ?`,
    )
    .get(projectId) as { todo: number; done: number };

  const sessionsThisWeek = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sessions
       WHERE project_id = ? AND started_at >= ?`,
    )
    .get(projectId, oneWeekAgo) as { n: number };

  const decisionCount = db
    .prepare('SELECT COUNT(*) AS n FROM decisions WHERE project_id = ?')
    .get(projectId) as { n: number };

  return {
    active_features: featureCounts.active ?? 0,
    total_features: featureCounts.total ?? 0,
    todo_tasks: taskCounts.todo ?? 0,
    done_tasks: taskCounts.done ?? 0,
    sessions_this_week: sessionsThisWeek.n,
    decisions: decisionCount.n,
  };
}

// ============================================================
// Features
// ============================================================

export function listFeatures(projectId: string, status?: FeatureStatus): Feature[] {
  const db = getDb();
  let sql = 'SELECT * FROM features WHERE project_id = ?';
  const params: any[] = [projectId];
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY priority DESC, updated_at DESC';
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(rowToFeature);
}

export function getFeature(id: string): Feature | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM features WHERE id = ?').get(id) as any;
  return row ? rowToFeature(row) : null;
}

export function createFeature(args: {
  projectId: string;
  name: string;
  goal?: string;
  spec_md?: string;
  status?: FeatureStatus;
}): Feature {
  const db = getDb();
  const taken = new Set(
    (db.prepare('SELECT id FROM features WHERE project_id = ?').all(args.projectId) as {
      id: string;
    }[]).map((r) => r.id),
  );
  const id = makeSlug(args.name, taken);
  const t = now();
  db.prepare(
    `INSERT INTO features (id, project_id, name, goal, spec_md, status, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(id, args.projectId, args.name, args.goal ?? null, args.spec_md ?? null, args.status ?? 'todo', t, t);
  return getFeature(id)!;
}

export function updateFeature(
  id: string,
  patch: Partial<Pick<Feature, 'name' | 'goal' | 'spec_md' | 'status' | 'priority'>>,
): Feature | null {
  const db = getDb();
  const fields: string[] = [];
  const params: any[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) {
      fields.push(`${k} = ?`);
      params.push(v);
    }
  }
  if (fields.length === 0) return getFeature(id);
  fields.push('updated_at = ?');
  params.push(now());
  params.push(id);
  db.prepare(`UPDATE features SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getFeature(id);
}

export function getFeatureProgress(featureId: string): { progress: number; done: number; total: number } {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
       FROM tasks WHERE feature_id = ?`,
    )
    .get(featureId) as { total: number; done: number };
  const total = row.total || 0;
  const done = row.done || 0;
  const progress = total === 0 ? 0 : Math.round((done / total) * 100);
  return { progress, done, total };
}

// ============================================================
// Tasks
// ============================================================

export function listTasks(featureId: string): Task[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM tasks WHERE feature_id = ? ORDER BY position, id')
    .all(featureId) as any[];
  return rows.map(rowToTask);
}

export function addTask(featureId: string, name: string): Task {
  const db = getDb();
  const t = now();
  const maxPos = (
    db.prepare('SELECT MAX(position) AS m FROM tasks WHERE feature_id = ?').get(featureId) as {
      m: number | null;
    }
  ).m;
  const result = db
    .prepare(
      `INSERT INTO tasks (feature_id, name, status, position, created_at)
       VALUES (?, ?, 'todo', ?, ?)`,
    )
    .run(featureId, name, (maxPos ?? -1) + 1, t);
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid) as any;
  return rowToTask(row);
}

export function updateTask(
  id: number,
  patch: Partial<Pick<Task, 'name' | 'status' | 'notes' | 'position'>>,
): Task | null {
  const db = getDb();
  const current = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
  if (!current) return null;

  const fields: string[] = [];
  const params: any[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) {
      fields.push(`${k} = ?`);
      params.push(v);
    }
  }

  // Status transitions update timestamps
  if (patch.status === 'in_progress' && current.status !== 'in_progress') {
    fields.push('started_at = ?');
    params.push(now());
  }
  if (patch.status === 'done' && current.status !== 'done') {
    fields.push('completed_at = ?');
    params.push(now());
  }

  if (fields.length === 0) return rowToTask(current);
  params.push(id);
  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
  return rowToTask(updated);
}

// ============================================================
// Decisions (ADRs)
// ============================================================

export function listDecisions(projectId: string): Decision[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as any[];
  return rows.map(rowToDecision);
}

export function nextAdrId(projectId: string): string {
  const db = getDb();
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM decisions WHERE project_id = ?')
    .get(projectId) as { n: number };
  return formatAdrId(row.n + 1);
}

export function logDecision(args: {
  projectId: string;
  featureId?: string;
  title: string;
  context?: string;
  decision?: string;
  alternatives?: string;
  consequences?: string;
}): Decision {
  const db = getDb();
  const id = nextAdrId(args.projectId);
  const t = now();
  db.prepare(
    `INSERT INTO decisions (id, project_id, feature_id, title, context, decision, alternatives, consequences, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.projectId,
    args.featureId ?? null,
    args.title,
    args.context ?? null,
    args.decision ?? null,
    args.alternatives ?? null,
    args.consequences ?? null,
    t,
  );
  return rowToDecision(db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as any);
}

// ============================================================
// Sessions
// ============================================================

export function startSession(args: { projectId: string; featureId?: string }): SessionStartContext {
  const db = getDb();
  const project = getProject(args.projectId);
  if (!project) throw new Error(`Project not found: ${args.projectId}`);

  const sessionId = newSessionId();
  const t = now();
  db.prepare(
    `INSERT INTO sessions (id, project_id, feature_id, started_at)
     VALUES (?, ?, ?, ?)`,
  ).run(sessionId, args.projectId, args.featureId ?? null, t);

  return getContext(args.projectId, sessionId, args.featureId);
}

export function getContext(
  projectId: string,
  sessionId?: string,
  featureId?: string,
): SessionStartContext {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const features = listFeatures(projectId);
  const activeFeatures = features
    .filter((f) => f.status === 'in_progress')
    .map((f) => featureToContext(f));

  // Pick the active feature: explicit > most-recently-touched in_progress > first in_progress
  let activeFeature: FeatureContext | null = null;
  let activeFeatureSpec: string | null | undefined;
  if (featureId) {
    const f = getFeature(featureId);
    if (f) {
      activeFeature = featureToContext(f);
      activeFeatureSpec = f.spec_md;
    }
  } else if (activeFeatures.length > 0) {
    activeFeature = activeFeatures[0]!;
    const f = getFeature(activeFeature.id);
    activeFeatureSpec = f?.spec_md;
  }

  const recentDecisions = listDecisions(projectId).slice(0, 5).map((d) => ({
    id: d.id,
    title: d.title,
    date: relativeTime(d.created_at),
  }));

  const recentSessionRows = getDb()
    .prepare(
      `SELECT s.*, f.name AS feature_name
       FROM sessions s LEFT JOIN features f ON f.id = s.feature_id
       WHERE s.project_id = ? AND s.summary IS NOT NULL
       ORDER BY s.started_at DESC LIMIT 8`,
    )
    .all(projectId) as any[];
  const recentSessions = recentSessionRows.map((r) => ({
    time: relativeTime(r.started_at),
    summary: r.summary as string,
    feature: r.feature_name as string | null,
  }));

  return {
    session_id: sessionId ?? '',
    project: { id: project.id, name: project.name, goal: project.goal },
    active_feature: activeFeature,
    active_features: activeFeatures,
    recent_decisions: recentDecisions,
    recent_sessions: recentSessions,
    spec_md: activeFeatureSpec,
  };
}

export function setActiveFeature(sessionId: string, featureId: string): void {
  const db = getDb();
  db.prepare('UPDATE sessions SET feature_id = ? WHERE id = ?').run(featureId, sessionId);
}

export function endSession(args: {
  sessionId: string;
  summary: string;
  primaryFeatureId?: string;
}): { ok: true; files_touched: string[] } {
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(args.sessionId) as any;
  if (!session) throw new Error(`Session not found: ${args.sessionId}`);

  db.prepare(
    `UPDATE sessions SET ended_at = ?, summary = ?, feature_id = COALESCE(?, feature_id) WHERE id = ?`,
  ).run(now(), args.summary, args.primaryFeatureId ?? null, args.sessionId);

  // Auto-link files touched in this session to the primary feature
  const featureId = args.primaryFeatureId ?? session.feature_id;
  const files = db
    .prepare('SELECT file_path, edit_type FROM session_files WHERE session_id = ?')
    .all(args.sessionId) as { file_path: string; edit_type: EditType }[];

  if (featureId && files.length > 0) {
    autoLinkFiles(featureId, args.sessionId, files);
  }

  return { ok: true, files_touched: files.map((f) => f.file_path) };
}

export function recordSessionFile(
  sessionId: string,
  filePath: string,
  editType: EditType,
): void {
  if (shouldIgnoreFile(filePath)) return;
  const db = getDb();
  // Upsert: if exists with stronger edit_type, keep stronger
  const rank = { read: 1, modified: 2, created: 3 };
  const existing = db
    .prepare('SELECT edit_type FROM session_files WHERE session_id = ? AND file_path = ?')
    .get(sessionId, filePath) as { edit_type: EditType } | undefined;
  if (existing && rank[existing.edit_type] >= rank[editType]) return;

  db.prepare(
    `INSERT OR REPLACE INTO session_files (session_id, file_path, edit_type) VALUES (?, ?, ?)`,
  ).run(sessionId, filePath, editType);
}

// ============================================================
// Auto-linking files to features
// ============================================================

function autoLinkFiles(
  featureId: string,
  sessionId: string,
  files: { file_path: string; edit_type: EditType }[],
): void {
  const db = getDb();
  const t = now();
  const upsert = db.prepare(
    `INSERT INTO feature_files (feature_id, file_path, description, confidence, source, last_session_id, created_at)
     VALUES (?, ?, NULL, ?, 'auto', ?, ?)
     ON CONFLICT(feature_id, file_path) DO UPDATE SET
       last_session_id = excluded.last_session_id,
       confidence = MIN(1.0, feature_files.confidence + 0.05)`,
  );

  const txn = () => {
    for (const f of files) {
      // Skip read-only files (low confidence noise)
      if (f.edit_type === 'read') continue;
      const initialConf = f.edit_type === 'created' ? 0.85 : 0.7;
      upsert.run(featureId, f.file_path, initialConf, sessionId, t);
    }
  };
  transact(db, txn);
}

export function linkFile(args: {
  featureId: string;
  filePath: string;
  description?: string;
}): FeatureFile {
  const db = getDb();
  const t = now();
  db.prepare(
    `INSERT INTO feature_files (feature_id, file_path, description, confidence, source, created_at)
     VALUES (?, ?, ?, 1.0, 'manual', ?)
     ON CONFLICT(feature_id, file_path) DO UPDATE SET
       description = COALESCE(excluded.description, feature_files.description),
       confidence = 1.0,
       source = 'confirmed'`,
  ).run(args.featureId, args.filePath, args.description ?? null, t);
  return db
    .prepare('SELECT * FROM feature_files WHERE feature_id = ? AND file_path = ?')
    .get(args.featureId, args.filePath) as unknown as FeatureFile;
}

export function unlinkFile(featureId: string, filePath: string): void {
  const db = getDb();
  db.prepare('DELETE FROM feature_files WHERE feature_id = ? AND file_path = ?').run(
    featureId,
    filePath,
  );
}

export function listFeatureFiles(featureId: string): FeatureFile[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM feature_files WHERE feature_id = ?
       ORDER BY confidence DESC, created_at ASC`,
    )
    .all(featureId) as unknown as FeatureFile[];
}

export function listSessionsForFile(filePath: string, projectId: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT DISTINCT s.id, s.started_at, s.summary, s.feature_id, f.name AS feature_name
       FROM session_files sf
       JOIN sessions s ON s.id = sf.session_id
       LEFT JOIN features f ON f.id = s.feature_id
       WHERE sf.file_path = ? AND s.project_id = ? AND s.summary IS NOT NULL
       ORDER BY s.started_at DESC`,
    )
    .all(filePath, projectId) as Array<{
    id: string;
    started_at: number;
    summary: string;
    feature_id: string | null;
    feature_name: string | null;
  }>;
}

export function listFeaturesForFile(filePath: string, projectId: string): FeatureFile[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT ff.* FROM feature_files ff
       JOIN features f ON f.id = ff.feature_id
       WHERE ff.file_path = ? AND f.project_id = ?
       ORDER BY ff.confidence DESC`,
    )
    .all(filePath, projectId) as unknown as FeatureFile[];
}

// ============================================================
// Sessions list
// ============================================================

export function listSessions(projectId: string, limit: number = 50): Array<
  Session & { feature_name: string | null; files: string[] }
> {
  const db = getDb();
  const sessions = db
    .prepare(
      `SELECT s.*, f.name AS feature_name FROM sessions s
       LEFT JOIN features f ON f.id = s.feature_id
       WHERE s.project_id = ? AND s.summary IS NOT NULL
       ORDER BY s.started_at DESC LIMIT ?`,
    )
    .all(projectId, limit) as any[];

  return sessions.map((s) => {
    const files = db
      .prepare('SELECT file_path FROM session_files WHERE session_id = ? LIMIT 6')
      .all(s.id) as { file_path: string }[];
    return { ...rowToSession(s), feature_name: s.feature_name, files: files.map((f) => f.file_path) };
  });
}

// ============================================================
// File-watcher integration: record edits without an active session
// ============================================================

/**
 * Record a file edit. If there's an open session for the project, attach to it.
 * If not, the edit goes unrecorded (we don't keep an "orphan" bucket in this MVP).
 */
export function recordFileEdit(
  projectId: string,
  filePath: string,
  editType: EditType,
): void {
  const db = getDb();
  const session = db
    .prepare(
      `SELECT id FROM sessions WHERE project_id = ? AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(projectId) as { id: string } | undefined;
  if (!session) return;
  recordSessionFile(session.id, filePath, editType);
}

// ============================================================
// File tree
// ============================================================

/**
 * Walk the project root directory and return a recursive file tree.
 * Skips entries matched by lib.ts ignore patterns.
 * Folders are sorted before files; both groups alphabetically.
 */
export function getFileTree(projectId: string): FileNode[] {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const root = project.root_path;
  if (!fs.existsSync(root)) return [];

  function walk(dir: string, relPrefix: string): FileNode[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes: FileNode[] = [];
    for (const entry of entries) {
      // Build a posix-style relative path for ignore-matching and the response
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      // shouldIgnoreFile checks patterns like "(^|/)node_modules/" — append "/" for dirs
      const matchPath = entry.isDirectory() ? `${relPath}/` : relPath;
      if (shouldIgnoreFile(matchPath)) continue;

      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          path: relPath,
          type: 'dir',
          children: walk(path.join(dir, entry.name), relPath),
        });
      } else if (entry.isFile()) {
        nodes.push({
          name: entry.name,
          path: relPath,
          type: 'file',
        });
      }
    }
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return nodes;
  }

  return walk(root, '');
}

// ============================================================
// Row converters
// ============================================================

function rowToProject(r: any): Project {
  return {
    id: r.id,
    name: r.name,
    tagline: r.tagline,
    goal: r.goal,
    root_path: r.root_path,
    tech: r.tech ? JSON.parse(r.tech) : [],
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function rowToFeature(r: any): Feature {
  return {
    id: r.id,
    project_id: r.project_id,
    name: r.name,
    goal: r.goal,
    spec_md: r.spec_md,
    status: r.status,
    priority: r.priority,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function rowToTask(r: any): Task {
  return {
    id: r.id,
    feature_id: r.feature_id,
    name: r.name,
    status: r.status,
    position: r.position,
    notes: r.notes,
    created_at: r.created_at,
    started_at: r.started_at,
    completed_at: r.completed_at,
  };
}

function rowToDecision(r: any): Decision {
  return {
    id: r.id,
    project_id: r.project_id,
    feature_id: r.feature_id,
    title: r.title,
    context: r.context,
    decision: r.decision,
    alternatives: r.alternatives,
    consequences: r.consequences,
    created_at: r.created_at,
  };
}

function rowToSession(r: any): Session {
  return {
    id: r.id,
    project_id: r.project_id,
    feature_id: r.feature_id,
    started_at: r.started_at,
    ended_at: r.ended_at,
    summary: r.summary,
    notes: r.notes,
  };
}

function featureToContext(f: Feature): FeatureContext {
  const { progress } = getFeatureProgress(f.id);
  const tasks = listTasks(f.id);
  const next = tasks.find((t) => t.status === 'in_progress') ?? tasks.find((t) => t.status === 'todo');
  return {
    id: f.id,
    name: f.name,
    goal: f.goal,
    status: f.status,
    progress,
    next_task: next ? { id: next.id, name: next.name } : null,
  };
}

export { relativizeToProject };
