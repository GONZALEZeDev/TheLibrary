/**
 * What a response of deadlock-api means for the app: data to use, a pause to respect, or a typed
 * error.
 *
 * Every rule about status codes and response headers lives here, including the quirks of the API,
 * so the service that sends the requests stays a plain orchestrator.
 *
 * @packageDocumentation
 */
import { AppError, type AppErrorContext, type AppErrorKind } from '../errors/app-error';
import type { ApiRequest } from './endpoints';

/** The parts of an HTTP response the rules look at. Header names are lower case. */
export interface ApiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** What a response means. */
export type ApiOutcome =
  /** Usable data. `fromSteam` tells whether deadlock-api refreshed it from Steam just now. */
  | { readonly kind: 'success'; readonly json: unknown; readonly fromSteam: boolean }
  /** deadlock-api asks to slow down: no request may be sent before `until` (Unix ms). */
  | { readonly kind: 'pause'; readonly until: number; readonly error: AppError }
  /** The request failed. */
  | { readonly kind: 'failure'; readonly error: AppError };

/** Pause applied when a 429 or 503 response gives no usable `Retry-After`, in milliseconds. */
export const DEFAULT_PAUSE_MS = 60_000;

/** Shortest pause, so that a `Retry-After: 0` cannot turn into a burst of requests. */
const MIN_PAUSE_MS = 1_000;

/**
 * Longest pause. A larger `Retry-After` (a typo, or a misconfigured proxy) would otherwise stop
 * every synchronisation for days; after an hour the next attempt simply asks again.
 */
export const MAX_PAUSE_MS = 60 * 60_000;

/**
 * Interpret a response of deadlock-api.
 *
 * - 2xx: the JSON body is the data.
 * - 429 on the match history: deadlock-api still returns the history it has stored, only without a
 *   fresh Steam refresh (the refresh quota of bot friends is spent): the data is used.
 * - Any other 429, and 503: a pause until `Retry-After`.
 * - 403: the player made their data private on deadlock-api (`forbidden`).
 * - 404: `not_found`; other 5xx: `service_unavailable`; any other status: `unexpected`.
 *
 * @param request - The request the response answers.
 * @param response - The response.
 * @param now - Current time, Unix milliseconds.
 * @returns What the response means.
 */
export function interpretResponse(
  request: ApiRequest,
  response: ApiResponse,
  now: number,
): ApiOutcome {
  const { status } = response;
  const context = { endpoint: request.endpoint, status };
  if (status >= 200 && status < 300) {
    const json = parseJson(response.body);
    return json.ok
      ? {
          kind: 'success',
          json: json.value,
          fromSteam: response.headers['called-steam'] === 'true',
        }
      : failure('invalid_payload', 'The response is not valid JSON', context);
  }
  if (status === 429 && request.family === 'history') {
    const json = parseJson(response.body);
    if (json.ok && Array.isArray(json.value)) {
      return { kind: 'success', json: json.value, fromSteam: false };
    }
  }
  if (status === 429 || status === 503) {
    const pauseMs = parseRetryAfter(response.headers['retry-after'], now);
    return {
      kind: 'pause',
      until: now + pauseMs,
      error: new AppError(
        status === 429 ? 'rate_limited' : 'service_unavailable',
        'deadlock-api asked to slow down',
        { context: { ...context, pauseMs } },
      ),
    };
  }
  if (status === 403) {
    return failure('forbidden', 'The data of this player is private on deadlock-api', context);
  }
  if (status === 404) {
    return failure('not_found', 'deadlock-api does not know this resource', context);
  }
  if (status >= 500) {
    return failure('service_unavailable', 'deadlock-api failed to answer', context);
  }
  return failure('unexpected', 'deadlock-api rejected the request', context);
}

/**
 * Read a `Retry-After` header: a number of seconds, or an HTTP date.
 *
 * @param value - The header value, if any.
 * @param now - Current time, Unix milliseconds.
 * @returns The delay to wait, in milliseconds, between 1 second and 1 hour; 60 seconds when the
 *   header is absent or unreadable.
 */
export function parseRetryAfter(value: string | undefined, now: number): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_PAUSE_MS;
  }
  const text = value.trim();
  const delayMs = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  if (Number.isNaN(delayMs)) {
    return DEFAULT_PAUSE_MS;
  }
  return Math.min(Math.max(delayMs, MIN_PAUSE_MS), MAX_PAUSE_MS);
}

/**
 * Parse a JSON text without throwing.
 *
 * @param text - The text to parse.
 * @returns The parsed value, or `{ ok: false }` when the text is not JSON.
 */
function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Build a failure outcome.
 *
 * @param kind - Kind of the error.
 * @param message - Technical description, for the logs.
 * @param context - Endpoint template and status.
 * @returns The outcome.
 */
function failure(kind: AppErrorKind, message: string, context: AppErrorContext): ApiOutcome {
  return { kind: 'failure', error: new AppError(kind, message, { context }) };
}
