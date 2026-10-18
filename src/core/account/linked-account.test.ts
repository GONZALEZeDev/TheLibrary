/**
 * Tests of the linked Steam account: the avatar helpers, the persona name rule and the daily
 * refresh of the profile.
 *
 * Every hash and every name here is synthetic.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testAccountId } from '../../test/test-data';
import {
  AVATAR_HASH_PATTERN,
  type LinkedAccount,
  MAX_AVATAR_BASE64_LENGTH,
  MAX_AVATAR_BYTES,
  PROFILE_REFRESH_INTERVAL_MS,
  avatarDataUri,
  avatarHashFromUrl,
  avatarUrl,
  bytesToBase64,
  isProfileRefreshDue,
  normalisePersonaName,
} from './linked-account';

/** A made-up avatar hash: 40 lowercase hexadecimal characters. */
const HASH = 'ab12'.repeat(10);

/** One hour, in milliseconds. */
const HOUR_MS = 60 * 60_000;

/** The moment the tests consider as "now" (Unix ms). */
const NOW = 1_760_000_000_000;

/**
 * A linked account with a profile fetched just now.
 *
 * @param overrides - Fields to change.
 * @returns The account.
 */
function linkedAccount(overrides: Partial<LinkedAccount> = {}): LinkedAccount {
  return {
    accountId: testAccountId(1000001),
    personaName: 'Synthetic Paige',
    avatarBase64: 'AP+A',
    avatarHash: HASH,
    linkedAt: NOW - 30 * 24 * HOUR_MS,
    profileFetchedAt: NOW,
    ...overrides,
  };
}

describe('avatarUrl', () => {
  it('rebuilds the medium avatar URL from its hash', () => {
    expect(avatarUrl(HASH)).toBe(`https://avatars.steamstatic.com/${HASH}_medium.jpg`);
  });

  it('throws for an uppercase or 39-character hash', () => {
    expect(() => avatarUrl(HASH.toUpperCase())).toThrow(Error);
    expect(() => avatarUrl(HASH.slice(1))).toThrow(Error);
  });

  it('never puts the refused hash in the error', () => {
    // An avatar hash is personal data: it must not reach the logs through an error message.
    const refused = HASH.toUpperCase();
    let message = '';
    try {
      avatarUrl(refused);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).not.toBe('');
    expect(message).not.toContain(refused);
  });
});

describe('AVATAR_HASH_PATTERN', () => {
  it('matches exactly 40 lowercase hexadecimal characters', () => {
    expect(AVATAR_HASH_PATTERN.test(HASH)).toBe(true);
    expect(AVATAR_HASH_PATTERN.test(HASH.slice(1))).toBe(false);
    expect(AVATAR_HASH_PATTERN.test(`${HASH}0`)).toBe(false);
    expect(AVATAR_HASH_PATTERN.test(HASH.toUpperCase())).toBe(false);
    expect(AVATAR_HASH_PATTERN.test(`${HASH.slice(1)}g`)).toBe(false);
  });
});

describe('avatarHashFromUrl', () => {
  it('reads the avatar hash of the current Steam hosts', () => {
    const hosts = [
      'avatars.steamstatic.com',
      'avatars.fastly.steamstatic.com',
      'avatars.akamai.steamstatic.com',
    ];
    for (const host of hosts) {
      for (const suffix of ['', '_medium', '_full']) {
        const url = `https://${host}/${HASH}${suffix}.jpg`;

        expect(avatarHashFromUrl(url), url).toBe(HASH);
      }
    }
  });

  it('reads the avatar hash of an older Steam host', () => {
    const directory = HASH.slice(0, 2);
    for (const suffix of ['', '_medium', '_full']) {
      const url = `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/avatars/${directory}/${HASH}${suffix}.jpg`;

      expect(avatarHashFromUrl(url), url).toBe(HASH);
    }
  });

  it('round-trips with avatarUrl', () => {
    expect(avatarHashFromUrl(avatarUrl(HASH))).toBe(HASH);
  });

  it('refuses an avatar URL on any other host or scheme', () => {
    const refused = [
      `http://avatars.steamstatic.com/${HASH}.jpg`,
      `https://steamstatic.com.evil.test/${HASH}.jpg`,
      `https://evil.test/avatars.steamstatic.com/${HASH}.jpg`,
      `https://evil-steamstatic.com/${HASH}.jpg`,
      `https://evil.test@avatars.steamstatic.com/${HASH}.jpg`,
      `https://avatars.steamstatic.com/${HASH.toUpperCase()}.jpg`,
      // The older host is accepted on its avatar path only, never on the scheme or host alone.
      `http://steamcdn-a.akamaihd.net/steamcommunity/public/images/avatars/ab/${HASH}.jpg`,
      `https://steamcdn-a.akamaihd.net/other/path/${HASH}.jpg`,
      `https://akamaihd.net/steamcommunity/public/images/avatars/ab/${HASH}.jpg`,
    ];
    for (const url of refused) {
      expect(avatarHashFromUrl(url), url).toBeNull();
    }
  });

  it('refuses a URL that is not a JPEG of a 40-hexadecimal-character hash', () => {
    const refused = [
      `https://avatars.steamstatic.com/${HASH}.png`,
      `https://avatars.steamstatic.com/${HASH.slice(1)}.jpg`,
      `https://avatars.steamstatic.com/${HASH}0.jpg`,
      `https://avatars.steamstatic.com/${HASH}_large.jpg`,
      `https://avatars.steamstatic.com/${HASH}.jpg?size=big`,
      `https://avatars.steamstatic.com/path/${HASH}.jpg`,
      '',
      'not a url',
    ];
    for (const url of refused) {
      expect(avatarHashFromUrl(url), url).toBeNull();
    }
  });
});

