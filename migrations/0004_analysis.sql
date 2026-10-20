-- Migration 4: the projections of the match analysis, and the rank of the linked account.
--
-- The desktop app applies it once, through the Tauri SQL plugin, after migration 3 (same rules:
-- never edit this file once released, put every change in a new migration). The browser dev mode
-- and the tests apply it to a fresh in-memory database, right after migration 3.
--
-- The analysis of a match starts from its archived detail, a large file read and decoded for each
-- match. The projection reads that file once and keeps its numbers here: one row per match that
-- says the projection is done (and with which version of the metrics), and one row per metric of
-- that match. Neither table is a source of truth, only a cache that the archive can rebuild: a
-- projection row of another version is replaced the next time the match is projected, and the rows
-- of an account are deleted with the rest of its data. Times are Unix milliseconds, like every time
-- but `start_time`.

-- One row per projected match of an account. A match is projected when this row exists with the
-- current version. A save deletes this row before it touches the metric rows and writes it again
-- after them, so a projection interrupted at any point leaves no row and the match is projected
-- again.
CREATE TABLE match_projections (
  account_id INTEGER NOT NULL,
  match_id INTEGER NOT NULL,
  -- The version of the metric definitions that produced the rows; another version means that the
  -- match is to be projected again.
  projection_version INTEGER NOT NULL,
  -- The rank badge the player had in the match (tier * 10 + sub-rank); NULL when the match shows
  -- none (an unranked match, or a rank not known).
  player_badge INTEGER CHECK (player_badge IS NULL OR player_badge BETWEEN 1 AND 116),
  -- Whether a player left the match (it is analysed with low confidence).
  has_leaver INTEGER NOT NULL CHECK (has_leaver IN (0, 1)),
  -- Whether the archived detail could not be turned into a match to analyse: such a match has no
  -- metric rows and is not projected again before the version changes.
  failed INTEGER NOT NULL CHECK (failed IN (0, 1)),
  -- When the match was projected.
  projected_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, match_id)
) STRICT, WITHOUT ROWID;

-- One row per metric of a projected match. The key names the metric, and its window or phase when it
-- has one (`kda`, `souls_per_min_mid.community_window`). The value is a finite number, or NULL when
-- the metric could not be computed for the match: the repository never writes a NaN or an infinity,
-- which the two database drivers would not read back the same way.
CREATE TABLE match_metrics (
  account_id INTEGER NOT NULL,
  match_id INTEGER NOT NULL,
  metric_key TEXT NOT NULL,
  value REAL,
  PRIMARY KEY (account_id, match_id, metric_key)
) STRICT, WITHOUT ROWID;

-- The rank of the linked account, to compare its unranked matches with the community of its rank.
-- Existing rows start without a rank: both columns are NULL until the app fetches it.
-- The badge is `tier * 10 + sub-rank` as deadlock-api gives it; 0 means that no rank is known.
ALTER TABLE linked_account ADD COLUMN rank_badge INTEGER
  CHECK (rank_badge IS NULL OR rank_badge BETWEEN 0 AND 116);
-- When deadlock-api last answered about the rank; NULL when it never did.
ALTER TABLE linked_account ADD COLUMN rank_fetched_at INTEGER;
