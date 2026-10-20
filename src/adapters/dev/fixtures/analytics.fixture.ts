/**
 * Synthetic community data served by the development HTTP client: what deadlock-api answers to the
 * four requests of the match analysis (the benchmark of the metrics, the performance curve, the
 * statistics of the heroes, and the rank of a player), in the raw shape of the API (reduced to the
 * fields the app reads and a few it ignores, like the real answers).
 *
 * No real player is described here. The numbers are invented, close to what the community of Paige
 * looks like: they only have to be plausible and the same every time, so that the dev mode and the
 * tests always see the same comparison.
 *
 * @packageDocumentation
 */
import { PAIGE_HERO_ID, type HeroId } from '../../../core/domain/hero';

/** The nine percentiles of a metric, at the points 1, 5, 10, 25, 50, 75, 90, 95 and 99. */
type NinePercentiles = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** The statistics of one metric of the benchmark, in the raw shape of the API. */
export type RawMetricStatistics = Readonly<Record<string, number>>;

/** One point of the performance curve, in the raw shape of the API (`game_time`, `X_avg`, `X_std`). */
export type RawCurvePoint = Readonly<Record<string, number>>;

/** One row of the hero statistics, in the raw shape of the API (reduced to a few fields). */
export interface RawHeroSample {
  readonly hero_id: HeroId;
  readonly wins: number;
  readonly losses: number;
  /** The number of matches the hero was played in: `wins + losses`. */
  readonly matches: number;
}

/** The rank of a player, in the raw shape of the API. */
export interface RawPlayerRank {
  /** The badge: `tier × 10 + subrank`, 0 when no rank is known. */
  readonly badge: number;
  readonly rank: number;
  readonly subrank: number;
  /** The latest ranked match; the fixtures never describe one. */
  readonly last_match: null;
}

/**
 * Write the statistics of one metric the way the API does: the average, the standard deviation, and
 * one field per percentile point.
 *
 * @param avg - The average over the cohort.
 * @param std - The standard deviation over the cohort.
 * @param percentiles - The values at the nine percentile points, in increasing order.
 * @returns The statistics.
 */
function metricStatistics(
  avg: number,
  std: number,
  percentiles: NinePercentiles,
): RawMetricStatistics {
  const [p1, p5, p10, p25, p50, p75, p90, p95, p99] = percentiles;
  return {
    avg,
    std,
    percentile1: p1,
    percentile5: p5,
    percentile10: p10,
    percentile25: p25,
    percentile50: p50,
    percentile75: p75,
    percentile90: p90,
    percentile95: p95,
    percentile99: p99,
  };
}

/**
 * Imitate what deadlock-api answers to `GET /v1/analytics/player-stats/metrics`: an object keyed by
 * metric name. It holds the 11 metrics the app reads and a few it ignores. Like the real answer, a
 * count metric ties at 0 in its lower tail (deaths, denies), so that the dev mode meets ties.
 *
 * The answer does not depend on the cohort asked for.
 *
 * @returns The raw body of the answer.
 */
export function createMetricBenchmarkFixture(): Readonly<Record<string, RawMetricStatistics>> {
  return {
    kda: metricStatistics(7.6, 8, [0.2, 0.6, 0.8, 1.5, 4.3, 10.9, 21.1, 24.8, 30.9]),
    player_damage_per_min: metricStatistics(
      660,
      228,
      [233, 340, 400, 498, 633, 805, 963, 1064, 1274],
    ),
    accuracy: metricStatistics(0.57, 0.08, [0.4, 0.45, 0.48, 0.53, 0.59, 0.64, 0.68, 0.71, 0.76]),
    deaths: metricStatistics(4.04, 2.74, [0, 0, 1.01, 1.99, 4.02, 5.99, 7.93, 8.94, 10.9]),
    player_damage_taken_per_min: metricStatistics(
      494,
      170,
      [153, 233, 279, 369, 488, 608, 728, 789, 907],
    ),
    net_worth_per_min: metricStatistics(
      1067,
      173,
      [686, 773, 837, 925, 1086, 1176, 1274, 1353, 1466],
    ),
    last_hits: metricStatistics(137, 38, [60, 79, 91, 111, 136, 162, 187, 202, 233]),
    denies: metricStatistics(2.08, 2.34, [0, 0, 0, 0, 1.01, 2.97, 5, 7.03, 10.1]),
    teammate_healing: metricStatistics(
      2587,
      1823,
      [91, 408, 699, 1326, 2187, 3396, 4867, 6065, 8693],
    ),
    teammate_barriering: metricStatistics(
      5367,
      2654,
      [620, 1408, 2019, 3328, 5168, 7117, 8868, 9999, 12_213],
    ),
    boss_damage_per_min: metricStatistics(202, 162, [0, 9, 27, 74, 162, 296, 433, 518, 699]),
    // Metrics of the real answer that the app does not read.
    kills: metricStatistics(3.12, 2.1, [0, 0, 1, 1.99, 3.01, 4, 6, 7.1, 9]),
    assists: metricStatistics(12.9, 6.3, [2, 4, 5, 8, 12.1, 16.9, 21, 24, 30.9]),
    crit_shot_rate: metricStatistics(0.005, 0.014, [0, 0, 0, 0, 0, 0, 0.018, 0.039, 0.068]),
  };
}

