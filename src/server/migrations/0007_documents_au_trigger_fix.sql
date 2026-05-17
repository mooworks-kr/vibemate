-- 0007_documents_au_trigger_fix: stop documents.project_id reassignments
-- from leaving search_fts.project_id stale.
--
-- Bug: 0006's `documents_au` was scoped `AFTER UPDATE OF title, content_md`,
-- so an `UPDATE documents SET project_id = ?` would not fire the trigger and
-- the FTS index kept the old project_id (UNINDEXED). Cross-project moves
-- (e.g. streamshub → 9wvc, 2026-05-17) then leaked into search results
-- scoped to the destination project.
--
-- Fix: drop the column-qualified trigger and recreate it as `AFTER UPDATE ON
-- documents`, matching the unqualified pattern used by features_au /
-- decisions_au / sessions_au. The slight extra churn from timestamp-only
-- updates is negligible compared with the consistency win.
--
-- Body is unchanged from 0006 — same DELETE+INSERT row-replace pattern.

DROP TRIGGER IF EXISTS documents_au;

CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
  DELETE FROM search_fts
    WHERE kind = 'document' AND ref_id = OLD.id AND project_id = OLD.project_id;
  INSERT INTO search_fts (kind, ref_id, project_id, title, body) VALUES (
    'document', NEW.id, NEW.project_id, NEW.title, NEW.content_md
  );
END;
