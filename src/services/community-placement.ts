/**
 * Where a metric of a match stands among the community, and whether the community can be compared
 * with at all.
 *
 * `BenchmarkService` (`./benchmark.service`) reads the community data of a cohort: the percentiles of
 * the metrics and the average course of a match. This module is the pure part that turns what it
 * read into a placement: {@link communityOf} tells the state of the comparison for the page
 * ({@link CommunityState}) and keeps the data to place with ({@link CommunityReference}), and
 * {@link communityCellOf} places one metric of a match with it ({@link CommunityCell}), among the
 * percentiles of the benchmark or on the average course of the curve; {@link communityComparisonOf}
 * gives the two figures that placement compares, the player's and the community's. A view that counts
 * its own figure on a stretch of a phase reads the community's rate over the same stretch with
 * {@link curveStretchFor}. Nothing here reads a database, a file or the network, and nothing is
 * logged.
 *
 * It stands apart from the analysis of a match (`./analysis-view`) so that whatever places matches
 * among the community, the analysis of one match or a view of many, reads the community the same
 * way. What the community cannot tell is told in the cell and never replaced by a number: a metric
 * with no reference, data that is missing or too small, a value that is unknown, a curve read on
 * another stretch than the stored rate.
 *
 * @packageDocumentation
 */
import { communitySpan, type Cohort, type DurationWindow } from '../core/analysis/cohort';
import type {
  CommunitySource,
  CurveStat,
  MetricDefinition,
  MetricKey,
} from '../core/analysis/metric';
import { spanOf, type Phase, type PhaseSpan } from '../core/analysis/phases';
import {
  curveRate,
  placeOnCurve,
  type CurveLabel,
  type CurvePlacement,
  type CurveRate,
} from '../core/analysis/references';
import { communityWindowKey } from '../core/analysis/registry';
import { PERCENTILE_POINTS, placeInPercentiles } from '../core/analysis/statistics';
import type { CohortData, CohortRead } from './benchmark.service';
import type { MetricValues } from './metrics.repository';

/**
 * Where the comparison with the community of a match stands.
 *
 * - `available`: the match is compared with `used`. `fallback` is set when that is every rank
 *   because the rank of the match holds too few matches; `stale` when the data is a day old or more;
 *   `sampleMatches` is how many matches of the hero the cohort holds; `fetchedAt` is when the data
 *   was downloaded.
 * - `missing`: no community data is cached for the match (never downloaded, or the entry cannot be
 *   read). The page can ask for it with `AnalysisService.refreshCommunity`.
 * - `unavailable`: the community data was downloaded and holds too few matches, even over every
 *   rank: there is no community comparison for this match.
 */
