/**
 * Tests of the development HTTP client and of the synthetic fixtures it serves: the fixtures must
 * pass the same validation as the real API's responses.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { avatarUrl } from '../../core/account/linked-account';
import {
  DEADLOCK_API_BASE_URL,
  heroesRequest,
  matchHistoryRequest,
  matchMetadataRequest,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  steamProfileRequest,
} from '../../core/deadlock-api/endpoints';
import { parseHeroAssets } from '../../core/deadlock-api/heroes.schema';
import { parseMatchHistory } from '../../core/deadlock-api/match-history.schema';
import { parseMatchMetadata } from '../../core/deadlock-api/match-metadata.schema';
import { parseSteamProfiles } from '../../core/deadlock-api/steam-profile.schema';
import { parseAccountId } from '../../core/domain/account';
import { PAIGE_HERO_ID } from '../../core/domain/hero';
import { AppError } from '../../core/errors/app-error';
import { findTrackedPlayer } from '../../core/match-detail/pruning';
import {
  buildCheckAuthenticationBody,
  buildSignInRequest,
  nonceFromBytes,
  OPENID_NS,
  parseCheckAuthenticationAnswer,
  STEAM_OPENID_ENDPOINT,
  validateCallback,
} from '../../core/steam/steam-openid';
import type { HttpFormPost, HttpRequest } from '../../ports/http-client.port';
import { testAccountId, testMatchId } from '../../test/test-data';
import {
  createFixtureApi,
  FixtureHttpClient,
  jsonResponse,
  type FixtureRequest,
} from './fixture-http-client.adapter';
import { createMatchHistoryFixture, FIXTURE_ACCOUNT_ID } from './fixtures/match-history.fixture';
import { isMetadataMissing } from './fixtures/match-metadata.fixture';
import {
  createSteamCallbackUrl,
  createSteamProfilesFixture,
  FIXTURE_AVATAR_HASH,
  FIXTURE_AVATAR_JPEG,
  FIXTURE_PERSONA_NAME,
  FIXTURE_STEAM_ID64,
} from './fixtures/steam.fixture';

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

/**
 * Build a form post with the default limits of the app.
 *
 * @param url - URL to post to.
 * @param form - The form body.
 * @param maxBodyBytes - Largest body accepted.
 * @returns The request.
 */
