/**
 * The definition of a metric: one number the analysis computes for every match, and everything the
 * analysis needs to know about it to compare it with the community and with the player's habits.
 *
 * A metric is a plain object, not a class: its identity (key, family, unit), how to read it (which
 * direction is better, how a difference is shown, how the habits are compared), where the community
 * reference comes from, and the function that computes it from a {@link MatchContext}. The metrics
 * themselves live apart, one file each, in `./metrics`; this module holds what they share.
 *
 * @packageDocumentation
 */
import type { MatchContext, PlayerContext, SnapshotStat } from './match-context';
import type { Phase } from './phases';

/**
 * The key of a metric of the whole match: one value per match, shown in the family it belongs to.
 * The key is stored with the value and names the metric's texts, so it never changes once released.
 */
export type MatchMetricKey =
  | 'kda'
  | 'player_damage_per_min'
  | 'accuracy'
  | 'deaths'
  | 'damage_taken_per_min'
  | 'souls_per_min'
  | 'last_hits'
  | 'denies'
  | 'teammate_healing'
  | 'teammate_barriering'
  | 'boss_damage_per_min'
  | 'souls_at_10min'
  | 'lane_souls_diff_at_10min';

/**
 * The key of a metric of one phase of the match: a rate over the early, the mid or the late game,
 * shown in the phase table rather than in a family. The early game has no souls metric of its own:
 * `souls_at_10min` (a match metric) covers it.
 */
export type PhaseMetricKey =
  | 'souls_per_min_mid'
  | 'souls_per_min_late'
  | 'hero_damage_per_min_early'
  | 'hero_damage_per_min_mid'
  | 'hero_damage_per_min_late'
  | 'objective_damage_per_min_early'
  | 'objective_damage_per_min_mid'
  | 'objective_damage_per_min_late'
  | 'kills_per_min_early'
  | 'kills_per_min_mid'
  | 'kills_per_min_late';

/** The key of any metric, of the whole match or of one phase. */
export type MetricKey = MatchMetricKey | PhaseMetricKey;

/** The family a match metric is shown under: what part of the player's game it describes. */
export type MetricFamily = 'combat' | 'survival' | 'farm' | 'support' | 'objectives' | 'laning';

/**
 * What a metric's value counts, which decides how it is formatted: a `ratio` (the KDA), a rate
 * `per_min`, a `percent` (from 0 to 1), a `count` of events (deaths, last hits) or an `amount` of
 * something (souls, healing).
 */
export type MetricUnit = 'ratio' | 'per_min' | 'percent' | 'count' | 'amount';

/**
 * The name of a community benchmark of the deadlock-api: the statistic whose percentiles over a
 * cohort of matches the community reference is read from. Some names differ from the metric's key
 * (`net_worth_per_min` is the benchmark of `souls_per_min`).
 */
export type BenchmarkKey =
  | 'kda'
  | 'player_damage_per_min'
  | 'accuracy'
  | 'deaths'
  | 'player_damage_taken_per_min'
  | 'net_worth_per_min'
  | 'last_hits'
  | 'denies'
  | 'teammate_healing'
  | 'teammate_barriering'
  | 'boss_damage_per_min';

/**
 * The statistic of the deadlock-api's performance curve: the average of a cumulative counter, at
 * each time of the match, over a cohort.
 */
export type CurveStat = 'net_worth' | 'player_damage' | 'boss_damage' | 'kills';

/**
 * Where the community reference of a metric comes from:
 *
 * - `percentiles`: the player is placed in the percentiles of a benchmark (1 to 99 over the cohort),
 *   so the metric is compared with the whole distribution of the community.
 * - `curve`: the community only gives the average of a cumulative counter (`stat`) at each time of
 *   the match, so the metric is compared with the community's rate over a span of the match that
 *   starts with `phase`. `rate` is the player's rate over that same span in this match (per minute),
 *   or `null` when the match does not reach it or the archive lacks the counter; comparing the
 *   same span on both sides is what keeps a long match from looking better than the average.
 * - `none`: the community has no reference for this metric, only the player's habits are compared.
 */
