/**
 * The rules every row of the review of the player's last matches applies: when a match is weak or
 * strong for a point, where a buy minute stands among the purchases of a tier, whether a figure
 * progressed between the last matches and the ones before, and on which side of the summary a point
 * is listed.
 *
 * They are pure arithmetic on numbers the rest of the review already computed, kept apart from the
 * code that gathers those numbers so that each rule is stated once, with its threshold, and read the
 * same way by every tab. The thresholds are in `../insights/thresholds`: none of them is a literal
 * here, and tuning a rule is a change of one number there.
 *
 * A mark is the verdict of one match on one point: `'weak'`, `'strong'`, or `null` for neither.
 * A point with no verdict on a match (the cohort is not known, the figure is missing) has no mark
 * at all; the callers count those matches apart.
 *
 * @packageDocumentation
 */
import { PERCENTILE_SCALE } from '../insights/insights';
import {
  DEATHS_BEFORE_RESISTANCE_WEAK,
  LANE_SOULS_CLEAR_GAP,
  MIN_PERSONAL_MATCHES,
  PLACE_STRONG_UP_TO,
  PLACE_WEAK_FROM,
  PROGRESS_MIN_Z,
  REVIEW_MIN_FLAGGED_SHARE,
  STRENGTH_PERCENTILE,
  WEAKNESS_PERCENTILE,
} from '../insights/thresholds';
import { HIGHEST_PLACEMENT, LOWEST_PLACEMENT, median } from '../statistics';

/** The verdict of one match on one point: it is weak or strong for it. */
export type ReviewMark = 'weak' | 'strong';

/**
 * How a figure moved between the matches before and the last ones.
 *
 * It holds the figure of the earlier window and not the one of the last matches: the row already
 * has that one, and shows both side by side.
 */
export interface ReviewProgress {
  /**
   * The centre (mean or median, as asked) of the earlier matches; `null` when there are fewer than
   * {@link MIN_PERSONAL_MATCHES} of them, as a centre of fewer values says too little to show.
   */
  readonly before: number | null;
  /**
   * Whether the figure improved, got worse or stayed about the same (a change that the spread of the
   * matches explains); `null` when it cannot be told: fewer than {@link MIN_PERSONAL_MATCHES} values
   * in either window, or a point that is neither better nor worse when higher.
   */
  readonly direction: 'better' | 'worse' | 'stable' | null;
}

/**
 * The last place of Valve's top three of a match: 1 to 3 are in it, and the player who is not in it
 * has the rank 0.
 */
const VALVE_TOP_RANKS = 3;

/** Where in its minute a purchase counts for a mean: halfway, as a bucket spans a whole minute. */
const MINUTE_MIDDLE = 0.5;

/**
 * Mark a community placement that is already oriented so that higher is better.
 *
 * @param oriented - The oriented percentile (see `orientedPercentile`).
 * @returns `'weak'` up to {@link WEAKNESS_PERCENTILE}, `'strong'` from {@link STRENGTH_PERCENTILE},
 *   and `null` in between.
 */
export function markOfPercentile(oriented: number): ReviewMark | null {
  if (oriented <= WEAKNESS_PERCENTILE) {
    return 'weak';
  }
  return oriented >= STRENGTH_PERCENTILE ? 'strong' : null;
}

/**
 * Mark the place of the player among the twelve players of a match on a figure of the scoreboard.
 *
 * @param place - The place, 1 for the best.
 * @returns `'strong'` up to {@link PLACE_STRONG_UP_TO}, `'weak'` from {@link PLACE_WEAK_FROM}, and
 *   `null` for the places in between.
 */
export function markOfPlace(place: number): ReviewMark | null {
  if (place >= PLACE_WEAK_FROM) {
    return 'weak';
  }
  return place <= PLACE_STRONG_UP_TO ? 'strong' : null;
}

/**
 * Mark the place of the player in Valve's top three of a match.
 *
 * @param rank - The rank stored for the match: 1 to 3 in the top three, 0 outside it.
 * @returns `'strong'` in the top three and `null` outside it: missing it says nothing, as only
 *   three of the twelve players have it.
 */
export function markOfValveRank(rank: number): ReviewMark | null {
  return rank >= 1 && rank <= VALVE_TOP_RANKS ? 'strong' : null;
}

/**
 * Mark the deaths of the player before their first resistance item.
 *
 * @param deaths - How many times the player died before the purchase (all of their deaths when
 *   the match has none).
 * @returns `'weak'` from {@link DEATHS_BEFORE_RESISTANCE_WEAK} deaths, `'strong'` for none at all,
 *   and `null` in between.
 */
