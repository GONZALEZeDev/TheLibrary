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
 * Part of {@link HISTORY_RATE_LIMIT} that automatic synchronisations (at startup and on their
 * timer) may use: the last 2 requests of the hour are kept for the "Sync" button. It counts every
 * history request of the window, manual ones included, so the timer must leave room for them.
 */
export const AUTOMATIC_HISTORY_RATE_LIMIT: RateLimit = { limit: 6, windowMs: HOUR_MS };

/** Static game data (the hero catalogue): 2 requests per second. */
export const ASSETS_RATE_LIMIT: RateLimit = { limit: 2, windowMs: 1_000 };

/**
 * Match detail requests: 5 per second. deadlock-api allows 100 per second and per IP when the
 * match is in its cache, but only 100 per 10 seconds (10 per second) when it is read from storage,
 * and the app cannot know which of the two a match needs. 5 per second stays at half of the slower
 * limit. The API also asks clients not to send many uncached requests in parallel, which
 * {@link METADATA_MAX_CONCURRENCY} enforces.
 */
export const METADATA_RATE_LIMIT: RateLimit = { limit: 5, windowMs: 1_000 };

/**
 * Match detail requests in flight at the same time: 2. A request that is still waiting for its
 * answer counts, whereas {@link METADATA_RATE_LIMIT} only counts the requests already sent: a slow
 * storage read must not let the downloads pile up in parallel, which the API asks clients not to do.
 */
export const METADATA_MAX_CONCURRENCY = 2;
