/**
 * The damage-to-heroes-per-minute metric: how much damage the tracked player dealt to enemy heroes
 * for each minute of the match.
 *
 * @packageDocumentation
 */
import { matchMinutes } from '../match-context';
import { finalStat } from '../metric';
import type { MetricDefinition } from '../metric';

/**
 * The damage dealt to heroes per minute: the final `player_damage` counter of the tracked player,
 * divided by the length of the match in minutes.
 *
 * The counter is read from the snapshots (the end-of-game fields hold no damage), through
 * {@link finalStat}: it is `null`, not `0`, when no snapshot holds it, so that a payload without the
 * counter is not mistaken for a player who dealt no damage. Dividing by the length of the match makes
 * a long match comparable with a short one, and with the community's damage per minute.
 */
export const playerDamagePerMinMetric: MetricDefinition = {
  key: 'player_damage_per_min',
  family: 'combat',
  unit: 'per_min',
  better: 'higher',
  group: 'hero_damage',
  display: 'relative',
  personal: 'as_is',
  integer: false,
  community: { kind: 'percentiles', benchmark: 'player_damage_per_min' },
  compute: (context) => {
    const damage = finalStat(context.tracked, 'player_damage');
    return damage === null ? null : damage / matchMinutes(context);
  },
};
