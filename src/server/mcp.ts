import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as domain from './domain.js';

/**
 * MCP server. Spawned by Claude Code via stdio.
 *
 * Handlers call `domain.*` directly against the local DB.
 *
 * Tools are built into a `Record<name, { schema, handler }>` map (see
 * `buildToolHandlers`) so:
 *   1. The MCP SDK iterator registers them all via `server.tool` in one loop
 *   2. The HTTP passthrough route reuses the same map for `/api/mcp/:tool`
 * Adding a new tool only requires touching the registry — passthrough is
 * automatic.
 */

// ============================================================
// Tool types + registry
// ============================================================

/** MCP SDK response shape. Multiple content items allowed (text + JSON
 *  side-channel for tools like pm_list_workspace_features).
 *  Open index signature matches the SDK's loose-extra-fields contract — without
 *  it, `server.tool(name, schema, handler)` would reject our handlers. */
export interface McpResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [k: string]: unknown;
}

export type ToolHandler = (args: any) => Promise<McpResult>;

export interface ToolDef {
  /** zod raw shape — passed to `server.tool` and used by the HTTP
   *  passthrough route to parse incoming JSON bodies. */
  schema: z.ZodRawShape;
  handler: ToolHandler;
}

export type ToolRegistry = Record<string, ToolDef>;

// ============================================================
// Shared shapes (reused across multiple tools)
// ============================================================

const DOCUMENT_KIND_ENUM = z.enum([
  'prd', 'planning', 'architecture', 'retro', 'feature_spec', 'other',
]);

// ============================================================
// Helpers
// ============================================================

function okResult(data: unknown): McpResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function textResult(text: string): McpResult {
  return { content: [{ type: 'text', text }] };
}

// Sprint 22 (3wtr) — HTML-entity decoder for `pm_search`. The HTTP search
// response is HTML-escaped + wrapped in literal `<mark>` tags for the web
// UI; the LLM consumer wants real angle brackets in user content while
// keeping the marker tags intact so it can see what matched.
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// ============================================================
// Local-mode tool registry (handlers hit domain.* directly)
// ============================================================

export interface BuildToolsOpts {
  /** Default project_id used when a tool's `project_id` arg is omitted.
   *  Falls back to CWD match (`domain.getProjectByRoot`). */
  projectId?: string;
}

