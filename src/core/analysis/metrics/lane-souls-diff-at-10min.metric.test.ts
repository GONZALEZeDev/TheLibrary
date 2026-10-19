/**
 * Tests of the lane souls difference metric: the souls the tracked player owned ten minutes into
 * the match, minus the mean of the souls their lane opponents owned at the same time.
 *
 * The contexts are built by hand, as plain objects, from synthetic numbers: the metric only reads
 * the souls of the tracked player and of their lane opponents, and the length of the match.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testMatchContext, testPlayer, testSnapshot } from '../../../test/analysis-context';
import type { MatchContext, PlayerContext, Snapshot } from '../match-context';
import { laneSoulsDiffAt10MinMetric } from './lane-souls-diff-at-10min.metric';

/** The length of the hand-built match in seconds: 30 minutes. */
const DURATION_S = 1_800;

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
 * Build a hand-built player, who only has statistic snapshots.
 *
 * @param slot - Their slot.
 * @param team - Their team.
 * @param snapshots - Their statistic snapshots, sorted by time.
 * @returns The player (on the lane 1, with no end-of-game count: the metric reads none).
 */
function player(slot: number, team: number, snapshots: readonly Snapshot[]): PlayerContext {
  return testPlayer({ slot, team, lane: 1, snapshots });
}

/**
 * Build the context of a hand-built match.
 *
 * @param trackedSnapshots - The statistic snapshots of the tracked player.
 * @param opponents - The players of the other team on the tracked player's lane.
 * @param durationS - The length of the match, in seconds.
 * @returns The match context (no teammate and no other enemy: the metric reads neither).
 */
function matchContext(
  trackedSnapshots: readonly Snapshot[],
  opponents: readonly PlayerContext[],
  durationS = DURATION_S,
): MatchContext {
  return testMatchContext({
    durationS,
    tracked: player(3, 0, trackedSnapshots),
    enemies: opponents,
    laneOpponents: opponents,
  });
}

/** The tracked player of the reference match: 7000 souls at 10:00. */
const TRACKED = [soulsSnapshot(300, 3_500), soulsSnapshot(600, 7_000), soulsSnapshot(900, 11_000)];

/** A lane opponent a little ahead of the tracked player: 7200 souls at 10:00. */
const OPPONENT_NEAR_AHEAD = player(8, 1, [soulsSnapshot(300, 3_600), soulsSnapshot(600, 7_200)]);

/** A lane opponent far ahead of the tracked player: 8400 souls at 10:00. */
const OPPONENT_FAR_AHEAD = player(9, 1, [soulsSnapshot(300, 4_000), soulsSnapshot(600, 8_400)]);

