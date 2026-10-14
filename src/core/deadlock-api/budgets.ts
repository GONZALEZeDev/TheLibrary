/**
 * Politeness budgets of the app towards deadlock-api.
 *
 * deadlock-api is a free community service: the app stays far below its published limits, so that
 * thousands of installations together remain welcome. A request that does not fit its budget is
 * not sent.
 *
 * @packageDocumentation
 */
import type { RateLimit } from '../rate-limit/sliding-window';

const HOUR_MS = 60 * 60_000;

/**
 * Match history requests: 8 per hour in total. deadlock-api allows 10 per hour and per IP for the
 * Steam refresh of a bot friend's history; staying at 8 leaves room for the other apps of the
 * same network.
 */
export const HISTORY_RATE_LIMIT: RateLimit = { limit: 8, windowMs: HOUR_MS };

/**
 * Part of {@link HISTORY_RATE_LIMIT} that automatic synchronisations (at startup and every
 * 10 minutes) may use: the last 2 requests of the hour are kept for the "Sync" button.
 */
export const AUTOMATIC_HISTORY_RATE_LIMIT: RateLimit = { limit: 6, windowMs: HOUR_MS };

/** Static game data (the hero catalogue): 2 requests per second. */
export const ASSETS_RATE_LIMIT: RateLimit = { limit: 2, windowMs: 1_000 };
