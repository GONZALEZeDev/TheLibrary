/**
 * Tests of the sliding-window rate limits.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { checkRateLimit, type RateLimit } from './sliding-window';

const HOUR = 3_600_000;
const NOW = 10 * HOUR;
const EIGHT_PER_HOUR: RateLimit = { limit: 8, windowMs: HOUR };

/**
 * Timestamps of `count` events spaced by `stepMs`, the last one at `last`.
 *
 * @param count - Number of events.
 * @param last - Time of the last event.
 * @param stepMs - Time between two events.
 * @returns The timestamps, oldest first.
 */
function events(count: number, last: number, stepMs: number): number[] {
  return Array.from({ length: count }, (_, index) => last - (count - 1 - index) * stepMs);
}

describe('checkRateLimit', () => {
  it('allows an event while the window holds fewer events than the limit', () => {
    expect(checkRateLimit([], NOW, EIGHT_PER_HOUR)).toEqual({
      allowed: true,
      nextAllowedAt: NOW,
      recent: [],
    });
    expect(checkRateLimit(events(7, NOW - 1, 60_000), NOW, EIGHT_PER_HOUR).allowed).toBe(true);
  });

  it('refuses an event once the limit is reached, until the oldest event leaves the window', () => {
    const timestamps = events(8, NOW - 1_000, 5 * 60_000);
    const check = checkRateLimit(timestamps, NOW, EIGHT_PER_HOUR);

    expect(check.allowed).toBe(false);
    expect(check.nextAllowedAt).toBe((timestamps[0] ?? 0) + HOUR);
    expect(checkRateLimit(timestamps, check.nextAllowedAt, EIGHT_PER_HOUR).allowed).toBe(true);
  });

  it('forgets the events that left the window and returns the others, oldest first', () => {
    const check = checkRateLimit([NOW - 2 * HOUR, NOW - 10, NOW - HOUR, NOW - 20], NOW, {
      limit: 3,
      windowMs: HOUR,
    });

    expect(check.recent).toEqual([NOW - 20, NOW - 10]);
    expect(check.allowed).toBe(true);
  });

  it('applies a lower limit to the same events', () => {
    const timestamps = events(6, NOW - 1, 60_000);

    expect(checkRateLimit(timestamps, NOW, { limit: 6, windowMs: HOUR }).allowed).toBe(false);
    expect(checkRateLimit(timestamps, NOW, EIGHT_PER_HOUR).allowed).toBe(true);
  });

  it('counts an event dated in the future as happening now, so a clock moved back blocks no longer than the window', () => {
    const future = NOW + 30 * 24 * HOUR;
    const check = checkRateLimit([future], NOW, { limit: 1, windowMs: HOUR });

    expect(check.recent).toEqual([NOW]);
    expect(check.nextAllowedAt).toBe(NOW + HOUR);
  });
});
