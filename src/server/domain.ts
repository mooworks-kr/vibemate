import fs from 'node:fs';
import path from 'node:path';
import { getDb, transact } from './db.js';
import { runGitLog, type ParsedCommit } from './git-import.js';
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
  Project,
  ProjectStats,
  SearchResult,
  Session,
  SessionStartContext,
  Task,
  TaskStatus,
  WorkspaceFeature,
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

export function deleteTask(id: number): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  return result.changes > 0;
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

  // Status transitions update timestamps. Reverting away from done clears
  // completed_at so the UI's "X분 전 완료" affordance doesn't lie about a task
  // that's actually open again.
  if (patch.status === 'in_progress' && current.status !== 'in_progress') {
    fields.push('started_at = ?');
    params.push(now());
  }
  if (patch.status === 'done' && current.status !== 'done') {
    fields.push('completed_at = ?');
    params.push(now());
  }
  if (patch.status && patch.status !== 'done' && current.status === 'done') {
    fields.push('completed_at = ?');
    params.push(null);
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

export function getDecision(id: string): Decision | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as any;
  return row ? rowToDecision(row) : null;
}

export function updateDecision(
  id: string,
  patch: Partial<Pick<Decision, 'title' | 'context' | 'decision' | 'alternatives' | 'consequences' | 'feature_id'>>,
): Decision | null {
  const db = getDb();
  if (!getDecision(id)) return null;

  const fields: string[] = [];
  const params: any[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) {
      fields.push(`${k} = ?`);
      params.push(v);
    }
  }
  if (fields.length === 0) return getDecision(id);
  params.push(id);
  db.prepare(`UPDATE decisions SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getDecision(id);
}

export function deleteDecision(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM decisions WHERE id = ?').run(id);
  return result.changes > 0;
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

/**
 * Re-point an in-flight session at a different feature.
 *
 * Returns the FeatureContext (id/name/goal/status/progress/next_task) plus the
 * feature's spec_md so the caller — typically Claude Code via
 * `pm_set_active_feature` — has the same "what should I work on next" payload
 * it would have gotten from `pm_get_context({feature_id})`. Added in Sprint 17
 * (ADR-0017) to close the gap where switching features mid-session silently
 * dropped the spec_md hand-off.
 *
 * Validation: both session and feature must exist. Previously this was a
 * silent UPDATE with no row-count check, so a typo in either id would
 * succeed-on-paper but leave the session pinned to whatever it was before.
 */
export function setActiveFeature(
  sessionId: string,
  featureId: string,
): { ok: true; feature: FeatureContext; spec_md: string | null } {
  const db = getDb();
  const session = db
    .prepare('SELECT id FROM sessions WHERE id = ?')
    .get(sessionId) as { id: string } | undefined;
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const feature = getFeature(featureId);
  if (!feature) throw new Error(`Feature not found: ${featureId}`);

  db.prepare('UPDATE sessions SET feature_id = ? WHERE id = ?').run(featureId, sessionId);

  return {
    ok: true,
    feature: featureToContext(feature),
    spec_md: feature.spec_md ?? null,
  };
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

// (Removed in ADR-0016: getFileTree, listFilesNeedingExplanation,
// getFileExplanation, getFileContent, saveFileExplanation, clearFileExplanation,
// plus their private helpers (prepareFileForExplanation, clampForExplain,
// isLikelyBinary) and the FILE_EXPLAIN_ERRORS sentinel. Code Map / AI file
// explanation workflow retired. file_explanations table dropped in 0005.)

// ============================================================
// Search (FTS5)
// ============================================================

/**
 * Build a safe FTS5 MATCH expression from raw user input. Two layers of
 * defense, in order:
 *
 *  1. Per-token cleanup: strip everything that isn't a Unicode letter, digit,
 *     or underscore. That kills FTS5 syntax characters (`"*^():+-`) AND
 *     ordinary punctuation (`;,!?.=<>|&%#@/`) which unicode61 also treats as
 *     separators — leaving them in a token would either break the parser or
 *     produce queries the tokenizer can never match.
 *  2. Each remaining token gets a `*` suffix for prefix search. unicode61
 *     doesn't morphologically split Korean, so a literal MATCH '인증' only
 *     matches the exact token. '인증*' picks up '인증을', '인증의', etc.
 *
 * Tokens are AND-ed (FTS5 default for space-separated terms). Empty input
 * returns '' — callers should treat that as "no results" without running a
 * query.
 */
export function sanitizeFtsQuery(raw: string): string {
  const tokens = raw
    .split(/\s+/)
    // \p{L} = letters (covers ASCII + CJK + everything else),
    // \p{N} = digits. Underscore stays for identifiers like `feature_id`.
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `${t}*`).join(' ');
}

