/**
 * Tests of the teammate-barriering metric: the total barrier the tracked player gave to their
 * teammates, read from the statistic snapshots.
 *
 * The contexts are built by hand, as plain objects, from synthetic numbers: the metric only reads
 * the tracked player's snapshots, not a whole archive.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testMatchContext, testPlayer, testSnapshot } from '../../../test/analysis-context';
import type { MatchContext, Snapshot } from '../match-context';
import { teammateBarrieringMetric } from './teammate-barriering.metric';

/** The length of the hand-built match in seconds: 32 minutes and 14 seconds. */
const DURATION_S = 1_934;

/**
 * Build the context of a hand-built match, in which the tracked player alone is described.
 *
 * @param snapshots - The statistic snapshots of the tracked player, sorted by time.
 * @param durationS - The length of the match, in seconds.
 * @returns The match context (no teammate, no enemy: the metric reads neither).
 */
function matchContext(snapshots: readonly Snapshot[], durationS = DURATION_S): MatchContext {
  return testMatchContext({ durationS, tracked: testPlayer({ snapshots }) });
}

describe('teammateBarrieringMetric', () => {
  it('is a support amount, the higher the better, compared with the community barriers', () => {
    expect(teammateBarrieringMetric).toMatchObject({
      key: 'teammate_barriering',
      family: 'support',
      unit: 'amount',
      better: 'higher',
      group: 'teammate_barriering',
      display: 'relative',
      personal: 'per_minute',
      integer: false,
      community: { kind: 'percentiles', benchmark: 'teammate_barriering' },
    });
  });

  it('is the total barrier of the last snapshot', () => {
    const context = matchContext([
      testSnapshot(600, { teammate_barriering: 900 }),
      testSnapshot(DURATION_S, { teammate_barriering: 7_300 }),
    ]);
    expect(teammateBarrieringMetric.compute(context)).toBe(7_300);
  });

  it('is a total, not a rate: the length of the match does not change it', () => {
    // The comparison with the habits divides by the length of the match (`personal: per_minute`),
    // the value itself is what the community's barrier percentiles hold.
    const snapshots = [testSnapshot(1_200, { teammate_barriering: 7_300 })];
    expect(teammateBarrieringMetric.compute(matchContext(snapshots, 1_200))).toBe(7_300);
    expect(teammateBarrieringMetric.compute(matchContext(snapshots, 2_700))).toBe(7_300);
  });

  it('reads the latest snapshot that holds the barrier when the last one lacks it', () => {
    const context = matchContext([
      testSnapshot(600, { teammate_barriering: 900 }),
      testSnapshot(1_500, { teammate_barriering: 4_100 }),
      // The last snapshot is there, but the API left this counter out of it.
      testSnapshot(DURATION_S, { net_worth: 55_000 }),
    ]);
    expect(teammateBarrieringMetric.compute(context)).toBe(4_100);
  });

  it('is null without teammate_barriering', () => {
    const context = matchContext([
      testSnapshot(600, { teammate_healing: 2_400 }),
      testSnapshot(DURATION_S, { teammate_healing: 18_400 }),
    ]);
    expect(teammateBarrieringMetric.compute(context)).toBeNull();
  });

  it('is null for a player without any snapshot', () => {
    expect(teammateBarrieringMetric.compute(matchContext([]))).toBeNull();
  });

  it('is zero for a player who shielded nobody, not unknown', () => {
    // A counter at 0 is a value: only a counter that is absent is unknown.
    const context = matchContext([testSnapshot(DURATION_S, { teammate_barriering: 0 })]);
    expect(teammateBarrieringMetric.compute(context)).toBe(0);
  });
});
