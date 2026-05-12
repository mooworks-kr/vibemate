import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as domain from '../domain.js';
import { getDb } from '../db.js';
import { createTempDb } from './helpers.js';

// Sprint 23 (h5uk) — getSessionDetail + getContext.last_session coverage.
// Each test seeds the minimal row set for the branch it exercises.

let t: ReturnType<typeof createTempDb>;
beforeEach(() => { t = createTempDb(); });
afterEach(() => { t.cleanup(); });

const HOUR = 60 * 60 * 1000;

/** Insert a fully-formed session directly (bypassing start/end) so tests
 *  can control feature_id / started_at / ended_at / notes precisely. */
function insertSession(args: {
  projectId: string;
  featureId?: string | null;
  startedAt: number;
  endedAt?: number | null;
  summary?: string | null;
  notes?: string | null;
}): string {
  const id = `s-${Math.random().toString(36).slice(2, 10)}`;
  getDb()
    .prepare(
      `INSERT INTO sessions (id, project_id, feature_id, started_at, ended_at, summary, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.projectId,
      args.featureId ?? null,
      args.startedAt,
      args.endedAt ?? null,
      args.summary ?? null,
      args.notes ?? null,
    );
  return id;
}

describe('getSessionDetail', () => {
  it('returns the session with joined feature_name + labeled timestamps', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: project.id, name: '결제' });
    const sid = insertSession({
      projectId: project.id,
      featureId: f.id,
      startedAt: Date.now() - 2 * HOUR,
      endedAt: Date.now() - 1 * HOUR,
      summary: '결제 흐름 작성',
      notes: '## 완료\n- A\n## 남은 일\n- B',
    });
    const detail = domain.getSessionDetail(sid);
    expect(detail.id).toBe(sid);
    expect(detail.feature_name).toBe('결제');
    expect(detail.summary).toBe('결제 흐름 작성');
    expect(detail.notes).toContain('## 완료');
    expect(detail.started_at_label).toBeTruthy();
    expect(detail.ended_at_label).toBeTruthy();
  });

  it('returns session_files with edit_type (Sprint 21 / ADR-0019 surface)', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const sid = insertSession({
      projectId: project.id,
      startedAt: Date.now() - HOUR,
      endedAt: Date.now(),
      summary: 's',
    });
    const db = getDb();
    db.prepare(`INSERT INTO session_files (session_id, file_path, edit_type) VALUES (?, ?, 'modified')`).run(sid, 'src/a.ts');
    db.prepare(`INSERT INTO session_files (session_id, file_path, edit_type) VALUES (?, ?, 'created')`).run(sid, 'src/b.ts');

    const detail = domain.getSessionDetail(sid);
    expect(detail.files).toHaveLength(2);
    const byPath = Object.fromEntries(detail.files.map((f) => [f.file_path, f.edit_type]));
    expect(byPath['src/a.ts']).toBe('modified');
    expect(byPath['src/b.ts']).toBe('created');
  });

  it('throws on unknown session id (matches getContext convention)', () => {
    expect(() => domain.getSessionDetail('no-such-session')).toThrow(/Session not found/);
  });

  it('exposes prev/next siblings within the same feature, ordered by started_at', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: project.id, name: 'F' });
    const base = Date.now() - 5 * HOUR;
    const s1 = insertSession({ projectId: project.id, featureId: f.id, startedAt: base + 0 * HOUR, summary: 'first' });
    const s2 = insertSession({ projectId: project.id, featureId: f.id, startedAt: base + 1 * HOUR, summary: 'middle' });
    const s3 = insertSession({ projectId: project.id, featureId: f.id, startedAt: base + 2 * HOUR, summary: 'last' });

    const middle = domain.getSessionDetail(s2);
    expect(middle.prev_session?.id).toBe(s1);
    expect(middle.next_session?.id).toBe(s3);

    const first = domain.getSessionDetail(s1);
    expect(first.prev_session).toBeNull();
    expect(first.next_session?.id).toBe(s2);

    const last = domain.getSessionDetail(s3);
    expect(last.prev_session?.id).toBe(s2);
    expect(last.next_session).toBeNull();
  });

  it('returns null prev/next for an orphan session (feature_id is null)', () => {
    // Sessions from `pm import-history` without a matched feature commonly
    // land in this bucket. There's no sibling axis to walk.
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const sid = insertSession({
      projectId: project.id,
      featureId: null,
      startedAt: Date.now() - HOUR,
      endedAt: Date.now(),
      summary: 'orphan',
    });
    const detail = domain.getSessionDetail(sid);
    expect(detail.prev_session).toBeNull();
    expect(detail.next_session).toBeNull();
  });

  it("skips sessions without a summary when walking prev/next (matches listSessions filter)", () => {
    // listSessions already filters `summary IS NOT NULL` — sessions that
    // were started but never ended (or are silent imports) shouldn't show
    // up as siblings, otherwise the UI nav would jump to empty rows.
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: project.id, name: 'F' });
    const base = Date.now() - 4 * HOUR;
    const real1 = insertSession({ projectId: project.id, featureId: f.id, startedAt: base + 0, summary: 'real-1' });
    insertSession({ projectId: project.id, featureId: f.id, startedAt: base + 1 * HOUR, summary: null });
    const real2 = insertSession({ projectId: project.id, featureId: f.id, startedAt: base + 2 * HOUR, summary: 'real-2' });

    const detail = domain.getSessionDetail(real2);
    expect(detail.prev_session?.id).toBe(real1);
  });
});

describe('getContext.last_session (Sprint 23)', () => {
  it('returns the most-recently-ended session attached to the active feature', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: project.id, name: 'F', status: 'in_progress' });
    const base = Date.now() - 10 * HOUR;
    insertSession({ projectId: project.id, featureId: f.id, startedAt: base, endedAt: base + 30 * 60 * 1000, summary: '먼저', notes: 'old notes' });
    const newer = insertSession({
      projectId: project.id, featureId: f.id,
      startedAt: base + 5 * HOUR, endedAt: base + 5 * HOUR + 60 * 60 * 1000,
      summary: '나중',
      notes: '## 완료\n- 분할\n## 남은 일\n- 통합',
    });

    const ctx = domain.getContext(project.id);
    expect(ctx.last_session).not.toBeNull();
    expect(ctx.last_session!.id).toBe(newer);
    expect(ctx.last_session!.summary).toBe('나중');
    expect(ctx.last_session!.notes_excerpt).toContain('## 완료');
  });

  it("returns null when there's no active feature", () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const ctx = domain.getContext(project.id);
    expect(ctx.active_feature).toBeNull();
    expect(ctx.last_session).toBeNull();
  });

  it("returns null when the active feature has no ended sessions yet", () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: project.id, name: 'F' });
    // Open session — ended_at NULL — must not surface as last_session.
    insertSession({ projectId: project.id, featureId: f.id, startedAt: Date.now(), endedAt: null, summary: 'open' });

    const ctx = domain.getContext(project.id, undefined, f.id);
    expect(ctx.last_session).toBeNull();
  });

  it('truncates notes_excerpt to 200 chars with a trailing ellipsis', () => {
    const project = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: project.id, name: 'F' });
    insertSession({
      projectId: project.id, featureId: f.id,
      startedAt: Date.now() - HOUR, endedAt: Date.now(),
      summary: 's',
      notes: 'x'.repeat(500),
    });
    const ctx = domain.getContext(project.id, undefined, f.id);
    expect(ctx.last_session!.notes_excerpt.length).toBeLessThanOrEqual(201);
    expect(ctx.last_session!.notes_excerpt.endsWith('…')).toBe(true);
  });
});
