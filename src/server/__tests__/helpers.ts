import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { closeDb, getDb, type DB } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

/**
 * Spin up an isolated SQLite DB for one test. The temp file lives under
 * `os.tmpdir()/vibemate-test-<rand>/db.sqlite`. `getDb()` is a module-level
 * singleton — we close any prior instance, then prime it with the temp path
 * so subsequent `getDb()` calls (which domain.ts does without arguments)
 * return this same connection.
 *
 * Use with vitest's beforeEach/afterEach:
 *   let t: ReturnType<typeof createTempDb>;
 *   beforeEach(() => { t = createTempDb(); });
 *   afterEach(() => { t.cleanup(); });
 */
export function createTempDb(): { db: DB; dir: string; dbPath: string; cleanup: () => void } {
  // Reset the singleton in case a previous test left it bound.
  closeDb();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibemate-test-'));
  const dbPath = path.join(dir, 'db.sqlite');
  const db = getDb(dbPath);

  return {
    db,
    dir,
    dbPath,
    cleanup: () => {
      closeDb();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; if the OS still has a handle, leave it for tmp reaper.
      }
    },
  };
}

/**
 * Create a "legacy" DB containing only the 0001 init schema (no
 * schema_migrations table). Used to verify the migration runner's baseline
 * detection — it should mark version 1 as applied and only re-run 0002+.
 *
 * Returns the path; caller is responsible for cleanup. The DB connection
 * here is short-lived and closed before returning, so a subsequent
 * `getDb(dbPath)` opens it fresh.
 */
export function createLegacyDb(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibemate-legacy-'));
  const dbPath = path.join(dir, 'db.sqlite');
  const db = new DatabaseSync(dbPath);
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '0001_init.sql'), 'utf-8');
  db.exec(sql);
  db.close();
  return { dir, dbPath };
}
