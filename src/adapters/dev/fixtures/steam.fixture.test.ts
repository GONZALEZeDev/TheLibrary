/**
 * Tests of the synthetic Steam data: the profile, the avatar and the sign-in callbacks. The
 * callbacks must pass the checks of the core the way Steam's own do, and the profile must pass the
 * same validation as a real answer of deadlock-api.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import {
  avatarHashFromUrl,
  avatarUrl,
  AVATAR_HASH_PATTERN,
} from '../../../core/account/linked-account';
import { parseSteamProfiles } from '../../../core/deadlock-api/steam-profile.schema';
import { accountIdToSteamId64 } from '../../../core/steam/steam-id';
import {
  buildSignInRequest,
  nonceFromBytes,
  type PendingSignIn,
  STEAM_OPENID_ENDPOINT,
  validateCallback,
} from '../../../core/steam/steam-openid';
import { testAccountId } from '../../../test/test-data';
import { FIXTURE_ACCOUNT_ID } from './match-history.fixture';
import {
  createSteamCallbackUrl,
  createSteamProfilesFixture,
  FIXTURE_AVATAR_HASH,
  FIXTURE_AVATAR_JPEG,
  FIXTURE_PERSONA_NAME,
  FIXTURE_STEAM_ID64,
} from './steam.fixture';

const PORT = 49152;
const NONCE = nonceFromBytes(Uint8Array.from({ length: 16 }, (_, index) => index + 1));
const NOW = Date.UTC(2026, 9, 18, 1, 2, 3, 456);

const request = buildSignInRequest(PORT, NONCE);
const pending: PendingSignIn = { port: PORT, nonce: NONCE, returnTo: request.returnTo };

/**
 * Read the query of a callback URL.
 *
 * @param url - The callback URL.
 * @returns Its parameters, by key.
 */
function parametersOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('the synthetic Steam identity', () => {
  it('is the SteamID64 of the fixture account, without any real data', () => {
    expect(FIXTURE_STEAM_ID64).toBe('76561197961265729');
    expect(FIXTURE_STEAM_ID64).toBe(accountIdToSteamId64(FIXTURE_ACCOUNT_ID));
    expect(FIXTURE_PERSONA_NAME).toBe('Fixture Player');
    expect(AVATAR_HASH_PATTERN.test(FIXTURE_AVATAR_HASH)).toBe(true);
  });
});

describe('createSteamProfilesFixture', () => {
  it('describes the fixture account like deadlock-api does', () => {
    const [profile, ...others] = createSteamProfilesFixture(FIXTURE_ACCOUNT_ID);

    expect(others).toEqual([]);
    expect(profile).toEqual({
      account_id: FIXTURE_ACCOUNT_ID,
      personaname: FIXTURE_PERSONA_NAME,
      profileurl: `https://steamcommunity.com/profiles/${FIXTURE_STEAM_ID64}/`,
      avatar: `https://avatars.steamstatic.com/${FIXTURE_AVATAR_HASH}.jpg`,
      avatarmedium: `https://avatars.steamstatic.com/${FIXTURE_AVATAR_HASH}_medium.jpg`,
      avatarfull: `https://avatars.steamstatic.com/${FIXTURE_AVATAR_HASH}_full.jpg`,
      realname: null,
      countrycode: null,
      last_updated: 1_760_000_000,
    });
  });

  it('passes the validation of the real answers', () => {
    const profile = parseSteamProfiles(
      createSteamProfilesFixture(FIXTURE_ACCOUNT_ID),
      FIXTURE_ACCOUNT_ID,
    );

    expect(profile).toEqual({ personaName: FIXTURE_PERSONA_NAME, avatarHash: FIXTURE_AVATAR_HASH });
  });

  it('serves the avatar the app downloads', () => {
    const [profile] = createSteamProfilesFixture(FIXTURE_ACCOUNT_ID) as [{ avatarmedium: string }];

    expect(profile.avatarmedium).toBe(avatarUrl(FIXTURE_AVATAR_HASH));
    expect(avatarHashFromUrl(profile.avatarmedium)).toBe(FIXTURE_AVATAR_HASH);
  });

  it('knows nobody else, like deadlock-api answers for an unknown player', () => {
    expect(createSteamProfilesFixture(testAccountId(2_000_001))).toEqual([]);
    expect(createSteamProfilesFixture(testAccountId(42))).toEqual([]);
  });
});

