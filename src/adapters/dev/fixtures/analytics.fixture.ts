/**
 * Synthetic community data served by the development HTTP client: what deadlock-api answers to the
 * five requests of the match analysis and the review (the benchmark of the metrics, the performance
 * curve, the statistics of the heroes, the rank of a player, and the purchases of the items by
 * minute), in the raw shape of the API (reduced to the fields the app reads and a few it ignores,
 * like the real answers).
 *
 * No real player is described here. The numbers are invented, close to what the community of Paige
 * looks like: they only have to be plausible and the same every time, so that the dev mode and the
 * tests always see the same comparison.
 *
 * @packageDocumentation
 */
import { PAIGE_HERO_ID, type HeroId } from '../../../core/domain/hero';
import {
  FIXTURE_ITEM_CATALOGUE,
  FIXTURE_RESISTANCE_ITEM_IDS,
  FIXTURE_SHOP_ITEM_IDS,
} from './assets.fixture';

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

/**
 * One row of the item statistics, in the raw shape of the API: the purchases of one item in one
 * minute of the game (all the fields of a real row).
 */
export interface RawItemStatsRow {
  readonly item_id: number;
  /** The minute of the game the purchases were made in: 14 stands for 14:00 to 14:59. */
  readonly bucket: number;
  readonly wins: number;
  readonly losses: number;
  /** The purchases: `wins + losses`. */
  readonly matches: number;
  /** The distinct buyers. */
  readonly players: number;
  /** The mean second of the purchases, from the start of the match. */
  readonly avg_buy_time_s: number;
  /** The mean second of the sales of the purchases that were sold, 0 when none was. */
  readonly avg_sell_time_s: number;
  /** The mean buy time, as a percentage of the length of the match. */
  readonly avg_buy_time_relative: number;
  readonly avg_sell_time_relative: number;
  /** How many of the purchases were sold later. */
  readonly sold: number;
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
 * The counters of the curve: the five the app reads and one it ignores, shaped after the community
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

/** The first minute of the game the item statistics hold purchases of. */
const FIRST_ITEM_MINUTE = 6;

/** The last minute of the game the item statistics hold purchases of. */
const LAST_ITEM_MINUTE = 40;

/** The tiers of the shop items the item statistics describe: the three the review looks at. */
type ItemStatsTier = 2 | 3 | 4;

/**
 * The minute in which an item of each tier is bought most, as in the real answer: a tier 2 item
 * around 13:00, a tier 3 around 28:00 and a tier 4 around 35:00. An item's own peak is up to a
 * minute away from it (see {@link createItemStatsFixture}).
 */
const ITEM_PEAK_MINUTE_BY_TIER: Readonly<Record<ItemStatsTier, number>> = { 2: 13, 3: 28, 4: 35 };

/**
 * How many minutes away from its peak an item of each tier is still bought, exclusive: an item is
 * bought in the minutes closer to its peak than this, and in no other. The later the tier, the
 * wider the run of minutes. With the peaks above, no tier 2 item is bought after minute 21 and no
 * tier 4 item before minute 25.
 */
const ITEM_REACH_MINUTES_BY_TIER: Readonly<Record<ItemStatsTier, number>> = { 2: 8, 3: 12, 4: 10 };

/** How many times the least bought item is bought in its busiest minute. */
const PEAK_PURCHASES_BASE = 120;

/**
 * How many more times each next item is bought in its busiest minute: the items go through seven
 * sizes (the base, then the base plus one to six steps) and start over, so that the histograms
 * differ in size.
 */
const PEAK_PURCHASES_STEP = 50;

/** The share of the purchases of a minute that were in a won match. */
const ITEM_WIN_RATE = 0.55;

/** The share of the purchases of a minute that were made by a distinct player. */
const ITEM_BUYER_RATE = 0.85;

/** How rare a sale is: one purchase in this many is sold again. */
const ITEM_SOLD_ONE_IN = 8;

/** How long after the purchase a sold item is sold, in seconds. */
const ITEM_SOLD_AFTER_S = 300;

/** The length of a match that the relative times of the item statistics are taken against. */
const ITEM_MATCH_LENGTH_S = 2200;

/**
 * The shop items the fixture item statistics describe besides the resistance items: the first four
 * of the catalogue, since the real answer holds every item and not only the ones a rule looks for.
 */
const ITEM_STATS_OTHER_ITEM_IDS: readonly number[] = FIXTURE_SHOP_ITEM_IDS.filter(
  (itemId) => !FIXTURE_RESISTANCE_ITEM_IDS.includes(itemId),
).slice(0, 4);

/**
 * The tier of a shop item of the fixture catalogue.
 *
 * @param itemId - The id of the item.
 * @returns Its tier, 2 to 4.
 * @throws Error when the catalogue holds no shop item under that id, or one of a tier the item
 *   statistics do not describe (a mistake of the fixtures, not of the data).
 */
function shopItemTier(itemId: number): ItemStatsTier {
  const entry = FIXTURE_ITEM_CATALOGUE.find((item) => item.id === itemId);
  if (entry?.type !== 'upgrade') {
    throw new Error('The fixture item catalogue has no shop item for an item of the statistics');
  }
  const tier = entry.item_tier;
  if (tier !== 2 && tier !== 3 && tier !== 4) {
    throw new Error(`The item statistics describe no item of tier ${String(tier)}`);
  }
  return tier;
}

/**
 * Build the row of the item statistics for one item in one minute.
 *
 * @param itemId - The item.
 * @param minute - The minute of the game.
 * @param purchases - How many times the item was bought in that minute (1 or more).
 * @returns The row.
 */
function itemStatsRow(itemId: number, minute: number, purchases: number): RawItemStatsRow {
  const wins = Math.round(purchases * ITEM_WIN_RATE);
  const sold = Math.floor(purchases / ITEM_SOLD_ONE_IN);
  // The mean buy time falls inside the minute, and moves a little with the number of purchases.
  const buyTimeS = minute * 60 + 15 + (purchases % 30);
  const sellTimeS = sold === 0 ? 0 : buyTimeS + ITEM_SOLD_AFTER_S;
  const relativeTo = (timeS: number): number =>
    roundToHundredths(Math.min(100, (timeS / ITEM_MATCH_LENGTH_S) * 100));
  return {
    item_id: itemId,
    bucket: minute,
    wins,
    losses: purchases - wins,
    matches: purchases,
    players: Math.max(1, Math.round(purchases * ITEM_BUYER_RATE)),
    avg_buy_time_s: buyTimeS,
    avg_sell_time_s: sellTimeS,
    avg_buy_time_relative: relativeTo(buyTimeS),
    avg_sell_time_relative: relativeTo(sellTimeS),
    sold,
  };
}

/**
 * Imitate what deadlock-api answers to `GET /v1/analytics/item-stats` with `bucket=game_time_min`
 * and `min_matches=1`: one row per item and minute that holds a purchase. It describes the twelve
 * resistance items and four other shop items, within the minutes 6 to 40.
 *
 * The purchases of an item make a hump around its peak minute: the minute of its tier (see
 * `ITEM_PEAK_MINUTE_BY_TIER`), moved by a minute earlier, none or a minute later by turns from one
 * item to the next. The hump is a parabola that reaches 0 at `ITEM_REACH_MINUTES_BY_TIER` minutes
 * from the peak, so an item is bought in a run of consecutive minutes and the others hold no row,
 * like the minutes of a real answer in which nobody bought the item: a tier 4 item has no row for
 * the early minutes, and a tier 2 item none for the late ones. A count takes basic arithmetic only
 * (no `Math.exp` or `Math.pow`), so that it is the same on every engine. The answer does not depend
 * on the community asked for.
 *
 * @returns The raw rows of the answer: item by item (the resistance items first), minute by minute.
 * @throws Error when an item has no tier 2 to 4 in the fixture item catalogue.
 */
export function createItemStatsFixture(): RawItemStatsRow[] {
  const rows: RawItemStatsRow[] = [];
  const itemIds = [...FIXTURE_RESISTANCE_ITEM_IDS, ...ITEM_STATS_OTHER_ITEM_IDS];
  for (const [index, itemId] of itemIds.entries()) {
    const tier = shopItemTier(itemId);
    const peakMinute = ITEM_PEAK_MINUTE_BY_TIER[tier] + (index % 3) - 1;
    const reach = ITEM_REACH_MINUTES_BY_TIER[tier];
    const peakPurchases = PEAK_PURCHASES_BASE + PEAK_PURCHASES_STEP * (index % 7);
    for (let minute = FIRST_ITEM_MINUTE; minute <= LAST_ITEM_MINUTE; minute += 1) {
      // A parabola: all the purchases of the peak at the peak, none at `reach` minutes from it.
      const offset = (minute - peakMinute) / reach;
      const weight = Math.max(0, 1 - offset * offset);
      const purchases = Math.round(peakPurchases * weight);
      if (purchases >= 1) {
        rows.push(itemStatsRow(itemId, minute, purchases));
      }
    }
  }
  return rows;
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
