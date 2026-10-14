-- Migration 1: the tables of the match history synchronisation.
--
-- The desktop app applies it once, through the Tauri SQL plugin, which records a checksum of the
-- file and refuses to open the database if an applied migration changed afterwards, even by a
-- whitespace: never edit this file once released, put every change in a new migration. The
-- browser dev mode and the tests apply the same file to a fresh in-memory database.
--
-- Conventions: match times (`start_time`) are Unix seconds, as deadlock-api returns them; every
-- other time is in Unix milliseconds, as `Date.now()` returns them. Booleans are 0/1: SQLite has
-- no boolean type. Tables are STRICT: SQLite refuses a value of the wrong type (a text, or a
-- decimal in an INTEGER column) instead of storing it.

-- One row per match of a player's history, all heroes, as returned by deadlock-api.
CREATE TABLE matches (
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
  PRIMARY KEY (account_id, match_id)
) STRICT, WITHOUT ROWID;

-- Most recent matches of a player first (match list, dashboard periods).
CREATE INDEX matches_by_start_time ON matches (account_id, start_time DESC);
-- Matches of one hero over a period (dashboard).
CREATE INDEX matches_by_hero ON matches (account_id, hero_id, start_time);

-- Responses of slow-changing endpoints (such as the hero catalogue), reused across sessions.
CREATE TABLE api_cache (
  cache_key TEXT NOT NULL PRIMARY KEY,
  payload_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- Small JSON values of the synchronisation: request budget, API pause, last result per account.
CREATE TABLE sync_state (
  key TEXT NOT NULL PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