function post(url: string, form: string, maxBodyBytes = MAX_RESPONSE_BYTES): HttpFormPost {
  return { ...get(url, maxBodyBytes), form };
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
    const heroes = parseHeroAssets(JSON.parse(response.body)).map(({ id, name }) => ({ id, name }));

    expect(heroes).toContainEqual({ id: PAIGE_HERO_ID, name: 'Paige' });
    // A hero flagged in development that players can pick is kept; a retired one is not.
    expect(heroes.map((hero) => hero.name)).toContain('Baba');
    expect(heroes.map((hero) => hero.name)).not.toContain('Retired Hero');
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

describe('createFixtureApi Steam', () => {
  const NONCE = nonceFromBytes(Uint8Array.from({ length: 16 }, (_, index) => index + 1));
  const PORT = 49152;

  /** The answer of Steam to a `check_authentication` it confirms, and to one it does not. */
  const IS_VALID = `ns:${OPENID_NS}\nis_valid:true\n`;
  const IS_NOT_VALID = `ns:${OPENID_NS}\nis_valid:false\n`;

  /**
   * The form the app posts to Steam to confirm a genuine sign-in: the fields of a callback, with
   * the mode changed. Every call signs its own assertion, with a signature of its own.
   *
   * @returns The form body.
   */
  function assertionForm(): string {
    const signIn = buildSignInRequest(PORT, NONCE);
    const url = createSteamCallbackUrl(signIn.loginUrl, {
      steamId64: FIXTURE_STEAM_ID64,
      now: NOW,
    });
    const check = validateCallback(
      url,
      { port: PORT, nonce: NONCE, returnTo: signIn.returnTo },
      NOW,
    );
    return check.ok
      ? buildCheckAuthenticationBody(check.fields)
      : expect.unreachable('the callback of the fixture is genuine');
  }

  /**
   * Change one field of a form.
   *
   * @param form - The form body.
   * @param key - The field.
   * @param value - Its new value, or `null` to remove it.
   * @returns The new form body.
   */
  function withField(form: string, key: string, value: string | null): string {
    const fields = new URLSearchParams(form);
    if (value === null) {
      fields.delete(key);
    } else {
      fields.set(key, value);
    }
    return fields.toString();
  }

  it('confirms a sign-in assertion once', async () => {
    const client = new FixtureHttpClient(createFixtureApi({ now: NOW }));
    const form = assertionForm();

    const first = await client.postForm(post(STEAM_OPENID_ENDPOINT, form));
    const second = await client.postForm(post(STEAM_OPENID_ENDPOINT, form));

    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('text/plain;charset=utf-8');
    expect(first.body).toBe(IS_VALID);
    expect(parseCheckAuthenticationAnswer(first.body)).toBe('valid');
    expect(second.status).toBe(200);
    expect(second.body).toBe(IS_NOT_VALID);
    expect(parseCheckAuthenticationAnswer(second.body)).toBe('invalid');
  });

  it('confirms each assertion on its own signature', async () => {
    const client = new FixtureHttpClient(createFixtureApi({ now: NOW }));

    const first = await client.postForm(post(STEAM_OPENID_ENDPOINT, assertionForm()));
    const second = await client.postForm(post(STEAM_OPENID_ENDPOINT, assertionForm()));

    expect([first.body, second.body]).toEqual([IS_VALID, IS_VALID]);
  });

  it('keeps what it confirmed to itself', async () => {
    const form = assertionForm();
    const first = new FixtureHttpClient(createFixtureApi({ now: NOW }));
    const second = new FixtureHttpClient(createFixtureApi({ now: NOW }));

    await first.postForm(post(STEAM_OPENID_ENDPOINT, form));

    expect((await second.postForm(post(STEAM_OPENID_ENDPOINT, form))).body).toBe(IS_VALID);
  });

  it('refuses a form that is not a check_authentication', async () => {
    const form = assertionForm();
    const refused = [
      withField(form, 'openid.mode', 'id_res'),
      withField(form, 'openid.mode', null),
      withField(form, 'openid.ns', 'http://specs.openid.net/auth/1.1'),
      withField(form, 'openid.ns', null),
      withField(form, 'openid.sig', null),
      withField(form, 'openid.sig', ''),
      '',
    ];
    const client = new FixtureHttpClient(createFixtureApi({ now: NOW }));

    for (const body of refused) {
      const response = await client.postForm(post(STEAM_OPENID_ENDPOINT, body));

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('text/plain;charset=utf-8');
      expect(response.body).toBe(IS_NOT_VALID);
    }
    // A refusal does not spend the signature: Steam still confirms the genuine form.
    expect((await client.postForm(post(STEAM_OPENID_ENDPOINT, form))).body).toBe(IS_VALID);
  });

  it('only answers a POST to the endpoint of Steam', async () => {
    const client = new FixtureHttpClient(createFixtureApi({ now: NOW }));

    expect((await client.get(get(STEAM_OPENID_ENDPOINT))).status).toBe(404);
    expect(
      (await client.postForm(post('https://example.test/openid/login', assertionForm()))).status,
    ).toBe(404);
  });

  it('gives the profile of the fixture account and nothing for the others', async () => {
    const client = new FixtureHttpClient(createFixtureApi({ now: NOW }));

    const own = await client.get(get(steamProfileRequest(FIXTURE_ACCOUNT_ID, false).url));
    const other = await client.get(get(steamProfileRequest(testAccountId(2_000_001), false).url));

    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toBe('application/json');
    expect(JSON.parse(own.body)).toEqual(createSteamProfilesFixture(FIXTURE_ACCOUNT_ID));
    expect(parseSteamProfiles(JSON.parse(own.body), FIXTURE_ACCOUNT_ID)).toEqual({
      personaName: FIXTURE_PERSONA_NAME,
      avatarHash: FIXTURE_AVATAR_HASH,
    });
    expect(other.status).toBe(200);
    expect(JSON.parse(other.body)).toEqual([]);
  });

  it('answers a refresh like a normal profile call', async () => {
    const client = new FixtureHttpClient(createFixtureApi({ now: NOW }));
    const normal = await client.get(get(steamProfileRequest(FIXTURE_ACCOUNT_ID, false).url));

    const refreshed = await client.get(get(steamProfileRequest(FIXTURE_ACCOUNT_ID, true).url));
    const other = await client.get(get(steamProfileRequest(testAccountId(2_000_001), true).url));

    expect(refreshed).toEqual(normal);
    expect(JSON.parse(other.body)).toEqual([]);
  });

  it('serves the fixture avatar as a JPEG', async () => {
    const client = new FixtureHttpClient(createFixtureApi({ now: NOW }));

    const response = await client.getBytes(get(avatarUrl(FIXTURE_AVATAR_HASH)));

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.body).toEqual(FIXTURE_AVATAR_JPEG);
  });

  it('answers 404 for any other avatar', async () => {
    const client = new FixtureHttpClient(createFixtureApi({ now: NOW }));

    const response = await client.getBytes(get(avatarUrl('cd'.repeat(20))));

    expect(response.status).toBe(404);
  });
});

