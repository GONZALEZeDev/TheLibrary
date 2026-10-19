/**
 * The phase metrics: what the tracked player did in the early, the mid or the late game, as a rate
 * per minute of that phase. Four figures (souls, damage to heroes, damage to objectives, kills) in
 * three phases make twelve cells, and eleven metrics: the early souls are the match metric
 * `souls_at_10min`.
 *
 * A phase metric is the rate of a figure over the phase of the match, so that a phase of any length
 * can be compared with the community's curve and with the player's other matches. The community's
 * curve only covers a stretch of each phase (see `communitySpan`), so every metric also gives the
 * player's rate over that stretch, the one the community's average is read on.
 *
 * @packageDocumentation
 */
import { AppError } from '../../errors/app-error';
import { communitySpan, durationWindowOf } from '../cohort';
import type { MatchContext } from '../match-context';
import type { CurveStat, MetricDefinition, MetricKey, PhaseMetricKey } from '../metric';
import { phaseSpans, phaseTotal } from '../phases';
import type { Phase, PhaseSpan, PhaseStat } from '../phases';

/** One phase metric: the figure it rates and the phase it rates it over. */
interface PhaseMetricCell {
  /** The key of the metric. */
  readonly key: PhaseMetricKey;
  /** The figure the metric rates. */
  readonly stat: PhaseStat;
  /** The phase the metric rates the figure over. */
  readonly phase: Phase;
}

/**
 * The eleven phase metrics, in the order they are listed: the cell of every figure and phase but
 * the early souls, which `souls_at_10min` covers (a match metric, shown in the laning family).
 */
const PHASE_METRIC_CELLS: readonly PhaseMetricCell[] = [
  { key: 'souls_per_min_mid', stat: 'souls', phase: 'mid' },
  { key: 'souls_per_min_late', stat: 'souls', phase: 'late' },
  { key: 'hero_damage_per_min_early', stat: 'hero_damage', phase: 'early' },
  { key: 'hero_damage_per_min_mid', stat: 'hero_damage', phase: 'mid' },
  { key: 'hero_damage_per_min_late', stat: 'hero_damage', phase: 'late' },
  { key: 'objective_damage_per_min_early', stat: 'objective_damage', phase: 'early' },
  { key: 'objective_damage_per_min_mid', stat: 'objective_damage', phase: 'mid' },
  { key: 'objective_damage_per_min_late', stat: 'objective_damage', phase: 'late' },
  { key: 'kills_per_min_early', stat: 'kills', phase: 'early' },
  { key: 'kills_per_min_mid', stat: 'kills', phase: 'mid' },
  { key: 'kills_per_min_late', stat: 'kills', phase: 'late' },
];

/** The key of the metric that covers the early souls, which has no phase metric of its own. */
const EARLY_SOULS_KEY = 'souls_at_10min' satisfies MetricKey;

/**
 * The statistic of the community's curve that each figure of a phase is compared with: the average
 * of the same cumulative counter (the kills are counted as they are).
 */
const CURVE_STAT: Readonly<Record<PhaseStat, CurveStat>> = {
  souls: 'net_worth',
  hero_damage: 'player_damage',
  objective_damage: 'boss_damage',
  kills: 'kills',
};

/**
 * The key of the metric a cell of the phase table reads its value and its comparison from.
 *
 * @param stat - The figure of the cell.
 * @param phase - The phase of the cell.
 * @returns The key of the phase metric (`hero_damage_per_min_mid`…), or `souls_at_10min` for the
 *   souls of the early game: that is the only cell without a phase metric of its own.
 * @throws AppError of kind `unexpected` when the table holds no metric for another cell (a mistake
 *   in the table, since the types allow no other figure or phase): no key is guessed.
 */
export function phaseMetricKey(stat: PhaseStat, phase: Phase): MetricKey {
  // The one cell that has no phase metric of its own: a match metric covers it.
  if (stat === 'souls' && phase === 'early') {
    return EARLY_SOULS_KEY;
  }
  const cell = PHASE_METRIC_CELLS.find(
    (candidate) => candidate.stat === stat && candidate.phase === phase,
  );
  if (cell === undefined) {
    throw new AppError('unexpected', `The phase metrics hold no metric for ${stat} in ${phase}`);
  }
  return cell.key;
}

