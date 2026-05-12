import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as domain from '../domain.js';
import { getDb } from '../db.js';
import { createTempDb } from './helpers.js';

// Sprint 20 (u3zu): coverage for `getProjectOverview`. The shape is purely
// derived from existing tables (project/feature/task/session/decision), so
// each test seeds the minimal row set needed to trigger one branch.

let t: ReturnType<typeof createTempDb>;

beforeEach(() => {
  t = createTempDb();
});

afterEach(() => {
  t.cleanup();
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Helper: synthesise a session row directly. The public `startSession` /
// `endSession` flow would also work, but for status-recency tests we need
// to backdate `started_at` past the 2-week stale cutoff, which the public
// API doesn't allow.
function insertSession(
  projectId: string,
  startedAt: number,
  summary: string | null,
  featureId: string | null = null,
): string {
  const id = `s-${Math.random().toString(36).slice(2, 10)}`;
  getDb()
    .prepare(
      'INSERT INTO sessions (id, project_id, feature_id, started_at, summary) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, projectId, featureId, startedAt, summary);
  return id;
}

describe('getProjectOverview', () => {
  it('returns empty status with no features and no sessions', () => {
    const p = domain.createProject({ name: 'P', rootPath: t.dir });
    const ov = domain.getProjectOverview(p.id);
    expect(ov.status).toBe('empty');
    expect(ov.active_features).toEqual([]);
    expect(ov.next_task).toBeNull();
    expect(ov.last_activity_at).toBeNull();
    expect(ov.recent_sessions).toEqual([]);
    expect(ov.recent_decisions).toEqual([]);
    expect(ov.project.name).toBe('P');
    expect(ov.project.stats.total_features).toBe(0);
  });

  it('throws on unknown project id (matches getContext/setActiveFeature)', () => {
    expect(() => domain.getProjectOverview('nope')).toThrow(/Project not found/);
  });

  it("returns 'active' when there's an in_progress feature and recent activity", () => {
    const p = domain.createProject({ name: 'P', rootPath: t.dir });
    domain.createFeature({ projectId: p.id, name: 'Live', status: 'in_progress' });
    insertSession(p.id, Date.now() - 1 * HOUR, '최근 작업');

    const ov = domain.getProjectOverview(p.id);
    expect(ov.status).toBe('active');
    expect(ov.active_features.map((f) => f.name)).toEqual(['Live']);
    expect(ov.last_activity_at).not.toBeNull();
  });

  it("returns 'todo_only' when only todo features exist with recent activity", () => {
    const p = domain.createProject({ name: 'P', rootPath: t.dir });
    domain.createFeature({ projectId: p.id, name: 'NotStarted', status: 'todo' });
    insertSession(p.id, Date.now() - 1 * HOUR, '오늘');

    const ov = domain.getProjectOverview(p.id);
    expect(ov.status).toBe('todo_only');
  });

  it("returns 'stale' as the catch-all when every feature is done (no actionable work)", () => {
    // Real dogfood found this gap on arkham_like at Sprint 20 (27 done, 0
    // actionable). Under ADR-0018 the priority list is active > todo_only >
    // stale > empty; "all done, no follow-up" lands in stale because there's
    // nothing for the user to pick up next.
    const p = domain.createProject({ name: 'P', rootPath: t.dir });
    domain.createFeature({ projectId: p.id, name: 'Finished', status: 'done' });
    insertSession(p.id, Date.now() - 1 * HOUR, '오늘');

    const ov = domain.getProjectOverview(p.id);
    expect(ov.status).toBe('stale');
  });

  it("returns 'stale' when the last session is older than 2 weeks (wins over needs_review)", () => {
    const p = domain.createProject({ name: 'P', rootPath: t.dir });
    domain.createFeature({ projectId: p.id, name: 'OldTodo', status: 'todo' });
    insertSession(p.id, Date.now() - 30 * DAY, '오래된 세션');

    const ov = domain.getProjectOverview(p.id);
    expect(ov.status).toBe('stale');
  });

  it("returns 'stale' when features exist but no session ever recorded", () => {
    const p = domain.createProject({ name: 'P', rootPath: t.dir });
    domain.createFeature({ projectId: p.id, name: 'Untouched', status: 'in_progress' });

    const ov = domain.getProjectOverview(p.id);
    // No sessions → last_activity_at is null → counts as stale, even
    // with an in_progress feature. Matches the "you wrote a feature row
    // and never opened a session" pattern.
    expect(ov.status).toBe('stale');
    expect(ov.last_activity_at).toBeNull();
  });

  it('next_task points at the in_progress feature\'s first open task', () => {
    const p = domain.createProject({ name: 'P', rootPath: t.dir });
    const ip = domain.createFeature({ projectId: p.id, name: 'IP', status: 'in_progress' });
    domain.createFeature({ projectId: p.id, name: 'Other', status: 'todo' });
    const t1 = domain.addTask(ip.id, 'first task');
    domain.addTask(ip.id, 'second task');
    // Recent activity so we're not stale — keeps focus on the next_task assertion.
    insertSession(p.id, Date.now() - 1 * HOUR, 's');

    const ov = domain.getProjectOverview(p.id);
    expect(ov.next_task).not.toBeNull();
    expect(ov.next_task?.feature_id).toBe(ip.id);
    expect(ov.next_task?.feature_name).toBe('IP');
    expect(ov.next_task?.task_id).toBe(t1.id);
    expect(ov.next_task?.task_name).toBe('first task');
  });

  it('falls through to a todo feature\'s task when no in_progress feature has tasks', () => {
    const p = domain.createProject({ name: 'P', rootPath: t.dir });
    // in_progress feature has zero tasks → skipped by the next_task walk.
    domain.createFeature({ projectId: p.id, name: 'IP-empty', status: 'in_progress' });
    const todoF = domain.createFeature({ projectId: p.id, name: 'TodoFeat', status: 'todo' });
    const tk = domain.addTask(todoF.id, 'pick me');
    insertSession(p.id, Date.now() - 1 * HOUR, 's');

    const ov = domain.getProjectOverview(p.id);
    expect(ov.next_task?.feature_id).toBe(todoF.id);
    expect(ov.next_task?.task_id).toBe(tk.id);
  });

  it('recent_sessions are ordered DESC and limited to 5, with feature_name joined', () => {
    const p = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: p.id, name: 'F', status: 'in_progress' });
    const now = Date.now();
    // Insert 7 sessions; the helper assigns ascending start times by index.
    for (let i = 0; i < 7; i++) {
      insertSession(p.id, now - (7 - i) * HOUR, `session-${i}`, i % 2 === 0 ? f.id : null);
    }

    const ov = domain.getProjectOverview(p.id);
    expect(ov.recent_sessions).toHaveLength(5);
    // Newest first: 6, 5, 4, 3, 2.
    expect(ov.recent_sessions.map((s) => s.summary)).toEqual([
      'session-6', 'session-5', 'session-4', 'session-3', 'session-2',
    ]);
    // Joined name surfaces; null where session wasn't linked.
    expect(ov.recent_sessions[0]!.feature_name).toBe('F');
    expect(ov.recent_sessions[1]!.feature_name).toBeNull();
  });

  it('recent_decisions are ordered DESC and limited to 5, with feature_name joined', () => {
    const p = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: p.id, name: 'F', status: 'in_progress' });
    insertSession(p.id, Date.now() - 1 * HOUR, 's');
    // logDecision uses `now()` for every call, so a tight loop produces
    // identical timestamps and ORDER BY created_at DESC isn't deterministic.
    // Insert with explicit ascending created_at instead.
    const baseT = Date.now() - 1 * DAY;
    const db = getDb();
    for (let i = 0; i < 6; i++) {
      db.prepare(
        `INSERT INTO decisions (id, project_id, feature_id, title, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(`ADR-${100 + i}`, p.id, i % 2 === 0 ? f.id : null, `decision-${i}`, baseT + i * HOUR);
    }

    const ov = domain.getProjectOverview(p.id);
    expect(ov.recent_decisions).toHaveLength(5);
    // Newest first: decision-5 (highest created_at).
    expect(ov.recent_decisions[0]!.title).toBe('decision-5');
    // even-index ones (0, 2, 4) carry the feature_name; odd ones (1, 3, 5) null.
    expect(ov.recent_decisions[0]!.feature_name).toBeNull();
    expect(ov.recent_decisions[1]!.feature_name).toBe('F');
  });

  it('active_features keep the Sprint 19 sort: in_progress first, then todo', () => {
    const p = domain.createProject({ name: 'P', rootPath: t.dir });
    domain.createFeature({ projectId: p.id, name: 'TodoA', status: 'todo' });
    domain.createFeature({ projectId: p.id, name: 'IpA', status: 'in_progress' });
    insertSession(p.id, Date.now() - 1 * HOUR, 's');

    const ov = domain.getProjectOverview(p.id);
    expect(ov.active_features.map((f) => f.name)).toEqual(['IpA', 'TodoA']);
  });
});
