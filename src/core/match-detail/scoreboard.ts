/**
 * The scoreboard of an archived match: the players of both teams with their heroes and their
 * end-of-game figures, and the places the tracked player takes among them.
 *
 * An archive keeps all twelve players of the match (only the movement paths and the damage of the
 * others are pruned), so the page can show the whole scoreboard and tell how the tracked player
 * did against everyone else. The scoreboard is read with narrow schemas that name only the fields
 * it needs, so that an archive stays readable as the API evolves: the fields that make a
 * scoreboard (who played which hero, the kills, the souls…) are required, and everything that only
 * decorates it (the damage and support counters, Valve's top three, the ranks) is tolerated, an odd
 * value reading as "unknown" rather than as an unreadable archive.
 *
 * The scoreboard never holds an account id: the other players of a match are people, and the page
 * has no use for who they are. Like every reader of an archive, it never puts a value of the
 * payload in an error: the errors end up in the logs.
 *
 * @packageDocumentation
 */
import { z } from 'zod';
import { isBadge } from '../domain/rank';
import type { ArchiveEnvelope } from './archive-envelope';
import { archiveCount, readArchiveFields } from './archive-fields';
import { RANKED_MATCH_MODE } from './detail-status';
import { findTrackedPlayer } from './pruning';

/** One player of the scoreboard. */
export interface ScoreboardPlayer {
  /** Their slot (1 to 12), which identifies them in the match. */
  readonly slot: number;
  /** Their team, as numbered by the API. */
  readonly team: number;
  /** The hero they played, an id of the hero list. */
  readonly heroId: number;
  /** Their kills. */
  readonly kills: number;
  /** Their deaths. */
  readonly deaths: number;
  /** Their assists. */
  readonly assists: number;
  /** Their souls at the end of the match. */
  readonly netWorth: number;
  /** Their last hits (the troopers they killed). */
  readonly lastHits: number;
  /** Their denies (the troopers they killed on their own side). */
  readonly denies: number;
  /** The damage they dealt to heroes over the match; `null` when the archive does not tell. */
  readonly heroDamage: number | null;
  /** The damage they dealt to objectives over the match; `null` when the archive does not tell. */
  readonly objectiveDamage: number | null;
  /**
   * What they gave their teammates over the match: the healing and the barrier added. `null` only
   * when the archive tells neither (one that is known counts as it is, the other as 0).
   */
  readonly support: number | null;
  /**
   * Their place in Valve's top three of the match (1 for the best), or `null` for any other
   * player (and for a match that has no top three).
   */
  readonly mvpRank: 1 | 2 | 3 | null;
  /**
   * The rank badge they had when the match started (see `../domain/rank`), or `null` in a match
   * that is not ranked, for a player who has no rank yet (placement matches) and when the archive
   * does not tell.
   */
  readonly badge: number | null;
}

/** The scoreboard of a match, and who the tracked player is on it. */
export interface ScoreboardRead {
  /** The slot of the tracked player: the player of {@link ScoreboardRead.players} with this slot. */
  readonly trackedSlot: number;
  /** The team that won the match, numbered like {@link ScoreboardPlayer.team}. */
  readonly winningTeam: number;
  /** `true` for a ranked match: the only one whose players' ranks are the badges they played at. */
  readonly ranked: boolean;
  /** The players of the match present in the archive (twelve in a complete one), sorted by slot. */
  readonly players: readonly ScoreboardPlayer[];
}

/**
 * The figures of the scoreboard that the tracked player is placed on, in the order they are
 * shown. Each is a field of {@link ScoreboardPlayer} where a higher number is better.
 */
export const SCOREBOARD_PLACE_STATS = [
  'netWorth',
  'heroDamage',
  'objectiveDamage',
  'support',
  'lastHits',
] as const;

/** One of the {@link SCOREBOARD_PLACE_STATS}. */
export type PlaceStat = (typeof SCOREBOARD_PLACE_STATS)[number];

/** The place of the tracked player on one figure of the scoreboard. */
export interface StatPlace {
  /** The figure. */
  readonly stat: PlaceStat;
  /** Their place among the players that have this figure: 1 for the best, ties sharing the best place. */
  readonly place: number;
  /** How many players have this figure (the tracked player included). */
  readonly of: number;
  /**
   * How far their figure is from the mean of the players, as a share of that mean (`0.5` is 50 %
   * above it, `-0.2` is 20 % below it); `null` when the mean is 0, as there is nothing to compare
   * with.
   */
  readonly gapToMean: number | null;
}

