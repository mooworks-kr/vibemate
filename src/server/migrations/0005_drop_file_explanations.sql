-- 0005_drop_file_explanations: retire the Code Map / AI file-explanation
-- feature per ADR-0016.
--
-- Order matters:
--   1. Drop the FTS5 triggers that fire on file_explanations changes — they
--      still reference the table, so they have to go before the table itself.
--   2. Sweep out any 'file'-kind rows from search_fts so future searches can't
--      surface dead references. (The triggers we just dropped were keeping
--      this in sync; once they're gone, the index is the only place these
--      rows still live.)
--   3. Drop the table.
--
-- We deliberately don't reindex anything else: features / decisions / sessions
-- triggers from 0002 are untouched and their rows in search_fts stay valid.

DROP TRIGGER IF EXISTS file_explanations_ai;
DROP TRIGGER IF EXISTS file_explanations_au;
DROP TRIGGER IF EXISTS file_explanations_ad;

DELETE FROM search_fts WHERE kind = 'file';

DROP TABLE IF EXISTS file_explanations;