export function buildToolHandlers(opts: BuildToolsOpts = {}): ToolRegistry {
  function resolveProject(explicit?: string): string {
    if (explicit) {
      const p = domain.getProject(explicit);
      if (!p) throw new Error(`Unknown project: ${explicit}`);
      return p.id;
    }
    if (opts.projectId) return opts.projectId;
    const cwd = process.cwd();
    const p = domain.getProjectByRoot(cwd);
    if (!p) throw new Error(`No project registered for ${cwd}. Run 'pm init' first.`);
    return p.id;
  }

  return {
    // ----- Session lifecycle -----

    pm_session_start: {
      schema: {
        project_id: z.string().optional().describe('프로젝트 ID. 생략하면 현재 디렉토리에서 추론'),
        feature_id: z.string().optional().describe('이 세션에서 작업할 기능 ID'),
      },
      handler: async ({ project_id, feature_id }) => {
        const pid = resolveProject(project_id);
        return okResult(domain.startSession({ projectId: pid, featureId: feature_id }));
      },
    },

    pm_session_end: {
      schema: {
        session_id: z.string().describe('session_start에서 받은 ID'),
        summary: z.string().describe('세션 한 줄 요약 (한국어 권장)'),
        primary_feature_id: z.string().optional().describe('이 세션에서 주로 작업한 기능'),
        // Sprint 23 (h5uk / ADR-0020).
        notes: z.string().optional().describe('구조화된 Markdown 메모 (## 완료 / ## 남은 일 / ## 결정). 다음 세션 시작 시 last_session.notes_excerpt 로 노출됨.'),
      },
      handler: async ({ session_id, summary, primary_feature_id, notes }) => {
        return okResult(domain.endSession({
          sessionId: session_id,
          summary,
          primaryFeatureId: primary_feature_id,
          notes,
        }));
      },
    },

    pm_set_active_feature: {
      schema: {
        session_id: z.string(),
        feature_id: z.string(),
      },
      handler: async ({ session_id, feature_id }) => {
        return okResult(domain.setActiveFeature(session_id, feature_id));
      },
    },

    // ----- Context -----

    pm_get_context: {
      schema: {
        project_id: z.string().optional(),
        feature_id: z.string().optional(),
      },
      handler: async ({ project_id, feature_id }) => {
        const pid = resolveProject(project_id);
        return okResult(domain.getContext(pid, undefined, feature_id));
      },
    },

    pm_get_context_brief: {
      schema: {
        feature_id: z.string().describe('Context Brief 를 생성할 feature ID'),
      },
      handler: async ({ feature_id }) => {
        const brief = domain.getContextBrief(feature_id);
        // Surface just the markdown blob — the user pastes that. Structured
        // sections stay on the HTTP response for the UI.
        return textResult(brief.markdown);
      },
    },

    pm_get_session_detail: {
      schema: { session_id: z.string() },
      handler: async ({ session_id }) => okResult(domain.getSessionDetail(session_id)),
    },

    pm_get_project_overview: {
      schema: { project_id: z.string().optional() },
      handler: async ({ project_id }) => {
        const pid = resolveProject(project_id);
        return okResult(domain.getProjectOverview(pid));
      },
    },

    // ----- Features -----

    pm_create_feature: {
      schema: {
        project_id: z.string().optional(),
        name: z.string().describe('기능 이름. 한국어 OK'),
        goal: z.string().optional().describe('1-2줄 목표 요약'),
        spec_md: z.string().optional().describe('전체 스펙 마크다운'),
        status: z.enum(['todo', 'in_progress', 'done', 'archived']).optional()
          .describe('초기 상태. 미지정 시 todo'),
      },
      handler: async ({ project_id, name, goal, spec_md, status }) => {
        const pid = resolveProject(project_id);
        const f = domain.createFeature({ projectId: pid, name, goal, spec_md, status });
        return okResult({ feature_id: f.id, name: f.name });
      },
    },

    pm_update_feature: {
      schema: {
        feature_id: z.string(),
        name: z.string().optional(),
        goal: z.string().optional(),
        spec_md: z.string().optional(),
        status: z.enum(['todo', 'in_progress', 'done', 'archived']).optional(),
        priority: z.number().optional(),
      },
      handler: async ({ feature_id, ...patch }) => {
        const updated = domain.updateFeature(feature_id, patch);
        if (!updated) throw new Error(`Feature not found: ${feature_id}`);
        return okResult({ ok: true, feature: updated });
      },
    },

    // ----- Tasks -----

    pm_add_task: {
      schema: { feature_id: z.string(), name: z.string() },
      handler: async ({ feature_id, name }) => {
        const t = domain.addTask(feature_id, name);
        return okResult({ task_id: t.id, name: t.name });
      },
    },

    pm_update_task: {
      schema: {
        task_id: z.number(),
        name: z.string().optional(),
        status: z.enum(['todo', 'in_progress', 'done']).optional(),
        notes: z.string().optional(),
        position: z.number().optional().describe('정렬 순서 (낮을수록 위)'),
      },
      handler: async ({ task_id, ...patch }) => {
        const updated = domain.updateTask(task_id, patch);
        if (!updated) throw new Error(`Task not found: ${task_id}`);
        return okResult({ ok: true, task: updated });
      },
    },

    pm_delete_task: {
      schema: { task_id: z.number() },
      handler: async ({ task_id }) => {
        const removed = domain.deleteTask(task_id);
        if (!removed) throw new Error(`Task not found: ${task_id}`);
        return okResult({ ok: true });
      },
    },

    // ----- Decisions (ADRs) -----

    pm_log_decision: {
      schema: {
        project_id: z.string().optional(),
        feature_id: z.string().optional(),
        title: z.string().describe('결정 한 줄 제목'),
        context: z.string().optional().describe('왜 이 결정이 필요했는지'),
        decision: z.string().optional().describe('어떻게 결정했는지'),
        alternatives: z.string().optional().describe('고려한 대안들'),
        consequences: z.string().optional().describe('이 결정의 영향'),
      },
      handler: async ({ project_id, feature_id, title, context, decision, alternatives, consequences }) => {
        const pid = resolveProject(project_id);
        const adr = domain.logDecision({
          projectId: pid,
          featureId: feature_id,
          title,
          context,
          decision,
          alternatives,
          consequences,
        });
        return okResult({ adr_id: adr.id, title: adr.title });
      },
    },

    pm_update_decision: {
      schema: {
        decision_id: z.string(),
        title: z.string().optional(),
        context: z.string().optional(),
        decision: z.string().optional(),
        alternatives: z.string().optional(),
        consequences: z.string().optional(),
        feature_id: z.string().nullable().optional(),
      },
      handler: async ({ decision_id, ...patch }) => {
        const updated = domain.updateDecision(decision_id, patch);
        if (!updated) throw new Error(`Decision not found: ${decision_id}`);
        return okResult({ ok: true, decision: updated });
      },
    },

    pm_delete_decision: {
      schema: { decision_id: z.string() },
      handler: async ({ decision_id }) => {
        const removed = domain.deleteDecision(decision_id);
        if (!removed) throw new Error(`Decision not found: ${decision_id}`);
        return okResult({ ok: true });
      },
    },

    // ----- Project deletion (Sprint 28, pax6) -----

    pm_get_deletion_impact: {
      schema: {
        project_id: z.string().optional().describe('프로젝트 ID. 생략하면 현재 디렉토리에서 추론'),
      },
      handler: async ({ project_id }) => {
        const pid = resolveProject(project_id);
        return okResult(domain.getProjectDeletionImpact(pid));
      },
    },

    pm_delete_project: {
      schema: {
        project_id: z.string().optional()
          .describe('프로젝트 ID. 생략하면 현재 디렉토리에서 추론'),
        force: z.boolean().optional()
          .describe('true면 활성 세션이 있어도 강제 삭제. 기본 false'),
      },
      handler: async ({ project_id, force }) => {
        const pid = resolveProject(project_id);
        const removed = domain.deleteProject(pid, { force });
        if (!removed) throw new Error(`Project not found: ${pid}`);
        return okResult({ ok: true, project_id: pid });
      },
    },

    // ----- File linking -----

    pm_link_file: {
      schema: {
        feature_id: z.string(),
        file_path: z.string().describe('프로젝트 root 기준 상대 경로'),
        description: z.string().optional(),
      },
      handler: async ({ feature_id, file_path, description }) => {
        const link = domain.linkFile({ featureId: feature_id, filePath: file_path, description });
        return okResult({ ok: true, link });
      },
    },

    pm_unlink_file: {
      schema: { feature_id: z.string(), file_path: z.string() },
      handler: async ({ feature_id, file_path }) => {
        domain.unlinkFile(feature_id, file_path);
        return okResult({ ok: true });
      },
    },

    // ----- Workspace -----

    pm_list_workspace_features: {
      schema: {
        statuses: z.array(z.enum(['todo', 'in_progress', 'done', 'archived'])).optional()
          .describe("포함할 feature status. 기본 ['in_progress']."),
        limit: z.number().optional().describe('최대 결과 수 (기본 50, 최대 200)'),
      },
      handler: async ({ statuses, limit }) => {
        const rows = domain.listWorkspaceFeatures({ statuses, limit });
        if (rows.length === 0) return textResult('진행 중인 기능이 없습니다.');
        const formatted = rows
          .map((r) => {
            const when = r.last_activity_at
              ? new Date(r.last_activity_at).toISOString()
              : '활동 없음';
            return `[${r.project_name}] ${r.feature_name}  (${r.tasks_done}/${r.tasks_todo + r.tasks_done} · ${r.progress}% · ${when})`;
          })
          .join('\n');
        return {
          content: [
            { type: 'text', text: `${rows.length}건:\n\n${formatted}` },
            { type: 'text', text: JSON.stringify(rows, null, 2) },
          ],
        };
      },
    },

    // ----- Conventional-commit feature extraction -----

    pm_extract_features_from_commits: {
      schema: {
        project_id: z.string().optional()
          .describe('프로젝트 ID. 생략하면 현재 디렉토리에서 추론'),
        types: z.array(z.string()).optional()
          .describe('추출할 commit type 화이트리스트 (conventional 모드, 기본: feat/fix/docs/style/refactor/test/chore/perf/build/ci/revert)'),
        min_count: z.number().optional().describe('그룹당 최소 commit 수 (기본 2)'),
        include_untyped: z.boolean().optional()
          .describe('scope 없는 commit도 type 단위로 묶기 (conventional 모드, 기본 false)'),
        pattern: z.string().optional()
          .describe('사용자 정의 regex (group 1 또는 named <scope>로 scope 캡처). 지정 시 conventional 모드 무시.'),
        pattern_type: z.string().optional()
          .describe("사용자 정의 모드의 signature prefix. 기본 'custom'"),
        dry_run: z.boolean().optional().describe('true면 카운트만 반환, INSERT 없음. 기본 false'),
      },
      handler: async ({ project_id, types, min_count, include_untyped, pattern, pattern_type, dry_run }) => {
        const pid = resolveProject(project_id);
        const result = domain.extractFeaturesFromCommits(pid, {
          allowTypes: types,
          minCount: min_count,
          includeUntyped: include_untyped,
          customPattern: pattern,
          customPatternType: pattern_type,
          dryRun: dry_run,
        });
        const qualifying = result.groups.filter((g) => g.outcome !== 'under-threshold');
        const headline = dry_run
          ? `${qualifying.length}개 그룹 자격 (dry-run, DB 변경 없음)`
          : `신규 ${result.created} / 합치기 ${result.merged} / 스킵 ${result.skipped} / 백필 ${result.sessionsBackfilled} sessions`;
        const lines = [headline];
        for (const g of qualifying.slice(0, 20)) {
          const tag = g.outcome === 'created' ? '+'
            : g.outcome === 'merged' ? '~'
            : g.outcome === 'skipped' ? '·'
            : g.outcome === 'dry-run' ? '?'
            : ' ';
          lines.push(`  ${tag} ${g.signature}  (${g.commitCount}건${g.featureId ? ` → ${g.featureId}` : ''})`);
        }
        if (qualifying.length > 20) lines.push(`  … +${qualifying.length - 20}개`);
        return {
          content: [
            { type: 'text', text: lines.join('\n') },
            { type: 'text', text: JSON.stringify(result, null, 2) },
          ],
        };
      },
    },

    // ----- Git history import -----

    pm_import_git_history: {
      schema: {
        project_id: z.string().optional()
          .describe('프로젝트 ID. 생략하면 현재 디렉토리에서 추론'),
        since: z.string().optional()
          .describe("git --since 값 (ISO 날짜 또는 'N weeks ago'). 미지정 시 전체 history"),
        limit: z.number().optional().describe('최대 커밋 수 (기본 1000). 큰 repo 보호용 cap'),
        dry_run: z.boolean().optional()
          .describe('true면 신규/스킵 카운트만 반환, 실제 INSERT 안 함. 기본 false'),
      },
      handler: async ({ project_id, since, limit, dry_run }) => {
        const pid = resolveProject(project_id);
        const result = await domain.importGitHistory(pid, { since, limit, dryRun: dry_run });
        const lines = [
          `총 ${result.total}건 / 신규 ${result.newCount}건 / 스킵 ${result.skippedCount}건` +
            (dry_run ? ' (dry-run, DB 변경 없음)' : ''),
        ];
        if (result.errors.length > 0) {
          lines.push(`실패 ${result.errors.length}건:`);
          for (const e of result.errors.slice(0, 5)) {
            lines.push(`  ${e.hash.slice(0, 8)}: ${e.reason}`);
          }
          if (result.errors.length > 5) lines.push(`  … +${result.errors.length - 5}건`);
        }
        return {
          content: [
            { type: 'text', text: lines.join('\n') },
            { type: 'text', text: JSON.stringify(result, null, 2) },
          ],
        };
      },
    },

    // ----- Documents (Sprint 22, 3wtr — Spec Hub) -----

    pm_create_document: {
      schema: {
        project_id: z.string().optional().describe('프로젝트 ID. 생략하면 현재 디렉토리에서 추론'),
        kind: DOCUMENT_KIND_ENUM.describe('문서 종류 (prd / planning / architecture / retro / feature_spec / other)'),
        title: z.string().describe('문서 제목'),
        content_md: z.string().optional().describe('Markdown 본문'),
        feature_id: z.string().optional().describe('지정 시 생성 직후 해당 feature 와 link'),
      },
      handler: async ({ project_id, kind, title, content_md, feature_id }) => {
        const pid = resolveProject(project_id);
        const doc = domain.createDocument({ projectId: pid, kind, title, content_md });
        if (feature_id) domain.linkDocumentToFeature(doc.id, feature_id);
        return okResult({ document_id: doc.id, title: doc.title, kind: doc.kind });
      },
    },

    pm_update_document: {
      schema: {
        document_id: z.string(),
        kind: DOCUMENT_KIND_ENUM.optional(),
        title: z.string().optional(),
        content_md: z.string().optional(),
      },
      handler: async ({ document_id, ...patch }) => {
        const updated = domain.updateDocument(document_id, patch);
        if (!updated) throw new Error(`Document not found: ${document_id}`);
        return okResult({ ok: true, document: updated });
      },
    },

    pm_delete_document: {
      schema: { document_id: z.string() },
      handler: async ({ document_id }) => {
        const removed = domain.deleteDocument(document_id);
        if (!removed) throw new Error(`Document not found: ${document_id}`);
        return okResult({ ok: true });
      },
    },

    pm_list_documents: {
      schema: {
        project_id: z.string().optional(),
        kind: DOCUMENT_KIND_ENUM.optional().describe('지정 시 해당 종류만'),
        feature_id: z.string().optional().describe('지정 시 그 feature 에 linked 된 문서만 반환'),
        limit: z.number().optional().describe('기본 100, 최대 500'),
      },
      handler: async ({ project_id, kind, feature_id, limit }) => {
        if (feature_id) return okResult(domain.listDocumentsForFeature(feature_id));
        const pid = resolveProject(project_id);
        return okResult(domain.listDocuments(pid, { kind, limit }));
      },
    },

    pm_link_document_to_feature: {
      schema: { document_id: z.string(), feature_id: z.string() },
      handler: async ({ document_id, feature_id }) => {
        domain.linkDocumentToFeature(document_id, feature_id);
        return okResult({ ok: true });
      },
    },

    pm_unlink_document_from_feature: {
      schema: { document_id: z.string(), feature_id: z.string() },
      handler: async ({ document_id, feature_id }) => {
        const removed = domain.unlinkDocumentFromFeature(document_id, feature_id);
        return okResult({ ok: removed });
      },
    },

    // ----- Search -----

    pm_search: {
      schema: {
        project_id: z.string().optional()
          .describe('프로젝트 ID. 생략하면 현재 디렉토리에서 추론'),
        query: z.string().describe('검색어 (한국어/영문 모두 지원, prefix 매칭)'),
        limit: z.number().optional()
          .describe('최대 결과 수 (기본 20, 최대 100). 도메인에서 자동 clamp'),
      },
      handler: async ({ project_id, query, limit }) => {
        const pid = resolveProject(project_id);
        const results = domain.searchProject(pid, query, limit ?? 20);
        if (results.length === 0) return textResult('검색 결과가 없습니다.');
        const formatted = results
          .map((r) => `[${r.kind}] ${decodeEntities(r.title)} (id: ${r.ref_id})\n  ${decodeEntities(r.snippet)}`)
          .join('\n\n');
        return textResult(`${results.length}건 매칭:\n\n${formatted}`);
      },
    },
  };
}

// ============================================================
// Server bootstrap
// ============================================================

export async function startMcpServer(opts: { projectId?: string }): Promise<void> {
  const server = new McpServer({ name: 'vibemate', version: '0.1.0' });

  const registry = buildToolHandlers(opts);
  for (const [name, def] of Object.entries(registry)) {
    server.tool(name, def.schema, def.handler);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // McpServer keeps the process alive via stdio.
}
