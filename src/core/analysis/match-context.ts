/**
 * The match context: everything the analysis reads from an archived match, in one typed value.
 *
 * An archive holds a whole match detail (see `../match-detail/archive-envelope`), most of it of no
 * use to the analysis. This module reads the few parts the metrics need: the twelve players with
 * their end-of-game counts and their statistic snapshots over time, who killed whom and when, the
 * rank the tracked player had, and whether somebody left the match. It splits the players into the
 * tracked player, their teammates, their enemies and their lane opponents, so that the metrics never
 * deal with slots and teams.
 *
 * Like every reader of an archive, it reads the payload with narrow schemas that name only the
 * fields it needs and ignore everything else, and it never puts a value of the payload in an error:
 * the payload belongs to players (account ids), and the errors end up in the logs.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { matchIdSchema } from '../domain/match';
import type { MatchId } from '../domain/match';
import { AppError } from '../errors/app-error';
import type { ArchiveEnvelope } from '../match-detail/archive-envelope';
import { archiveCount, readArchiveFields } from '../match-detail/archive-fields';
import { findTrackedPlayer } from '../match-detail/pruning';
import { interpolate } from './statistics';

/**
 * The cumulative counters of a statistic snapshot that the analysis reads: souls, the damage dealt
 * to heroes, taken from heroes and dealt to objectives, the shots that hit and missed, and the
 * healing and barriers given to teammates.
 */
export type SnapshotStat =
  | 'net_worth'
  | 'player_damage'
  | 'player_damage_taken'
  | 'boss_damage'
  | 'shots_hit'
  | 'shots_missed'
  | 'teammate_healing'
  | 'teammate_barriering';

/** One player's statistics at one time of the match: the cumulative value of each counter. */
export interface Snapshot {
  /** When the snapshot was taken, in seconds since the start of the match. */
  readonly timeS: number;
  /**
   * The counters of the snapshot. A counter the payload does not hold for this snapshot (or holds
   * as something else than a finite number from 0) is absent, never `0`.
   */
  readonly stats: Readonly<Partial<Record<SnapshotStat, number>>>;
}

/** One player of the match: their end-of-game counts and their statistics over time. */
export interface PlayerContext {
  /** Their slot (1 to 12): the key the kills refer to. */
  readonly slot: number;
  /** Their team, as numbered by the API. */
  readonly team: number;
  /**
   * The lane they were assigned to, or `null` when the payload does not say. The same number means
   * the same lane on both teams.
   */
  readonly lane: number | null;
  /** Their kills over the whole match. */
  readonly kills: number;
  /** Their deaths over the whole match. */
  readonly deaths: number;
  /** Their assists over the whole match. */
  readonly assists: number;
  /** Their souls at the end of the match. */
  readonly netWorth: number;
  /** Their last hits (creeps killed) over the whole match. */
  readonly lastHits: number;
  /** Their denies over the whole match. */
  readonly denies: number;
  /** Their statistic snapshots, sorted by time (none when the payload holds none). */
  readonly snapshots: readonly Snapshot[];
}

/** One kill of a hero by another hero. */
export interface KillEvent {
  /** When the victim died, in seconds since the start of the match. */
  readonly timeS: number;
  /** The slot of the player who made the kill. */
  readonly killerSlot: number;
  /** The slot of the player who died. */
  readonly victimSlot: number;
}

/** What the analysis reads from an archived match. */
export interface MatchContext {
  /** The match. */
  readonly matchId: MatchId;
  /** The length of the match, in seconds. */
  readonly durationS: number;
  /** The match mode code of the game data (1 = unranked, 4 = ranked…). */
  readonly matchMode: number;
  /** The tracked player: the one the archive was pruned for. */
  readonly tracked: PlayerContext;
  /** The players of the tracked player's team, the tracked player excluded, ordered by slot. */
  readonly teammates: readonly PlayerContext[];
  /** The players of the other team, ordered by slot. */
  readonly enemies: readonly PlayerContext[];
  /**
   * The enemies who were assigned to the same lane as the tracked player, ordered by slot; none
   * when the tracked player has no lane.
   */
  readonly laneOpponents: readonly PlayerContext[];
  /** Every kill of a hero by another hero in the match, ordered by time. */
  readonly kills: readonly KillEvent[];
  /**
   * The rank badge the tracked player had when the match started (tier × 10 + sub-rank, from 1 to
   * 116), or `null` for an unranked match, for a player who has no rank yet (placement matches),
   * and for a number that is no badge (above 116).
   */
  readonly trackedBadge: number | null;
  /** `true` when at least one player left the match before its end. */
  readonly hasLeaver: boolean;
}

