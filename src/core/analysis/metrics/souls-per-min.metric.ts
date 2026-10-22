/**
 * The souls-per-minute metric: the souls the tracked player owned at the end of the match, for each
 * minute of the match.
 *
 * @packageDocumentation
 */
import { matchMinutes } from '../match-context';
import type { MetricDefinition } from '../metric';

/**
 * The souls per minute: the tracked player's end-of-game net worth divided by the length of the
 * match in minutes.
 *
 * It reads the end-of-game field and not the last statistic snapshot: the game's scoreboard and the
 * deadlock-api both count from the end-of-game net worth, and the last snapshot can differ from it
 * by a few souls. Reading the snapshot would give a rate that disagrees with the one the player sees
 * in the game and with the community's net worth per minute. Dividing by the length of the match
 * makes a long match comparable with a short one.
 */
export const soulsPerMinMetric: MetricDefinition = {
  key: 'souls_per_min',
  family: 'farm',
  unit: 'per_min',
  better: 'higher',
  group: 'souls',
  display: 'relative',
  personal: 'as_is',
  integer: false,
  community: { kind: 'percentiles', benchmark: 'net_worth_per_min' },
  /**
   * The tracked player's end-of-game souls for each minute of the match.
   *
   * @param context - The match.
   * @returns The souls per minute, never `null`.
   */
  compute: (context) => context.tracked.netWorth / matchMinutes(context),
};
