/**
 * Analysis periods of the dashboard (7 days, 30 days, 90 days).
 *
 * Periods travel in the dashboard URL (`/dashboard?period=30d`), so they are short, stable string
 * codes rather than numbers.
 *
 * @packageDocumentation
 */

/** Periods selectable on the dashboard, shortest first. */
export const PERIODS = ['7d', '30d', '90d'] as const;

/** An analysis period of the dashboard. */
export type Period = (typeof PERIODS)[number];

/** Length of every period, in days. */
export const PERIOD_DAYS: Readonly<Record<Period, number>> = { '7d': 7, '30d': 30, '90d': 90 };

/** Milliseconds in a day: the periods are rolling windows of 24 hours, not calendar days. */
const DAY_MS = 86_400_000;

/** Period used when the URL does not specify a valid one. */
export const DEFAULT_PERIOD: Period = '30d';

/**
 * Tell whether a value is a supported {@link Period}.
 *
 * @param value - Any value, typically a URL search parameter.
 * @returns `true` when `value` is a supported period code.
 */
export function isPeriod(value: unknown): value is Period {
  return typeof value === 'string' && (PERIODS as readonly string[]).includes(value);
}

/**
 * Tell when a period starts, counting back from now: the dashboard keeps the matches that started
 * at or after this time.
 *
 * The result is in Unix seconds, like the `start_time` of a match, so that it compares with it
 * directly. The sub-second part of `now` is dropped.
 *
 * @param period - The period.
 * @param now - Current time, Unix milliseconds (a parameter, so that the core stays pure).
 * @returns Start of the period, Unix seconds.
 */
export function periodStartTime(period: Period, now: number): number {
  return Math.floor((now - PERIOD_DAYS[period] * DAY_MS) / 1000);
}