const SEARCH_LIMIT_DEFAULT = 20;
const SEARCH_LIMIT_MAX = 100;

// FTS5 column weights for bm25(): a hit in `title` is worth 3× a hit in `body`.
// The other columns are UNINDEXED so they don't take weights.
const TITLE_WEIGHT = 3.0;
const BODY_WEIGHT = 1.0;

// Per-kind score multiplier applied to bm25(). `bm25()` returns a negative
// number where smaller = more relevant; multiplying by a number > 0 keeps the
// sign and re-scales the magnitude. Larger multipliers → stronger boost.
//
// Picked so that base content match still dominates kind: a session result
// with a much better content match (bm25 = -10) outranks a feature with a
// weak match (bm25 = -5) even after the boost — the kind tier only swings
// ties or near-ties.
// ADR-0016: 'file' kind retired (no longer indexed; filtered out in searchProject).
const KIND_WEIGHT: Record<string, number> = {
  feature: 1.0,
  decision: 0.9,
  session: 0.6,
};

// Sentinel markers handed to SQLite's snippet(). They survive the round-trip
// through SQLite untouched, then we HTML-escape the entire snippet and swap
// the sentinels back for real <mark>…</mark> tags. The result: any user
// content (e.g. `<img onerror=...>` in a feature goal) is rendered inert
// while our own marker tags pass through. Picking sentinel strings that are
// unlikely in real prose AND won't survive HTML-escaping if they ever did
// (the `` SOH char would show up as a literal — fine, it's invisible
// in any sane render path).
const SNIPPET_OPEN_SENTINEL = 'MARK_OPEN';
const SNIPPET_CLOSE_SENTINEL = 'MARK_CLOSE';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function searchProject(
  projectId: string,
  query: string,
  limit: number = SEARCH_LIMIT_DEFAULT,
): SearchResult[] {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit) || SEARCH_LIMIT_DEFAULT), SEARCH_LIMIT_MAX);
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];

  const db = getDb();
  // snippet(table, col=-1 → search across all indexed cols, open, close, ellipsis, n_tokens)
  let rows: Array<{
    kind: string;
    ref_id: string;
    project_id: string;
    title: string;
    snippet: string;
    score: number;
  }>;
  try {
    // bm25 args: weights for indexed columns in declaration order
    // (title, body — kind/ref_id/project_id are UNINDEXED). Per-kind boost
    // is folded in via CASE WHEN: kinds with a higher KIND_WEIGHT see a more
    // negative score (= ranks higher), with the multiplier preserving sign.
    // ADR-0016: the 'file' kind is retired. Migration 0005 swept search_fts
    // of file rows and dropped the feeding triggers, but we filter here too
    // as a defensive guard — a stale client or a hand-injected row must
    // never surface in results.
    rows = db
      .prepare(
        `SELECT kind, ref_id, project_id, title,
                snippet(search_fts, -1, ?, ?, '…', 16) AS snippet,
                bm25(search_fts, ?, ?) * (
                  CASE kind
                    WHEN 'feature'  THEN ?
                    WHEN 'decision' THEN ?
                    WHEN 'session'  THEN ?
                    ELSE 1.0
                  END
                ) AS score
         FROM search_fts
         WHERE project_id = ? AND kind != 'file' AND search_fts MATCH ?
         ORDER BY score
         LIMIT ?`,
      )
      .all(
        SNIPPET_OPEN_SENTINEL,
        SNIPPET_CLOSE_SENTINEL,
        TITLE_WEIGHT,
        BODY_WEIGHT,
        KIND_WEIGHT.feature,
        KIND_WEIGHT.decision,
        KIND_WEIGHT.session,
        projectId,
        ftsQuery,
        safeLimit,
      ) as unknown as typeof rows;
  } catch {
    // FTS5 parser errors (e.g. an exotic input the sanitizer didn't catch)
    // shouldn't surface as 500s. Fail closed: the user gets an empty result,
    // not a stack trace.
    return [];
  }

  return rows.map((r) => ({
    kind: r.kind as SearchResult['kind'],
    ref_id: r.ref_id,
    project_id: r.project_id,
    title: escapeHtml(r.title),
    snippet: escapeHtml(r.snippet)
      .split(SNIPPET_OPEN_SENTINEL).join('<mark>')
      .split(SNIPPET_CLOSE_SENTINEL).join('</mark>'),
    score: r.score,
  }));
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

