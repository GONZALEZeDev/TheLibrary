/**
 * {@link HttpClient} that never touches the network, for tests and the browser dev mode.
 *
 * Every request (GET, form POST or binary GET) is answered by a handler function:
 * {@link createFixtureApi} imitates deadlock-api, and the two Steam servers the sign-in reaches
 * (Steam's OpenID endpoint and its avatar CDN), with the synthetic fixtures, and tests pass their
 * own handler to simulate any status, header or transport failure. The client records the requests
 * it received, with their method, so tests can inspect them.
 *
 * @packageDocumentation
 */
import { avatarUrl } from '../../core/account/linked-account';
import { AppError } from '../../core/errors/app-error';
import {
  heroesRequest,
  itemsRequest,
  matchHistoryRequest,
  ranksRequest,
  DEADLOCK_API_BASE_URL,
} from '../../core/deadlock-api/endpoints';
import { parseAccountId, type AccountId } from '../../core/domain/account';
import { parseMatchId } from '../../core/domain/match';
import { OPENID_NS, STEAM_OPENID_ENDPOINT } from '../../core/steam/steam-openid';
import type {
  HttpBytesResponse,
  HttpClient,
  HttpFormPost,
  HttpRequest,
  HttpResponse,
} from '../../ports/http-client.port';
import {
  createHeroSamplesFixture,
  createItemStatsFixture,
  createMetricBenchmarkFixture,
  createPerformanceCurveFixture,
  createPlayerRankFixture,
  createUnrankedPlayerRankFixture,
} from './fixtures/analytics.fixture';
import { FIXTURE_ITEM_CATALOGUE, FIXTURE_RANK_CATALOGUE } from './fixtures/assets.fixture';
import { FIXTURE_HERO_CATALOGUE } from './fixtures/heroes.fixture';
import {
  createMatchHistoryFixture,
  FIXTURE_ACCOUNT_ID,
  type RawMatchHistoryRow,
} from './fixtures/match-history.fixture';
import { createMatchMetadataFixture, isMetadataMissing } from './fixtures/match-metadata.fixture';
import {
  createSteamProfilesFixture,
  FIXTURE_AVATAR_HASH,
  FIXTURE_AVATAR_JPEG,
} from './fixtures/steam.fixture';

/**
 * A request as a handler sees it and as the client records it: the method tells which method of
 * the client it came from, and `form` is the body of a form post.
 */
export type FixtureRequest = HttpRequest & {
  readonly method: 'GET' | 'POST';
  readonly form?: string;
};

/**
 * What a handler answers. A handler does not have to know which method of the client asked: the
 * body is text or bytes, and the client converts it for the caller.
 */
export interface FixtureResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array;
}

/**
 * Answers a request: returns a response, or throws an `AppError` to simulate a failure of the
 * transport (`timeout`, `network`).
 */
export type FixtureHandler = (
  request: FixtureRequest,
) => FixtureResponse | Promise<FixtureResponse>;

/** Options of {@link FixtureHttpClient}. */
export interface FixtureHttpClientOptions {
  /** Delay before each answer, in milliseconds, so the browser dev mode shows loading states. */
  readonly delayMs?: number;
}

/** {@link HttpClient} answering every request with a handler function. */
export class FixtureHttpClient implements HttpClient {
  /** Every request received, oldest first. */
  readonly requests: FixtureRequest[] = [];

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
   * Answer a GET request with the handler like a real client: the size cap of the request is
   * enforced and header names are lower-cased.
   *
   * @param request - The request.
   * @returns The handler's response, with lower-case header names and a body decoded as UTF-8.
   * @throws AppError thrown by the handler, or of kind `invalid_payload` when the body exceeds
   *   `maxBodyBytes`.
   */
  async get(request: HttpRequest): Promise<HttpResponse> {
    const answer = await this.#answer({ ...request, method: 'GET' });
    return { ...answer, body: bodyAsText(answer.body) };
  }

  /**
   * Answer a form post with the handler, which sees the method and the form; like a real client,
   * no redirect is followed, so a 3xx answer comes back as it is.
   *
   * @param request - The request, with the form as its body.
   * @returns The handler's response, as {@link FixtureHttpClient.get}.
   * @throws AppError, as {@link FixtureHttpClient.get}.
   */
  async postForm(request: HttpFormPost): Promise<HttpResponse> {
    const answer = await this.#answer({ ...request, method: 'POST' });
    return { ...answer, body: bodyAsText(answer.body) };
  }