describe('laneSoulsDiffAt10MinMetric', () => {
  it('is a laning amount, the higher the better, with no community reference', () => {
    expect(laneSoulsDiffAt10MinMetric).toMatchObject({
      key: 'lane_souls_diff_at_10min',
      family: 'laning',
      unit: 'amount',
      better: 'higher',
      group: 'lane_souls_diff',
      display: 'absolute',
      personal: 'as_is',
      integer: false,
      community: { kind: 'none' },
    });
  });

  it('compares the tracked player with the mean of the two lane opponents', () => {
    // Tracked 7000, opponents 7200 and 8400: 7000 - 7800.
    const context = matchContext(TRACKED, [OPPONENT_NEAR_AHEAD, OPPONENT_FAR_AHEAD]);
    expect(laneSoulsDiffAt10MinMetric.compute(context)).toBe(-800);
  });

  it('is positive when the tracked player owns more souls than the opponents', () => {
    const farBehind = player(8, 1, [soulsSnapshot(600, 6_000)]);
    const nearBehind = player(9, 1, [soulsSnapshot(600, 6_400)]);
    const context = matchContext(TRACKED, [farBehind, nearBehind]);
    // 7000 - (6000 + 6400) / 2.
    expect(laneSoulsDiffAt10MinMetric.compute(context)).toBe(800);
  });

  it('is zero for a tracked player level with the mean of the opponents', () => {
    const low = player(8, 1, [soulsSnapshot(600, 6_500)]);
    const high = player(9, 1, [soulsSnapshot(600, 7_500)]);
    expect(laneSoulsDiffAt10MinMetric.compute(matchContext(TRACKED, [low, high]))).toBe(0);
  });

  it('compares with the only opponent of a lane that has one', () => {
    // A lane with a single enemy (the other left, or the lane is 1 against 1): no mean to take.
    expect(laneSoulsDiffAt10MinMetric.compute(matchContext(TRACKED, [OPPONENT_FAR_AHEAD]))).toBe(
      -1_400,
    );
  });

  it('interpolates the souls of everyone at 10:00', () => {
    // Tracked: 6000 at 540 s and 9000 at 720 s put 10:00 a third of the way, at 7000. Opponent:
    // 4000 at 480 s and 6000 at 720 s put 10:00 half-way, at 5000.
    const tracked = [soulsSnapshot(540, 6_000), soulsSnapshot(720, 9_000)];
    const opponent = player(8, 1, [soulsSnapshot(480, 4_000), soulsSnapshot(720, 6_000)]);
    expect(laneSoulsDiffAt10MinMetric.compute(matchContext(tracked, [opponent]))).toBe(2_000);
  });

  it('is null without a lane opponent', () => {
    // The tracked player has no lane in the archive, so nobody is their opponent.
    expect(laneSoulsDiffAt10MinMetric.compute(matchContext(TRACKED, []))).toBeNull();
  });

  it('is null when the match ends before 10:00', () => {
    const tracked = [soulsSnapshot(300, 3_500), soulsSnapshot(540, 6_300)];
    const opponent = player(8, 1, [soulsSnapshot(300, 3_600), soulsSnapshot(540, 6_000)]);
    expect(laneSoulsDiffAt10MinMetric.compute(matchContext(tracked, [opponent], 540))).toBeNull();
  });

  it('is null when the match ends before 10:00, whatever the snapshots say', () => {
    // A snapshot past the end of the match cannot be: the length of the match decides.
    const context = matchContext(TRACKED, [OPPONENT_NEAR_AHEAD, OPPONENT_FAR_AHEAD], 599);
    expect(laneSoulsDiffAt10MinMetric.compute(context)).toBeNull();
  });

  it('is known for a match of exactly 10:00', () => {
    const tracked = [soulsSnapshot(300, 3_500), soulsSnapshot(600, 7_000)];
    const context = matchContext(tracked, [OPPONENT_NEAR_AHEAD, OPPONENT_FAR_AHEAD], 600);
    expect(laneSoulsDiffAt10MinMetric.compute(context)).toBe(-800);
  });

  it('is null when the souls of the tracked player at 10:00 are unknown', () => {
    // The archive stops counting the tracked player's souls at 9:00: nothing is extrapolated.
    const tracked = [soulsSnapshot(300, 3_500), soulsSnapshot(540, 6_300)];
    expect(
      laneSoulsDiffAt10MinMetric.compute(
        matchContext(tracked, [OPPONENT_NEAR_AHEAD, OPPONENT_FAR_AHEAD]),
      ),
    ).toBeNull();
  });

  it('is null when the souls of one opponent at 10:00 are unknown', () => {
    // Half a mean would pass for the real one: one unknown value makes the whole difference unknown.
    const unknown = player(9, 1, [soulsSnapshot(300, 4_000), soulsSnapshot(540, 7_500)]);
    expect(
      laneSoulsDiffAt10MinMetric.compute(matchContext(TRACKED, [OPPONENT_NEAR_AHEAD, unknown])),
    ).toBeNull();
  });

  it('is null when an opponent has no souls at all', () => {
    const silent = player(9, 1, []);
    expect(
      laneSoulsDiffAt10MinMetric.compute(matchContext(TRACKED, [OPPONENT_NEAR_AHEAD, silent])),
    ).toBeNull();
  });

  it('is null for a tracked player without any snapshot', () => {
    expect(
      laneSoulsDiffAt10MinMetric.compute(
        matchContext([], [OPPONENT_NEAR_AHEAD, OPPONENT_FAR_AHEAD]),
      ),
    ).toBeNull();
  });
});