// ============================================================
// Git history import
//
// `pm import-history` and `pm_import_git_history` (MCP) call into here.
// Single-commit path is `importGitCommit` — pure DB op, idempotent against
// `imported_commits`. Bulk path is `importGitHistory` — spawns git log via
// `git-import.runGitLog` then loops single-commit imports.
// ============================================================

export interface ImportGitCommitArgs {
  projectId: string;
  commitHash: string;
  /** Author timestamp in ms since epoch (git emits seconds; caller × 1000). */
  authorTimestampMs: number;
  subject: string;
  body?: string;
  files: Array<{ path: string; edit_type: EditType }>;
  /** Optional explicit feature mapping for the synthesised session. */
  featureId?: string;
}

export interface ImportGitCommitResult {
  sessionId: string;
  /** false when the commit was already imported — caller did nothing. */
  created: boolean;
}

/**
 * Persist one git commit as a synthetic session. Idempotent against
 * `imported_commits`: a repeat call returns the prior session_id with
 * `created: false`. All inserts run in a single transaction so either the
 * full commit (session + files + idempotency marker) lands or none of it.
 */
export function importGitCommit(args: ImportGitCommitArgs): ImportGitCommitResult {
  const db = getDb();

  const existing = db
    .prepare('SELECT session_id FROM imported_commits WHERE project_id = ? AND commit_hash = ?')
    .get(args.projectId, args.commitHash) as { session_id: string } | undefined;
  if (existing) {
    return { sessionId: existing.session_id, created: false };
  }

  const sessionId = newSessionId();
  const ts = args.authorTimestampMs;
  const notes = args.body && args.body.trim() ? args.body : null;

  const insertSession = db.prepare(
    `INSERT INTO sessions (id, project_id, feature_id, started_at, ended_at, summary, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFile = db.prepare(
    `INSERT OR IGNORE INTO session_files (session_id, file_path, edit_type) VALUES (?, ?, ?)`,
  );
  const insertMarker = db.prepare(
    `INSERT INTO imported_commits (project_id, commit_hash, session_id, imported_at)
     VALUES (?, ?, ?, ?)`,
  );

  transact(db, () => {
    insertSession.run(
      sessionId,
      args.projectId,
      args.featureId ?? null,
      ts,
      ts, // ended_at = started_at — a commit is instantaneous
      args.subject,
      notes,
    );
    for (const f of args.files) {
      // Apply the same ignore policy used by the live watcher; keeps imported
      // sessions free of node_modules / build artifacts churn.
      if (shouldIgnoreFile(f.path)) continue;
      insertFile.run(sessionId, f.path, f.edit_type);
    }
    insertMarker.run(args.projectId, args.commitHash, sessionId, now());
  });

  return { sessionId, created: true };
}

export interface ImportGitHistoryOpts {
  /** YYYY-MM-DD or any string git --since accepts. */
  since?: string;
  /** Hard cap on commits returned. Defaults to git-import.DEFAULT_LIMIT. */
  limit?: number;
  /** When true, parse commits but skip writes. Counts still populate. */
  dryRun?: boolean;
}

export interface ImportGitHistoryResult {
  /** Total commits returned by `git log` (post-filter). */
  total: number;
  /** Commits this run actually inserted. */
  newCount: number;
  /** Commits skipped because they were already imported. */
  skippedCount: number;
  /** Per-commit failures during apply. Empty on a clean run. */
  errors: Array<{ hash: string; reason: string }>;
}

/**
 * Spawn `git log` against the project's root_path and import each commit as
 * a session. Returns counts so the caller (CLI / MCP) can report.
 *
 * `dryRun: true` skips `importGitCommit` writes. We still classify each
 * commit (already-imported vs new) by checking `imported_commits` directly.
 */
export async function importGitHistory(
  projectId: string,
  opts: ImportGitHistoryOpts = {},
): Promise<ImportGitHistoryResult> {
  const project = getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const commits = await runGitLog({
    rootPath: project.root_path,
    since: opts.since,
    limit: opts.limit,
  });

  const result: ImportGitHistoryResult = {
    total: commits.length,
    newCount: 0,
    skippedCount: 0,
    errors: [],
  };

  if (commits.length === 0) return result;

  if (opts.dryRun) {
    // Classify without writes.
    const db = getDb();
    const isImported = db.prepare(
      'SELECT 1 FROM imported_commits WHERE project_id = ? AND commit_hash = ?',
    );
    for (const c of commits) {
      if (isImported.get(projectId, c.hash)) result.skippedCount++;
      else result.newCount++;
    }
    return result;
  }

  for (const c of commits) {
    try {
      const r = importGitCommit({
        projectId,
        commitHash: c.hash,
        authorTimestampMs: c.author_timestamp_ms,
        subject: c.subject,
        body: c.body,
        files: c.files,
      });
      if (r.created) result.newCount++;
      else result.skippedCount++;
    } catch (err) {
      result.errors.push({ hash: c.hash, reason: (err as Error).message });
    }
  }

  return result;
}

// ============================================================
// Workspace (cross-project "내 작업" view)
//
// Single endpoint backing the workspace UI. Hands back a flat feature list
// joined with its parent project's name plus tasks counts and last-activity
// timestamp — everything renderWorkspace() needs without N+1.
// ============================================================

const WORKSPACE_LIMIT_DEFAULT = 50;
const WORKSPACE_LIMIT_MAX = 200;
const ALL_FEATURE_STATUSES: ReadonlyArray<FeatureStatus> = ['todo', 'in_progress', 'done', 'archived'];

export interface ListWorkspaceFeaturesOpts {
  /** Feature statuses to include. Defaults to `['in_progress']`. */
  statuses?: FeatureStatus[];
  /** Hard cap on returned rows. Default 50, max 200. */
  limit?: number;
}

/**
 * Cross-project active-features view. The SQL keeps it in one round-trip:
 * scalar subqueries pull tasks counts + max session timestamp per feature
 * rather than separate batches.
 *
 * Ordering: most-recently-active feature first; ties (or feature with no
 * sessions yet) fall back to `features.updated_at` so freshly-edited
 * features still surface near the top.
 */
export function listWorkspaceFeatures(opts: ListWorkspaceFeaturesOpts = {}): WorkspaceFeature[] {
  // Default to in_progress; explicit empty array → no filter (caller has to
  // pass something deliberate to get the no-op result).
  const requested = opts.statuses ?? ['in_progress'];
  // Sanitize: drop anything we don't recognise so a stray query param can't
  // poison the IN-clause. Fall back to default when nothing survives.
  const sanitized = requested.filter((s): s is FeatureStatus =>
    (ALL_FEATURE_STATUSES as ReadonlyArray<string>).includes(s));
  const statuses = sanitized.length > 0 ? sanitized : (['in_progress'] as FeatureStatus[]);

  const limit = Math.min(
    WORKSPACE_LIMIT_MAX,
    Math.max(1, Math.floor(opts.limit ?? WORKSPACE_LIMIT_DEFAULT)),
  );

  const db = getDb();
  const placeholders = statuses.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT
         f.project_id                                                       AS project_id,
         p.name                                                             AS project_name,
         f.id                                                               AS feature_id,
         f.name                                                             AS feature_name,
         f.status                                                           AS status,
         f.updated_at                                                       AS updated_at,
         (SELECT MAX(started_at) FROM sessions WHERE feature_id = f.id)     AS last_activity_at,
         (SELECT COUNT(*) FROM tasks
            WHERE feature_id = f.id AND status IN ('todo','in_progress'))   AS tasks_todo,
         (SELECT COUNT(*) FROM tasks
            WHERE feature_id = f.id AND status = 'done')                    AS tasks_done
       FROM features f
       JOIN projects p ON p.id = f.project_id
       WHERE f.status IN (${placeholders})
       ORDER BY (last_activity_at IS NULL), last_activity_at DESC, f.updated_at DESC
       LIMIT ?`,
    )
    .all(...statuses, limit) as Array<{
      project_id: string;
      project_name: string;
      feature_id: string;
      feature_name: string;
      status: FeatureStatus;
      updated_at: number;
      last_activity_at: number | null;
      tasks_todo: number;
      tasks_done: number;
    }>;

  return rows.map((r) => {
    const totalTasks = r.tasks_todo + r.tasks_done;
    const progress = totalTasks === 0 ? 0 : Math.round((r.tasks_done / totalTasks) * 100);
    return {
      project_id: r.project_id,
      project_name: r.project_name,
      feature_id: r.feature_id,
      feature_name: r.feature_name,
      status: r.status,
      progress,
      tasks_todo: r.tasks_todo,
      tasks_done: r.tasks_done,
      last_activity_at: r.last_activity_at,
    };
  });
}

