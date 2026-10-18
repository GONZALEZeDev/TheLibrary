/**
 * Tests of the politeness budgets towards deadlock-api.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_HISTORY_RATE_LIMIT,
  HISTORY_RATE_LIMIT,
  METADATA_MAX_CONCURRENCY,
  METADATA_RATE_LIMIT,
  PROFILE_RATE_LIMIT,
  PROFILE_REFRESH_RATE_LIMIT,
} from './budgets';

describe('history budgets', () => {
  it('counts the automatic synchronisations over the same window as every history request', () => {
    // Both budgets read and prune the same saved request times (each check keeps only the times
    // inside its own window), so with different windows one budget would erase times the other
    // still counts.
    expect(AUTOMATIC_HISTORY_RATE_LIMIT.windowMs).toBe(HISTORY_RATE_LIMIT.windowMs);
  });

  it('keeps at least 2 requests of the window for the "Sync" button', () => {
    expect(HISTORY_RATE_LIMIT.limit - AUTOMATIC_HISTORY_RATE_LIMIT.limit).toBeGreaterThanOrEqual(2);
  });
});

describe('profile budgets', () => {
  it('sends at most 10 profile requests a minute and 3 refreshes an hour', () => {
    expect(PROFILE_RATE_LIMIT).toEqual({ limit: 10, windowMs: 60_000 });
    expect(PROFILE_REFRESH_RATE_LIMIT).toEqual({ limit: 3, windowMs: 3_600_000 });
  });
});

describe('match detail budget', () => {
  it('sends at most 5 match detail requests per second, 2 at a time', () => {
    expect(METADATA_RATE_LIMIT).toEqual({ limit: 5, windowMs: 1_000 });
    expect(METADATA_MAX_CONCURRENCY).toBe(2);
  });
});
