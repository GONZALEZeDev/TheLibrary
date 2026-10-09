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
