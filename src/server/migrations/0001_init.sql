-- 0001_init: baseline schema. Equivalent to the old SCHEMA constant in db.ts.
-- Connection PRAGMAs (journal_mode/foreign_keys/synchronous) live in db.ts —
-- they're per-connection (or one-time persistent) and don't belong in a
-- transactional migration body.

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  tagline     TEXT,
  goal        TEXT,
  root_path   TEXT NOT NULL UNIQUE,
  tech        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS features (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  goal        TEXT,
  spec_md     TEXT,
  status      TEXT NOT NULL CHECK (status IN ('todo','in_progress','done','archived')),
  priority    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_id   TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('todo','in_progress','done')),
  position     INTEGER NOT NULL DEFAULT 0,
  notes        TEXT,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS decisions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  feature_id    TEXT REFERENCES features(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  context       TEXT,
  decision      TEXT,
  alternatives  TEXT,
  consequences  TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  feature_id  TEXT REFERENCES features(id) ON DELETE SET NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  summary     TEXT,
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS session_files (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,
  edit_type   TEXT NOT NULL CHECK (edit_type IN ('created','modified','read')),
  PRIMARY KEY (session_id, file_path)
);

CREATE TABLE IF NOT EXISTS feature_files (
  feature_id      TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  file_path       TEXT NOT NULL,
  description     TEXT,
  confidence      REAL NOT NULL DEFAULT 1.0,
  source          TEXT NOT NULL CHECK (source IN ('manual','auto','confirmed')),
  last_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (feature_id, file_path)
);

CREATE TABLE IF NOT EXISTS file_explanations (
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  explanation   TEXT NOT NULL,
  generated_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_features_project_status ON features(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_feature_status   ON tasks(feature_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_project       ON sessions(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_files_path     ON session_files(file_path);
CREATE INDEX IF NOT EXISTS idx_feature_files_path     ON feature_files(file_path);
CREATE INDEX IF NOT EXISTS idx_decisions_project      ON decisions(project_id, created_at DESC);
