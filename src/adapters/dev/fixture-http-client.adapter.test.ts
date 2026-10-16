/**
 * Tests of the development HTTP client and of the synthetic fixtures it serves: the fixtures must
 * pass the same validation as the real API's responses.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  DEADLOCK_API_BASE_URL,
  heroesRequest,
  matchHistoryRequest,
  matchMetadataRequest,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
} from '../../core/deadlock-api/endpoints';
import { parseHeroes } from '../../core/deadlock-api/heroes.schema';
import { parseMatchHistory } from '../../core/deadlock-api/match-history.schema';
import { parseMatchMetadata } from '../../core/deadlock-api/match-metadata.schema';
import { parseAccountId } from '../../core/domain/account';
import { PAIGE_HERO_ID } from '../../core/domain/hero';
import { AppError } from '../../core/errors/app-error';
import { findTrackedPlayer } from '../../core/match-detail/pruning';
import type { HttpRequest } from '../../ports/http-client.port';
import { testAccountId, testMatchId } from '../../test/test-data';
import { createFixtureApi, FixtureHttpClient, jsonResponse } from './fixture-http-client.adapter';
import { createMatchHistoryFixture, FIXTURE_ACCOUNT_ID } from './fixtures/match-history.fixture';
import { isMetadataMissing } from './fixtures/match-metadata.fixture';

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

describe('createFixtureApi match details', () => {
  const client = new FixtureHttpClient(createFixtureApi({ now: NOW }));
  // The history the API above is built on: same options, same rows.
  const history = createMatchHistoryFixture({ now: NOW });
  const rowOf = (missing: boolean) =>
    history.find(
      (row) =>
        row.hero_id === PAIGE_HERO_ID && isMetadataMissing(testMatchId(row.match_id)) === missing,
    ) ?? expect.unreachable('the history holds both kinds of Paige matches');

  /** What deadlock-api answers for a match it does not hold and may not ask Steam for. */
  const NOT_FOUND_BODY =
    '{"status":404,"error":"Match salts not found in Clickhouse and Steam fallback is disabled"}';

  /** What deadlock-api answers when the request lets it ask Steam and Steam is out of budget. */
  const STEAM_BUSY_BODY =
    '{"status":503,"error":"Steam is busy. Retry after the delay in the Retry-After header."}';

  it('serves the detail of a fixture match', async () => {
    const row = rowOf(false);
    const matchId = testMatchId(row.match_id);

    const response = await client.get(get(matchMetadataRequest(matchId).url));
    const metadata = parseMatchMetadata(JSON.parse(response.body), matchId);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/json');
    expect(findTrackedPlayer(metadata, FIXTURE_ACCOUNT_ID)).toEqual({
      playerSlot: (row.match_id % 12) + 1,
      team: row.player_team,
    });
  });

  it('serves the detail for the account of its options', async () => {
    // The history rows only differ by their account id: the same match ids are served.
    const account = testAccountId(42);
    const other = new FixtureHttpClient(createFixtureApi({ now: NOW, accountId: account }));
    const matchId = testMatchId(rowOf(false).match_id);

    const response = await other.get(get(matchMetadataRequest(matchId).url));
    const metadata = parseMatchMetadata(JSON.parse(response.body), matchId);

    expect(findTrackedPlayer(metadata, account).playerSlot).toBe((matchId % 12) + 1);
  });

  it('answers 404 for a missing match', async () => {
    const matchId = testMatchId(rowOf(true).match_id);

    const response = await client.get(get(matchMetadataRequest(matchId).url));

    expect(response.status).toBe(404);
    expect(response.body).toBe(NOT_FOUND_BODY);
  });

  it('answers 404 for a match that is not in the history', async () => {
    const response = await client.get(get(matchMetadataRequest(testMatchId(42)).url));

    expect(response.status).toBe(404);
    expect(response.body).toBe(NOT_FOUND_BODY);
  });

  it('answers 503 Steam is busy without disable_steam, whatever the match', async () => {
    // A served match, a missing one and an unknown one: without the parameter the API would ask
    // Steam for all three, so all three get the same answer.
    const matchIds = [rowOf(false).match_id, rowOf(true).match_id, 42];
    for (const matchId of matchIds) {
      for (const query of ['', '?disable_steam=false', '?other=1']) {
        const url = `${DEADLOCK_API_BASE_URL}/v1/matches/${String(matchId)}/metadata${query}`;

        const response = await client.get(get(url));

        expect(response.status).toBe(503);
        expect(response.body).toBe(STEAM_BUSY_BODY);
        expect(response.headers['retry-after']).toBe('1807');
      }
    }
  });

  it('answers 404 to a detail request that is not for deadlock-api', async () => {
    const matchId = testMatchId(rowOf(false).match_id);
    const url = `https://example.test/v1/matches/${String(matchId)}/metadata?disable_steam=true`;

    const response = await client.get(get(url));

    expect(response.status).toBe(404);
    expect(response.body).toContain('No fixture for');
  });

  it('leaves the history and the heroes as they were', async () => {
    const historyUrl = matchHistoryRequest(FIXTURE_ACCOUNT_ID).url;
    const heroesUrl = heroesRequest().url;
    const historyBefore = await client.get(get(historyUrl));
    const heroesBefore = await client.get(get(heroesUrl));

    await client.get(get(matchMetadataRequest(testMatchId(rowOf(false).match_id)).url));

    expect(await client.get(get(historyUrl))).toEqual(historyBefore);
    expect(await client.get(get(heroesUrl))).toEqual(heroesBefore);
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
