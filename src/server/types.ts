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
}

// (Removed in ADR-0016: FileNode. File-tree API retired.)

// SearchKind still includes 'file' for type-system stability, but on a
// post-0005 DB no row of kind='file' can be returned — migration purged
// the search_fts table of those rows and dropped the triggers that fed
// them. The web client treats incoming 'file' results as a no-op.
export type SearchKind = 'feature' | 'decision' | 'session' | 'file';

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