describe('FixtureHttpClient', () => {
  it('records the requests it receives, with their method', async () => {
    const client = new FixtureHttpClient(() => jsonResponse([]));
    const request = get('https://example.test/a');

    await client.get(request);

    expect(client.requests).toEqual([{ ...request, method: 'GET' }]);
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

  it('answers a form post with the handler, which sees the method and the form', async () => {
    const seen: FixtureRequest[] = [];
    const client = new FixtureHttpClient((request) => {
      seen.push(request);
      return { status: 302, headers: { Location: 'https://example.test/b' }, body: '' };
    });
    const request = post('https://example.test/login', 'mode=check');

    const response = await client.postForm(request);

    expect(response).toEqual({
      status: 302,
      headers: { location: 'https://example.test/b' },
      body: '',
    });
    expect(seen).toEqual([{ ...request, method: 'POST' }]);
    expect(seen[0]?.form).toBe('mode=check');
    expect(client.requests).toEqual(seen);
  });

  it('answers a binary request with bytes', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const client = new FixtureHttpClient(() => ({
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
      body: bytes,
    }));

    const response = await client.getBytes(get('https://example.test/avatar.jpg'));

    expect(response).toEqual({
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
      body: bytes,
    });
    expect(client.requests).toEqual([{ ...get('https://example.test/avatar.jpg'), method: 'GET' }]);
  });

  it('encodes a text answer for a binary request', async () => {
    const client = new FixtureHttpClient(() => jsonResponse({ ok: true }));

    const response = await client.getBytes(get('https://example.test/a'));

    expect(new TextDecoder().decode(response.body)).toBe('{"ok":true}');
  });

  it('decodes a binary answer for a text request', async () => {
    const client = new FixtureHttpClient(() => ({
      status: 200,
      headers: {},
      body: new TextEncoder().encode('is_valid:true\n'),
    }));

    await expect(client.get(get('https://example.test/a'))).resolves.toMatchObject({
      body: 'is_valid:true\n',
    });
    await expect(
      client.postForm(post('https://example.test/a', 'mode=check')),
    ).resolves.toMatchObject({ body: 'is_valid:true\n' });
  });

  it('enforces the size cap on binary bodies', async () => {
    const binary = new FixtureHttpClient(() => ({
      status: 200,
      headers: {},
      body: new Uint8Array(100),
    }));
    // 60 bytes in 30 characters: the cap counts bytes, whatever the type of the body.
    const accented = new FixtureHttpClient(() => ({
      status: 200,
      headers: {},
      body: 'é'.repeat(30),
    }));
    const tooLarge = expect.objectContaining({ kind: 'invalid_payload' }) as unknown;

    await expect(binary.getBytes(get('https://example.test/a', 50))).rejects.toThrow(tooLarge);
    await expect(binary.get(get('https://example.test/a', 50))).rejects.toThrow(tooLarge);
    await expect(binary.postForm(post('https://example.test/a', 'mode=check', 50))).rejects.toThrow(
      tooLarge,
    );
    await expect(accented.getBytes(get('https://example.test/a', 50))).rejects.toThrow(tooLarge);
    await expect(accented.get(get('https://example.test/a', 59))).rejects.toThrow(tooLarge);
    await expect(accented.get(get('https://example.test/a', 60))).resolves.toMatchObject({
      status: 200,
    });
  });

  it('lower-cases header names for every method', async () => {
    const client = new FixtureHttpClient(() => ({
      status: 200,
      headers: { 'Content-Type': 'text/plain', 'X-Custom': '1' },
      body: '',
    }));
    const expected = { 'content-type': 'text/plain', 'x-custom': '1' };

    expect((await client.getBytes(get('https://example.test/a'))).headers).toEqual(expected);
    expect((await client.postForm(post('https://example.test/a', 'a=b'))).headers).toEqual(
      expected,
    );
  });
});
