import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as domain from '../domain.js';
import { mapStatusToEditType, parseGitLog } from '../git-import.js';
import { createTempDb } from './helpers.js';

let t: ReturnType<typeof createTempDb>;

beforeEach(() => {
  t = createTempDb();
});

afterEach(() => {
  t.cleanup();
});

describe('parseGitLog', () => {
  // Synthesise the byte layout that real git emits with `--format=...
  // --name-status -z`. Verified empirically against git 2.x:
  //   `H1<FS>T1<FS>S1<FS>B1<RS>\0\nA\0path1\0M\0path2\0H2<FS>T2<FS>...`
  // The 40-char hash requirement is what lets the parser separate the
  // previous commit's file list from the next commit's header.
  function synth(commits: Array<{
    hash: string; ts: number; subject: string; body: string;
    files: Array<[string, string] | [string, string, string]>; // [status, path] or [R/C-status, old, new]
  }>): string {
    let out = '';
    for (let i = 0; i < commits.length; i++) {
      const c = commits[i]!;
      out += [c.hash, c.ts, c.subject, c.body].join('\x1f') + '\x1e';
      // Files come AFTER the RS. -z prefix is "\0\n" before the first file
      // and `\0` between file fields. Every commit (even with no files) gets
      // the leading `\0\n`.
      out += '\0\n';
      for (const f of c.files) {
        for (const tok of f) out += tok + '\0';
      }
    }
    return out;
  }

  // 40-char placeholder hashes. Real git hashes are 40 hex chars, and the
  // parser uses that pattern to find commit boundaries — we have to match.
  const H1 = 'a'.repeat(40);
  const H2 = 'b'.repeat(40);

  it('parses a single commit with mixed file statuses', () => {
    const out = synth([{
      hash: H1, ts: 1700000000, subject: 'init', body: '',
      files: [['A', 'src/a.ts'], ['M', 'src/b.ts'], ['D', 'src/c.ts']],
    }]);
    const parsed = parseGitLog(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.hash).toBe(H1);
    expect(parsed[0]!.author_timestamp_ms).toBe(1_700_000_000_000);
    // D is dropped (no slot in our edit_type enum)
    expect(parsed[0]!.files).toEqual([
      { path: 'src/a.ts', edit_type: 'created' },
      { path: 'src/b.ts', edit_type: 'modified' },
    ]);
  });

  it('parses rename entries (R<n>) using the new path', () => {
    const out = synth([{
      hash: H1, ts: 1700000000, subject: 'fix', body: '',
      files: [['R100', 'old.ts', 'new.ts']],
    }]);
    const parsed = parseGitLog(out);
    expect(parsed[0]!.files).toEqual([
      { path: 'new.ts', edit_type: 'modified' },
    ]);
  });

  it('handles multi-commit output and preserves order', () => {
    const out = synth([
      { hash: H1, ts: 1700000000, subject: 'one', body: '', files: [['A', 'x.ts']] },
      { hash: H2, ts: 1700000100, subject: 'two', body: 'longer body', files: [['M', 'x.ts']] },
    ]);
    const parsed = parseGitLog(out);
    expect(parsed.map((c) => c.hash)).toEqual([H1, H2]);
    expect(parsed[1]!.body).toBe('longer body');
    expect(parsed[0]!.files).toEqual([{ path: 'x.ts', edit_type: 'created' }]);
    expect(parsed[1]!.files).toEqual([{ path: 'x.ts', edit_type: 'modified' }]);
  });

  it('returns [] for empty input', () => {
    expect(parseGitLog('')).toEqual([]);
  });

  it('skips records missing required fields', () => {
    // Header with only 2 fields → discarded.
    const out = `${H1}\x1f1700000000\x1e`;
    expect(parseGitLog(out)).toEqual([]);
  });
});

describe('mapStatusToEditType', () => {
  it('maps git status codes', () => {
    expect(mapStatusToEditType('A')).toBe('created');
    expect(mapStatusToEditType('M')).toBe('modified');
    expect(mapStatusToEditType('T')).toBe('modified');
    expect(mapStatusToEditType('R100')).toBe('modified');
    expect(mapStatusToEditType('C75')).toBe('created');
    expect(mapStatusToEditType('D')).toBeNull();
    expect(mapStatusToEditType('?')).toBeNull();
  });
});

