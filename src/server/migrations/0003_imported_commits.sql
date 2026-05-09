-- 0003_imported_commits: idempotency table for `pm import-history`.
--
-- Records the (project_id, commit_hash) pairs we've already imported so a
-- repeat invocation is a no-op. session_id points at the synthesised session
-- row in `sessions` so we can deduplicate rejoin / cleanup paths.
--
-- Cascade behaviour:
--   * project_id → projects.id ON DELETE CASCADE — wiping a project removes
--     its idempotency markers along with everything else.
--   * session_id → sessions.id ON DELETE CASCADE — if the synthesised session
--     is deleted (e.g. via a future `pm session delete` flow) we forget the
--     import too, so a re-import would create a fresh session.
--
-- Design notes (ADR pending):
--   * No `source_type` column. If we add another import source (notion,
--     jira, …) it gets its own table (`imported_<source>`) — keeps each
--     mapping table tight and source-specific.
--   * No `imported_by` / user — single-user tool. Add later if needed.

CREATE TABLE IF NOT EXISTS imported_commits (
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_hash  TEXT NOT NULL,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  imported_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, commit_hash)
);

-- Reverse lookup: given a session, was it imported (and if so, from which
-- commit)? Used by future cleanup / display features.
CREATE INDEX IF NOT EXISTS idx_imported_commits_session ON imported_commits(session_id);
