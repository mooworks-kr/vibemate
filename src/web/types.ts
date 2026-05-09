// Web-side types. Pure-type module — no runtime imports allowed (Vite would
// otherwise bundle them and the file is meant to live alongside main.ts).
// Shared shapes from the server come in via `import type` from `../server/types`.
//
// Conventions used here:
//   * `*Patch` types mirror the strict zod schemas in `http.ts` for mutations
//     so client-side `mutate<X>(...)` calls round-trip cleanly.
//   * `*Row` / `*Card` / `*Entry` types describe view-layer enrichments —
//     what `loadProjectDetail()` builds and `renderXxx()` reads. These are
//     intentionally separate from the raw server shapes so a server payload
//     change can be absorbed by the load adapter without touching renderers.

import type {
  Decision,
  Feature,
  FeatureFile,
  FeatureStatus,
  ProjectStats,
  Project,
  SearchResult,
  Task,
  TaskStatus,
} from '../server/types.js';

// ============================================================
// View-layer enrichments
// ============================================================

export interface ProjectListEntry extends Project {
  mark: string;            // 2-letter avatar derived from name
  markColor: string;       // hsl seeded by id
  stats?: ProjectStats;    // populated by `/api/projects` (which folds stats in)
}

export interface TaskRow extends Task {
  /** Pre-formatted relative-time string from `pickWhenForTask`. */
  when: string | null;
}

export interface FeatureFileRow {
  /** = `feature_files.file_path`, renamed for terser UI templates. */
  path: string;
  /** = `description ?? ''`. */
  desc: string;
}

export interface SessionSummaryRow {
  /** Stable session id; threaded through to the search palette's flash target. */
  id?: string;
  /** Pre-formatted via `relativeTime()` on the server response. */
  time: string;
  summary: string;
  files: string[];
  /** Attached by `getAllSessions()` for cross-feature dashboard rollups. */
  feature?: string;
  featureId?: string;
}

export interface EnrichedFeature {
  id: string;
  name: string;
  goal: string | null;
  status: FeatureStatus;
  progress: number;
  tasks: TaskRow[];
  files: FeatureFileRow[];
  sessions: SessionSummaryRow[];
}

export interface AdrCard extends Decision {
  /** Pre-formatted relative-time. */
  date: string;
  /** Resolved feature name (joined client-side from `feature_id` → `getFeatures()`). */
  feature: string | null;
}

export interface FileTreeNode {
  /** Adapter renames `dir` → `folder` to match the renderer's CSS hooks. */
  type: 'folder' | 'file';
  name: string;
  children?: FileTreeNode[];
  /** Reserved — currently always [], kept for future per-node feature tagging. */
  features: FeatureFile[];
  /** True when the file path appears in any session within the last 7 days. */
  hot: boolean;
}

/**
 * Shape returned by `GET /api/projects/:id/files/detail?path=…`.
 * The web UI caches this in `FILE_DETAIL` keyed by (projectId, path).
 */
export interface FileDetailResponse {
  path: string;
  features: Array<{
    feature_id: string;
    name: string;
    confidence: number;
    source: string;
  }>;
  sessions: Array<{
    id: string;
    time: string;
    summary: string;
    feature_id: string | null;
    feature_name: string | null;
  }>;
  explanation: { text: string; generated_at: number } | null;
}

/**
 * In-memory client cache. Populated on-demand by `loadProjectList()` and
 * `loadProjectDetail()`. Keyed by project id where appropriate.
 */
export interface DataCache {
  projects: ProjectListEntry[];
  features: Record<string, EnrichedFeature[]>;
  decisions: Record<string, AdrCard[]>;
  fileTree: Record<string, FileTreeNode[]>;
  /** Raw `/sessions` response, used only for the hot-file cutoff calc. */
  sessions?: Record<string, RawSessionResponse[]>;
  /** Legacy slot — currently unused. */
  fileExplanations: Record<string, string>;
}

/**
 * Minimal projection of the server's `/api/projects/:id/sessions` response.
 * Only the fields `computeHotFiles` actually reads.
 */
export interface RawSessionResponse {
  id: string;
  time: string;
  started_at: number;
  ended_at: number | null;
  summary: string;
  feature_id: string | null;
  feature_name: string | null;
  files: string[];
}

/**
 * Server response for `GET /api/projects` — the raw Project row plus a
 * stats roll-up (added in `http.ts:75-83`).
 */
