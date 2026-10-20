/**
 * The references a match value is compared with: the player's own habits, and the community curve.
 *
 * - The **habits** are the values of the player's earlier matches. A value is compared with their
 *   median, and its distance to it is read in robust standard deviations (the median absolute
 *   deviation, scaled), which a single odd match does not distort.
 * - The **community curve** gives, at each time of the match, the average and the standard deviation
 *   of a cumulative counter over a cohort. Comparing a span of the match with the community means
 *   turning the curve into a rate over that span, with the spread of that rate, and placing the
 *   player's own rate on a normal distribution that has the two.
 *
 * Everything here is pure arithmetic on numbers. The callers decide which values to compare, orient
 * the result so that higher is better, and guard the missing data. Inputs are the finite numbers
 * stored with the archive: a `NaN` is not expected and is not handled.
 *
 * @packageDocumentation
 */
import type { CurvePoint } from '../deadlock-api/performance-curve.schema';
import {
  CURVE_ABOVE_Z,
  CURVE_WELL_Z,
  MAD_SCALE,
  MIN_PERSONAL_MATCHES,
} from './insights/thresholds';
import type { CurveStat } from './metric';
import {
  interpolate,
  median,
  medianAbsoluteDeviation,
  normalCdf,
  PERCENTILE_POINTS,
} from './statistics';

/** How many seconds make a minute: the curve is read in seconds, its rates are per minute. */
const SECONDS_PER_MINUTE = 60;

/** The lowest placement on the curve: the same bound as a placement among community percentiles. */
const LOWEST_PERCENTILE = Math.min(...PERCENTILE_POINTS);

/** The highest placement on the curve: the same bound as a placement among community percentiles. */
const HIGHEST_PERCENTILE = Math.max(...PERCENTILE_POINTS);

/**
 * The point every cumulative counter starts from: nothing was earned at the start of the match, so
 * the curve is read from an average of 0 and a deviation of 0 at 0 s, whether or not the cohort's
 * own points reach back that far (they usually start at 180 s).
 */
const MATCH_START: readonly [timeS: number, value: number] = [0, 0];

/**
 * How a value differs from the player's habits:
 *
 * - `relative`: a share of the usual value, `ratio` (0.12 is 12 % above, -0.2 is 20 % below).
 * - `absolute`: an `amount` in the unit shown (2 is two more deaths than usual).
 *
 * Neither is oriented: a positive difference means a higher value, not a better one.
 */
export type Difference =
  | { readonly kind: 'relative'; readonly ratio: number }
  | { readonly kind: 'absolute'; readonly amount: number };

/** What {@link comparePersonal} compares. */
export interface PersonalComparisonInput {
  /**
   * The value of the match, in the unit it is compared in: for a metric compared per minute, the
   * rate of the match, not its total.
   */
  readonly value: number;
  /**
   * The values of the player's earlier matches in that same unit, in any order (the callers pass
   * the most recent ones).
   */
  readonly previous: readonly number[];
  /**
   * How the difference is shown: `relative` as a share of the usual value, `absolute` in the shown
   * unit. A `relative` difference falls back to an absolute one when the usual value is 0.
   */
  readonly display: 'relative' | 'absolute';
  /**
   * The factor that converts the compared unit back to the shown one:
   * - this match's length in minutes for a metric compared per minute (a rate becomes a total);
   * - the length in minutes of the phase in this match for a phase metric, which is stored as a
   *   rate over its phase and shown as the total of the phase, like the totals of the phase table
   *   (a median of 0.4 kills a minute is shown as 3.5 kills over a phase of 8.7 minutes);
   * - 1 otherwise.
   */
  readonly scale: number;
}

/** How one match value differs from the player's habits. */
export interface PersonalComparison {
  /** How many earlier matches the habits are made of. */
  readonly count: number;
  /** The usual value (the median of the earlier matches), in the shown unit. */
  readonly median: number;
  /**
   * The robust z-score of the value: its distance to the median in standard deviations estimated
   * from the median absolute deviation. Positive means a higher value, not a better one (the
   * caller orients it). `null` when the earlier matches do not vary at all (a deviation of 0):
   * there is then no scale to read the distance in.
   */
  readonly z: number | null;
  /** The difference with the usual value. */
  readonly difference: Difference;
}

