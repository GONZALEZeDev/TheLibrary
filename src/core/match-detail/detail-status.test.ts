/**
 * Tests of the rules of the detail queue: which matches are archived and when a failed detail is
 * tried again.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { matchSummary } from '../../test/test-data';
import {
  afterFailedAttempt,
  DETAIL_WINDOW_MS,
  isDetailEligible,
  isRetryDue,
  MAX_RETRY_DELAY_MS,
  RETRY_DELAYS_MS,
} from './detail-status';

/** The current time of the tests (Unix milliseconds, a whole number of seconds). */
const NOW = 1_792_154_119_000;

/** One second, in milliseconds. */
const SECOND_MS = 1_000;

/** What the random source returns when the jitter is neutral (the delay is exact). */
const NEUTRAL_RANDOM = () => 0.5;

describe('isDetailEligible', () => {
  it('archives normal-mode Paige matches of the last 90 days', () => {
    const startTime = (NOW - 10 * 24 * 60 * 60_000) / SECOND_MS;
    // Both match modes of the normal game are archived: unranked (1) and ranked (4).
    expect(isDetailEligible(matchSummary({ startTime, matchMode: 1 }), NOW)).toBe(true);
    expect(isDetailEligible(matchSummary({ startTime, matchMode: 4 }), NOW)).toBe(true);
  });

  it('does not archive Street Brawl, private lobbies or other heroes', () => {
    const startTime = (NOW - 10 * 24 * 60 * 60_000) / SECOND_MS;
    // Street Brawl is game mode 4.
    expect(isDetailEligible(matchSummary({ startTime, gameMode: 4 }), NOW)).toBe(false);
    // A private lobby is match mode 2.
    expect(isDetailEligible(matchSummary({ startTime, matchMode: 2 }), NOW)).toBe(false);
    // Any hero but Paige.
    expect(isDetailEligible(matchSummary({ startTime, heroId: 1 }), NOW)).toBe(false);
  });

  it('stops at 90 days', () => {
    const exactlyNinetyDays = (NOW - DETAIL_WINDOW_MS) / SECOND_MS;
    // The start time is in seconds: 90 days to the second is in, one second older is out.
    expect(isDetailEligible(matchSummary({ startTime: exactlyNinetyDays }), NOW)).toBe(true);
    expect(isDetailEligible(matchSummary({ startTime: exactlyNinetyDays - 1 }), NOW)).toBe(false);
  });
});

describe('afterFailedAttempt', () => {
  it('waits 5 min, 30 min, 2 h, 12 h then 24 h after each failure', () => {
    const waits = [0, 1, 2, 3, 4].map((attempts) => {
      const state = afterFailedAttempt(attempts, 'retryable', 'timeout', NOW, NEUTRAL_RANDOM);
      expect(state).toMatchObject({ status: 'retry', attempts: attempts + 1 });
      return (state.nextAttemptAt ?? Number.NaN) - NOW;
    });
    expect(waits).toEqual([5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000, 86_400_000]);
  });

  it('makes the match unavailable at the 6th failure', () => {
    expect(afterFailedAttempt(5, 'retryable', 'not_found', NOW, NEUTRAL_RANDOM)).toEqual({
      status: 'unavailable',
      attempts: 6,
      nextAttemptAt: null,
      lastError: 'not_found',
    });
  });

  it('keeps the jitter within 10 %', () => {
    RETRY_DELAYS_MS.forEach((delay, index) => {
      const earliest = afterFailedAttempt(index, 'retryable', 'timeout', NOW, () => 0);
      const latest = afterFailedAttempt(index, 'retryable', 'timeout', NOW, () => 0.999_999_999);
      expect(earliest.nextAttemptAt).toBe(NOW + Math.round(delay * 0.9));
      // The latest date stays under 110 % of the delay, whichever delay it is.
      expect(latest.nextAttemptAt).toBeGreaterThan(NOW + delay);
      expect(latest.nextAttemptAt).toBeLessThanOrEqual(NOW + Math.round(delay * 1.1));
      // And under the bound `isRetryDue` trusts to spot a clock that moved backwards.
      expect((latest.nextAttemptAt ?? Number.NaN) - NOW).toBeLessThanOrEqual(MAX_RETRY_DELAY_MS);
    });
  });

  it('makes an invalid response final', () => {
    // An invalid response is final from the first attempt: no retry, whatever the attempt count.
    expect(afterFailedAttempt(0, 'invalid', 'schema', NOW, NEUTRAL_RANDOM)).toEqual({
      status: 'invalid',
      attempts: 1,
      nextAttemptAt: null,
      lastError: 'schema',
    });
  });
});

describe('isRetryDue', () => {
  it('is due when the time has come', () => {
    // A detail that never failed has no date: it is due at once.
    expect(isRetryDue(null, NOW)).toBe(true);
    expect(isRetryDue(NOW, NOW)).toBe(true);
    expect(isRetryDue(NOW - 1, NOW)).toBe(true);
    expect(isRetryDue(NOW + 1, NOW)).toBe(false);
  });

  it('treats a retry dated too far in the future as due', () => {
    // The longest wait the schedule can produce is still waited...
    expect(isRetryDue(NOW + MAX_RETRY_DELAY_MS, NOW)).toBe(false);
    // ...a date beyond it can only come from a clock that was ahead then: retry now.
    expect(isRetryDue(NOW + MAX_RETRY_DELAY_MS + 1, NOW)).toBe(true);
  });
});
