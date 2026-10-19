/**
 * Tests of the Steam OpenID request and of the checks of its callback.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { testAccountId } from '../../test/test-data';
import { accountIdToSteamId64 } from './steam-id';
import {
  type CallbackRefusal,
  type PendingSignIn,
  buildCheckAuthenticationBody,
  buildSignInRequest,
  nonceFromBytes,
  parseCheckAuthenticationAnswer,
  validateCallback,
} from './steam-openid';

const PORT = 49152;
const NONCE = '0123456789abcdef0123456789abcdef';
const MINUTE = 60_000;
/** The moment the callbacks below are received, at a whole second like Steam's response nonces. */
const NOW = Date.parse('2026-10-18T01:02:03Z');
/** The synthetic player who signs in: account 1000001. */
const STEAM_ID64 = accountIdToSteamId64(testAccountId(1_000_001));
const CLAIMED_ID = `https://steamcommunity.com/openid/id/${STEAM_ID64}`;

const request = buildSignInRequest(PORT, NONCE);
const pending: PendingSignIn = { port: PORT, nonce: NONCE, returnTo: request.returnTo };

/**
 * The response nonce Steam would send for an assertion made at `time`: the RFC 3339 UTC second,
 * then random text.
 *
 * @param time - Unix ms.
 * @returns The response nonce.
 */
function responseNonceAt(time: number): string {
  return `${new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z')}ab12cd`;
}

/** The query parameters of the callback Steam sends for a genuine sign-in, in Steam's order. */
const VALID_PARAMETERS: Readonly<Record<string, string>> = {
  nonce: NONCE,
  'openid.ns': 'http://specs.openid.net/auth/2.0',
  'openid.mode': 'id_res',
  'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
  'openid.claimed_id': CLAIMED_ID,
  'openid.identity': CLAIMED_ID,
  'openid.return_to': request.returnTo,
  'openid.response_nonce': responseNonceAt(NOW),
  'openid.assoc_handle': '1234567890',
  'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
  // Base64 with every character that a query string must encode.
  'openid.sig': 'Zm9v+YmFy/YmF6Cg==',
};

/**
 * Build the callback URL the loopback listener would receive.
 *
 * It starts from the genuine callback of {@link VALID_PARAMETERS}, on the URL the sign-in request
 * asked Steam to return to.
 *
 * @param overrides - Parameters to change; a `null` value removes the parameter.
 * @returns The callback URL.
 */
function callback(overrides: Readonly<Record<string, string | null>> = {}): string {
  const parameters = new Map(Object.entries(VALID_PARAMETERS));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      parameters.delete(key);
    } else {
      parameters.set(key, value);
    }
  }
  const url = new URL(request.returnTo);
  url.search = new URLSearchParams([...parameters]).toString();
  return url.toString();
}

/** Every `openid.*` parameter of the genuine callback. */
const VALID_FIELDS = Object.fromEntries(
  Object.entries(VALID_PARAMETERS).filter(([key]) => key.startsWith('openid.')),
);

describe('buildSignInRequest', () => {
  it('builds the sign-in URL with the exact parameters', () => {
    expect(buildSignInRequest(49152, NONCE)).toEqual({
      loginUrl:
        'https://steamcommunity.com/openid/login?openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&openid.mode=checkid_setup&openid.return_to=http%3A%2F%2F127.0.0.1%3A49152%2Fcallback%3Fnonce%3D0123456789abcdef0123456789abcdef&openid.realm=http%3A%2F%2F127.0.0.1%3A49152&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select',
      returnTo: 'http://127.0.0.1:49152/callback?nonce=0123456789abcdef0123456789abcdef',
      realm: 'http://127.0.0.1:49152',
    });
  });
});

