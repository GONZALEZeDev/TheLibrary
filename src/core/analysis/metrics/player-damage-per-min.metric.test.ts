/**
 * Tests of the damage-to-heroes-per-minute metric, and of `finalStat`, the reader of a counter's
 * final value that this metric and the other snapshot metrics share.
 *
 * The contexts are built by hand, as plain objects, from synthetic numbers: the metric only reads
 * the tracked player's snapshots and the length of the match, not a whole archive.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testMatchContext, testPlayer, testSnapshot } from '../../../test/analysis-context';
import type { MatchContext, Snapshot } from '../match-context';
import { finalStat } from '../metric';
import { playerDamagePerMinMetric } from './player-damage-per-min.metric';

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

describe('playerDamagePerMinMetric', () => {
  it('is a combat rate, the higher the better, compared with the community damage per minute', () => {
    expect(playerDamagePerMinMetric).toMatchObject({
      key: 'player_damage_per_min',
      family: 'combat',
      unit: 'per_min',
      better: 'higher',
      group: 'hero_damage',
      display: 'relative',
      personal: 'as_is',
      integer: false,
      community: { kind: 'percentiles', benchmark: 'player_damage_per_min' },
    });
  });

  it('computes the damage to heroes per minute', () => {
    const context = matchContext([
      testSnapshot(600, { player_damage: 9_000 }),
      testSnapshot(DURATION_S, { player_damage: 32_900 }),
    ]);
    // 32900 damage over 1934 s, which is 32900 / (1934 / 60) per minute.
    expect(playerDamagePerMinMetric.compute(context)).toBeCloseTo(1_020.68, 2);
  });

  it('reads the latest snapshot that holds the damage when the last one lacks it', () => {
    const context = matchContext([
      testSnapshot(600, { player_damage: 9_000 }),
      testSnapshot(1_500, { player_damage: 24_000 }),
      // The last snapshot is there, but the API left this counter out of it.
      testSnapshot(DURATION_S, { net_worth: 55_000 }),
    ]);
    expect(playerDamagePerMinMetric.compute(context)).toBeCloseTo(24_000 / (DURATION_S / 60), 6);
  });

  it('is null without player_damage', () => {
    const context = matchContext([
      testSnapshot(600, { net_worth: 9_000 }),
      testSnapshot(DURATION_S, { net_worth: 55_000 }),
    ]);
    expect(playerDamagePerMinMetric.compute(context)).toBeNull();
  });

  it('is null for a player without any snapshot', () => {
    expect(playerDamagePerMinMetric.compute(matchContext([]))).toBeNull();
  });

  it('is zero for a player who dealt no damage, not unknown', () => {
    // A counter at 0 is a value: only a counter that is absent is unknown.
    const context = matchContext([testSnapshot(DURATION_S, { player_damage: 0 })]);
    expect(playerDamagePerMinMetric.compute(context)).toBe(0);
  });

  it('divides by at least one second for a match of no length', () => {
    // max(1, 0) / 60 of a minute: 60 damage in that second is 3600 per minute, not infinity.
    const context = matchContext([testSnapshot(0, { player_damage: 60 })], 0);
    expect(playerDamagePerMinMetric.compute(context)).toBeCloseTo(3_600, 6);
  });
});

describe('finalStat', () => {
  it('is the value of the latest snapshot', () => {
    const player = testPlayer({
      snapshots: [
        testSnapshot(600, { net_worth: 9_000 }),
        testSnapshot(1_200, { net_worth: 21_000 }),
        testSnapshot(1_800, { net_worth: 40_000 }),
      ],
    });
    expect(finalStat(player, 'net_worth')).toBe(40_000);
  });

  it('skips a latest snapshot that lacks the counter', () => {
    const player = testPlayer({
      snapshots: [
        testSnapshot(600, { player_damage: 9_000 }),
        testSnapshot(1_200, { player_damage: 21_000 }),
        testSnapshot(1_800, { net_worth: 40_000 }),
      ],
    });
    expect(finalStat(player, 'player_damage')).toBe(21_000);
  });

  it('is null when no snapshot holds the counter', () => {
    const player = testPlayer({
      snapshots: [testSnapshot(600, { net_worth: 9_000 }), testSnapshot(1_800, {})],
    });
    expect(finalStat(player, 'player_damage')).toBeNull();
  });

  it('is null for a player without any snapshot', () => {
    expect(finalStat(testPlayer({ snapshots: [] }), 'player_damage')).toBeNull();
  });

  it('keeps a counter at zero as a value', () => {
    const player = testPlayer({ snapshots: [testSnapshot(1_800, { boss_damage: 0 })] });
    expect(finalStat(player, 'boss_damage')).toBe(0);
  });
});
