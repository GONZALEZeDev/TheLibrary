/**
 * Tests of the souls-per-minute metric: the souls the tracked player owned at the end of the match,
 * for each minute of the match, and which of the two copies of those souls in the archive it reads.
 *
 * The contexts are built by hand, as plain objects, from synthetic numbers: the metric only reads
 * the tracked player and the length of the match, not a whole archive.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testMatchContext, testPlayer, testSnapshot } from '../../../test/analysis-context';
import type { MatchContext, Snapshot } from '../match-context';
import { soulsPerMinMetric } from './souls-per-min.metric';

/** The length of the hand-built match in seconds: 32 minutes and 14 seconds. */
const DURATION_S = 1_934;

/**
 * Build a snapshot that holds only the souls.
 *
 * @param timeS - When it was taken, in seconds.
 * @param netWorth - The souls of the player at that time.
 * @returns The snapshot.
 */
function soulsSnapshot(timeS: number, netWorth: number): Snapshot {
  return testSnapshot(timeS, { net_worth: netWorth });
}

/**
 * Build the context of a hand-built match, in which the tracked player alone is described.
 *
 * @param netWorth - The end-of-game souls of the tracked player.
 * @param snapshots - The statistic snapshots of the tracked player, sorted by time.
 * @param durationS - The length of the match, in seconds.
 * @returns The match context (no teammate, no enemy: the metric reads neither).
 */
function matchContext(
  netWorth: number,
  snapshots: readonly Snapshot[] = [],
  durationS = DURATION_S,
): MatchContext {
  return testMatchContext({ durationS, tracked: testPlayer({ netWorth, snapshots }) });
}

describe('soulsPerMinMetric', () => {
  it('is a farm rate, the higher the better, compared with the community net worth per minute', () => {
    expect(soulsPerMinMetric).toMatchObject({
      key: 'souls_per_min',
      family: 'farm',
      unit: 'per_min',
      better: 'higher',
      group: 'souls',
      display: 'relative',
      personal: 'as_is',
      integer: false,
      community: { kind: 'percentiles', benchmark: 'net_worth_per_min' },
    });
  });

  it('computes 38200 souls in 1934 s as 1185.11 souls per minute', () => {
    // 38200 souls over 1934 s, which is 38200 / (1934 / 60) per minute.
    expect(soulsPerMinMetric.compute(matchContext(38_200))).toBeCloseTo(1_185.11, 2);
  });

  it('uses the end-of-game net worth when the last snapshot is 50 lower', () => {
    // The API's last snapshot can be a few souls behind the end-of-game net worth (the game's
    // scoreboard and the API both use the end-of-game one): 38150 would give 1183.56 per minute.
    const context = matchContext(38_200, [
      soulsSnapshot(600, 9_000),
      soulsSnapshot(DURATION_S, 38_150),
    ]);
    expect(soulsPerMinMetric.compute(context)).toBeCloseTo(1_185.11, 2);
  });

  it('is known for a match without any snapshot', () => {
    // The end-of-game fields are required in every archive, unlike the snapshots: this metric has
    // no null case.
    expect(soulsPerMinMetric.compute(matchContext(38_200, []))).toBeCloseTo(1_185.11, 2);
  });

  it('is zero for a player who owned no souls, not unknown', () => {
    expect(soulsPerMinMetric.compute(matchContext(0))).toBe(0);
  });

  it('divides by at least one second for a match of no length', () => {
    // max(1, 0) / 60 of a minute: 60 souls in that second is 3600 per minute, not infinity.
    expect(soulsPerMinMetric.compute(matchContext(60, [], 0))).toBeCloseTo(3_600, 6);
  });
});
