/**
 * The insights of a match: the few metrics that stood out, for better (strengths) or for worse
 * (weaknesses), that the summary shows before the full list.
 *
 * Each metric brings up to two signals, both turned so that higher means better (a metric where
 * lower is better, like deaths, is flipped first):
 *
 * - the **community signal**, `c = (p' − 50) / 50`: where the player stands among the players of
 *   their rank (`p'` is the oriented percentile), from −1 (the very bottom) to 1 (the very top);
 * - the **personal signal**, `s = clamp(z' / PERSONAL_Z_DIVISOR, −1, 1)`: how far this match is from
 *   the player's habits (`z'` is the oriented robust z-score), on the same scale.
 *
 * The two make a score, a metric is a strength or a weakness when its score and one of its signals
 * agree that it stands out, and the summary keeps the three strongest of each side, one per group
 * of metrics. Everything here is pure arithmetic on the numbers the references already computed.
 *
 * @packageDocumentation
 */
import type { MetricKey } from '../metric';
import {
  COMMUNITY_WEIGHT,
  INSIGHTS_PER_SIDE,
  PERSONAL_WEIGHT,
  PERSONAL_Z_DIVISOR,
  SHORT_MATCH_S,
  STRENGTH_PERCENTILE,
  STRONG_Z,
  WEAKNESS_PERCENTILE,
} from './thresholds';

/**
 * How far an insight can be trusted: `high` when both references back it, `medium` when one of them
 * is missing, `low` when the match itself says little about the player (a short match, a leaver).
 */
export type Confidence = 'high' | 'medium' | 'low';

/** What a metric brings to the selection of insights: its two references, not yet oriented. */
export interface InsightCandidate {
  /** The metric. */
  readonly key: MetricKey;
  /**
   * The thing the metric measures. Metrics of the same group say the same thing in different words
   * (souls per minute and souls at 10:00), so the summary shows only one of them per side.
   */
  readonly group: string;
  /** Which direction is an improvement: for `lower`, both references are flipped before use. */
  readonly better: 'higher' | 'lower';
  /**
   * The raw placement of the match among the community, from 1 to 99 (a high value is a high
   * metric, not necessarily a good one), or `null` when the community gives no reference.
   */
  readonly communityPercentile: number | null;
  /**
   * The raw robust z-score of the match against the player's habits (positive is a higher metric,
   * not necessarily a better one), or `null` when there is no usable history.
   */
  readonly personalZ: number | null;
}

/** What the confidence of an insight depends on, apart from the references: the match itself. */
export interface InsightMatch {
  /** The length of the match, in seconds. */
  readonly durationS: number;
  /** Whether a player left the match before its end. */
  readonly hasLeaver: boolean;
}

/** A metric that stood out in a match. */
export interface Insight {
  /** The metric. */
  readonly key: MetricKey;
  /** Whether the metric is one of the best of the match or one of the worst. */
  readonly side: 'strength' | 'weakness';
  /**
   * The score, from −1 to 1: positive for a strength, negative for a weakness. Its absolute value
   * says how much the metric stood out.
   */
  readonly score: number;
  /** How far the insight can be trusted. */
  readonly confidence: Confidence;
}

/** An insight with the group of its metric, which the selection needs and the caller does not. */
interface GroupedInsight {
  readonly group: string;
  readonly insight: Insight;
}

/** The top of the percentile scale: `100 − p` turns a percentile, and a share times it is one. */
export const PERCENTILE_SCALE = 100;

/** The percentile of the median: the placement that is neither good nor bad. */
const MEDIAN_PERCENTILE = 50;

/** The distance from the median to either end of the percentile scale, which `c` is divided by. */
const PERCENTILE_HALF_RANGE = 50;

/** The largest value of a signal, and the opposite of its smallest. */
const SIGNAL_LIMIT = 1;

/**
 * A community percentile, oriented so that higher is always better.
 *
 * It is what the weak and strong marks of a placement are read on, in a match's insights and in the
 * review of the last matches alike.
 *
 * @param percentile - The raw percentile, from 1 to 99 (a high value is a high metric, not
 *   necessarily a good one).
 * @param better - Which direction is an improvement for the metric.
 * @returns The percentile, turned (`100 − p`) for a lower-is-better metric and unchanged otherwise.
 */
export function orientedPercentile(percentile: number, better: 'higher' | 'lower'): number {
  return better === 'lower' ? PERCENTILE_SCALE - percentile : percentile;
}

/**
 * The z-score of a candidate against the player's habits, oriented so that higher is always better.
 *
 * @param candidate - The metric and its references.
 * @returns The z-score, negated for a lower-is-better metric, or `null` when there are no habits
 *   to compare with.
 */
function orientedZ(candidate: InsightCandidate): number | null {
  const { personalZ, better } = candidate;
  if (personalZ === null) {
    return null;
  }
  return better === 'lower' ? -personalZ : personalZ;
}

/**
 * Tell how far an insight about a candidate can be trusted.
 *
 * A match that is short or has a leaver says little about how the player plays, whatever the
 * references say, so it is `low`. Otherwise the insight is `medium` when it rests on one reference
 * only and `high` when both back it.
 *
 * @param candidate - The metric the insight is about.
 * @param match - The match it comes from.
 * @returns The confidence.
 */
export function confidenceOf(candidate: InsightCandidate, match: InsightMatch): Confidence {
  if (match.durationS < SHORT_MATCH_S || match.hasLeaver) {
    return 'low';
  }
  if (candidate.communityPercentile === null || candidate.personalZ === null) {
    return 'medium';
  }
  return 'high';
}

