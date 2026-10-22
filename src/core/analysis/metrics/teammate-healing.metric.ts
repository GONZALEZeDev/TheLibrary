/**
 * The teammate-healing metric: how much health the tracked player gave back to their teammates.
 *
 * @packageDocumentation
 */
import { finalStat } from '../metric';
import type { MetricDefinition } from '../metric';

/**
 * The healing given to teammates: the final `teammate_healing` counter of the tracked player, as a
 * total over the match.
 *
 * The value stays a total, not a rate, because the community's healing percentiles hold totals. The
 * comparison with the player's habits is per minute instead (`personal: per_minute`): a long match
 * would otherwise always look strong in healing, only because there was more time to heal in.
 *
 * The counter is read from the snapshots (the end-of-game fields hold no healing), through
 * {@link finalStat}: it is `null`, not `0`, when no snapshot holds it, so that a payload without the
 * counter is not mistaken for a player who healed nobody.
 */
export const teammateHealingMetric: MetricDefinition = {
  key: 'teammate_healing',
  family: 'support',
  unit: 'amount',
  better: 'higher',
  group: 'teammate_healing',
  display: 'relative',
  personal: 'per_minute',
  integer: false,
  community: { kind: 'percentiles', benchmark: 'teammate_healing' },
  /**
   * The health the tracked player gave back to their teammates over the whole match.
   *
   * @returns The total healing, or `null` when no snapshot holds the `teammate_healing` counter.
   */
  compute: ({ tracked }) => finalStat(tracked, 'teammate_healing'),
};