/**
 * A count that is only decoration of the scoreboard: a non-negative integer, or `null` for
 * anything else (absent, `null` or odd), so that it never makes the archive unreadable.
 */
const lenientCount = archiveCount.nullable().catch(null);

/**
 * The counters of a statistic snapshot that the scoreboard reads, one by one: an absent or odd
 * counter is unknown, whatever the others are.
 */
const snapshotCountersSchema = z.looseObject({
  // The damage dealt to heroes, then to objectives (the API calls them bosses).
  player_damage: lenientCount,
  boss_damage: lenientCount,
  // The support given to teammates: what they were healed, and what they were shielded.
  teammate_healing: lenientCount,
  teammate_barriering: lenientCount,
});

/** The counters of a snapshot that is missing or is not an object: all unknown. */
const NO_COUNTERS: z.output<typeof snapshotCountersSchema> = {
  player_damage: null,
  boss_damage: null,
  teammate_healing: null,
  teammate_barriering: null,
};

/**
 * The fields of a player's entry that the scoreboard needs. The object is loose: every other field
 * of the player is ignored.
 *
 * The end-of-game figures and the hero are required. Everything else is tolerated, so that a field
 * that is missing or odd is an unknown figure and never an unreadable archive:
 * - `mvp_rank` is Valve's top three (1 to 3), `null` for the nine other players; an older match
 *   may lack it, and any other number is not a place of the top three;
 * - `player_rank_data` is absent from a match that is not ranked;
 * - `stats` is the list of snapshots, of which only the last is read (apart, see
 *   {@link snapshotCountersSchema}), since an odd snapshot must not hide a good one.
 */
const playerSchema = z.looseObject({
  player_slot: archiveCount,
  team: z.int(),
  hero_id: archiveCount,
  kills: archiveCount,
  deaths: archiveCount,
  assists: archiveCount,
  net_worth: archiveCount,
  last_hits: archiveCount,
  denies: archiveCount,
  mvp_rank: z.literal([1, 2, 3]).nullable().catch(null),
  player_rank_data: z.looseObject({ initial_display_rank: lenientCount }).nullable().catch(null),
  stats: z.array(z.unknown()).nullable().catch(null),
});

/** The fields of `match_info` that the scoreboard needs (the object is loose, like the player's). */
const matchInfoSchema = z.looseObject({
  // The team that won the match, numbered like `players[].team`.
  winning_team: z.int(),
  match_mode: z.int(),
});

/**
 * Add the healing and the barrier a player gave their teammates.
 *
 * Most players give none of one or the other (a healer's barrier is 0, and so is a shielder's
 * healing), so a counter that is known is never held back by one that is not.
 *
 * @param healing - Their healing, or `null` when unknown.
 * @param barrier - Their barrier, or `null` when unknown.
 * @returns The sum, counting an unknown one as 0; `null` only when both are unknown.
 */
function supportOf(healing: number | null, barrier: number | null): number | null {
  if (healing === null && barrier === null) {
    return null;
  }
  return (healing ?? 0) + (barrier ?? 0);
}

/**
 * Read the counters of the last snapshot of a player.
 *
 * Counters are cumulative, so the last snapshot (the one at the end of the match) holds the totals.
 * The snapshots are sorted by time in the payloads, and the last of the list is the one read.
 *
 * @param snapshots - The `stats` list of the player; `null` when absent or not a list.
 * @returns The counters of the last snapshot, each `null` when absent or odd, all of them when
 *   there is no snapshot (or the last is not an object).
 */
function lastSnapshotCounters(
  snapshots: readonly unknown[] | null,
): z.output<typeof snapshotCountersSchema> {
  const parsed = snapshotCountersSchema.safeParse(snapshots?.at(-1));
  return parsed.success ? parsed.data : NO_COUNTERS;
}

/**
 * Turn a player of the payload into a player of the scoreboard.
 *
 * @param player - The validated fields of the player.
 * @param ranked - Whether the match is ranked.
 * @returns The player, without anything that identifies them besides their slot.
 */
