/**
 * The denies metric: how many times the tracked player denied souls to the enemy team.
 *
 * @packageDocumentation
 */
import type { MetricDefinition } from '../metric';

/**
 * The denies: the tracked player's end-of-game deny count.
 *
 * It reads the end-of-game field and not a statistic snapshot: the game's scoreboard and the
 * deadlock-api both count from the end-of-game field, so it is the number the player sees in the game
 * and the one the community's deny percentiles hold.
 *
 * It is compared with the habits per minute (`personal: per_minute`): a long match would otherwise
 * always look strong in denies, only because there was more time to deny in. The difference is
 * `absolute` (+3 denies): denies are far fewer than last hits, so a percentage of a few units would
 * swing too wildly to mean much.
 */
export const deniesMetric: MetricDefinition = {
  key: 'denies',
  family: 'farm',
  unit: 'count',
  better: 'higher',
  group: 'denies',
  display: 'absolute',
  personal: 'per_minute',
  integer: true,
  community: { kind: 'percentiles', benchmark: 'denies' },
  /**
   * Reads the deny count of the tracked player.
   *
   * @returns The end-of-game deny count; never `null`.
   */
  compute: ({ tracked }) => tracked.denies,
};
