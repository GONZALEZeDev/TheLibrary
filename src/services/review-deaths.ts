/**
 * The rows of the deaths tab of the review: the player's deaths in each phase of the match against
 * the players of the tier above.
 *
 * Every row is a point judged match by match and summed up around the **mean** (`./review-row`), as
 * the tier's figures of these points are means: an average number of deaths over a stretch of the
 * match. The gap with the tier is an amount in the unit of the point.
 *
 * - **The deaths of a phase.** The early and mid games count deaths per match, and only in the matches
 *   that played the whole phase (10:00 and 25:00): a match that ended in the middle of a phase would
 *   look better only for being shorter. The late game has no end of its own, so it counts deaths per
 *   10 minutes of the late game, whatever the length of the match. A match is placed by its deaths
 *   over the stretch of the phase that the tier's curve covers (`curveStretchFor`,
 *   `./community-placement`), against the tier's rate over the same stretch, and is weak or strong
 *   from where it falls on the curve, fewer deaths being better. For a complete early or mid game
 *   that stretch is the whole phase; for the late game it ends at the time every match of the tier
 *   reaches, so the gap is told on that stretch, and the player's figure on the whole phase.
 *
 * What is not known is left out and never taken for zero: a match without the death details of the
 * archive has no deaths. A match that cannot be placed among the tier (its data is not cached, or not
 * for its length) is still counted, without a mark.
 *
 * The phases and the duration window of a match are worked out once, when the rows are built, and
 * passed down to every row. The resistance items and the deaths before the first one are on the same
 * tab of the page, and have their own module (`./review-resistance`).
 *
 * Nothing here reads a database, a file or the network, and nothing is logged.
 *
 * @packageDocumentation
 */
import { orientedPercentile } from '../core/analysis/insights/insights';
import { PHASES, PHASE_START_S, spanOf, type Phase } from '../core/analysis/phases';
import { placeOnCurve } from '../core/analysis/references';
import { markOfPercentile } from '../core/analysis/review/review-rules';
import { phaseDeathsKey, phaseDeathsWindowKey } from '../core/analysis/review/review-values';
import { curveStretchFor } from './community-placement';
import type { RecentMatch } from './metrics.repository';
import {
  UNJUDGED,
  placeMatches,
  placeReviewMatches,
  pointRowOf,
  type PlacedMatch,
  type PlacedReviewMatch,
  type ReviewPoint,
} from './review-row';
import type { ReviewMatch, ReviewRow } from './review-view';

/** The length the deaths of the late game are counted per, in minutes. */
const LATE_GAME_UNIT_MINUTES = 10;

/**
 * Tell whether a match played the whole of a phase. The late game has no end of its own: it is
 * played whole whenever it is played at all.
 *
 * @param phase - The phase.
 * @param durationS - The length of the match, in seconds.
 * @returns `true` when the match lasted to the start of the next phase (10:00 for the early game,
 *   25:00 for the mid game), or when the phase is the last one.
 */
function isPlayedWhole(phase: Phase, durationS: number): boolean {
  const next = PHASES[PHASES.indexOf(phase) + 1];
  return next === undefined || durationS >= PHASE_START_S[next];
}

/**
 * The deaths of the player over some minutes of a phase, in the unit of the phase's row: the number
 * of deaths for the early and mid games, deaths per 10 minutes for the late game.
 *
 * @param phase - The phase.
 * @param deaths - The deaths over the stretch.
 * @param minutes - The length of the stretch, in minutes.
 * @returns The figure.
 */
function deathsFigureOf(phase: Phase, deaths: number, minutes: number): number {
  return phase === 'late' ? (deaths / minutes) * LATE_GAME_UNIT_MINUTES : deaths;
}

/**
 * The deaths of the tier over some minutes of a phase, in the unit of the phase's row.
 *
 * @param phase - The phase.
 * @param ratePerMinute - The tier's deaths per minute over the stretch.
 * @param minutes - The length of the stretch, in minutes.
 * @returns The figure: the deaths the tier counts over the stretch, or per 10 minutes for the late
 *   game.
 */
function communityDeathsFigureOf(phase: Phase, ratePerMinute: number, minutes: number): number {
  return ratePerMinute * (phase === 'late' ? LATE_GAME_UNIT_MINUTES : minutes);
}

/**
 * The point of the deaths of a phase.
 *
 * @param phase - The phase.
 * @returns The point: the mean of the deaths of the phase, the gap an amount.
 */
function phaseDeathsPoint(phase: Phase): ReviewPoint<PlacedReviewMatch, PlacedMatch> {
  return {
    subject: { kind: 'phase_deaths', phase },
    unit: phase === 'late' ? 'deaths_per_10_min' : 'deaths',
    better: 'lower',
    display: 'absolute',
    center: 'mean',
    valueIn: ({ match, basis }) => {
      // The span is missing when the match never reached the phase: whatever it stored for it is
      // not read.
      const span = spanOf(basis.spans, phase);
      const deaths = match.values.get(phaseDeathsKey(phase)) ?? null;
      return span === undefined || deaths === null || !isPlayedWhole(phase, match.durationS)
        ? null
        : deathsFigureOf(phase, deaths, span.minutes);
    },
    judge: ({ match, basis, reference }) => {
      if (reference === null) {
        return UNJUDGED;
      }
      const stretch = curveStretchFor(phase, 'deaths', basis, reference);
      const deaths = match.values.get(phaseDeathsWindowKey(phase)) ?? null;
      if (stretch === null || deaths === null) {
        return UNJUDGED;
      }
      const { minutes, average } = stretch;
      const placement = placeOnCurve(deaths / minutes, average);
      if (placement === null) {
        return UNJUDGED;
      }
      const percentile = orientedPercentile(placement.percentile, 'lower');
      return {
        mark: markOfPercentile(percentile),
        marked: true,
        percentile,
        comparison: {
          player: deathsFigureOf(phase, deaths, minutes),
          community: communityDeathsFigureOf(phase, average.rate, minutes),
        },
      };
    },
  };
}

/**
 * Build the rows of the deaths tab: the deaths of the player in each phase of the match.
 *
 * @param recent - The last matches, most recent first, each with the tier's data for its duration
 *   window (`null` when none is cached).
 * @param before - The matches before them, which the progress compares with.
 * @returns Three rows, one for each phase, in the order of the match.
 */
export function deathRowsOf(
  recent: readonly ReviewMatch[],
  before: readonly RecentMatch[],
): readonly ReviewRow[] {
  const placedRecent = placeReviewMatches(recent);
  const placedBefore = placeMatches(before);
  return PHASES.map((phase) => pointRowOf(phaseDeathsPoint(phase), placedRecent, placedBefore));
}
