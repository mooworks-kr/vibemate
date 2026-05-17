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
    // 0004_extracted_features + 0005_drop_file_explanations +
    // 0006_documents + 0007_documents_au_trigger_fix. Bump as new
    // migrations land.
    expect(versions).toContain(1);
    expect(versions).toContain(2);
    expect(versions).toContain(3);
    expect(versions).toContain(4);
    expect(versions).toContain(5);
    expect(versions).toContain(6);
    expect(versions).toContain(7);
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
      // 0006 (Sprint 22): Spec Hub documents + M:N feature link.
      'documents',
      'document_features',
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

  it('four entity tables have INSERT/UPDATE/DELETE triggers feeding search_fts', () => {
    // After 0005: file_explanations triggers retired.
    // After 0006: documents triggers added. 4 entities × 3 trigger types = 12.
    // If we ever add a new indexed entity, the trigger count is the canonical
    // place to assert against.
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
      // 0006 (Sprint 22, Spec Hub):
      'documents_ai', 'documents_au', 'documents_ad',
    ]) {
      expect(names.has(expected), `missing trigger: ${expected}`).toBe(true);
    }
    // Negative assertion: file_explanations_* dropped by 0005.
    for (const dropped of ['file_explanations_ai', 'file_explanations_au', 'file_explanations_ad']) {
      expect(names.has(dropped), `${dropped} should be dropped by 0005`).toBe(false);
    }
  });
});

describe('migrations runner — documents_au trigger (0007)', () => {
  let t: ReturnType<typeof createTempDb>;
  beforeEach(() => { t = createTempDb(); });
  afterEach(() => { t.cleanup(); });

  it('updates search_fts.project_id when documents.project_id is reassigned', () => {
    // Seed two projects + one document under the first.
    const now = Date.now();
    const insertProject = t.db.prepare(
      `INSERT INTO projects (id, name, root_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insertProject.run('proj_src', 'Source', '/tmp/proj-src', now, now);
    insertProject.run('proj_dst', 'Destination', '/tmp/proj-dst', now, now);
    t.db
      .prepare(
        `INSERT INTO documents
           (id, project_id, kind, title, content_md, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('doc1', 'proj_src', 'other', 'Title', 'body', now, now);

    const before = t.db
      .prepare("SELECT project_id FROM search_fts WHERE kind='document' AND ref_id=?")
      .get('doc1') as { project_id: string } | undefined;
    expect(before?.project_id).toBe('proj_src');

    // Reassign to another project — the 0006 trigger missed this because it
    // was scoped to (title, content_md) only.
    t.db
      .prepare('UPDATE documents SET project_id = ? WHERE id = ?')
      .run('proj_dst', 'doc1');

    const after = t.db
      .prepare("SELECT project_id FROM search_fts WHERE kind='document' AND ref_id=?")
      .get('doc1') as { project_id: string } | undefined;
    expect(after?.project_id).toBe('proj_dst');

    // And exactly one FTS row remains for this document.
    const count = t.db
      .prepare("SELECT COUNT(*) AS n FROM search_fts WHERE kind='document' AND ref_id=?")
      .get('doc1') as { n: number };
    expect(count.n).toBe(1);
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
      // Baseline marker for v1, plus newly-applied v2..v7.
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7]);
    } finally {
      closeDb();
      try { fs.rmSync(legacy.dir, { recursive: true, force: true }); } catch {}
    }
  });
});