describe('FIXTURE_AVATAR_JPEG', () => {
  it('decodes a real JPEG', () => {
    expect([...FIXTURE_AVATAR_JPEG.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...FIXTURE_AVATAR_JPEG.subarray(-2)]).toEqual([0xff, 0xd9]);
  });

  it('is a 16 by 16 image', () => {
    // The start-of-frame marker `FF C0` is followed by its length, the precision, then the height
    // and the width on two bytes each.
    const marker = FIXTURE_AVATAR_JPEG.findIndex(
      (byte, index) => byte === 0xff && FIXTURE_AVATAR_JPEG[index + 1] === 0xc0,
    );
    const view = new DataView(
      FIXTURE_AVATAR_JPEG.buffer,
      FIXTURE_AVATAR_JPEG.byteOffset,
      FIXTURE_AVATAR_JPEG.byteLength,
    );

    expect(marker).toBeGreaterThan(0);
    expect(view.getUint16(marker + 5)).toBe(16);
    expect(view.getUint16(marker + 7)).toBe(16);
  });
});

describe('createSteamCallbackUrl', () => {
  it('builds a callback the core accepts', () => {
    const url = createSteamCallbackUrl(request.loginUrl, {
      steamId64: FIXTURE_STEAM_ID64,
      now: NOW,
    });

    const check = validateCallback(url, pending, NOW);

    expect(check.ok).toBe(true);
    expect(check.ok && check.steamId64).toBe(FIXTURE_STEAM_ID64);
  });

  it('carries the fields of a genuine id_res answer of Steam', () => {
    const url = createSteamCallbackUrl(request.loginUrl, {
      steamId64: FIXTURE_STEAM_ID64,
      now: NOW,
    });
    const parameters = parametersOf(url);
    const claimedId = `https://steamcommunity.com/openid/id/${FIXTURE_STEAM_ID64}`;

    expect(url.startsWith(`${request.realm}/callback?nonce=${NONCE}&`)).toBe(true);
    expect(Object.fromEntries(parameters)).toMatchObject({
      nonce: NONCE,
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'id_res',
      'openid.op_endpoint': STEAM_OPENID_ENDPOINT,
      'openid.claimed_id': claimedId,
      'openid.identity': claimedId,
      'openid.return_to': request.returnTo,
      'openid.assoc_handle': '1234567890',
      'openid.signed':
        'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    });
  });

  it('names the player it is given', () => {
    const other = accountIdToSteamId64(testAccountId(2_000_001));

    const check = validateCallback(
      createSteamCallbackUrl(request.loginUrl, { steamId64: other, now: NOW }),
      pending,
      NOW,
    );

    expect(check.ok && check.steamId64).toBe(other);
  });

  it('times the assertion at the second of now, followed by 6 random hexadecimal characters', () => {
    const url = createSteamCallbackUrl(request.loginUrl, {
      steamId64: FIXTURE_STEAM_ID64,
      now: NOW,
    });

    expect(parametersOf(url).get('openid.response_nonce')).toMatch(
      /^2026-10-18T01:02:03Z[0-9a-f]{6}$/,
    );
  });

  it('signs with 20 random bytes in base64, different every time', () => {
    const options = { steamId64: FIXTURE_STEAM_ID64, now: NOW };

    const first = parametersOf(createSteamCallbackUrl(request.loginUrl, options)).get('openid.sig');
    const second = parametersOf(createSteamCallbackUrl(request.loginUrl, options)).get(
      'openid.sig',
    );

    expect(first).toMatch(/^[A-Za-z0-9+/]{27}=$/);
    expect(second).toMatch(/^[A-Za-z0-9+/]{27}=$/);
    expect(first).not.toBe(second);
  });

  it('overrides or removes callback fields', () => {
    const options = { steamId64: FIXTURE_STEAM_ID64, now: NOW };
    const base = parametersOf(createSteamCallbackUrl(request.loginUrl, options));
    const url = createSteamCallbackUrl(request.loginUrl, {
      ...options,
      overrides: { 'openid.mode': 'cancel', 'openid.sig': null, nonce: 'f'.repeat(32) },
    });
    const parameters = parametersOf(url);

    expect(parameters.get('openid.mode')).toBe('cancel');
    expect(parameters.has('openid.sig')).toBe(false);
    expect(parameters.get('nonce')).toBe('f'.repeat(32));
    // What is not overridden stays as it was built.
    expect(parameters.get('openid.claimed_id')).toBe(base.get('openid.claimed_id'));
    expect(
      validateCallback(
        createSteamCallbackUrl(request.loginUrl, {
          ...options,
          overrides: { 'openid.mode': 'cancel' },
        }),
        pending,
        NOW,
      ),
    ).toEqual({ ok: false, refusal: 'cancelled_on_steam' });
    expect(
      validateCallback(
        createSteamCallbackUrl(request.loginUrl, {
          ...options,
          overrides: { 'openid.signed': null },
        }),
        pending,
        NOW,
      ),
    ).toEqual({ ok: false, refusal: 'signed' });
  });

  it('refuses a login URL that carries no return_to', () => {
    expect(() =>
      createSteamCallbackUrl(STEAM_OPENID_ENDPOINT, { steamId64: FIXTURE_STEAM_ID64, now: NOW }),
    ).toThrow('return_to');
  });
});
