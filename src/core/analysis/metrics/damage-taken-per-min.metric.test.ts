/**
 * Tests of the damage-taken-per-minute metric: how much damage the tracked player took from enemy
 * heroes for each minute of the match.
 *
 * The contexts are built by hand, as plain objects, from synthetic numbers: the metric only reads
 * the tracked player's snapshots and the length of the match, not a whole archive.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testMatchContext, testPlayer, testSnapshot } from '../../../test/analysis-context';
import type { MatchContext, Snapshot } from '../match-context';
import { damageTakenPerMinMetric } from './damage-taken-per-min.metric';

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

describe('damageTakenPerMinMetric', () => {
  it('is a survival rate, the lower the better, compared with the community damage taken', () => {
    expect(damageTakenPerMinMetric).toMatchObject({
      key: 'damage_taken_per_min',
      family: 'survival',
      unit: 'per_min',
      better: 'lower',
      group: 'damage_taken',
      display: 'relative',
      personal: 'as_is',
      integer: false,
      community: { kind: 'percentiles', benchmark: 'player_damage_taken_per_min' },
    });
  });

  it('computes the damage taken per minute', () => {
    const context = matchContext([
      testSnapshot(600, { player_damage_taken: 7_000 }),
      testSnapshot(DURATION_S, { player_damage_taken: 24_000 }),
    ]);
    // 24000 damage over 1934 s, which is 24000 / (1934 / 60) per minute.
    expect(damageTakenPerMinMetric.compute(context)).toBeCloseTo(744.57, 2);
  });

  it('reads the latest snapshot that holds the damage when the last one lacks it', () => {
    const context = matchContext([
      testSnapshot(600, { player_damage_taken: 7_000 }),
      testSnapshot(1_500, { player_damage_taken: 19_000 }),
      // The last snapshot is there, but the API left this counter out of it.
      testSnapshot(DURATION_S, { net_worth: 55_000 }),
    ]);
    expect(damageTakenPerMinMetric.compute(context)).toBeCloseTo(19_000 / (DURATION_S / 60), 6);
  });

  it('is null without player_damage_taken', () => {
    const context = matchContext([
      testSnapshot(600, { player_damage: 9_000 }),
      testSnapshot(DURATION_S, { player_damage: 32_900 }),
    ]);
    expect(damageTakenPerMinMetric.compute(context)).toBeNull();
  });

  it('is null for a player without any snapshot', () => {
    expect(damageTakenPerMinMetric.compute(matchContext([]))).toBeNull();
  });

  it('is zero for a player who took no damage, not unknown', () => {
    // A counter at 0 is a value: only a counter that is absent is unknown.
    const context = matchContext([testSnapshot(DURATION_S, { player_damage_taken: 0 })]);
    expect(damageTakenPerMinMetric.compute(context)).toBe(0);
  });

  it('divides by at least one second for a match of no length', () => {
    // max(1, 0) / 60 of a minute: 60 damage in that second is 3600 per minute, not infinity.
    const context = matchContext([testSnapshot(0, { player_damage_taken: 60 })], 0);
    expect(damageTakenPerMinMetric.compute(context)).toBeCloseTo(3_600, 6);
  });
});
