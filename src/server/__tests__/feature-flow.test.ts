import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as domain from '../domain.js';
import { getDb } from '../db.js';
import { createTempDb } from './helpers.js';

// Sprint 25 (feature-flow-map) — covers the two domain additions:
//   * listDecisionsForFeature  (T1: "관련 결정" surface)
//   * listFeatureFilesWithEditStats  (T2: "최근 수정 세션" indicator)

let t: ReturnType<typeof createTempDb>;

beforeEach(() => {
  t = createTempDb();
});

afterEach(() => {
  t.cleanup();
});

// Direct INSERT helper — domain.startSession/endSession are heavy and would
// drag in git-status side effects we don't want in these focused tests.
function insertSession(args: {
  projectId: string;
  featureId?: string | null;
  startedAt: number;
  files?: string[];
}): string {
  const id = `sess-${Math.random().toString(36).slice(2, 8)}`;
  getDb()
    .prepare(
      `INSERT INTO sessions (id, project_id, feature_id, started_at, summary)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, args.projectId, args.featureId ?? null, args.startedAt, 's');
  for (const fp of args.files ?? []) {
    getDb()
      .prepare(
        `INSERT INTO session_files (session_id, file_path, edit_type)
         VALUES (?, ?, 'modified')`,
      )
      .run(id, fp);
  }
  return id;
}

describe('listDecisionsForFeature (T1)', () => {
  it('returns ADRs linked to the feature in created_at DESC order', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: proj.id, name: '인증' });

    const a = domain.logDecision({
      projectId: proj.id,
      featureId: f.id,
      title: '첫 결정',
      context: 'a'.repeat(50),
    });
    // Force the second ADR to land strictly later in wall-clock terms so
    // ORDER BY created_at DESC is deterministic.
    const later = a.created_at + 1000;
    getDb()
      .prepare(
        `INSERT INTO decisions (id, project_id, feature_id, title, context, created_at)
         VALUES ('ADR-0002', ?, ?, '두번째 결정', '짧은 컨텍스트', ?)`,
      )
      .run(proj.id, f.id, later);

    const rows = domain.listDecisionsForFeature(f.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe('ADR-0002');
    expect(rows[0]!.title).toBe('두번째 결정');
    expect(rows[1]!.id).toBe(a.id);
  });

  it('excludes ADRs with NULL feature_id', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: proj.id, name: '기능 A' });

    domain.logDecision({ projectId: proj.id, featureId: f.id, title: '연결됨' });
    domain.logDecision({ projectId: proj.id, title: '연결 안 됨' }); // featureId omitted

    const rows = domain.listDecisionsForFeature(f.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('연결됨');
  });

  it('excludes ADRs linked to a different feature in the same project', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    const fa = domain.createFeature({ projectId: proj.id, name: 'A' });
    const fb = domain.createFeature({ projectId: proj.id, name: 'B' });

    domain.logDecision({ projectId: proj.id, featureId: fa.id, title: 'A 의 결정' });
    domain.logDecision({ projectId: proj.id, featureId: fb.id, title: 'B 의 결정' });

    const rowsA = domain.listDecisionsForFeature(fa.id);
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]!.title).toBe('A 의 결정');
  });

  it('truncates context to 80 chars with an ellipsis; empty context → empty excerpt', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: proj.id, name: '기능' });

    const longCtx = 'x'.repeat(120);
    const longAdr = domain.logDecision({
      projectId: proj.id,
      featureId: f.id,
      title: '긴 컨텍스트',
      context: longCtx,
    });
    const shortAdr = domain.logDecision({
      projectId: proj.id,
      featureId: f.id,
      title: '짧은 컨텍스트',
      context: 'hi',
    });
    domain.logDecision({
      projectId: proj.id,
      featureId: f.id,
      title: '컨텍스트 없음',
      // context omitted → stored as NULL
    });

    const rows = domain.listDecisionsForFeature(f.id);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[longAdr.id]!.context_excerpt).toBe('x'.repeat(80) + '…');
    expect(byId[shortAdr.id]!.context_excerpt).toBe('hi');
    // Decision without context should surface as empty string, not undefined.
    const noCtx = rows.find((r) => r.title === '컨텍스트 없음')!;
    expect(noCtx.context_excerpt).toBe('');
  });
});

describe('listFeatureFilesWithEditStats (T2)', () => {
  it('counts distinct sessions and points at the most recent for each file', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: proj.id, name: '기능' });
    domain.linkFile({ featureId: f.id, filePath: 'src/a.ts' });
    domain.linkFile({ featureId: f.id, filePath: 'src/b.ts' });

    const t0 = Date.now();
    insertSession({ projectId: proj.id, startedAt: t0 - 30_000, files: ['src/a.ts'] });
    insertSession({ projectId: proj.id, startedAt: t0 - 20_000, files: ['src/a.ts', 'src/b.ts'] });
    const latestId = insertSession({
      projectId: proj.id,
      startedAt: t0 - 10_000,
      files: ['src/a.ts'],
    });

    const rows = domain.listFeatureFilesWithEditStats(f.id);
    const byPath = Object.fromEntries(rows.map((r) => [r.file_path, r]));

    // a.ts edited in 3 sessions; latest pointer matches the newest started_at.
    expect(byPath['src/a.ts']!.edit_session_count).toBe(3);
    expect(byPath['src/a.ts']!.last_edited_session_id).toBe(latestId);
    expect(byPath['src/a.ts']!.last_edited_at).toBe(t0 - 10_000);

    // b.ts edited in only the middle session.
    expect(byPath['src/b.ts']!.edit_session_count).toBe(1);
    expect(byPath['src/b.ts']!.last_edited_at).toBe(t0 - 20_000);
  });

  it('returns 0 / null stats for files no session has touched', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: proj.id, name: '기능' });
    domain.linkFile({ featureId: f.id, filePath: 'src/untouched.ts' });

    const rows = domain.listFeatureFilesWithEditStats(f.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.edit_session_count).toBe(0);
    expect(rows[0]!.last_edited_session_id).toBeNull();
    expect(rows[0]!.last_edited_at).toBeNull();
  });

  it('ignores sessions from other projects even when the file_path collides', () => {
    const pa = domain.createProject({ name: 'A', rootPath: t.dir + '/a' });
    const pb = domain.createProject({ name: 'B', rootPath: t.dir + '/b' });
    const fa = domain.createFeature({ projectId: pa.id, name: 'fa' });
    domain.linkFile({ featureId: fa.id, filePath: 'src/shared.ts' });

    const t0 = Date.now();
    // Same path in project B — must not bleed into project A's counts.
    insertSession({ projectId: pb.id, startedAt: t0 - 5_000, files: ['src/shared.ts'] });
    const myId = insertSession({
      projectId: pa.id,
      startedAt: t0 - 1_000,
      files: ['src/shared.ts'],
    });

    const rows = domain.listFeatureFilesWithEditStats(fa.id);
    expect(rows[0]!.edit_session_count).toBe(1);
    expect(rows[0]!.last_edited_session_id).toBe(myId);
  });

  it('returns empty array when the feature has no linked files', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: proj.id, name: '빈 기능' });
    expect(domain.listFeatureFilesWithEditStats(f.id)).toEqual([]);
  });
});
