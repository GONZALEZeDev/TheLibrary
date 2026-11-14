import { describe, expect, it } from 'vitest';
import { TROOPER_WAVES, midBossReturns } from './game-schedule';

describe('TROOPER_WAVES', () => {
  it('trooper waves change at 20:00 and 35:00', () => {
    expect(TROOPER_WAVES).toEqual([
      { fromS: 0, everyS: 30 },
      { fromS: 1200, everyS: 25 },
      { fromS: 2100, everyS: 20 },
    ]);
  });
});

describe('midBossReturns', () => {
  it('returns 420 s, 360 s, then 300 s after each kill', () => {
    expect(midBossReturns([1240, 1700, 2100, 2500])).toEqual([1660, 2060, 2400, 2800]);
  });

  it('gives nothing without a kill', () => {
    expect(midBossReturns([])).toEqual([]);
  });
});
