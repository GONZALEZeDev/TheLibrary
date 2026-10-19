/**
 * Tests of the deaths metric: the number of times the tracked player died, and which of the two
 * copies of that count in the archive it reads.
 *
 * The contexts are built by hand, as plain objects, from synthetic numbers: the metric only reads
 * the tracked player, not a whole archive.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testMatchContext, testPlayer, testSnapshot } from '../../../test/analysis-context';
import type { MatchContext, Snapshot } from '../match-context';
import { deathsMetric } from './deaths.metric';

/**
 * Build the context of a hand-built match, in which the tracked player alone is described.
 *
 * @param deaths - The end-of-game deaths of the tracked player.
 * @param snapshots - The statistic snapshots of the tracked player, sorted by time.
 * @returns The match context (no teammate, no enemy: the metric reads neither).
 */
function matchContext(deaths: number, snapshots: readonly Snapshot[] = []): MatchContext {
  return testMatchContext({ tracked: testPlayer({ deaths, snapshots }) });
}

describe('deathsMetric', () => {
  it('is a survival count, the lower the better, compared with the community deaths', () => {
    expect(deathsMetric).toMatchObject({
      key: 'deaths',
      family: 'survival',
      unit: 'count',
      better: 'lower',
      group: 'deaths',
      display: 'absolute',
      personal: 'per_minute',
      integer: true,
      community: { kind: 'percentiles', benchmark: 'deaths' },
    });
  });

  it('is the number of deaths', () => {
    expect(deathsMetric.compute(matchContext(7))).toBe(7);
  });

  it('reads the deaths from the end-of-game field, not the snapshot', () => {
    // The API's snapshots can count one death more or less than the end-of-game field (the game's
    // scoreboard and the API both use the end-of-game one). The context does not model that count
    // on a snapshot at all, so it is given through a variable: the metric must not pick it up,
    // whatever a hand-built context holds.
    const disagreeingStats = { player_damage_taken: 21_000, deaths: 5 };
    const context = matchContext(4, [testSnapshot(1_934, disagreeingStats)]);
    expect(deathsMetric.compute(context)).toBe(4);
  });

  it('is zero for a player who never died, not unknown', () => {
    expect(deathsMetric.compute(matchContext(0))).toBe(0);
  });

  it('is known for a match without any snapshot', () => {
    // The end-of-game fields are required in every archive, unlike the snapshots: this metric has
    // no null case.
    expect(deathsMetric.compute(matchContext(2, []))).toBe(2);
  });
});