export function markOfDeathsBeforeResistance(deaths: number): ReviewMark | null {
  if (deaths >= DEATHS_BEFORE_RESISTANCE_WEAK) {
    return 'weak';
  }
  return deaths === 0 ? 'strong' : null;
}

/**
 * Mark the lane at 10 minutes by the gap in souls with the lane opponent.
 *
 * @param gap - The player's souls minus their opponent's, so a positive gap is a lane that was won.
 * @returns `'weak'` from a gap of {@link LANE_SOULS_CLEAR_GAP} souls behind, `'strong'` from the same
 *   gap ahead, and `null` for a lane that was even.
 */
export function markOfLaneGap(gap: number): ReviewMark | null {
  if (gap <= -LANE_SOULS_CLEAR_GAP) {
    return 'weak';
  }
  return gap >= LANE_SOULS_CLEAR_GAP ? 'strong' : null;
}

/**
 * The buckets of a histogram that hold purchases, as `[minute, count]`. A bucket with no purchase
 * (or a count that is not a positive number) says nothing and is left out, so that the callers
 * divide by a total that is never 0 and never `NaN`.
 *
 * @param histogram - The purchases of the tier, by minute of the match.
 * @returns The non-empty buckets.
 */
function purchasesOf(
  histogram: ReadonlyMap<number, number>,
): readonly (readonly [minute: number, count: number])[] {
  return [...histogram].filter(([, count]) => count > 0);
}

/**
 * Place a buy minute among the purchases of a tier: the percentile of the minute, where a low one
 * is an early purchase.
 *
 * It is the share of the purchases made at an earlier minute, plus half of those made at the same
 * minute (a tie is split in two), as a percentile and clamped to the bounds of a community
 * placement, {@link LOWEST_PLACEMENT} to {@link HIGHEST_PLACEMENT}. Earlier is better for a
 * purchase, so the caller orients the result with `'lower'` (see `orientedPercentile`) before it
 * marks it.
 *
 * @param minute - The minute of the match the player bought the item at. The buckets of the
 *   histogram are whole minutes, so a fractional minute is floored to the bucket it falls in.
 * @param histogram - The purchases of the tier, by minute of the match.
 * @returns The percentile, or `null` when the histogram holds no purchase.
 */
export function placeInHistogram(
  minute: number,
  histogram: ReadonlyMap<number, number>,
): number | null {
  const bucketOfMinute = Math.floor(minute);
  let total = 0;
  let earlier = 0;
  let same = 0;
  for (const [bucket, count] of purchasesOf(histogram)) {
    total += count;
    if (bucket < bucketOfMinute) {
      earlier += count;
    } else if (bucket === bucketOfMinute) {
      same += count;
    }
  }
  if (total === 0) {
    return null;
  }
  // Multiplying before dividing keeps the exact result when the counts are whole numbers.
  const place = ((earlier + same / 2) * PERCENTILE_SCALE) / total;
  return Math.min(HIGHEST_PLACEMENT, Math.max(LOWEST_PLACEMENT, place));
}

/**
 * The mean buy minute of a tier, weighted by purchases.
 *
 * A bucket stands for a whole minute, so each purchase counts at the middle of its minute
 * (`minute + 0.5`): a tier that buys everything in the 12th minute has a mean of 12.5, not 12.
 *
 * @param histogram - The purchases of the tier, by minute of the match.
 * @returns The mean minute, or `null` when the histogram holds no purchase.
 */
export function histogramMean(histogram: ReadonlyMap<number, number>): number | null {
  let total = 0;
  let weighted = 0;
  for (const [minute, count] of purchasesOf(histogram)) {
    total += count;
    weighted += (minute + MINUTE_MIDDLE) * count;
  }
  return total === 0 ? null : weighted / total;
}

/**
 * The sum of a list of numbers.
 *
 * @param values - The numbers.
 * @returns Their sum, 0 for none.
 */
