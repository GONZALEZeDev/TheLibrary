/**
 * Requests to deadlock-api, with every rule of a polite client: User-Agent, timeout, size limit,
 * politeness budgets, and the pauses deadlock-api asks for.
 *
 * The service sends a request only when it fits its budget and no pause is running; it then
 * interprets the response (`core/deadlock-api/api-response.ts`) and validates the data
 * (`core/deadlock-api/*.schema.ts`), so callers only ever see validated domain objects or an
 * `AppError`.
 *
 * The pause deadlock-api asks for (HTTP 429 or 503) is shared by every kind of request and kept in
 * the database, so it survives a restart. Several requests can be in flight at once, so two
 * answers may ask for a pause at the same time: the saved pause always ends at the latest of the
 * ones asked for, and the writes are made one after the other (see `DeadlockApiService.#savePause`).
 *
 * Errors are not logged here: the caller decides (the synchronisation logs each failure once).
 * Only a debug line per request and the pauses are logged, never with an account id nor a body.
 *
 * @packageDocumentation
 */
import { interpretResponse, type ApiOutcome } from '../core/deadlock-api/api-response';
import {
  ASSETS_RATE_LIMIT,
  AUTOMATIC_HISTORY_RATE_LIMIT,
  HISTORY_RATE_LIMIT,
  METADATA_MAX_CONCURRENCY,
  METADATA_RATE_LIMIT,
} from '../core/deadlock-api/budgets';
import {
  heroesRequest,
  matchHistoryRequest,
  matchMetadataRequest,
  MAX_RESPONSE_BYTES,
  redactAccountIds,
  REQUEST_TIMEOUT_MS,
  userAgent,
  type ApiRequest,
} from '../core/deadlock-api/endpoints';
import { parseHeroes } from '../core/deadlock-api/heroes.schema';
import { parseMatchHistory } from '../core/deadlock-api/match-history.schema';
import type { AccountId } from '../core/domain/account';
import type { Hero } from '../core/domain/hero';
import type { MatchId, MatchSummary } from '../core/domain/match';
import { AppError, errorLogContext, toAppError } from '../core/errors/app-error';
import { checkRateLimit } from '../core/rate-limit/sliding-window';
import type { HttpClient, HttpResponse } from '../ports/http-client.port';
import type { Logger } from '../ports/logger.port';
import type { SyncStateRepository } from './sync-state.repository';

