/**
 * The replay of an archived match: where every player was each second, when they were dead, and
 * which objectives and mid boss kills happened. It is the single input of the map replay.
 *
 * Everything is read from the archive's `match_info`: the players and their `death_details`, the
 * movement paths (decoded by `../match-detail/player-paths`), `objectives` and `mid_boss`. Like every
 * reader of an archive, it never puts a value of the payload in an error: the payload belongs to
 * players (account ids), and the errors end up in the logs.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import type { ArchiveEnvelope } from '../match-detail/archive-envelope';
import { archiveCount, readArchiveFields } from '../match-detail/archive-fields';
import { positionAt, readPlayerPaths } from '../match-detail/player-paths';
import type { MapPoint, PlayerPath } from '../match-detail/player-paths';
import { findTrackedPlayer } from '../match-detail/pruning';
import { identifyObjective } from './map-objectives';

/** One death of a player: when they died, and when they come back. */
export interface ReplayDeath {
  /** The second of the match the player died at. */
  readonly timeS: number;
  /**
   * The second of the match the player is back at (`timeS + death_duration_s`); `null` when the
   * payload does not say how long they waited.
   */
  readonly respawnS: number | null;
}

/** Where one player was during the match, and when they were dead. */
export interface ReplayPlayerTrack {
  /** The slot of the player, from 1 to 12. */
  readonly slot: number;
  /** The team of the player, as numbered by the API. */
  readonly team: number;
  /** The hero the player played. */
  readonly heroId: number;
  /** Whether this is the player the archive was made for. */
  readonly isTracked: boolean;
  /** Whether the player has a readable path; without one, every position is `null`. */
  readonly hasPath: boolean;
  /**
   * The position of the player at each second: the index is the second, from 0 to `durationS`, so
   * the length is always `durationS + 1`. `null` while dead (see {@link isDeadAt}) or unknown.
   */
  readonly positions: readonly (MapPoint | null)[];
  /** The deaths of the player, sorted by time. */
  readonly deaths: readonly ReplayDeath[];
}

/** One objective of a team, and when it fell. */
export interface ReplayObjective {
  /** The team that owns the objective. */
  readonly team: number;
  /** The id of the objective among the objectives of its team. */
  readonly teamObjectiveId: number;
  /** The second the objective was destroyed at; `null` when it survived (the API writes `0`). */
  readonly destroyedAtS: number | null;
}

/** One kill of the mid boss. */
export interface ReplayMidBossKill {
  /** The second of the match the mid boss was killed at. */
  readonly timeS: number;
  /** The team that killed it. */
  readonly teamKilled: number;
  /** The team that claimed the reward. */
  readonly teamClaimed: number;
}

/**
 * How many players the replay can place on the map:
 * - `all`: every player with a readable path;
 * - `tracked_only`: a format-1 archive, which only holds the tracked player's path;
 * - `none`: no path could be read.
 */
export type ReplayCoverage = 'all' | 'tracked_only' | 'none';

/** The replay of a match. */
export interface MatchReplay {
  /** How long the match lasted, in seconds. */
  readonly durationS: number;
  /** The team of the tracked player. */
  readonly trackedTeam: number;
  /** How many players can be placed on the map. */
  readonly coverage: ReplayCoverage;
  /** One track for each player of the match, sorted by slot. */
  readonly players: readonly ReplayPlayerTrack[];
  /** The objectives that were damaged and that the map knows, sorted by team then id. */
  readonly objectives: readonly ReplayObjective[];
  /** The mid boss kills, sorted by time; none when the payload has no `mid_boss`. */
  readonly midBossKills: readonly ReplayMidBossKill[];
}

/**
 * The fields of a player that the replay needs. The object is loose: every other field is ignored.
 *
 * `death_details` may be absent (a payload may leave out an empty list) or `null`, and so may the
 * wait before the respawn of a death.
 */
const replayPlayerSchema = z.looseObject({
  player_slot: archiveCount,
  team: z.int(),
  hero_id: archiveCount,
  death_details: z
    .array(
      z.looseObject({
        game_time_s: z.number().nonnegative(),
        death_duration_s: z.number().nullish(),
      }),
    )
    .nullish(),
});

/**
 * `match_info.objectives`: the objectives that were damaged; absent when none was. The object of an
 * entry is loose, the other fields (the first damage time…) are ignored.
 */
const objectivesSchema = z
  .array(
    z.looseObject({
      team: z.int(),
      team_objective_id: archiveCount,
      destroyed_time_s: z.number().nonnegative(),
    }),
  )
  .optional();

/** `match_info.mid_boss`: the kills of the mid boss; absent when it was never killed. */
const midBossSchema = z
  .array(
    z.looseObject({
      team_killed: z.int(),
      team_claimed: z.int(),
      destroyed_time_s: z.number().nonnegative(),
    }),
  )
  .optional();

