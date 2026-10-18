/**
 * The Steam account linked to the app, and the rules about its profile (persona name and avatar).
 *
 * Signing in with Steam tells the app who the player is (an {@link AccountId}); the persona name and
 * the avatar are cosmetic and come from deadlock-api, which may know nothing about the account. The
 * avatar is downloaded once and stored with the account as a base64 JPEG, so the interface can show
 * it offline and without a request per display; this module holds the pure rules around it:
 * how a hash becomes a URL and back, how bytes become base64, which names and sizes are accepted, and
 * when the profile is due for a refresh.
 *
 * @packageDocumentation
 */
import type { AccountId } from '../domain/account';

/** The Steam account the app is linked to, as it is stored. */
export interface LinkedAccount {
  readonly accountId: AccountId;
  /** Steam persona name; `null` when no profile is known (the UI shows "Steam player"). */
  readonly personaName: string | null;
  /** The medium avatar (JPEG), base64; `null` when none is stored. */
  readonly avatarBase64: string | null;
  /** 40-hex hash of the stored avatar; `null` exactly when `avatarBase64` is. */
  readonly avatarHash: string | null;
  /** When the account was linked (Unix ms). */
  readonly linkedAt: number;
  /** When deadlock-api last answered about the profile (Unix ms); `null` when it never did. */
  readonly profileFetchedAt: number | null;
}

/**
 * Largest avatar the app stores, in bytes. A medium Steam avatar (64 × 64) weighs a few kilobytes:
 * the limit only protects the database from a surprising response.
 */
export const MAX_AVATAR_BYTES = 256 * 1024;

/**
 * Largest base64 text of a stored avatar: base64 writes every started group of 3 bytes as 4
 * characters, so `4 × ceil(MAX_AVATAR_BYTES / 3)`.
 */
export const MAX_AVATAR_BASE64_LENGTH = 349_528;

/**
 * Longest persona name the app keeps, in UTF-16 code units. Steam itself stops at 32 characters:
 * the limit is generous, and only refuses a name that is not a name.
 */
export const MAX_PERSONA_NAME_LENGTH = 64;

/** How old the profile may get before it is fetched again: one day, in milliseconds. */
export const PROFILE_REFRESH_INTERVAL_MS = 24 * 60 * 60_000;

/** An avatar hash: the SHA-1 Steam names its avatar files after, in lowercase hexadecimal. */
export const AVATAR_HASH_PATTERN = /^[0-9a-f]{40}$/;

/**
 * An avatar URL on one of Steam's current hosts (`avatars.steamstatic.com` and its
 * `fastly`/`akamai` variants). The host must end with `steamstatic.com` right before the first
 * slash, so `steamstatic.com.evil.test` and `evil.test/steamstatic.com/…` are refused.
 */
const CURRENT_HOST_AVATAR_URL =
  /^https:\/\/(?:[a-z0-9-]+\.)*steamstatic\.com\/([0-9a-f]{40})(?:_medium|_full)?\.jpg$/;

/**
 * An avatar URL on Steam's older host, which deadlock-api may still answer with: the avatars live
 * under a directory named after the first two characters of the hash.
 */
const OLD_HOST_AVATAR_URL =
  /^https:\/\/steamcdn-a\.akamaihd\.net\/steamcommunity\/public\/images\/avatars\/[0-9a-f]{2}\/([0-9a-f]{40})(?:_medium|_full)?\.jpg$/;

/** The host and path every avatar is downloaded from. */
const AVATAR_URL_PREFIX = 'https://avatars.steamstatic.com/';

/**
 * Number of bytes turned into text by one `String.fromCharCode` call. Spreading a large array into
 * a function call overflows the stack, so a big avatar is converted piece by piece.
 */
const BYTES_PER_CHUNK = 0x8000;

/**
 * Build the URL of the medium avatar (64 × 64) from its hash.
 *
 * @param hash - The 40-hex avatar hash.
 * @returns The URL the avatar is downloaded from.
 * @throws Error when `hash` is not 40 lowercase hexadecimal characters. The message does not quote
 *   it: an avatar hash identifies a player and must not reach the logs.
 */
export function avatarUrl(hash: string): string {
  if (!AVATAR_HASH_PATTERN.test(hash)) {
    throw new Error('An avatar hash is 40 lowercase hexadecimal characters');
  }
  return `${AVATAR_URL_PREFIX}${hash}_medium.jpg`;
}

/**
 * Read the avatar hash out of an avatar URL.
 *
 * Only two forms are accepted, both over HTTPS: Steam's current hosts and its older
 * `steamcdn-a.akamaihd.net` avatar path. Any other host, scheme or file name gives `null`, so a
 * response can never make the app download from an address Steam does not own.
 *
 * @param url - The URL deadlock-api gave for an avatar.
 * @returns The 40-hex hash, or `null` when `url` is not an avatar URL of Steam.
 */
export function avatarHashFromUrl(url: string): string | null {
  const match = CURRENT_HOST_AVATAR_URL.exec(url) ?? OLD_HOST_AVATAR_URL.exec(url);
  return match?.[1] ?? null;
}

/**
 * Build the `src` of an `<img>` for a stored avatar.
 *
 * @param avatarBase64 - The base64 text of the JPEG, as stored.
 * @returns A `data:` URI the webview displays without any request.
 */
export function avatarDataUri(avatarBase64: string): string {
  return `data:image/jpeg;base64,${avatarBase64}`;
}

/**
 * Encode bytes in base64.
 *
 * The bytes become a "binary string" (one character per byte) which `btoa` encodes in one go: only
 * the conversion to characters is chunked, never the encoding. Encoding each chunk separately would
 * be wrong, as a chunk size that is not a multiple of 3 makes every chunk end with padding.
 *
 * @param bytes - The bytes to encode.
 * @returns Their base64 text.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += BYTES_PER_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + BYTES_PER_CHUNK));
  }
  return btoa(binary);
}

/**
 * Clean a persona name before it is stored.
 *
 * @param value - The persona name as deadlock-api gave it.
 * @returns The name without surrounding spaces, or `null` when it is blank or longer than
 *   {@link MAX_PERSONA_NAME_LENGTH} (the UI then shows "Steam player").
 */
export function normalisePersonaName(value: string): string | null {
  const name = value.trim();
  return name === '' || name.length > MAX_PERSONA_NAME_LENGTH ? null : name;
}

/**
 * Tell whether the profile of the account should be fetched again.
 *
 * It is due when it was never fetched, when it was fetched {@link PROFILE_REFRESH_INTERVAL_MS} ago
 * or more, or when it is said to have been fetched after `now`: the clock was moved back, so the
 * stored time cannot be trusted and would otherwise block the refresh until `now` caught up.
 *
 * @param account - The linked account.
 * @param now - The current time (Unix ms).
 * @returns `true` when the profile is due for a refresh.
 */
export function isProfileRefreshDue(account: LinkedAccount, now: number): boolean {
  const { profileFetchedAt } = account;
  return (
    profileFetchedAt === null ||
    profileFetchedAt > now ||
    now - profileFetchedAt >= PROFILE_REFRESH_INTERVAL_MS
  );
}