export type CommunityState =
  | {
      readonly kind: 'available';
      readonly used: Cohort;
      readonly fallback: boolean;
      readonly stale: boolean;
      readonly sampleMatches: number;
      /** When the community data was downloaded (Unix ms): the page dates stale data with it. */
      readonly fetchedAt: number;
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable' };

/**
 * How a metric of a match stands among the community.
 *
 * Neither number is turned for the metrics where lower is better: a high `percentile` means a high
 * value, which is good or bad according to `MetricRowView.better`.
 *
 * - `percentile`: the value placed among the percentiles of the community's benchmark (1 to 99).
 * - `curve`: the player's rate over a stretch of the match placed on the community's average rate
 *   over the same stretch (1 to 99), with the label of the distance (`well_above`…`well_below`).
 * - `none`: the community has no reference for this metric, it is only compared with the habits.
 * - `missing`: the community has a reference for this metric but it cannot be used now: no
 *   community data (see {@link CommunityState}), or not for this metric, or the value is unknown, or
 *   (a curve) the database and the archive give the match two lengths in different duration
 *   windows, so that the stored rate and the curve would be read on different stretches.
 */
export type CommunityCell =
  | { readonly kind: 'percentile'; readonly percentile: number }
  | { readonly kind: 'curve'; readonly percentile: number; readonly label: CurveLabel }
  | { readonly kind: 'none' }
  | { readonly kind: 'missing' };

/**
 * The community data of the cohort a match is compared with, once it is known to be usable: the
 * percentiles of its metrics, the average course of a match, and the duration window of the cohort
 * that is used (see {@link communityOf}).
 */
export type CommunityReference = Pick<CohortData, 'benchmark' | 'curve'> & {
  /** The duration window of the cohort that is used: the curve is the one of its matches. */
  readonly window: DurationWindow;
};

/**
 * What a metric of one match is placed from: the part of the match that {@link communityCellOf}
 * reads, besides the community data it is placed on.
 */
export interface PlacementBasis {
  /** The phases the match reached, worked out once for all the metrics. */
  readonly spans: readonly PhaseSpan[];
  /**
   * The duration window of the length the archive gives the match: the one the stored
   * `<key>.community_window` rates were computed for.
   */
  readonly ratesWindow: DurationWindow;
  /** The values of the metrics of the match. */
  readonly values: MetricValues;
}

/** The community source of a metric compared on the curve. */
type CurveSource = Extract<CommunitySource, { readonly kind: 'curve' }>;

/**
 * The two figures a metric of a match is compared on with the community, in the unit of the
 * metric's value (see {@link communityComparisonOf}).
 */
export interface CommunityComparison {
  /** The player's figure that was placed among the community. */
  readonly player: number;
  /** The community's figure it was placed around. */
  readonly community: number;
}

/** The stretch of a match that a curve metric is compared on, with the community's rate over it. */
export interface CurveStretch {
  /** The length of the stretch, in minutes. */
  readonly minutes: number;
  /** The community's rate of the metric's counter over the stretch, per minute, and its spread. */
  readonly average: CurveRate;
}

/** What the curve says of a metric of a match: the stretch, the player's rate and its placement. */
interface CurveReading {
  /** The stretch the metric is compared on, with the community's rate over it. */
  readonly stretch: CurveStretch;
  /** The player's rate over the stretch, per minute (`<key>.community_window`). */
  readonly rate: number;
  /** Where the player's rate stands on the community's. */
  readonly placement: CurvePlacement;
}

/** How many seconds make a minute: a stretch of the curve is in seconds, its rates are per minute. */
const SECONDS_PER_MINUTE = 60;

/** The percentile point of the median, the community's own figure for a metric placed among them. */
const MEDIAN_PERCENTILE = 50;

/** Where the median is in a percentile table: the index of its point in `PERCENTILE_POINTS`. */
const MEDIAN_INDEX = PERCENTILE_POINTS.indexOf(MEDIAN_PERCENTILE);

/**
 * Tell whether two duration windows are the same one. Windows are compared by their bounds: the one
 * of a cohort comes back from the cache, a copy of the constant it was made from.
 *
 * @param first - A window.
 * @param second - Another window.
 * @returns `true` when both bounds are equal.
 */
function sameWindow(first: DurationWindow, second: DurationWindow): boolean {
  return first.minS === second.minS && first.maxS === second.maxS;
}

/**
 * Tell where the community comparison stands from what the cache holds, and keep the data when it
 * can be compared with.
 *
 * @param cohortRead - What the cache holds for the cohort.
 * @returns The state for the page, and the data to compare the metrics with (`null` unless the
 *   state is `available`).
 */
export function communityOf(cohortRead: CohortRead): {
  readonly state: CommunityState;
  readonly reference: CommunityReference | null;
} {
  if (cohortRead.kind === 'missing') {
    return { state: { kind: 'missing' }, reference: null };
  }
  const { data, stale } = cohortRead;
  const { used } = data;
  if (used === null) {
    // Even every rank holds too few matches: the data says there is nothing to compare with.
    return { state: { kind: 'unavailable' }, reference: null };
  }
  return {
    state: {
      kind: 'available',
      used,
      // A tier that was too small was replaced by every rank.
      fallback: used.rank.kind !== data.wanted.rank.kind,
      stale,
      sampleMatches: data.sampleMatches,
      fetchedAt: data.fetchedAt,
    },
    reference: { benchmark: data.benchmark, curve: data.curve, window: used.window },
  };
}

/**
 * Read the community's rate of a counter over the stretch of a phase of a match that the cohort's
 * curve covers (`communitySpan`): the stretch a stored `<key>.community_window` rate, or any figure
 * counted on the same stretch, is compared on.
 *
 * What was stored for the match was computed for the duration window of the length the archive gives
 * it, so the stretch is only read when that is the window of the cohort: a stretch of another window
 * is another stretch.
 *
 * @param phase - The phase the stretch is part of.
 * @param stat - The counter of the curve to read the community's rate of.
 * @param basis - What the metrics of the match are placed from.
 * @param reference - The community data.
 * @returns The stretch and the community's rate over it, or `null` when the stored values were
 *   computed for another duration window than the cohort's, the match did not reach the phase, the
 *   stretch is shorter than the minimum, or the curve does not cover it.
 */
export function curveStretchFor(
  phase: Phase,
  stat: CurveStat,
  basis: PlacementBasis,
  reference: CommunityReference,
): CurveStretch | null {
  if (!sameWindow(basis.ratesWindow, reference.window)) {
    return null;
  }
  const span = spanOf(basis.spans, phase);
  const shared = span === undefined ? null : communitySpan(span, reference.window);
  if (shared === null) {
    return null;
  }
  const average = curveRate(reference.curve, stat, shared.startS, shared.endS);
  return average === null
    ? null
    : { minutes: (shared.endS - shared.startS) / SECONDS_PER_MINUTE, average };
}

/**
 * Place a metric of a match on the community's average course of a match.
 *
 * The player's rate is the one projected for the stretch of the phase that the community curve
 * covers (`<key>.community_window`), not the rate over the whole phase: the curve only holds the
 * matches of the cohort up to the time every one of them reaches, and the same stretch has to be
 * compared on both sides. The cell of the metric and the two figures it compares are both read
 * from here, so that they always agree on whether the match is compared.
 *
 * @param key - The metric.
 * @param community - Where the metric's community reference comes from: a stretch of the curve.
 * @param basis - What the metrics of the match are placed from.
 * @param reference - The community data.
 * @returns The stretch, the player's rate over it and its placement, or `null` when any step has no
 *   answer: the phase the match did not reach, a stretch shorter than the minimum, a curve that does
 *   not cover it, an unknown rate of the player, a community without spread, or a stored rate
 *   computed for another duration window than the cohort's (the stretch it covers is not the one
 *   the curve is read on).
 */
function readCurve(
  key: MetricKey,
  community: CurveSource,
  basis: PlacementBasis,
  reference: CommunityReference,
): CurveReading | null {
  const stretch = curveStretchFor(community.phase, community.stat, basis, reference);
  const rate = basis.values.get(communityWindowKey(key)) ?? null;
  if (stretch === null || rate === null) {
    return null;
  }
  const placement = placeOnCurve(rate, stretch.average);
  return placement === null ? null : { stretch, rate, placement };
}

/**
 * Compare the value of a metric with the community.
 *
 * @param definition - The metric.
 * @param value - Its value in the match.
 * @param basis - What the metrics of the match are placed from.
 * @param reference - The community data to place the value on, or `null` when there is none to
 *   compare with (see {@link communityOf}).
 * @returns How it stands: `none` for a metric the community has no reference for, whatever the
 *   data; `missing` when the data, the value or the reference of the data for this metric is not
 *   there; its placement otherwise.
 */
export function communityCellOf(
  definition: MetricDefinition,
  value: number | null,
  basis: PlacementBasis,
  reference: CommunityReference | null,
): CommunityCell {
  const { community } = definition;
  if (community.kind === 'none') {
    return { kind: 'none' };
  }
  if (reference === null || value === null) {
    return { kind: 'missing' };
  }
  if (community.kind === 'curve') {
    const reading = readCurve(definition.key, community, basis, reference);
    return reading === null
      ? { kind: 'missing' }
      : { kind: 'curve', percentile: reading.placement.percentile, label: reading.placement.label };
  }
  const table = reference.benchmark.get(community.benchmark);
  return table === undefined
    ? { kind: 'missing' }
    : {
        kind: 'percentile',
        percentile: placeInPercentiles(value, table, { integer: definition.integer }),
      };
}

/**
 * The two figures the placement of a metric of a match compares, in the unit of the metric's value:
 * the player's that was placed, and the community's it was placed around. A view shows them side by
 * side, and the gap between them is the gap the placement measured.
 *
 * - A metric placed among percentiles compares its value with the median of the benchmark (its
 *   `p50`), as the community gives it: the median is not rounded for a metric that counts whole
 *   units, as a median of 3.6 deaths says more than 4.
 * - A metric placed on the curve compares the player's rate over the stretch the curve covers with
 *   the community's rate over the same stretch, not the value of the whole phase (see
 *   {@link communityCellOf}). A metric that is not a rate counts what was earned up to the end of
 *   its stretch, so both rates are turned into what was earned over it: the souls at 10:00,
 *   compared over the first ten minutes, compare the player's souls at 10:00 with the community's.
 *
 * @param definition - The metric.
 * @param value - Its value in the match.
 * @param basis - What the metrics of the match are placed from.
 * @param reference - The community data, or `null` when there is none to compare with.
 * @returns The two figures, or `null` whenever {@link communityCellOf} gives no placement (`none`
 *   or `missing`): both read the same data, so a match is compared by both or by neither.
 */
export function communityComparisonOf(
  definition: MetricDefinition,
  value: number | null,
  basis: PlacementBasis,
  reference: CommunityReference | null,
): CommunityComparison | null {
  const { community } = definition;
  if (community.kind === 'none' || reference === null || value === null) {
    return null;
  }
  if (community.kind === 'curve') {
    const reading = readCurve(definition.key, community, basis, reference);
    if (reading === null) {
      return null;
    }
    const scale = definition.unit === 'per_min' ? 1 : reading.stretch.minutes;
    return { player: reading.rate * scale, community: reading.stretch.average.rate * scale };
  }
  // A table always holds one value per percentile point (placing among it throws otherwise), so the
  // median is there whenever the table is.
  const median = reference.benchmark.get(community.benchmark)?.[MEDIAN_INDEX];
  return median === undefined ? null : { player: value, community: median };
}
