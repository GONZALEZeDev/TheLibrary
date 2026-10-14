/**
 * Tests of the interpretation of deadlock-api's responses.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { parseAccountId } from '../domain/account';
import { DEFAULT_PAUSE_MS, interpretResponse, parseRetryAfter } from './api-response';
import { heroesRequest, matchHistoryRequest } from './endpoints';

/** Current time of the tests, Unix milliseconds. */
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

const HISTORY = matchHistoryRequest(parseAccountId(123456789) ?? expect.unreachable());
const HEROES = heroesRequest();

/**
 * Build a response.
 *
 * @param status - HTTP status.
 * @param body - Body text.
 * @param headers - Headers, lower-case names.
 * @returns The response.
 */
function response(status: number, body = '', headers: Record<string, string> = {}) {
  return { status, body, headers };
}

describe('interpretResponse', () => {
  it('returns the JSON body of a 2xx response and whether it was refreshed from Steam', () => {
    expect(
      interpretResponse(HISTORY, response(200, '[]', { 'called-steam': 'true' }), NOW),
    ).toEqual({ kind: 'success', json: [], fromSteam: true });
    expect(
      interpretResponse(HISTORY, response(200, '[]', { 'called-steam': 'false' }), NOW),
    ).toEqual({ kind: 'success', json: [], fromSteam: false });
    expect(interpretResponse(HEROES, response(200, '[{"id":1}]'), NOW)).toEqual({
      kind: 'success',
      json: [{ id: 1 }],
      fromSteam: false,
    });
  });

  it('reports a 2xx body that is not JSON as an invalid payload', () => {
    const outcome = interpretResponse(HEROES, response(200, '<html>'), NOW);

    expect(outcome).toMatchObject({ kind: 'failure', error: { kind: 'invalid_payload' } });
  });

  it('uses the stored history that a 429 on the match history still returns', () => {
    expect(
      interpretResponse(
        HISTORY,
        response(429, '[{"match_id":1}]', { 'called-steam': 'false' }),
        NOW,
      ),
    ).toEqual({ kind: 'success', json: [{ match_id: 1 }], fromSteam: false });
  });

  it('pauses on a 429 without a usable history, for the time given by Retry-After', () => {
    const outcome = interpretResponse(
      HISTORY,
      response(429, '{"status":429}', { 'retry-after': '120' }),
      NOW,
    );

    expect(outcome).toMatchObject({
      kind: 'pause',
      until: NOW + 120_000,
      error: { kind: 'rate_limited' },
    });
  });

  it('pauses on any 429 of another endpoint, and on a 503', () => {
    expect(interpretResponse(HEROES, response(429, '[]'), NOW)).toMatchObject({
      kind: 'pause',
      until: NOW + DEFAULT_PAUSE_MS,
      error: { kind: 'rate_limited' },
    });
    expect(
      interpretResponse(HISTORY, response(503, '', { 'retry-after': '5' }), NOW),
    ).toMatchObject({ kind: 'pause', until: NOW + 5_000, error: { kind: 'service_unavailable' } });
  });

  it.each([
    [403, 'forbidden'],
    [404, 'not_found'],
    [500, 'service_unavailable'],
    [502, 'service_unavailable'],
    [400, 'unexpected'],
    [418, 'unexpected'],
  ] as const)('reports a %s as %s', (status, kind) => {
    expect(interpretResponse(HISTORY, response(status), NOW)).toMatchObject({
      kind: 'failure',
      error: { kind, context: { endpoint: '/v1/players/{account_id}/match-history', status } },
    });
  });
});

describe('parseRetryAfter', () => {
  it('reads a number of seconds', () => {
    expect(parseRetryAfter('30', NOW)).toBe(30_000);
  });

  it('reads an HTTP date', () => {
    expect(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90_000);
  });

  it('waits 60 seconds when the header is absent or unreadable', () => {
    expect(parseRetryAfter(undefined, NOW)).toBe(DEFAULT_PAUSE_MS);
    expect(parseRetryAfter('', NOW)).toBe(DEFAULT_PAUSE_MS);
    expect(parseRetryAfter('soon', NOW)).toBe(DEFAULT_PAUSE_MS);
  });

  it('waits at least 1 second and at most 1 hour', () => {
    expect(parseRetryAfter('0', NOW)).toBe(1_000);
    expect(parseRetryAfter(new Date(NOW - 5_000).toUTCString(), NOW)).toBe(1_000);
    expect(parseRetryAfter('999999', NOW)).toBe(3_600_000);
  });
});
