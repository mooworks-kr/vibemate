import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as domain from './domain.js';

/**
 * MCP server. Spawned by Claude Code via stdio.
 * Project context is resolved by matching CWD against registered projects.
 */
export async function startMcpServer(opts: { projectId?: string }): Promise<void> {
  const server = new McpServer({
    name: 'vibemate',
    version: '0.1.0',
  });

  // Helper: resolve current project. Prefer explicit arg, fall back to CWD match.
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

  const ok = (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  });

  // ----- Session lifecycle -----

  server.tool(
    'pm_session_start',
    {
      project_id: z.string().optional().describe('프로젝트 ID. 생략하면 현재 디렉토리에서 추론'),
      feature_id: z.string().optional().describe('이 세션에서 작업할 기능 ID'),
    },
    async ({ project_id, feature_id }) => {
      const pid = resolveProject(project_id);
      return ok(domain.startSession({ projectId: pid, featureId: feature_id }));
    },
  );

  server.tool(
    'pm_session_end',
    {
      session_id: z.string().describe('session_start에서 받은 ID'),
      summary: z.string().describe('세션 한 줄 요약 (한국어 권장)'),
      primary_feature_id: z.string().optional().describe('이 세션에서 주로 작업한 기능'),
    },
    async ({ session_id, summary, primary_feature_id }) => {
      return ok(
        domain.endSession({
          sessionId: session_id,
          summary,
          primaryFeatureId: primary_feature_id,
        }),
      );
    },
  );

  server.tool(
    'pm_set_active_feature',
    {
      session_id: z.string(),
      feature_id: z.string(),
    },
    async ({ session_id, feature_id }) => {
      domain.setActiveFeature(session_id, feature_id);
      return ok({ ok: true });
    },
  );

  // ----- Context (called at session start) -----

  server.tool(
    'pm_get_context',
    {
      project_id: z.string().optional(),
      feature_id: z.string().optional(),
    },
    async ({ project_id, feature_id }) => {
      const pid = resolveProject(project_id);
      return ok(domain.getContext(pid, undefined, feature_id));
    },
  );

  // ----- Features -----

  server.tool(
    'pm_create_feature',
    {
      project_id: z.string().optional(),
      name: z.string().describe('기능 이름. 한국어 OK'),
      goal: z.string().optional().describe('1-2줄 목표 요약'),
      spec_md: z.string().optional().describe('전체 스펙 마크다운'),
      // Mirror HTTP createFeatureSchema — let callers create a feature
      // already in_progress / done without a follow-up update_feature call.
      status: z.enum(['todo', 'in_progress', 'done', 'archived']).optional()
        .describe('초기 상태. 미지정 시 todo'),
    },
    async ({ project_id, name, goal, spec_md, status }) => {
      const pid = resolveProject(project_id);
      const f = domain.createFeature({ projectId: pid, name, goal, spec_md, status });
      return ok({ feature_id: f.id, name: f.name });
    },
  );

  server.tool(
    'pm_update_feature',
    {
      feature_id: z.string(),
      name: z.string().optional(),
      goal: z.string().optional(),
      spec_md: z.string().optional(),
      status: z.enum(['todo', 'in_progress', 'done', 'archived']).optional(),
      priority: z.number().optional(),
    },
    async ({ feature_id, ...patch }) => {
      const updated = domain.updateFeature(feature_id, patch);
      if (!updated) throw new Error(`Feature not found: ${feature_id}`);
      return ok({ ok: true, feature: updated });
    },
  );

  // ----- Tasks -----

  server.tool(
    'pm_add_task',
    {
      feature_id: z.string(),
      name: z.string(),
    },
    async ({ feature_id, name }) => {
      const t = domain.addTask(feature_id, name);
      return ok({ task_id: t.id, name: t.name });
    },
  );

  server.tool(
    'pm_update_task',
    {
      task_id: z.number(),
      name: z.string().optional(),
      status: z.enum(['todo', 'in_progress', 'done']).optional(),
      notes: z.string().optional(),
      // Mirror HTTP updateTaskSchema. Domain's updateTask already accepts
      // `position` — this just exposes it through MCP.
      position: z.number().optional().describe('정렬 순서 (낮을수록 위)'),
    },
    async ({ task_id, ...patch }) => {
      const updated = domain.updateTask(task_id, patch);
      if (!updated) throw new Error(`Task not found: ${task_id}`);
      return ok({ ok: true, task: updated });
    },
  );

  server.tool(
    'pm_delete_task',
    {
      task_id: z.number(),
    },
    async ({ task_id }) => {
      const removed = domain.deleteTask(task_id);
      if (!removed) throw new Error(`Task not found: ${task_id}`);
      return ok({ ok: true });
    },
  );

  // ----- Decisions (ADRs) -----

  server.tool(
    'pm_log_decision',
    {
      project_id: z.string().optional(),
      feature_id: z.string().optional(),
      title: z.string().describe('결정 한 줄 제목'),
      // All ADR body fields optional — matches the HTTP schema (line ~50 of
      // http.ts). A one-line ADR (just `title`) is a valid use case: capture
      // the decision now, fill in detail later via update.
      context: z.string().optional().describe('왜 이 결정이 필요했는지'),
      decision: z.string().optional().describe('어떻게 결정했는지'),
      alternatives: z.string().optional().describe('고려한 대안들'),
      consequences: z.string().optional().describe('이 결정의 영향'),
    },
    async ({ project_id, feature_id, title, context, decision, alternatives, consequences }) => {
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
      return ok({ adr_id: adr.id, title: adr.title });
    },
  );

  server.tool(
    'pm_update_decision',
    {
      decision_id: z.string(),
      title: z.string().optional(),
      context: z.string().optional(),
      decision: z.string().optional(),
      alternatives: z.string().optional(),
      consequences: z.string().optional(),
      feature_id: z.string().nullable().optional(),
    },
    async ({ decision_id, ...patch }) => {
      const updated = domain.updateDecision(decision_id, patch);
      if (!updated) throw new Error(`Decision not found: ${decision_id}`);
      return ok({ ok: true, decision: updated });
    },
  );

  server.tool(
    'pm_delete_decision',
    {
      decision_id: z.string(),
    },
    async ({ decision_id }) => {
      const removed = domain.deleteDecision(decision_id);
      if (!removed) throw new Error(`Decision not found: ${decision_id}`);
      return ok({ ok: true });
    },
  );

  // ----- File linking (manual override) -----

  server.tool(
    'pm_link_file',
    {
      feature_id: z.string(),
      file_path: z.string().describe('프로젝트 root 기준 상대 경로'),
      description: z.string().optional(),
    },
    async ({ feature_id, file_path, description }) => {
      const link = domain.linkFile({ featureId: feature_id, filePath: file_path, description });
      return ok({ ok: true, link });
    },
  );

  server.tool(
    'pm_unlink_file',
    {
      feature_id: z.string(),
      file_path: z.string(),
    },
    async ({ feature_id, file_path }) => {
      domain.unlinkFile(feature_id, file_path);
      return ok({ ok: true });
    },
  );

  // ----- File content + AI explanation storage -----
  // These two tools let Claude Code (the user's IDE session) play the LLM role:
  //   1. read clamped file content via `pm_get_file_content`
  //   2. summarize locally
  //   3. persist via `pm_save_file_explanation`
  // vibemate stays a data store; the user's existing Claude subscription does
  // the work, no separate API key required.

  server.tool(
    'pm_get_file_content',
    {
      project_id: z.string().optional()
        .describe('프로젝트 ID. 생략하면 현재 디렉토리에서 추론'),
      file_path: z.string().describe('프로젝트 root 기준 상대 경로'),
    },
    async ({ project_id, file_path }) => {
      const pid = resolveProject(project_id);
      const result = domain.getFileContent(pid, file_path);
      // Return the raw clamped content as plain text — MCP transport is text,
      // and Claude Code reads this directly to summarize.
      return ok({
        file_path,
        content: result.content,
        truncated: result.truncated,
      });
    },
  );

  server.tool(
    'pm_clear_file_explanation',
    {
      project_id: z.string().optional()
        .describe('프로젝트 ID. 생략하면 현재 디렉토리에서 추론'),
      file_path: z.string().describe('프로젝트 root 기준 상대 경로'),
    },
    async ({ project_id, file_path }) => {
      const pid = resolveProject(project_id);
      const removed = domain.clearFileExplanation(pid, file_path);
      if (!removed) throw new Error(`No cached explanation for: ${file_path}`);
      return ok({ ok: true });
    },
  );

  server.tool(
    'pm_save_file_explanation',
    {
      project_id: z.string().optional()
        .describe('프로젝트 ID. 생략하면 현재 디렉토리에서 추론'),
      file_path: z.string().describe('프로젝트 root 기준 상대 경로'),
      summary: z.string().describe('Claude Code가 작성한 한국어 파일 설명'),
    },
    async ({ project_id, file_path, summary }) => {
      const pid = resolveProject(project_id);
      const saved = domain.saveFileExplanation(pid, file_path, summary);
      return ok({ ok: true, generated_at: saved.generated_at });
    },
  );

  // ----- Conventional-commit feature extraction -----

  server.tool(
    'pm_extract_features_from_commits',
    {
      project_id: z.string().optional()
        .describe('프로젝트 ID. 생략하면 현재 디렉토리에서 추론'),
      types: z.array(z.string()).optional()
        .describe("추출할 commit type 화이트리스트 (기본: feat/fix/docs/style/refactor/test/chore/perf/build/ci/revert)"),
      min_count: z.number().optional()
        .describe('그룹당 최소 commit 수 (기본 2)'),
      include_untyped: z.boolean().optional()
        .describe('scope 없는 commit도 type 단위로 묶기 (기본 false)'),
      dry_run: z.boolean().optional()
        .describe('true면 카운트만 반환, INSERT 없음. 기본 false'),
    },
    async ({ project_id, types, min_count, include_untyped, dry_run }) => {
      const pid = resolveProject(project_id);
      const result = domain.extractFeaturesFromCommits(pid, {
        allowTypes: types,
        minCount: min_count,
        includeUntyped: include_untyped,
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
          { type: 'text' as const, text: lines.join('\n') },
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // ----- Git history import -----

  server.tool(
    'pm_import_git_history',
    {
      project_id: z.string().optional()
        .describe('프로젝트 ID. 생략하면 현재 디렉토리에서 추론'),
      since: z.string().optional()
        .describe("git --since 값 (ISO 날짜 또는 'N weeks ago'). 미지정 시 전체 history"),
      limit: z.number().optional()
        .describe('최대 커밋 수 (기본 1000). 큰 repo 보호용 cap'),
      dry_run: z.boolean().optional()
        .describe('true면 신규/스킵 카운트만 반환, 실제 INSERT 안 함. 기본 false'),
    },
    async ({ project_id, since, limit, dry_run }) => {
      const pid = resolveProject(project_id);
      const result = await domain.importGitHistory(pid, {
        since,
        limit,
        dryRun: dry_run,
      });
      // Compose a short human-readable summary alongside the structured
      // counts. Claude Code reads the text; the JSON is for any caller that
      // wants to programmatically chain on it.
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
          { type: 'text' as const, text: lines.join('\n') },
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // ----- "Needs explanation" queue (Claude Code consumes this) -----

  server.tool(
    'pm_list_files_needing_explanation',
    {
      project_id: z.string().optional()
        .describe('프로젝트 ID. 생략하면 현재 디렉토리에서 추론'),
      limit: z.number().optional()
        .describe('최대 결과 수 (기본 50, 최대 200)'),
      stale_only: z.boolean().optional()
        .describe('true(기본)면 explanation 없거나 stale인 것만, false면 후보 전체 (force regenerate용)'),
      recent_days: z.number().optional()
        .describe('이 일수 안에 modified/created로 touch된 파일만 포함 (기본 30)'),
    },
    async ({ project_id, limit, stale_only, recent_days }) => {
      const pid = resolveProject(project_id);
      const queue = domain.listFilesNeedingExplanation(pid, {
        limit,
        staleOnly: stale_only,
        recentDays: recent_days,
      });

      if (queue.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: '설명이 필요한 파일이 없습니다.' },
          ],
        };
      }

      // Format as: "[stale|new] file_path (last touched: …)" — readable for the
      // Claude Code session that's about to call get_file_content / save.
      const formatted = queue
        .map((q) => {
          const tag = !q.has_explanation ? 'new' : q.explanation_stale ? 'stale' : 'fresh';
          return `[${tag}] ${q.file_path} (last touched ${new Date(q.last_touched_at).toISOString()})`;
        })
        .join('\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: `${queue.length}개 파일에 설명이 필요합니다:\n\n${formatted}\n\n각 파일에 대해 pm_get_file_content + pm_save_file_explanation을 호출하세요.`,
          },
        ],
      };
    },
  );

  // ----- Search (FTS5 across features/decisions/sessions/files) -----

  // The HTTP search response is HTML-escaped (`&lt;` etc.) plus literal
  // `<mark>...</mark>` highlighting tags. For an LLM consumer we want the
  // opposite: real angle brackets in user content, while keeping the marker
  // tags intact so the model can see what matched. Decoding the few common
  // entities in place is good enough — Claude reads the result, not a browser.
  const decodeEntities = (s: string): string =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');

  const KIND_LABEL_MCP: Record<string, string> = {
    feature: 'feature',
    decision: 'decision',
    session: 'session',
    file: 'file',
  };

  server.tool(
    'pm_search',
    {
      project_id: z
        .string()
        .optional()
        .describe('프로젝트 ID. 생략하면 현재 디렉토리에서 추론'),
      query: z.string().describe('검색어 (한국어/영문 모두 지원, prefix 매칭)'),
      limit: z
        .number()
        .optional()
        .describe('최대 결과 수 (기본 20, 최대 100). 도메인에서 자동 clamp'),
    },
    async ({ project_id, query, limit }) => {
      const pid = resolveProject(project_id);
      const results = domain.searchProject(pid, query, limit ?? 20);

      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: '검색 결과가 없습니다.',
            },
          ],
        };
      }

      // Format each row as: "[kind] title (id: ref_id)\n  snippet\n"
      const formatted = results
        .map((r) => {
          const kind = KIND_LABEL_MCP[r.kind] ?? r.kind;
          const title = decodeEntities(r.title);
          const snippet = decodeEntities(r.snippet);
          return `[${kind}] ${title} (id: ${r.ref_id})\n  ${snippet}`;
        })
        .join('\n\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: `${results.length}건 매칭:\n\n${formatted}`,
          },
        ],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // McpServer keeps the process alive via stdio
}
