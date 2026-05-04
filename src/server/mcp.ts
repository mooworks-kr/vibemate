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
    },
    async ({ project_id, name, goal, spec_md }) => {
      const pid = resolveProject(project_id);
      const f = domain.createFeature({ projectId: pid, name, goal, spec_md });
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
    },
    async ({ task_id, ...patch }) => {
      const updated = domain.updateTask(task_id, patch);
      if (!updated) throw new Error(`Task not found: ${task_id}`);
      return ok({ ok: true, task: updated });
    },
  );

  // ----- Decisions (ADRs) -----

  server.tool(
    'pm_log_decision',
    {
      project_id: z.string().optional(),
      feature_id: z.string().optional(),
      title: z.string().describe('결정 한 줄 제목'),
      context: z.string().describe('왜 이 결정이 필요했는지'),
      decision: z.string().describe('어떻게 결정했는지'),
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // McpServer keeps the process alive via stdio
}
