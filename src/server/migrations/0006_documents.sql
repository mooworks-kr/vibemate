-- 0006_documents (Sprint 22, 3wtr Spec Hub).
--
-- Adds a free-form documents store + M:N mapping to features + FTS5 triggers
-- so docs surface in global search (kind='document'). No backfill — existing
-- features.spec_md inline content stays where it is; documents.feature_spec
-- is the *external* long-form sibling (per spec_md, both coexist).
--
-- Schema parity with existing tables:
--   * 4-char TEXT id (decisions/features pattern, allocated by domain.makeSlug)
--   * project_id FK with ON DELETE CASCADE
--   * (created_at, updated_at) integer ms — Date.now() convention
--   * CHECK constraint enforces kind enum at the DB layer (cheap safety net)

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (
    kind IN ('prd','planning','architecture','retro','feature_spec','other')
  ),
  title       TEXT NOT NULL,
  content_md  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- One index for "list all docs in a project, newest first" (the Docs tab
-- default) and a second for "filter by kind within a project" (kind-group
-- rendering / pm_list_documents(kind=...)).
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_kind    ON documents(project_id, kind);

-- M:N join table for document↔feature linkage. Composite PK prevents
-- duplicate links; the reverse index speeds "all docs for this feature"
-- (feature detail panel + listDocumentsForFeature).
CREATE TABLE IF NOT EXISTS document_features (
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  feature_id   TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (document_id, feature_id)
);
CREATE INDEX IF NOT EXISTS idx_document_features_feature ON document_features(feature_id);

-- ============================================================
-- search_fts triggers — title + content_md feed the FTS5 index under
-- kind='document'. Same row-replace pattern as features/decisions/sessions
-- from 0002. AFTER UPDATE only fires when the indexed columns change so
-- timestamp-only updates don't churn the FTS index.
-- ============================================================
CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO search_fts (kind, ref_id, project_id, title, body) VALUES (
    'document', NEW.id, NEW.project_id, NEW.title, NEW.content_md
  );
END;

CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE OF title, content_md ON documents BEGIN
  DELETE FROM search_fts
    WHERE kind = 'document' AND ref_id = OLD.id AND project_id = OLD.project_id;
  INSERT INTO search_fts (kind, ref_id, project_id, title, body) VALUES (
    'document', NEW.id, NEW.project_id, NEW.title, NEW.content_md
  );
END;

CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  DELETE FROM search_fts
    WHERE kind = 'document' AND ref_id = OLD.id AND project_id = OLD.project_id;
END;
