export type FeatureStatus = 'todo' | 'in_progress' | 'done' | 'archived';
export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type EditType = 'created' | 'modified' | 'read';
export type LinkSource = 'manual' | 'auto' | 'confirmed';

export interface Project {
  id: string;
  name: string;
  tagline: string | null;
  goal: string | null;
  root_path: string;
  tech: string[];
  created_at: number;
  updated_at: number;
}

export interface Feature {
  id: string;
  project_id: string;
  name: string;
  goal: string | null;
  spec_md: string | null;
  status: FeatureStatus;
  priority: number;
  created_at: number;
  updated_at: number;
}

export interface Task {
  id: number;
  feature_id: string;
  name: string;
  status: TaskStatus;
  position: number;
  notes: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface Decision {
  id: string;
  project_id: string;
  feature_id: string | null;
  title: string;
  context: string | null;
  decision: string | null;
  alternatives: string | null;
  consequences: string | null;
  created_at: number;
}

export interface Session {
  id: string;
  project_id: string;
  feature_id: string | null;
  started_at: number;
  ended_at: number | null;
  summary: string | null;
  notes: string | null;
}

export interface SessionFile {
  session_id: string;
  file_path: string;
  edit_type: EditType;
}

// Sprint 23 (h5uk) — Session Intelligence.
//
// `SessionDetail` is the rich shape returned by GET /api/sessions/:id and
// `pm_get_session_detail` MCP. Carries the base Session row + joined
// feature_name + edit-typed files + prev/next session pointers for the
// "navigate within this feature's session history" affordance in the
// session-detail sub-view.
export interface SessionDetailSibling {
  id: string;
  /** Pre-formatted relative time (matches AdrCard/SessionSummary convention). */
  time: string;
  /** First line / summary blurb — long-form notes stay on the detail page. */
  summary: string | null;
}

export interface SessionDetail extends Session {
  /** Resolved name of the linked feature, or null when the session is
   *  unattached (e.g. pm import-history without an extracted feature). */
  feature_name: string | null;
  /** Files touched in this session (Sprint 21 / ADR-0019: derived from
   *  `git status --porcelain` at endSession time). */
  files: SessionFile[];
  /** Pre-formatted started/ended labels — the UI reads these directly. */
  started_at_label: string;
  ended_at_label: string | null;
  /** Same-feature siblings for the prev/next nav buttons in the detail
   *  view. Null when there is no neighbour on that side. */
  prev_session: SessionDetailSibling | null;
  next_session: SessionDetailSibling | null;
}

/**
 * Compact projection used by pm_get_context to advertise the "이어서 작업하기"
 * surface. Shipped on the SessionStartContext when the active feature has
 * a most-recently-ended session; null otherwise.
 *
 * `notes_excerpt` is bounded the same way `DocumentSummary.excerpt` is
 * (Sprint 22) — 200 chars max. Designed for "what was I in the middle of
 * last time?" hint, not full context.
 */
export interface LastSessionSummary {
  id: string;
  /** Pre-formatted relative time. */
  ended_at_label: string;
  summary: string | null;
  notes_excerpt: string;
}

export interface FeatureFile {
  feature_id: string;
  file_path: string;
  description: string | null;
  confidence: number;
  source: LinkSource;
  last_session_id: string | null;
  created_at: number;
}

// (Removed in ADR-0016: FileExplanation. AI file-explanation workflow retired.)

/**
 * One row in the cross-project "내 작업" / workspace view. Combines feature
 * metadata with its parent project's name + a derived last_activity_at so
 * the client can sort by recency without an extra join.
 *
 * Returned by `domain.listWorkspaceFeatures` / GET /api/workspace/active-features
 * / `pm_list_workspace_features`.
 */
export interface WorkspaceFeature {
  project_id: string;
  project_name: string;
  feature_id: string;
  feature_name: string;
  status: FeatureStatus;
  /** 0–100, rounded. (tasks_done / (tasks_todo + tasks_done)) × 100. */
  progress: number;
  tasks_todo: number;
  tasks_done: number;
  /** ms since epoch of most recent session.started_at for this feature, or null. */
  last_activity_at: number | null;
}

// (Removed in ADR-0016: FileNeedingExplanation. Code Map workflow retired.)

export interface ProjectStats {
  active_features: number;
  total_features: number;
  todo_tasks: number;
  done_tasks: number;
  sessions_this_week: number;
  decisions: number;
}

// Sprint 20 (u3zu) — ADR-0018. Project Overview tab. Derived from existing
// project / feature / session / decision data — no new model.
//
// Priority tier (best → worst): active > todo_only > stale > empty.
//
//   empty:     no features at all (fresh project).
//   stale:     last session > 14 days ago (or none ever) — the project is
//              gathering dust. Wins over the positive labels because even
//              an in_progress feature is misleading when no one's working
//              on it. Also the bucket for "all features done, no follow-up"
//              (no actionable work AND not literally fresh).
//   todo_only: recent activity AND ≥1 todo feature AND 0 in_progress.
//              Signals "pick something up and start it."
//   active:    recent activity AND ≥1 in_progress feature. The healthy state.
export type ProjectHealth = 'active' | 'todo_only' | 'stale' | 'empty';

export interface ProjectOverviewNextTask {
  feature_id: string;
  feature_name: string;
  task_id: number;
  task_name: string;
}

export interface ProjectOverviewSession {
  id: string;
  /** Pre-formatted relative-time (e.g. "3시간 전"). */
  time: string;
  summary: string;
  feature_name: string | null;
}

export interface ProjectOverviewDecision {
  id: string;
  title: string;
  /** Pre-formatted relative-time. */
  date: string;
  feature_name: string | null;
}

/**
 * Server response for `GET /api/projects/:id/overview` (Sprint 20, u3zu).
 *
 * Read-only aggregate. Combines `getProject`, `getProjectStats`, the same
 * `active_features` sort as `getContext` (Sprint 19), plus a derived health
 * label and a next-task pointer. Client renders the entire shape directly —
 * no further stitching needed.
 */
export interface ProjectOverview {
  project: Project & { stats: ProjectStats };
  status: ProjectHealth;
  /** Most recent `sessions.started_at` for the project, or null when no
   *  sessions exist. Drives the `stale` health decision client-side too. */
  last_activity_at: number | null;
  /** Same ordering rules as `getContext.active_features` — in_progress first,
   *  then todo; within each, priority DESC then updated_at DESC. */
  active_features: FeatureContext[];
  /** First actionable task: prefer an in_progress feature's first
   *  todo/in_progress task; fall back to the top todo feature's first task.
   *  null when neither has any tasks. */
  next_task: ProjectOverviewNextTask | null;
  recent_sessions: ProjectOverviewSession[];
  recent_decisions: ProjectOverviewDecision[];
}

export interface FeatureContext {
  id: string;
  name: string;
  goal: string | null;
  status: FeatureStatus;
  progress: number;
  next_task: { id: number; name: string } | null;
}

export interface SessionStartContext {
  session_id: string;
  project: { id: string; name: string; goal: string | null };
  active_feature: FeatureContext | null;
  active_features: FeatureContext[];
  recent_decisions: Array<{ id: string; title: string; date: string }>;
  recent_sessions: Array<{ time: string; summary: string; feature: string | null }>;
  spec_md?: string | null;
  /** Sprint 22 (3wtr) / ADR-0019: documents linked to `active_feature`,
   *  up to 5, each carrying a 200-char excerpt so Claude Code has scope
   *  context (PRD / planning / architecture notes) at session start.
   *  Empty when no active feature OR no linked docs. */
  active_documents: DocumentSummary[];
  /** Sprint 23 (h5uk): the most-recently-ended session attached to the
   *  same `active_feature`. Powers the "이어서 작업하기" affordance —
   *  Claude Code can re-read the last session's notes (which the
   *  claudeMdTemplate v4 guides users to structure with `## 남은 일` /
   *  `## 결정`) and pick up where the previous session stopped. Null when
   *  there's no active feature or no prior session on it. */
  last_session: LastSessionSummary | null;
}

// (Removed in ADR-0016: FileNode. File-tree API retired.)

// Sprint 22 (3wtr) — Spec Hub: free-form project documents (PRDs, planning
// memos, architecture notes, retros, external feature specs). Distinct from
// `features.spec_md`: that field stays for the inline one-screen blurb that
// `pm_set_active_feature` hands off (Sprint 17); `documents` is for longer
// content the user wants to manage as standalone artifacts.
export type DocumentKind =
  | 'prd'
  | 'planning'
  | 'architecture'
  | 'retro'
  | 'feature_spec'
  | 'other';

export interface Document {
  id: string;
  project_id: string;
  kind: DocumentKind;
  title: string;
  content_md: string;
  created_at: number;
  updated_at: number;
}

/** Slim projection used by pm_get_context / pm_set_active_feature for
 *  hand-off to Claude Code. ADR-0019: only the first 200 chars of body
 *  travel — full content is fetched on demand if needed. */
export interface DocumentSummary {
  id: string;
  kind: DocumentKind;
  title: string;
  /** content_md truncated to 200 chars + `…` when longer. Empty string when
   *  the document has no body. */
  excerpt: string;
  /** Pre-formatted relative time. Same convention as AdrCard / SessionSummary. */
  updated_at_label: string;
}

// SearchKind: 'file' is retired but kept for type-system stability (post-0005
// migration purged all rows + dropped triggers). 'document' is added by
// Sprint 22 (3wtr) — surfaces via global search at KIND_WEIGHT 0.8.
export type SearchKind = 'feature' | 'decision' | 'session' | 'file' | 'document';

export interface SearchResult {
  kind: SearchKind;
  ref_id: string;
  project_id: string;
  title: string;
  /** snippet() output with <mark>…</mark> wrapping the matched terms */
  snippet: string;
  /** bm25(); lower (more negative) = more relevant */
  score: number;
}
