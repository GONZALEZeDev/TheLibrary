/**
 * Tests of the accuracy metric: how the shots that hit and the shots that missed, read from the
 * statistic snapshots of the tracked player, make one fraction.
 *
 * The contexts are built by hand, as plain objects, from synthetic numbers: the metric only reads
 * the tracked player's snapshots, not a whole archive.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testMatchContext, testPlayer, testSnapshot } from '../../../test/analysis-context';
import type { MatchContext, Snapshot } from '../match-context';
import { accuracyMetric } from './accuracy.metric';

/** The length of the hand-built match in seconds: 32 minutes and 14 seconds. */
const DURATION_S = 1_934;

/**
 * Build the context of a hand-built match, in which the tracked player alone is described.
 *
 * @param snapshots - The statistic snapshots of the tracked player, sorted by time.
 * @returns The match context (no teammate, no enemy: the metric reads neither).
 */
function matchContext(snapshots: readonly Snapshot[]): MatchContext {
  return testMatchContext({ durationS: DURATION_S, tracked: testPlayer({ snapshots }) });
}

describe('accuracyMetric', () => {
  it('is a combat percentage, the higher the better, compared with the community accuracy', () => {
    expect(accuracyMetric).toMatchObject({
      key: 'accuracy',
      family: 'combat',
      unit: 'percent',
      better: 'higher',
      group: 'accuracy',
      display: 'absolute',
      personal: 'as_is',
      integer: false,
      community: { kind: 'percentiles', benchmark: 'accuracy' },
    });
  });

  it('is 0.41 for 410 hits and 590 misses', () => {
    const context = matchContext([
      testSnapshot(600, { shots_hit: 90, shots_missed: 160 }),
      testSnapshot(DURATION_S, { shots_hit: 410, shots_missed: 590 }),
    ]);
    // 410 of the 1000 shots hit: a fraction from 0 to 1, not a percentage.
    expect(accuracyMetric.compute(context)).toBe(0.41);
  });

  it('divides the hits by all the shots', () => {
    // The two counters are the player's shots as a whole, as the deadlock-api's own accuracy is:
    // 300 hits among 800 shots, never 300 hits over the 500 misses.
    const context = matchContext([testSnapshot(DURATION_S, { shots_hit: 300, shots_missed: 500 })]);
    expect(accuracyMetric.compute(context)).toBe(0.375);
  });

  it('reads each counter in the latest snapshot that holds it', () => {
    const context = matchContext([
      testSnapshot(600, { shots_hit: 100, shots_missed: 200 }),
      testSnapshot(1_500, { shots_hit: 300, shots_missed: 500 }),
      // The last snapshot is there, but the API left both shot counters out of it.
      testSnapshot(DURATION_S, { net_worth: 55_000 }),
    ]);
    expect(accuracyMetric.compute(context)).toBe(0.375);
  });

  it('is zero for a player who missed every shot, not unknown', () => {
    // A fraction of 0 is a value: only a counter that is absent, or a player who never shot, is not.
    const context = matchContext([testSnapshot(DURATION_S, { shots_hit: 0, shots_missed: 120 })]);
    expect(accuracyMetric.compute(context)).toBe(0);
  });

  it('is one for a player who hit every shot', () => {
    const context = matchContext([testSnapshot(DURATION_S, { shots_hit: 85, shots_missed: 0 })]);
    expect(accuracyMetric.compute(context)).toBe(1);
  });

  it('is null with no shot', () => {
    // 0 of 0 shots is not an accuracy of 0 (nor a division by zero): there is nothing to rate.
    const context = matchContext([testSnapshot(DURATION_S, { shots_hit: 0, shots_missed: 0 })]);
    expect(accuracyMetric.compute(context)).toBeNull();
  });

  it('is null without shots_hit', () => {
    const context = matchContext([testSnapshot(DURATION_S, { shots_missed: 590 })]);
    expect(accuracyMetric.compute(context)).toBeNull();
  });

  it('is null without shots_missed', () => {
    const context = matchContext([testSnapshot(DURATION_S, { shots_hit: 410 })]);
    expect(accuracyMetric.compute(context)).toBeNull();
  });

  it('is null for a player without any snapshot', () => {
    expect(accuracyMetric.compute(matchContext([]))).toBeNull();
  });
});
