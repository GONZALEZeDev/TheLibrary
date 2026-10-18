/**
 * Synthetic Steam data served by the development HTTP client: the profile deadlock-api gives of the
 * fixture account, its avatar, and the callbacks Steam would send back after a sign-in.
 *
 * No real player is ever described here: the account is the synthetic one of the other fixtures
 * (`match-history.fixture.ts`), its SteamID64 is computed from its account id, and the persona
 * name and the avatar are invented. The avatar is a plain 16 by 16 image.
 *
 * @packageDocumentation
 */
import { avatarUrl, bytesToBase64 } from '../../../core/account/linked-account';
import type { AccountId } from '../../../core/domain/account';
import { accountIdToSteamId64 } from '../../../core/steam/steam-id';
import { OPENID_NS, STEAM_OPENID_ENDPOINT } from '../../../core/steam/steam-openid';
import { FIXTURE_ACCOUNT_ID } from './match-history.fixture';

/** The SteamID64 of the fixture account: `'76561197961265729'`. It identifies no real player. */
export const FIXTURE_STEAM_ID64 = accountIdToSteamId64(FIXTURE_ACCOUNT_ID);

/** The persona name of the fixture account. */
export const FIXTURE_PERSONA_NAME = 'Fixture Player';

/** The avatar hash of the fixture account: 40 hexadecimal characters, like Steam's own. */
export const FIXTURE_AVATAR_HASH = 'ab'.repeat(20);

/**
 * The avatar file, in base64: a 16×16 solid image, synthetic. It is a real JPEG (made once with
 * `System.Drawing`), so that the code that stores and displays an avatar handles real bytes and not
 * a placeholder.
 */
const FIXTURE_AVATAR_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDKooor+yzoP//Z';

/** The avatar file as bytes, decoded once when the module loads. */
export const FIXTURE_AVATAR_JPEG: Uint8Array = Uint8Array.from(
  atob(FIXTURE_AVATAR_BASE64),
  (character) => character.charCodeAt(0),
);

/**
 * The avatar URL without its size suffix and extension: Steam serves the small, the medium and the
 * full avatar of a hash under the same stem. It is cut from {@link avatarUrl}, so the host of the
 * avatars is written once.
 */
const AVATAR_URL_STEM = avatarUrl(FIXTURE_AVATAR_HASH).replace(/_medium\.jpg$/, '');

/** Number of random bytes in the signature of an assertion (an HMAC-SHA1 is 20 bytes long). */
const SIGNATURE_BYTES = 20;

/** Number of random bytes behind the 6 random characters that end a `response_nonce`. */
const RESPONSE_NONCE_RANDOM_BYTES = 3;

/**
 * Imitate what deadlock-api answers to `GET /v1/players/steam?account_ids=<id>`: a list with the
 * profile of every known player, here only the fixture account's, in the raw shape of the API
 * (including the fields the app ignores). Any other player is unknown, and deadlock-api then
 * answers an empty list, never an error.
 *
 * @param accountId - The player asked for.
 * @returns The raw elements of the answer.
 */
export function createSteamProfilesFixture(accountId: AccountId): unknown[] {
  if (accountId !== FIXTURE_ACCOUNT_ID) {
    return [];
  }
  return [
    {
      account_id: FIXTURE_ACCOUNT_ID,
      personaname: FIXTURE_PERSONA_NAME,
      profileurl: `https://steamcommunity.com/profiles/${FIXTURE_STEAM_ID64}/`,
      avatar: `${AVATAR_URL_STEM}.jpg`,
      avatarmedium: `${AVATAR_URL_STEM}_medium.jpg`,
      avatarfull: `${AVATAR_URL_STEM}_full.jpg`,
      realname: null,
      countrycode: null,
      last_updated: 1_760_000_000,
    },
  ];
}

/** What {@link createSteamCallbackUrl} needs to know about the sign-in it answers. */
export interface SteamCallbackOptions {
  /** The SteamID64 of the player who signs in. */
  readonly steamId64: string;
  /** The current time (Unix ms): the moment of the assertion, which its `response_nonce` carries. */
  readonly now: number;
  /**
   * Query parameters to change after the callback is built, by their full name (`openid.mode`,
   * `nonce`…): a value replaces the parameter, `null` removes it. It makes a forged or incomplete
   * callback out of a genuine one.
   */
  readonly overrides?: Readonly<Record<string, string | null>>;
}

/**
 * Draw random bytes.
 *
 * @param length - Number of bytes.
 * @returns The bytes.
 */
function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Draw random bytes and write them in hexadecimal.
 *
 * @param length - Number of bytes.
 * @returns `2 × length` lowercase hexadecimal characters.
 */
function randomHex(length: number): string {
  return Array.from(randomBytes(length), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Build the URL Steam sends the browser back to after the player signed in: the `return_to` of the
 * login URL, followed by the `id_res` fields Steam answers with (verified live on 2026-10-18).
 *
 * The callback is genuine, as far as the app can tell on its own: it passes `validateCallback`
 * until the confirmation of Steam, which the fixture API gives once per signature. The signature
 * itself is random, since nothing here can sign for Steam.
 *
 * @param loginUrl - The URL the app opened in the browser (`SignInRequest.loginUrl`).
 * @param options - See {@link SteamCallbackOptions}.
 * @returns The callback URL, with `return_to`'s own query (the nonce) kept.
 * @throws Error when `loginUrl` carries no `openid.return_to`.
 */
export function createSteamCallbackUrl(loginUrl: string, options: SteamCallbackOptions): string {
  const returnTo = new URL(loginUrl).searchParams.get('openid.return_to');
  if (returnTo === null) {
    throw new Error('The login URL has no openid.return_to');
  }
  const callback = new URL(returnTo);
  const claimedId = `https://steamcommunity.com/openid/id/${options.steamId64}`;
  // The query of `return_to` (the nonce) comes first, as Steam keeps it, then Steam's own fields.
  const parameters = new Map<string, string>(callback.searchParams);
  const fields: Record<string, string> = {
    'openid.ns': OPENID_NS,
    'openid.mode': 'id_res',
    'openid.op_endpoint': STEAM_OPENID_ENDPOINT,
    'openid.claimed_id': claimedId,
    'openid.identity': claimedId,
    'openid.return_to': returnTo,
    // The RFC 3339 UTC second, without the milliseconds, then random text.
    'openid.response_nonce': `${new Date(options.now).toISOString().replace(/\.\d{3}Z$/, 'Z')}${randomHex(RESPONSE_NONCE_RANDOM_BYTES)}`,
    'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': bytesToBase64(randomBytes(SIGNATURE_BYTES)),
  };
  for (const [key, value] of Object.entries(fields)) {
    parameters.set(key, value);
  }
  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    if (value === null) {
      parameters.delete(key);
    } else {
      parameters.set(key, value);
    }
  }
  callback.search = new URLSearchParams([...parameters]).toString();
  return callback.toString();
}
