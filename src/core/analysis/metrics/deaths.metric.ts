/**
 * The deaths metric: how many times the tracked player died.
 *
 * @packageDocumentation
 */
import type { MetricDefinition } from '../metric';

/**
 * The deaths: the tracked player's end-of-game death count.
 *
 * It is a metric the player wants `lower`: the placement among the community and the difference
 * with the habits are turned, so that dying less than usual reads as a strength.
 *
 * It reads the end-of-game field and not the last statistic snapshot: the game's scoreboard and the
 * deadlock-api both count from the end-of-game field, and the snapshot's deaths can differ from it.
 * It is compared with the habits per minute (`personal: per_minute`): a long match would otherwise
 * always look weak in deaths, only because there was more time to die in. The difference is
 * `absolute` (+2 deaths), a small count where a percentage means little.
 */
export const deathsMetric: MetricDefinition = {
  key: 'deaths',
  family: 'survival',
  unit: 'count',
  better: 'lower',
  group: 'deaths',
  display: 'absolute',
  personal: 'per_minute',
  integer: true,
  community: { kind: 'percentiles', benchmark: 'deaths' },
  /**
   * Reads the death count of the tracked player.
   *
   * @returns The end-of-game death count; never `null`.
   */
  compute: ({ tracked }) => tracked.deaths,
};