describe('importGitCommit (idempotency + cascade)', () => {
  it('inserts a session + session_files + marker on first call', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const r = domain.importGitCommit({
      projectId: project.id,
      commitHash: 'deadbeef',
      authorTimestampMs: 1_700_000_000_000,
      subject: '첫 커밋',
      body: '본문 라인',
      files: [
        { path: 'src/a.ts', edit_type: 'created' },
        { path: 'README.md', edit_type: 'modified' },
      ],
    });
    expect(r.created).toBe(true);
    expect(r.sessionId).toMatch(/^[a-z0-9]{12}$/);

    const session = t.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(r.sessionId) as { summary: string; notes: string; started_at: number; ended_at: number };
    expect(session.summary).toBe('첫 커밋');
    expect(session.notes).toBe('본문 라인');
    // started_at == ended_at — a commit is instantaneous
    expect(session.started_at).toBe(1_700_000_000_000);
    expect(session.ended_at).toBe(1_700_000_000_000);

    const files = t.db
      .prepare('SELECT file_path, edit_type FROM session_files WHERE session_id = ? ORDER BY file_path')
      .all(r.sessionId) as Array<{ file_path: string; edit_type: string }>;
    expect(files).toEqual([
      { file_path: 'README.md', edit_type: 'modified' },
      { file_path: 'src/a.ts', edit_type: 'created' },
    ]);
  });

  it('returns created=false on a repeat with the same hash (idempotent)', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const args = {
      projectId: project.id,
      commitHash: 'deadbeef',
      authorTimestampMs: 1_700_000_000_000,
      subject: 'init',
      files: [],
    };
    const first = domain.importGitCommit(args);
    const second = domain.importGitCommit(args);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.sessionId).toBe(first.sessionId);
    // Only one session row — confirms the second call did NOT insert.
    const count = (t.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('skips files that match shouldIgnoreFile (node_modules etc.)', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const r = domain.importGitCommit({
      projectId: project.id,
      commitHash: 'cafe1',
      authorTimestampMs: 1_700_000_000_000,
      subject: 'noise',
      files: [
        { path: 'src/real.ts', edit_type: 'modified' },
        { path: 'node_modules/dep/index.js', edit_type: 'modified' },
        { path: 'dist/bundle.js', edit_type: 'modified' },
      ],
    });
    const paths = (t.db
      .prepare('SELECT file_path FROM session_files WHERE session_id = ?')
      .all(r.sessionId) as Array<{ file_path: string }>).map((x) => x.file_path);
    expect(paths).toEqual(['src/real.ts']);
  });

  it('drops the imported_commits row when the session is deleted (FK cascade)', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const r = domain.importGitCommit({
      projectId: project.id,
      commitHash: 'cascade1',
      authorTimestampMs: 1_700_000_000_000,
      subject: 'x',
      files: [],
    });
    t.db.prepare('DELETE FROM sessions WHERE id = ?').run(r.sessionId);
    const remaining = t.db
      .prepare('SELECT 1 FROM imported_commits WHERE commit_hash = ?')
      .get('cascade1');
    expect(remaining).toBeUndefined();
  });

  it('treats whitespace-only body as no notes', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const r = domain.importGitCommit({
      projectId: project.id,
      commitHash: 'blank-body',
      authorTimestampMs: 1_700_000_000_000,
      subject: 'x',
      body: '   \n  ',
      files: [],
    });
    const notes = (t.db.prepare('SELECT notes FROM sessions WHERE id = ?').get(r.sessionId) as { notes: string | null }).notes;
    expect(notes).toBeNull();
  });
});

// Real-git E2E. Skipped automatically when git isn't on PATH so CI machines
// without git don't fail the suite.
function gitAvailable(): boolean {
  try {
    execSync('git --version', { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

describe.skipIf(!gitAvailable())('importGitHistory (real git fixture)', () => {
  function buildFixtureRepo(): string {
    const repo = t.dir;
    // Self-contained config — don't lean on the host's user.email/name.
    execSync('git init -q -b main', { cwd: repo });
    execSync('git config user.email vibemate@test.local', { cwd: repo });
    execSync('git config user.name vibemate', { cwd: repo });
    execSync('git config commit.gpgsign false', { cwd: repo });

    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    execSync('git add a.ts', { cwd: repo });
    execSync('git commit -q -m "first commit\n\nlonger body"', { cwd: repo });

    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(repo, 'b.ts'), 'export const b = 1;\n');
    execSync('git add a.ts b.ts', { cwd: repo });
    execSync('git commit -q -m "second commit"', { cwd: repo });
    return repo;
  }

  it('imports every commit and is idempotent on a second run', async () => {
    const repo = buildFixtureRepo();
    const project = domain.createProject({ name: 'fixture', rootPath: repo });

    const first = await domain.importGitHistory(project.id);
    expect(first.total).toBe(2);
    expect(first.newCount).toBe(2);
    expect(first.skippedCount).toBe(0);
    expect(first.errors).toEqual([]);

    const second = await domain.importGitHistory(project.id);
    expect(second.total).toBe(2);
    expect(second.newCount).toBe(0);
    expect(second.skippedCount).toBe(2);
  });

  it('dryRun returns the same counts but writes nothing', async () => {
    const repo = buildFixtureRepo();
    const project = domain.createProject({ name: 'fixture', rootPath: repo });

    const dry = await domain.importGitHistory(project.id, { dryRun: true });
    expect(dry.total).toBe(2);
    expect(dry.newCount).toBe(2);
    const sessionCount = (t.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
    expect(sessionCount).toBe(0);
  });

  it('respects --limit', async () => {
    const repo = buildFixtureRepo();
    const project = domain.createProject({ name: 'fixture', rootPath: repo });

    const r = await domain.importGitHistory(project.id, { limit: 1 });
    expect(r.total).toBe(1);
    expect(r.newCount).toBe(1);
  });

  it('handles a repo with no commits (empty result)', async () => {
    execSync('git init -q -b main', { cwd: t.dir });
    execSync('git config user.email v@l', { cwd: t.dir });
    execSync('git config user.name v', { cwd: t.dir });
    const project = domain.createProject({ name: 'empty', rootPath: t.dir });
    // git log on an empty repo exits 128. We surface that as a thrown error
    // rather than a 0-commit success — the caller (CLI) prints it cleanly.
    await expect(domain.importGitHistory(project.id)).rejects.toThrow();
  });

  it('throws when the project root is not a git repo', async () => {
    const project = domain.createProject({ name: 'notgit', rootPath: t.dir });
    await expect(domain.importGitHistory(project.id)).rejects.toThrow();
  });
});