/** The counters of a snapshot the analysis reads (see {@link SnapshotStat}). */
const SNAPSHOT_STATS = [
  'net_worth',
  'player_damage',
  'player_damage_taken',
  'boss_damage',
  'shots_hit',
  'shots_missed',
  'teammate_healing',
  'teammate_barriering',
] as const satisfies readonly SnapshotStat[];

/** The match mode code of a ranked match: only then does a player's rank data mean a badge. */
const RANKED_MATCH_MODE = 4;

/**
 * The lowest and the highest rank badge there is: sub-rank 1 of tier 1, and sub-rank 6 of tier 11.
 * A number outside them is not a badge (it cannot be stored with the match, nor compared with a
 * cohort), so the match is read as having none.
 */
const MIN_BADGE = 1;
const MAX_BADGE = 116;

/**
 * The rank data of a player. Only the badge they had when the match started is read (`0` while
 * they are still in their placement matches). It is a whole number from 0 like any count of the
 * payload; whether it is a badge that exists is decided where the badge is used.
 */
const rankDataSchema = z.looseObject({ initial_display_rank: archiveCount.nullish() });

/**
 * One statistic snapshot. Only its time is required: the counters are read apart, one by one,
 * because a counter that is missing or odd must not make the whole snapshot (or the match) unusable.
 */
const snapshotSchema = z.looseObject({ time_stamp_s: z.number().nonnegative() });

/** One death of a player: when it happened and the slot of the killer (`0` for no hero killer). */
const deathSchema = z.looseObject({
  game_time_s: z.number().nonnegative(),
  killer_player_slot: archiveCount,
});

/**
 * The fields of a player's entry that the context needs. The object is loose: every other field of
 * the player is ignored.
 *
 * The API sends `null` for what does not apply (an unranked match has no rank data), so a field that
 * may be missing accepts `null` as well as being absent.
 */
const playerSchema = z.looseObject({
  player_slot: archiveCount,
  team: z.int(),
  kills: archiveCount,
  deaths: archiveCount,
  assists: archiveCount,
  net_worth: archiveCount,
  last_hits: archiveCount,
  denies: archiveCount,
  assigned_lane: z.int().nullish(),
  // The time the player left the match, in seconds; `0` (or none) when they stayed to the end.
  abandon_match_time_s: z.number().nullish(),
  player_rank_data: rankDataSchema.nullish(),
  stats: z.array(snapshotSchema).nullish(),
  death_details: z.array(deathSchema).nullish(),
});

/** The fields of `match_info` that the context needs (the object is loose, like the player's). */
const matchInfoSchema = z.looseObject({
  match_id: matchIdSchema,
  duration_s: archiveCount,
  match_mode: z.int(),
});

/** A player as read from the payload: their context, and the facts that only concern the match. */
interface ReadPlayer {
  /** Whether this is the player the archive was pruned for. */
  readonly isTracked: boolean;
  /** The player as the metrics see them. */
  readonly player: PlayerContext;
  /**
   * The number they had as rank when the match started, whatever the match mode (`0` or none: no
   * rank). It is not checked to be a badge that exists, nor to be of a ranked match.
   */
  readonly initialRank: number;
  /** Whether they left the match before its end. */
  readonly left: boolean;
  /** Their deaths caused by a hero, as kills of the player who killed them. */
  readonly kills: readonly KillEvent[];
}