/** Options of {@link DeadlockApiService}. */
export interface DeadlockApiServiceOptions {
  /** Version of the app, sent in the User-Agent. */
  readonly appVersion: string;
  /** Current time (Unix ms); `Date.now` by default. */
  readonly now?: () => number;
  /**
   * Wait for a delay in milliseconds, when a match detail request has to wait for the next slot of
   * its budget. A timer by default; tests give a fake one that moves their clock forward.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Options of {@link DeadlockApiService.fetchMatchHistory}. */
export interface HistoryFetchOptions {
  /**
   * The request is not made by the user (startup, schedule): it may only use the automatic part of
   * the budget.
   */
  readonly automatic: boolean;
}

/** Result of {@link DeadlockApiService.fetchMatchHistory}. */
export type HistoryFetch =
  /** The history was downloaded; `fromSteam` tells whether deadlock-api refreshed it from Steam. */
  | {
      readonly kind: 'fetched';
      readonly matches: readonly MatchSummary[];
      readonly fromSteam: boolean;
    }
  /** Not requested: the politeness budget allows the next request at `nextAllowedAt` (Unix ms). */
  | { readonly kind: 'budget_exhausted'; readonly nextAllowedAt: number }
  /** Not requested, or refused: deadlock-api asked to pause until `until` (Unix ms). */
  | { readonly kind: 'paused'; readonly until: number };

/** Result of {@link DeadlockApiService.fetchMatchMetadata}. */
export type MetadataFetch =
  /**
   * The detail was downloaded. `json` is the parsed payload, not validated yet; `body` is the text
   * it was parsed from, kept so that a payload that fails validation can be quarantined as it came.
   */
  | { readonly kind: 'fetched'; readonly json: unknown; readonly body: string }
  /** A success that cannot be used: `issue` says why (`not_json`), `body` is the text received. */
  | { readonly kind: 'invalid'; readonly body: string; readonly issue: string }
  /** deadlock-api does not hold this match (HTTP 404). */
  | { readonly kind: 'not_found' }
  /** Not requested, or refused: deadlock-api asked to pause until `until` (Unix ms). */
  | { readonly kind: 'paused'; readonly until: number };

/** A response, and what it means. */
interface Exchange {
  readonly response: HttpResponse;
  /** The outcome of the response; the end of a pause is the one that was saved. */
  readonly outcome: ApiOutcome;
}

/**
 * Wait with a timer.
 *
 * @param ms - The delay, in milliseconds.
 * @returns A promise settled after the delay: the default of {@link DeadlockApiServiceOptions.sleep}.
 */
function sleepWithTimer(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * A counting semaphore: at most `capacity` holders at a time, the other callers wait their turn in
 * the order they arrived.
 */
class Semaphore {
  readonly #capacity: number;
  /** Number of slots held, including the ones handed over to a waiting caller. */
  #held = 0;
  readonly #waiting: (() => void)[] = [];

  /**
   * @param capacity - Number of slots.
   */
  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  /**
   * Take a slot. The caller must {@link Semaphore.release} it, whatever happens next.
   *
   * @returns A promise settled once the caller holds a slot.
   */
  acquire(): Promise<void> {
    // A free slot is taken before this method returns: two callers cannot take the last one.
    if (this.#held < this.#capacity) {
      this.#held += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#waiting.push(resolve);
    });
  }

  /** Give back a slot: the caller waiting the longest, if any, takes it over. */
  release(): void {
    const next = this.#waiting.shift();
    if (next === undefined) {
      this.#held -= 1;
    } else {
      // The slot goes straight to the waiting caller, so `#held` stays the same and a caller that
      // arrives right now cannot jump the queue.
      next();
    }
  }
}

/** Sends the requests of the app to deadlock-api. */
export class DeadlockApiService {
  readonly #http: HttpClient;
  readonly #syncState: SyncStateRepository;
  readonly #logger: Logger;
  readonly #userAgent: string;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Times of the recent asset requests: their budget is per second, memory is enough. */
  #assetRequests: readonly number[] = [];
  /** Times of the recent match detail requests: per second too, so kept in memory as well. */
  #metadataRequests: readonly number[] = [];
  /** The slots of the match detail requests in flight. */
  readonly #metadataSlots = new Semaphore(METADATA_MAX_CONCURRENCY);
  /** Settles when the last check of the history budget is done (see `#oneAtATime`). */
  #lastHistoryCheck: Promise<unknown> = Promise.resolve();
  /** Settles when the last write of a pause is done (see `#savePause`); never rejects. */
  #lastPauseWrite: Promise<void> = Promise.resolve();

  /**
   * @param http - Sends the requests.
   * @param syncState - Keeps the history budget and the pauses across restarts.
   * @param logger - Structured logger.
   * @param options - See {@link DeadlockApiServiceOptions}.
   */
  constructor(
    http: HttpClient,
    syncState: SyncStateRepository,
    logger: Logger,
    options: DeadlockApiServiceOptions,
  ) {
    this.#http = http;
    this.#syncState = syncState;
    this.#logger = logger;
    this.#userAgent = userAgent(options.appVersion);
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? sleepWithTimer;
  }