function sumOf(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

/**
 * The mean of a list of numbers.
 *
 * @param values - The numbers.
 * @returns Their mean, or `null` for none: the mean of nothing is not 0.
 */
export function meanOf(values: readonly number[]): number | null {
  return values.length === 0 ? null : sumOf(values) / values.length;
}

/**
 * The sample variance of a list of numbers: the mean squared distance to their mean, divided by
 * `n − 1` (the usual estimate of the spread of the matches a window was drawn from).
 *
 * @param values - The numbers.
 * @returns The variance; 0 for fewer than two values, which have no spread to measure.
 */
function sampleVarianceOf(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const mean = sumOf(values) / values.length;
  return sumOf(values.map((value) => (value - mean) ** 2)) / (values.length - 1);
}

/**
 * The centre of a window of values.
 *
 * @param values - The numbers; not empty.
 * @param center - Whether the centre is the mean or the median.
 * @returns The centre.
 */
function centerOf(values: readonly number[], center: 'mean' | 'median'): number {
  return center === 'median' ? median(values) : sumOf(values) / values.length;
}

/**
 * Tell how a figure moved between the matches before and the last ones.
 *
 * The change is the difference between the centres of the two windows. It counts when it is at
 * least {@link PROGRESS_MIN_Z} standard errors of that difference; a smaller change is `'stable'`.
 * The standard error is `√(s²_now / n_now + s²_before / n_before)`, with `s²` the sample variance
 * (`n − 1`) of a window. It is the error of a difference of means, and the same formula serves
 * both centres: a median has no error as simple as that, and in both cases the rule weighs the
 * change against the spread of the matches.
 *
 * Without any spread (every value of a window the same) the error is 0: then any change at all
 * counts, however small, and no change is stable. A difference that only comes from the rounding
 * of the sums that make the means is no change: two windows of the same fractional value and of
 * two sizes (0.1 seven times and five times) have means that differ in their last digit. The mean of
 * `n` values carries an error of up to about `n` units of their last digit, so a difference of at
 * most that many, relative to the larger centre, is taken as none.
 *
 * @param now - The values of the last matches, finite numbers.
 * @param before - The values of the matches before them, finite numbers.
 * @param center - Whether the figure of a window is its mean or its median.
 * @param better - Which direction is an improvement, or `null` for a point that is neither better
 *   nor worse when higher (a damage share, a pick rate), which has no direction.
 * @returns The centre of the earlier window, and the direction (see {@link ReviewProgress}). Fewer
 *   than {@link MIN_PERSONAL_MATCHES} values in the earlier window give no centre, and in either
 *   window no direction.
 */
export function progressOf(
  now: readonly number[],
  before: readonly number[],
  center: 'mean' | 'median',
  better: 'higher' | 'lower' | null,
): ReviewProgress {
  const beforeCenter = before.length < MIN_PERSONAL_MATCHES ? null : centerOf(before, center);
  if (beforeCenter === null || now.length < MIN_PERSONAL_MATCHES || better === null) {
    return { before: beforeCenter, direction: null };
  }
  const nowCenter = centerOf(now, center);
  const change = nowCenter - beforeCenter;
  const standardError = Math.sqrt(
    sampleVarianceOf(now) / now.length + sampleVarianceOf(before) / before.length,
  );
  const roundingError =
    Number.EPSILON *
    Math.max(Math.abs(nowCenter), Math.abs(beforeCenter)) *
    Math.max(now.length, before.length);
  if (Math.abs(change) <= roundingError || Math.abs(change) < PROGRESS_MIN_Z * standardError) {
    return { before: beforeCenter, direction: 'stable' };
  }
  const rose = change > 0;
  const higherIsBetter = better === 'higher';
  return { before: beforeCenter, direction: rose === higherIsBetter ? 'better' : 'worse' };
}

/**
 * Decide on which side of the summary a point is listed, from how many of the matches that have a
 * mark are weak and how many are strong for it.
 *
 * A point is a weakness when it is weak in more matches than it is strong **and** in at least
 * {@link REVIEW_MIN_FLAGGED_SHARE} of the matches that have a mark: fewer than that is more likely
 * a few games than a habit. A strength is the mirror. A point that is flagged equally often on
 * both sides is on neither.
 *
 * @param weak - How many matches are weak for the point.
 * @param strong - How many matches are strong for it.
 * @param marked - How many matches have a mark for the point, weak, strong or neither; the share is
 *   of these, not of every match of the review.
 * @returns The side, or `null` when the point is listed on neither.
 */
export function flaggedSide(
  weak: number,
  strong: number,
  marked: number,
): 'weakness' | 'strength' | null {
  if (marked <= 0) {
    return null;
  }
  const minimum = REVIEW_MIN_FLAGGED_SHARE * marked;
  if (weak > strong && weak >= minimum) {
    return 'weakness';
  }
  return strong > weak && strong >= minimum ? 'strength' : null;
}
