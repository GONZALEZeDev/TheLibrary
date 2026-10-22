/**
 * The objective-damage-per-minute metric: how much damage the tracked player dealt to the objectives
 * for each minute of the match.
 *
 * @packageDocumentation
 */
import { matchMinutes } from '../match-context';
import { finalStat } from '../metric';
import type { MetricDefinition } from '../metric';

/**
 * The damage dealt to objectives per minute: the final `boss_damage` counter of the tracked player,
 * divided by the length of the match in minutes.
 *
 * The counter is read from the snapshots (the end-of-game fields hold no damage), through
 * {@link finalStat}: it is `null`, not `0`, when no snapshot holds it, so that a payload without the
 * counter is not mistaken for a player who never hit an objective. Dividing by the length of the
 * match makes a long match comparable with a short one, and with the community's objective damage per
 * minute.
 */
export const bossDamagePerMinMetric: MetricDefinition = {
  key: 'boss_damage_per_min',
  family: 'objectives',
  unit: 'per_min',
  better: 'higher',
  group: 'objective_damage',
  display: 'relative',
  personal: 'as_is',
  integer: false,
  community: { kind: 'percentiles', benchmark: 'boss_damage_per_min' },
  /**
   * Reads the objective damage of the tracked player, per minute of the match.
   *
   * @param context - The match context: the tracked player and the length of the match.
   * @returns The objective damage per minute; `null` when no snapshot holds the counter.
   */
  compute: (context) => {
    const damage = finalStat(context.tracked, 'boss_damage');
    return damage === null ? null : damage / matchMinutes(context);
  },
};
