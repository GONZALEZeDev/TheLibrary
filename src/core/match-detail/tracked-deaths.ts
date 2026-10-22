/**
 * The times the tracked player died at in an archived match.
 *
 * A player's `death_details[]` lists their deaths, one entry each, with the time of the death and
 * the slot of the hero who killed them (`0` when no hero did: the environment, a trooper…). The
 * review only needs when the tracked player died, whoever or whatever killed them, so this module
 * reads the times and nothing else, with a narrow schema that names the few fields it needs, so
 * that an archive stays readable as the API evolves.
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

/**
 * The part of a player's entry that holds their deaths: the count, and the detail of each one. The
 * object is loose: every other field is ignored, such as the killer's slot of a death detail.
 *
 * The list may be absent (a payload may leave out an empty list, as JSON written from protobuf
 * messages does with empty repeated fields), and the API sends `null` for what does not apply.
 */
const playerDeathsSchema = z.looseObject({
  deaths: archiveCount,
  death_details: z.array(z.looseObject({ game_time_s: z.number().nonnegative() })).nullish(),
});

/**
 * Read the times the tracked player died at in an archive.
 *
 * The tracked player is the one the archive was pruned for. They are found by account id exactly
 * like the pruning does, so an archive that would not have been written (no such player, several of
 * them, not playing Paige) is not read either. Every death counts, whoever or whatever caused it.
 *
 * The times are only trusted when the death details are complete, as the match context does for the
 * kills: one detail per death. When the list is missing, or has another length than the count of
 * deaths, some detail may be missing, and the times are unknown rather than fewer.
 *
 * @param envelope - The decoded archive; it is not modified.
 * @returns The times of the deaths, in seconds since the start of the match, sorted from the
 *   earliest (the payload's order is not relied on); none for a player who never died, even when
 *   the payload leaves out the empty list; `null` when the death details are missing or incomplete.
 * @throws AppError of kind `invalid_payload` when the tracked player is missing or a field is not
 *   what is expected. The context `issue` is one of `findTrackedPlayer`'s
 *   (`tracked_player_missing`…), or `players.<index>.<path>: <code>` (`<index>` being the position
 *   of the player in `match_info.players`, `<path>` for instance
 *   `death_details.<position>.game_time_s`); never a value of the payload.
 */
export function readTrackedDeathTimes(envelope: ArchiveEnvelope): readonly number[] | null {
  const { payload, prunedForAccountId } = envelope;
  // Lookup and checks first: past this point, exactly one player has the tracked account id.
  findTrackedPlayer(payload, prunedForAccountId);
  const players = payload.match_info.players;
  const index = players.findIndex((player) => player.account_id === prunedForAccountId);
  const player = readArchiveFields(playerDeathsSchema, players[index], `players.${String(index)}`);
  // A player who never died has no death to detail, so an absent list is the empty one.
  const details = player.death_details ?? (player.deaths === 0 ? [] : undefined);
  // The list is missing for a player who died: their deaths are not detailed at all.
  if (details === undefined) {
    return null;
  }
  // Fewer or more details than deaths: some may be missing.
  if (details.length !== player.deaths) {
    return null;
  }
  return details.map((death) => death.game_time_s).toSorted((first, second) => first - second);
}