function toScoreboardPlayer(
  player: z.output<typeof playerSchema>,
  ranked: boolean,
): ScoreboardPlayer {
  const counters = lastSnapshotCounters(player.stats);
  const rank = player.player_rank_data?.initial_display_rank ?? null;
  return {
    slot: player.player_slot,
    team: player.team,
    heroId: player.hero_id,
    kills: player.kills,
    deaths: player.deaths,
    assists: player.assists,
    netWorth: player.net_worth,
    lastHits: player.last_hits,
    denies: player.denies,
    heroDamage: counters.player_damage,
    objectiveDamage: counters.boss_damage,
    support: supportOf(counters.teammate_healing, counters.teammate_barriering),
    mvpRank: player.mvp_rank,
    // A rank only is a badge in a ranked match; `0` is a player who has no rank yet, and a number
    // past the highest badge is no badge at all: the player has none, the archive is not refused.
    badge: ranked && isBadge(rank) ? rank : null,
  };
}

/**
 * Read the scoreboard of an archive.
 *
 * The tracked player is the one the archive was pruned for. They are found by account id exactly
 * like the pruning does, so an archive that would not have been written (no such player, several of
 * them, not playing Paige) is not read either. The players of the payload are in no particular
 * order; the scoreboard's are sorted by slot. The result holds no account id.
 *
 * @param envelope - The decoded archive; it is not modified.
 * @returns The scoreboard.
 * @throws AppError of kind `invalid_payload` when the tracked player is missing or a field the
 *   scoreboard requires is not what it expects. The context `issue` is one of
 *   `findTrackedPlayer`'s (`tracked_player_missing`…), or `match_info.<path>: <code>` /
 *   `players.<index>.<path>: <code>` (`<index>` being the position of the player in
 *   `match_info.players`); never a value of the payload, nor an account id.
 */
export function readScoreboard(envelope: ArchiveEnvelope): ScoreboardRead {
  const { payload, prunedForAccountId } = envelope;
  // Lookup and checks first: past this point, exactly one player has the tracked account id.
  const tracked = findTrackedPlayer(payload, prunedForAccountId);
  const matchInfo = readArchiveFields(matchInfoSchema, payload.match_info, 'match_info');
  const ranked = matchInfo.match_mode === RANKED_MATCH_MODE;
  const players = payload.match_info.players
    .map((entry, index) =>
      toScoreboardPlayer(
        readArchiveFields(playerSchema, entry, `players.${String(index)}`),
        ranked,
      ),
    )
    .toSorted((first, second) => first.slot - second.slot);
  return {
    trackedSlot: tracked.playerSlot,
    winningTeam: matchInfo.winning_team,
    ranked,
    players,
  };
}

/**
 * Place the tracked player on one figure of the scoreboard.
 *
 * @param players - Every player of the scoreboard.
 * @param stat - The figure.
 * @param value - The figure of the tracked player.
 * @returns Their place among the players that have this figure, and their gap to the mean of those.
 */
function placeOnStat(
  players: readonly ScoreboardPlayer[],
  stat: PlaceStat,
  value: number,
): StatPlace {
  // A player whose figure is unknown is neither compared with nor counted in the mean.
  const values = players.map((player) => player[stat]).filter((figure) => figure !== null);
  const mean = values.reduce((total, figure) => total + figure, 0) / values.length;
  return {
    stat,
    // One place below every player that has more: ties share the best place, and the next player
    // comes after all of them (two players first, then third).
    place: 1 + values.filter((figure) => figure > value).length,
    of: values.length,
    gapToMean: mean === 0 ? null : (value - mean) / mean,
  };
}

/**
 * Place the tracked player among the players of the scoreboard, figure by figure.
 *
 * A higher figure is a better place. A figure the tracked player has no value for gets no place
 * (there is nothing to place); neither does a scoreboard that does not hold the tracked player.
 *
 * @param read - The scoreboard; it is not modified.
 * @returns The places of the tracked player, in the order of {@link SCOREBOARD_PLACE_STATS}.
 */
export function placesOf(read: ScoreboardRead): readonly StatPlace[] {
  const tracked = read.players.find((player) => player.slot === read.trackedSlot);
  if (tracked === undefined) {
    return [];
  }
  return SCOREBOARD_PLACE_STATS.flatMap((stat) => {
    const value = tracked[stat];
    return value === null ? [] : [placeOnStat(read.players, stat, value)];
  });
}
