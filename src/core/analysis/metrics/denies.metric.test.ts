/**
 * Tests of the denies metric: the number of times the tracked player denied souls to the enemy
 * team, and which of the copies of that count in the archive it reads.
 *
 * The contexts are built by hand, as plain objects, from synthetic numbers: the metric only reads
 * the tracked player, not a whole archive.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testMatchContext, testPlayer, testSnapshot } from '../../../test/analysis-context';
import type { MatchContext, Snapshot } from '../match-context';
import { deniesMetric } from './denies.metric';

/**
 * Build the context of a hand-built match, in which the tracked player alone is described.
 *
 * @param denies - The end-of-game denies of the tracked player.
 * @param snapshots - The statistic snapshots of the tracked player, sorted by time.
 * @returns The match context (no teammate, no enemy: the metric reads neither).
 */
function matchContext(denies: number, snapshots: readonly Snapshot[] = []): MatchContext {
  return testMatchContext({ tracked: testPlayer({ denies, snapshots }) });
}

describe('deniesMetric', () => {
  it('is a farm count, the higher the better, compared with the community denies', () => {
    expect(deniesMetric).toMatchObject({
      key: 'denies',
      family: 'farm',
      unit: 'count',
      better: 'higher',
      group: 'denies',
      display: 'absolute',
      personal: 'per_minute',
      integer: true,
      community: { kind: 'percentiles', benchmark: 'denies' },
    });
  });

  it('is the number of denies', () => {
    expect(deniesMetric.compute(matchContext(23))).toBe(23);
  });

  it('reads the end-of-game field, not a count of the snapshot', () => {
    // A snapshot can carry a count of denies that differs from the end-of-game one (the game's
    // scoreboard and the API both use the end-of-game one). The context does not model that count
    // on a snapshot at all, so it is given through a variable: the metric must not pick it up,
    // whatever a hand-built context holds.
    const disagreeingStats = { net_worth: 38_000, denies: 26 };
    const context = matchContext(23, [testSnapshot(1_934, disagreeingStats)]);
    expect(deniesMetric.compute(context)).toBe(23);
  });

  it('is zero for a player without any deny, not unknown', () => {
    expect(deniesMetric.compute(matchContext(0))).toBe(0);
  });

  it('is known for a match without any snapshot', () => {
    // The end-of-game fields are required in every archive, unlike the snapshots: this metric has
    // no null case.
    expect(deniesMetric.compute(matchContext(9, []))).toBe(9);
  });
});
