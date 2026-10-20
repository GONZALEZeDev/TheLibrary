/**
 * The view of a match analysis, and the arithmetic that builds it.
 *
 * `AnalysisService` (`./analysis.service`) reads what a match is compared from: its projection, its
 * archive, the habits of the player and the community data in the cache. This module is the pure
 * part that turns those into what the match page shows: for each of the 24 metrics its value, where
 * it stands among the community (`CommunityCell`) and against the player's habits
 * (`PersonalComparison`), the strengths and weaknesses of the summary, the metrics by family, and the
 * phase table. Nothing here reads a database, a file or the network, and nothing is logged.
 *
 * Everything the community or the habits cannot tell is told in the view and never replaced by a
 * number, so that the page can say "no comparison" instead of a wrong one: a missing value, a metric
 * the community has no reference for, a cohort that is missing or too small, a phase too short to be
 * scored, a player with fewer than five earlier matches.
 *
 * The one function that builds an analysis is {@link buildAnalysis}; the rest is its parts, kept
 * private so that the view types are the one contract with the pages.
 *
 * @packageDocumentation
 */
import { communitySpan, type Cohort, type DurationWindow } from '../core/analysis/cohort';
import {
  confidenceOf,
  selectInsights,
  type Confidence,
  type Insight,
  type InsightCandidate,
  type InsightMatch,
} from '../core/analysis/insights/insights';
import { PERSONAL_WINDOW } from '../core/analysis/insights/thresholds';
import type { MatchContext } from '../core/analysis/match-context';
import type {
  CommunitySource,
  MetricDefinition,
  MetricFamily,
  MetricKey,
  MetricUnit,
} from '../core/analysis/metric';
import { phaseMetricKey } from '../core/analysis/metrics/phase.metric';
import {
  PHASES,
  PHASE_STATS,
  phaseBreakdown,
  phaseSpans,
  type Phase,
  type PhaseSpan,
  type PhaseStat,
} from '../core/analysis/phases';
import {
  comparePersonal,
  curveRate,
  placeOnCurve,
  type CurveLabel,
  type PersonalComparison,
} from '../core/analysis/references';
import { communityWindowKey, MATCH_METRICS, METRICS } from '../core/analysis/registry';
import { placeInPercentiles } from '../core/analysis/statistics';
import type { CohortData, CohortRead } from './benchmark.service';
import type { MetricValues, PreviousMatch, StoredProjection } from './metrics.repository';

/**
 * Where the comparison with the community of a match stands.
 *
 * - `available`: the match is compared with `used`. `fallback` is set when that is every rank
 *   because the rank of the match holds too few matches; `stale` when the data is a day old or more;
 *   `sampleMatches` is how many matches of the hero the cohort holds.
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
 *   community data (see {@link CommunityState}), or not for this metric, or the value is unknown.
 */
export type CommunityCell =
  | { readonly kind: 'percentile'; readonly percentile: number }
  | { readonly kind: 'curve'; readonly percentile: number; readonly label: CurveLabel }
  | { readonly kind: 'none' }
  | { readonly kind: 'missing' };

/** One metric of a match, with everything the page shows next to its value. */
export interface MetricRowView {
  /** The metric: its key names its texts. */
  readonly key: MetricKey;
  /** What the value counts, which decides how it is formatted. */
  readonly unit: MetricUnit;
  /** Which direction is an improvement. */
  readonly better: 'higher' | 'lower';
  /**
   * The value in this match, or `null` when it is unknown (the archive does not hold what the metric
   * needs, or the metric does not apply to the match). A phase metric is a rate per minute of its
   * phase.
   */
  readonly value: number | null;
  /** How the value stands among the community. */
  readonly community: CommunityCell;
  /**
   * How the value differs from the habits of the player, or `null` when the value is unknown or the
   * player has fewer than five earlier values. `median` and a difference in an `absolute` amount
   * are in the unit the page shows: the total of the match for a metric compared per minute (the
   * deaths, the healing…), the total of the phase for a phase metric, like the totals of the phase
   * table. `z` is not turned for the metrics where lower is better.
   */
  readonly personal: PersonalComparison | null;
  /** The strength or the weakness this metric makes in the summary, or `null` when it is neither. */
  readonly insight: Insight | null;
  /** How far the comparison of this metric can be trusted. */
  readonly confidence: Confidence;
}

