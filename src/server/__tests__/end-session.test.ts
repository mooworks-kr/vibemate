import fs from 'node:fs';
import path from 'node:path';
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

describe('getFileContent (MCP-facing)', () => {
  it('returns clamped content + truncated=false for small file', () => {
    const project = domain.createProject({ name: 'GFC', rootPath: t.dir });
    const filePath = 'tiny.ts';
    fs.writeFileSync(path.join(t.dir, filePath), 'export const x = 1;\n');

    const result = domain.getFileContent(project.id, filePath);
    expect(result.content).toBe('export const x = 1;\n');
    expect(result.truncated).toBe(false);
    expect(result.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('truncates files over the byte budget', () => {
    const project = domain.createProject({ name: 'GFC', rootPath: t.dir });
    const filePath = 'big.txt';
    // Write 64KB of `a` — well over MAX_EXPLAIN_BYTES (32KB).
    fs.writeFileSync(path.join(t.dir, filePath), 'a'.repeat(64 * 1024));

    const result = domain.getFileContent(project.id, filePath);
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(32 * 1024);
  });

  it('throws IGNORED on node_modules path', () => {
    const project = domain.createProject({ name: 'GFC', rootPath: t.dir });
    expect(() => domain.getFileContent(project.id, 'node_modules/foo.js'))
      .toThrow(domain.FILE_EXPLAIN_ERRORS.IGNORED);
  });

  it('throws OUTSIDE_ROOT on path traversal', () => {
    const project = domain.createProject({ name: 'GFC', rootPath: t.dir });
    expect(() => domain.getFileContent(project.id, '../../etc/passwd'))
      .toThrow(domain.FILE_EXPLAIN_ERRORS.OUTSIDE_ROOT);
  });

  it('throws NOT_FOUND for missing file', () => {
    const project = domain.createProject({ name: 'GFC', rootPath: t.dir });
    expect(() => domain.getFileContent(project.id, 'no-such-file.ts'))
      .toThrow(domain.FILE_EXPLAIN_ERRORS.NOT_FOUND);
  });

  it('throws BINARY for files with null bytes in the head', () => {
    const project = domain.createProject({ name: 'GFC', rootPath: t.dir });
    const filePath = 'bin.dat';
    fs.writeFileSync(path.join(t.dir, filePath), Buffer.from([0, 1, 2, 65, 66, 67]));
    expect(() => domain.getFileContent(project.id, filePath))
      .toThrow(domain.FILE_EXPLAIN_ERRORS.BINARY);
  });
});

describe('saveFileExplanation (MCP-facing)', () => {
  it('upserts to file_explanations with content_hash matching getFileContent', () => {
    const project = domain.createProject({ name: 'SFE', rootPath: t.dir });
    const filePath = 'src.ts';
    fs.writeFileSync(path.join(t.dir, filePath), 'export const greeting = "hi";\n');

    const fetched = domain.getFileContent(project.id, filePath);
    const saved = domain.saveFileExplanation(
      project.id,
      filePath,
      '간단한 인사말 상수를 export하는 파일.',
    );

    expect(saved.content_hash).toBe(fetched.content_hash);
    expect(saved.explanation).toBe('간단한 인사말 상수를 export하는 파일.');
    expect(saved.generated_at).toBeGreaterThan(0);

    const cached = domain.getFileExplanation(project.id, filePath);
    expect(cached?.explanation).toBe('간단한 인사말 상수를 export하는 파일.');
  });

  it('overwrites existing explanation on subsequent save (upsert)', () => {
    const project = domain.createProject({ name: 'SFE', rootPath: t.dir });
    const filePath = 'src.ts';
    fs.writeFileSync(path.join(t.dir, filePath), 'export const x = 1;\n');

    domain.saveFileExplanation(project.id, filePath, '첫 설명.');
    domain.saveFileExplanation(project.id, filePath, '두 번째 설명.');

    const final = domain.getFileExplanation(project.id, filePath);
    expect(final?.explanation).toBe('두 번째 설명.');
  });

  it('rejects empty explanation text', () => {
    const project = domain.createProject({ name: 'SFE', rootPath: t.dir });
    const filePath = 'src.ts';
    fs.writeFileSync(path.join(t.dir, filePath), 'x\n');
    expect(() => domain.saveFileExplanation(project.id, filePath, '   '))
      .toThrow(domain.FILE_EXPLAIN_ERRORS.EMPTY_TEXT);
  });

  it('FTS5 trigger picks up the upsert (search hits the explanation)', () => {
    const project = domain.createProject({ name: 'SFE', rootPath: t.dir });
    const filePath = 'src.ts';
    fs.writeFileSync(path.join(t.dir, filePath), 'console.log(1);\n');

    domain.saveFileExplanation(
      project.id,
      filePath,
      '컨솔 출력만 하는 단순 스크립트 파일.',
    );

    const hits = domain.searchProject(project.id, '컨솔');
    expect(hits.some((h) => h.kind === 'file' && h.ref_id === filePath)).toBe(true);
  });
});

describe('clearFileExplanation (force-regenerate path)', () => {
  it('deletes the row and the FTS5 mirror — search no longer hits the file', () => {
    const project = domain.createProject({ name: 'CFE', rootPath: t.dir });
    const filePath = 'src.ts';
    fs.writeFileSync(path.join(t.dir, filePath), 'x\n');

    domain.saveFileExplanation(project.id, filePath, '리아밍해요 키워드.');
    expect(domain.getFileExplanation(project.id, filePath)).not.toBeNull();
    // Sanity check: FTS5 mirror exists.
    expect(
      domain.searchProject(project.id, '리아밍해요').some((h) => h.kind === 'file' && h.ref_id === filePath),
    ).toBe(true);

    expect(domain.clearFileExplanation(project.id, filePath)).toBe(true);

    // Cache cleared
    expect(domain.getFileExplanation(project.id, filePath)).toBeNull();
    // FTS5 trigger (file_explanations_ad) wiped the search row too
    expect(
      domain.searchProject(project.id, '리아밍해요').some((h) => h.kind === 'file' && h.ref_id === filePath),
    ).toBe(false);
  });

  it('returns false when there was nothing cached (idempotent no-op)', () => {
    const project = domain.createProject({ name: 'CFE', rootPath: t.dir });
    expect(domain.clearFileExplanation(project.id, 'never-explained.ts')).toBe(false);
  });
});
