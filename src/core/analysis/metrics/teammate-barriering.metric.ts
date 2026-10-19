/**
 * The teammate-barriering metric: how much barrier the tracked player gave to their teammates.
 *
 * @packageDocumentation
 */
import { finalStat } from '../metric';
import type { MetricDefinition } from '../metric';

/**
 * The barrier given to teammates: the final `teammate_barriering` counter of the tracked player, as a
 * total over the match.
 *
 * The value stays a total, not a rate, because the community's barrier percentiles hold totals. The
 * comparison with the player's habits is per minute instead (`personal: per_minute`): a long match
 * would otherwise always look strong in barriers, only because there was more time to shield in.
 *
 * The counter is read from the snapshots (the end-of-game fields hold no barrier), through
 * {@link finalStat}: it is `null`, not `0`, when no snapshot holds it, so that a payload without the
 * counter is not mistaken for a player who shielded nobody.
 */
export const teammateBarrieringMetric: MetricDefinition = {
  key: 'teammate_barriering',
  family: 'support',
  unit: 'amount',
  better: 'higher',
  group: 'teammate_barriering',
  display: 'relative',
  personal: 'per_minute',
  integer: false,
  community: { kind: 'percentiles', benchmark: 'teammate_barriering' },
  compute: ({ tracked }) => finalStat(tracked, 'teammate_barriering'),
};