describe('validateCallback', () => {
  it('accepts a valid callback and gives the SteamID64 and every openid field', () => {
    expect(validateCallback(callback(), pending, NOW)).toEqual({
      ok: true,
      steamId64: STEAM_ID64,
      fields: VALID_FIELDS,
    });
  });

  it('keeps the nonce of the URL out of the openid fields', () => {
    const check = validateCallback(callback(), pending, NOW);

    // The callback must be accepted first: on a refusal there are no fields to look at, and the
    // test would pass without having checked anything.
    expect(check.ok).toBe(true);
    expect(check.ok && 'nonce' in check.fields).toBe(false);
  });

  // The URL is the loopback listener's only input: anything that is not the exact callback URL
  // of this sign-in is refused before a single parameter is believed.
  const wrongUrls: readonly { readonly name: string; readonly url: string }[] = [
    { name: 'an empty string', url: '' },
    { name: 'a text that is not a URL', url: 'not a url' },
    {
      name: 'localhost as the host',
      url: callback().replace('http://127.0.0.1:49152/', 'http://localhost:49152/'),
    },
    {
      name: 'another protocol',
      url: callback().replace('http://127.0.0.1:49152/', 'https://127.0.0.1:49152/'),
    },
    {
      name: 'another port',
      url: callback().replace('http://127.0.0.1:49152/', 'http://127.0.0.1:49153/'),
    },
    {
      name: 'the path /cb',
      url: callback().replace('http://127.0.0.1:49152/callback', 'http://127.0.0.1:49152/cb'),
    },
    {
      name: 'the path /callback/',
      url: callback().replace('/callback?', '/callback/?'),
    },
    {
      // The host is still 127.0.0.1, but the URL is not the one the listener was given.
      name: 'a user name and a password before the host',
      url: callback().replace('http://127.0.0.1:49152/', 'http://user:pass@127.0.0.1:49152/'),
    },
    {
      name: 'a user name before the host',
      url: callback().replace('http://127.0.0.1:49152/', 'http://user@127.0.0.1:49152/'),
    },
    {
      name: 'an empty user name and a password before the host',
      url: callback().replace('http://127.0.0.1:49152/', 'http://:pass@127.0.0.1:49152/'),
    },
    {
      name: 'a duplicated openid.claimed_id',
      url: `${callback()}&openid.claimed_id=${encodeURIComponent(CLAIMED_ID)}`,
    },
    {
      // The keys are compared once decoded: `openid%2Emode` is `openid.mode`. A comparison of the
      // raw text would see two different keys and let the second value hide behind the first, so
      // the duplicate must be refused like any other, whichever value it carries.
      name: 'an openid.mode duplicated by a percent-encoded key',
      url: `${callback()}&openid%2Emode=cancel`,
    },
    { name: 'a duplicated nonce', url: `${callback()}&nonce=${NONCE}` },
    { name: 'a missing nonce', url: callback({ nonce: null }) },
  ];

  it.each(wrongUrls)('refuses $name as a url', ({ url }) => {
    expect(validateCallback(url, pending, NOW)).toEqual({ ok: false, refusal: 'url' });
  });

  const refusedCallbacks: readonly {
    readonly name: string;
    readonly refusal: CallbackRefusal;
    readonly url: string;
  }[] = [
    {
      name: 'a nonce differing in its last character',
      refusal: 'nonce',
      url: callback({ nonce: `${NONCE.slice(0, -1)}e` }),
    },
    {
      name: 'a shorter nonce',
      refusal: 'nonce',
      url: callback({ nonce: NONCE.slice(0, -1) }),
    },
    { name: 'an empty nonce', refusal: 'nonce', url: callback({ nonce: '' }) },
    {
      name: 'the mode cancel',
      refusal: 'cancelled_on_steam',
      url: callback({ 'openid.mode': 'cancel' }),
    },
    { name: 'the mode error', refusal: 'steam_error', url: callback({ 'openid.mode': 'error' }) },
    {
      name: 'the mode checkid_setup',
      refusal: 'mode',
      url: callback({ 'openid.mode': 'checkid_setup' }),
    },
    { name: 'a missing mode', refusal: 'mode', url: callback({ 'openid.mode': null }) },
    {
      name: 'the OpenID 1.1 namespace',
      refusal: 'ns',
      url: callback({ 'openid.ns': 'http://specs.openid.net/auth/1.1' }),
    },
    { name: 'a missing namespace', refusal: 'ns', url: callback({ 'openid.ns': null }) },
    {
      name: 'a look-alike endpoint',
      refusal: 'op_endpoint',
      url: callback({ 'openid.op_endpoint': 'https://steamcommunity.com.evil.test/openid/login' }),
    },
    {
      name: 'a return_to on another port',
      refusal: 'return_to',
      url: callback({
        'openid.return_to': `http://127.0.0.1:49153/callback?nonce=${NONCE}`,
      }),
    },
    {
      name: 'a return_to with a different nonce',
      refusal: 'return_to',
      url: callback({ 'openid.return_to': `${request.returnTo.slice(0, -1)}e` }),
    },
    {
      name: 'an identity different from the claimed id',
      refusal: 'claimed_id',
      url: callback({
        'openid.identity': `https://steamcommunity.com/openid/id/${accountIdToSteamId64(testAccountId(2_000_001))}`,
      }),
    },
    {
      name: 'a missing identity',
      refusal: 'claimed_id',
      url: callback({ 'openid.identity': null }),
    },
    {
      name: 'an http:// claimed id',
      refusal: 'claimed_id',
      url: callback({
        'openid.claimed_id': CLAIMED_ID.replace('https://', 'http://'),
        'openid.identity': CLAIMED_ID.replace('https://', 'http://'),
      }),
    },
    {
      name: 'a claimed id on another host',
      refusal: 'claimed_id',
      url: callback({
        'openid.claimed_id': CLAIMED_ID.replace(
          'steamcommunity.com',
          'steamcommunity.com.evil.test',
        ),
        'openid.identity': CLAIMED_ID.replace('steamcommunity.com', 'steamcommunity.com.evil.test'),
      }),
    },
    {
      name: 'a 16-digit claimed id',
      refusal: 'claimed_id',
      url: callback({
        'openid.claimed_id': CLAIMED_ID.slice(0, -1),
        'openid.identity': CLAIMED_ID.slice(0, -1),
      }),
    },
    {
      name: 'a claimed id followed by more text',
      refusal: 'claimed_id',
      url: callback({
        'openid.claimed_id': `${CLAIMED_ID}/extra`,
        'openid.identity': `${CLAIMED_ID}/extra`,
      }),
    },
    {
      name: 'a signed list without assoc_handle',
      refusal: 'signed',
      url: callback({
        'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce',
      }),
    },
    {
      name: 'a signed list whose entry only contains a required name',
      refusal: 'signed',
      url: callback({
        'openid.signed':
          'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,not_assoc_handle',
      }),
    },
    { name: 'a missing signed list', refusal: 'signed', url: callback({ 'openid.signed': null }) },
    {
      name: 'a response nonce 11 minutes old',
      refusal: 'response_nonce',
      url: callback({ 'openid.response_nonce': responseNonceAt(NOW - 11 * MINUTE) }),
    },
    {
      name: 'a response nonce 11 minutes ahead',
      refusal: 'response_nonce',
      url: callback({ 'openid.response_nonce': responseNonceAt(NOW + 11 * MINUTE) }),
    },
    {
      name: 'a response nonce that is not a date',
      refusal: 'response_nonce',
      url: callback({ 'openid.response_nonce': 'garbage' }),
    },
    {
      name: 'a response nonce with an impossible date',
      refusal: 'response_nonce',
      url: callback({ 'openid.response_nonce': '2026-13-45T99:99:99Zab12cd' }),
    },
    {
      name: 'a missing response nonce',
      refusal: 'response_nonce',
      url: callback({ 'openid.response_nonce': null }),
    },
  ];

  it.each(refusedCallbacks)('refuses $name as $refusal', ({ refusal, url }) => {
    expect(validateCallback(url, pending, NOW)).toEqual({ ok: false, refusal });
  });

  it('reports the first failing check only', () => {
    // A wrong nonce wins over a cancelled mode, and a wrong return_to over a wrong claimed id:
    // the checks run in a fixed order and the first failure ends them.
    expect(
      validateCallback(
        callback({ nonce: `${NONCE.slice(0, -1)}e`, 'openid.mode': 'cancel' }),
        pending,
        NOW,
      ),
    ).toEqual({ ok: false, refusal: 'nonce' });
    expect(
      validateCallback(
        callback({
          'openid.return_to': `http://127.0.0.1:49153/callback?nonce=${NONCE}`,
          'openid.identity': 'https://steamcommunity.com/openid/id/1',
        }),
        pending,
        NOW,
      ),
    ).toEqual({ ok: false, refusal: 'return_to' });
  });

  it('accepts a response nonce up to 10 minutes ahead or behind', () => {
    const ahead = callback({ 'openid.response_nonce': responseNonceAt(NOW + 10 * MINUTE) });
    const behind = callback({ 'openid.response_nonce': responseNonceAt(NOW - 10 * MINUTE) });

    expect(validateCallback(ahead, pending, NOW).ok).toBe(true);
    expect(validateCallback(behind, pending, NOW).ok).toBe(true);
  });

  it('compares the response nonce with the clock it is given, not with its own', () => {
    // The same genuine callback, received an hour later by the same listener, is stale.
    expect(validateCallback(callback(), pending, NOW + 60 * MINUTE)).toEqual({
      ok: false,
      refusal: 'response_nonce',
    });
  });

  it('keeps the characters of the signature that a query string encodes', () => {
    const check = validateCallback(callback(), pending, NOW);

    expect(check.ok && check.fields['openid.sig']).toBe('Zm9v+YmFy/YmF6Cg==');
  });
});

