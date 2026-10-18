/**
 * Tests of the reading of deadlock-api's Steam profiles (`GET /v1/players/steam`).
 *
 * Every payload here is synthetic: it has the shape of a real answer (many fields the app ignores)
 * but none of its data.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testAccountId } from '../../test/test-data';
import { type AppError, isAppError } from '../errors/app-error';
import { parseSteamProfiles } from './steam-profile.schema';

/** The account of the tests. */
const ACCOUNT_ID = testAccountId(1000001);

/** The avatar hash of the account of the tests (made up). */
const HASH = 'ab12'.repeat(10);

/** The avatar hash of another account (made up). */
const OTHER_HASH = 'cd34'.repeat(10);

/**
 * Build the URL of an avatar in the form deadlock-api gives it.
 *
 * @param hash - The 40-hex hash of the avatar.
 * @param suffix - `''` (small), `'_medium'` or `'_full'`.
 * @returns The avatar URL.
 */
function avatar(hash: string, suffix = ''): string {
  return `https://avatars.steamstatic.com/${hash}${suffix}.jpg`;
}

/**
 * One profile in the exact shape of the API (fields the app ignores included).
 *
 * @param overrides - Fields to change.
 * @returns The raw profile.
 */
function rawProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account_id: 1000001,
    personaname: 'Synthetic Paige',
    profileurl: 'https://steamcommunity.com/id/synthetic-paige/',
    avatar: avatar(HASH),
    avatarmedium: avatar(HASH, '_medium'),
    avatarfull: avatar(HASH, '_full'),
    realname: 'Synthetic Person',
    countrycode: null,
    last_updated: 1_760_000_000,
    brand_new_field: { nested: true },
    ...overrides,
  };
}

/**
 * Run a call that must fail with an {@link AppError} and return that error.
 *
 * @param action - The call under test.
 * @returns The error it threw.
 */
function refusalOf(action: () => unknown): AppError {
  try {
    action();
  } catch (error) {
    if (isAppError(error)) {
      return error;
    }
    throw error;
  }
  return expect.unreachable('the call should have thrown');
}

describe('parseSteamProfiles', () => {
  it('reads the persona name and the avatar hash of the account', () => {
    const body = [
      rawProfile({
        account_id: 2000001,
        personaname: 'Someone Else',
        avatarmedium: avatar(OTHER_HASH),
      }),
      rawProfile(),
    ];

    expect(parseSteamProfiles(body, ACCOUNT_ID)).toEqual({
      personaName: 'Synthetic Paige',
      avatarHash: HASH,
    });
  });

  it('trims the persona name', () => {
    const body = [rawProfile({ personaname: '  Synthetic Paige  ' })];

    expect(parseSteamProfiles(body, ACCOUNT_ID)?.personaName).toBe('Synthetic Paige');
  });

  it('gives no persona name when it is blank or over-long', () => {
    for (const personaname of ['', '   ', 'a'.repeat(65)]) {
      const body = [rawProfile({ personaname })];

      expect(parseSteamProfiles(body, ACCOUNT_ID)).toEqual({
        personaName: null,
        avatarHash: HASH,
      });
    }
  });

  it('gives no persona name when the answer has none', () => {
    const profile = rawProfile();
    delete profile.personaname;

    expect(parseSteamProfiles([profile], ACCOUNT_ID)).toEqual({
      personaName: null,
      avatarHash: HASH,
    });
  });

  it('reads the avatar from the medium URL, then the small one, then the full one', () => {
    const medium = avatar(HASH, '_medium');
    const small = avatar(OTHER_HASH);
    const full = avatar('ef56'.repeat(10), '_full');

    const withAll = rawProfile({ avatarmedium: medium, avatar: small, avatarfull: full });
    const withoutMedium = rawProfile({ avatarmedium: 'https://evil.test/x.jpg', avatar: small });
    const onlyFull = rawProfile({ avatarmedium: '', avatar: 'not a url', avatarfull: full });

    expect(parseSteamProfiles([withAll], ACCOUNT_ID)?.avatarHash).toBe(HASH);
    expect(parseSteamProfiles([withoutMedium], ACCOUNT_ID)?.avatarHash).toBe(OTHER_HASH);
    expect(parseSteamProfiles([onlyFull], ACCOUNT_ID)?.avatarHash).toBe('ef56'.repeat(10));
  });

  it('gives no avatar hash when no avatar URL is readable', () => {
    const body = [
      rawProfile({
        avatar: 'https://evil.test/a.jpg',
        avatarmedium: `http://avatars.steamstatic.com/${HASH}.jpg`,
        avatarfull: '',
      }),
    ];

    expect(parseSteamProfiles(body, ACCOUNT_ID)).toEqual({
      personaName: 'Synthetic Paige',
      avatarHash: null,
    });
  });

  it('gives no avatar hash when the answer has no avatar at all', () => {
    const profile = rawProfile();
    delete profile.avatar;
    delete profile.avatarmedium;
    delete profile.avatarfull;

    expect(parseSteamProfiles([profile], ACCOUNT_ID)).toEqual({
      personaName: 'Synthetic Paige',
      avatarHash: null,
    });
  });

  it('gives no profile when deadlock-api has none for the account', () => {
    expect(parseSteamProfiles([], ACCOUNT_ID)).toBeNull();
    expect(parseSteamProfiles([rawProfile({ account_id: 2000001 })], ACCOUNT_ID)).toBeNull();
  });

  it('skips an element it cannot read', () => {
    const body = [
      null,
      'text',
      42,
      [rawProfile()],
      { personaname: 'No Account Id' },
      rawProfile({ account_id: '1000001' }),
      rawProfile({ account_id: 1000001.5 }),
      rawProfile({ personaname: 12345 }),
      rawProfile({ personaname: 'Readable Paige' }),
    ];

    expect(parseSteamProfiles(body, ACCOUNT_ID)).toEqual({
      personaName: 'Readable Paige',
      avatarHash: HASH,
    });
  });

  it('reads a null field like an absent one, and keeps what is valid', () => {
    // One odd field must not make the whole profile unreadable: the persona name and the medium
    // avatar are null, yet the small avatar still gives its hash.
    const body = [rawProfile({ personaname: null, avatarmedium: null })];

    expect(parseSteamProfiles(body, ACCOUNT_ID)).toEqual({ personaName: null, avatarHash: HASH });
  });

  it('gives a profile with nothing in it when every cosmetic field is null', () => {
    const body = [
      rawProfile({ personaname: null, avatar: null, avatarmedium: null, avatarfull: null }),
    ];

    expect(parseSteamProfiles(body, ACCOUNT_ID)).toEqual({ personaName: null, avatarHash: null });
  });

  it('gives no profile when the only element of the account cannot be read', () => {
    expect(parseSteamProfiles([rawProfile({ avatarmedium: 5 })], ACCOUNT_ID)).toBeNull();
  });

  it('refuses a body that is not a list, without quoting it', () => {
    // The persona name planted in the body, like any value of it, must stay out of the error.
    const planted = 'Planted Persona 987654321';
    const bodies = [rawProfile({ personaname: planted }), planted, 987654321, null];
    for (const body of bodies) {
      const error = refusalOf(() => parseSteamProfiles(body, ACCOUNT_ID));
      const described = JSON.stringify({ message: error.message, context: error.context });

      expect(error.kind).toBe('invalid_payload');
      expect(error.message).toBe('The Steam profiles are invalid');
      expect(error.context).toEqual({ issue: '(root): invalid_type' });
      expect(described).not.toContain('Planted');
      expect(described).not.toContain('987654321');
    }
  });
});
