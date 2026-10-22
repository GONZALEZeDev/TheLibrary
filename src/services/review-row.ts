/**
 * The row of one point of the review, summed up from the point's value in each of the last matches.
 *
 * Each tab judges its points its own way: a metric is placed among the percentiles or on the curve
 * of the tier above, a place among the players is judged by a fixed rule, and so on. What follows
 * the judgement is the same for every point, and it is done here once:
 *
 * - **the player's figure**, made of every match that has a value;
 * - **the comparison with the tier**: the player's compared figure, the tier's figure and the gap
 *   between them, made of the matches compared with the tier only, the two figures of each match
 *   taken on the same stretch;
 * - **the marks**: how many matches a rule judged, and how many of them were weak or strong, which
 *   set the side of the summary;
 * - **the position** among the tier, the median of the placements;
 * - **the progress** against the matches before.
 *
 * The player's figure, both figures of the comparison and the progress share one centre, the median
 * or the mean, as the tier's figure of the point is one or the other. The position is always a
 * median: a placement is a rank among the tier, which a mean of ranks would not keep. A figure made
 * of fewer than `MIN_PERSONAL_MATCHES` values is not given, as a centre of so few says more about
 * the luck of the draw than about the player; the counts are always given.
 *
 * The tabs also place a match the same way, from the length of the match as the database holds it:
 * {@link placementBasisOf} works out what a point is placed from, once for all the points of a tab
 * ({@link placeMatches}, {@link placeReviewMatches}).
 *
 * And they build their rows the same way. A tab has points: each has a subject, a unit and a
 * direction, reads its value in a match, and judges the last matches by its own rules. What every tab
 * repeats is done here once ({@link pointRowOf}): a match without a value is left out, the last
 * matches are judged, the earlier ones give their values, and the row is summed up.
 *
 * Nothing here reads a database, a file or the network, and nothing is logged.
 *
 * @packageDocumentation
 */
import { durationWindowOf } from '../core/analysis/cohort';
import { MIN_PERSONAL_MATCHES } from '../core/analysis/insights/thresholds';
import { phaseSpans } from '../core/analysis/phases';
import { differenceOf } from '../core/analysis/references';
import {
  flaggedSide,
  meanOf,
  progressOf,
  type ReviewMark,
} from '../core/analysis/review/review-rules';
import { median } from '../core/analysis/statistics';
import type {
  CommunityComparison,
  CommunityReference,
  PlacementBasis,
} from './community-placement';
import type { RecentMatch } from './metrics.repository';
import type {
  ReviewMatch,
  ReviewMatchValue,
  ReviewRow,
  ReviewSubject,
  ReviewUnit,
} from './review-view';

/** How the figure of a list of matches is made: the median of their values, or their mean. */
export type ReviewCenter = 'median' | 'mean';

/** One of the last matches, judged on a point. */
export interface JudgedMatch {
  /** The value of the point in the match, and its mark. */
  readonly entry: ReviewMatchValue;
  /** Whether a rule judged the match: its mark, `null` included, is then a verdict that counts. */
  readonly marked: boolean;
  /**
   * Where the match stands among the tier above, oriented so that higher is better (1 to 99);
   * `null` when it was not placed among the tier.
   */
  readonly percentile: number | null;
  /**
   * The two figures of the match's comparison with the tier, in the unit of the row; `null` when it
   * was not compared with the tier (a match judged by a fixed rule is marked but not compared).
   */
  readonly comparison: CommunityComparison | null;
}

/** What the row of a point is built from. */
export interface ReviewRowInput {
  /** The point. */
  readonly subject: ReviewSubject;
  /** What the figures of the row count. */
  readonly unit: ReviewUnit;
  /** Which direction is an improvement, or `null` for a point that is neither. */
  readonly better: 'higher' | 'lower' | null;
  /** How the gap with the tier is shown: a share of the tier's figure, or an amount. */
  readonly display: 'relative' | 'absolute';
  /**
   * The centre of the player's figure, of both figures of the comparison and of the progress: the
   * one the tier's figure of the point is.
   */
  readonly center: ReviewCenter;
  /** The last matches that have a value for the point, most recent first, each judged. */
  readonly judged: readonly JudgedMatch[];
  /** The values of the point in the matches before the last ones. */
  readonly before: readonly number[];
}