/**
 * How a cumulative counter of the curve grows with the time of the match: its average at `t`
 * seconds is `linear × t + quadratic × t²` (a player earns faster as the match goes on), and its
 * standard deviation is `spread` times the average.
 */
interface CounterGrowth {
  readonly linear: number;
  readonly quadratic: number;
  readonly spread: number;
}

/**
 * The counters of the curve: the four the app reads and two it ignores, shaped after the community
 * of Paige (about 25 000 souls and 2.7 kills after 25 minutes).
 */
const CURVE_COUNTERS: Readonly<Record<string, CounterGrowth>> = {
  net_worth: { linear: 8.4, quadratic: 0.0055, spread: 0.14 },
  player_damage: { linear: 5.1, quadratic: 0.003, spread: 0.4 },
  boss_damage: { linear: 1.1, quadratic: 0.00094, spread: 1 },
  kills: { linear: 0.00177, quadratic: 0, spread: 0.9 },
  deaths: { linear: 0.00233, quadratic: 0, spread: 0.65 },
  assists: { linear: 0.0064, quadratic: 0, spread: 0.55 },
};

/** The time of the first point of the curve, and the distance between the points up to 900 s. */
const FIRST_CURVE_STEP_S = 180;

/** The time up to which the points are `FIRST_CURVE_STEP_S` apart. */
const FINE_CURVE_END_S = 900;

/** The distance between the points once past `FINE_CURVE_END_S`. */
const COARSE_CURVE_STEP_S = 300;

/** The longest match the API filters on (`max_duration_s` goes from 0 to this). */
const LONGEST_MATCH_S = 7000;

/**
 * Round a number to two decimals, like the figures of the real answer.
 *
 * @param value - Any number.
 * @returns The rounded number.
 */
function roundToHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Build one point of the curve.
 *
 * @param timeS - The time of the point, in seconds since the start of the match.
 * @returns The point: `game_time`, then the average and the deviation of each counter.
 */
function curvePoint(timeS: number): RawCurvePoint {
  const point: Record<string, number> = { game_time: timeS };
  for (const [counter, growth] of Object.entries(CURVE_COUNTERS)) {
    const average = growth.linear * timeS + growth.quadratic * timeS ** 2;
    point[`${counter}_avg`] = roundToHundredths(average);
    point[`${counter}_std`] = roundToHundredths(average * growth.spread);
  }
  return point;
}

/**
 * Imitate what deadlock-api answers to `GET /v1/analytics/player-performance-curve` with
 * `resolution=0`: one point at 180, 360, 540, 720 and 900 seconds, then one every 300 seconds, as
 * far as the longest match of the window. The averages are cumulative since the start of the match,
 * so every average and every deviation grows from one point to the next.
 *
 * @param maxDurationS - The longest match of the window, in seconds (inclusive); the whole range of
 *   the API by default. A window shorter than 180 seconds has no point.
 * @returns The raw points of the answer, in the order of time.
 */
export function createPerformanceCurveFixture(
  maxDurationS: number = LONGEST_MATCH_S,
): RawCurvePoint[] {
  const points: RawCurvePoint[] = [];
  for (
    let timeS = FIRST_CURVE_STEP_S;
    timeS <= maxDurationS;
    timeS += timeS < FINE_CURVE_END_S ? FIRST_CURVE_STEP_S : COARSE_CURVE_STEP_S
  ) {
    points.push(curvePoint(timeS));
  }
  return points;
}

/**
 * Build a row of the hero statistics.
 *
 * @param heroId - The hero.
 * @param wins - Number of matches won.
 * @param losses - Number of matches lost.
 * @returns The row, with its total of matches.
 */
function heroSample(heroId: HeroId, wins: number, losses: number): RawHeroSample {
  return { hero_id: heroId, wins, losses, matches: wins + losses };
}

/**
 * Imitate what deadlock-api answers to `GET /v1/analytics/hero-stats`: one row per hero. Paige holds
 * 2422 matches (1439 won, 983 lost), and two other heroes of the hero catalogue of the fixtures
 * have a row too. The answer does not depend on the cohort asked for.
 *
 * @returns The raw rows of the answer.
 */
export function createHeroSamplesFixture(): RawHeroSample[] {
  return [heroSample(1, 1190, 920), heroSample(2, 1021, 853), heroSample(PAIGE_HERO_ID, 1439, 983)];
}

/**
 * Imitate what deadlock-api answers to `GET /v1/players/{account_id}/rank` for the player the
 * fixtures follow: Sentinel 4 (badge 44).
 *
 * @returns The raw body of the answer.
 */
export function createPlayerRankFixture(): RawPlayerRank {
  return { badge: 44, rank: 4, subrank: 4, last_match: null };
}

/**
 * Imitate what deadlock-api answers to `GET /v1/players/{account_id}/rank` when none of the recent
 * ranked matches of the player reports a rank (a player still in the placement matches, or one the
 * API knows nothing of): the Obscurus tier, badge 0.
 *
 * @returns The raw body of the answer.
 */
export function createUnrankedPlayerRankFixture(): RawPlayerRank {
  return { badge: 0, rank: 0, subrank: 0, last_match: null };
}
