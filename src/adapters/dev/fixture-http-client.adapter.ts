/**
 * {@link HttpClient} that never touches the network, for tests and the browser dev mode.
 *
 * Every request is answered by a handler function: {@link createFixtureApi} imitates deadlock-api
 * with the synthetic fixtures, and tests pass their own handler to simulate any status, header or
 * transport failure. The client records the requests it received so tests can inspect them.
 *
 * @packageDocumentation
 */
import { AppError } from '../../core/errors/app-error';
import {
  heroesRequest,
  matchHistoryRequest,
  DEADLOCK_API_BASE_URL,
} from '../../core/deadlock-api/endpoints';
import type { AccountId } from '../../core/domain/account';
import type { HttpClient, HttpRequest, HttpResponse } from '../../ports/http-client.port';
import { FIXTURE_HERO_CATALOGUE } from './fixtures/heroes.fixture';
import { createMatchHistoryFixture, FIXTURE_ACCOUNT_ID } from './fixtures/match-history.fixture';

/**
 * Answers a request: returns a response, or throws an `AppError` to simulate a failure of the
 * transport (`timeout`, `network`).
 */
export type FixtureHandler = (request: HttpRequest) => HttpResponse | Promise<HttpResponse>;

/** Options of {@link FixtureHttpClient}. */
export interface FixtureHttpClientOptions {
  /** Delay before each answer, in milliseconds, so the browser dev mode shows loading states. */
  readonly delayMs?: number;
}

/** {@link HttpClient} answering every request with a handler function. */
export class FixtureHttpClient implements HttpClient {
  /** Every request received, oldest first. */
  readonly requests: HttpRequest[] = [];

  readonly #handler: FixtureHandler;
  readonly #delayMs: number;

  /**
   * @param handler - Answers the requests.
   * @param options - See {@link FixtureHttpClientOptions}.
   */
  constructor(handler: FixtureHandler, options: FixtureHttpClientOptions = {}) {
    this.#handler = handler;
    this.#delayMs = options.delayMs ?? 0;
  }

  /**
   * Answer a request with the handler like a real client: the size cap of the request is
   * enforced and header names are lower-cased.
   *
   * @param request - The request.
   * @returns The handler's response, with lower-case header names.
   * @throws AppError thrown by the handler, or of kind `invalid_payload` when the body exceeds
   *   `maxBodyBytes`.
   */
  async get(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    if (this.#delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
    }
    const response = await this.#handler(request);
    if (new TextEncoder().encode(response.body).length > request.maxBodyBytes) {
      throw new AppError('invalid_payload', 'The response body exceeds the size limit', {
        context: { maxBodyBytes: request.maxBodyBytes },
      });
    }
    const headers = Object.entries(response.headers).map(([name, value]): [string, string] => [
      name.toLowerCase(),
      value,
    ]);
    return { ...response, headers: Object.fromEntries(headers) };
  }
}

/**
 * Build a JSON response.
 *
 * @param body - Value serialised as the body.
 * @param status - HTTP status; 200 by default.
 * @param headers - Extra headers.
 * @returns The response.
 */
export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

/** Options of {@link createFixtureApi}. */
export interface FixtureApiOptions {
  /** End of the synthetic history (Unix ms). */
  readonly now: number;
  /** The account whose history is served; {@link FIXTURE_ACCOUNT_ID} by default. */
  readonly accountId?: AccountId;
  /** Number of matches in the history; see `createMatchHistoryFixture`. */
  readonly matchCount?: number;
}

/**
 * Imitate deadlock-api with the synthetic fixtures: the match history of one account (refreshed
 * "from Steam"), an empty history for any other account, the hero catalogue, and 404 for anything
 * else.
 *
 * @param options - See {@link FixtureApiOptions}.
 * @returns The handler.
 */
export function createFixtureApi(options: FixtureApiOptions): FixtureHandler {
  const accountId = options.accountId ?? FIXTURE_ACCOUNT_ID;
  const history = createMatchHistoryFixture({
    now: options.now,
    accountId,
    ...(options.matchCount === undefined ? {} : { count: options.matchCount }),
  });
  const historyUrl = matchHistoryRequest(accountId).url;
  return (request) => {
    if (request.url === historyUrl) {
      return jsonResponse(history, 200, { 'called-steam': 'true' });
    }
    if (/\/v1\/players\/\d+\/match-history$/.test(request.url)) {
      return jsonResponse([], 200, { 'called-steam': 'false' });
    }
    if (request.url === heroesRequest().url) {
      return jsonResponse(FIXTURE_HERO_CATALOGUE);
    }
    return jsonResponse(
      { error: `No fixture for ${request.url.replace(DEADLOCK_API_BASE_URL, '')}` },
      404,
    );
  };
}