describe('buildCheckAuthenticationBody', () => {
  it('posts back every received field with the check_authentication mode', () => {
    const body = buildCheckAuthenticationBody(VALID_FIELDS);
    const posted = new URLSearchParams(body);

    expect(Object.fromEntries(posted)).toEqual({
      ...VALID_FIELDS,
      'openid.mode': 'check_authentication',
    });
    expect(posted.getAll('openid.mode')).toEqual(['check_authentication']);
  });

  it('does not alter the fields it is given', () => {
    const fields = { ...VALID_FIELDS };
    buildCheckAuthenticationBody(fields);

    expect(fields).toEqual(VALID_FIELDS);
  });
});

describe('parseCheckAuthenticationAnswer', () => {
  const NAMESPACE_LINE = 'ns:http://specs.openid.net/auth/2.0';

  it('confirms only an answer with the OpenID namespace and is_valid:true', () => {
    expect(parseCheckAuthenticationAnswer(`${NAMESPACE_LINE}\nis_valid:true\n`)).toBe('valid');
    expect(parseCheckAuthenticationAnswer(`is_valid:true\n${NAMESPACE_LINE}`)).toBe('valid');

    expect(parseCheckAuthenticationAnswer('is_valid:true\n')).toBe('invalid');
    expect(parseCheckAuthenticationAnswer(`${NAMESPACE_LINE}\nis_valid:false\n`)).toBe('invalid');
    expect(parseCheckAuthenticationAnswer(`${NAMESPACE_LINE}\nis_valid:trueish\n`)).toBe('invalid');
    expect(parseCheckAuthenticationAnswer(`<p>${NAMESPACE_LINE} is_valid:true</p>`)).toBe(
      'invalid',
    );
    expect(parseCheckAuthenticationAnswer('')).toBe('invalid');
  });

  it('refuses an answer in which a key appears on more than one line', () => {
    // A contradictory answer is not Steam's: whichever line it believed, it would be guessing.
    expect(
      parseCheckAuthenticationAnswer(`${NAMESPACE_LINE}\nis_valid:false\nis_valid:true\n`),
    ).toBe('invalid');
    expect(
      parseCheckAuthenticationAnswer(`${NAMESPACE_LINE}\nis_valid:true\nis_valid:false\n`),
    ).toBe('invalid');
    expect(
      parseCheckAuthenticationAnswer(`${NAMESPACE_LINE}\nis_valid:true\nis_valid:true\n`),
    ).toBe('invalid');
    expect(
      parseCheckAuthenticationAnswer(`${NAMESPACE_LINE}\n${NAMESPACE_LINE}\nis_valid:true\n`),
    ).toBe('invalid');
    expect(
      parseCheckAuthenticationAnswer(
        `${NAMESPACE_LINE}\nns:http://specs.openid.net/auth/1.1\nis_valid:true\n`,
      ),
    ).toBe('invalid');
    // Any key counts, not only the two that are read.
    expect(
      parseCheckAuthenticationAnswer(`${NAMESPACE_LINE}\nis_valid:true\nextra:1\nextra:2\n`),
    ).toBe('invalid');
  });

  it('refuses a namespace other than OpenID 2.0 and lines that do not end exactly', () => {
    expect(
      parseCheckAuthenticationAnswer('ns:http://specs.openid.net/auth/1.1\nis_valid:true\n'),
    ).toBe('invalid');
    // The answer is split on \n only: a \r stays in the line, which then is not exact.
    expect(parseCheckAuthenticationAnswer(`${NAMESPACE_LINE}\r\nis_valid:true\r\n`)).toBe(
      'invalid',
    );
    expect(parseCheckAuthenticationAnswer(` ${NAMESPACE_LINE}\n is_valid:true\n`)).toBe('invalid');
  });
});

describe('nonceFromBytes', () => {
  it('makes a nonce of 32 lowercase hex characters from 16 bytes', () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 255]);

    expect(nonceFromBytes(bytes)).toBe('000102030405060708090a0b0c0d0eff');
    expect(nonceFromBytes(bytes)).toMatch(/^[0-9a-f]{32}$/);
    expect(() => nonceFromBytes(new Uint8Array(15))).toThrow(Error);
    expect(() => nonceFromBytes(new Uint8Array(17))).toThrow(Error);
  });
});
