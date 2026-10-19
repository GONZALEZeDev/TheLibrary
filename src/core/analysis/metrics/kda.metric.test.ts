/**
 * Tests of the KDA metric: how the kills, deaths and assists of the tracked player make one ratio,
 * and which of the two copies of those counts in the archive it reads.
 *
 * The contexts are built by hand, as plain objects, from synthetic numbers: the metric only reads
 * the tracked player, not a whole archive.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testMatchContext, testPlayer, testSnapshot } from '../../../test/analysis-context';
import type { MatchContext, Snapshot } from '../match-context';
import { kdaMetric } from './kda.metric';

/** The end-of-game counts of a hand-built tracked player. */
interface Counts {
  /** Their kills over the whole match. */
  readonly kills: number;
  /** Their deaths over the whole match. */
  readonly deaths: number;
  /** Their assists over the whole match. */
  readonly assists: number;
}

/**
 * Build the context of a hand-built match, in which the tracked player alone is described.
 *
 * @param counts - The end-of-game counts of the tracked player.
 * @param snapshots - The statistic snapshots of the tracked player, sorted by time.
 * @returns The match context (no teammate, no enemy: the KDA reads neither).
 */
function matchContext(counts: Counts, snapshots: readonly Snapshot[] = []): MatchContext {
  return testMatchContext({ tracked: testPlayer({ ...counts, snapshots }) });
}

describe('kdaMetric', () => {
  it('is a combat ratio, the higher the better, compared with the community KDA', () => {
    expect(kdaMetric).toMatchObject({
      key: 'kda',
      family: 'combat',
      unit: 'ratio',
      better: 'higher',
      group: 'kda',
      display: 'relative',
      personal: 'as_is',
      integer: false,
      community: { kind: 'percentiles', benchmark: 'kda' },
    });
  });

  it('computes the KDA from the end-of-game fields', () => {
    // (6 kills + 14 assists) / 4 deaths.
    expect(kdaMetric.compute(matchContext({ kills: 6, deaths: 4, assists: 14 }))).toBe(5);
  });

  it('keeps the fraction of a KDA that does not divide evenly', () => {
    // (4 + 3) / 3: a ratio, never rounded to a whole number.
    expect(kdaMetric.compute(matchContext({ kills: 4, deaths: 3, assists: 3 }))).toBeCloseTo(
      2.3333,
      4,
    );
  });

  it('divides by one death at least', () => {
    // A match without a death is not a division by zero: (3 + 9) / 1.
    expect(kdaMetric.compute(matchContext({ kills: 3, deaths: 0, assists: 9 }))).toBe(12);
  });

  it('is zero for a player who did nothing and never died', () => {
    expect(kdaMetric.compute(matchContext({ kills: 0, deaths: 0, assists: 0 }))).toBe(0);
  });

  it('ignores a last snapshot that disagrees with the end-of-game fields', () => {
    // The API's snapshots can count one kill, death or assist more or less than the end-of-game
    // fields (the game's scoreboard and the API both use the end-of-game ones). The context does not
    // model those counts on a snapshot at all, so the snapshot is given through a variable: the
    // metric must not pick them up, whatever a hand-built context holds.
    const disagreeingStats = { player_damage: 5_000, kills: 7, deaths: 5, assists: 13 };
    const context = matchContext({ kills: 6, deaths: 4, assists: 14 }, [
      testSnapshot(1_934, disagreeingStats),
    ]);
    // (6 + 14) / 4 from the end-of-game fields, not (7 + 13) / 5 = 4 from the snapshot.
    expect(kdaMetric.compute(context)).toBe(5);
  });

  it('is known for a match without any snapshot', () => {
    // The end-of-game fields are required in every archive, unlike the snapshots.
    expect(kdaMetric.compute(matchContext({ kills: 2, deaths: 1, assists: 0 }, []))).toBe(2);
  });
});
