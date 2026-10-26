/**
 * The deaths of the tracked player in an archived match: when they died, and for the detailed
 * reading, who killed them, how fast, how long they waited to respawn and where.
 *
 * A player's `death_details[]` lists their deaths, one entry each, with the time of the death and
 * the slot of the hero who killed them (`0` when no hero did: the environment, a trooper…). The
 * projection only needs when the tracked player died, whoever or whatever killed them, so
 * {@link readTrackedDeathTimes} reads the times and nothing else. {@link readTrackedDeaths} reads
 * the detail of each death. Both use a narrow schema that names the few fields they need, so that
 * an archive stays readable as the API evolves.
 *
 * Like every reader of an archive, it never puts a value of the payload in an error: the payload
 * belongs to players (account ids), and the errors end up in the logs.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import type { ArchiveEnvelope } from './archive-envelope';
import { archiveCount, readArchiveFields } from './archive-fields';
import type { MapPoint } from './player-paths';
import { findTrackedPlayer } from './pruning';

/**
 * The part of a player's entry that holds the times of their deaths: the count, and the detail of
 * each one. The object is loose: every other field is ignored, such as the killer's slot of a death
 * detail.
 *
 * The list may be absent (a payload may leave out an empty list, as JSON written from protobuf
 * messages does with empty repeated fields), and the API sends `null` for what does not apply.
 */
const playerDeathTimesSchema = z.looseObject({
  deaths: archiveCount,
  death_details: z.array(z.looseObject({ game_time_s: z.number().nonnegative() })).nullish(),
});

/**
 * The part of a player's entry that holds the detail of their deaths. A detail has the time of the
 * death, the slot of the killer (`0` for no hero), the position of the death, and two durations
 * that the API may leave out: the time the killer took to kill, and the wait before the respawn.
 *
 * The position is required here, unlike in {@link playerDeathTimesSchema}: a death that cannot be
 * placed cannot be judged. The rest of each object is loose and ignored.
 *
 * The two durations accept any number: the API writes `-1` when it does not know the time to kill
 * (about 2 % of the deaths), so a negative value is not an invalid payload. It means unknown, and
 * {@link readTrackedDeaths} reads it as `null`, never as a time.
 */
const playerDeathDetailsSchema = z.looseObject({
  deaths: archiveCount,
  death_details: z
    .array(
      z.looseObject({
        game_time_s: z.number().nonnegative(),
        killer_player_slot: archiveCount,
        time_to_kill_s: z.number().nullish(),
        death_duration_s: z.number().nullish(),
        death_pos: z.looseObject({ x: z.number(), y: z.number() }),
      }),
    )
    .nullish(),
});

/**
 * One death of the tracked player, with what the judgement of the death needs.
 *
 * It holds nothing that identifies a player: the killer is a slot of the match, not an account.
 */
export interface TrackedDeath {
  /** When the player died, in seconds since the start of the match. */
  readonly timeS: number;
  /** The slot of the hero who killed them, `0` when no hero did (the environment, a trooper…). */
  readonly killerSlot: number;
  /**
   * How long the killer took to kill them, in seconds; `null` when the payload does not say, or
   * writes `-1` because the API does not know it.
   */
  readonly timeToKillS: number | null;
  /** How long they waited to respawn, in seconds; `null` when the payload does not say (or `-1`). */
  readonly respawnS: number | null;
  /** Where they died, on the map. */
  readonly position: MapPoint;
}

/**
 * Read the fields of the tracked player's entry with a schema.
 *
 * The tracked player is found by account id exactly like the pruning does, so an archive that would
 * not have been written (no such player, several of them, not playing Paige) is not read either.
 *
 * @param envelope - The decoded archive; it is not modified.
 * @param schema - The schema of the fields to read.
 * @returns The validated fields of the tracked player.
 * @throws AppError of kind `invalid_payload`, see {@link readTrackedDeathTimes}.
 */
function readTrackedPlayer<Schema extends z.ZodType>(
  envelope: ArchiveEnvelope,
  schema: Schema,
): z.output<Schema> {
  const { payload, prunedForAccountId } = envelope;
  // Lookup and checks first: past this point, exactly one player has the tracked account id.
  findTrackedPlayer(payload, prunedForAccountId);
  const players = payload.match_info.players;
  const index = players.findIndex((player) => player.account_id === prunedForAccountId);
  return readArchiveFields(schema, players[index], `players.${String(index)}`);
}

/**
 * The death details of a player when they are complete: one detail per death.
 *
 * @param player - The player's deaths.
 * @param player.deaths - The count of their deaths.
 * @param player.death_details - The detail of each death, when the payload has them.
 * @returns The details: none for a player who never died, even when the payload leaves out the
 *   empty list; `null` when the list is missing for a player who died, or has another length than
 *   the count of deaths, as some detail may be missing and the deaths are unknown rather than fewer.
 */
function completeDetails<Detail>(player: {
  readonly deaths: number;
  readonly death_details?: readonly Detail[] | null | undefined;
}): readonly Detail[] | null {
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
  return details;
}

/**
 * A duration of a death when the payload knows it.
 *
 * @param seconds - The duration as the payload gives it: left out, `null`, or a number; the API
 *   writes `-1` when it does not know the time to kill.
 * @returns The duration, or `null` when it is left out or negative (unknown, never a time).
 */
function knownDuration(seconds: number | null | undefined): number | null {
  return seconds === null || seconds === undefined || seconds < 0 ? null : seconds;
}

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
  const details = completeDetails(readTrackedPlayer(envelope, playerDeathTimesSchema));
  if (details === null) {
    return null;
  }
  return details.map((death) => death.game_time_s).toSorted((first, second) => first - second);
}

/**
 * Read the deaths of the tracked player in an archive, each with its killer, time to kill, respawn
 * wait and position.
 *
 * It follows the same completeness rule as {@link readTrackedDeathTimes}: the deaths are only
 * trusted when the death details are complete, one detail per death. Unlike it, a detail must hold
 * the position of the death, since the deaths are judged from it.
 *
 * @param envelope - The decoded archive; it is not modified.
 * @returns The deaths, sorted from the earliest (the payload's order is not relied on); none for a
 *   player who never died, even when the payload leaves out the empty list; `null` when the death
 *   details are missing or incomplete.
 * @throws AppError of kind `invalid_payload` when the tracked player is missing or a field is not
 *   what is expected, including a death position without numeric coordinates. The context `issue`
 *   is as for {@link readTrackedDeathTimes}, for instance
 *   `players.<index>.death_details.<position>.death_pos.x: invalid_type`; never a value of the
 *   payload.
 */
export function readTrackedDeaths(envelope: ArchiveEnvelope): readonly TrackedDeath[] | null {
  const details = completeDetails(readTrackedPlayer(envelope, playerDeathDetailsSchema));
  if (details === null) {
    return null;
  }
  return details
    .map((death): TrackedDeath => ({
      timeS: death.game_time_s,
      killerSlot: death.killer_player_slot,
      // The API may leave out the durations of a death, or write -1 when it does not know them:
      // they are unknown then, not zero and not a negative time.
      timeToKillS: knownDuration(death.time_to_kill_s),
      respawnS: knownDuration(death.death_duration_s),
      position: { x: death.death_pos.x, y: death.death_pos.y },
    }))
    .toSorted((first, second) => first.timeS - second.timeS);
}
