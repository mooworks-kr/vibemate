import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as domain from '../domain.js';
import { createTempDb } from './helpers.js';

let t: ReturnType<typeof createTempDb>;

beforeEach(() => {
  t = createTempDb();
});

afterEach(() => {
  t.cleanup();
});

// Helper: seed a session against a feature so we can drive last_activity_at.
function seedSession(projectId: string, featureId: string, startedAt: number): void {
  const id = 's' + Math.random().toString(36).slice(2, 12).padEnd(11, '0');
  t.db.prepare(
    'INSERT INTO sessions (id, project_id, feature_id, started_at) VALUES (?, ?, ?, ?)',
  ).run(id, projectId, featureId, startedAt);
}

describe('listWorkspaceFeatures', () => {
  it('returns an empty array when no projects/features exist', () => {
    expect(domain.listWorkspaceFeatures()).toEqual([]);
  });

  it('defaults to in_progress only — todo / done / archived hidden', () => {
    const p = domain.createProject({ name: 'P1', rootPath: t.dir });
    domain.createFeature({ projectId: p.id, name: 'todo-feat' });
    domain.createFeature({ projectId: p.id, name: 'progress-feat', status: 'in_progress' });
    domain.createFeature({ projectId: p.id, name: 'done-feat', status: 'done' });
    domain.createFeature({ projectId: p.id, name: 'archived-feat', status: 'archived' });

    const rows = domain.listWorkspaceFeatures();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.feature_name).toBe('progress-feat');
    expect(rows[0]!.status).toBe('in_progress');
    expect(rows[0]!.project_name).toBe('P1');
  });

  it('respects an explicit statuses filter (union semantics)', () => {
    const p = domain.createProject({ name: 'P', rootPath: t.dir });
    domain.createFeature({ projectId: p.id, name: 'A' }); // todo
    domain.createFeature({ projectId: p.id, name: 'B', status: 'in_progress' });
    domain.createFeature({ projectId: p.id, name: 'C', status: 'done' });

    const rows = domain.listWorkspaceFeatures({ statuses: ['todo', 'done'] });
    expect(rows.map((r) => r.feature_name).sort()).toEqual(['A', 'C']);
  });

  it('falls back to default when an unknown status is passed', () => {
    const p = domain.createProject({ name: 'P', rootPath: t.dir });
    domain.createFeature({ projectId: p.id, name: 'A', status: 'in_progress' });

    // 'bogus' filtered out → empty → default in_progress kicks in.
    const rows = domain.listWorkspaceFeatures({
      statuses: ['bogus' as unknown as 'in_progress'],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.feature_name).toBe('A');
  });

  it('sorts by last_activity_at DESC, NULLs last, then updated_at DESC', () => {
    const p = domain.createProject({ name: 'P', rootPath: t.dir });
    const a = domain.createFeature({ projectId: p.id, name: 'A', status: 'in_progress' });
    const b = domain.createFeature({ projectId: p.id, name: 'B', status: 'in_progress' });
    const c = domain.createFeature({ projectId: p.id, name: 'C', status: 'in_progress' });
    // A: old session, B: newest session, C: no sessions
    seedSession(p.id, a.id, 1_700_000_000_000);
    seedSession(p.id, b.id, 1_700_000_500_000);

    const rows = domain.listWorkspaceFeatures();
    expect(rows.map((r) => r.feature_name)).toEqual(['B', 'A', 'C']);
    expect(rows[0]!.last_activity_at).toBe(1_700_000_500_000);
    expect(rows[2]!.last_activity_at).toBeNull();
  });

  it('returns features from multiple projects and joins the right project_name', () => {
    const p1 = domain.createProject({ name: 'pokepoke', rootPath: t.dir + '/a' });
    const p2 = domain.createProject({ name: 'arkham_like', rootPath: t.dir + '/b' });
    domain.createFeature({ projectId: p1.id, name: 'authflow', status: 'in_progress' });
    domain.createFeature({ projectId: p2.id, name: 'milestone-37', status: 'in_progress' });

    const rows = domain.listWorkspaceFeatures();
    const byFeature = Object.fromEntries(rows.map((r) => [r.feature_name, r.project_name]));
    expect(byFeature).toEqual({
      'authflow': 'pokepoke',
      'milestone-37': 'arkham_like',
    });
  });

  it('computes progress correctly (done / total) and reports task counts', () => {
    const p = domain.createProject({ name: 'P', rootPath: t.dir });
    const f = domain.createFeature({ projectId: p.id, name: 'F', status: 'in_progress' });
    const t1 = domain.addTask(f.id, 't1');
    const t2 = domain.addTask(f.id, 't2');
    domain.addTask(f.id, 't3');
    domain.updateTask(t1.id, { status: 'done' });
    domain.updateTask(t2.id, { status: 'done' });

    const row = domain.listWorkspaceFeatures()[0]!;
    expect(row.tasks_done).toBe(2);
    expect(row.tasks_todo).toBe(1);
    expect(row.progress).toBe(67); // 2/3 → 67%
  });

  it('reports progress=0 when the feature has no tasks (no division by zero)', () => {
    const p = domain.createProject({ name: 'P', rootPath: t.dir });
    domain.createFeature({ projectId: p.id, name: 'empty', status: 'in_progress' });

    const row = domain.listWorkspaceFeatures()[0]!;
    expect(row.progress).toBe(0);
    expect(row.tasks_done).toBe(0);
    expect(row.tasks_todo).toBe(0);
  });

  it('clamps limit to [1, 200]', () => {
    const p = domain.createProject({ name: 'P', rootPath: t.dir });
    for (let i = 0; i < 5; i++) {
      domain.createFeature({ projectId: p.id, name: `F${i}`, status: 'in_progress' });
    }
    expect(domain.listWorkspaceFeatures({ limit: 2 })).toHaveLength(2);
    // 0 / negative → clamp to 1.
    expect(domain.listWorkspaceFeatures({ limit: 0 })).toHaveLength(1);
    expect(domain.listWorkspaceFeatures({ limit: -10 })).toHaveLength(1);
    // Above MAX → clamp down (doesn't throw, doesn't crash).
    expect(() => domain.listWorkspaceFeatures({ limit: 999_999 })).not.toThrow();
  });
});
