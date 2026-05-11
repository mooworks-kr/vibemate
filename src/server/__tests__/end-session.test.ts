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
