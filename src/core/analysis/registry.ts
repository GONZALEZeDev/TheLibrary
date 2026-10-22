/**
 * The registry of the metrics: the list of every metric the analysis computes, in the order they are
 * shown and stored, and the projection of a match into the values that are kept.
 *
 * The metrics themselves live apart, one file each, in `./metrics`; this module only puts them in
 * order and runs them. The projection is what the analysis keeps of a match: the value of every
 * metric, plus, for a metric compared with the community's curve, the player's rate over the span the
 * community's average is read on. A metric that fails on a match never prevents the others from being
 * kept.
 *
 * @packageDocumentation
 */
import { AppError } from '../errors/app-error';
import type { MatchContext } from './match-context';
import type { MetricDefinition, MetricKey } from './metric';
import { accuracyMetric } from './metrics/accuracy.metric';
import { bossDamagePerMinMetric } from './metrics/boss-damage-per-min.metric';
import { damageTakenPerMinMetric } from './metrics/damage-taken-per-min.metric';
import { deathsMetric } from './metrics/deaths.metric';
import { deniesMetric } from './metrics/denies.metric';
import { kdaMetric } from './metrics/kda.metric';
import { laneSoulsDiffAt10MinMetric } from './metrics/lane-souls-diff-at-10min.metric';
import { lastHitsMetric } from './metrics/last-hits.metric';
import { PHASE_METRICS } from './metrics/phase.metric';
import { playerDamagePerMinMetric } from './metrics/player-damage-per-min.metric';
import { soulsAt10MinMetric } from './metrics/souls-at-10min.metric';
import { soulsPerMinMetric } from './metrics/souls-per-min.metric';
import { teammateBarrieringMetric } from './metrics/teammate-barriering.metric';
import { teammateHealingMetric } from './metrics/teammate-healing.metric';

/**
 * The version of the projection: the set of values stored for a match, and the way they are
 * computed. A projection holds the values of the metrics of this registry and, next to them, the
 * damage-source values of the match (`./damage-sources`): the damage of each source, the damage
 * dealt while each shop item was owned, and the time each ability was unlocked; and its review
 * values (`./review/review-values`): the deaths of each phase, the time each shop item was first
 * bought and the deaths before, the places on the scoreboard and Valve's top three.
 *
 * Every projection is stored with the version that wrote it. Bumping the version makes every archive
 * be projected again at the next synchronisation, which projects the archived matches that lack a
 * projection of the current version at the end of its run (and a page opened before it projects the
 * match it shows, as a fallback). The archives are already on the disk, so this needs no network.
 *
 * Bump it when a metric is added, removed or changed (its formula, its unit, the way its community
 * window is read), or when the damage-source or review values are (a family of keys added or
 * removed, the way a value is worked out): the values stored for the same archive would no longer
 * be the ones the code computes. Do not bump it for a change that leaves the projected values as
 * they are (a text, the layout of the page).
 *
 * The versions so far: 1 stored the values of the metrics; 2 also stored the damage-source values
 * of each match; 3 also stores the review values of each match.
 */
export const PROJECTION_VERSION = 3;

/**
 * The thirteen metrics of the whole match, in the order they are shown: grouped by family (combat,
 * survival, farm, support, objectives, laning), and in the order of the family's metrics.
 */
export const MATCH_METRICS: readonly MetricDefinition[] = [
  // Combat.
  kdaMetric,
  playerDamagePerMinMetric,
  accuracyMetric,
  // Survival.
  deathsMetric,
  damageTakenPerMinMetric,
  // Farm.
  soulsPerMinMetric,
  lastHitsMetric,
  deniesMetric,
  // Support.
  teammateHealingMetric,
  teammateBarrieringMetric,
  // Objectives.
  bossDamagePerMinMetric,
  // Laning.
  soulsAt10MinMetric,
  laneSoulsDiffAt10MinMetric,
];

/**
 * Every metric of the analysis: the thirteen metrics of the whole match, then the eleven metrics of
 * a phase. The order is the one the values are projected and shown in.
 */
export const METRICS: readonly MetricDefinition[] = [...MATCH_METRICS, ...PHASE_METRICS];

