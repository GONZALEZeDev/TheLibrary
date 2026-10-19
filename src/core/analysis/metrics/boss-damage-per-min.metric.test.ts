/**
 * Tests of the objective-damage-per-minute metric: how much damage the tracked player dealt to the
 * objectives for each minute of the match.
 *
 * The contexts are built by hand, as plain objects, from synthetic numbers: the metric only reads
 * the tracked player's snapshots and the length of the match, not a whole archive.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testMatchContext, testPlayer, testSnapshot } from '../../../test/analysis-context';
import type { MatchContext, Snapshot } from '../match-context';
import { bossDamagePerMinMetric } from './boss-damage-per-min.metric';

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

describe('bossDamagePerMinMetric', () => {
  it('is an objectives rate, the higher the better, compared with the community objective damage', () => {
    expect(bossDamagePerMinMetric).toMatchObject({
      key: 'boss_damage_per_min',
      family: 'objectives',
      unit: 'per_min',
      better: 'higher',
      group: 'objective_damage',
      display: 'relative',
      personal: 'as_is',
      integer: false,
      community: { kind: 'percentiles', benchmark: 'boss_damage_per_min' },
    });
  });

  it('computes the damage to objectives per minute', () => {
    const context = matchContext([
      testSnapshot(600, { boss_damage: 1_500 }),
      testSnapshot(DURATION_S, { boss_damage: 24_000 }),
    ]);
    // 24000 damage over 1934 s, which is 24000 / (1934 / 60) per minute.
    expect(bossDamagePerMinMetric.compute(context)).toBeCloseTo(744.57, 2);
  });

  it('reads the latest snapshot that holds the damage when the last one lacks it', () => {
    const context = matchContext([
      testSnapshot(600, { boss_damage: 1_500 }),
      testSnapshot(1_500, { boss_damage: 14_000 }),
      // The last snapshot is there, but the API left this counter out of it.
      testSnapshot(DURATION_S, { net_worth: 55_000 }),
    ]);
    expect(bossDamagePerMinMetric.compute(context)).toBeCloseTo(14_000 / (DURATION_S / 60), 6);
  });

  it('is null without boss_damage', () => {
    const context = matchContext([
      testSnapshot(600, { player_damage: 9_000 }),
      testSnapshot(DURATION_S, { player_damage: 32_900 }),
    ]);
    expect(bossDamagePerMinMetric.compute(context)).toBeNull();
  });

  it('is null for a player without any snapshot', () => {
    expect(bossDamagePerMinMetric.compute(matchContext([]))).toBeNull();
  });

  it('is zero for a player who never hit an objective, not unknown', () => {
    // A counter at 0 is a value: only a counter that is absent is unknown.
    const context = matchContext([testSnapshot(DURATION_S, { boss_damage: 0 })]);
    expect(bossDamagePerMinMetric.compute(context)).toBe(0);
  });

  it('divides by at least one second for a match of no length', () => {
    // max(1, 0) / 60 of a minute: 60 damage in that second is 3600 per minute, not infinity.
    const context = matchContext([testSnapshot(0, { boss_damage: 60 })], 0);
    expect(bossDamagePerMinMetric.compute(context)).toBeCloseTo(3_600, 6);
  });
});
