/**
 * Tests of the numbers shown for a dashboard period.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { periodStats } from './period-stats';

describe('periodStats', () => {
  it('has no numbers without a match', () => {
    expect(periodStats({ matches: 0, wins: 0, kills: 0, deaths: 0, assists: 0 })).toBeNull();
  });

  it('averages the K/D/A and computes the win rate', () => {
    // 28 / 4 = 7, 12 / 4 = 3, 72 / 4 = 18 and 3 / 4 = 0.75 are all exact in floating point.
    expect(periodStats({ matches: 4, wins: 3, kills: 28, deaths: 12, assists: 72 })).toEqual({
      matches: 4,
      wins: 3,
      winRate: 0.75,
      averageKills: 7,
      averageDeaths: 3,
      averageAssists: 18,
    });
  });
});