/** The metrics by key, built once: the registry does not change while the app runs. */
const METRIC_BY_KEY: ReadonlyMap<MetricKey, MetricDefinition> = new Map(
  METRICS.map((metric) => [metric.key, metric]),
);

/**
 * What follows the key of a value to name the same value over the span of the match that the
 * community's curve is read on: the key of a metric's community window, and the key of any other
 * value that is compared with the community over that span.
 *
 * The key is stored with the value, so its format never changes once released.
 */
export const COMMUNITY_WINDOW_SUFFIX = '.community_window';

/**
 * The key a metric's community window is projected under: the player's rate over the span of the
 * match that the community's curve is read on (see {@link CommunitySource}). It sits next to the
 * metric's own value, and is only projected for a metric compared with the community's curve.
 *
 * The key is stored with the value, so its format never changes once released.
 *
 * @param key - The key of the metric.
 * @returns The key of its community window.
 */
export function communityWindowKey(key: MetricKey): string {
  return `${key}${COMMUNITY_WINDOW_SUFFIX}`;
}

/**
 * Find a metric by its key.
 *
 * The type of a key rules out an unknown one, but a key read back from storage is only a string that
 * was cast: a record written by another version of the app, or damaged, can hold one.
 *
 * @param key - The key of the metric.
 * @returns The metric.
 * @throws AppError of kind `unexpected` when no metric has this key. The key is in the error's
 *   context: it names a metric, not a person.
 */
export function metricByKey(key: MetricKey): MetricDefinition {
  const metric = METRIC_BY_KEY.get(key);
  if (metric === undefined) {
    throw new AppError('unexpected', 'No metric has the requested key', { context: { key } });
  }
  return metric;
}

/**
 * Run one computation of a metric and make its result storable.
 *
 * @param key - The key of the metric, passed to `onError` when the computation throws.
 * @param run - The computation: the metric's `compute`, or its community `rate`.
 * @param onError - Told about the computation that throws.
 * @returns The result when it is a finite number; `null` when the computation gives `null` (an
 *   unknown value), a number that is not finite (`NaN`, an infinity: it would not survive storage as
 *   a number and means nothing), or throws.
 */
function evaluate(
  key: MetricKey,
  run: () => number | null,
  onError: ((key: MetricKey, error: unknown) => void) | undefined,
): number | null {
  try {
    const value = run();
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch (error) {
    onError?.(key, error);
    return null;
  }
}

/**
 * Project a match into the values the analysis stores: the value of every metric, and for each
 * metric compared with the community's curve (the eleven phase metrics and `souls_at_10min`) the
 * player's rate over the span the curve is read on, under {@link communityWindowKey}. That makes 36
 * values.
 *
 * The map follows the order of {@link METRICS}, each community window right after its metric. A value
 * is `null` when it is unknown (the archive does not hold what the metric needs, or the metric does
 * not apply to this match), and it is never replaced by `0`.
 *
 * A metric must not lose the others: one that throws gives `null` for the value that failed (its
 * value, or its community window), and the failure is passed to `onError`, with the key of the
 * metric, for the caller to log. A result that is not a finite number also becomes `null`, but it is
 * not reported: the metric ran, and its result is only unusable.
 *
 * @param context - The match, seen from the tracked player.
 * @param onError - Told about each computation that throws, with the key of its metric. Whatever it
 *   gets is a technical detail of the archive: it must not be logged with anything that identifies
 *   the player.
 * @returns The projected values by key.
 */
export function projectMetrics(
  context: MatchContext,
  onError?: (key: MetricKey, error: unknown) => void,
): ReadonlyMap<string, number | null> {
  const projection = new Map<string, number | null>();
  for (const metric of METRICS) {
    projection.set(
      metric.key,
      evaluate(metric.key, () => metric.compute(context), onError),
    );
    // Only a curve metric has a community window; the other sources are compared another way.
    if (metric.community.kind === 'curve') {
      const { rate } = metric.community;
      projection.set(
        communityWindowKey(metric.key),
        evaluate(metric.key, () => rate(context), onError),
      );
    }
  }
  return projection;
}
