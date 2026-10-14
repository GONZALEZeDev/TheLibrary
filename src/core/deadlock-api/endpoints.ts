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
 * refresh is strictly rate-limited by deadlock-api), `assets` the static game data.
 */
export type RequestFamily = 'history' | 'assets';

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
