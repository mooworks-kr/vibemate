import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import * as domain from '../domain.js';
import { getDb } from '../db.js';
import { createTempDb, gitInit } from './helpers.js';

let t: ReturnType<typeof createTempDb>;

beforeEach(() => {
  t = createTempDb();
});

afterEach(() => {
  t.cleanup();
});

// Helper: bootstrap a session with N session_files for endSession to chew on.
function makeSessionWithFiles(projectRoot: string, files: string[] = []): { sessionId: string; projectId: string } {
  const project = domain.createProject({ name: 'P', rootPath: projectRoot });
  const startCtx = domain.startSession({ projectId: project.id });
  const sessionId = startCtx.session_id;
  const db = getDb();
  for (const f of files) {
    db.prepare(
      `INSERT INTO session_files (session_id, file_path, edit_type) VALUES (?, ?, 'modified')`,
    ).run(sessionId, f);
  }
  return { sessionId, projectId: project.id };
}

describe('endSession', () => {
  it('returns files_touched in insertion order', () => {
    const { sessionId } = makeSessionWithFiles(t.dir, ['a.ts', 'b.ts', 'c.ts']);
    const result = domain.endSession({ sessionId, summary: 's' });
    expect(result.ok).toBe(true);
    expect(result.files_touched.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('returns empty files_touched when no session_files recorded', () => {
    const { sessionId } = makeSessionWithFiles(t.dir, []);
    const result = domain.endSession({ sessionId, summary: 's' });
    expect(result.files_touched).toEqual([]);
  });

  it('throws on unknown sessionId', () => {
    expect(() =>
      domain.endSession({ sessionId: 'nope', summary: 's' }),
    ).toThrow(/Session not found/);
  });

  it('persists summary to sessions row', () => {
    const { sessionId } = makeSessionWithFiles(t.dir, []);
    domain.endSession({ sessionId, summary: '세션 종료 요약' });
    const row = getDb()
      .prepare('SELECT summary, ended_at FROM sessions WHERE id = ?')
      .get(sessionId) as { summary: string; ended_at: number };
    expect(row.summary).toBe('세션 종료 요약');
    expect(row.ended_at).toBeGreaterThan(0);
  });

  // Sprint 23 (h5uk / ADR-0020): claudeMdTemplate v4 instructs callers to
  // pass structured Markdown `notes`. endSession stores it; the first 200
  // chars become the next session's `last_session.notes_excerpt`.
  it('persists structured Markdown notes when provided', () => {
    const { sessionId } = makeSessionWithFiles(t.dir, []);
    const notes = '## 완료\n- 인벤토리\n## 남은 일\n- 백엔드 구현';
    domain.endSession({ sessionId, summary: 's', notes });
    const row = getDb()
      .prepare('SELECT notes FROM sessions WHERE id = ?')
      .get(sessionId) as { notes: string };
    expect(row.notes).toBe(notes);
  });

  it('preserves existing notes when caller omits the field (COALESCE)', () => {
    // Pre-seed the row with notes the way `pm import-history` does (commit
    // body in notes). endSession without a `notes` arg must not clobber it.
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const startCtx = domain.startSession({ projectId: project.id });
    getDb()
      .prepare('UPDATE sessions SET notes = ? WHERE id = ?')
      .run('pre-existing commit body', startCtx.session_id);

    domain.endSession({ sessionId: startCtx.session_id, summary: 's' });
    const row = getDb()
      .prepare('SELECT notes FROM sessions WHERE id = ?')
      .get(startCtx.session_id) as { notes: string };
    expect(row.notes).toBe('pre-existing commit body');
  });
});

// (Removed in ADR-0016: describe blocks for getFileContent / saveFileExplanation /
// clearFileExplanation — 13 tests. Code Map / AI file-explanation workflow retired.)

describe('getContext', () => {
  // Sprint 19 (iljn): `active_features` was widened to include `todo` so that
  // todo-heavy projects don't look empty at session start. These tests pin
  // both the filter (in_progress + todo) and the ordering rules (status →
  // priority → updated_at) so a future tweak can't silently reorder things.
  it('returns todo features in active_features when no in_progress exists', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    domain.createFeature({ projectId: project.id, name: 'A', status: 'todo' });
    domain.createFeature({ projectId: project.id, name: 'B', status: 'todo' });

    const ctx = domain.getContext(project.id);
    expect(ctx.active_features.map((f) => f.name).sort()).toEqual(['A', 'B']);
    // auto-pick: with no in_progress, the first todo wins.
    expect(ctx.active_feature?.name).toMatch(/^[AB]$/);
  });

  it('orders in_progress before todo regardless of insertion order', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    // Insert todo first, then in_progress — listFeatures' default order would
    // otherwise return the todo first. The sort is the load-bearing bit.
    domain.createFeature({ projectId: project.id, name: 'TodoA', status: 'todo' });
    domain.createFeature({ projectId: project.id, name: 'InProgA', status: 'in_progress' });

    const ctx = domain.getContext(project.id);
    expect(ctx.active_features.map((f) => f.name)).toEqual(['InProgA', 'TodoA']);
    // active_feature falls out of activeFeatures[0] → must be the in_progress one.
    expect(ctx.active_feature?.name).toBe('InProgA');
    expect(ctx.active_feature?.status).toBe('in_progress');
  });

  it('excludes done and archived features from active_features', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    domain.createFeature({ projectId: project.id, name: 'Live', status: 'in_progress' });
    domain.createFeature({ projectId: project.id, name: 'Past', status: 'done' });
    const arch = domain.createFeature({ projectId: project.id, name: 'Old', status: 'todo' });
    domain.updateFeature(arch.id, { status: 'archived' });

    const ctx = domain.getContext(project.id);
    expect(ctx.active_features.map((f) => f.name)).toEqual(['Live']);
  });

  it('breaks ties within a status by priority DESC then updated_at DESC', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    // All three are todo. Priority sorting is the primary tie-break.
    const a = domain.createFeature({ projectId: project.id, name: 'LowPrio', status: 'todo' });
    const b = domain.createFeature({ projectId: project.id, name: 'HighPrio', status: 'todo' });
    const c = domain.createFeature({ projectId: project.id, name: 'MidPrio', status: 'todo' });
    domain.updateFeature(a.id, { priority: 1 });
    domain.updateFeature(b.id, { priority: 10 });
    domain.updateFeature(c.id, { priority: 5 });

    const ctx = domain.getContext(project.id);
    expect(ctx.active_features.map((f) => f.name)).toEqual([
      'HighPrio', 'MidPrio', 'LowPrio',
    ]);
  });

  it('honours an explicit featureId for active_feature even when not first in the sort', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const inProg = domain.createFeature({ projectId: project.id, name: 'Default', status: 'in_progress' });
    const todoFeat = domain.createFeature({
      projectId: project.id,
      name: 'Asked',
      status: 'todo',
      spec_md: '## scope\n- demo',
    });

    const ctx = domain.getContext(project.id, undefined, todoFeat.id);
    expect(ctx.active_feature?.id).toBe(todoFeat.id);
    expect(ctx.active_feature?.name).toBe('Asked');
    // The explicit pick also threads through the feature's spec_md, matching
    // the SessionStartContext contract relied on by Sprint 17 (setActiveFeature).
    expect(ctx.spec_md).toContain('## scope');
    // The unrequested in_progress still appears in the broader active_features
    // list — the explicit hint only overrides the single auto-pick.
    expect(ctx.active_features.map((f) => f.name)).toContain('Default');
    expect(ctx.active_features.map((f) => f.name)).toContain('Asked');
    void inProg;
  });

  // Sprint 22 / ADR-0019 #6: getContext surfaces the active feature's linked
  // documents alongside spec_md so Claude Code gets PRD / planning context.
  it('populates active_documents from the active feature\'s linked docs', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: project.id, name: 'F', status: 'in_progress' });
    const d = domain.createDocument({
      projectId: project.id,
      kind: 'prd',
      title: '결제 PRD',
      content_md: '## 범위\n- 결제 흐름 정리',
    });
    domain.linkDocumentToFeature(d.id, f.id);

    const ctx = domain.getContext(project.id);
    expect(ctx.active_documents).toHaveLength(1);
    expect(ctx.active_documents[0]!.id).toBe(d.id);
    expect(ctx.active_documents[0]!.kind).toBe('prd');
    expect(ctx.active_documents[0]!.excerpt).toContain('## 범위');
  });

  it('returns empty active_documents when there is no active feature', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    // No features at all → activeFeature stays null → no docs to surface.
    const ctx = domain.getContext(project.id);
    expect(ctx.active_feature).toBeNull();
    expect(ctx.active_documents).toEqual([]);
  });
});