/**
 * Combine the two signals of a metric into its score.
 *
 * With both, the community signal weighs {@link COMMUNITY_WEIGHT} and the personal one
 * {@link PERSONAL_WEIGHT}. With only one, that signal is the score, **unweighted**: shrinking a
 * lone signal by 0.6 or 0.4 would undersell it, since nothing else is there to carry the rest of
 * the weight. It would make the first matches of a history (no habits yet) look weaker than they
 * are, and it would do the same to the lane difference, which has no community signal at all.
 *
 * @param community - The community signal `c`, or `null` when there is none.
 * @param personal - The personal signal `s`, or `null` when there is none.
 * @returns The score, or `null` when there is no signal to score.
 */
function scoreOf(community: number | null, personal: number | null): number | null {
  if (community !== null && personal !== null) {
    return COMMUNITY_WEIGHT * community + PERSONAL_WEIGHT * personal;
  }
  return community ?? personal;
}

/**
 * Decide whether a score is a strength, a weakness or neither.
 *
 * A score alone is not enough: a metric must also stand out through at least one of its own
 * references, or a middling metric with a slightly positive score would pass for a strength. And
 * the score has the last word: when the references disagree (a good placement among the
 * community, a bad match against the habits), the side the score falls on is the one that counts,
 * and a score of exactly 0 is neither. Only the references that exist are looked at.
 *
 * @param percentile - The oriented community percentile, or `null` when there is none.
 * @param z - The oriented personal z-score, or `null` when there is none.
 * @param score - The score of the metric.
 * @returns The side, or `null` when the metric stands out on neither.
 */
function sideOf(
  percentile: number | null,
  z: number | null,
  score: number,
): Insight['side'] | null {
  const isHigh =
    (percentile !== null && percentile >= STRENGTH_PERCENTILE) || (z !== null && z >= STRONG_Z);
  if (score > 0 && isHigh) {
    return 'strength';
  }
  const isLow =
    (percentile !== null && percentile <= WEAKNESS_PERCENTILE) || (z !== null && z <= -STRONG_Z);
  if (score < 0 && isLow) {
    return 'weakness';
  }
  return null;
}

/**
 * Turn one candidate into an insight, if it stands out.
 *
 * @param candidate - The metric and its two references.
 * @param match - The match, for the confidence.
 * @returns The insight with its group, or `null` when the metric has no signal or stands out on
 *   neither side.
 */
function evaluate(candidate: InsightCandidate, match: InsightMatch): GroupedInsight | null {
  const percentile =
    candidate.communityPercentile === null
      ? null
      : orientedPercentile(candidate.communityPercentile, candidate.better);
  const z = orientedZ(candidate);

  // The community signal c: the oriented placement, from −1 (the bottom) to 1 (the top).
  const community =
    percentile === null ? null : (percentile - MEDIAN_PERCENTILE) / PERCENTILE_HALF_RANGE;
  // The personal signal s: the oriented z-score, brought to the same scale and clamped to it.
  const personal =
    z === null ? null : Math.max(-SIGNAL_LIMIT, Math.min(SIGNAL_LIMIT, z / PERSONAL_Z_DIVISOR));

  const score = scoreOf(community, personal);
  if (score === null) {
    return null;
  }
  const side = sideOf(percentile, z, score);
  if (side === null) {
    return null;
  }
  return {
    group: candidate.group,
    insight: { key: candidate.key, side, score, confidence: confidenceOf(candidate, match) },
  };
}

/**
 * Keep the strongest insights of one side: one per group, at most {@link INSIGHTS_PER_SIDE}.
 *
 * @param entries - Every insight of the match, in the order of the candidates.
 * @param side - The side to keep.
 * @returns The insights of that side, strongest first.
 */
function topOfSide(entries: readonly GroupedInsight[], side: Insight['side']): Insight[] {
  // The sort is stable, so insights with the same |score| stay in the order of the candidates.
  const ranked = entries
    .filter((entry) => entry.insight.side === side)
    .toSorted((first, second) => Math.abs(second.insight.score) - Math.abs(first.insight.score));

  // The first of a group in this order is its strongest (and, on a tie, its first candidate), so
  // keeping only the first seen of each group is the same as keeping the largest |score| per group.
  const groups = new Set<string>();
  const kept: Insight[] = [];
  for (const { group, insight } of ranked) {
    if (groups.has(group)) {
      continue;
    }
    groups.add(group);
    kept.push(insight);
    if (kept.length === INSIGHTS_PER_SIDE) {
      break;
    }
  }
  return kept;
}

/**
 * Pick the strengths and the weaknesses of a match.
 *
 * Each candidate is oriented (`p' = 100 − p` and `z' = −z` for a lower-is-better metric, unchanged
 * otherwise), scored from its signals (the two together, or a lone one unweighted) and classified
 * from its score and its references. Then, per side, only the strongest metric of each group is
 * kept, so that the summary never shows the same thing twice (souls per minute and souls at 10:00
 * are one thing), and the {@link INSIGHTS_PER_SIDE} strongest groups are listed by decreasing
 * |score|. The two sides are independent: one group can bring a strength and a weakness to the
 * same match (a good pace, a poor start).
 *
 * @param candidates - Every metric of the match with its references, in a stable order (equal
 *   scores keep that order).
 * @param match - The match, which sets the confidence of every insight.
 * @returns The strengths and the weaknesses, strongest first, at most three of each.
 */
export function selectInsights(
  candidates: readonly InsightCandidate[],
  match: InsightMatch,
): { readonly strengths: readonly Insight[]; readonly weaknesses: readonly Insight[] } {
  const entries: GroupedInsight[] = [];
  for (const candidate of candidates) {
    const entry = evaluate(candidate, match);
    if (entry !== null) {
      entries.push(entry);
    }
  }
  return {
    strengths: topOfSide(entries, 'strength'),
    weaknesses: topOfSide(entries, 'weakness'),
  };
}
