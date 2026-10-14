/**
 * Sliding-window rate limits: "at most N events in any period of T milliseconds".
 *
 * Used for the politeness budgets of deadlock-api requests and to throttle the logging of
 * unhandled errors. The functions are pure: the caller keeps the timestamps (in memory or in the
 * database) and passes the current time.
 *
 * @packageDocumentation
 */

/** At most `limit` events in any window of `windowMs` milliseconds. */
export interface RateLimit {
  readonly limit: number;
  readonly windowMs: number;
}

/** Result of {@link checkRateLimit}. */
export interface RateLimitCheck {
  /** Whether one more event may happen now. */
  readonly allowed: boolean;
  /** When the next event may happen (Unix ms): `now` when allowed. */
  readonly nextAllowedAt: number;
  /** The events still inside the window, oldest first: what the caller should keep. */
  readonly recent: readonly number[];
}

/**
 * Check whether one more event fits in a rate limit.
 *
 * A timestamp later than `now` (the system clock was moved back) counts as happening now, so it
 * leaves the window after `windowMs` at most instead of blocking events until the clock catches up.
 *
 * @param timestamps - Times of the past events, Unix ms, in any order.
 * @param now - Current time, Unix ms.
 * @param rule - The limit.
 * @returns Whether an event is allowed, when the next one is, and the events still in the window.
 */
export function checkRateLimit(
  timestamps: readonly number[],
  now: number,
  rule: RateLimit,
): RateLimitCheck {
  const recent = timestamps
    .map((timestamp) => Math.min(timestamp, now))
    .filter((timestamp) => timestamp > now - rule.windowMs)
    .toSorted((first, second) => first - second);
  if (recent.length < rule.limit) {
    return { allowed: true, nextAllowedAt: now, recent };
  }
  // The window frees a slot when its oldest event that would still count leaves it: with `limit`
  // allowed events, that is the event `limit` places before the newest one.
  const blocking = recent[recent.length - rule.limit] ?? now;
  return { allowed: false, nextAllowedAt: blocking + rule.windowMs, recent };
}
