import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../db.js';
import { runMigrations } from '../migrations.js';
import { createLegacyDb, createTempDb } from './helpers.js';

describe('migrations runner — fresh DB', () => {
  let t: ReturnType<typeof createTempDb>;
  beforeEach(() => { t = createTempDb(); });
  afterEach(() => { t.cleanup(); });

  it('applies all migrations on first open', () => {
    const rows = t.db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as { version: number }[];
    const versions = rows.map((r) => r.version);
    // 0001_init + 0002_search_fts + 0003_imported_commits +
    // 0004_extracted_features + 0005_drop_file_explanations.
    // Bump as new migrations land.
    expect(versions).toContain(1);
    expect(versions).toContain(2);
    expect(versions).toContain(3);
    expect(versions).toContain(4);
    expect(versions).toContain(5);
  });

  it('creates the expected tables', () => {
    const tables = t.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = new Set(tables.map((r) => r.name));
    for (const expected of [
      'projects',
      'features',
      'tasks',
      'decisions',
      'sessions',
      'session_files',
      'feature_files',
      // file_explanations: created by 0001, dropped by 0005 — should NOT exist
      // on a fresh DB.
      'imported_commits',
      'extracted_features',
      'schema_migrations',
    ]) {
      expect(names.has(expected), `missing table: ${expected}`).toBe(true);
    }
    // Negative assertion: 0005 retired this one. Fresh installs must not see it.
    expect(names.has('file_explanations'), 'file_explanations should be dropped by 0005').toBe(false);
  });

  it('search_fts virtual table exists (from 0002)', () => {
    const row = t.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name = 'search_fts'",
      )
      .get();
    expect(row).toBeDefined();
  });

  it('three entity tables have INSERT/UPDATE/DELETE triggers feeding search_fts', () => {
    // After 0005: file_explanations triggers retired. 3 entities × 3 trigger
    // types = 9. If we ever add a new indexed entity, the trigger count is
    // the canonical place to assert against.
    const triggers = t.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = new Set(triggers.map((r) => r.name));
    for (const expected of [
      'features_ai', 'features_au', 'features_ad',
      'decisions_ai', 'decisions_au', 'decisions_ad',
      'sessions_ai', 'sessions_au', 'sessions_ad',
    ]) {
      expect(names.has(expected), `missing trigger: ${expected}`).toBe(true);
    }
    // Negative assertion: file_explanations_* dropped by 0005.
    for (const dropped of ['file_explanations_ai', 'file_explanations_au', 'file_explanations_ad']) {
      expect(names.has(dropped), `${dropped} should be dropped by 0005`).toBe(false);
    }
  });
});

describe('migrations runner — idempotent', () => {
  let t: ReturnType<typeof createTempDb>;
  beforeEach(() => { t = createTempDb(); });
  afterEach(() => { t.cleanup(); });

  it("doesn't re-apply migrations on a second runMigrations() call", () => {
    const before = t.db
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
      .get() as { n: number };

    // Run a second time on the same connection.
    runMigrations(t.db);

    const after = t.db
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
      .get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('reopening the DB file is idempotent (closeDb + getDb again)', () => {
    const before = t.db
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
      .get() as { n: number };

    closeDb();
    const db2 = getDb(t.dbPath);

    const after = db2
      .prepare('SELECT COUNT(*) AS n FROM schema_migrations')
      .get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});

describe('migrations runner — legacy baseline', () => {
  it('marks 0001 as baseline-applied when projects table already exists', () => {
    closeDb();
    const legacy = createLegacyDb();
    try {
      // Sanity: legacy file has projects but no schema_migrations yet.
      const probe = new DatabaseSync(legacy.dbPath);
      try {
        const beforeRow = probe
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='schema_migrations'",
          )
          .get();
        expect(beforeRow).toBeUndefined();
      } finally {
        probe.close();
      }

      // Boot the runner against the legacy file.
      const db = getDb(legacy.dbPath);
      const rows = db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as { version: number }[];
      const versions = rows.map((r) => r.version);
      // Baseline marker for v1, plus newly-applied v2 / v3 / v4 / v5.
      expect(versions).toEqual([1, 2, 3, 4, 5]);
    } finally {
      closeDb();
      try { fs.rmSync(legacy.dir, { recursive: true, force: true }); } catch {}
    }
  });
});