export interface ProjectListItem extends Project {
  stats: ProjectStats;
}

/**
 * Server response for `GET /api/projects/:id/features` — Feature row plus
 * derived counts/progress (`http.ts:97-104`).
 */
export interface FeatureListItem extends Feature {
  progress: number;
  tasks_done: number;
  tasks_total: number;
}

/**
 * Server response for `GET /api/projects/:id/decisions` — Decision row plus
 * a pre-formatted relative-time `date` (`http.ts:142-150`).
 */
export interface DecisionListItem extends Decision {
  date: string;
}

/**
 * Server response for `GET /api/features/:id` — the feature row plus
 * hydrated tasks/files/sessions arrays (`http.ts:106-138`).
 */
export interface FeatureDetailResponse extends Feature {
  progress: number;
  tasks_done: number;
  tasks_total: number;
  tasks: Task[];
  files: FeatureFile[];
  sessions: Array<{
    id: string;
    time: string;
    summary: string;
    files: string[];
  }>;
}

// ============================================================
// App state
// ============================================================

export type Tab = 'dashboard' | 'features' | 'codemap' | 'decisions' | 'sessions';
export type ToastKind = 'error' | 'success' | 'info';

/**
 * Singleton `state` object held in main.ts. Every `render*()` reads from
 * here; mutations flip flags then call `render()`. Adding a field generally
 * requires a render-side branch — keep it lean.
 */
export interface AppState {
  currentProject: string | null;
  currentTab: Tab;
  currentFeature: string | null;
  currentFile: string | null;
  loading: boolean;
  error: string | null;
  loadedProjects: Set<string>;

  // Mutation UI flags ----------------------------------------------------
  /** Sidebar "+ 기능" inline form open. */
  addingFeature: boolean;
  /** Feature id whose "+ 태스크" inline form is open (null = closed). */
  addingTaskFor: string | null;
  /** Decisions tab "+ 결정" form open. */
  addingDecision: boolean;
  /** Codemap file path while the "+ 기능에 매핑" picker is open (null = closed). */
  linkingFile: string | null;
  /** Feature id while name is being inline-edited. */
  editingFeatureName: string | null;
  /** ADR id whose edit form is open in-place of its card. */
  editingDecisionId: string | null;

  // Transient UI ---------------------------------------------------------
  /** Last error toast text; null = no banner. Cleared on click or by timeout. */
  errorMsg: string | null;
  /** Border tint for the toast — set together with `errorMsg`. */
  toastKind: ToastKind;
  /** True while `/files/detail` fetch is in flight for the current file. */
  fileDetailLoading: boolean;
}

// ============================================================
// Search palette
// ============================================================

/** Reuses the server's SearchResult shape; the palette renders rows directly. */
export type SearchResultRow = SearchResult;

export interface SearchState {
  open: boolean;
  query: string;
  loading: boolean;
  results: SearchResultRow[];
  error: string | null;
  selectedIndex: number;
}

// ============================================================
// Mutation patches (mirror server zod schemas, http.ts:14-54)
// ============================================================

export interface FeaturePatch {
  name?: string;
  status?: FeatureStatus;
  goal?: string;
  spec_md?: string;
  priority?: number;
}

export interface TaskPatch {
  name?: string;
  status?: TaskStatus;
  notes?: string;
  position?: number;
}

export interface DecisionPatch {
  title?: string;
  context?: string;
  decision?: string;
  alternatives?: string;
  consequences?: string;
  /** null clears the link; undefined leaves it. */
  feature_id?: string | null;
}

// ============================================================
// el() helper
// ============================================================

/**
 * Props recognised by the `el()` helper. Known keys take dedicated paths
 * (`text` → textContent, `class` → className, `onClick` → onclick, etc.).
 * Anything else goes through `setAttribute` (covers `data-*`, `aria-*`,
 * `title`, `placeholder`, custom attrs). `[other]: any` keeps the door
 * open while preserving auto-completion on the named keys.
 */
export interface ElProps {
  class?: string;
  text?: string;
  /** Raw HTML — used in a handful of spots (svg markup, mark snippets). */
  html?: string;
  /** Inline cssText. */
  style?: string;
  onClick?: (e: MouseEvent) => void;
  // Catch-all for setAttribute-style props.
  [other: string]: unknown;
}

export type ElChild = string | Node | null | undefined;