/**
 * Read the players, the kills and the rank of an archived match.
 *
 * The tracked player is the one the archive was pruned for. They are found by account id exactly
 * like the pruning does, so an archive that would not have been written (no such player, several of
 * them, not playing Paige) is not read either. Every list of the context is ordered (by slot for
 * the players, by time for the kills): the players of the payload are in no particular order.
 *
 * @param envelope - The decoded archive; it is not modified.
 * @returns The context of the match.
 * @throws AppError of kind `invalid_payload` when the tracked player is missing or malformed, or a
 *   field is not what the context expects. The context `issue` is one of `findTrackedPlayer`'s
 *   (`tracked_player_missing`…), or `match_info.<path>: <code>` / `players.<index>.<path>: <code>`
 *   (`<index>` being the position of the player in `match_info.players`); never a value of the
 *   payload.
 */
export function buildMatchContext(envelope: ArchiveEnvelope): MatchContext {
  const { payload, prunedForAccountId } = envelope;
  // Lookup and checks first: past this point, exactly one player has the tracked account id.
  findTrackedPlayer(payload, prunedForAccountId);
  const matchInfo = readArchiveFields(matchInfoSchema, payload.match_info, 'match_info');
  const players = payload.match_info.players
    .map((entry, index) => readPlayer(entry, index, entry.account_id === prunedForAccountId))
    .toSorted((first, second) => first.player.slot - second.player.slot);

  const trackedEntry = players.find((entry) => entry.isTracked);
  // Cannot happen once `findTrackedPlayer` has passed; it narrows the type without an assertion.
  if (trackedEntry === undefined) {
    throw new AppError('unexpected', 'The tracked player is not among the players of the match');
  }
  const tracked = trackedEntry.player;
  const others = players.filter((entry) => !entry.isTracked).map((entry) => entry.player);
  const enemies = others.filter((player) => player.team !== tracked.team);

  return {
    matchId: matchInfo.match_id,
    durationS: matchInfo.duration_s,
    matchMode: matchInfo.match_mode,
    tracked,
    teammates: others.filter((player) => player.team === tracked.team),
    enemies,
    // A player without a lane has no opponent: `null` is not a lane two players can share.
    laneOpponents:
      tracked.lane === null ? [] : enemies.filter((player) => player.lane === tracked.lane),
    // The players are already ordered by slot, so kills at the same time keep a stable order.
    kills: players
      .flatMap((entry) => entry.kills)
      .toSorted((first, second) => first.timeS - second.timeS),
    // A badge only means something in a ranked match; `0` is a player who has not been placed yet,
    // and a number past the highest badge is no badge at all: the match is read as having none, not
    // refused, since the rest of the archive is fine.
    trackedBadge:
      matchInfo.match_mode === RANKED_MATCH_MODE &&
      trackedEntry.initialRank >= MIN_BADGE &&
      trackedEntry.initialRank <= MAX_BADGE
        ? trackedEntry.initialRank
        : null,
    hasLeaver: players.some((entry) => entry.left),
  };
}

/**
 * The value of a player's counter at a time of the match.
 *
 * Counters are cumulative and the payload only holds a snapshot every few minutes, so a value
 * between two snapshots is the linear interpolation between them. Every counter starts at `0` when
 * the match starts, so the time before the first snapshot grows linearly from `(0, 0)`. A snapshot
 * that lacks the counter is skipped: the value is then read between the snapshots that have it.
 *
 * @param player - The player.
 * @param stat - The counter.
 * @param timeS - The time, in seconds since the start of the match.
 * @returns The value, or `null` when no snapshot holds the counter or when the time is after the
 *   last snapshot that holds it (or before the start of the match): the counter is never
 *   extrapolated.
 */
export function statAt(player: PlayerContext, stat: SnapshotStat, timeS: number): number | null {
  // Every counter is 0 when the match starts: the (0, 0) point is what makes the time before the
  // first snapshot a straight line from the origin instead of an unknown. The snapshots are sorted
  // by time, so the points are as well.
  const points: [number, number][] = [[0, 0]];
  for (const snapshot of player.snapshots) {
    const value = snapshot.stats[stat];
    if (value !== undefined) {
      points.push([snapshot.timeS, value]);
    }
  }
  // Only the origin: the counter is in no snapshot, so even its start is not known.
  return points.length === 1 ? null : interpolate(points, timeS);
}

