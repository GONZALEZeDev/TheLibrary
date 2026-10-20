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
import { isBadge } from '../domain/rank';
import { AppError } from '../errors/app-error';
import type { ArchiveEnvelope } from '../match-detail/archive-envelope';
import { archiveCount, readArchiveFields } from '../match-detail/archive-fields';
import { RANKED_MATCH_MODE } from '../match-detail/detail-status';
import { findTrackedPlayer } from '../match-detail/pruning';
import { interpolate } from './statistics';

/**
 * The cumulative counters of a statistic snapshot that the analysis reads: souls, the damage dealt
 * to heroes, taken from heroes and dealt to objectives, the shots that hit and missed, and the
 * healing and barriers given to teammates.
 *
 * The list is the one the snapshots are read with, and {@link SnapshotStat} is made from it: a
 * counter cannot be named by a metric without being read.
 */
export const SNAPSHOT_STATS = [
  'net_worth',
  'player_damage',
  'player_damage_taken',
  'boss_damage',
  'shots_hit',
  'shots_missed',
  'teammate_healing',
  'teammate_barriering',
] as const;

/** One of the {@link SNAPSHOT_STATS}. */
export type SnapshotStat = (typeof SNAPSHOT_STATS)[number];

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
  /**
   * Every kill of a hero by another hero in the match, ordered by time; `null` when the kills are
   * not known.
   *
   * The kills are read from the death details of the victims. In a complete payload every player
   * has one death detail per death (a player who never died may have no list at all); when the
   * death details of a player who died are missing, or fewer or more than their deaths, a kill
   * could be missing from them, so none is trusted: the kills of the match are unknown, never taken
   * for no kill.
   */
  readonly kills: readonly KillEvent[] | null;
  /**
   * The rank badge the tracked player had when the match started (tier × 10 + sub-rank, see
   * `../domain/rank`), or `null` for an unranked match, for a player who has no rank yet (placement
   * matches), and for a number that is no badge (past the last one).
   */
  readonly trackedBadge: number | null;
  /** `true` when at least one player left the match before its end. */
  readonly hasLeaver: boolean;
}

/**
 * The rank of the tracked player. Only the badge they had when the match started is read (`0`
 * while they are still in their placement matches). It is a whole number from 0 like any count of
 * the payload; whether it is a badge that exists is decided where the badge is used.
 *
 * Only the tracked player's rank is read: the analysis uses no other player's, so an odd rank on
 * another player never makes the match unreadable.
 */
const trackedRankSchema = z.looseObject({
  player_rank_data: z.looseObject({ initial_display_rank: archiveCount.nullish() }).nullish(),
});

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
 * The API sends `null` for what does not apply, so a field that may be missing accepts `null` as
 * well as being absent. The rank data is not among the fields: only the tracked player's is read
 * ({@link trackedRankSchema}).
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
   * The number the tracked player had as rank when the match started, whatever the match mode (`0`
   * or none: no rank). It is not checked to be a badge that exists, nor to be of a ranked match.
   * `null` for the other players: their rank is not read.
   */
  readonly initialRank: number | null;
  /** Whether they left the match before its end. */
  readonly left: boolean;
  /**
   * Their deaths caused by a hero, as kills of the player who killed them; `null` when their death
   * details are missing or do not hold one entry per death (some of them may be missing).
   */
  readonly kills: readonly KillEvent[] | null;
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
    kills: matchKills(players),
    // A badge only means something in a ranked match; `0` is a player who has not been placed yet,
    // and a number past the highest badge is no badge at all: the match is read as having none, not
    // refused, since the rest of the archive is fine.
    trackedBadge:
      matchInfo.match_mode === RANKED_MATCH_MODE && isBadge(trackedEntry.initialRank)
        ? trackedEntry.initialRank
        : null,
    hasLeaver: players.some((entry) => entry.left),
  };
}

