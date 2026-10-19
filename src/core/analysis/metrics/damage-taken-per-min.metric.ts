/**
 * The damage-taken-per-minute metric: how much damage the tracked player took from enemy heroes for
 * each minute of the match.
 *
 * @packageDocumentation
 */
import { matchMinutes } from '../match-context';
import { finalStat } from '../metric';
import type { MetricDefinition } from '../metric';

/**
 * The damage taken per minute: the final `player_damage_taken` counter of the tracked player, divided
 * by the length of the match in minutes.
 *
 * It is a metric the player wants `lower`: the placement among the community and the difference
 * with the habits are turned, so that taking less damage than usual reads as a strength.
 *
 * The counter is read from the snapshots (the end-of-game fields hold no damage), through
 * {@link finalStat}: it is `null`, not `0`, when no snapshot holds it, so that a payload without the
 * counter is not mistaken for a player who took no damage. Dividing by the length of the match makes
 * a long match comparable with a short one, and with the community's damage taken per minute.
 */
export const damageTakenPerMinMetric: MetricDefinition = {
  key: 'damage_taken_per_min',
  family: 'survival',
  unit: 'per_min',
  better: 'lower',
  group: 'damage_taken',
  display: 'relative',
  personal: 'as_is',
  integer: false,
  community: { kind: 'percentiles', benchmark: 'player_damage_taken_per_min' },
  compute: (context) => {
    const damage = finalStat(context.tracked, 'player_damage_taken');
    return damage === null ? null : damage / matchMinutes(context);
  },
};
