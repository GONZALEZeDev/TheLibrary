/**
 * Tests of the development HTTP client and of the synthetic fixtures it serves: the fixtures must
 * pass the same validation as the real API's responses.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  heroesRequest,
  matchHistoryRequest,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
} from '../../core/deadlock-api/endpoints';
import { parseHeroes } from '../../core/deadlock-api/heroes.schema';
import { parseMatchHistory } from '../../core/deadlock-api/match-history.schema';
import { parseAccountId } from '../../core/domain/account';
import { PAIGE_HERO_ID } from '../../core/domain/hero';
import { AppError } from '../../core/errors/app-error';
import type { HttpRequest } from '../../ports/http-client.port';
import { createFixtureApi, FixtureHttpClient, jsonResponse } from './fixture-http-client.adapter';
import { FIXTURE_ACCOUNT_ID } from './fixtures/match-history.fixture';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

/**
 * Build a GET request with the default limits of the app.
 *
 * @param url - URL to request.
 * @param maxBodyBytes - Largest body accepted.
 * @returns The request.
 */
function get(url: string, maxBodyBytes = MAX_RESPONSE_BYTES): HttpRequest {
  return { url, headers: {}, timeoutMs: REQUEST_TIMEOUT_MS, maxBodyBytes };
}

describe('createFixtureApi', () => {
  const client = new FixtureHttpClient(createFixtureApi({ now: NOW }));

  it('serves a synthetic history that passes the validation of the real API, with no invalid row', async () => {
    const response = await client.get(get(matchHistoryRequest(FIXTURE_ACCOUNT_ID).url));
    const history = parseMatchHistory(JSON.parse(response.body), FIXTURE_ACCOUNT_ID);

    expect(response.status).toBe(200);
    expect(response.headers['called-steam']).toBe('true');
    expect(history.matches).toHaveLength(240);
    expect(history.invalidRows).toBe(0);
  });

  it('serves a plausible history: most recent first, ending near "now", with Paige well represented', async () => {
    const response = await client.get(get(matchHistoryRequest(FIXTURE_ACCOUNT_ID).url));
    const { matches } = parseMatchHistory(JSON.parse(response.body), FIXTURE_ACCOUNT_ID);
    const paigeShare = matches.filter((match) => match.heroId === PAIGE_HERO_ID).length / 240;
    const startTimes = matches.map((match) => match.startTime);

    expect(startTimes).toEqual(startTimes.toSorted((first, second) => second - first));
    expect(NOW / 1000 - (startTimes[0] ?? 0)).toBe(2 * 3600);
    expect(paigeShare).toBeGreaterThan(0.25);
    expect(paigeShare).toBeLessThan(0.55);
  });

  it('serves the same history for the same options', async () => {
    const other = new FixtureHttpClient(createFixtureApi({ now: NOW }));
    const url = matchHistoryRequest(FIXTURE_ACCOUNT_ID).url;

    expect((await other.get(get(url))).body).toBe((await client.get(get(url))).body);
  });

  it('serves an empty history for any other account', async () => {
    const otherAccount = parseAccountId(42) ?? expect.unreachable();
    const response = await client.get(get(matchHistoryRequest(otherAccount).url));

    expect(JSON.parse(response.body)).toEqual([]);
  });

  it('serves a hero catalogue that passes the validation of the real API', async () => {
    const response = await client.get(get(heroesRequest().url));
    const heroes = parseHeroes(JSON.parse(response.body));

    expect(heroes).toContainEqual({ id: PAIGE_HERO_ID, name: 'Paige' });
    expect(heroes.map((hero) => hero.name)).not.toContain('Baba');
  });

  it('answers 404 to anything else', async () => {
    const response = await client.get(get('https://api.deadlock-api.com/v1/unknown'));

    expect(response.status).toBe(404);
  });
});

describe('FixtureHttpClient', () => {
  it('records the requests it receives', async () => {
    const client = new FixtureHttpClient(() => jsonResponse([]));
    const request = get('https://example.test/a');

    await client.get(request);

    expect(client.requests).toEqual([request]);
  });

  it('lower-cases header names, like a real client', async () => {
    const client = new FixtureHttpClient(() => jsonResponse([], 429, { 'Retry-After': '30' }));

    const response = await client.get(get('https://example.test/a'));

    expect(response.headers).toEqual({ 'content-type': 'application/json', 'retry-after': '30' });
  });

  it('rejects a body larger than the limit of the request, like a real client', async () => {
    const client = new FixtureHttpClient(() => jsonResponse('x'.repeat(100)));

    await expect(client.get(get('https://example.test/a', 50))).rejects.toThrow(
      expect.objectContaining({ kind: 'invalid_payload' }),
    );
  });

  it('lets a handler simulate a failure of the transport', async () => {
    const client = new FixtureHttpClient(() => {
      throw new AppError('timeout', 'simulated timeout');
    });

    await expect(client.get(get('https://example.test/a'))).rejects.toThrow('simulated timeout');
  });
});
