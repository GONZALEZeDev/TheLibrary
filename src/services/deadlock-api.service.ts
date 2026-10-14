/**
 * Requests to deadlock-api, with every rule of a polite client: User-Agent, timeout, size limit,
 * politeness budgets, and the pauses deadlock-api asks for.
 *
 * The service sends a request only when it fits its budget and no pause is running; it then
 * interprets the response (`core/deadlock-api/api-response.ts`) and validates the data
 * (`core/deadlock-api/*.schema.ts`), so callers only ever see validated domain objects or an
 * `AppError`.
 *
 * Errors are not logged here: the caller decides (the synchronisation logs each failure once).
 * Only a debug line per request and the pauses are logged, never with an account id.
 *
 * @packageDocumentation
 */
import { interpretResponse, type ApiOutcome } from '../core/deadlock-api/api-response';
import {
  ASSETS_RATE_LIMIT,
  AUTOMATIC_HISTORY_RATE_LIMIT,
  HISTORY_RATE_LIMIT,
} from '../core/deadlock-api/budgets';
import {
  heroesRequest,
  matchHistoryRequest,
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
import type { MatchSummary } from '../core/domain/match';
import { AppError, errorLogContext, toAppError } from '../core/errors/app-error';
import { checkRateLimit } from '../core/rate-limit/sliding-window';
import type { HttpClient } from '../ports/http-client.port';
import type { Logger } from '../ports/logger.port';
import type { SyncStateRepository } from './sync-state.repository';

/** Options of {@link DeadlockApiService}. */
export interface DeadlockApiServiceOptions {
  /** Version of the app, sent in the User-Agent. */
  readonly appVersion: string;
  /** Current time (Unix ms); `Date.now` by default. */
  readonly now?: () => number;
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

/** Sends the requests of the app to deadlock-api. */
export class DeadlockApiService {
  readonly #http: HttpClient;
  readonly #syncState: SyncStateRepository;
  readonly #logger: Logger;
  readonly #userAgent: string;
  readonly #now: () => number;
  /** Times of the recent asset requests: their budget is per second, memory is enough. */
  #assetRequests: readonly number[] = [];
  /** Settles when the last check of the history budget is done (see `#oneAtATime`). */
  #lastHistoryCheck: Promise<unknown> = Promise.resolve();

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
    const pausedUntil = await this.#syncState.getPausedUntil();
    return pausedUntil !== null && pausedUntil > now ? pausedUntil : null;
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
    if (outcome.kind === 'failure') {
      throw outcome.error;
    }
    if (outcome.kind === 'pause') {
      await this.#syncState.setPausedUntil(outcome.until);
      this.#logger.log('warn', 'api', 'deadlock-api asked to pause the requests', {
        ...outcome.error.context,
        pausedUntil: new Date(outcome.until).toISOString(),
      });
    }
    return outcome;
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
