import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as domain from '../domain.js';
import { getDb } from '../db.js';
import { createTempDb } from './helpers.js';

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
});

// (Removed in ADR-0016: describe blocks for getFileContent / saveFileExplanation /
// clearFileExplanation — 13 tests. Code Map / AI file-explanation workflow retired.)

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
});