/**
 * Compare the value of a match with the player's habits.
 *
 * The usual value is the median of the earlier matches and the z-score is
 * `(value - median) / (MAD_SCALE × MAD)`, the median absolute deviation (MAD) scaled to stand for a
 * standard deviation. Both the value and the earlier matches are taken in the compared unit, so
 * that a long match does not stand out only because it is long; `scale` converts the median and an
 * absolute difference back to the shown unit. The z-score and a relative difference are ratios of
 * numbers in the same unit, so the scale does not change them.
 *
 * @param input - What to compare, see {@link PersonalComparisonInput}. The earlier matches are not
 * modified.
 * @returns The comparison, or `null` when there are fewer earlier matches than
 * {@link MIN_PERSONAL_MATCHES}: the habits are then too few to say anything.
 */
export function comparePersonal(input: PersonalComparisonInput): PersonalComparison | null {
  const { value, previous, display, scale } = input;
  if (previous.length < MIN_PERSONAL_MATCHES) {
    return null;
  }
  const usual = median(previous);
  const spread = MAD_SCALE * medianAbsoluteDeviation(previous, usual);
  const gap = value - usual;
  return {
    count: previous.length,
    median: usual * scale,
    z: spread === 0 ? null : gap / spread,
    // A share of 0 is undefined, so a usual value of 0 is compared in absolute terms.
    difference:
      display === 'relative' && usual !== 0
        ? { kind: 'relative', ratio: gap / Math.abs(usual) }
        : { kind: 'absolute', amount: gap * scale },
  };
}

/**
 * Read one series of the community curve (the averages or the deviations of a counter) at a time
 * of the match.
 *
 * @param curve - The points of the curve, sorted by time.
 * @param timeS - The time to read, in seconds since the start of the match.
 * @param read - Which number to take from each point.
 * @returns The series at `timeS`, interpolated linearly between the two points around it, or
 * `null` outside the curve or for an empty curve.
 */
function readSeries(
  curve: readonly CurvePoint[],
  timeS: number,
  read: (point: CurvePoint) => number,
): number | null {
  // Without a single point nothing is known about the cohort, not even the start of the match.
  if (curve.length === 0) {
    return null;
  }
  const points = curve.map((point): readonly [number, number] => [point.timeS, read(point)]);
  // A point of the cohort at 0 s speaks for itself: the implied start would shadow it.
  const hasStart = curve.some((point) => point.timeS === 0);
  return interpolate(hasStart ? points : [MATCH_START, ...points], timeS);
}

/**
 * Read the community curve of a counter at a time of the match.
 *
 * The average and the deviation are interpolated separately, linearly between the two points around
 * the time. The curve is read from the start of the match (a cumulative counter is 0 there, with no
 * deviation) up to its last point, and never extrapolated.
 *
 * @param curve - The points of the curve, sorted by time (as the performance curve reader gives
 * them).
 * @param stat - The counter to read.
 * @param timeS - The time to read, in seconds since the start of the match.
 * @returns The average and the standard deviation of the counter at that time, or `null` when the
 * time is before the start of the match or after the last point, and for an empty curve.
 */
export function curvePoint(
  curve: readonly CurvePoint[],
  stat: CurveStat,
  timeS: number,
): { readonly avg: number; readonly std: number } | null {
  const avg = readSeries(curve, timeS, (point) => point.avg[stat]);
  const std = readSeries(curve, timeS, (point) => point.std[stat]);
  // Both series share their times, so they are both there or both missing; checking both narrows
  // the types.
  return avg === null || std === null ? null : { avg, std };
}

/** The community's rate of a counter over a span of the match, and how much it varies. */
export interface CurveRate {
  /** The average rate of the cohort, in units of the counter per minute. */
  readonly rate: number;
  /** The standard deviation of that rate across the players of the cohort, per minute. */
  readonly sigma: number;
}

