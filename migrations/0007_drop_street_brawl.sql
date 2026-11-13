-- Migration 7: deletes the Street Brawl matches the earlier versions of the app stored.
--
-- The desktop app applies it once, through the Tauri SQL plugin, after migration 6 (same rules:
-- never edit this file once released, put every change in a new migration). The plugin runs it in
-- one transaction, so a failure leaves every table as it was. The browser dev mode and the tests
-- apply it to a fresh in-memory database, right after migration 6.
--
-- The app keeps no Street Brawl match any more: the synchronisation drops them before it stores the
-- history, and this migration removes the ones stored before. A Street Brawl match is told by its
-- game mode alone (4), whatever its match mode. Such a match was never archived (only the normal
-- game is), so it has no archive file, and its detail status needs no care: its row goes. Its
-- projection and metric rows are deleted first, should any exist, so that no row is left pointing
-- at a match the database no longer holds.

-- The metric rows of the Street Brawl matches, matched on the account and the match.
DELETE FROM match_metrics
WHERE EXISTS (
  SELECT 1 FROM matches
  WHERE matches.account_id = match_metrics.account_id
    AND matches.match_id = match_metrics.match_id
    AND matches.game_mode = 4
);

-- Their projection rows, the same way.
DELETE FROM match_projections
WHERE EXISTS (
  SELECT 1 FROM matches
  WHERE matches.account_id = match_projections.account_id
    AND matches.match_id = match_projections.match_id
    AND matches.game_mode = 4
);

-- The Street Brawl matches themselves.
DELETE FROM matches WHERE game_mode = 4;
