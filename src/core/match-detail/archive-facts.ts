/**
 * The few facts the match detail page reads back from an archive.
 *
 * The archive holds a whole match detail (pruned for the tracked player), and the page shows a line
 * of figures about the archive itself. This module reads exactly those, with a schema that names
 * only the fields it needs and ignores everything else, so that an archive stays readable as the
 * API (and the rest of the app) evolves. It is also the door check of an archive: an archive is
 * only written if this reader accepts it.
 *
 * Like every reader of an archive, it never puts a value of the payload in an error: the payload
 * belongs to players (account ids), and the errors end up in the logs.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import type { ArchiveEnvelope } from './archive-envelope';
import { archiveCount, readArchiveFields } from './archive-fields';
import { findTrackedPlayer } from './pruning';
import { SHOP_ITEM_UPGRADE_ID } from './tracked-items';

/**
 * What the match detail page shows about the tracked player in an archived match: the line of
 * archive facts at the bottom of the analysis tab. The rest of the page comes from elsewhere: the
 * result and the score from the match history; the damage, the build and the players from readers
 * of their own.
 */
export interface ArchiveFacts {
  /** The number of statistic snapshots the archive holds for them (one at the match end). */
  readonly snapshots: number;
  /**
   * The number of shop items they bought (the unlocks and the upgrades of their hero's abilities,
   * which the same list holds, are not counted).
   */
  readonly itemsBought: number;
  /** When the archived detail was fetched from the API, in Unix milliseconds. */
  readonly fetchedAt: number;
}

/**
 * The fields of the tracked player's entry that the door check of an archive requires. The object
 * is loose: every other field of the player is ignored.
 *
 * `kills`, `deaths`, `assists` and `net_worth` are not among the facts, but they stay required:
 * this reader is the door check of an archive (an archive is only written if it passes), and these
 * fields are the tracked player's line of the scoreboard. Dropping them would let in an archive
 * whose scoreboard cannot be read.
 *
 * `stats` (the cumulative statistic snapshots) and `items` (the shop purchases and the ability
 * unlocks and upgrades) may be absent from a player's entry: an absent array counts as empty. The
 * `upgrade_id` of an entry may be absent too, which is the tolerance of this door check.
 */
const trackedPlayerSchema = z.looseObject({
  kills: archiveCount,
  deaths: archiveCount,
  assists: archiveCount,
  net_worth: archiveCount,
  // Only the number of snapshots is read, so their content is not checked.
  stats: z.array(z.unknown()).optional(),
  items: z.array(z.looseObject({ upgrade_id: archiveCount.optional() })).optional(),
});

/**
 * The fields of `match_info` that the door check requires (the object is loose, like the
 * player's). The winning team is not among the facts either: it is required for the same reason as
 * the scoreboard fields of the player, since without it no reader can tell the result.
 */
const matchInfoSchema = z.looseObject({
  // The team that won the match, numbered like `players[].team`.
  winning_team: z.int(),
});

/**
 * Summarise the tracked player of an archive.
 *
 * The tracked player is the one the archive was pruned for. They are found by account id exactly
 * like the pruning does, so an archive that would not have been written (no such player, several of
 * them, not playing Paige) is not read either.
 *
 * @param envelope - The decoded archive; it is not modified.
 * @returns The facts about the tracked player.
 * @throws AppError of kind `invalid_payload` when the tracked player is missing or malformed. The
 *   context `issue` is one of `findTrackedPlayer`'s (`tracked_player_missing`…), or
 *   `tracked_player.<path>: <code>` / `match_info.<path>: <code>` for a field that is not what
 *   the door check expects; never a value of the payload.
 */
export function summarizeArchive(envelope: ArchiveEnvelope): ArchiveFacts {
  const { payload, prunedForAccountId } = envelope;
  // Lookup and checks first: past this point, exactly one player has the tracked account id.
  findTrackedPlayer(payload, prunedForAccountId);
  const entry = payload.match_info.players.find(
    (player) => player.account_id === prunedForAccountId,
  );
  const player = readArchiveFields(trackedPlayerSchema, entry, 'tracked_player');
  // Read for the door check only: it throws when the winning team is missing or malformed.
  readArchiveFields(matchInfoSchema, payload.match_info, 'match_info');
  return {
    snapshots: player.stats?.length ?? 0,
    // The items of a player mix shop purchases with the unlocks (`upgrade_id` 0) and the upgrades
    // (any other number) of their hero's abilities: only a shop item (`upgrade_id` 1) was bought. An
    // entry without an `upgrade_id` is tolerated (this is the door check of an archive) but says
    // nothing that makes it a shop item, so it is not counted.
    itemsBought: (player.items ?? []).filter((item) => item.upgrade_id === SHOP_ITEM_UPGRADE_ID)
      .length,
    fetchedAt: envelope.fetchedAt,
  };
}
