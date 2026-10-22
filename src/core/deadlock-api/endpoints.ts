/**
 * The deadlock-api endpoints the app calls, and the rules every request follows.
 *
 * deadlock-api (https://api.deadlock-api.com, documented by its OpenAPI document at
 * `/openapi.json`) is the only data source of the app: Valve publishes no match data API for
 * Deadlock. Each installation calls it from the user's own IP address, without any key.
 *
 * @packageDocumentation
 */
import type { AccountId } from '../domain/account';
import type { HeroId } from '../domain/hero';
import type { MatchId } from '../domain/match';

/**
 * Base URL of deadlock-api. The desktop app may reach no other host: its HTTP permission
 * (`src-tauri/capabilities/default.json`) only allows this one.
 */
export const DEADLOCK_API_BASE_URL = 'https://api.deadlock-api.com';

/** Public home of the project, advertised in the User-Agent of every request. */
const REPOSITORY_URL = 'https://github.com/GONZALEZeDev/TheLibrary';

/** Every request is abandoned after this delay, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Largest response body accepted, in bytes, counted once decompressed. The largest payload the app
 * downloads is the item catalogue (`itemsRequest`, about 6.5 MB on 2026-10-21, some 65 % of the
 * limit; a match detail is about 1 MB); anything bigger is malformed or hostile. Past the limit the
 * download of the item catalogue would fail for good, so the API canary watches its share.
 */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Groups of endpoints sharing a politeness budget: `history` is the match history (its Steam
 * refresh is strictly rate-limited by deadlock-api), `assets` the static game data, `metadata` the
 * detail of one match, `profile` the Steam profile of a player (name and avatar), `analytics` the
 * community statistics of a hero (all of them share one limit per IP on deadlock-api's side), `rank`
 * the rank of a player (a separate, far stricter limit).
 */
export type RequestFamily = 'history' | 'assets' | 'metadata' | 'profile' | 'analytics' | 'rank';

/** A request to deadlock-api. */
export interface ApiRequest {
  /** Full URL to request. It may contain an account id: it is never logged. */
  readonly url: string;
  /**
   * Path template of the endpoint, logged instead of the URL, e.g.
   * `/v1/players/{account_id}/match-history`: the logs never contain an account id.
   */
  readonly endpoint: string;
  /** Budget the request counts against. */
  readonly family: RequestFamily;
}

/**
 * The match history of a player: every match deadlock-api knows of, all heroes, in one response
 * (the endpoint is not paginated).
 *
 * The `force_refetch` parameter is never sent: it makes deadlock-api walk Steam's pages, which is
 * limited to 1 request per hour and per IP.
 *
 * @param accountId - The player.
 * @returns The request.
 */
export function matchHistoryRequest(accountId: AccountId): ApiRequest {
  return {
    url: `${DEADLOCK_API_BASE_URL}/v1/players/${String(accountId)}/match-history`,
    endpoint: '/v1/players/{account_id}/match-history',
    family: 'history',
  };
}

/**
 * The hero catalogue, in English (owner's choice: hero names are never translated).
 *
 * `only_active=true` leaves out most heroes that cannot be played; the parser filters the few that
 * remain (see `heroes.schema.ts`).
 *
 * @returns The request.
 */
export function heroesRequest(): ApiRequest {
  return {
    url: `${DEADLOCK_API_BASE_URL}/v1/assets/heroes?language=english&only_active=true`,
    endpoint: '/v1/assets/heroes',
    family: 'assets',
  };
}

/**
 * The item catalogue, in English: every ability, weapon and shop item of the game, which names and
 * illustrates the damage sources and the final build of a match.
 *
 * The answer is large (about 6.5 MB, 0.5 MB compressed on the wire) because it carries the full
 * tooltips; `parseItemCatalogue` reduces it to the few fields the app shows (see
 * `assets.schema.ts`). The endpoint has no filter that would shrink it.
 *
 * @returns The request.
 */
export function itemsRequest(): ApiRequest {
  return {
    url: `${DEADLOCK_API_BASE_URL}/v1/assets/items?language=english`,
    endpoint: '/v1/assets/items',
    family: 'assets',
  };
}

/**
 * The rank catalogue, in English: the twelve tiers (Obscurus to Eternus) with their names and
 * badges.
 *
 * @returns The request.
 */
export function ranksRequest(): ApiRequest {
  return {
    url: `${DEADLOCK_API_BASE_URL}/v1/assets/ranks?language=english`,
    endpoint: '/v1/assets/ranks',
    family: 'assets',
  };
}

/**
 * The detail of one match (players, items, damage and healing over time): the full payload the
 * app archives.
 *
 * `disable_steam=true` is always sent. Without it, a match deadlock-api does not hold makes the API
 * ask Steam for it, and that fallback is budgeted at 3 requests per hour and per IP: once the
 * budget is spent, the API answers 503 "Steam is busy" with a `Retry-After` of about 30 minutes
 * (1807 s observed on a single such call). With the parameter, the API never asks Steam: a match it
 * does not hold is answered with a plain 404, and the Steam budget of the user's IP stays untouched.
 * The detail queue relies on that 404 (`not_found` in `api-response.ts`): it takes it for a match
 * the API may not have collected yet, counts it as a failed attempt and tries the match again
 * later, giving up at the sixth.
 *
 * @param matchId - The match.
 * @returns The request.
 */
export function matchMetadataRequest(matchId: MatchId): ApiRequest {
  return {
    url: `${DEADLOCK_API_BASE_URL}/v1/matches/${String(matchId)}/metadata?disable_steam=true`,
    endpoint: '/v1/matches/{match_id}/metadata',
    family: 'metadata',
  };
}

/**
 * The Steam profile of one player (persona name and avatar), as deadlock-api knows it.
 *
 * The endpoint takes a list of account ids, but the app only ever asks for the one account it is
 * signed in with. An unknown player is not an error: deadlock-api answers `200` with an empty list
 * `[]`, never a 404, so the caller must treat an empty list as "no profile" rather than as a failure.
 *
 * With `refresh`, the API fetches the profile from Steam again instead of answering from its cache.
 * That path is strictly limited by deadlock-api (3 requests a minute and 15 an hour per IP), so the
 * app budgets it far below the limit (see `PROFILE_REFRESH_RATE_LIMIT`).
 *
 * @param accountId - The player.
 * @param refresh - Whether to ask deadlock-api to read the profile from Steam again.
 * @returns The request.
 */
export function steamProfileRequest(accountId: AccountId, refresh: boolean): ApiRequest {
  return {
    url: `${DEADLOCK_API_BASE_URL}/v1/players/steam?account_ids=${String(accountId)}${refresh ? '&refresh=true' : ''}`,
    endpoint: '/v1/players/steam',
    family: 'profile',
  };
}

/**
 * The community a match is compared with: the matches of one hero, over a recent period, within a
 * match-duration window and, for a ranked comparison, within a rank tier.
 *
 * It holds nothing about the player: a community request carries a hero, a date, a duration window
 * and a badge range, never an account id nor a match id.
 */
export interface CohortQuery {
  /** Hero whose players form the community (Paige for every comparison of the app). */
  readonly heroId: HeroId;
  /**
   * Start of the period, in Unix seconds: only the matches played since then count. deadlock-api
   * floors it to the hour, so the caller passes a UTC midnight: the URL then stays the same all day
   * and the answer can be reused until the next one.
   */
  readonly sinceUnixS: number;
  /** Shortest match of the community, in seconds (inclusive). */
  readonly minDurationS: number;
  /**
   * Longest match of the community, in seconds (inclusive). With {@link CohortQuery.minDurationS} it
   * bounds a window of a few minutes, because most metrics are per-match totals that grow with the
   * length of the match: a 25-minute match is never compared with a 45-minute one.
   */
  readonly maxDurationS: number;
  /**
   * Range of the match average badge (inclusive), e.g. `{ min: 41, max: 46 }` for tier 4, or `null`
   * for every rank. The average badge only exists for ranked matches, so a range keeps ranked
   * matches only, and a `null` range also admits the matches without a badge.
   */
  readonly badge: { readonly min: number; readonly max: number } | null;
}

/**
 * The query parameters every community request shares once its own ones are written: the period,
 * the duration window and, when the cohort has one, the badge range. They always come in this order
 * so that two requests of the same cohort produce the same URL.
 *
 * @param query - The community.
 * @returns The parameters, without a leading `?` or `&`.
 */
function cohortFilters(query: CohortQuery): string {
  const period = `min_unix_timestamp=${String(query.sinceUnixS)}&min_duration_s=${String(query.minDurationS)}&max_duration_s=${String(query.maxDurationS)}`;
  const { badge } = query;
  return badge === null
    ? period
    : `${period}&min_average_badge=${String(badge.min)}&max_average_badge=${String(badge.max)}`;
}

/**
 * The distribution of every per-player metric (its percentile points) among the players of a hero in
 * a community: the reference a metric of a match is placed on.
 *
 * `hero_ids` restricts the statistics to the hero. `game_mode=normal` matches what the app archives
 * (the normal mode only), so a match is never compared with another kind of game. The period, the
 * duration window and the badge range come from the community (see {@link CohortQuery}).
 *
 * All the analytics endpoints share one limit of 200 requests per minute and per IP on
 * deadlock-api's side, which `ANALYTICS_RATE_LIMIT` stays far below.
 *
 * @param query - The community.
 * @returns The request.
 */
export function metricBenchmarkRequest(query: CohortQuery): ApiRequest {
  return {
    url: `${DEADLOCK_API_BASE_URL}/v1/analytics/player-stats/metrics?hero_ids=${String(query.heroId)}&game_mode=normal&${cohortFilters(query)}`,
    endpoint: '/v1/analytics/player-stats/metrics',
    family: 'analytics',
  };
}

/**
 * The performance curves (how a stat grows over the match) of the players of a hero in a community:
 * the reference of the metrics that are read at a moment of the match.
 *
 * `resolution=0` asks for absolute game times instead of percentage buckets of the match: the
 * points come at 180, 360, 540, 720 and 900 seconds, then every 300 seconds. A point then means the
 * same moment whatever the length of the match, whereas a percentage bucket stands for a different
 * moment in a 25-minute and in a 45-minute match. The other parameters are those of
 * {@link metricBenchmarkRequest}.
 *
 * @param query - The community.
 * @returns The request.
 */
export function performanceCurveRequest(query: CohortQuery): ApiRequest {
  return {
    url: `${DEADLOCK_API_BASE_URL}/v1/analytics/player-performance-curve?hero_ids=${String(query.heroId)}&game_mode=normal&resolution=0&${cohortFilters(query)}`,
    endpoint: '/v1/analytics/player-performance-curve',
    family: 'analytics',
  };
}

/**
 * The statistics of every hero in a duration window and a badge range: the sample the comparison
 * rests on, i.e. how many matches the community of the hero holds.
 *
 * This endpoint has no hero filter and answers one row per hero, so `hero_ids` is not sent and the
 * builder ignores `query.heroId`: the parser keeps the row of the hero it needs. The other
 * parameters are those of {@link metricBenchmarkRequest}.
 *
 * @param query - The community; its hero is not sent.
 * @returns The request.
 */
export function heroSampleRequest(query: CohortQuery): ApiRequest {
  return {
    url: `${DEADLOCK_API_BASE_URL}/v1/analytics/hero-stats?game_mode=normal&${cohortFilters(query)}`,
    endpoint: '/v1/analytics/hero-stats',
    family: 'analytics',
  };
}

/**
 * The purchases of every shop item by minute of the game, among the players of a hero in a
 * community: how many bought each item in each minute, which tells when a rank tier buys an item.
 *
 * `bucket=game_time_min` splits the answer by the minute of the purchase (bucket 14 is 14:00 to
 * 14:59). `min_matches=1` keeps every group: without it the API leaves out each (item, minute) pair
 * with fewer than 20 purchases, which erases the early and late tails of the distribution of a
 * rarely bought item. The other parameters are those of {@link metricBenchmarkRequest}; the caller
 * puts the bounds of the duration window it wants in the query (the review passes every length).
 *
 * @param query - The community.
 * @returns The request.
 */
export function itemStatsRequest(query: CohortQuery): ApiRequest {
  return {
    url: `${DEADLOCK_API_BASE_URL}/v1/analytics/item-stats?hero_ids=${String(query.heroId)}&game_mode=normal&bucket=game_time_min&min_matches=1&${cohortFilters(query)}`,
    endpoint: '/v1/analytics/item-stats',
    family: 'analytics',
  };
}

/**
 * The rank of one player: the badge the player had at the end of the latest ranked match.
 *
 * It tells which tier to compare an unranked match with. deadlock-api limits this endpoint to 20
 * requests a minute and per IP, and the app needs one a day (see `RANK_RATE_LIMIT`).
 *
 * @param accountId - The player.
 * @returns The request.
 */
export function playerRankRequest(accountId: AccountId): ApiRequest {
  return {
    url: `${DEADLOCK_API_BASE_URL}/v1/players/${String(accountId)}/rank`,
    endpoint: '/v1/players/{account_id}/rank',
    family: 'rank',
  };
}

/**
 * The User-Agent sent with every request, so that deadlock-api's maintainers can identify the app
 * and reach its authors.
 *
 * @param appVersion - Version of the app, e.g. `0.1.0`.
 * @returns The header value, e.g. `TheLibrary/0.1.0 (+https://github.com/GONZALEZeDev/TheLibrary)`.
 */
export function userAgent(appVersion: string): string {
  return `TheLibrary/${appVersion} (+${REPOSITORY_URL})`;
}

/**
 * Remove the account ids from a text before it is logged.
 *
 * Errors of the network layer can quote the URL they failed on, and the URL of the match history
 * contains the player's account id. Every `/players/<digits>` path segment and every
 * `account_id(s)=<digits>` parameter is replaced with its template.
 *
 * @param text - Any text, typically an error message.
 * @returns The text without account ids.
 */
export function redactAccountIds(text: string): string {
  return text
    .replaceAll(/\/players\/\d+/g, '/players/{account_id}')
    .replaceAll(/(account_ids?=)[\d,]+/g, '$1{account_id}');
}