export { relativizeToProject };
// Re-export so cli.ts and tests can compose without reaching into the helper.
export type { ParsedCommit };
export {
  CONVENTIONAL_TYPES,
  extractFeaturesFromCommits,
  parseConventionalCommit,
} from './extract-features.js';
export type {
  ConventionalCommit,
  ExtractFeaturesOpts,
  ExtractFeaturesResult,
  ExtractedGroup,
} from './extract-features.js';

// ============================================================
// CLAUDE.md migration
//
// vibemate drops a section into the user's CLAUDE.md so Claude Code knows
// which MCP tools to call. The template evolves across sprints — this module
// owns the template + the diff/replace logic that updates an existing file
// without clobbering content the user added on top.
//
// Marker design (see ADR-0008):
//   * Opening:  <!-- vibemate-section:v2 -->  ← detection sentinel, also the
//     starting boundary for migrate.
//   * Closing:  <!-- /vibemate-section -->    ← end boundary so user content
//     after the section is preserved.
//   * A meta line `<!-- vibemate-template-version: N -->` lives inside the
//     section so future migrations know the body's vintage without parsing
//     the body itself.
//   * Legacy v1 (Sprint ≤8 single-marker — "Vibemate section — added by 'pm
//     init'. Edit freely.") is detected and treated as marker→EOF for the
//     first migration pass.
//
// User customisations preserved across migration:
//   * Anything outside the marker pair (free-form additions before/after).
//   * The Project ID line — regex-extracted from the old section and threaded
//     into the new template so manual edits like vibemate's own
//     `testft → vibemate` rename survive.
// ============================================================