  /**
   * Answer a GET request for a binary body with the handler.
   *
   * @param request - The request.
   * @returns The handler's response, with lower-case header names and a body as bytes (a text body
   *   is encoded as UTF-8).
   * @throws AppError, as {@link FixtureHttpClient.get}.
   */
  async getBytes(request: HttpRequest): Promise<HttpBytesResponse> {
    const answer = await this.#answer({ ...request, method: 'GET' });
    return { ...answer, body: bodyAsBytes(answer.body) };
  }

  /**
   * Record a request and answer it with the handler: what every method of the client shares.
   *
   * @param request - The request, as the handler sees it.
   * @returns The handler's response, with lower-case header names.
   * @throws AppError thrown by the handler, or of kind `invalid_payload` when the body exceeds
   *   `maxBodyBytes`.
   */
  async #answer(request: FixtureRequest): Promise<FixtureResponse> {
    this.requests.push(request);
    if (this.#delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
    }
    const response = await this.#handler(request);
    // The cap counts bytes, whatever the type of the body, like the cap of a real client.
    if (bodyAsBytes(response.body).byteLength > request.maxBodyBytes) {
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
 * The body of a fixture response as text.
 *
 * @param body - Text, or bytes to decode as UTF-8.
 * @returns The text.
 */
function bodyAsText(body: string | Uint8Array): string {
  return typeof body === 'string' ? body : new TextDecoder().decode(body);
}

/**
 * The body of a fixture response as bytes.
 *
 * @param body - Bytes, or text to encode as UTF-8.
 * @returns The bytes.
 */
function bodyAsBytes(body: string | Uint8Array): Uint8Array {
  return typeof body === 'string' ? new TextEncoder().encode(body) : body;
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
 * The path of the match detail endpoint, once the base URL is cut off: the match id, then the
 * query when there is one. The path is `/v1/matches/{match_id}/metadata`, as in
 * `matchMetadataRequest`.
 */
const MATCH_METADATA_PATH = /^\/v1\/matches\/(\d+)\/metadata(?:\?(.*))?$/;

/** The error body deadlock-api sends for a match it does not hold, when it may not ask Steam. */
const MATCH_NOT_FOUND_ERROR = 'Match salts not found in Clickhouse and Steam fallback is disabled';

/** The error body deadlock-api sends when Steam, asked for a match, is out of budget. */
const STEAM_BUSY_ERROR = 'Steam is busy. Retry after the delay in the Retry-After header.';

/** The `Retry-After` of that answer, in seconds (the delay observed on the real API). */
const STEAM_BUSY_RETRY_AFTER_S = '1807';

/**
 * Answer a request for the detail of a match.
 *
 * - Without `disable_steam=true` the real API would ask Steam for the match, and Steam is busy: 503.
 *   The answer does not depend on the match, since the API only learns whether it holds it
 *   after the Steam call is allowed.
 * - With it, a match of the history that is not {@link isMetadataMissing} is served, and any other
 *   match is reported missing: 404.
 *
 * @param matchText - The match id of the URL, in digits.
 * @param query - The query of the URL, without the `?`; empty when there is none.
 * @param rows - The rows of the synthetic history, by match id.
 * @param accountId - The tracked account.
 * @returns The response.
 */
function answerMatchMetadata(
  matchText: string,
  query: string,
  rows: ReadonlyMap<number, RawMatchHistoryRow>,
  accountId: AccountId,
): HttpResponse {
  if (new URLSearchParams(query).get('disable_steam') !== 'true') {
    return jsonResponse({ status: 503, error: STEAM_BUSY_ERROR }, 503, {
      'retry-after': STEAM_BUSY_RETRY_AFTER_S,
    });
  }
  const matchId = parseMatchId(matchText);
  const row = matchId === null ? undefined : rows.get(matchId);
  if (matchId === null || row === undefined || isMetadataMissing(matchId)) {
    return jsonResponse({ status: 404, error: MATCH_NOT_FOUND_ERROR }, 404);
  }
  return jsonResponse(createMatchMetadataFixture(row, accountId));
}

/**
 * The path of the Steam profile endpoint, once the base URL is cut off: the account id of the
 * query, then the `refresh` parameter when there is one (`steamProfileRequest`). The profile does
 * not depend on `refresh`: the real API only reads from Steam instead of its cache.
 */
const STEAM_PROFILE_PATH = /^\/v1\/players\/steam\?account_ids=(\d+)(?:&refresh=true)?$/;

/**
 * The path of the community benchmark endpoint, once the base URL is cut off, then its query when
 * there is one (`metricBenchmarkRequest`). The query is ignored: the answer is always the same.
 */
const METRIC_BENCHMARK_PATH = /^\/v1\/analytics\/player-stats\/metrics(?:\?.*)?$/;

/**
 * The path of the performance curve endpoint, once the base URL is cut off, then its query when
 * there is one (`performanceCurveRequest`). Only its `max_duration_s` is read.
 */
const PERFORMANCE_CURVE_PATH = /^\/v1\/analytics\/player-performance-curve(?:\?(.*))?$/;

/**
 * The path of the hero statistics endpoint, once the base URL is cut off, then its query when there
 * is one (`heroSampleRequest`). The query is ignored: the answer is always the same.
 */
const HERO_SAMPLE_PATH = /^\/v1\/analytics\/hero-stats(?:\?.*)?$/;

/**
 * The path of the item statistics endpoint, once the base URL is cut off, then its query when there
 * is one (`itemStatsRequest`). The query is ignored: the answer is always the same.
 */
const ITEM_STATS_PATH = /^\/v1\/analytics\/item-stats(?:\?.*)?$/;

/** The path of the player rank endpoint, once the base URL is cut off: the account id is in it. */
const PLAYER_RANK_PATH = /^\/v1\/players\/(\d+)\/rank$/;

/**
 * Answer a request for community data (the benchmark, the curve, the hero statistics, the item
 * statistics or a rank).
 *
 * The answers do not depend on the community asked for (the hero, the period, the badge range),
 * except for the length of the curve, which follows `max_duration_s` as the real API's does, and
 * for the rank, which is the one of the tracked account (any other player has no rank).
 *
 * @param path - The path of the URL, once the base URL is cut off, with its query.
 * @param trackedAccountId - The tracked account.
 * @returns The response, or `null` when the path is not one of the community endpoints.
 */
function answerCommunityRequest(path: string, trackedAccountId: AccountId): HttpResponse | null {
  if (METRIC_BENCHMARK_PATH.test(path)) {
    return jsonResponse(createMetricBenchmarkFixture());
  }
  const curveRoute = PERFORMANCE_CURVE_PATH.exec(path);
  if (curveRoute !== null) {
    const [, query = ''] = curveRoute;
    const maxDurationS = new URLSearchParams(query).get('max_duration_s');
    // Without a window, the curve runs as far as the longest match the API knows.
    return jsonResponse(
      createPerformanceCurveFixture(maxDurationS === null ? undefined : Number(maxDurationS)),
    );
  }
  if (HERO_SAMPLE_PATH.test(path)) {
    return jsonResponse(createHeroSamplesFixture());
  }
  if (ITEM_STATS_PATH.test(path)) {
    return jsonResponse(createItemStatsFixture());
  }
  const rankRoute = PLAYER_RANK_PATH.exec(path);
  if (rankRoute !== null) {
    const [, accountText = ''] = rankRoute;
    return jsonResponse(
      parseAccountId(Number(accountText)) === trackedAccountId
        ? createPlayerRankFixture()
        : createUnrankedPlayerRankFixture(),
    );
  }
  return null;
}

/** The content type of Steam's `check_authentication` answers. */
const STEAM_ANSWER_CONTENT_TYPE = 'text/plain;charset=utf-8';

/**
 * Answer a `check_authentication` the way Steam does: `is_valid:true` the first time it sees an
 * assertion, `is_valid:false` for the same assertion afterwards (a captured callback cannot be
 * replayed, verified live on 2026-10-18), and `is_valid:false` for anything that is not a
 * `check_authentication` of an assertion. The real Steam recomputes the signature; the fixture
 * cannot, so it only knows whether it already confirmed this exact `openid.sig`.
 *
 * @param form - The body of the POST.
 * @param confirmed - The signatures confirmed so far, which a confirmation adds to. A refused form
 *   adds nothing: the genuine assertion can still be confirmed.
 * @returns The response, in OpenID's key-value form.
 */
function answerCheckAuthentication(form: string, confirmed: Set<string>): FixtureResponse {
  const fields = new URLSearchParams(form);
  const signature = fields.get('openid.sig') ?? '';
  const isConfirmed =
    fields.get('openid.mode') === 'check_authentication' &&
    fields.get('openid.ns') === OPENID_NS &&
    signature !== '' &&
    !confirmed.has(signature);
  if (isConfirmed) {
    confirmed.add(signature);
  }
  return {
    status: 200,
    headers: { 'content-type': STEAM_ANSWER_CONTENT_TYPE },
    body: `ns:${OPENID_NS}\nis_valid:${isConfirmed ? 'true' : 'false'}\n`,
  };
}

/**
 * Imitate deadlock-api and the two Steam servers the sign-in reaches, with the synthetic fixtures:
 *
 * - deadlock-api: the match history of one account (refreshed "from Steam"), an empty history for
 *   any other account, the hero, item and rank catalogues (`GET /v1/assets/…`, with the portraits
 *   and loadouts of the heroes), the detail of the matches of that history
 *   (`GET /v1/matches/{match_id}/metadata`, see `answerMatchMetadata`), and the Steam profile
 *   (`GET /v1/players/steam`, with or without `refresh`) of the fixture account, an empty list for
 *   any other, and the community data of the match analysis and the review (the benchmark, the
 *   performance curve, the hero statistics and the item statistics of `GET /v1/analytics/…`, and
 *   the rank `GET /v1/players/{id}/rank`, see `answerCommunityRequest`);
 * - Steam's OpenID endpoint: the confirmation of an assertion, once (`POST`, see
 *   `answerCheckAuthentication`). Each fixture API remembers what it confirmed;
 * - Steam's avatar CDN: the avatar of the fixture account, as a JPEG;
 * - 404 for anything else.
 *
 * Steam's endpoint is only reached by a POST, and the avatar and the profile only by a GET.
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
  const rowsByMatchId = new Map(
    history.map((row): [number, RawMatchHistoryRow] => [row.match_id, row]),
  );
  const avatarFixtureUrl = avatarUrl(FIXTURE_AVATAR_HASH);
  // The signatures of the assertions this API confirmed: Steam confirms an assertion once.
  const confirmedSignatures = new Set<string>();
  return (request) => {
    if (request.method === 'POST' && request.url === STEAM_OPENID_ENDPOINT) {
      return answerCheckAuthentication(request.form ?? '', confirmedSignatures);
    }
    if (request.method === 'GET' && request.url === avatarFixtureUrl) {
      return {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
        body: FIXTURE_AVATAR_JPEG,
      };
    }
    if (request.url === historyUrl) {
      return jsonResponse(history, 200, { 'called-steam': 'true' });
    }
    if (/\/v1\/players\/\d+\/match-history$/.test(request.url)) {
      return jsonResponse([], 200, { 'called-steam': 'false' });
    }
    if (request.url === heroesRequest().url) {
      return jsonResponse(FIXTURE_HERO_CATALOGUE);
    }
    if (request.url === itemsRequest().url) {
      return jsonResponse(FIXTURE_ITEM_CATALOGUE);
    }
    if (request.url === ranksRequest().url) {
      return jsonResponse(FIXTURE_RANK_CATALOGUE);
    }
    // Only the API's own host is imitated: the path is read once the base URL is cut off.
    const path = request.url.startsWith(DEADLOCK_API_BASE_URL)
      ? request.url.slice(DEADLOCK_API_BASE_URL.length)
      : '';
    const metadataRoute = MATCH_METADATA_PATH.exec(path);
    if (metadataRoute !== null) {
      const [, matchText = '', query = ''] = metadataRoute;
      return answerMatchMetadata(matchText, query, rowsByMatchId, accountId);
    }
    const profileRoute = STEAM_PROFILE_PATH.exec(path);
    const profileAccountId =
      request.method === 'GET' && profileRoute !== null
        ? parseAccountId(Number(profileRoute[1]))
        : null;
    if (profileAccountId !== null) {
      return jsonResponse(createSteamProfilesFixture(profileAccountId));
    }
    const communityAnswer =
      request.method === 'GET' ? answerCommunityRequest(path, accountId) : null;
    if (communityAnswer !== null) {
      return communityAnswer;
    }
    return jsonResponse(
      { error: `No fixture for ${request.url.replace(DEADLOCK_API_BASE_URL, '')}` },
      404,
    );
  };
}