describe('avatarDataUri', () => {
  it('turns the avatar into a data URI', () => {
    expect(avatarDataUri('AP+A')).toBe('data:image/jpeg;base64,AP+A');
  });
});

describe('bytesToBase64', () => {
  it('encodes bytes in base64', () => {
    expect(bytesToBase64(new Uint8Array([0, 255, 128]))).toBe('AP+A');
    expect(bytesToBase64(new Uint8Array())).toBe('');
  });

  it('encodes a large array without an exception', () => {
    // Far above the argument limit of `String.fromCharCode(...bytes)`, which is why the bytes are
    // converted in chunks.
    const encoded = bytesToBase64(new Uint8Array(300_000));

    expect(encoded).toHaveLength(400_000);
  });

  it('encodes one single base64 text, whatever the chunks of the conversion', () => {
    // 300,000 is not a multiple of the chunk size, nor is the chunk size a multiple of 3: encoding
    // each chunk separately would put padding inside the text. Decoding it back proves the text is
    // one valid base64 of the very same bytes.
    const bytes = Uint8Array.from({ length: 300_000 }, (_, index) => (index * 7) % 256);

    const decoded = atob(bytesToBase64(bytes));

    expect(decoded).toHaveLength(bytes.length);
    expect(bytes.every((byte, index) => decoded.charCodeAt(index) === byte)).toBe(true);
  });
});

describe('avatar limits', () => {
  it('sizes the base64 limit for the byte limit', () => {
    expect(MAX_AVATAR_BYTES).toBe(256 * 1024);
    expect(MAX_AVATAR_BASE64_LENGTH).toBe(4 * Math.ceil(MAX_AVATAR_BYTES / 3));
    expect(bytesToBase64(new Uint8Array(MAX_AVATAR_BYTES))).toHaveLength(MAX_AVATAR_BASE64_LENGTH);
  });
});

describe('normalisePersonaName', () => {
  it('ignores a blank or over-long persona name', () => {
    expect(normalisePersonaName('  Paige  ')).toBe('Paige');
    expect(normalisePersonaName('')).toBeNull();
    expect(normalisePersonaName('   ')).toBeNull();
    expect(normalisePersonaName('a'.repeat(64))).toBe('a'.repeat(64));
    expect(normalisePersonaName('a'.repeat(65))).toBeNull();
  });

  it('measures the limit on the trimmed name', () => {
    expect(normalisePersonaName(`  ${'a'.repeat(64)}  `)).toBe('a'.repeat(64));
    expect(normalisePersonaName(`  ${'a'.repeat(65)}  `)).toBeNull();
  });
});

describe('isProfileRefreshDue', () => {
  it('refreshes the profile once a day', () => {
    expect(isProfileRefreshDue(linkedAccount({ profileFetchedAt: null }), NOW)).toBe(true);
    expect(isProfileRefreshDue(linkedAccount({ profileFetchedAt: NOW - 23 * HOUR_MS }), NOW)).toBe(
      false,
    );
    expect(isProfileRefreshDue(linkedAccount({ profileFetchedAt: NOW - 24 * HOUR_MS }), NOW)).toBe(
      true,
    );
  });

  it('is not due the instant the profile was fetched, and one millisecond before the day', () => {
    expect(isProfileRefreshDue(linkedAccount({ profileFetchedAt: NOW }), NOW)).toBe(false);
    expect(
      isProfileRefreshDue(
        linkedAccount({ profileFetchedAt: NOW - PROFILE_REFRESH_INTERVAL_MS + 1 }),
        NOW,
      ),
    ).toBe(false);
  });

  it('treats a profile fetched in the future as due', () => {
    // The clock moved back: the stored time cannot be trusted, and waiting for it would block the
    // refresh for as long as the clock was set back.
    expect(isProfileRefreshDue(linkedAccount({ profileFetchedAt: NOW + 1 }), NOW)).toBe(true);
    expect(isProfileRefreshDue(linkedAccount({ profileFetchedAt: NOW + 10 * HOUR_MS }), NOW)).toBe(
      true,
    );
  });
});