/**
 * Gather the kills of a match from the deaths of its players.
 *
 * @param players - Every player of the match, ordered by slot.
 * @returns Every kill, ordered by time (the players being ordered by slot, kills at the same time
 *   keep a stable order), or `null` as soon as one player's kills are unknown: a kill missing from
 *   their death details would make some other player's kills look fewer than they were.
 */
function matchKills(players: readonly ReadPlayer[]): readonly KillEvent[] | null {
  const killsByVictim = players.map((entry) => entry.kills);
  if (!killsByVictim.every((kills): kills is readonly KillEvent[] => kills !== null)) {
    return null;
  }
  return killsByVictim.flat().toSorted((first, second) => first.timeS - second.timeS);
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
 *   the window ends with the match; `null` when the kills of the match are unknown (see
 *   {@link MatchContext.kills}), never `0`.
 */
export function killsIn(
  context: MatchContext,
  killerSlot: number,
  startS: number,
  endS: number,
): number | null {
  if (context.kills === null) {
    return null;
  }
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
 * A length in minutes, for the figures per minute: the one place that owns the rule.
 *
 * A match is never shorter than one second here, so that a figure per minute never divides by zero
 * (the analysis flags such a match as low confidence anyway).
 *
 * @param durationS - The length of a match, in seconds.
 * @returns `max(1, durationS) / 60`.
 */
export function minutesOf(durationS: number): number {
  return Math.max(1, durationS) / 60;
}

/**
 * The length of the match in minutes, for the metrics per minute.
 *
 * @param context - The match.
 * @returns The length of the match, see {@link minutesOf}.
 */
export function matchMinutes(context: MatchContext): number {
  return minutesOf(context.durationS);
}

/**
 * Read one player of the payload.
 *
 * @param entry - The player as the match detail schema typed it.
 * @param index - The position of the player in `match_info.players`, the path of a problem.
 * @param isTracked - Whether this is the player the archive was pruned for: only their rank is read.
 * @returns The player.
 * @throws AppError of kind `invalid_payload` (`players.<index>.<path>: <code>`) when the player is
 *   not what the context expects.
 */
function readPlayer(entry: unknown, index: number, isTracked: boolean): ReadPlayer {
  const path = `players.${String(index)}`;
  const raw = readArchiveFields(playerSchema, entry, path);
  // A player who never died has no death to detail: a payload may leave the empty list out, as
  // JSON written from protobuf messages does with empty repeated fields.
  const deathDetails = raw.death_details ?? (raw.deaths === 0 ? [] : undefined);
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
    initialRank: isTracked ? readInitialRank(entry, path) : null,
    left: (raw.abandon_match_time_s ?? 0) > 0,
    // One death detail per death, as in every complete payload. Otherwise (no list, or one of
    // another length) some may be missing, and the kills they hold are unknown rather than fewer.
    kills:
      deathDetails?.length === raw.deaths
        ? deathDetails
            // A killer slot of `0` means the death has no hero killer (the environment, a trooper…).
            .filter((death) => death.killer_player_slot > 0)
            .map((death) => ({
              timeS: death.game_time_s,
              killerSlot: death.killer_player_slot,
              victimSlot: raw.player_slot,
            }))
        : null,
  };
}

/**
 * Read the rank the tracked player had when the match started.
 *
 * @param entry - The tracked player as the match detail schema typed it.
 * @param path - The path of the player in the payload (`players.<index>`), the start of the path of
 *   a problem.
 * @returns Their rank at the start of the match, `0` when they have none (no rank data, or none at
 *   the start).
 * @throws AppError of kind `invalid_payload` (`players.<index>.player_rank_data…: <code>`) when the
 *   rank data is not an object or the rank is not a whole number from 0.
 */
function readInitialRank(entry: unknown, path: string): number {
  const { player_rank_data: rankData } = readArchiveFields(trackedRankSchema, entry, path);
  return rankData?.initial_display_rank ?? 0;
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
