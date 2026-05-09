import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './db.js';

// Lightweight forward-only migration runner. Files live in ./migrations/ next
// to this module (both in src/ during dev and in dist/ in prod — the build
// step copies the .sql files over). Each file is `NNNN_description.sql`,
// applied in numeric order, one transaction per file.
//
// Why so plain: we don't need down-migrations, multi-tenant version skew, or
// concurrent runners. SQLite + single-process daemon. Anything fancier is a
// trap until proven otherwise.

const FILE_PATTERN = /^(\d{4})_.+\.sql$/;

function ensureMigrationsTable(db: DB): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );
}

function getAppliedVersions(db: DB): Set<number> {
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as {
    version: number;
  }[];
  return new Set(rows.map((r) => r.version));
}

/**
 * If schema_migrations is empty but the legacy schema is already in place
 * (`projects` table exists from the pre-migration `db.exec(SCHEMA)` era),
 * mark version 1 as applied so we don't try to re-run init on an existing DB.
 *
 * Picking `projects` as the witness is intentional: it's the root table that
 * everything else cascades from, so its presence is a reliable signal that
 * the 0001 baseline ran in some prior run.
 */
function baselineIfNeeded(db: DB): void {
  const applied = getAppliedVersions(db);
  if (applied.size > 0) return;

  const witness = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'")
    .get();
  if (!witness) return;

  db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
    1,
    new Date().toISOString(),
  );
}

function defaultMigrationsDir(): string {
  // Resolves to src/server/migrations/ in dev (tsx) and dist/server/migrations/
  // in prod. Keeping the layout symmetric is the simplest path-resolution.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
}

/**
 * Apply all pending migrations in version order.
 * Each file runs inside its own transaction; a failure rolls back that file
 * (but earlier files stay applied) and surfaces the error.
 */
export function runMigrations(db: DB, migrationsDir: string = defaultMigrationsDir()): void {
  ensureMigrationsTable(db);
  baselineIfNeeded(db);

  if (!fs.existsSync(migrationsDir)) return;

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => FILE_PATTERN.test(f))
    .sort();

  const applied = getAppliedVersions(db);

  for (const file of files) {
    const m = file.match(FILE_PATTERN)!;
    const version = Number(m[1]);
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      ).run(version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
}
