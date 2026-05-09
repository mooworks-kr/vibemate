import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir } from './lib.js';
import { runMigrations } from './migrations.js';

export type DB = DatabaseSync;

/** Run a function inside a SQLite transaction. Rolls back on throw. */
export function transact<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Per-connection (or one-time persistent) PRAGMAs. journal_mode=WAL is a
// persistent setting in the DB file but it's safe — and idempotent — to set
// on every open. foreign_keys/synchronous are per-connection and need to be
// reapplied each time we connect. None of these belong in a migration body
// because some PRAGMAs (notably journal_mode) can't be set inside a
// transaction.
const CONNECTION_PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
`;

let dbInstance: DB | null = null;

export function getDb(dbPath?: string): DB {
  if (dbInstance) return dbInstance;
  const finalPath = dbPath ?? path.join(defaultDataDir(), 'db.sqlite');
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const db = new DatabaseSync(finalPath);
  db.exec(CONNECTION_PRAGMAS);
  runMigrations(db);
  dbInstance = db;
  return db;
}

/** Reset for tests / restarts */
export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
