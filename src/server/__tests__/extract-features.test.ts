import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as domain from '../domain.js';
import {
  CONVENTIONAL_TYPES,
  extractFeaturesFromCommits,
  parseConventionalCommit,
} from '../extract-features.js';
import { createTempDb } from './helpers.js';

let t: ReturnType<typeof createTempDb>;

beforeEach(() => {
  t = createTempDb();
});

afterEach(() => {
  t.cleanup();
});

describe('parseConventionalCommit', () => {
  it('parses type-only headers', () => {
    expect(parseConventionalCommit('feat: 한국어 메시지')).toEqual({
      type: 'feat', scope: null, breaking: false, subject: '한국어 메시지',
    });
  });

  it('parses type + scope', () => {
    expect(parseConventionalCommit('feat(auth): wired up SMS')).toEqual({
      type: 'feat', scope: 'auth', breaking: false, subject: 'wired up SMS',
    });
  });

  it('parses scopes that contain dots and slashes', () => {
    expect(parseConventionalCommit('fix(auth.oauth): refresh token')!.scope).toBe('auth.oauth');
    expect(parseConventionalCommit('refactor(api/users): rename')!.scope).toBe('api/users');
  });

  it('captures breaking-change marker `!`', () => {
    expect(parseConventionalCommit('feat!: drop legacy SDK')!.breaking).toBe(true);
    expect(parseConventionalCommit('feat(auth)!: rotate keys')!.breaking).toBe(true);
    expect(parseConventionalCommit('feat: nope')!.breaking).toBe(false);
  });

  it('returns null on non-conventional headers', () => {
    expect(parseConventionalCommit("Merge branch 'main'")).toBeNull();
    expect(parseConventionalCommit('WIP — auth flow')).toBeNull();
    expect(parseConventionalCommit('')).toBeNull();
  });

  it("doesn't constrain the type to a known whitelist (caller's job)", () => {
    // The parser accepts any [a-z]+ — type filtering is done one layer up so
    // unusual prefixes ('init:', 'wip:') are visible to a more permissive
    // caller without changing this regex.
    expect(parseConventionalCommit('init: a.js 추가')).toEqual({
      type: 'init', scope: null, breaking: false, subject: 'a.js 추가',
    });
  });
});

