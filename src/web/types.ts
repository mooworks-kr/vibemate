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
  ContextBrief,
  Decision,
  Document,
  DocumentKind,
  Feature,
  FeatureDecisionSummary,
  FeatureFile,
  FileNode,
  FeatureStatus,
  ProjectDeletionImpact,
  ProjectOverview,
  ProjectStats,
  Project,
  SearchResult,
  SessionDetail,
  Task,
  TaskStatus,
} from '../server/types.js';

// Re-export ProjectOverview as the canonical web-side name so import sites
// don't need to reach into ../server/types directly.
export type ProjectOverviewResponse = ProjectOverview;

// Sprint 22 (3wtr) — re-export Document types so renderDocs and friends
// don't have to reach across the boundary at every call site.
export type { Document, DocumentKind };
// Sprint 28 (pax6) — re-export project deletion impact for the destructive modal.
export type { ProjectDeletionImpact };
// Sprint 23 (h5uk) — re-export session detail shape for the sub-view cache.
export type { SessionDetail };
// Sprint 24 (ijze) — Context Brief response shape.
export type { ContextBrief };

// Re-export FileNode for Code Map consumers.
export type { FileNode };

// (Removed in ADR-0016: FileDetailResponse + AppState.currentFile +
// AppState.linkingFile + AppState.fileDetailLoading.
// AI file-explanation UI retired. FileNode + file-tree API re-added.)

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
  /** = `feature_files.file_path`, renamed for terser UI templates. Surfaced
   *  in feature detail "관련 코드" section. */
  path: string;
  /** = `description ?? ''`. */
  desc: string;
  /** T2: pre-formatted relative time (e.g. "3시간 전") for the most recent
   *  session that touched this file. null when no session has edited it. */
  last_edited_time: string | null;
  /** T2: total distinct sessions in the project that edited this file. 0
   *  when none — the UI suppresses the indicator label in that case. */
  edit_session_count: number;
}

// Note: `FileFile`-style codemap entities (FileTreeNode, FileDetailResponse)
// were removed in ADR-0016. The feature_files "관련 코드" display still uses
// FeatureFileRow above — that's separate from codemap.

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
  spec_md: string | null;
  status: FeatureStatus;
  progress: number;
  tasks: TaskRow[];
  files: FeatureFileRow[];
  sessions: SessionSummaryRow[];
  /** ADRs linked to this feature via `decisions.feature_id`. Newest first.
   *  Folded into the response by `GET /api/features/:id` (T1 / feature-flow-map). */
  decisions: FeatureDecisionSummary[];
}

export interface AdrCard extends Decision {
  /** Pre-formatted relative-time. */
  date: string;
  /** Resolved feature name (joined client-side from `feature_id` → `getFeatures()`). */
  feature: string | null;
}

/**
 * In-memory client cache. Populated on-demand by `loadProjectList()` and
 * `loadProjectDetail()`. Keyed by project id where appropriate.
 */
export interface DataCache {
  projects: ProjectListEntry[];
  features: Record<string, EnrichedFeature[]>;
  decisions: Record<string, AdrCard[]>;
  /** Raw `/sessions` response, used only by hot-file affordances elsewhere. */
  sessions?: Record<string, RawSessionResponse[]>;
  /** Sprint 20 (u3zu): cached GET /api/projects/:id/overview response, keyed
   *  by project id. Populated by `loadProjectOverview()` and invalidated by
   *  mutations that touch sessions / decisions / feature status. For MVP we
   *  invalidate aggressively (clear the entry on any feature/task mutation
   *  in the project) — see `invalidateOverview()` in main.ts. */
  overviews?: Record<string, ProjectOverview>;
  /** Sprint 22 (3wtr): cached GET /api/projects/:id/documents response per
   *  project. Populated by `loadDocuments()` when the Docs tab first opens,
   *  invalidated by document mutation paths. */
  documents?: Record<string, Document[]>;
  /** Per-feature documents list — fed by `/api/features/:id/documents`,
   *  used by feature detail's "관련 문서" section. Keyed by feature id. */
  documentsByFeature?: Record<string, Document[]>;
  /** Sprint 23 (h5uk): cached `/api/sessions/:id` responses keyed by
   *  session id. Populated lazily by the detail sub-view when a session
   *  card is clicked. */
  sessionDetails?: Record<string, SessionDetail>;
  /** Sprint 24 (ijze): cached `/api/features/:id/context-brief` responses
   *  keyed by feature id. Populated when the user expands the Context
   *  Brief section or clicks Copy. */
  contextBriefs?: Record<string, ContextBrief>;
  /** Cached `GET /api/projects/:id/file-tree` responses keyed by project id.
   *  Populated lazily by `loadFileTree()`. Re-added after ADR-0016 removal. */
  fileTrees?: Record<string, FileNode[]>;
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
  /** Decisions linked to this feature, newest first. Added by the T1 patch
   *  in `http.ts` — see `listDecisionsForFeature` for the projection. */
  decisions: FeatureDecisionSummary[];
}

