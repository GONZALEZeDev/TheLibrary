/**
 * Tests of the dashboard periods.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PERIOD, PERIODS, isPeriod } from './period';

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
