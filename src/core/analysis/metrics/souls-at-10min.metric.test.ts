/**
 * Tests of the souls-at-10:00 metric: the souls the tracked player owned ten minutes into the
 * match, interpolated between the statistic snapshots, and the souls per minute of the early game
 * that is compared with the community's curve.
 *
 * The contexts are built by hand, as plain objects, from synthetic numbers: the metric only reads
 * the tracked player's snapshots and the length of the match, not a whole archive.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testMatchContext, testPlayer, testSnapshot } from '../../../test/analysis-context';
import type { MatchContext, Snapshot } from '../match-context';
import type { MetricDefinition } from '../metric';
import { soulsAt10MinMetric } from './souls-at-10min.metric';

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
 * @param snapshots - The statistic snapshots of the tracked player, sorted by time.
 * @param durationS - The length of the match, in seconds.
 * @returns The match context (no teammate, no enemy: the metric reads neither).
 */
function matchContext(snapshots: readonly Snapshot[], durationS = DURATION_S): MatchContext {
  return testMatchContext({ durationS, tracked: testPlayer({ snapshots }) });
}

/**
 * The function that gives the player's rate over the span the community's curve is compared on.
 *
 * @param metric - A metric whose community reference is a curve.
 * @returns Its `community.rate`; the test fails for a metric with another kind of reference.
 */
function rateOf(metric: MetricDefinition): (context: MatchContext) => number | null {
  const { community } = metric;
  return community.kind === 'curve'
    ? community.rate
    : expect.unreachable('the community reference of this metric is a curve');
}

/** A 32-minute match with a snapshot every three minutes up to 12:00, and one at the end. */
const FULL_MATCH = matchContext([
  soulsSnapshot(180, 2_250),
  soulsSnapshot(360, 4_500),
  soulsSnapshot(540, 6_000),
  soulsSnapshot(720, 9_000),
  soulsSnapshot(DURATION_S, 38_200),
]);

describe('soulsAt10MinMetric', () => {
  it('is a laning amount, the higher the better, compared with the community early curve', () => {
    expect(soulsAt10MinMetric).toMatchObject({
      key: 'souls_at_10min',
      family: 'laning',
      unit: 'amount',
      better: 'higher',
      group: 'souls',
      display: 'relative',
      personal: 'as_is',
      integer: false,
      community: { kind: 'curve', stat: 'net_worth', phase: 'early' },
    });
  });

  it('interpolates the souls at 10:00', () => {
    // 540 s -> 6000 souls and 720 s -> 9000: 10:00 is a third of the way, at 7000.
    expect(soulsAt10MinMetric.compute(FULL_MATCH)).toBe(7_000);
  });

  it('reads the snapshot taken at 10:00 as it is', () => {
    const context = matchContext([
      soulsSnapshot(300, 3_000),
      soulsSnapshot(600, 7_400),
      soulsSnapshot(900, 11_000),
    ]);
    expect(soulsAt10MinMetric.compute(context)).toBe(7_400);
  });

  it('starts from no souls at 0:00 when the first snapshot is after 10:00', () => {
    // Every counter is 0 when the match starts: 7500 souls at 12:00 is 6250 at 10:00 on that line.
    const context = matchContext([soulsSnapshot(720, 7_500)]);
    expect(soulsAt10MinMetric.compute(context)).toBe(6_250);
  });

  it('is known for a match of exactly 10:00', () => {
    // The match reaches 10:00, and its last snapshot is taken at that time.
    const context = matchContext([soulsSnapshot(300, 3_000), soulsSnapshot(600, 7_400)], 600);
    expect(soulsAt10MinMetric.compute(context)).toBe(7_400);
  });

  it('is null when the match ends before 10:00', () => {
    const context = matchContext(
      [soulsSnapshot(180, 2_250), soulsSnapshot(360, 4_500), soulsSnapshot(540, 6_000)],
      540,
    );
    expect(soulsAt10MinMetric.compute(context)).toBeNull();
  });

  it('is null when the match ends before 10:00, whatever a snapshot says', () => {
    // A snapshot past the end of the match cannot be: the length of the match decides, not the
    // snapshots.
    const context = matchContext([soulsSnapshot(300, 3_000), soulsSnapshot(720, 9_000)], 599);
    expect(soulsAt10MinMetric.compute(context)).toBeNull();
  });

  it('is null when the last snapshot with souls is before 10:00', () => {
    // The match lasts past 10:00 but the archive stops counting souls at 9:00: nothing is
    // extrapolated.
    const context = matchContext([soulsSnapshot(300, 3_000), soulsSnapshot(540, 6_000)]);
    expect(soulsAt10MinMetric.compute(context)).toBeNull();
  });

  it('is null without net_worth', () => {
    const context = matchContext([
      testSnapshot(540, { player_damage: 4_000 }),
      testSnapshot(720, { player_damage: 6_000 }),
    ]);
    expect(soulsAt10MinMetric.compute(context)).toBeNull();
  });

  it('is null for a player without any snapshot', () => {
    expect(soulsAt10MinMetric.compute(matchContext([]))).toBeNull();
  });
});

describe('the community rate of soulsAt10MinMetric', () => {
  it('gives the early rate over the community span', () => {
    // 7000 souls over the 10 minutes of the span the community's curve is read on.
    expect(rateOf(soulsAt10MinMetric)(FULL_MATCH)).toBe(700);
  });

  it('is null when the match ends before 10:00', () => {
    const context = matchContext(
      [soulsSnapshot(180, 2_250), soulsSnapshot(360, 4_500), soulsSnapshot(540, 6_000)],
      540,
    );
    expect(rateOf(soulsAt10MinMetric)(context)).toBeNull();
  });

  it('is null when the souls at 10:00 are unknown', () => {
    const context = matchContext([soulsSnapshot(300, 3_000), soulsSnapshot(540, 6_000)]);
    expect(rateOf(soulsAt10MinMetric)(context)).toBeNull();
  });

  it('is zero for a player who owned no souls at 10:00, not unknown', () => {
    expect(rateOf(soulsAt10MinMetric)(matchContext([soulsSnapshot(600, 0)]))).toBe(0);
  });

  it('is the souls at 10:00 over ten minutes, whatever the length of the match', () => {
    // The rate covers the first ten minutes only, so a long match is not worth more than a short
    // one: both give 7000 souls at 10:00.
    const long = matchContext([
      soulsSnapshot(540, 6_000),
      soulsSnapshot(720, 9_000),
      soulsSnapshot(3_000, 90_000),
    ]);
    expect(rateOf(soulsAt10MinMetric)(long)).toBe(700);
  });
});