describe('extractFeaturesFromCommits', () => {
  // Helper: insert a session directly so we don't need git on the path.
  function seedSession(projectId: string, summary: string, t0 = Date.now()): string {
    const id = 's' + Math.random().toString(36).slice(2, 12).padEnd(11, '0');
    t.db.prepare(
      'INSERT INTO sessions (id, project_id, started_at, summary) VALUES (?, ?, ?, ?)',
    ).run(id, projectId, t0, summary);
    return id;
  }

  it('groups conventional commits by (type, scope) and creates features', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    seedSession(proj.id, 'feat(auth): SMS provider');
    seedSession(proj.id, 'feat(auth): email magic link');
    seedSession(proj.id, 'fix(billing): refund flow');
    seedSession(proj.id, 'fix(billing): tax rounding');

    const r = extractFeaturesFromCommits(proj.id, { minCount: 2 });
    expect(r.created).toBe(2);
    expect(r.merged).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.sessionsBackfilled).toBe(4);

    const groups = r.groups.filter((g) => g.applied);
    expect(groups.map((g) => g.signature).sort()).toEqual(['feat:auth', 'fix:billing']);

    // Both features exist in DB with the scope as their name.
    const features = domain.listFeatures(proj.id);
    const names = features.map((f) => f.name).sort();
    expect(names).toEqual(['auth', 'billing']);

    // Sessions point at the right feature.
    const authFeature = features.find((f) => f.name === 'auth')!;
    const linked = t.db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE feature_id = ?')
      .get(authFeature.id) as { n: number };
    expect(linked.n).toBe(2);
  });

  it('respects minCount: groups under threshold report under-threshold and do not write', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    seedSession(proj.id, 'feat(auth): solo commit');
    seedSession(proj.id, 'feat(billing): another solo');

    const r = extractFeaturesFromCommits(proj.id, { minCount: 2 });
    expect(r.created).toBe(0);
    expect(r.sessionsBackfilled).toBe(0);
    expect(r.groups.every((g) => g.outcome === 'under-threshold')).toBe(true);
    expect(domain.listFeatures(proj.id)).toHaveLength(0);
  });

  it('skips scope-less commits by default and includes them when includeUntyped=true', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    seedSession(proj.id, 'feat: A');
    seedSession(proj.id, 'feat: B');
    seedSession(proj.id, 'feat: C');

    // Default → ignore scope-less.
    const skip = extractFeaturesFromCommits(proj.id, { minCount: 2 });
    expect(skip.created).toBe(0);
    expect(skip.groups).toHaveLength(0);

    // includeUntyped → bucket by type alone.
    const include = extractFeaturesFromCommits(proj.id, { minCount: 2, includeUntyped: true });
    expect(include.created).toBe(1);
    const f = domain.listFeatures(proj.id);
    expect(f).toHaveLength(1);
    expect(f[0]!.name).toBe('feat');
  });

  it('honours an allowTypes whitelist (other types ignored even if scoped)', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    seedSession(proj.id, 'feat(auth): a');
    seedSession(proj.id, 'feat(auth): b');
    seedSession(proj.id, 'chore(deps): c');
    seedSession(proj.id, 'chore(deps): d');

    const r = extractFeaturesFromCommits(proj.id, { minCount: 2, allowTypes: ['feat'] });
    expect(r.created).toBe(1);
    expect(domain.listFeatures(proj.id).map((f) => f.name)).toEqual(['auth']);
  });

  it('is idempotent: a second run on the same data writes nothing new', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    seedSession(proj.id, 'feat(auth): a');
    seedSession(proj.id, 'feat(auth): b');

    const first = extractFeaturesFromCommits(proj.id, { minCount: 2 });
    expect(first.created).toBe(1);
    expect(first.sessionsBackfilled).toBe(2);

    const second = extractFeaturesFromCommits(proj.id, { minCount: 2 });
    // Marker hit → skipped. Sessions already mapped → backfill is a no-op.
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.sessionsBackfilled).toBe(0);
    expect(domain.listFeatures(proj.id)).toHaveLength(1);
  });

  it('merges into an existing feature with the same name (case-insensitive)', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    // User created the feature manually first.
    const manual = domain.createFeature({ projectId: proj.id, name: 'Auth' });
    seedSession(proj.id, 'feat(auth): a');
    seedSession(proj.id, 'feat(auth): b');

    const r = extractFeaturesFromCommits(proj.id, { minCount: 2 });
    expect(r.created).toBe(0);
    expect(r.merged).toBe(1);
    // Sessions backfill into the user's manual feature, not a new one.
    expect(domain.listFeatures(proj.id)).toHaveLength(1);
    const linked = t.db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE feature_id = ?')
      .get(manual.id) as { n: number };
    expect(linked.n).toBe(2);
  });

  it('preserves sessions already mapped to other features (no overwrite)', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    const other = domain.createFeature({ projectId: proj.id, name: 'OtherFeature' });

    const a = (() => {
      const id = 'sxxxxxxxxxxx';
      t.db.prepare(
        'INSERT INTO sessions (id, project_id, feature_id, started_at, summary) VALUES (?, ?, ?, ?, ?)',
      ).run(id, proj.id, other.id, Date.now(), 'feat(auth): pre-mapped');
      return id;
    })();
    // Two more not yet mapped.
    const b = (() => {
      const id = 'syyyyyyyyyyy';
      t.db.prepare(
        'INSERT INTO sessions (id, project_id, started_at, summary) VALUES (?, ?, ?, ?)',
      ).run(id, proj.id, Date.now(), 'feat(auth): unmapped 1');
      return id;
    })();
    const c = (() => {
      const id = 'szzzzzzzzzzz';
      t.db.prepare(
        'INSERT INTO sessions (id, project_id, started_at, summary) VALUES (?, ?, ?, ?)',
      ).run(id, proj.id, Date.now(), 'feat(auth): unmapped 2');
      return id;
    })();

    const r = extractFeaturesFromCommits(proj.id, { minCount: 2 });
    expect(r.created).toBe(1);
    // Backfill touches only the two NULL-feature_id sessions.
    expect(r.sessionsBackfilled).toBe(2);

    // The pre-mapped session keeps `other` as its feature.
    const aFeature = (t.db
      .prepare('SELECT feature_id FROM sessions WHERE id = ?')
      .get(a) as { feature_id: string }).feature_id;
    expect(aFeature).toBe(other.id);
    void b; void c;
  });

  it('dryRun reports outcome=dry-run for qualifying groups and writes nothing', () => {
    const proj = domain.createProject({ name: 'P', rootPath: t.dir });
    seedSession(proj.id, 'feat(auth): a');
    seedSession(proj.id, 'feat(auth): b');

    const r = extractFeaturesFromCommits(proj.id, { minCount: 2, dryRun: true });
    expect(r.created).toBe(0);
    expect(r.sessionsBackfilled).toBe(0);
    expect(r.groups[0]!.outcome).toBe('dry-run');
    expect(domain.listFeatures(proj.id)).toHaveLength(0);
  });

  it('exposes CONVENTIONAL_TYPES with the standard set', () => {
    expect(CONVENTIONAL_TYPES).toContain('feat');
    expect(CONVENTIONAL_TYPES).toContain('fix');
    expect(CONVENTIONAL_TYPES).not.toContain('init');
  });
});