  /**
   * Download and validate the match history of a player, if the budget and deadlock-api allow it.
   *
   * @param accountId - The player.
   * @param options - See {@link HistoryFetchOptions}.
   * @returns The history, or why it was not downloaded.
   * @throws AppError of kind `timeout`, `network`, `forbidden`, `not_found`,
   *   `service_unavailable`, `invalid_payload`, `unexpected` or `storage`.
   */
  async fetchMatchHistory(
    accountId: AccountId,
    options: HistoryFetchOptions,
  ): Promise<HistoryFetch> {
    const refusal = await this.#oneAtATime(() => this.#admitHistoryRequest(options.automatic));
    if (refusal !== null) {
      return refusal;
    }
    const request = matchHistoryRequest(accountId);
    const outcome = await this.#send(request);
    if (outcome.kind === 'pause') {
      return { kind: 'paused', until: outcome.until };
    }
    const history = parseMatchHistory(outcome.json, accountId);
    if (history.invalidRows > 0) {
      this.#logger.log('warn', 'api', 'Ignored invalid rows of the match history', {
        endpoint: request.endpoint,
        invalidRows: history.invalidRows,
        firstIssue: history.firstIssue,
      });
    }
    return { kind: 'fetched', matches: history.matches, fromSteam: outcome.fromSteam };
  }

  /**
   * Download and validate the hero catalogue.
   *
   * @returns The playable heroes, with their English names.
   * @throws AppError of kind `rate_limited` when deadlock-api asked to pause or the budget is
   *   exhausted, or any kind of {@link DeadlockApiService.fetchMatchHistory}.
   */
  async fetchHeroes(): Promise<Hero[]> {
    const now = this.#now();
    const pausedUntil = await this.#activePause(now);
    if (pausedUntil !== null) {
      throw new AppError('rate_limited', 'deadlock-api asked to pause', {
        context: { pausedUntil },
      });
    }
    const budget = checkRateLimit(this.#assetRequests, now, ASSETS_RATE_LIMIT);
    // Kept even when refused, like the times of the history requests (see #admitHistoryRequest).
    this.#assetRequests = budget.allowed ? [...budget.recent, now] : budget.recent;
    if (!budget.allowed) {
      throw new AppError('rate_limited', 'The budget of asset requests is exhausted', {
        context: { nextAllowedAt: budget.nextAllowedAt },
      });
    }
    const outcome = await this.#send(heroesRequest());
    if (outcome.kind === 'pause') {
      throw outcome.error;
    }
    return parseHeroes(outcome.json);
  }

  /**
   * Download the detail of a match, if deadlock-api allows it.
   *
   * The call waits when the budget asks for it, instead of being refused: it queues for one of the
   * {@link METADATA_MAX_CONCURRENCY} requests allowed at the same time, then waits for a free
   * request slot of {@link METADATA_RATE_LIMIT}. A pause asked for by deadlock-api, on this request
   * or on any other, ends the wait with `paused`.
   *
   * The payload is returned as it came, not validated: the caller archives it and parses it.
   *
   * @param matchId - The match.
   * @returns The payload with its text, or why there is none.
   * @throws AppError of kind `timeout`, `network`, `forbidden`, `service_unavailable`,
   *   `invalid_payload` (a body over 10 MB), `unexpected` or `storage`.
   */
  async fetchMatchMetadata(matchId: MatchId): Promise<MetadataFetch> {
    // A call that would only learn about the pause after waiting for a slot answers at once.
    const runningPause = await this.#activePause(this.#now());
    if (runningPause !== null) {
      return { kind: 'paused', until: runningPause };
    }
    const request = matchMetadataRequest(matchId);
    // The place in flight comes first: the time counted in the rate window is then the time of the
    // sending, not the time the call joined the queue, so the window is never ahead of reality.
    await this.#metadataSlots.acquire();
    // From the moment the slot is taken, whatever happens next gives it back: a slot kept by a call
    // that failed would stop every later call for good.
    try {
      const pausedUntil = await this.#claimMetadataRequest(request);
      if (pausedUntil !== null) {
        return { kind: 'paused', until: pausedUntil };
      }
      const { response, outcome } = await this.#exchange(request);
      return toMetadataFetch(response, outcome);
    } finally {
      this.#metadataSlots.release();
    }
  }

  /**
   * Wait for the right to send one match detail request, and count it.
   *
   * The budget is a sliding window (see `checkRateLimit`): at most {@link METADATA_RATE_LIMIT}
   * requests in any period of its length. When it is full, the call sleeps until the oldest
   * request of the window leaves it, then starts again from the pause check: the window may have
   * been filled again by another call, and a pause may have been saved while this one slept.
   *
   * @param request - The request to send, for the log.
   * @returns The end of the pause that stops the request, or `null` when the request was counted
   *   and may be sent now.
   */
  async #claimMetadataRequest(request: ApiRequest): Promise<number | null> {
    // Every round starts by the pause check, the first one and the ones after a sleep alike.
    for (;;) {
      const pausedUntil = await this.#activePause(this.#now());
      if (pausedUntil !== null) {
        return pausedUntil;
      }
      // Nothing is awaited between reading the window and writing the count back, so two calls
      // cannot both take its last request. The caller sends the request as soon as it returns,
      // without waiting for anything slow in between: the pause just checked is the one the
      // request is sent under.
      const now = this.#now();
      const budget = checkRateLimit(this.#metadataRequests, now, METADATA_RATE_LIMIT);
      // Kept even when refused, to leave out the times that left the window.
      this.#metadataRequests = budget.allowed ? [...budget.recent, now] : budget.recent;
      if (budget.allowed) {
        return null;
      }
      const waitMs = budget.nextAllowedAt - now;
      this.#logger.log('debug', 'api', 'Waiting for the next request slot', {
        endpoint: request.endpoint,
        waitMs,
      });
      await this.#sleep(waitMs);
    }
  }

  /**
   * Check the pause and the budget of the history requests, and count the request when it may be
   * sent. Counted before sending: a request that fails still reached deadlock-api.
   *
   * @param automatic - Whether an automatic synchronisation asks (see {@link HistoryFetchOptions}).
   * @returns Why the request may not be sent, or `null` when it was counted.
   */
  async #admitHistoryRequest(
    automatic: boolean,
  ): Promise<Exclude<HistoryFetch, { kind: 'fetched' }> | null> {
    const now = this.#now();
    const pausedUntil = await this.#activePause(now);
    if (pausedUntil !== null) {
      return { kind: 'paused', until: pausedUntil };
    }
    const budget = checkRateLimit(
      await this.#syncState.getHistoryRequests(),
      now,
      automatic ? AUTOMATIC_HISTORY_RATE_LIMIT : HISTORY_RATE_LIMIT,
    );
    // Saved even when refused: a time dated after `now` (the system clock moved backwards) is
    // saved as `now`, so it leaves the window within the hour instead of when the clock catches up.
    await this.#syncState.setHistoryRequests(
      budget.allowed ? [...budget.recent, now] : budget.recent,
    );
    return budget.allowed
      ? null
      : { kind: 'budget_exhausted', nextAllowedAt: budget.nextAllowedAt };
  }

  /**
   * Run the checks of the history budget one at a time: two overlapping calls would otherwise read
   * the same request times, both pass, and send one request more than the budget allows.
   *
   * @param check - The check, run once the previous one is done.
   * @returns The result of `check`.
   */
  #oneAtATime<T>(check: () => Promise<T>): Promise<T> {
    const result = this.#lastHistoryCheck.then(check);
    this.#lastHistoryCheck = result.catch(() => undefined);
    return result;
  }

  /**
   * The end of the pause deadlock-api asked for, if it is still running.
   *
   * @param now - Current time (Unix ms).
   * @returns The end of the pause (Unix ms), or `null` when no pause is running.
   */
  async #activePause(now: number): Promise<number | null> {
    // A pause that is being saved counts: a call that starts right after an answer asked for a
    // pause must see it, not the database as it was before the write.
    await this.#lastPauseWrite;
    const pausedUntil = await this.#syncState.getPausedUntil();
    return pausedUntil !== null && pausedUntil > now ? pausedUntil : null;
  }

  /**
   * Save the pause an answer asked for, keeping the latest end.
   *
   * Requests overlap, so two answers can ask for a pause at the same time. The saved end is then
   * the later of the end already saved and the new one, and the reads and writes of the database
   * are made one after the other: two answers that read the saved end together would otherwise
   * each write their own, and the last write would win even if it ends sooner.
   *
   * @param until - The end of the pause the answer asked for (Unix ms).
   * @returns The end of the pause now saved (Unix ms): `until`, or a later end saved before.
   * @throws AppError of kind `storage` when the database fails.
   */
  #savePause(until: number): Promise<number> {
    const saved = this.#lastPauseWrite.then(async () => {
      const current = await this.#syncState.getPausedUntil();
      // A saved pause that is over ends before any new one, so it never wins.
      const latest = current === null ? until : Math.max(current, until);
      if (latest !== current) {
        await this.#syncState.setPausedUntil(latest);
      }
      return latest;
    });
    // The next write waits for this one to end, however it ends: a failed write must not stop the
    // later ones (and `then(…, …)` leaves no rejection unhandled on this side of the chain).
    this.#lastPauseWrite = saved.then(
      () => undefined,
      () => undefined,
    );
    return saved;
  }

  /**
   * Send a request and interpret its response. A pause asked for by deadlock-api is saved before
   * it is returned.
   *
   * @param request - The request.
   * @returns Usable data, or a pause.
   * @throws AppError for a failed request, without any account id in its message or cause.
   */
  async #send(request: ApiRequest): Promise<Exclude<ApiOutcome, { kind: 'failure' }>> {
    const { outcome } = await this.#exchange(request);
    if (outcome.kind === 'failure') {
      throw outcome.error;
    }
    return outcome;
  }

  /**
   * Send a request and interpret its response, whatever it means: a failure of the API is an
   * outcome here, so that the caller can tell some of them from the others (a match that does not
   * exist is not an error of the app). A pause asked for by deadlock-api is saved before it is
   * returned, and the outcome carries the end that was saved.
   *
   * @param request - The request.
   * @returns The response, with what it means. Its body is never logged.
   * @throws AppError when the transport fails, without any account id in its message or cause.
   */
  async #exchange(request: ApiRequest): Promise<Exchange> {
    const startedAt = this.#now();
    let response;
    try {
      response = await this.#http.get({
        url: request.url,
        headers: { 'User-Agent': this.#userAgent, Accept: 'application/json' },
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBodyBytes: MAX_RESPONSE_BYTES,
      });
    } catch (error) {
      throw withoutAccountIds(toAppError(error), request);
    }
    this.#logger.log('debug', 'api', 'Request answered', {
      endpoint: request.endpoint,
      status: response.status,
      durationMs: this.#now() - startedAt,
    });
    const outcome = interpretResponse(request, response, this.#now());
    if (outcome.kind !== 'pause') {
      return { response, outcome };
    }
    // Another answer may have asked for a longer pause: the one saved is the one that is running.
    const until = await this.#savePause(outcome.until);
    this.#logger.log('warn', 'api', 'deadlock-api asked to pause the requests', {
      ...outcome.error.context,
      pausedUntil: new Date(until).toISOString(),
    });
    return { response, outcome: { ...outcome, until } };
  }
}