/**
 * The centre of a list of values, when there are enough of them to tell.
 *
 * @param values - The values.
 * @param center - Whether the centre is the median or the mean.
 * @returns The centre, or `null` under {@link MIN_PERSONAL_MATCHES} values.
 */
function gatedCenterOf(values: readonly number[], center: ReviewCenter): number | null {
  if (values.length < MIN_PERSONAL_MATCHES) {
    return null;
  }
  return center === 'median' ? median(values) : meanOf(values);
}

/**
 * Sum up the judged matches of a point into its row.
 *
 * @param input - See {@link ReviewRowInput}.
 * @returns The row. Its figures are each made of their own matches: the player's figure of every
 *   match with a value, the comparison with the tier of the matches compared with it, the position
 *   of the matches placed among it (the same matches, for a point whose placement and comparison
 *   read the same data); each is `null` under {@link MIN_PERSONAL_MATCHES} of them.
 */
export function reviewRowOf(input: ReviewRowInput): ReviewRow {
  const { subject, unit, better, display, center, judged, before } = input;
  const values = judged.map(({ entry }) => entry.value);
  const marked = judged.filter((match) => match.marked);
  const weak = marked.filter(({ entry }) => entry.mark === 'weak').length;
  const strong = marked.filter(({ entry }) => entry.mark === 'strong').length;
  // Both figures of the comparison come from the same matches, so the gap is like for like.
  const comparisons = judged.flatMap(({ comparison }) => comparison ?? []);
  const comparedValue = gatedCenterOf(
    comparisons.map(({ player }) => player),
    center,
  );
  const reference = gatedCenterOf(
    comparisons.map(({ community }) => community),
    center,
  );
  const percentiles = judged.flatMap(({ percentile }) => percentile ?? []);
  return {
    subject,
    unit,
    better,
    value: gatedCenterOf(values, center),
    count: values.length,
    comparedValue,
    reference,
    difference:
      comparedValue === null || reference === null
        ? null
        : differenceOf(comparedValue, reference, display),
    percentile: gatedCenterOf(percentiles, 'median'),
    weak,
    strong,
    marked: marked.length,
    side: flaggedSide(weak, strong, marked.length),
    progress: progressOf(values, before, center, better),
    matches: judged.map(({ entry }) => entry),
  };
}

/**
 * What the points of a match are placed from: its phases and the duration window of its stored
 * rates, both from the length of the match as the database holds it, and its stored values.
 *
 * The stored rates were computed from the length the archive gives the match, which the match page
 * reads to check the two windows agree. The review reads no archive: it relies on the database and
 * the archive giving the same match the same length, as they do.
 *
 * @param match - The match.
 * @returns The basis of the placement.
 */
export function placementBasisOf(match: RecentMatch): PlacementBasis {
  return {
    spans: phaseSpans(match.durationS),
    ratesWindow: durationWindowOf(match.durationS),
    values: match.values,
  };
}

/**
 * A match of the player as a point reads it: the match and its stored values. This is all a point
 * needs of a match whose value it reads from the stored values alone (a place, the minute an item was
 * bought); a point that is read from the length of the match as well reads a {@link PlacedMatch}.
 */
export interface PointMatch {
  /** The match and its stored values. */
  readonly match: RecentMatch;
}

/** A match with what its points are placed from, worked out once for all the rows of a tab. */
export interface PlacedMatch extends PointMatch {
  /** What the points of the match are placed from. */
  readonly basis: PlacementBasis;
}

/** One of the last matches, placed, with the tier's data for its duration window. */
export interface PlacedReviewMatch extends PlacedMatch {
  /** The tier's data for the duration window of the match, or `null` when none is cached. */
  readonly reference: CommunityReference | null;
}

/**
 * Wrap matches as the points that are read from their stored values alone read them.
 *
 * @param matches - The matches.
 * @returns The matches as {@link PointMatch}es, in the same order.
 */
export function pointMatchesOf(matches: readonly RecentMatch[]): PointMatch[] {
  return matches.map((match) => ({ match }));
}

/**
 * Work out what the points of the matches are placed from, once for all the rows of a tab.
 *
 * @param matches - The matches.
 * @returns The matches with their basis ({@link placementBasisOf}), in the same order.
 */