// NB: the section BEGIN marker keeps the `:v2` suffix on purpose. It's a
// section *identifier* (used by `migrateClaudeMd` to locate the block), not a
// content-version stamp — bumping it to `:v3` would make the migrator fail to
// find existing v2 sections and silently fall through to "no marker → append",
// which loses user content after the block. Content version is tracked
// separately by the inline `<!-- vibemate-template-version: N -->` line below.
export const VIBEMATE_SECTION_BEGIN = '<!-- vibemate-section:v2 -->';
export const VIBEMATE_SECTION_END = '<!-- /vibemate-section -->';
// Bumped 2 → 3 in Sprint 17 (ADR-0017) when the spec_md hand-off workflow
// was added to the template body. Existing v2 sections migrate cleanly
// because the section markers are unchanged.
export const VIBEMATE_TEMPLATE_VERSION = 3;
// Legacy single-line marker emitted by Sprint ≤8 templates. Single-shot,
// no closing marker. Detected for backward-compat; first migration pass
// rewrites these to the v2 pair.
export const VIBEMATE_LEGACY_MARKER = "<!-- Vibemate section — added by 'pm init'. Edit freely. -->";

// Matches `**Project ID**: \`<id>\`` line — used to lift the user's Project ID
// out of an existing section so we don't clobber a manual rename.
const PROJECT_ID_LINE_RE = /\*\*Project ID\*\*:\s*`([^`]+)`/;

/**
 * Render the canonical CLAUDE.md vibemate section for a given project id.
 * Wraps the body in begin/end markers so future migrations have clean
 * boundaries even when the user adds content after the section.
 *
 * Keep edits to the body in lockstep with `cli.ts` historical output —
 * `pm init` and `pm migrate-claude-md` share this exact template.
 */
export function claudeMdTemplate(projectId: string): string {
  return `${VIBEMATE_SECTION_BEGIN}
