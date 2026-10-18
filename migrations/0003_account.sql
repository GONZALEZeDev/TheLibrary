-- Migration 3: the Steam account the user linked to the app.
--
-- The desktop app applies it once, through the Tauri SQL plugin, after migration 2 (same rules:
-- never edit this file once released, put every change in a new migration). The browser dev mode
-- and the tests apply it to a fresh in-memory database, right after migration 2.
--
-- The link lives in this database, next to the matches it governs, and not in the settings store:
-- every match belongs to one account, so the link can only be lost together with the data it
-- governs. A database restored from a backup, or deleted by hand, brings back (or loses) both the
-- matches and the account they belong to, never one without the other. Times are Unix
-- milliseconds, like every time but `start_time`.

-- The linked account: at most one row, so `id` is always 1 and replacing the account is an update
-- of that row.
CREATE TABLE linked_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- The Steam account id (the low 32 bits of the SteamID64), as deadlock-api names the player.
  account_id INTEGER NOT NULL CHECK (account_id BETWEEN 1 AND 4294967295),
  -- Steam persona name; NULL when no profile is known.
  persona_name TEXT,
  -- The medium avatar (a JPEG) as base64 text, so that it shows offline and without a request per
  -- display. The limit is 4 * ceil(262144 / 3) characters, the base64 text of 256 KiB.
  avatar_base64 TEXT CHECK (avatar_base64 IS NULL OR length(avatar_base64) <= 349528),
  -- The 40-hex SHA-1 Steam names the avatar file after; tells when the stored avatar is outdated.
  avatar_hash TEXT CHECK (avatar_hash IS NULL OR length(avatar_hash) = 40),
  -- When the account was linked.
  linked_at INTEGER NOT NULL,
  -- When deadlock-api last answered about the profile; NULL when it never did.
  profile_fetched_at INTEGER,
  -- An avatar and its hash go together: there are both, or neither.
  CHECK ((avatar_base64 IS NULL) = (avatar_hash IS NULL))
) STRICT;
