/**
 * The rules of the detail queue: which matches get their detail archived, and when a detail that
 * failed is tried again.
 *
 * Everything here is pure: the current time and the random source are arguments, so the rules are
 * tested without a clock and the queue decides when to read them.
 *
 * @packageDocumentation
 */
import type { MatchSummary } from '../domain/match';
import { PAIGE_HERO_ID } from '../domain/hero';

/**
 * Where a match stands in the detail queue.
 *
 * - `pending`: the detail was never fetched, and no attempt failed yet.
 * - `retry`: an attempt failed for a reason that may go away; the next one waits for its date.
 * - `ready`: the detail is archived.
 * - `unavailable`: every attempt failed; the queue gives up on this match.
 * - `invalid`: the API answered, but with a detail the app cannot use; trying again would get the
 *   same answer, so the queue gives up at once.
 * - `evicted`: the detail was archived, but its file was removed to keep the archive folder under
 *   its size limit; the match keeps its archive size, its format and its stored metrics. The queue
 *   never takes it on its own.
 */
export const DETAIL_STATUSES = [
  'pending',
  'retry',
  'ready',
  'unavailable',
  'invalid',
  'evicted',
] as const;

/** One of the {@link DETAIL_STATUSES}. */
export type DetailStatus = (typeof DETAIL_STATUSES)[number];

/** How far back the details are archived: 90 days, in milliseconds. */
export const DETAIL_WINDOW_MS = 90 * 24 * 60 * 60_000;

/** The only game mode that is archived: 1, the normal game (4 is Street Brawl). */
export const ARCHIVED_GAME_MODE = 1;

/** The match mode code of an unranked match of the game data. */
export const UNRANKED_MATCH_MODE = 1;

/**
 * The match mode code of a ranked match of the game data: the only mode whose players' rank data is
 * the badge they played the match at.
 */
export const RANKED_MATCH_MODE = 4;

/**
 * The match modes that are archived: {@link UNRANKED_MATCH_MODE} and {@link RANKED_MATCH_MODE}; 2
 * is a private lobby.
 */
export const ARCHIVED_MATCH_MODES = [UNRANKED_MATCH_MODE, RANKED_MATCH_MODE] as const;

/**
 * Whether the detail of a match is worth archiving.
 *
 * Only the normal-mode Paige matches of the last 90 days are: the app is about Paige, a Street
 * Brawl or a private lobby says nothing about how she plays the real game, and a match older than
 * the window would only fill the archive of a history nobody looks at.
 *
 * @param match - The fields of the match summary the rule reads.
 * @param now - The current time, in Unix milliseconds.
 * @returns `true` when the detail of the match should be archived.
 */
export function isDetailEligible(
  match: Pick<MatchSummary, 'heroId' | 'gameMode' | 'matchMode' | 'startTime'>,
  now: number,
): boolean {
  // Widened on purpose: `includes` on the literal tuple would only accept 1 and 4.
  const archivedMatchModes: readonly number[] = ARCHIVED_MATCH_MODES;
  return (
    match.heroId === PAIGE_HERO_ID &&
    match.gameMode === ARCHIVED_GAME_MODE &&
    archivedMatchModes.includes(match.matchMode) &&
    // The start time is in seconds while the window and `now` are in milliseconds.
    match.startTime * 1000 >= now - DETAIL_WINDOW_MS
  );
}

/**
 * How long to wait after the 1st, 2nd… 5th counted failure: 5 min, 30 min, 2 h, 12 h, 24 h, in
 * milliseconds. A 6th failure ends the retries.
 */
export const RETRY_DELAYS_MS = [
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

/**
 * The share by which a retry delay is randomly shortened or lengthened (±10 %), so that details
 * that failed together do not all come back at the same second.
 */
export const RETRY_JITTER = 0.1;

/**
 * The longest wait a retry can be given: the longest delay plus its jitter (26.4 h), in
 * milliseconds. The product is rounded because `1.1` has no exact binary form.
 */
export const MAX_RETRY_DELAY_MS = Math.round(24 * 60 * 60_000 * (1 + RETRY_JITTER));

/** What the queue keeps about the progress of one detail. */
export interface DetailState {
  readonly status: DetailStatus;
  /** How many attempts were counted as failures so far. */
  readonly attempts: number;
  /** When the next attempt is due, in Unix milliseconds; `null` when none is planned. */
  readonly nextAttemptAt: number | null;
  /** Why the last counted attempt failed (an error code, never a value of a payload). */
  readonly lastError: string | null;
}

/**
 * The state of a detail after an attempt that counts as a failure.
 *
 * A retryable failure is the API's answer that the detail is not there (yet) or not usable now: it
 * waits {@link RETRY_DELAYS_MS} (with jitter), then becomes `unavailable` at the 6th failure. An
 * invalid response is final at once. Failures that say nothing about the match (no network, a
 * pause, a full disk) are not counted and never reach this function.
 *
 * @param attempts - How many failures were counted before this one.
 * @param failure - Whether trying again may help (`retryable`) or not (`invalid`).
 * @param lastError - Why the attempt failed (an error code).
 * @param now - The current time, in Unix milliseconds.
 * @param random - A random source returning a number in [0, 1); `0.5` gives the exact delay.
 * @returns The new state of the detail.
 */
export function afterFailedAttempt(
  attempts: number,
  failure: 'retryable' | 'invalid',
  lastError: string,
  now: number,
  random: () => number,
): DetailState {
  const failedAttempts = attempts + 1;
  if (failure === 'invalid') {
    return { status: 'invalid', attempts: failedAttempts, nextAttemptAt: null, lastError };
  }
  // The delay of the n-th failure is the n-th of the schedule; past the end, there is none.
  const delay = RETRY_DELAYS_MS[failedAttempts - 1];
  if (delay === undefined) {
    return { status: 'unavailable', attempts: failedAttempts, nextAttemptAt: null, lastError };
  }
  // `random()` in [0, 1) is stretched to [-1, 1) then scaled by the jitter: the delay varies by ±10 %.
  const jitter = (random() * 2 - 1) * RETRY_JITTER;
  return {
    status: 'retry',
    attempts: failedAttempts,
    nextAttemptAt: now + Math.round(delay * (1 + jitter)),
    lastError,
  };
}

/**
 * Whether a detail waiting for its next attempt may be tried now.
 *
 * A date further away than the longest wait the schedule can produce was not written by this
 * schedule: the clock was ahead when it was, and has been set back since. Waiting for it could last
 * days, so such a detail counts as due.
 *
 * @param nextAttemptAt - When the attempt is due, in Unix milliseconds; `null` when it has no date.
 * @param now - The current time, in Unix milliseconds.
 * @returns `true` when the attempt can be made now.
 */
export function isRetryDue(nextAttemptAt: number | null, now: number): boolean {
  if (nextAttemptAt === null) {
    return true;
  }
  return nextAttemptAt <= now || nextAttemptAt > now + MAX_RETRY_DELAY_MS;
}
