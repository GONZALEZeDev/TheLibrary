/**
 * Tests of the last-hits metric: the number of enemy troopers the tracked player killed, and which
 * of the copies of that count in the archive it reads.
 *
 * The contexts are built by hand, as plain objects, from synthetic numbers: the metric only reads
 * the tracked player, not a whole archive.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testMatchContext, testPlayer, testSnapshot } from '../../../test/analysis-context';
import type { MatchContext, Snapshot } from '../match-context';
import { lastHitsMetric } from './last-hits.metric';

/**
 * Build the context of a hand-built match, in which the tracked player alone is described.
 *
 * @param lastHits - The end-of-game last hits of the tracked player.
 * @param snapshots - The statistic snapshots of the tracked player, sorted by time.
 * @returns The match context (no teammate, no enemy: the metric reads neither).
 */
function matchContext(lastHits: number, snapshots: readonly Snapshot[] = []): MatchContext {
  return testMatchContext({ tracked: testPlayer({ lastHits, snapshots }) });
}

describe('lastHitsMetric', () => {
  it('is a farm count, the higher the better, compared with the community last hits', () => {
    expect(lastHitsMetric).toMatchObject({
      key: 'last_hits',
      family: 'farm',
      unit: 'count',
      better: 'higher',
      group: 'last_hits',
      display: 'relative',
      personal: 'per_minute',
      integer: true,
      community: { kind: 'percentiles', benchmark: 'last_hits' },
    });
  });

  it('is the number of last hits', () => {
    expect(lastHitsMetric.compute(matchContext(187))).toBe(187);
  });

  it('reads the end-of-game field, never a count rebuilt from the creep kills', () => {
    // A snapshot can carry the creeps the player killed under other names, and they differ from the
    // end-of-game last hits (the game's scoreboard and the API both use the end-of-game one). The
    // context does not model those counts on a snapshot at all, so they are given through a
    // variable: the metric must not pick them up, whatever a hand-built context holds.
    const disagreeingStats = { net_worth: 38_000, creep_kills: 240, last_hits: 190 };
    const context = matchContext(187, [testSnapshot(1_934, disagreeingStats)]);
    expect(lastHitsMetric.compute(context)).toBe(187);
  });

  it('is zero for a player without any last hit, not unknown', () => {
    expect(lastHitsMetric.compute(matchContext(0))).toBe(0);
  });

  it('is known for a match without any snapshot', () => {
    // The end-of-game fields are required in every archive, unlike the snapshots: this metric has
    // no null case.
    expect(lastHitsMetric.compute(matchContext(64, []))).toBe(64);
  });
});
