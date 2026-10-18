/**
 * The Steam OpenID 2.0 sign-in: the URL the player opens, and the checks that decide whether the
 * callback received on the loopback listener is genuine (ADR 0005,
 * `docs/adr/0005-steam-openid-linking.md`).
 *
 * The app never sees a Steam password: the player signs in on Steam's own page, in the system
 * browser, and Steam sends the browser back to a one-shot listener on `127.0.0.1`. Any local
 * process can reach that port, so the listener is not trusted: a callback proves nothing until it
 * passes {@link validateCallback} *and* Steam itself confirms it (`check_authentication`, built
 * with {@link buildCheckAuthenticationBody} and read with {@link parseCheckAuthenticationAnswer}).
 *
 * Everything here is pure: the clock and the random bytes come from the caller, and the HTTP
 * request that asks Steam to confirm the assertion is the service's.
 *
 * @packageDocumentation
 */

/**
 * Steam's OpenID endpoint, hard-coded. The player's browser is sent to it, and the
 * `check_authentication` request is POSTed to it: never to a URL taken from the callback (see the
 * `op_endpoint` check of {@link validateCallback}).
 */
export const STEAM_OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';

/** The OpenID 2.0 namespace: the value of `openid.ns`, and of the `ns` line of Steam's answer. */
export const OPENID_NS = 'http://specs.openid.net/auth/2.0';

/**
 * The OpenID 2.0 value that asks the provider to choose the identity: the app does not know the
 * player's SteamID64 yet, Steam tells it once the player has signed in.
 */
export const OPENID_IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';

/**
 * The fields Steam must have signed. The `openid.signed` list names the fields that `openid.sig`
 * covers; an assertion whose signature leaves out one of these could be edited without Steam
 * noticing, so {@link validateCallback} refuses it. The `signed` entry itself is not in the list:
 * OpenID makes it implicit.
 */
export const REQUIRED_SIGNED_FIELDS = [
  'op_endpoint',
  'claimed_id',
  'identity',
  'return_to',
  'response_nonce',
  'assoc_handle',
] as const;

/** The sign-in is abandoned after this delay, in milliseconds, when Steam sends nobody back. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/**
 * How far from the clock of the PC the time in `openid.response_nonce` may be, in milliseconds,
 * either way. It absorbs a PC clock that is a few minutes off without accepting an old assertion.
 */
export const RESPONSE_NONCE_TOLERANCE_MS = 10 * 60_000;

/**
 * Largest `check_authentication` answer read, in bytes. Steam's answer is two short lines: a
 * longer body is not Steam's.
 */
export const CHECK_AUTHENTICATION_MAX_BYTES = 16 * 1024;

/** Number of random bytes of the nonce (128 bits), which {@link nonceFromBytes} turns into hex. */
export const NONCE_BYTES = 16;

/** Where the player's browser comes back to: the only path the callback may use. */
const CALLBACK_PATH = '/callback';

/** The only host the callback may use: the loopback address, never a name that could resolve elsewhere. */
const LOOPBACK_HOST = '127.0.0.1';

/**
 * The claimed id of an individual Steam account: a fixed URL ending in the 17 digits of its
 * SteamID64, and nothing else. The digits are captured; the service converts them to an account id.
 */
const CLAIMED_ID_PATTERN = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

/**
 * The start of `openid.response_nonce`: an RFC 3339 UTC second, followed by random text. The
 * random text is ignored; the second is what the freshness check reads.
 */
const RESPONSE_NONCE_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/;

/** The OpenID mode of the request that asks Steam to confirm an assertion. */
const CHECK_AUTHENTICATION_MODE = 'check_authentication';

/** What {@link buildSignInRequest} gives the service. */
export interface SignInRequest {
  /** The Steam page the system browser opens. It carries the nonce: it is never logged. */
  readonly loginUrl: string;
  /**
   * Where Steam sends the browser back to, nonce included. The callback must repeat it byte for
   * byte. It is never logged.
   */
  readonly returnTo: string;
  /** The site Steam shows on its consent page: the loopback origin of the listener. */
  readonly realm: string;
}

/** The sign-in in progress, as {@link validateCallback} needs to know it. */
export interface PendingSignIn {
  /** The port of the loopback listener. */
  readonly port: number;
  /** The nonce of this sign-in, as made by {@link nonceFromBytes}. */
  readonly nonce: string;
  /** The `returnTo` of this sign-in's {@link SignInRequest}. */
  readonly returnTo: string;
}

