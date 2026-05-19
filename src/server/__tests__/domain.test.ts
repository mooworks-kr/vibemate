import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as domain from '../domain.js';
import { getDb } from '../db.js';
import { sanitizeFtsQuery } from '../domain.js';
import { createTempDb } from './helpers.js';

let t: ReturnType<typeof createTempDb>;

beforeEach(() => {
  t = createTempDb();
});

afterEach(() => {
  t.cleanup();
});

describe('projects', () => {
  it('createProject + listProjects round-trips', () => {
    const p = domain.createProject({
      name: 'Vibemate',
      rootPath: t.dir,
      tagline: '한 줄 설명',
      goal: 'goal here',
      tech: ['ts', 'sqlite'],
    });
    expect(p.id).toMatch(/^[a-z0-9-]+$/);
    expect(p.name).toBe('Vibemate');
    expect(p.tech).toEqual(['ts', 'sqlite']);

    const all = domain.listProjects();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(p.id);
  });

  it('getProject returns null for unknown id', () => {
    expect(domain.getProject('does-not-exist')).toBeNull();
  });

  it('Korean name produces a non-empty slug', () => {
    const p = domain.createProject({ name: '한국어 프로젝트', rootPath: t.dir });
    expect(p.id.length).toBeGreaterThan(0);
  });
});

// Sprint 28 (pax6) — deletion impact + cascade.
describe('getProjectDeletionImpact / deleteProject', () => {
  it('counts every child row + active sessions', () => {
    const proj = domain.createProject({ name: 'P-del', rootPath: t.dir });
    const f = domain.createFeature({ projectId: proj.id, name: '인증' });
    domain.addTask(f.id, 'task A');
    domain.addTask(f.id, 'task B');
    domain.logDecision({ projectId: proj.id, title: 'ADR-1' });
    const doc = domain.createDocument({ projectId: proj.id, kind: 'prd', title: 'PRD' });
    domain.linkDocumentToFeature(doc.id, f.id);
    domain.linkFile({ featureId: f.id, filePath: 'src/foo.ts' });

    // One open session (active) + one closed.
    const open = domain.startSession({ projectId: proj.id, featureId: f.id });
    const closed = domain.startSession({ projectId: proj.id, featureId: f.id });
    domain.endSession({ sessionId: closed.session_id, summary: 'wrap' });

    const impact = domain.getProjectDeletionImpact(proj.id);
    expect(impact.features).toBe(1);
    expect(impact.tasks).toBe(2);
    expect(impact.sessions).toBe(2);
    expect(impact.decisions).toBe(1);
    expect(impact.documents).toBe(1);
    expect(impact.feature_files).toBe(1);
    expect(impact.document_features).toBe(1);
    expect(impact.imported_commits).toBe(0);
    expect(impact.extracted_features).toBe(0);
    expect(impact.active_sessions).toBe(1);
    // Sanity: open session id is still around
    expect(open.session_id).toBeTruthy();
  });

  it('returns all-zero counts on a fresh empty project', () => {
    const proj = domain.createProject({ name: 'P-empty', rootPath: t.dir });
    const impact = domain.getProjectDeletionImpact(proj.id);
    expect(impact).toEqual({
      features: 0,
      tasks: 0,
      sessions: 0,
      decisions: 0,
      documents: 0,
      feature_files: 0,
      document_features: 0,
      imported_commits: 0,
      extracted_features: 0,
      active_sessions: 0,
    });
  });

  it('cascade wipes features / tasks / sessions / decisions / documents and search_fts rows', () => {
    const db = getDb();
    const proj = domain.createProject({ name: 'P-cascade', rootPath: t.dir });
    const f = domain.createFeature({ projectId: proj.id, name: '인증' });
    domain.addTask(f.id, 'task A');
    domain.logDecision({ projectId: proj.id, title: 'ADR' });
    const doc = domain.createDocument({ projectId: proj.id, kind: 'prd', title: 'PRD' });
    domain.linkDocumentToFeature(doc.id, f.id);
    domain.linkFile({ featureId: f.id, filePath: 'src/a.ts' });
    const s = domain.startSession({ projectId: proj.id, featureId: f.id });
    domain.endSession({ sessionId: s.session_id, summary: 'first' });

    const removed = domain.deleteProject(proj.id);
    expect(removed).toBe(true);

    // Direct rows gone.
    expect(domain.getProject(proj.id)).toBeNull();
    expect(domain.listFeatures(proj.id)).toHaveLength(0);
    const tasks = db
      .prepare('SELECT COUNT(*) AS n FROM tasks WHERE feature_id = ?')
      .get(f.id) as { n: number };
    expect(tasks.n).toBe(0);
    const sessions = db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?')
      .get(proj.id) as { n: number };
    expect(sessions.n).toBe(0);
    expect(domain.listDecisions(proj.id)).toHaveLength(0);
    expect(domain.listDocuments(proj.id)).toHaveLength(0);
    const ff = db
      .prepare('SELECT COUNT(*) AS n FROM feature_files WHERE feature_id = ?')
      .get(f.id) as { n: number };
    expect(ff.n).toBe(0);
    const df = db
      .prepare('SELECT COUNT(*) AS n FROM document_features WHERE document_id = ?')
      .get(doc.id) as { n: number };
    expect(df.n).toBe(0);

    // FTS5 rows — feature / decision / session / document should all be gone
    // via the *_ad triggers from 0002 / 0006.
    const fts = db
      .prepare('SELECT COUNT(*) AS n FROM search_fts WHERE project_id = ?')
      .get(proj.id) as { n: number };
    expect(fts.n).toBe(0);
  });

  it('throws when an active session exists and force=false', () => {
    const proj = domain.createProject({ name: 'P-active', rootPath: t.dir });
    domain.startSession({ projectId: proj.id });
    expect(() => domain.deleteProject(proj.id)).toThrow(/active session/i);
    // Project still here.
    expect(domain.getProject(proj.id)).not.toBeNull();
  });

  it('force=true bypasses the active-session guard', () => {
    const proj = domain.createProject({ name: 'P-force', rootPath: t.dir });
    domain.startSession({ projectId: proj.id });
    const removed = domain.deleteProject(proj.id, { force: true });
    expect(removed).toBe(true);
    expect(domain.getProject(proj.id)).toBeNull();
  });

  it('returns false for unknown project id', () => {
    expect(domain.deleteProject('nope-does-not-exist')).toBe(false);
  });

  it('does not affect sibling projects', () => {
    const a = domain.createProject({ name: 'A', rootPath: t.dir + '/a' });
    const b = domain.createProject({ name: 'B', rootPath: t.dir + '/b' });
    domain.createFeature({ projectId: a.id, name: 'fa' });
    domain.createFeature({ projectId: b.id, name: 'fb' });

    domain.deleteProject(a.id);

    expect(domain.getProject(a.id)).toBeNull();
    expect(domain.getProject(b.id)).not.toBeNull();
    expect(domain.listFeatures(b.id)).toHaveLength(1);
  });
});