/**
 * The span of a phase in a match.
 *
 * @param context - The match.
 * @param phase - The phase.
 * @returns The phase as played in the match, or `null` when the match ends before it starts.
 */
function spanOf(context: MatchContext, phase: Phase): PhaseSpan | null {
  return phaseSpans(context.durationS).find((span) => span.phase === phase) ?? null;
}

/**
 * The rate of a figure of the tracked player over a window of the match.
 *
 * @param context - The match.
 * @param stat - The figure.
 * @param startS - The start of the window, in seconds since the start of the match.
 * @param endS - The end of the window, in seconds since the start of the match; the window lasts at
 *   least three minutes (a phase that is not too short, or a community span), so the division by its
 *   length is never a division by zero.
 * @returns The figure per minute of the window, or `null` when it is unknown there.
 */
function rateOver(
  context: MatchContext,
  stat: PhaseStat,
  startS: number,
  endS: number,
): number | null {
  const total = phaseTotal(context, context.tracked, stat, startS, endS);
  return total === null ? null : total / ((endS - startS) / 60);
}

/**
 * Build the definition of a phase metric.
 *
 * @param cell - The figure and the phase the metric rates.
 * @returns The metric.
 */
function phaseMetric(cell: PhaseMetricCell): MetricDefinition {
  const { key, stat, phase } = cell;
  return {
    key,
    family: null,
    unit: 'per_min',
    better: 'higher',
    // The group is the figure itself: `souls_per_min_mid` and `souls_at_10min` both say how well
    // the player farmed, so the summary shows at most one of them.
    group: stat,
    // The kills of a phase are a small count (a few per phase), where a percentage of the usual
    // value jumps with one kill: the difference is shown in kills per minute instead.
    display: stat === 'kills' ? 'absolute' : 'relative',
    personal: 'as_is',
    integer: false,
    community: {
      kind: 'curve',
      stat: CURVE_STAT[stat],
      phase,
      rate: (context) => {
        const span = spanOf(context, phase);
        if (span === null) {
          return null;
        }
        // A phase shorter than three minutes has a community span of less than three as well, so
        // `communitySpan` leaves it out: the phase need not be checked a second time here.
        const shared = communitySpan(span, durationWindowOf(context.durationS));
        return shared === null ? null : rateOver(context, stat, shared.startS, shared.endS);
      },
    },
    compute: (context) => {
      const span = spanOf(context, phase);
      // A phase the match does not reach, or one too short to compare, has no rate.
      if (span?.comparable !== true) {
        return null;
      }
      return rateOver(context, stat, span.startS, span.endS);
    },
  };
}

/**
 * The eleven phase metrics: the rate per minute of the souls, the damage to heroes, the damage to
 * objectives and the kills of the tracked player over the early, the mid and the late game. The
 * early game has no souls metric of its own: `souls_at_10min` covers it.
 *
 * The value of a metric is the figure's growth over the phase (the kills made in it, for the kills)
 * divided by the phase's length in minutes, so a phase of any length is rated per minute of the
 * phase and not per minute of the match. It is `null` when the match does not reach the phase, when
 * the phase lasts less than three minutes (a late game that ends at 26:00, for instance: too short
 * to rate), and when the archive does not hold the counter over the whole phase (an unknown value
 * is never replaced by `0`).
 *
 * The community only gives the average of each counter at each time of the match, for the matches
 * of a duration window. A phase is therefore compared with the community over the stretch of the
 * phase that the window guarantees: from the start of the phase to its end or to the shortest match
 * of the window, whichever comes first (`communitySpan`). The metric's `community.rate` is the
 * player's rate over that same stretch, and `null` when the stretch is shorter than three minutes.
 * A 70-minute match, for instance, is compared on its late game from 25:00 to 45:00 only, the part
 * every match of its window reaches. Comparing the same span on both sides is what keeps a long
 * match from looking better than the average.
 */
export const PHASE_METRICS: readonly MetricDefinition[] = PHASE_METRIC_CELLS.map(phaseMetric);