<!-- vibemate-template-version: ${VIBEMATE_TEMPLATE_VERSION} -->

## 이 프로젝트는 Vibemate가 활성화되어 있습니다

**Project ID**: \`${projectId}\`

세션 시작 시:
1. \`pm_session_start\` 호출 → session_id 저장
2. \`pm_get_context\` 호출 → 진행 상태 / 최근 결정 / 다음 태스크 확인
3. 응답의 \`spec_md\` 가 있으면 **작업 시작 전 반드시 읽기** — 범위 / 비범위 / 의존 / 결정 항목 확인

Feature 작업 시작 시 (다른 기능으로 전환할 때 포함):
1. \`pm_set_active_feature\` 호출 → 응답의 \`spec_md\` / \`feature.goal\` / \`feature.next_task\` 확인
2. 또는 \`pm_get_context(feature_id=X)\` 로 명시 조회
3. **\`spec_md\` 의 "범위 / 비범위 / 의존" 섹션을 작업 결정 전 검토**
4. 검토 중 새로 정한 정책은 \`pm_log_decision\` 으로 ADR 기록

세션 중 의미있는 결정이 있으면:
- \`pm_log_decision\` 으로 ADR 기록 제안 (사용자 confirm 후 호출)

세션 종료 직전:
- \`pm_session_end\` 호출 (session_id, 한 줄 요약, primary_feature_id)
- summary는 한국어 권장. 어떤 기능을 어떻게 진행했는지 명확하게.

태스크 / 기능 변경:
- 태스크 시작: \`pm_update_task\` (status=in_progress)
- 태스크 완료: \`pm_update_task\` (status=done)
- 새 기능: \`pm_create_feature\`

${VIBEMATE_SECTION_END}`;
}

export interface MigrateClaudeMdResult {
  /** True when the on-disk content would change (or is missing entirely). */
  changed: boolean;
  /** Unified-style line diff (' '/'-'/'+' prefixes). Empty when !changed. */
  diff: string;
  /** Full new file content the caller should write to disk. */
  result: string;
  /** Marker variant detected in the input. Useful for reporting. */
  detected: 'none' | 'legacy' | 'paired';
}

/**
 * Compute the migration result for `filePath`. Caller decides whether to
 * apply (write `result`) or just print the `diff`. We never touch disk here.
 *
 * Behavior matrix:
 *   - file missing → result = '# <basename>\n\n<template>\n', changed = true
 *   - file exists, no marker → result = existing + '\n\n' + <template>
 *   - file exists, paired markers → replace from begin to end (inclusive)
 *   - file exists, legacy single marker → replace from marker → EOF
 *
 * `diff` only covers the section being changed (not the whole file) so the
 * user reviews exactly what's churning.
 */
