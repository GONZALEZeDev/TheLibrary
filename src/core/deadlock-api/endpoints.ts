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
import type { MatchId } from '../domain/match';

/**
 * Base URL of deadlock-api. The desktop app may reach no other host: its HTTP permission
 * (`src-tauri/capabilities/default.json`) only allows this one.
 */
export const DEADLOCK_API_BASE_URL = 'https://api.deadlock-api.com';

/** Public home of the project, advertised in the User-Agent of every request. */
export const REPOSITORY_URL = 'https://github.com/GONZALEZeDev/TheLibrary';

/** Every request is abandoned after this delay, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Largest response body accepted, in bytes. The largest payload the app will download (a match
 * detail, about 1 MB) stays far below it; anything bigger is malformed or hostile.
 */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Groups of endpoints sharing a politeness budget: `history` is the match history (its Steam
 * refresh is strictly rate-limited by deadlock-api), `assets` the static game data, `metadata` the
 * detail of one match, `profile` the Steam profile of a player (name and avatar).
 */
export type RequestFamily = 'history' | 'assets' | 'metadata' | 'profile';

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