export function placeMatches(matches: readonly RecentMatch[]): PlacedMatch[] {
  return matches.map((match) => ({ match, basis: placementBasisOf(match) }));
}

/**
 * Work out what the points of the last matches are placed from, once for all the rows of a tab.
 *
 * @param reviewMatches - The last matches, each with the tier's data for its duration window.
 * @returns The same matches with their basis, in the same order.
 */
export function placeReviewMatches(reviewMatches: readonly ReviewMatch[]): PlacedReviewMatch[] {
  return reviewMatches.map((reviewMatch) => ({
    ...reviewMatch,
    basis: placementBasisOf(reviewMatch.match),
  }));
}

/**
 * What one of the last matches says about a point once it has a value there: the verdict of a rule,
 * and the figures the row sums up. The value itself and the match it is of are the row's to add.
 */
export type Verdict = Pick<JudgedMatch, 'marked' | 'percentile' | 'comparison'> & {
  /** Whether the match is weak or strong for the point, or neither. */
  readonly mark: ReviewMark | null;
};

/** The verdict of a match no rule judged: no mark, no placement, no comparison with the tier. */
export const UNJUDGED: Verdict = { mark: null, marked: false, percentile: null, comparison: null };

/**
 * One point of a tab: what its row is about, how its figures are made, how a match gives its value
 * and how it is judged.
 *
 * It is generic over what a match carries. `Earlier` is what the value is read from: a
 * {@link PointMatch} for a point read from the stored values, a {@link PlacedMatch} for one that
 * needs the phases of the match as well. `Last` is what one of the last matches carries, which
 * includes what `Earlier` does, as the value is read from the last matches too, and what the
 * judgement needs (the tier's data, for a point that is placed among the tier).
 */
export interface ReviewPoint<Last extends Earlier, Earlier extends PointMatch = PointMatch> {
  /** The point. */
  readonly subject: ReviewSubject;
  /** What the figures of the row count. */
  readonly unit: ReviewUnit;
  /** Which direction is an improvement, or `null` for a point that is neither. */
  readonly better: 'higher' | 'lower' | null;
  /** How the gap with the tier is shown: a share of the tier's figure, or an amount. */
  readonly display: 'relative' | 'absolute';
  /** The centre of the figures of the row, see {@link ReviewRowInput.center}. */
  readonly center: ReviewCenter;
  /**
   * The value of the point in a match.
   *
   * @param match - A match of the player, among the last ones or the ones before.
   * @returns The value, or `null` when the match does not tell: it has no row to the point.
   */
  readonly valueIn: (match: Earlier) => number | null;
  /**
   * Judge one of the last matches that has a value for the point.
   *
   * @param match - The match, with whatever the judgement needs of it.
   * @param value - The value of the point in the match.
   * @returns The verdict, {@link UNJUDGED} when no rule judges the match.
   */
  readonly judge: (match: Last, value: number) => Verdict;
}

/**
 * Build the row of a point of a tab: the one skeleton every tab builds its rows on.
 *
 * A match where the point is unknown says nothing about it: it is left out of the row, not counted
 * as 0, and the judge is not asked about it. The others are judged one by one into a
 * {@link JudgedMatch}, and the earlier matches give their values through the same reader.
 *
 * @param point - The point.
 * @param recent - The last matches, most recent first.
 * @param before - The matches before them, which the progress compares with.
 * @returns The row ({@link reviewRowOf}).
 */
export function pointRowOf<Last extends Earlier, Earlier extends PointMatch>(
  point: ReviewPoint<Last, Earlier>,
  recent: readonly Last[],
  before: readonly Earlier[],
): ReviewRow {
  const { subject, unit, better, display, center } = point;
  const judged = recent.flatMap((last): JudgedMatch[] => {
    const value = point.valueIn(last);
    if (value === null) {
      return [];
    }
    const { mark, ...verdict } = point.judge(last, value);
    const { matchId, startTime } = last.match;
    return [{ entry: { matchId, startTime, value, mark }, ...verdict }];
  });
  return reviewRowOf({
    subject,
    unit,
    better,
    display,
    center,
    judged,
    before: before.flatMap((earlier) => point.valueIn(earlier) ?? []),
  });
}