export function migrateClaudeMd(
  filePath: string,
  opts: { projectId: string },
): MigrateClaudeMdResult {
  const fileExists = fs.existsSync(filePath);
  const existing = fileExists ? fs.readFileSync(filePath, 'utf-8') : '';

  // Locate the section first so we can lift the user's Project ID before
  // building the new template. Prefer paired markers; fall back to legacy.
  let detected: 'none' | 'legacy' | 'paired' = 'none';
  let oldSection = '';
  let prefix = existing;
  let suffix = '';

  const beginIdx = existing.indexOf(VIBEMATE_SECTION_BEGIN);
  if (beginIdx >= 0) {
    const endIdx = existing.indexOf(VIBEMATE_SECTION_END, beginIdx);
    if (endIdx >= 0) {
      detected = 'paired';
      const endClose = endIdx + VIBEMATE_SECTION_END.length;
      oldSection = existing.slice(beginIdx, endClose);
      prefix = existing.slice(0, beginIdx).replace(/\n+$/, '\n\n');
      suffix = existing.slice(endClose);
    }
  }

  if (detected === 'none' && existing) {
    const legacyIdx = existing.indexOf(VIBEMATE_LEGACY_MARKER);
    if (legacyIdx >= 0) {
      // Legacy single-marker: section runs from marker to EOF. We can't
      // distinguish user content beyond it, so caller backups before write.
      detected = 'legacy';
      oldSection = existing.slice(legacyIdx);
      prefix = existing.slice(0, legacyIdx).replace(/\n+$/, '\n\n');
      suffix = '';
    }
  }

  // Preserve user-edited Project ID. The vibemate dogfood case (a manual
  // `testft → vibemate` rename) would otherwise be reverted to whatever the
  // caller resolved from CWD.
  const preservedId = oldSection.match(PROJECT_ID_LINE_RE)?.[1];
  const effectiveId = preservedId ?? opts.projectId;
  const newSection = claudeMdTemplate(effectiveId);

  if (!fileExists) {
    const dirName = path.basename(path.dirname(filePath));
    const result = `# ${dirName}\n\n${newSection}\n`;
    return {
      changed: true,
      diff: lineDiff([], result.split('\n')).join('\n'),
      result,
      detected: 'none',
    };
  }

  let result: string;
  if (detected === 'none') {
    // No marker at all — append at EOF, preserving a single trailing newline.
    const trimmed = existing.replace(/\s+$/, '');
    result = `${trimmed}\n\n${newSection}\n`;
  } else {
    // Replace section. Re-normalize trailing newline so we don't accumulate.
    const trimmedSuffix = suffix.replace(/^\s+/, '');
    result = `${prefix}${newSection}${trimmedSuffix ? '\n\n' + trimmedSuffix : '\n'}`;
  }

  if (result === existing) {
    return { changed: false, diff: '', result, detected };
  }

  // Diff is scoped to the section. Showing the entire file would bury the
  // change in unchanged lines.
  const diff = lineDiff(
    oldSection ? oldSection.split('\n') : [],
    newSection.split('\n'),
  ).join('\n');

  return { changed: true, diff, result, detected };
}

/**
 * Line-level diff using LCS. Output mirrors `diff -u` body format without
 * hunk headers — each line gets a single ' ' / '-' / '+' prefix:
 *   ' unchanged'
 *   '-only-in-old'
 *   '+only-in-new'
 *
 * Implementation is the standard O(n·m) DP. CLAUDE.md sections are tens of
 * lines so this is cheap; we'd revisit if sections ever grow into thousands.
 */
export function lineDiff(oldLines: string[], newLines: string[]): string[] {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  const out: string[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      out.unshift(' ' + oldLines[i - 1]);
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      out.unshift('+' + newLines[j - 1]);
      j--;
    } else {
      out.unshift('-' + oldLines[i - 1]);
      i--;
    }
  }
  return out;
}
