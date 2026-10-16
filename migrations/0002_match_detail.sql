-- Migration 2: the state of the detail of each match in the detail queue.
--
-- The desktop app applies it once, through the Tauri SQL plugin, after migration 1 (same rules:
-- never edit this file once released, put every change in a new migration). The browser dev mode
-- and the tests apply it to a fresh in-memory database, right after migration 1.
--
-- The detail of a match is a large response of deadlock-api, archived in a compressed file outside
-- the database. These columns only record where each match stands: the queue reads them to pick
-- the next match to download and writes them after each attempt. A new synchronisation of the
-- match history never writes them (its upsert lists the history columns only), so a match that is
-- already archived stays archived. Times are Unix milliseconds, like every time but `start_time`.

-- Where the match stands: not tried yet (pending), waiting for a new attempt (retry), archived
-- (ready), given up after too many failures (unavailable), or answered with a detail the app
-- cannot use (invalid). Existing rows start as pending.
ALTER TABLE matches ADD COLUMN detail_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (detail_status IN ('pending', 'retry', 'ready', 'unavailable', 'invalid'));
-- How many attempts were counted as failures so far.
ALTER TABLE matches ADD COLUMN detail_attempts INTEGER NOT NULL DEFAULT 0;
-- When the next attempt is due; NULL when none is planned.
ALTER TABLE matches ADD COLUMN detail_next_attempt_at INTEGER;
-- Error code of the last counted failure (never a value read from a response); NULL when none.
ALTER TABLE matches ADD COLUMN detail_last_error TEXT;
-- Size in bytes of the archive file of a ready match; NULL otherwise.
ALTER TABLE matches ADD COLUMN archived_bytes INTEGER;