/**
 * Why a callback was refused, named after the check that failed. It is the only thing a refusal
 * carries (and the only thing that may be logged): it holds no part of the callback.
 *
 * - `url`: the URL is not exactly this sign-in's callback URL, or a key appears twice;
 * - `nonce`: the nonce is not this sign-in's;
 * - `cancelled_on_steam`: the player cancelled on Steam's page (`openid.mode=cancel`);
 * - `steam_error`: Steam reported an error (`openid.mode=error`);
 * - `mode`: any other mode than a positive assertion;
 * - `ns`, `op_endpoint`, `return_to`: the field is not the expected value;
 * - `claimed_id`: the claimed id is not the identity, or not a Steam individual account;
 * - `signed`: Steam did not sign every field that must be signed;
 * - `response_nonce`: the assertion's time cannot be read, or is too far from now.
 */
export type CallbackRefusal =
  | 'url'
  | 'nonce'
  | 'cancelled_on_steam'
  | 'steam_error'
  | 'mode'
  | 'ns'
  | 'op_endpoint'
  | 'return_to'
  | 'claimed_id'
  | 'signed'
  | 'response_nonce';

/** The result of {@link validateCallback}. */
export type CallbackCheck =
  | {
      readonly ok: true;
      /**
       * Every `openid.*` parameter received, as Steam sent them: what Steam is asked to confirm.
       * The nonce of the URL is not one of them.
       */
      readonly fields: Readonly<Record<string, string>>;
      /** The 17 digits of the player's SteamID64. It is never logged. */
      readonly steamId64: string;
    }
  | { readonly ok: false; readonly refusal: CallbackRefusal };

/**
 * Turn random bytes into the nonce of a sign-in.
 *
 * The nonce is the anti-forgery value of the flow: OpenID 2.0 has no `state` parameter, so it
 * travels in the query string of `return_to`, which Steam echoes back. The bytes come from the
 * caller because `core` draws no randomness.
 *
 * @param bytes - Exactly {@link NONCE_BYTES} random bytes.
 * @returns The nonce: 32 lowercase hexadecimal characters.
 * @throws Error when `bytes` does not hold exactly {@link NONCE_BYTES} bytes: a nonce of another
 *   strength would silently weaken the sign-in, so it is a programming error, not a result.
 */
