/**
 * The view of a match analysis, and the arithmetic that builds it.
 *
 * `AnalysisService` (`./analysis.service`) reads what a match is compared from: its projection, its
 * archive, the habits of the player and the community data in the cache. This module is the pure
 * part that turns those into what the match page shows: for each of the 24 metrics its value, where
 * it stands among the community (`CommunityCell`, placed by `./community-placement`) and against the
 * player's habits (`PersonalComparison`), the strengths and weaknesses of the summary, the metrics by
 * family, and the phase table. Nothing here reads a database, a file or the network, and nothing is
 * logged.
 *
 * Everything the community or the habits cannot tell is told in the view and never replaced by a
 * number, so that the page can say "no comparison" instead of a wrong one: a missing value, a metric
 * the community has no reference for, a cohort that is missing or too small, a phase too short to be
 * scored, a player with fewer than five earlier matches.
 *
 * The one function that builds an analysis is {@link buildAnalysis}; the rest is its parts, kept
 * private so that the view types are the one contract with the pages. Only the order of the
 * families ({@link FAMILY_ORDER}) is shared, with the review of the last matches. Two of the view
 * types, the state of the community comparison (`CommunityState`) and the placement of a metric
 * (`CommunityCell`), are declared in `./community-placement` with the arithmetic that gives them.
 *
 * @packageDocumentation
 */
import { durationWindowOf } from '../core/analysis/cohort';
import {
  confidenceOf,
  selectInsights,
  type Confidence,
  type Insight,
  type InsightCandidate,
  type InsightMatch,
} from '../core/analysis/insights/insights';
import { PERSONAL_WINDOW } from '../core/analysis/insights/thresholds';
import { minutesOf, type MatchContext } from '../core/analysis/match-context';
import type {
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
  spanOf,
  type Phase,
  type PhaseSpan,
  type PhaseStat,
} from '../core/analysis/phases';
import { comparePersonal, type PersonalComparison } from '../core/analysis/references';
import { MATCH_METRICS, METRICS } from '../core/analysis/registry';
import type { CohortRead } from './benchmark.service';
import {
  communityCellOf,
  communityOf,
  type CommunityCell,
  type CommunityReference,
  type CommunityState,
  type PlacementBasis,
} from './community-placement';
import type { MetricValues, PreviousMatch, StoredProjection } from './metrics.repository';

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
   * same stretch of the match on both sides relies on the two lengths agreeing. When they are in
   * different windows, the curve cells are `missing`.
   */
  readonly durationS: number;
}

/** What the match page shows of the analysis of one match. */
export type MatchAnalysisView =
  /** There is nothing to analyse: no account, no archived detail, or an archive that is unreadable. */
  | { readonly kind: 'not_analysed' }
  /**
   * The match is archived but its projection is not there yet (or is of an older version), or the
   * projections of the earlier matches its habits are made of are not all there yet.
   */
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

/**
 * The families in the order the match page shows them; the review of the last matches shows its
 * metrics in the same order.
 */
export const FAMILY_ORDER: readonly MetricFamily[] = [
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

/**
 * What the numbers of every metric of a match are compared from: what the community placement
 * reads of the match ({@link PlacementBasis}), and what only the analysis reads.
 */
interface MetricBasis extends PlacementBasis {
  /** The length of the match, in seconds. */
  readonly durationS: number;
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
  const community = communityCellOf(definition, value, basis, basis.reference);
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
 * The match has two lengths here, and they should be one: the length in the database
 * (`projection.durationS`) sets the cohort window, the phases the comparisons are made on, the
 * minutes of every per-minute figure and the confidence; the length in the archive
 * (`context.durationS`) sets the phase columns. Both are the length of the same match. It matters
 * beyond the display: the `<key>.community_window` rates stored with the metrics were computed from
 * the duration window of the archive's length, and the community curve is read here on the phases of
 * the database's length, so the rule that the same stretch of the match is compared on both sides
 * holds only if the two agree. When they are in different duration windows, the curve cells are
 * `missing` rather than a comparison of two different stretches.
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
    ratesWindow: durationWindowOf(context.durationS),
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