// ============================================================
// App state
// ============================================================

// Sprint 20 (u3zu): 'dashboard' was renamed to 'overview' — the tab now
// drives renderOverview() and consumes the GET /api/projects/:id/overview
// payload. Tab union changes are caught by the dispatch switch in render(),
// so any stale reference would fail typecheck.
// Sprint 22 (3wtr): 'docs' added — Spec Hub. Slot after 'overview' so the
// project's "what?" tab comes before "what to build?".
export type Tab = 'workspace' | 'overview' | 'docs' | 'features' | 'decisions' | 'sessions';

/**
 * Mirror of the server's `WorkspaceFeature` row (types.ts on the server).
 * Re-declared here because Vite cannot follow `import type` past the bundle
 * boundary cleanly when we also want runtime-free type ids.
 */
export interface WorkspaceFeatureRow {
  project_id: string;
  project_name: string;
  feature_id: string;
  feature_name: string;
  status: FeatureStatus;
  progress: number;
  tasks_todo: number;
  tasks_done: number;
  last_activity_at: number | null;
}
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
  /** Feature id while name is being inline-edited. */
  editingFeatureName: string | null;
  /** ADR id whose edit form is open in-place of its card. */
  editingDecisionId: string | null;

  // Transient UI ---------------------------------------------------------
  /** Last error toast text; null = no banner. Cleared on click or by timeout. */
  errorMsg: string | null;
  /** Border tint for the toast — set together with `errorMsg`. */
  toastKind: ToastKind;

  // Workspace tab --------------------------------------------------------
  /** Active filter for the cross-project view. Default `['in_progress']`. */
  workspaceStatuses: FeatureStatus[];
  /** Cached rows for the workspace view. null = not loaded yet. */
  workspaceFeatures: WorkspaceFeatureRow[] | null;
  /** Inflight guard so a status-toggle doesn't race with the initial load. */
  workspaceLoading: boolean;
  /** Last fetch error message; null when last load succeeded. */
  workspaceError: string | null;

  // Features sidebar -----------------------------------------------------
  /** Sprint 18 (y8pr): hide the "완료" group from the features sidebar.
   *  `archived` is always hidden (Sprint 5 policy); this flag covers `done`.
   *  Persisted to localStorage as `vibemate.hideCompletedFeatures`. Default
   *  `true` — a long backlog of completed features clutters the sidebar
   *  more than it informs. */
  hideCompletedFeatures: boolean;

  // Docs tab (Sprint 22, 3wtr) -------------------------------------------
  /** Currently-selected document for the detail view. null = list view. */
  currentDocument: string | null;
  /** Inline "+ 문서 추가" form open. */
  addingDocument: boolean;
  /** Document id whose edit mode is open inside the detail view. */
  editingDocumentId: string | null;
  /** Toggle between raw textarea and a minimal markdown preview inside the
   *  detail view's edit mode. Default false (text). */
  documentPreview: boolean;

  // Sessions tab (Sprint 23, h5uk) ---------------------------------------
  /** Currently-selected session for the detail sub-view (null = list). */
  currentSession: string | null;

  // Context Brief (Sprint 24, ijze) ---------------------------------------
  /** Feature ids whose Context Brief section is currently expanded in
   *  feature detail. A Set rather than a single id so users can keep
   *  several expanded if they switch between features in one session. */
  expandedContextBriefs: Set<string>;
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
