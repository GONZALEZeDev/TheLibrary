/**
 * The rows of the stats tab of the review: the 24 metrics of the match page over the player's last
 * matches, each against the players of the tier above and against the matches before.
 *
 * Each match is judged on its own, as the match page judges it: its value is placed among the tier's
 * data for its own duration window (`communityCellOf`, `./community-placement`), and the placement,
 * turned so that higher is better, makes it weak or strong (`markOfPercentile`). The two figures
 * that placement compares (`communityComparisonOf`) make the comparison of the row: the value and
 * the tier's median (`p50`) for a metric placed among the tier's percentiles, the player's rate and
 * the tier's over the same stretch for one placed on its curve. The lane gap has no tier figure and
 * is judged by a fixed rule of its own (`markOfLaneGap`). A match whose tier data is not cached keeps
 * its value but gets no community mark.
 *
 * Each metric is a point of the skeleton the tabs share (`./review-row`), around the **median**, as
 * the tier's figures of these metrics are percentiles: the player's figure is the median of the
 * values, and the tier's figure the median of its figures for the compared matches, each for the
 * length of that match.
 *
 * Nothing here reads a database, a file or the network, and nothing is logged.
 *
 * @packageDocumentation
 */
import { orientedPercentile } from '../core/analysis/insights/insights';
import type { MetricDefinition, MetricKey } from '../core/analysis/metric';
import { PHASE_METRICS } from '../core/analysis/metrics/phase.metric';
import { MATCH_METRICS } from '../core/analysis/registry';
import {
  markOfLaneGap,
  markOfPercentile,
  type ReviewMark,
} from '../core/analysis/review/review-rules';
import { FAMILY_ORDER } from './analysis-view';
import { communityCellOf, communityComparisonOf } from './community-placement';
import type { RecentMatch } from './metrics.repository';
import {
  UNJUDGED,
  placeReviewMatches,
  pointMatchesOf,
  pointRowOf,
  type PlacedReviewMatch,
  type ReviewPoint,
  type Verdict,
} from './review-row';
import type { ReviewFamily, ReviewMatch, ReviewRow, ReviewStats } from './review-view';

/**
 * The metrics the community has no figure for that are judged by a fixed rule instead, by key: the
 * lane gap at 10:00, clearly won or lost by a gap in souls. A metric with no community figure and no
 * rule here is never marked.
 */
const FIXED_RULES: ReadonlyMap<MetricKey, (value: number) => ReviewMark | null> = new Map([
  ['lane_souls_diff_at_10min', markOfLaneGap],
]);

/**
 * Judge one of the last matches on a metric.
 *
 * @param definition - The metric.
 * @param placed - The match, with the tier's data for its duration window and its basis.
 * @param value - The value of the metric in the match.
 * @returns The verdict: a fixed rule's for a metric that has one (the match is then marked but not
 *   compared with the tier), the placement among the tier and its two figures otherwise, and no
 *   verdict when the match cannot be placed.
 */
function judge(definition: MetricDefinition, placed: PlacedReviewMatch, value: number): Verdict {
  const { reference, basis } = placed;
  const fixedRule = FIXED_RULES.get(definition.key);
  if (fixedRule !== undefined) {
    return { mark: fixedRule(value), marked: true, percentile: null, comparison: null };
  }
  const cell = communityCellOf(definition, value, basis, reference);
  if (cell.kind !== 'percentile' && cell.kind !== 'curve') {
    return UNJUDGED;
  }
  const percentile = orientedPercentile(cell.percentile, definition.better);
  return {
    mark: markOfPercentile(percentile),
    marked: true,
    percentile,
    comparison: communityComparisonOf(definition, value, basis, reference),
  };
}

/**
 * The point of a metric: its value is the one stored for the match, and it is judged by `judge`.
 *
 * @param definition - The metric.
 * @returns The point, around the median.
 */
function metricPoint(definition: MetricDefinition): ReviewPoint<PlacedReviewMatch> {
  const { key } = definition;
  return {
    subject: { kind: 'metric', key },
    unit: definition.unit,
    better: definition.better,
    display: definition.display,
    center: 'median',
    valueIn: ({ match }) => match.values.get(key) ?? null,
    judge: (placed, value) => judge(definition, placed, value),
  };
}

/**
 * Build the stats tab of the review: one row for each of the 24 metrics of the match page.
 *
 * @param recent - The last matches, most recent first, each with the tier's data for its duration
 *   window (`null` when none is cached).
 * @param before - The matches before them, which the progress compares with.
 * @returns The 13 metrics of the whole match by family, in the order of the match page (a family
 *   with no metric is left out), each family in the order of the registry, and the 11 metrics of a
 *   phase in the order of the registry.
 */
export function statsRowsOf(
  recent: readonly ReviewMatch[],
  before: readonly RecentMatch[],
): ReviewStats {
  const placed = placeReviewMatches(recent);
  const earlier = pointMatchesOf(before);
  const rowOfMetric = (metric: MetricDefinition): ReviewRow =>
    pointRowOf(metricPoint(metric), placed, earlier);
  const families = FAMILY_ORDER.flatMap((family): ReviewFamily[] => {
    const rows = MATCH_METRICS.filter((metric) => metric.family === family).map(rowOfMetric);
    return rows.length === 0 ? [] : [{ family, rows }];
  });
  return { families, phases: PHASE_METRICS.map(rowOfMetric) };
}
