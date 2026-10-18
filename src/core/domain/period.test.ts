/**
 * Tests of the dashboard periods.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PERIOD, PERIODS, PERIOD_DAYS, isPeriod, periodStartTime } from './period';

describe('PERIODS', () => {
  it('lists the three dashboard periods, shortest first', () => {
    expect(PERIODS).toEqual(['7d', '30d', '90d']);
  });

  it('contains the default period', () => {
    expect(PERIODS).toContain(DEFAULT_PERIOD);
  });
});

describe('isPeriod', () => {
  it('accepts every supported period', () => {
    for (const period of PERIODS) {
      expect(isPeriod(period)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(isPeriod('1y')).toBe(false);
    expect(isPeriod('')).toBe(false);
    expect(isPeriod(7)).toBe(false);
    expect(isPeriod(undefined)).toBe(false);
  });
});

describe('periodStartTime', () => {
  it('starts a period the right number of days ago, in seconds', () => {
    // 100 days after the epoch, plus 1.5 s: the sub-second part must be dropped (the result is in
    // Unix seconds, like the `start_time` of a match), never rounded up.
    const now = 100 * 86_400_000 + 1_500;

    expect(periodStartTime('7d', now)).toBe(93 * 86_400 + 1);
    expect(periodStartTime('30d', now)).toBe(70 * 86_400 + 1);
    expect(periodStartTime('90d', now)).toBe(10 * 86_400 + 1);
  });

  it('agrees with the length of every period', () => {
    expect(PERIOD_DAYS).toEqual({ '7d': 7, '30d': 30, '90d': 90 });
    for (const period of PERIODS) {
      expect(periodStartTime(period, 1_000_000_000_000)).toBe(
        1_000_000_000 - PERIOD_DAYS[period] * 86_400,
      );
    }
  });
});
