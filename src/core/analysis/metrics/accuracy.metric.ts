/**
 * The accuracy metric: the share of the tracked player's shots that hit.
 *
 * @packageDocumentation
 */
import { finalStat } from '../metric';
import type { MetricDefinition } from '../metric';

/**
 * The accuracy: `shots_hit / (shots_hit + shots_missed)`, a fraction from 0 to 1, from the final
 * values of the two shot counters of the tracked player.
 *
 * It counts all the shots, the ones at heroes and the ones at anything else, as the deadlock-api's
 * own `accuracy` does: the community's accuracy percentiles are built from that definition, so a
 * narrower one would put the player among them on another scale.
 *
 * The counters are read from the snapshots through {@link finalStat} (the end-of-game fields hold no
 * shots). The metric is `null`, not `0`, when either counter is unknown, and when the player never
 * shot (`0` of `0` shots has no accuracy; it is not an accuracy of `0`).
 *
 * The difference with the habits is `absolute`: a gap between two fractions reads as points of
 * accuracy (+3 points), where a percentage of a percentage (+7 %) would be ambiguous.
 */
export const accuracyMetric: MetricDefinition = {
  key: 'accuracy',
  family: 'combat',
  unit: 'percent',
  better: 'higher',
  group: 'accuracy',
  display: 'absolute',
  personal: 'as_is',
  integer: false,
  community: { kind: 'percentiles', benchmark: 'accuracy' },
  /**
   * Reads the accuracy of the tracked player.
   *
   * @returns The share of shots that hit, from 0 to 1; `null` when a counter is unknown or no shot
   * was fired.
   */
  compute: ({ tracked }) => {
    const hit = finalStat(tracked, 'shots_hit');
    const missed = finalStat(tracked, 'shots_missed');
    if (hit === null || missed === null) {
      return null;
    }
    const shots = hit + missed;
    return shots === 0 ? null : hit / shots;
  },
};