/**
 * The number of kills a player made in a window of the match.
 *
 * The window starts at `startS` (included) and ends at `endS` (excluded), so that consecutive
 * windows never count a kill twice. The exception is the window that ends with the match
 * (`endS === durationS`): a kill in the very last second belongs to nothing else, so it is counted.
 *
 * @param context - The match.
 * @param killerSlot - The slot of the player.
 * @param startS - The start of the window, in seconds since the start of the match.
 * @param endS - The end of the window, in seconds since the start of the match.
 * @returns The number of kills of the player with `startS ≤ time < endS`, or `time ≤ endS` when
 *   the window ends with the match.
 */
export function killsIn(
  context: MatchContext,
  killerSlot: number,
  startS: number,
  endS: number,
): number {
  // The last window has no next one to take a kill made at the very end of the match, which a
  // plain `< endS` would drop: it is counted there and only there.
  const endsWithMatch = endS === context.durationS;
  return context.kills.filter(
    (kill) =>
      kill.killerSlot === killerSlot &&
      kill.timeS >= startS &&
      (kill.timeS < endS || (endsWithMatch && kill.timeS === endS)),
  ).length;
}

/**
 * The length of the match in minutes, for the metrics per minute.
 *
 * A match is never shorter than one second here, so that a metric per minute never divides by zero
 * (the analysis flags such a match as low confidence anyway).
 *
 * @param context - The match.
 * @returns `max(1, durationS) / 60`.
 */
export function matchMinutes(context: MatchContext): number {
  return Math.max(1, context.durationS) / 60;
}

/**
 * Read one player of the payload.
 *
 * @param entry - The player as the match detail schema typed it.
 * @param index - The position of the player in `match_info.players`, the path of a problem.
 * @param isTracked - Whether this is the player the archive was pruned for.
 * @returns The player.
 * @throws AppError of kind `invalid_payload` (`players.<index>.<path>: <code>`) when the player is
 *   not what the context expects.
 */
function readPlayer(entry: unknown, index: number, isTracked: boolean): ReadPlayer {
  const raw = readArchiveFields(playerSchema, entry, `players.${String(index)}`);
  return {
    isTracked,
    player: {
      slot: raw.player_slot,
      team: raw.team,
      lane: raw.assigned_lane ?? null,
      kills: raw.kills,
      deaths: raw.deaths,
      assists: raw.assists,
      netWorth: raw.net_worth,
      lastHits: raw.last_hits,
      denies: raw.denies,
      snapshots: (raw.stats ?? [])
        .map((snapshot) => ({ timeS: snapshot.time_stamp_s, stats: readSnapshotStats(snapshot) }))
        .toSorted((first, second) => first.timeS - second.timeS),
    },
    initialRank: raw.player_rank_data?.initial_display_rank ?? 0,
    left: (raw.abandon_match_time_s ?? 0) > 0,
    // A killer slot of `0` means the death has no hero killer (the environment, a trooper…).
    kills: (raw.death_details ?? [])
      .filter((death) => death.killer_player_slot > 0)
      .map((death) => ({
        timeS: death.game_time_s,
        killerSlot: death.killer_player_slot,
        victimSlot: raw.player_slot,
      })),
  };
}

/**
 * Read the counters of a snapshot.
 *
 * A counter is kept only when it is a finite number from 0. Anything else (absent, `null`, text, a
 * negative number) leaves it out of the snapshot: the snapshot stays usable for the other counters,
 * and a counter that is missing is not mistaken for a `0`.
 *
 * @param snapshot - The snapshot of the payload.
 * @returns The counters that could be read.
 */
function readSnapshotStats(
  snapshot: Readonly<Record<string, unknown>>,
): Partial<Record<SnapshotStat, number>> {
  const stats: Partial<Record<SnapshotStat, number>> = {};
  for (const stat of SNAPSHOT_STATS) {
    const value = snapshot[stat];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      stats[stat] = value;
    }
  }
  return stats;
}