describe('setActiveFeature', () => {
  it('returns FeatureContext + spec_md on success and re-points the session', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({
      projectId: project.id,
      name: '인증 모듈',
      goal: '로그인/회원가입 흐름 정리',
      spec_md: '## 범위\n- email/pw 로그인\n## 비범위\n- OAuth',
    });
    const startCtx = domain.startSession({ projectId: project.id });
    const sessionId = startCtx.session_id;

    const out = domain.setActiveFeature(sessionId, f.id);

    expect(out.ok).toBe(true);
    expect(out.feature.id).toBe(f.id);
    expect(out.feature.name).toBe('인증 모듈');
    expect(out.feature.goal).toBe('로그인/회원가입 흐름 정리');
    // FeatureContext exposes status/progress/next_task — covered by
    // featureToContext; we just check the spec_md hand-off here.
    expect(out.spec_md).toContain('## 범위');
    expect(out.spec_md).toContain('## 비범위');

    // Session row actually re-pointed.
    const row = getDb()
      .prepare('SELECT feature_id FROM sessions WHERE id = ?')
      .get(sessionId) as { feature_id: string };
    expect(row.feature_id).toBe(f.id);
  });

  it('returns spec_md=null for a feature with no spec written yet', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: project.id, name: '백오피스' });
    const startCtx = domain.startSession({ projectId: project.id });

    const out = domain.setActiveFeature(startCtx.session_id, f.id);
    expect(out.spec_md).toBeNull();
  });

  it('throws when the feature_id does not exist', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const startCtx = domain.startSession({ projectId: project.id });
    expect(() =>
      domain.setActiveFeature(startCtx.session_id, 'no-such-feature'),
    ).toThrow(/Feature not found/);
  });

  it('throws when the session_id does not exist (typo guard)', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: project.id, name: 'X' });
    expect(() => domain.setActiveFeature('no-such-session', f.id)).toThrow(
      /Session not found/,
    );
  });

  // Sprint 22 / ADR-0019 #6: setActiveFeature also ships the active feature's
  // linked documents (up to 5, body trimmed to 200 chars) so Claude Code can
  // pick up PRD/planning context in a single MCP round-trip.
  it('returns active_documents for the picked feature (limit + excerpt)', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: project.id, name: 'F' });
    // 7 docs total: limit is 5, so we expect the 5 most recently linked.
    const docs = [];
    for (let i = 0; i < 7; i++) {
      const d = domain.createDocument({
        projectId: project.id,
        kind: 'planning',
        title: `doc-${i}`,
        // 250 chars — over the 200-char excerpt budget, so we can check truncation.
        content_md: 'x'.repeat(250),
      });
      docs.push(d);
      domain.linkDocumentToFeature(d.id, f.id);
    }
    const startCtx = domain.startSession({ projectId: project.id });
    const out = domain.setActiveFeature(startCtx.session_id, f.id);

    expect(out.active_documents).toHaveLength(5);
    // Excerpt budget enforced: original 250-char body → 200-char + '…'.
    for (const summary of out.active_documents) {
      expect(summary.excerpt.length).toBeLessThanOrEqual(201);
      expect(summary.excerpt.endsWith('…')).toBe(true);
      expect(summary.kind).toBe('planning');
    }
  });

  it('returns empty active_documents when the feature has no linked docs', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: project.id, name: 'F' });
    const startCtx = domain.startSession({ projectId: project.id });
    const out = domain.setActiveFeature(startCtx.session_id, f.id);
    expect(out.active_documents).toEqual([]);
  });
});

