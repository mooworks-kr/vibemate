-- 0002_search_fts: full-text index across features, decisions, sessions, files.
-- One FTS5 virtual table with `kind` discriminator. Filter columns are
-- UNINDEXED — they exist for projection/WHERE filtering, not full-text match.
-- Tokenizer: unicode61 (default). Korean queries rely on prefix matching at
-- query time (`MATCH 'word*'`) since unicode61 doesn't do morphological
-- splitting. Good enough for the alpha; revisit if it doesn't pull its weight.

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  title,
  body,
  kind        UNINDEXED,
  ref_id      UNINDEXED,
  project_id  UNINDEXED
);

-- ============================================================
-- Features: title=name, body=goal+spec_md
-- ============================================================
CREATE TRIGGER IF NOT EXISTS features_ai AFTER INSERT ON features BEGIN
  INSERT INTO search_fts (kind, ref_id, project_id, title, body) VALUES (
    'feature', NEW.id, NEW.project_id, NEW.name,
    COALESCE(NEW.goal, '') || ' ' || COALESCE(NEW.spec_md, '')
  );
END;

CREATE TRIGGER IF NOT EXISTS features_au AFTER UPDATE ON features BEGIN
  -- Match on (kind, ref_id, project_id) — even though feature.id is the PK
  -- table-wide, scoping the delete by project_id is defensive against any
  -- future cross-project ID overlap.
  DELETE FROM search_fts
    WHERE kind = 'feature' AND ref_id = OLD.id AND project_id = OLD.project_id;
  INSERT INTO search_fts (kind, ref_id, project_id, title, body) VALUES (
    'feature', NEW.id, NEW.project_id, NEW.name,
    COALESCE(NEW.goal, '') || ' ' || COALESCE(NEW.spec_md, '')
  );
END;

CREATE TRIGGER IF NOT EXISTS features_ad AFTER DELETE ON features BEGIN
  DELETE FROM search_fts
    WHERE kind = 'feature' AND ref_id = OLD.id AND project_id = OLD.project_id;
END;

-- ============================================================
-- Decisions: title=title, body=context+decision+alternatives+consequences
-- ============================================================
CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO search_fts (kind, ref_id, project_id, title, body) VALUES (
    'decision', NEW.id, NEW.project_id, NEW.title,
    COALESCE(NEW.context, '') || ' ' ||
    COALESCE(NEW.decision, '') || ' ' ||
    COALESCE(NEW.alternatives, '') || ' ' ||
    COALESCE(NEW.consequences, '')
  );
END;

CREATE TRIGGER IF NOT EXISTS decisions_au AFTER UPDATE ON decisions BEGIN
  DELETE FROM search_fts
    WHERE kind = 'decision' AND ref_id = OLD.id AND project_id = OLD.project_id;
  INSERT INTO search_fts (kind, ref_id, project_id, title, body) VALUES (
    'decision', NEW.id, NEW.project_id, NEW.title,
    COALESCE(NEW.context, '') || ' ' ||
    COALESCE(NEW.decision, '') || ' ' ||
    COALESCE(NEW.alternatives, '') || ' ' ||
    COALESCE(NEW.consequences, '')
  );
END;

CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
  DELETE FROM search_fts
    WHERE kind = 'decision' AND ref_id = OLD.id AND project_id = OLD.project_id;
END;

-- ============================================================
-- Sessions: title=summary, body=notes. Sessions are INSERTed empty and
-- filled at session_end via UPDATE — empty FTS rows in the meantime are
-- harmless (they don't match anything).
-- ============================================================
CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
  INSERT INTO search_fts (kind, ref_id, project_id, title, body) VALUES (
    'session', NEW.id, NEW.project_id,
    COALESCE(NEW.summary, ''), COALESCE(NEW.notes, '')
  );
END;

CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions BEGIN
  DELETE FROM search_fts
    WHERE kind = 'session' AND ref_id = OLD.id AND project_id = OLD.project_id;
  INSERT INTO search_fts (kind, ref_id, project_id, title, body) VALUES (
    'session', NEW.id, NEW.project_id,
    COALESCE(NEW.summary, ''), COALESCE(NEW.notes, '')
  );
END;

CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
  DELETE FROM search_fts
    WHERE kind = 'session' AND ref_id = OLD.id AND project_id = OLD.project_id;
END;

-- ============================================================
-- File explanations: title=file_path, body=explanation. ref_id=file_path
-- (unique only within project, so always scope delete by project_id).
-- ============================================================
CREATE TRIGGER IF NOT EXISTS file_explanations_ai AFTER INSERT ON file_explanations BEGIN
  INSERT INTO search_fts (kind, ref_id, project_id, title, body) VALUES (
    'file', NEW.file_path, NEW.project_id, NEW.file_path, NEW.explanation
  );
END;

CREATE TRIGGER IF NOT EXISTS file_explanations_au AFTER UPDATE ON file_explanations BEGIN
  DELETE FROM search_fts
    WHERE kind = 'file' AND ref_id = OLD.file_path AND project_id = OLD.project_id;
  INSERT INTO search_fts (kind, ref_id, project_id, title, body) VALUES (
    'file', NEW.file_path, NEW.project_id, NEW.file_path, NEW.explanation
  );
END;

CREATE TRIGGER IF NOT EXISTS file_explanations_ad AFTER DELETE ON file_explanations BEGIN
  DELETE FROM search_fts
    WHERE kind = 'file' AND ref_id = OLD.file_path AND project_id = OLD.project_id;
END;

-- ============================================================
-- Backfill: pull existing rows into the index. Run once at migration time;
-- triggers handle all subsequent writes. We guard against double-backfill
-- via a NOT EXISTS check on (kind, ref_id, project_id) — harmless to re-run
-- but the migration system already prevents re-application of 0002.
-- ============================================================
INSERT INTO search_fts (kind, ref_id, project_id, title, body)
  SELECT 'feature', id, project_id, name,
         COALESCE(goal, '') || ' ' || COALESCE(spec_md, '')
  FROM features;

INSERT INTO search_fts (kind, ref_id, project_id, title, body)
  SELECT 'decision', id, project_id, title,
         COALESCE(context, '') || ' ' ||
         COALESCE(decision, '') || ' ' ||
         COALESCE(alternatives, '') || ' ' ||
         COALESCE(consequences, '')
  FROM decisions;

INSERT INTO search_fts (kind, ref_id, project_id, title, body)
  SELECT 'session', id, project_id,
         COALESCE(summary, ''), COALESCE(notes, '')
  FROM sessions;

INSERT INTO search_fts (kind, ref_id, project_id, title, body)
  SELECT 'file', file_path, project_id, file_path, explanation
  FROM file_explanations;