/** The metrics of one family, in the order they are shown. */
export interface FamilyView {
  /** The family. */
  readonly family: MetricFamily;
  /** The metrics of the family. */
  readonly rows: readonly MetricRowView[];
}

/** One figure of one phase: what the player did, and how it compares. */
export interface PhaseCellView {
  /** What the player did in the phase, or `null` when the archive does not tell. */
  readonly total: number | null;
  /** The share of the team's total that the player's makes (0 to 1), or `null` when it is unknown. */
  readonly teamShare: number | null;
  /**
   * The metric the figure is compared through: `souls_at_10min` for the souls of the early game,
   * the phase metric of the figure otherwise. `null` when the phase is too short to be scored (it
   * is shown with its totals only).
   */
  readonly row: MetricRowView | null;
}

/** One phase of the match: its span and its four figures. */
export interface PhaseColumnView {
  /** The phase as played in this match. */
  readonly span: PhaseSpan;
  /** The four figures of the phase. */
  readonly cells: Readonly<Record<PhaseStat, PhaseCellView>>;
}

/** The analysis of a match. */
export interface MatchAnalysis {
  /** The metrics that stood out for the better, strongest first (at most three). */
  readonly strengths: readonly Insight[];
  /** The metrics that stood out for the worse, strongest first (at most three). */
  readonly weaknesses: readonly Insight[];
  /** The 13 metrics of the whole match, by family. */
  readonly families: readonly FamilyView[];
  /** The phases the match reached, in the order of the match. */
  readonly phases: readonly PhaseColumnView[];
  /** Where the comparison with the community stands. */
  readonly community: CommunityState;
  /**
   * The length of the match, in seconds, as the database holds it. It is the length of the same
   * match as the archive's, which sets the phase columns: the community-window rates stored with
   * the metrics were computed from the duration window of the archive's length, so comparing the
   * same stretch of the match on both sides relies on the two lengths agreeing.
   */
  readonly durationS: number;
}

/** What the match page shows of the analysis of one match. */
export type MatchAnalysisView =
  /** There is nothing to analyse: no account, no archived detail, or an archive that is unreadable. */
  | { readonly kind: 'not_analysed' }
  /** The match is archived but its projection is not there yet (or is of an older version). */
  | { readonly kind: 'pending' }
  /** The archive lacks what the analysis needs: the match cannot be analysed. */
  | { readonly kind: 'failed' }
  /** The analysis of the match. */
  | { readonly kind: 'ready'; readonly analysis: MatchAnalysis };

/** What the analysis of a match is built from. */
export interface AnalysisInputs {
  /** The projection of the match: its length, whether somebody left, the badge of the player. */
  readonly projection: StoredProjection;
  /** The match as read from its archive, for the phase table. */
  readonly context: MatchContext;
  /** The values of the metrics of the match. */
  readonly values: MetricValues;
  /** The matches played before it, most recent first, with their values. */
  readonly previous: readonly PreviousMatch[];
  /** What the cache holds for the cohort of the match. */
  readonly cohortRead: CohortRead;
}

/** How many seconds make a minute. */
const SECONDS_PER_MINUTE = 60;

/** The families in the order the page shows them. */
const FAMILY_ORDER: readonly MetricFamily[] = [
  'combat',
  'survival',
  'farm',
  'support',
  'objectives',
  'laning',
];

/**
 * The phase each phase metric rates, by key, built from the table of the phase metrics
 * (`phaseMetricKey`) over the four figures and the three phases. A phase metric is told its phase by
 * this table and not by its community source, so that one without a curve would still have it. The
 * early souls are `souls_at_10min`, a match metric: it is in the table too, but only a metric with
 * no family is looked up.
 */
const PHASE_OF_METRIC: ReadonlyMap<MetricKey, Phase> = new Map(
  PHASE_STATS.flatMap((stat) =>
    PHASES.map((phase) => [phaseMetricKey(stat, phase), phase] as const),
  ),
);