export function nonceFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== NONCE_BYTES) {
    throw new Error(`A sign-in nonce is made from exactly ${String(NONCE_BYTES)} random bytes`);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Build the URL to open in the system browser, and the `return_to` and `realm` it carries.
 *
 * Steam accepts the loopback address as a realm (checked live): its consent page then names the
 * site "127.0.0.1". `identifier_select` leaves Steam to say who the player is.
 *
 * @param port - The port of the loopback listener.
 * @param nonce - The nonce of this sign-in, from {@link nonceFromBytes}: it is put in the URL as
 *   is, so it must hold hexadecimal characters only.
 * @returns The login URL, the `return_to` and the realm.
 */
export function buildSignInRequest(port: number, nonce: string): SignInRequest {
  const realm = `http://${LOOPBACK_HOST}:${String(port)}`;
  const returnTo = `${realm}${CALLBACK_PATH}?nonce=${nonce}`;
  const query = new URLSearchParams([
    ['openid.ns', OPENID_NS],
    ['openid.mode', 'checkid_setup'],
    ['openid.return_to', returnTo],
    ['openid.realm', realm],
    ['openid.identity', OPENID_IDENTIFIER_SELECT],
    ['openid.claimed_id', OPENID_IDENTIFIER_SELECT],
  ]);
  return { loginUrl: `${STEAM_OPENID_ENDPOINT}?${query.toString()}`, returnTo, realm };
}

/**
 * Compare two texts without stopping at the first difference, so the time it takes does not tell
 * a local process how many leading characters of a guess were right. The lengths are not secret
 * (a nonce always has the same length), so they are compared first.
 *
 * @param received - The text received.
 * @param expected - The text it must equal.
 * @returns Whether the two texts are equal.
 */
function constantTimeEquals(received: string, expected: string): boolean {
  if (received.length !== expected.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= received.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Read the query of a callback URL, if the URL is exactly this sign-in's callback URL.
 *
 * Only the `nonce` and the `openid.*` parameters are kept; the others (a cache buster the browser
 * may add, for example) are of no use and ignored. A key that appears twice is refused instead of
 * resolved to its first or last value: the parsers of other layers do not agree on which one wins,
 * and a duplicate is how an attacker would try to show one value to a check and another to Steam.
 *
 * @param rawUrl - The URL the listener received.
 * @param port - The port of the loopback listener.
 * @returns The nonce and the `openid.*` parameters in the order received, or `null` when the URL
 *   is not acceptable.
 */
function readCallbackQuery(
  rawUrl: string,
  port: number,
): { readonly nonce: string; readonly fields: Record<string, string> } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  // `URL.port` is empty for the default port of the scheme (80), which the listener never uses,
  // so the comparison with `String(port)` is exact. The browser never sends a user name or a
  // password in a redirect to the callback URL, so their presence marks a URL that did not come
  // from the return trip; it is refused even though the host would still be the loopback one.
  if (
    url.protocol !== 'http:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hostname !== LOOPBACK_HOST ||
    url.port !== String(port) ||
    url.pathname !== CALLBACK_PATH
  ) {
    return null;
  }
  const values = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (key !== 'nonce' && !key.startsWith('openid.')) {
      continue;
    }
    if (values.has(key)) {
      return null;
    }
    values.set(key, value);
  }
  const nonce = values.get('nonce');
  if (nonce === undefined) {
    return null;
  }
  values.delete('nonce');
  return { nonce, fields: Object.fromEntries(values) };
}

/**
 * Whether an `openid.response_nonce` is recent: its leading RFC 3339 UTC second is within
 * {@link RESPONSE_NONCE_TOLERANCE_MS} of `now`, either way.
 *
 * @param responseNonce - The value of `openid.response_nonce`.
 * @param now - Current time, Unix ms.
 * @returns Whether the time can be read and is close enough to `now`.
 */
function isRecentResponseNonce(responseNonce: string, now: number): boolean {
  const time = RESPONSE_NONCE_TIME_PATTERN.exec(responseNonce)?.[1];
  if (time === undefined) {
    return false;
  }
  const issuedAt = Date.parse(time);
  // `Date.parse` gives NaN for a date that does not exist, and a comparison with NaN is false.
  return Math.abs(issuedAt - now) <= RESPONSE_NONCE_TOLERANCE_MS;
}

/**
 * Decide whether a callback received on the loopback listener may be sent to Steam for
 * confirmation (ADR 0005). It does not prove the sign-in: only Steam's answer to
 * `check_authentication` does. It only keeps stray, forged and replayed requests from reaching
 * Steam, and never throws on any input.
 *
 * The checks run in this order and the first failure wins, so a refusal always names the earliest
 * check the callback fails:
 *
 * 1. `url`: the URL parses, uses `http` without a user name or a password, the host `127.0.0.1`,
 *    the port of the listener and the path `/callback`, and `nonce` and every `openid.*` key
 *    appear exactly once;
 * 2. `nonce`: the nonce is this sign-in's, compared in constant time;
 * 3. `openid.mode`: `id_res`, a positive assertion (`cancel` and `error` are told apart from the
 *    other modes, since the first is the player's choice and the second Steam's failure);
 * 4. `ns`: `openid.ns` is the OpenID 2.0 namespace;
 * 5. `op_endpoint`: `openid.op_endpoint` is Steam's endpoint;
 * 6. `return_to`: `openid.return_to` is the URL this sign-in sent, byte for byte;
 * 7. `claimed_id`: `openid.claimed_id` is `openid.identity` and the URL of an individual Steam
 *    account, whose 17 digits are the SteamID64;
 * 8. `signed`: Steam signed every field of {@link REQUIRED_SIGNED_FIELDS};
 * 9. `response_nonce`: the assertion was made within {@link RESPONSE_NONCE_TOLERANCE_MS} of `now`.
 *
 * A callback that passes is still unproven until Steam confirms it, once: OpenID 2.0 lets Steam
 * confirm an assertion a single time, which defeats a replay of a captured one.
 *
 * @param url - The full URL of the callback, as the listener received it.
 * @param pending - The sign-in in progress.
 * @param now - Current time, Unix ms.
 * @returns The `openid.*` fields and the SteamID64, or the check that failed.
 */
export function validateCallback(url: string, pending: PendingSignIn, now: number): CallbackCheck {
  // Check 1: the URL.
  const query = readCallbackQuery(url, pending.port);
  if (query === null) {
    return { ok: false, refusal: 'url' };
  }
  const { fields } = query;

  // Check 2: the nonce, the anti-forgery value that only the real return trip carries back.
  if (!constantTimeEquals(query.nonce, pending.nonce)) {
    return { ok: false, refusal: 'nonce' };
  }

  // Check 3: the mode. A missing mode is neither of the two named ones.
  const mode = fields['openid.mode'];
  if (mode === 'cancel') {
    return { ok: false, refusal: 'cancelled_on_steam' };
  }
  if (mode === 'error') {
    return { ok: false, refusal: 'steam_error' };
  }
  if (mode !== 'id_res') {
    return { ok: false, refusal: 'mode' };
  }

  // Check 4: the namespace.
  if (fields['openid.ns'] !== OPENID_NS) {
    return { ok: false, refusal: 'ns' };
  }

  // Check 5: the endpoint that issued the assertion.
  //
  // Only the equality is checked here, and the value is never used afterwards: Steam is asked to
  // confirm at the constant STEAM_OPENID_ENDPOINT. Posting `check_authentication` to the
  // `op_endpoint` of the callback is the flaw of GHSA-hhw9-35p2-q2c5: whoever forges a callback
  // names their own server as the endpoint, and it answers `is_valid:true` to its own forgery.
  if (fields['openid.op_endpoint'] !== STEAM_OPENID_ENDPOINT) {
    return { ok: false, refusal: 'op_endpoint' };
  }

  // Check 6: Steam sends the browser back to exactly where this sign-in asked, nonce included.
  if (fields['openid.return_to'] !== pending.returnTo) {
    return { ok: false, refusal: 'return_to' };
  }

  // Check 7: who signed in. With identifier_select, Steam answers with the same URL twice.
  const claimedId = fields['openid.claimed_id'];
  const steamId64 =
    claimedId === undefined || claimedId !== fields['openid.identity']
      ? undefined
      : CLAIMED_ID_PATTERN.exec(claimedId)?.[1];
  if (steamId64 === undefined) {
    return { ok: false, refusal: 'claimed_id' };
  }

  // Check 8: the signature must cover the fields that matter. Steam itself verifies the signature
  // during `check_authentication`; this only refuses an assertion that left them out of it.
  const signed = (fields['openid.signed'] ?? '').split(',');
  if (!REQUIRED_SIGNED_FIELDS.every((field) => signed.includes(field))) {
    return { ok: false, refusal: 'signed' };
  }

  // Check 9: the assertion is recent, which limits how long a captured callback stays useful.
  if (!isRecentResponseNonce(fields['openid.response_nonce'] ?? '', now)) {
    return { ok: false, refusal: 'response_nonce' };
  }

  return { ok: true, fields, steamId64 };
}

/**
 * Build the body of the request that asks Steam to confirm an assertion (`check_authentication`,
 * OpenID 2.0 section 11.4.2): every field of the assertion sent back as received, with the mode
 * changed. Steam recomputes the signature over them, which is the proof the callback is its own.
 *
 * The body carries the player's SteamID64 and the assertion: it is never logged.
 *
 * @param fields - The `openid.*` fields of a callback that {@link validateCallback} accepted.
 * @returns The body, URL-encoded (`application/x-www-form-urlencoded`).
 */
export function buildCheckAuthenticationBody(fields: Readonly<Record<string, string>>): string {
  const body = new URLSearchParams(Object.entries(fields));
  // `set` replaces the mode where it is; it only adds it if the fields hold none.
  body.set('openid.mode', CHECK_AUTHENTICATION_MODE);
  return body.toString();
}

/**
 * Read Steam's answer to `check_authentication`.
 *
 * The answer is OpenID's key-value form: `key:value` lines separated by `\n`, here
 * `ns:http://specs.openid.net/auth/2.0` and `is_valid:true`. It is read line by line and never
 * searched as a text, so a page that merely contains those words (an error page, a proxy's
 * answer) is not taken for Steam's confirmation. Each line is split at its first colon, since the
 * namespace value holds colons itself. A line that does not end exactly (a `\r`, a space) does not
 * match.
 *
 * A key that appears on more than one line, whatever its values, makes the whole answer `invalid`:
 * Steam writes each key once, so a contradictory answer (`is_valid:false` then `is_valid:true`) is
 * not Steam's, and believing either line would be a guess. A line without a colon (the empty one
 * after the last `\n`) carries no key and is ignored.
 *
 * @param text - The body of the answer.
 * @returns `valid` when the answer holds the OpenID namespace and `is_valid:true`, each key once,
 *   else `invalid`.
 */
export function parseCheckAuthenticationAnswer(text: string): 'valid' | 'invalid' {
  const pairs = text.split('\n').flatMap((line) => {
    const colon = line.indexOf(':');
    return colon === -1 ? [] : [[line.slice(0, colon), line.slice(colon + 1)] as const];
  });
  if (new Set(pairs.map(([key]) => key)).size !== pairs.length) {
    return 'invalid';
  }
  const has = (key: string, value: string): boolean =>
    pairs.some(([pairKey, pairValue]) => pairKey === key && pairValue === value);
  return has('ns', OPENID_NS) && has('is_valid', 'true') ? 'valid' : 'invalid';
}