/**
 * The community's rate of a counter over a span of the match.
 *
 * The rate is the growth of the average over the span, per minute. The curve does not give the
 * deviation of the growth, so it is estimated from the deviations at both ends. This is the first
 * approximation of the curve: it assumes that what a player gains during the span is independent of
 * what the player had at its start, so that variances add up, `σ_end² = σ_start² + σ_gain²`, and
 * `σ_gain = √(σ_end² − σ_start²)`. The assumption does not always hold (a player who is ahead tends
 * to stay ahead), and the cohort at a late point is not quite the cohort at an early one (only the
 * longer matches reach it). When the deviation at the end is not larger than at the start, the
 * formula has no solution and `σ_end` is taken instead. Dividing by the length of the span in
 * minutes gives the deviation of the rate.
 *
 * @param curve - The points of the curve, sorted by time.
 * @param stat - The counter to read.
 * @param startS - The start of the span, in seconds since the start of the match.
 * @param endS - The end of the span, in seconds since the start of the match.
 * @returns The rate and its deviation, or `null` when the span is empty or backwards, or when
 * either end is off the curve (see {@link curvePoint}).
 */
export function curveRate(
  curve: readonly CurvePoint[],
  stat: CurveStat,
  startS: number,
  endS: number,
): CurveRate | null {
  if (endS <= startS) {
    return null;
  }
  const start = curvePoint(curve, stat, startS);
  const end = curvePoint(curve, stat, endS);
  if (start === null || end === null) {
    return null;
  }
  const minutes = (endS - startS) / SECONDS_PER_MINUTE;
  const gainSigma = end.std > start.std ? Math.sqrt(end.std ** 2 - start.std ** 2) : end.std;
  return { rate: (end.avg - start.avg) / minutes, sigma: gainSigma / minutes };
}

/** How a rate compares with the community's: from far above its average to far below it. */
export type CurveLabel = 'well_above' | 'above' | 'around' | 'below' | 'well_below';

/**
 * Name the distance of a rate to the community's average.
 *
 * A z-score of at least {@link CURVE_WELL_Z} is well above, at least {@link CURVE_ABOVE_Z} is above,
 * strictly between minus {@link CURVE_ABOVE_Z} and {@link CURVE_ABOVE_Z} is around the average, and
 * the negative side mirrors the positive one: down to `-CURVE_ABOVE_Z` included is below, down to
 * `-CURVE_WELL_Z` included is well below. So 1 is well above, 0.5 is above, 0.49 is around, -0.5 is
 * below and -1 is well below.
 *
 * @param z - The distance of a rate to the average, in standard deviations.
 * @returns The label.
 */
export function curveLabel(z: number): CurveLabel {
  if (z >= CURVE_WELL_Z) {
    return 'well_above';
  }
  if (z >= CURVE_ABOVE_Z) {
    return 'above';
  }
  if (z > -CURVE_ABOVE_Z) {
    return 'around';
  }
  if (z > -CURVE_WELL_Z) {
    return 'below';
  }
  return 'well_below';
}

/** Where a rate stands among the community's. */
export interface CurvePlacement {
  /** The distance of the rate to the community's average, in standard deviations. */
  readonly z: number;
  /**
   * The share of the community (from 1 to 99) that has a lower rate. A high percentile is not a
   * good one by itself: the caller turns it for the metrics where lower is better.
   */
  readonly percentile: number;
  /** The label of the distance, see {@link curveLabel}. */
  readonly label: CurveLabel;
}

/**
 * Place the player's rate on the community's.
 *
 * The community's rate is taken as a normal distribution with the average `rate` and the deviation
 * `sigma`, so the placement is `Φ((playerRate − rate) / sigma)`, clamped to the same range as a
 * placement among percentiles (1 to 99). This is the second approximation of the curve: the curve
 * only gives a mean and a spread, and the real distribution is skewed for the counters that cannot
 * go below 0 and are often small (damage to objectives, kills), so the percentile is approximate
 * there, and the z-score is the more faithful of the two.
 *
 * @param playerRate - The player's rate over the same span as `community`, in the same unit.
 * @param community - The community's rate over that span, see {@link curveRate}.
 * @returns The placement, or `null` when `community.sigma` is not a finite number above 0: without
 * a spread there is no scale to place a rate on.
 */
export function placeOnCurve(playerRate: number, community: CurveRate): CurvePlacement | null {
  if (!Number.isFinite(community.sigma) || community.sigma <= 0) {
    return null;
  }
  const z = (playerRate - community.rate) / community.sigma;
  return {
    z,
    percentile: Math.min(HIGHEST_PERCENTILE, Math.max(LOWEST_PERCENTILE, 100 * normalCdf(z))),
    label: curveLabel(z),
  };
}