/**
 * What a match detail response means for {@link DeadlockApiService.fetchMatchMetadata}.
 *
 * `interpretResponse` reports a 404 as `not_found` and a success whose body is not JSON as
 * `invalid_payload` (no other response gets these kinds): the detail queue handles both without an
 * error, the first as an absent match, the second as a payload to quarantine.
 *
 * @param response - The response.
 * @param outcome - What `interpretResponse` made of it.
 * @returns The result of the download.
 * @throws AppError for any other failure of the API.
 */
function toMetadataFetch(response: HttpResponse, outcome: ApiOutcome): MetadataFetch {
  switch (outcome.kind) {
    case 'success':
      return { kind: 'fetched', json: outcome.json, body: response.body };
    case 'pause':
      return { kind: 'paused', until: outcome.until };
    case 'failure':
      if (outcome.error.kind === 'not_found') {
        return { kind: 'not_found' };
      }
      if (outcome.error.kind === 'invalid_payload') {
        return { kind: 'invalid', body: response.body, issue: 'not_json' };
      }
      throw outcome.error;
  }
}

/**
 * Copy an error of the transport, removing the account ids its message or cause may quote (the
 * network layer reports the URL it failed on), and naming the endpoint by its template.
 *
 * @param error - The error of the HTTP client.
 * @param request - The request that failed.
 * @returns An error safe to log.
 */
function withoutAccountIds(error: AppError, request: ApiRequest): AppError {
  // `errorLogContext` describes the cause as text, whatever it is (an Error, a plugin's string…).
  const { cause } = errorLogContext(error);
  const causeText = typeof cause === 'string' ? redactAccountIds(cause) : undefined;
  return new AppError(error.kind, redactAccountIds(error.message), {
    context: { ...error.context, endpoint: request.endpoint },
    ...(causeText === undefined ? {} : { cause: causeText }),
  });
}