export type CommunitySource =
  | { readonly kind: 'percentiles'; readonly benchmark: BenchmarkKey }
  | {
      readonly kind: 'curve';
      readonly stat: CurveStat;
      readonly phase: Phase;
      readonly rate: (context: MatchContext) => number | null;
    }
  | { readonly kind: 'none' };

/** Everything the analysis knows about one metric. */
export interface MetricDefinition {
  /** The metric's key: its identity in storage, and the name of its texts. */
  readonly key: MetricKey;
  /**
   * The family the metric is shown under, or `null` for a phase metric, which is shown in the
   * phase table instead.
   */
  readonly family: MetricFamily | null;
  /** What the value counts, which decides how it is formatted. */
  readonly unit: MetricUnit;
  /**
   * Which direction is an improvement. For `lower` (deaths, damage taken), the placement among the
   * community and the difference with the habits are turned, so that a higher score always means
   * better.
   */
  readonly better: 'higher' | 'lower';
  /**
   * The thing the metric measures. Metrics of the same group say the same thing in different words
   * (souls per minute and souls at 10:00, for instance), so the summary shows at most one strength
   * and one weakness per group. A metric that measures something of its own is its own group.
   */
  readonly group: string;
  /**
   * How the difference with the player's habits is shown: `relative` as a percentage of the usual
   * value (+12 %), `absolute` in the metric's unit (+2 deaths). An absolute difference suits a
   * small count or a percentage, where a percentage of a percentage means little.
   */
  readonly display: 'relative' | 'absolute';
  /**
   * How the value is compared with the player's earlier matches: `as_is` compares the values as
   * they are, `per_minute` first divides each match's value by its length in minutes. The second
   * is for totals (deaths, last hits, healing), which grow with the length of a match: compared as
   * they are, a long match would stand out from the habits only because it is long.
   */
  readonly personal: 'as_is' | 'per_minute';
  /**
   * Whether the value is a whole number. The community percentiles of such a metric are rounded to
   * whole numbers before the player is placed among them, because a player can only be at a whole
   * value.
   */
  readonly integer: boolean;
  /** Where the community reference comes from. */
  readonly community: CommunitySource;
  /**
   * Compute the metric for a match.
   *
   * @param context - The match, seen from the tracked player.
   * @returns The value, or `null` when the archive does not hold what the metric needs (or the
   *   metric does not apply to this match): an unknown value is never replaced by `0`.
   */
  compute(context: MatchContext): number | null;
}

/**
 * The final value of a player's cumulative counter: its value in the latest statistic snapshot that
 * holds it.
 *
 * The counters of a snapshot only grow, so the latest value is the largest one, which is how the
 * deadlock-api itself defines the final value of a counter. The latest snapshot may lack a counter
 * the earlier ones hold (the payload leaves out what it does not know); the value is then the one of
 * the latest snapshot that has it. This is the reader every metric built on a snapshot counter
 * (damage dealt, damage taken, shots, healing…) shares, so that they all treat a missing counter the
 * same way.
 *
 * Souls, kills, deaths, assists, last hits and denies are not read here: the metrics read their
 * end-of-game fields on the player (the game's scoreboard and the API both use those, and a snapshot
 * differs from them for a few players in ten).
 *
 * @param player - The player.
 * @param stat - The counter.
 * @returns The counter's value in the latest snapshot that holds it, or `null` when no snapshot
 *   holds it (not `0`: the counter is unknown).
 */
export function finalStat(player: PlayerContext, stat: SnapshotStat): number | null {
  // The snapshots are sorted by time, so the last one that holds the counter is the latest.
  const latest = player.snapshots.findLast((snapshot) => snapshot.stats[stat] !== undefined);
  return latest?.stats[stat] ?? null;
}
