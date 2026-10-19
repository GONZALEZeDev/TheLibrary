/**
 * The lane souls difference metric: how many souls the tracked player owned ten minutes into the
 * match compared with the players they laned against, the laning phase's measure of who won the lane.
 *
 * @packageDocumentation
 */
import { statAt } from '../match-context';
import type { MatchContext } from '../match-context';
import type { MetricDefinition } from '../metric';
import { SOULS_AT_S } from './souls-at-10min.metric';

/**
 * The tracked player's souls at 10:00 minus the mean of their lane opponents' souls at 10:00.
 *
 * @param context - The match.
 * @returns The difference (negative when the tracked player is behind), or `null` when the match
 *   ends before 10:00, when the tracked player has no lane opponent, or when the souls of the
 *   tracked player or of any opponent at 10:00 are unknown.
 */
function laneSoulsDiffAt10Min(context: MatchContext): number | null {
  // The length of the match decides, not the snapshots: a match that ends before 10:00 has no
  // 10:00, whatever a snapshot past its end would say.
  if (context.durationS < SOULS_AT_S) {
    return null;
  }
  // Nobody to compare with: the tracked player has no lane in the archive, or no enemy was on it.
  if (context.laneOpponents.length === 0) {
    return null;
  }
  const trackedSouls = statAt(context.tracked, 'net_worth', SOULS_AT_S);
  if (trackedSouls === null) {
    return null;
  }
  let opponentsSouls = 0;
  for (const opponent of context.laneOpponents) {
    const souls = statAt(opponent, 'net_worth', SOULS_AT_S);
    // One unknown opponent makes the mean unknown: the mean of the others would pass for the real
    // one, and an unknown value is never replaced by `0`.
    if (souls === null) {
      return null;
    }
    opponentsSouls += souls;
  }
  return trackedSouls - opponentsSouls / context.laneOpponents.length;
}

/**
 * The lane souls difference at 10:00: the `net_worth` counter of the tracked player minus the mean
 * of the same counter over their lane opponents (the enemies assigned to the same lane, usually two),
 * each interpolated between the snapshots that surround 10:00 like the souls at 10:00 are. A
 * positive value means the tracked player was ahead in the lane, a negative one behind.
 *
 * It is the one laning metric with no community reference: the deadlock-api publishes neither a
 * benchmark nor a curve for the difference with the lane opponents, so only the player's habits are
 * compared. The difference is shown as an amount of souls (`absolute`): it hovers around 0 and can
 * be negative, so a percentage of the usual value would mean nothing.
 *
 * The value is `null` when the match ends before 10:00, when the tracked player has no lane
 * opponent, and when any of the souls it needs is unknown: the difference is never extrapolated, and
 * an unknown value is never replaced by `0`.
 */
export const laneSoulsDiffAt10MinMetric: MetricDefinition = {
  key: 'lane_souls_diff_at_10min',
  family: 'laning',
  unit: 'amount',
  better: 'higher',
  group: 'lane_souls_diff',
  display: 'absolute',
  personal: 'as_is',
  integer: false,
  community: { kind: 'none' },
  compute: laneSoulsDiffAt10Min,
};