// Sprint 21 (zxl3, ADR-0019): deriveSessionFiles + endSession git integration.
// These tests need a real git working tree (via `gitInit` from helpers).
//
// We deliberately don't mock execFileSync — the parsing has subtle branches
// (porcelain status codes, rename arrows, deletes) and a fake exercise
// would be more fragile than a real one. The fixture stays tiny (≤3 files,
// no remotes) so all tests run in well under a second.

describe('deriveSessionFiles', () => {
  it('returns an empty array for a non-git directory (graceful)', () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'vibemate-nongit-'));
    try {
      expect(domain.deriveSessionFiles(nonGit)).toEqual([]);
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('returns an empty array on a clean git repo', () => {
    const g = gitInit();
    try {
      expect(domain.deriveSessionFiles(g.repoDir)).toEqual([]);
    } finally {
      g.cleanup();
    }
  });

  it("maps modifications to 'modified' and untracked files to 'created'", () => {
    const g = gitInit();
    try {
      // Modify the tracked README and drop an untracked file.
      fs.appendFileSync(path.join(g.repoDir, 'README.md'), 'second line\n');
      fs.writeFileSync(path.join(g.repoDir, 'NEW.md'), 'brand new\n');

      const got = domain.deriveSessionFiles(g.repoDir);
      // Sort for stable assertions; status order isn't a contract.
      const byPath = Object.fromEntries(got.map((f) => [f.path, f.edit_type]));
      expect(byPath['README.md']).toBe('modified');
      expect(byPath['NEW.md']).toBe('created');
      expect(got).toHaveLength(2);
    } finally {
      g.cleanup();
    }
  });

  it("maps staged adds to 'created' (status 'A ')", () => {
    const g = gitInit();
    try {
      fs.writeFileSync(path.join(g.repoDir, 'staged.ts'), 'export {};\n');
      execFileSync('git', ['add', 'staged.ts'], { cwd: g.repoDir, stdio: 'ignore' });
      const got = domain.deriveSessionFiles(g.repoDir);
      expect(got).toEqual([{ path: 'staged.ts', edit_type: 'created' }]);
    } finally {
      g.cleanup();
    }
  });

  it('skips deletions per ADR-0012 (we track presence, not absence)', () => {
    const g = gitInit();
    try {
      fs.rmSync(path.join(g.repoDir, 'README.md'));
      const got = domain.deriveSessionFiles(g.repoDir);
      expect(got).toEqual([]);
    } finally {
      g.cleanup();
    }
  });

  it('applies shouldIgnoreFile (node_modules / .git / build artifacts)', () => {
    const g = gitInit();
    try {
      // Two of these should land in node_modules / dist (ignored). Only
      // the src/ file should survive the filter. shouldIgnoreFile lives in
      // lib.ts and is shared with import-history, so any drift would
      // surface here too.
      fs.mkdirSync(path.join(g.repoDir, 'node_modules', 'foo'), { recursive: true });
      fs.writeFileSync(path.join(g.repoDir, 'node_modules', 'foo', 'index.js'), 'x');
      fs.mkdirSync(path.join(g.repoDir, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(g.repoDir, 'dist', 'bundle.js'), 'x');
      fs.mkdirSync(path.join(g.repoDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(g.repoDir, 'src', 'real.ts'), 'export {};');

      const got = domain.deriveSessionFiles(g.repoDir);
      expect(got.map((f) => f.path)).toEqual(['src/real.ts']);
    } finally {
      g.cleanup();
    }
  });
});

describe('endSession + git status integration', () => {
  it('writes derived files into session_files and surfaces them in files_touched', () => {
    const g = gitInit();
    try {
      // Same temp-DB scaffolding as the other endSession tests above.
      const project = domain.createProject({ name: 'P', rootPath: g.repoDir });
      const startCtx = domain.startSession({ projectId: project.id });
      // Make changes AFTER startSession — Sprint 21 flow doesn't snapshot
      // a baseline; we just look at the working tree at endSession.
      fs.appendFileSync(path.join(g.repoDir, 'README.md'), 'edit\n');
      fs.writeFileSync(path.join(g.repoDir, 'note.txt'), 'hi');

      const res = domain.endSession({ sessionId: startCtx.session_id, summary: 's' });
      expect(res.ok).toBe(true);
      expect(res.files_touched.sort()).toEqual(['README.md', 'note.txt']);

      // And the rows landed in session_files for downstream queries
      // (sessions tab, feature_files autoLink).
      const rows = getDb()
        .prepare('SELECT file_path FROM session_files WHERE session_id = ?')
        .all(startCtx.session_id) as { file_path: string }[];
      expect(rows.map((r) => r.file_path).sort()).toEqual(['README.md', 'note.txt']);
    } finally {
      g.cleanup();
    }
  });

  it('is idempotent on re-end (recordSessionFile rank guard keeps existing rows clean)', () => {
    // Calling endSession twice — which shouldn't happen in practice but
    // is the kind of edge case that bit us in import-history — must not
    // duplicate rows or downgrade edit_types.
    const g = gitInit();
    try {
      const project = domain.createProject({ name: 'P', rootPath: g.repoDir });
      const startCtx = domain.startSession({ projectId: project.id });
      fs.writeFileSync(path.join(g.repoDir, 'note.txt'), 'hi');

      domain.endSession({ sessionId: startCtx.session_id, summary: 's' });
      domain.endSession({ sessionId: startCtx.session_id, summary: 's again' });

      const rows = getDb()
        .prepare('SELECT file_path, edit_type FROM session_files WHERE session_id = ?')
        .all(startCtx.session_id) as { file_path: string; edit_type: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.file_path).toBe('note.txt');
      expect(rows[0]!.edit_type).toBe('created');
    } finally {
      g.cleanup();
    }
  });

  it('returns empty files_touched when the project root is not a git repo (graceful)', () => {
    // matches the existing "no session_files recorded" test above but
    // exercises the new derive-path explicitly.
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const startCtx = domain.startSession({ projectId: project.id });
    const res = domain.endSession({ sessionId: startCtx.session_id, summary: 's' });
    expect(res.files_touched).toEqual([]);
  });
});