/**
 * Tell whether a player is dead at a second.
 *
 * A player is dead from the second of a death included (`timeS`) to the second of the respawn
 * excluded (`respawnS`). A death whose wait is unknown (`respawnS` is `null`) counts as dead at
 * `timeS` only: nothing is known beyond that instant. The map and the panel both use this, so they
 * never disagree.
 *
 * @param deaths - The deaths of the player, in any order.
 * @param timeS - The second of the match.
 * @returns `true` when the player is dead then.
 */
export function isDeadAt(deaths: readonly ReplayDeath[], timeS: number): boolean {
  return deaths.some((death) =>
    death.respawnS === null
      ? timeS === death.timeS
      : death.timeS <= timeS && timeS < death.respawnS,
  );
}

/**
 * Build the positions of a player at each second of the match.
 *
 * @param path - The player's path, or `undefined` when they have none.
 * @param deaths - The deaths of the player.
 * @param durationS - How long the match lasted, in seconds.
 * @returns `durationS + 1` entries; all `null` without a path.
 */
function buildPositions(
  path: PlayerPath | undefined,
  deaths: readonly ReplayDeath[],
  durationS: number,
): readonly (MapPoint | null)[] {
  return Array.from({ length: durationS + 1 }, (_, timeS) =>
    // A player is hidden while dead even when their path sample says otherwise.
    path === undefined || isDeadAt(deaths, timeS) ? null : positionAt(path, timeS),
  );
}

/**
 * Read the replay of an archived match.
 *
 * @param envelope - The decoded archive; it is not modified.
 * @returns The replay. The coverage is `none` when the archive has no readable path, `tracked_only`
 *   for a format-1 archive, `all` otherwise.
 * @throws AppError of kind `invalid_payload` when the tracked player is missing, or when a field the
 *   replay needs is not what is expected (including `match_paths` itself). The context `issue` is
 *   `<name>.<path>: <code>` (`<name>` being for instance `match_info.objectives`); never a value of
 *   the payload.
 */
export function readMatchReplay(envelope: ArchiveEnvelope): MatchReplay {
  const matchInfo = envelope.payload.match_info;
  const durationS = matchInfo.duration_s;
  const tracked = findTrackedPlayer(envelope.payload, envelope.prunedForAccountId);
  const paths = readPlayerPaths(envelope);

  const players = matchInfo.players
    .map((player, index): ReplayPlayerTrack => {
      const fields = readArchiveFields(
        replayPlayerSchema,
        player,
        `match_info.players.${String(index)}`,
      );
      const deaths = (fields.death_details ?? [])
        .map((death): ReplayDeath => ({
          timeS: death.game_time_s,
          // The API may leave out how long the player waits: the respawn is unknown then.
          respawnS:
            death.death_duration_s === null || death.death_duration_s === undefined
              ? null
              : death.game_time_s + death.death_duration_s,
        }))
        .toSorted((first, second) => first.timeS - second.timeS);
      const path = paths?.bySlot.get(fields.player_slot);
      return {
        slot: fields.player_slot,
        team: fields.team,
        heroId: fields.hero_id,
        isTracked: fields.player_slot === tracked.playerSlot,
        hasPath: path !== undefined,
        positions: buildPositions(path, deaths, durationS),
        deaths,
      };
    })
    .toSorted((first, second) => first.slot - second.slot);

  const objectives = (
    readArchiveFields(objectivesSchema, matchInfo.objectives, 'match_info.objectives') ?? []
  )
    // The map only knows some objectives: the others (lane 2, unknown ids) are left out.
    .filter((objective) => identifyObjective(objective.team_objective_id) !== null)
    .map((objective): ReplayObjective => ({
      team: objective.team,
      teamObjectiveId: objective.team_objective_id,
      // The API writes 0 for an objective that survived.
      destroyedAtS: objective.destroyed_time_s === 0 ? null : objective.destroyed_time_s,
    }))
    .toSorted(
      (first, second) => first.team - second.team || first.teamObjectiveId - second.teamObjectiveId,
    );

  const midBossKills = (
    readArchiveFields(midBossSchema, matchInfo.mid_boss, 'match_info.mid_boss') ?? []
  )
    .map((kill): ReplayMidBossKill => ({
      timeS: kill.destroyed_time_s,
      teamKilled: kill.team_killed,
      teamClaimed: kill.team_claimed,
    }))
    .toSorted((first, second) => first.timeS - second.timeS);

  const hasReadablePath = players.some((player) => player.hasPath);
  const coverage: ReplayCoverage = !hasReadablePath
    ? 'none'
    : envelope.archiveFormat === 1
      ? 'tracked_only'
      : 'all';

  return { durationS, trackedTeam: tracked.team, coverage, players, objectives, midBossKills };
}