/** The community data of the cohort a match is compared with, once it is known to be usable. */
type CommunityReference = Pick<CohortData, 'benchmark' | 'curve'> & {
  /** The duration window of the cohort that is used: the curve is the one of its matches. */
  readonly window: DurationWindow;
};

/** What the numbers of every metric of a match are compared from. */
interface MetricBasis {
  /** The length of the match, in seconds. */
  readonly durationS: number;
  /** The phases the match reached, worked out once for all the metrics. */
  readonly spans: readonly PhaseSpan[];
  /** The values of the metrics of the match. */
  readonly values: MetricValues;
  /** The matches played before it, most recent first, with their values. */
  readonly previous: readonly PreviousMatch[];
  /** The community data, or `null` when there is none to compare with. */
  readonly reference: CommunityReference | null;
}

/** One metric of a match compared with its references, before the insights are selected. */
interface MetricEvaluation {
  /** The metric. */
  readonly definition: MetricDefinition;
  /** Its value in the match, or `null` when it is unknown. */
  readonly value: number | null;
  /** How it stands among the community. */
  readonly community: CommunityCell;
  /** How it differs from the habits of the player. */
  readonly personal: PersonalComparison | null;
  /** What the selection of the insights reads. */
  readonly candidate: InsightCandidate;
}

/**
 * The length of a match in minutes, as every per-minute figure of the analysis divides it. A match
 * of less than a second counts for one, so that no division is ever by zero.
 *
 * @param durationS - The length of the match, in seconds.
 * @returns The length in minutes, at least one second.
 */
function minutesOf(durationS: number): number {
  return Math.max(1, durationS) / SECONDS_PER_MINUTE;
}

/**
 * Find a phase among the ones a match reached.
 *
 * @param spans - The phases the match reached.
 * @param phase - The phase.
 * @returns Its span, or `undefined` when the match ended before the phase started.
 */
function spanOf(spans: readonly PhaseSpan[], phase: Phase): PhaseSpan | undefined {
  return spans.find((span) => span.phase === phase);
}

/**
 * Tell where the community comparison stands from what the cache holds, and keep the data when it
 * can be compared with.
 *
 * @param cohortRead - What the cache holds for the cohort.
 * @returns The state for the page, and the data to compare the metrics with (`null` unless the
 *   state is `available`).
 */
function communityOf(cohortRead: CohortRead): {
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
    },
    reference: { benchmark: data.benchmark, curve: data.curve, window: used.window },
  };
}

/**
 * Place a metric among the community's average course of a match.
 *
 * The player's rate is the one projected for the stretch of the phase that the community curve
 * covers (`<key>.community_window`), not the rate over the whole phase: the curve only holds the
 * matches of the cohort up to the time every one of them reaches, and the same stretch has to be
 * compared on both sides.
 *
 * @param key - The metric.
 * @param community - Where the metric's community reference comes from: a stretch of the curve.
 * @param basis - What the metrics of the match are compared from.
 * @param reference - The community data.
 * @returns The placement, or `missing` when any step has no answer: the phase the match did not
 *   reach, a stretch shorter than the minimum, a curve that does not cover it, an unknown rate of
 *   the player, or a community without spread.
 */
function curveCellOf(
  key: MetricKey,
  community: Extract<CommunitySource, { readonly kind: 'curve' }>,
  basis: MetricBasis,
  reference: CommunityReference,
): CommunityCell {
  const span = spanOf(basis.spans, community.phase);
  const shared = span === undefined ? null : communitySpan(span, reference.window);
  const average =
    shared === null ? null : curveRate(reference.curve, community.stat, shared.startS, shared.endS);
  const rate = basis.values.get(communityWindowKey(key)) ?? null;
  const placement = average === null || rate === null ? null : placeOnCurve(rate, average);
  return placement === null
    ? { kind: 'missing' }
    : { kind: 'curve', percentile: placement.percentile, label: placement.label };
}

/**
 * Compare the value of a metric with the community.
 *
 * @param definition - The metric.
 * @param value - Its value in the match.
 * @param basis - What the metrics of the match are compared from.
 * @returns How it stands: `none` for a metric the community has no reference for, whatever the
 *   data; `missing` when the data, the value or the reference of the data for this metric is not
 *   there; its placement otherwise.
 */
