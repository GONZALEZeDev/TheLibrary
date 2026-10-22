/**
 * The last-hits metric: how many enemy troopers the tracked player killed.
 *
 * @packageDocumentation
 */
import type { MetricDefinition } from '../metric';

/**
 * The last hits: the tracked player's end-of-game last-hit count.
 *
 * It reads the end-of-game field, never a count rebuilt from the creeps killed in the snapshots: the
 * game's scoreboard and the deadlock-api both count from the end-of-game field, so it is the number
 * the player sees in the game and the one the community's last-hit percentiles hold.
 *
 * It is compared with the habits per minute (`personal: per_minute`): a long match would otherwise
 * always look strong in last hits, only because there was more time to farm in. The difference is
 * `relative` (+12 %), as a last-hit count is large enough for a percentage to mean something.
 */
export const lastHitsMetric: MetricDefinition = {
  key: 'last_hits',
  family: 'farm',
  unit: 'count',
  better: 'higher',
  group: 'last_hits',
  display: 'relative',
  personal: 'per_minute',
  integer: true,
  community: { kind: 'percentiles', benchmark: 'last_hits' },
  /**
   * The tracked player's last hits at the end of the match.
   *
   * @returns The last-hit count, never `null`.
   */
  compute: ({ tracked }) => tracked.lastHits,
};
