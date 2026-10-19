/**
 * The KDA metric: the kills and assists of the tracked player for each of their deaths.
 *
 * @packageDocumentation
 */
import type { MetricDefinition } from '../metric';

/**
 * The KDA: `(kills + assists) / max(1, deaths)`, from the tracked player's end-of-game counts.
 *
 * A player with no death divides by one instead of by zero, so a flawless match is rated by what the
 * player did and not as an infinite ratio.
 *
 * It reads the end-of-game fields and not the last statistic snapshot: the game's scoreboard and the
 * deadlock-api both count from the end-of-game fields, and the last snapshot's kills and deaths
 * differ from them for about four players in ten. Reading the snapshot would give a KDA that
 * disagrees with the one the player sees in the game and with the community's KDA percentiles.
 */
export const kdaMetric: MetricDefinition = {
  key: 'kda',
  family: 'combat',
  unit: 'ratio',
  better: 'higher',
  group: 'kda',
  display: 'relative',
  personal: 'as_is',
  integer: false,
  community: { kind: 'percentiles', benchmark: 'kda' },
  compute: ({ tracked }) => (tracked.kills + tracked.assists) / Math.max(1, tracked.deaths),
};