function communityCellOf(
  definition: MetricDefinition,
  value: number | null,
  basis: MetricBasis,
): CommunityCell {
  const { community } = definition;
  if (community.kind === 'none') {
    return { kind: 'none' };
  }
  const { reference } = basis;
  if (reference === null || value === null) {
    return { kind: 'missing' };
  }
  if (community.kind === 'curve') {
    return curveCellOf(definition.key, community, basis, reference);
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
 * The values of the habits of the player for a metric: its {@link PERSONAL_WINDOW} most recent known
 * values in the earlier matches. A match where the metric is unknown is skipped, not counted, so
 * that the habits are made of real values; a metric compared per minute is divided by the length of
 * the match it comes from.
 *
 * @param definition - The metric.
 * @param previous - The earlier matches, most recent first.
 * @returns The values, in the unit the metric is compared in, most recent first.
 */
function habitsOf(definition: MetricDefinition, previous: readonly PreviousMatch[]): number[] {
  const habits: number[] = [];
  for (const match of previous) {
    const value = match.values.get(definition.key) ?? null;
    if (value !== null) {
      habits.push(
        definition.personal === 'per_minute' ? value / minutesOf(match.durationS) : value,
      );
    }
    if (habits.length === PERSONAL_WINDOW) {
      break;
    }
  }
  return habits;
}

/**
 * The factor that turns the unit a metric is compared with the habits in back into the unit the
 * page shows it in.
 *
 * - A metric compared per minute is shown as a total over the match: its length in minutes.
 * - A metric of the whole match that is compared as it is has no conversion: 1.
 * - A phase metric (one with no family) is stored as a rate over its phase and shown, like the
 *   totals of the phase table, as the total of the phase: the length of the phase in this match in
 *   minutes. Its phase comes from the table of the phase metrics, not from its community source.
 *
 * @param definition - The metric.
 * @param basis - What the metrics of the match are compared from.
 * @returns The factor, or `null` for a phase metric whose phase the match did not reach.
 */
function personalScaleOf(definition: MetricDefinition, basis: MetricBasis): number | null {
  if (definition.personal === 'per_minute') {
    return minutesOf(basis.durationS);
  }
  if (definition.family !== null) {
    return 1;
  }
  const phase = PHASE_OF_METRIC.get(definition.key);
  const span = phase === undefined ? undefined : spanOf(basis.spans, phase);
  return span?.minutes ?? null;
}

/**
 * Compare the value of a metric with the habits of the player.
 *
 * @param definition - The metric.
 * @param value - Its value in the match.
 * @param basis - What the metrics of the match are compared from.
 * @returns The comparison, or `null` when the value is unknown or the player has too few earlier
 *   values to have habits.
 */
function personalOf(
  definition: MetricDefinition,
  value: number | null,
  basis: MetricBasis,
): PersonalComparison | null {
  if (value === null) {
    return null;
  }
  const scale = personalScaleOf(definition, basis);
  if (scale === null) {
    return null;
  }
  return comparePersonal({
    // A metric compared per minute is a rate here: the scale is the length of the match.
    value: definition.personal === 'per_minute' ? value / scale : value,
    previous: habitsOf(definition, basis.previous),
    display: definition.display,
    scale,
  });
}

/**
 * Compare a metric of the match with the community and with the habits of the player.
 *
 * @param definition - The metric.
 * @param basis - What the metrics of the match are compared from.
 * @returns The value, the two comparisons, and the candidate the insights are selected from.
 */
function evaluateMetric(definition: MetricDefinition, basis: MetricBasis): MetricEvaluation {
  const value = basis.values.get(definition.key) ?? null;
  const community = communityCellOf(definition, value, basis);
  const personal = personalOf(definition, value, basis);
  return {
    definition,
    value,
    community,
    personal,
    candidate: {
      key: definition.key,
      group: definition.group,
      better: definition.better,
      communityPercentile:
        community.kind === 'percentile' || community.kind === 'curve' ? community.percentile : null,
      personalZ: personal?.z ?? null,
    },
  };
}

/**
 * Make the row of a metric from its evaluation.
 *
 * @param evaluation - The metric compared with its references.
 * @param insights - The insights of the summary by metric.
 * @param match - The match, for the confidence.
 * @returns The row.
 */
function rowOf(
  evaluation: MetricEvaluation,
  insights: ReadonlyMap<MetricKey, Insight>,
  match: InsightMatch,
): MetricRowView {
  const { definition, candidate } = evaluation;
  return {
    key: definition.key,
    unit: definition.unit,
    better: definition.better,
    value: evaluation.value,
    community: evaluation.community,
    personal: evaluation.personal,
    insight: insights.get(definition.key) ?? null,
    confidence: confidenceOf(candidate, match),
  };
}

/**
 * Group the metrics of the whole match by family.
 *
 * @param rows - The rows of every metric.
 * @returns The families in the order the page shows them, each with its metrics in the order of the
 *   registry; a family with no metric is left out.
 */
function familiesOf(rows: ReadonlyMap<MetricKey, MetricRowView>): readonly FamilyView[] {
  return FAMILY_ORDER.flatMap((family): FamilyView[] => {
    const familyRows = MATCH_METRICS.filter((metric) => metric.family === family).flatMap(
      (metric) => rows.get(metric.key) ?? [],
    );
    return familyRows.length === 0 ? [] : [{ family, rows: familyRows }];
  });
}

/**
 * Build the phase table: the totals of the archive, and for each figure the row of the metric it is
 * compared through.
 *
 * @param context - The match, as read from its archive.
 * @param rows - The rows of every metric.
 * @returns One column per phase the match reached, in the order of the match.
 */
function phaseColumnsOf(
  context: MatchContext,
  rows: ReadonlyMap<MetricKey, MetricRowView>,
): readonly PhaseColumnView[] {
  return phaseBreakdown(context).map(({ span, cells }): PhaseColumnView => {
    const cellOf = (stat: PhaseStat): PhaseCellView => ({
      total: cells[stat].total,
      teamShare: cells[stat].teamShare,
      // A phase too short to be compared is shown with its totals and not scored.
      row: span.comparable ? (rows.get(phaseMetricKey(stat, span.phase)) ?? null) : null,
    });
    return {
      span,
      cells: {
        souls: cellOf('souls'),
        hero_damage: cellOf('hero_damage'),
        objective_damage: cellOf('objective_damage'),
        kills: cellOf('kills'),
      },
    };
  });
}

/**
 * Build the analysis of a match from everything it is compared with.
 *
 * The match has two lengths here, and they must be one: the length in the database
 * (`projection.durationS`) sets the cohort window, the phases the comparisons are made on, the
 * minutes of every per-minute figure and the confidence; the length in the archive
 * (`context.durationS`) sets the phase columns. Both are the length of the same match. It matters
 * beyond the display: the `<key>.community_window` rates stored with the metrics were computed from
 * the duration window of the archive's length, and the community curve is read here on the phases of
 * the database's length, so the rule that the same stretch of the match is compared on both sides
 * holds only if the two agree.
 *
 * @param inputs - See {@link AnalysisInputs}.
 * @returns The analysis.
 */
export function buildAnalysis(inputs: AnalysisInputs): MatchAnalysis {
  const { projection, context, values, previous, cohortRead } = inputs;
  const { state, reference } = communityOf(cohortRead);
  const { durationS } = projection;
  const basis: MetricBasis = {
    durationS,
    spans: phaseSpans(durationS),
    values,
    previous,
    reference,
  };

  const evaluations = METRICS.map((definition) => evaluateMetric(definition, basis));
  const match: InsightMatch = { durationS, hasLeaver: projection.hasLeaver };
  const { strengths, weaknesses } = selectInsights(
    evaluations.map((evaluation) => evaluation.candidate),
    match,
  );
  const insights = new Map(
    [...strengths, ...weaknesses].map((insight) => [insight.key, insight] as const),
  );
  const rows = new Map(
    evaluations.map((evaluation) => [
      evaluation.definition.key,
      rowOf(evaluation, insights, match),
    ]),
  );
  return {
    strengths,
    weaknesses,
    families: familiesOf(rows),
    phases: phaseColumnsOf(context, rows),
    community: state,
    durationS,
  };
}
