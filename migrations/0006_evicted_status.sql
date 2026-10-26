-- Adds the detail status 'evicted': the archive file of a match was removed to keep the archive folder
-- under its size limit, while the match keeps its stored metrics. SQLite cannot change a CHECK, so the
-- table is rebuilt with the same columns, rows and indexes.
--
-- The desktop app applies it once, through the Tauri SQL plugin, after migration 5 (same rules:
-- never edit this file once released, put every change in a new migration). The plugin runs it in
-- one transaction, so a failure leaves the old table as it was. The browser dev mode and the tests
-- apply it to a fresh in-memory database, right after migration 5. No foreign key, view or trigger
-- refers to `matches`, so dropping the old table touches nothing else.

-- The new table: the columns of migration 1, then those migration 2 added, then the one migration 5
-- added, in that order and with the same definitions; only the CHECK of `detail_status` changes.
CREATE TABLE matches_rebuilt (
  account_id INTEGER NOT NULL,
  match_id INTEGER NOT NULL,
  hero_id INTEGER NOT NULL,
  start_time INTEGER NOT NULL,
  duration_s INTEGER NOT NULL,
  game_mode INTEGER NOT NULL,
  match_mode INTEGER NOT NULL,
  won INTEGER NOT NULL CHECK (won IN (0, 1)),
  kills INTEGER NOT NULL,
  deaths INTEGER NOT NULL,
  assists INTEGER NOT NULL,
  net_worth INTEGER NOT NULL,
  last_hits INTEGER NOT NULL,
  denies INTEGER NOT NULL,
  -- Rank change caused by the match; NULL when the match changed no rank.
  rank_delta INTEGER,
  -- Last time a synchronisation wrote this row.
  synced_at INTEGER NOT NULL,
  -- Where the match stands: not tried yet (pending), waiting for a new attempt (retry), archived
  -- (ready), given up after too many failures (unavailable), answered with a detail the app cannot
  -- use (invalid), or archived once but its file removed to free space (evicted).
  detail_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (detail_status IN ('pending', 'retry', 'ready', 'unavailable', 'invalid', 'evicted')),
  -- How many attempts were counted as failures so far.
  detail_attempts INTEGER NOT NULL DEFAULT 0,
  -- When the next attempt is due; NULL when none is planned.
  detail_next_attempt_at INTEGER,
  -- Error code of the last counted failure (never a value read from a response); NULL when none.
  detail_last_error TEXT,
  -- Size in bytes of the archive file of a ready match, kept once it is evicted; NULL otherwise.
  archived_bytes INTEGER,
  -- The format of each match's archive file: NULL for a file written before this column existed (format 1),
  -- 1 for a format-1 file whose refresh failed for good, 2 for the current format.
  archive_format INTEGER CHECK (archive_format IS NULL OR archive_format >= 1),
  PRIMARY KEY (account_id, match_id)
) STRICT, WITHOUT ROWID;

-- Every row, each column named on both sides so that no value can land in another column.
INSERT INTO matches_rebuilt (
  account_id, match_id, hero_id, start_time, duration_s, game_mode, match_mode, won, kills,
  deaths, assists, net_worth, last_hits, denies, rank_delta, synced_at, detail_status,
  detail_attempts, detail_next_attempt_at, detail_last_error, archived_bytes, archive_format
)
SELECT
  account_id, match_id, hero_id, start_time, duration_s, game_mode, match_mode, won, kills,
  deaths, assists, net_worth, last_hits, denies, rank_delta, synced_at, detail_status,
  detail_attempts, detail_next_attempt_at, detail_last_error, archived_bytes, archive_format
FROM matches;

-- Dropping the old table drops its indexes with it.
DROP TABLE matches;
ALTER TABLE matches_rebuilt RENAME TO matches;

-- The indexes of migration 1, as it wrote them.
-- Most recent matches of a player first (match list, dashboard periods).
CREATE INDEX matches_by_start_time ON matches (account_id, start_time DESC);
-- Matches of one hero over a period (dashboard).
CREATE INDEX matches_by_hero ON matches (account_id, hero_id, start_time);
