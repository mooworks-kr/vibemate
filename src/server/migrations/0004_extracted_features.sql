-- 0004_extracted_features: idempotency table for `pm extract-features`.
--
-- Maps a (project_id, source_signature) pair to the feature row that was
-- created (or merged-into) by an extraction run. A repeat run sees the row
-- and skips re-creating the feature — but still backfills sessions, since
-- new commits may have arrived in the same scope.
--
-- source_signature schema: `<type>:<scope>` (e.g. `feat:auth`, `fix:billing`).
-- We don't enforce the format at the SQL layer — the domain function owns it
-- so the schema stays source-agnostic for future imports.
--
-- Cascade behaviour:
--   * project_id → projects.id ON DELETE CASCADE — wiping a project removes
--     its extraction markers along with everything else.
--   * feature_id → features.id ON DELETE CASCADE — when a user deletes the
--     feature row (manual cleanup), the marker also goes. A subsequent
--     extraction run would then re-create the feature, which is what we want
--     ("delete the feature to redo the extraction for that scope").

CREATE TABLE IF NOT EXISTS extracted_features (
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_signature  TEXT NOT NULL,
  feature_id        TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  extracted_at      INTEGER NOT NULL,
  PRIMARY KEY (project_id, source_signature)
);

-- Reverse lookup: given a feature, was it auto-extracted (and from which
-- signature)? Used by future "regenerate / unmerge" UX.
CREATE INDEX IF NOT EXISTS idx_extracted_features_feature ON extracted_features(feature_id);