describe('features', () => {
  it('createFeature + listFeatures + updateFeature flow', () => {
    const proj = domain.createProject({ name: 'P1', rootPath: t.dir });
    const f = domain.createFeature({
      projectId: proj.id,
      name: '인증 모듈',
      goal: 'OAuth2 로그인',
    });
    expect(f.status).toBe('todo');

    const updated = domain.updateFeature(f.id, { status: 'in_progress', name: '인증 (수정됨)' });
    expect(updated?.status).toBe('in_progress');
    expect(updated?.name).toBe('인증 (수정됨)');

    const list = domain.listFeatures(proj.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(f.id);

    const filtered = domain.listFeatures(proj.id, 'done');
    expect(filtered).toHaveLength(0);
  });

  it('updateFeature on unknown id returns null', () => {
    expect(domain.updateFeature('nope', { name: 'x' })).toBeNull();
  });
});

describe('decisions', () => {
  it('logDecision + getDecision + updateDecision + deleteDecision flow', () => {
    const proj = domain.createProject({ name: 'P1', rootPath: t.dir });
    const f = domain.createFeature({ projectId: proj.id, name: '인증' });

    const adr = domain.logDecision({
      projectId: proj.id,
      title: 'OAuth2 사용',
      context: 'Google 로그인 필요',
    });
    expect(adr.id).toBe('ADR-0001');
    expect(domain.getDecision(adr.id)?.title).toBe('OAuth2 사용');

    const updated = domain.updateDecision(adr.id, {
      title: 'OAuth2 + PKCE 사용',
      decision: 'PKCE 플로우 채택',
      feature_id: f.id,
    });
    expect(updated?.title).toBe('OAuth2 + PKCE 사용');
    expect(updated?.decision).toBe('PKCE 플로우 채택');
    expect(updated?.feature_id).toBe(f.id);
    // Untouched fields preserved
    expect(updated?.context).toBe('Google 로그인 필요');

    // Empty patch is a no-op (returns current row)
    expect(domain.updateDecision(adr.id, {})?.title).toBe('OAuth2 + PKCE 사용');

    // Unknown id → null
    expect(domain.updateDecision('ADR-9999', { title: 'x' })).toBeNull();
    expect(domain.deleteDecision('ADR-9999')).toBe(false);

    expect(domain.deleteDecision(adr.id)).toBe(true);
    expect(domain.getDecision(adr.id)).toBeNull();
    expect(domain.listDecisions(proj.id)).toHaveLength(0);
  });
});

describe('feature_files', () => {
  it('linkFile + unlinkFile flow', () => {
    const proj = domain.createProject({ name: 'P1', rootPath: t.dir });
    const f = domain.createFeature({ projectId: proj.id, name: '기능 A' });

    domain.linkFile({ featureId: f.id, filePath: 'src/foo.ts', description: '주요 모듈' });
    domain.linkFile({ featureId: f.id, filePath: 'src/bar.ts' });
    expect(domain.listFeatureFiles(f.id)).toHaveLength(2);

    domain.unlinkFile(f.id, 'src/foo.ts');
    const remaining = domain.listFeatureFiles(f.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.file_path).toBe('src/bar.ts');

    // unlink on a path that's not linked is a silent no-op (idempotent)
    expect(() => domain.unlinkFile(f.id, 'never-linked.ts')).not.toThrow();
  });
});

describe('tasks', () => {
  it('addTask + updateTask + deleteTask flow', () => {
    const proj = domain.createProject({ name: 'P1', rootPath: t.dir });
    const f = domain.createFeature({ projectId: proj.id, name: '기능 A' });

    const t1 = domain.addTask(f.id, '태스크 1');
    const t2 = domain.addTask(f.id, '태스크 2');
    expect(domain.listTasks(f.id)).toHaveLength(2);

    const updated = domain.updateTask(t1.id, { status: 'done' });
    expect(updated?.status).toBe('done');
    expect(updated?.completed_at).toBeTypeOf('number');

    expect(domain.deleteTask(t2.id)).toBe(true);
    expect(domain.listTasks(f.id)).toHaveLength(1);
    expect(domain.listTasks(f.id)[0]!.id).toBe(t1.id);

    // deleting a non-existent task returns false (and doesn't throw)
    expect(domain.deleteTask(99999)).toBe(false);
  });

  it('reverting from done clears completed_at (regression: stale "X분 전 완료")', () => {
    const proj = domain.createProject({ name: 'P1', rootPath: t.dir });
    const f = domain.createFeature({ projectId: proj.id, name: '기능 A' });
    const tk = domain.addTask(f.id, '태스크');

    const done = domain.updateTask(tk.id, { status: 'done' });
    expect(done?.completed_at).toBeTypeOf('number');

    const reopened = domain.updateTask(tk.id, { status: 'todo' });
    expect(reopened?.status).toBe('todo');
    expect(reopened?.completed_at).toBeNull();

    // done → in_progress also clears
    domain.updateTask(tk.id, { status: 'done' });
    const inProg = domain.updateTask(tk.id, { status: 'in_progress' });
    expect(inProg?.completed_at).toBeNull();
  });
});

// (Removed in ADR-0016: describe block for listFilesNeedingExplanation — 5 tests.
// Code Map / AI file-explanation workflow retired.)

describe('sanitizeFtsQuery', () => {
  it('strips FTS5 metacharacters', () => {
    expect(sanitizeFtsQuery('"*^():+-')).toBe('');
  });

  it('strips ordinary punctuation that unicode61 treats as separators', () => {
    expect(sanitizeFtsQuery(';,!?.=<>|&%#@/')).toBe('');
  });

  it('returns empty for SQL-injection-shaped input', () => {
    expect(sanitizeFtsQuery('"; DROP TABLE features; --')).toBe('DROP* TABLE* features*');
    // Note: the result is harmless — it's matched as a 3-token MATCH clause
    // against indexed fields, and the parameterized query never lets it touch
    // the SQL surface area.
  });

  it('appends prefix * to each remaining token', () => {
    expect(sanitizeFtsQuery('foo bar')).toBe('foo* bar*');
  });

  it('handles Korean tokens and underscores', () => {
    expect(sanitizeFtsQuery('인증 모듈 feature_id')).toBe('인증* 모듈* feature_id*');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(sanitizeFtsQuery('   ')).toBe('');
  });

  it('drops control chars and combining marks but keeps the letters', () => {
    expect(sanitizeFtsQuery('foo\tbar\nbaz')).toBe('foo* bar* baz*');
  });
});

describe('searchProject', () => {
  it('returns [] for empty query', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    expect(domain.searchProject(proj.id, '')).toEqual([]);
  });

  it('returns [] for special-char-only query', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    expect(domain.searchProject(proj.id, '";--')).toEqual([]);
  });

  it('matches feature title via Korean prefix and wraps with <mark>', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    domain.createFeature({ projectId: proj.id, name: '사용자 인증 모듈' });
    domain.createFeature({ projectId: proj.id, name: '검색 기능' });

    const hits = domain.searchProject(proj.id, '인증');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe('feature');
    expect(hits[0]!.title).toBe('사용자 인증 모듈');
    expect(hits[0]!.snippet).toContain('<mark>인증</mark>');
  });

  it('escapes HTML in user content (XSS via name)', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    domain.createFeature({
      projectId: proj.id,
      name: '<script>alert(1)</script>findme',
    });
    const hits = domain.searchProject(proj.id, 'findme');
    expect(hits).toHaveLength(1);
    // Server-side HTML-escape: literal `<script>` must not survive into the
    // response. Only our own `<mark>` markers (via sentinel) make it through.
    expect(hits[0]!.title).not.toContain('<script>');
    expect(hits[0]!.title).toContain('&lt;script&gt;');
  });

  it("doesn't leak results across projects", () => {
    const a = domain.createProject({ name: 'A', rootPath: t.dir + '/a' });
    const b = domain.createProject({ name: 'B', rootPath: t.dir + '/b' });
    domain.createFeature({ projectId: a.id, name: '인증 (A)' });
    domain.createFeature({ projectId: b.id, name: '인증 (B)' });

    const aHits = domain.searchProject(a.id, '인증');
    expect(aHits).toHaveLength(1);
    expect(aHits[0]!.project_id).toBe(a.id);
    expect(aHits[0]!.title).toBe('인증 (A)');
  });

  it('respects the limit argument and clamps to 1..100', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    for (let i = 0; i < 5; i++) {
      domain.createFeature({ projectId: proj.id, name: `feature-${i} 인증` });
    }
    expect(domain.searchProject(proj.id, '인증', 3)).toHaveLength(3);
    // Negative / zero limit clamps to default min 1 (then SEARCH_LIMIT_DEFAULT
    // applies if Math.floor(limit) || DEFAULT). Either way: doesn't throw.
    expect(() => domain.searchProject(proj.id, '인증', 0)).not.toThrow();
    expect(() => domain.searchProject(proj.id, '인증', 99999)).not.toThrow();
  });

  it('title hits outrank body-only hits (column weight: title 3.0, body 1.0)', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    // Feature A: keyword in title only
    domain.createFeature({
      projectId: proj.id,
      name: 'authpipeline 모듈',
      goal: '관련 없는 설명',
    });
    // Feature B: keyword in body only (matches via goal/spec_md aggregation)
    domain.createFeature({
      projectId: proj.id,
      name: '관련 없는 이름',
      goal: 'authpipeline 흐름을 정리',
    });

    const hits = domain.searchProject(proj.id, 'authpipeline');
    expect(hits).toHaveLength(2);
    // First result must be the title-match feature.
    expect(hits[0]!.title).toBe('authpipeline 모듈');
  });

  it('feature outranks decision/session for the same content match (kind weight tiebreak)', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: proj.id, name: '인증' });
    domain.logDecision({ projectId: proj.id, title: '인증' });
    // Synthetic session with summary='인증' so it lands in FTS via the trigger.
    const db = getDb();
    const sid = `s-${Math.random().toString(36).slice(2, 10)}`;
    db.prepare(
      'INSERT INTO sessions (id, project_id, started_at, summary) VALUES (?, ?, ?, ?)',
    ).run(sid, proj.id, Date.now(), '인증');

    const hits = domain.searchProject(proj.id, '인증');
    // All three sources should match on title='인증'. With per-kind boosts
    // (feature=1.0 > decision=0.9 > session=0.6), feature must come first.
    const order = hits.map((h) => h.kind);
    expect(order.indexOf('feature')).toBeLessThan(order.indexOf('decision'));
    expect(order.indexOf('decision')).toBeLessThan(order.indexOf('session'));
    void f; // silence unused
  });

  // Regression for ADR-0016: even if a stray kind='file' row sneaks into
  // search_fts (e.g. a future bug re-adds the trigger), searchProject must
  // not surface it — the web client navigateToResult('file') is a no-op now,
  // and we'd rather catch the leak server-side.
  it("does not return kind='file' rows even when one is injected directly", () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    domain.createFeature({ projectId: proj.id, name: '인증 모듈' });
    const db = getDb();
    // Direct injection: bypass the (now-dropped) triggers entirely.
    db.prepare(
      `INSERT INTO search_fts (kind, ref_id, project_id, title, body)
       VALUES ('file', 'src/auth.ts', ?, '인증', 'auth module')`,
    ).run(proj.id);
    const hits = domain.searchProject(proj.id, '인증');
    expect(hits.every((h) => h.kind !== 'file')).toBe(true);
    // Sanity: the legitimate feature still surfaces.
    expect(hits.some((h) => h.kind === 'feature')).toBe(true);
  });
});
