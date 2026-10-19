/**
 * Tests of the Steam sign-in service, with the fixture gateway (the loopback listener and the
 * browser), the fixture HTTP client (Steam's `check_authentication`) and a fixed clock.
 *
 * The fixture gateway does not answer by itself: each test plays the part of the browser and
 * delivers the callback it wants, genuine, forged or unreadable. The timers are faked, since the
 * service runs a five-minute timer, and every test checks on its way out that no timer is left and
 * that nothing private was logged.
 *
 * @packageDocumentation
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFixtureApi,
  FixtureHttpClient,
  type FixtureHandler,
  type FixtureResponse,
} from '../adapters/dev/fixture-http-client.adapter';
import {
  FIXTURE_LOOPBACK_PORT,
  FixtureSignInGateway,
} from '../adapters/dev/fixture-sign-in-gateway.adapter';
import { FIXTURE_ACCOUNT_ID } from '../adapters/dev/fixtures/match-history.fixture';
import { createSteamCallbackUrl, FIXTURE_STEAM_ID64 } from '../adapters/dev/fixtures/steam.fixture';
import { MemoryLogger } from '../adapters/dev/memory-logger.adapter';
import { REQUEST_TIMEOUT_MS, userAgent } from '../core/deadlock-api/endpoints';
import { AppError, type AppErrorKind } from '../core/errors/app-error';
import { CALLBACK_PAGE_HTML } from '../core/steam/callback-page';
import {
  CHECK_AUTHENTICATION_MAX_BYTES,
  NONCE_BYTES,
  nonceFromBytes,
  OPENID_NS,
  SIGN_IN_TIMEOUT_MS,
  STEAM_OPENID_ENDPOINT,
  type CallbackRefusal,
} from '../core/steam/steam-openid';
import { SteamSignInService } from './steam-sign-in.service';

const MINUTE = 60_000;

/** The time of the tests (Unix ms): the moment Steam dates its assertions. */
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);

const APP_VERSION = '0.1.0';

/**
 * The random bytes of every sign-in, fixed so the nonce is known. A fixed nonce also lets a test
 * replay a captured callback on a second sign-in, which then accepts it as far as the core can tell.
 */
const FIXED_BYTES = new Uint8Array(NONCE_BYTES).fill(0xab);
const NONCE = nonceFromBytes(FIXED_BYTES);

/** Steam's answer to a `check_authentication` it confirms. */
const VALID_ANSWER = `ns:${OPENID_NS}\nis_valid:true\n`;

/** Steam's answer to a `check_authentication` it does not confirm. */
const INVALID_ANSWER = `ns:${OPENID_NS}\nis_valid:false\n`;

/**
 * Text that stands for the message of a plugin error, which may quote a URL. The tests throw errors
 * that carry it, and check that it never reaches a log.
 */
const LEAK_MARKER = 'leaked-error-message';

/** A plugin error whose message quotes the callback URL, as a real one may. */
function leakyError(): Error {
  return new Error(
    `${LEAK_MARKER} http://127.0.0.1:${String(FIXTURE_LOOPBACK_PORT)}/callback?nonce=${NONCE}`,
  );
}

/**
 * {@link FixtureSignInGateway} that also watches, and can disturb, the subscription to the
 * callbacks: how many times it was removed, whether removing it fails, and whether the listener
 * keeps hearing callbacks after it was removed (the real removal completes later).
 */
class ObservedGateway extends FixtureSignInGateway {
  /** How many times the function returned by `onCallback` was called. */
  unsubscribeCalls = 0;
  /** When set, the function returned by `onCallback` throws it. */
  unsubscribeError: Error | null = null;
  /** When set, the function returned by `onCallback` does not stop the listener from hearing. */
  lingeringListeners = false;

  override async onCallback(listener: (url: string) => void): Promise<() => void> {
    const stop = await super.onCallback(listener);
    return () => {
      this.unsubscribeCalls += 1;
      if (!this.lingeringListeners) {
        stop();
      }
      if (this.unsubscribeError !== null) {
        throw this.unsubscribeError;
      }
    };
  }
}

/** Every logger of the test in progress, so the privacy check can read them on the way out. */
const loggers: MemoryLogger[] = [];

/** How a test changes the genuine callback the browser would bring back. */
interface CallbackChanges {
  /** Parameters to replace (a string) or remove (`null`), by their full name. */
  readonly overrides?: Readonly<Record<string, string | null>>;
  /** Changes the callback URL as a whole, for what the parameters cannot express. */
  readonly rewrite?: (url: string) => string;
}

/** What {@link setUp} can change. */
interface SetUpOptions {
  /** Answers the requests to Steam; the fixture API by default. */
  readonly handler?: FixtureHandler;
  /** Source of the nonce's bytes; {@link FIXED_BYTES} by default. */
  readonly randomBytes?: (length: number) => Uint8Array;
}

/**
 * Build the service on fixtures, with a clock the test can move.
 *
 * @param options - See {@link SetUpOptions}.
 * @returns The service and its parts, the clock, `flush` (let the sign-in run until it waits for
 *   Steam) and `answer` (play the browser coming back, once the login page was opened).
 */
function setUp(options: SetUpOptions = {}) {
  const clock = { now: NOW };
  const gateway = new ObservedGateway({ autoAnswer: false, now: () => clock.now });
  const http = new FixtureHttpClient(
    options.handler ?? createFixtureApi({ now: NOW, matchCount: 1 }),
  );
  const logger = new MemoryLogger();
  loggers.push(logger);
  const service = new SteamSignInService({
    gateway,
    http,
    logger,
    appVersion: APP_VERSION,
    now: () => clock.now,
    ...(options.randomBytes === undefined
      ? { randomBytes: () => FIXED_BYTES }
      : { randomBytes: options.randomBytes }),
  });

  /** Run the pending promises: the listener is up, the browser is open. */
  const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };

  /** Deliver the callback the browser brings back to the first login page opened. */
  const answer = (changes: CallbackChanges = {}): string => {
    const loginUrl = gateway.openedUrls[0];
    if (loginUrl === undefined) {
      throw new Error('The browser was not opened yet');
    }
    const genuine = createSteamCallbackUrl(loginUrl, {
      steamId64: FIXTURE_STEAM_ID64,
      now: NOW,
      ...(changes.overrides === undefined ? {} : { overrides: changes.overrides }),
    });
    const callback = changes.rewrite === undefined ? genuine : changes.rewrite(genuine);
    gateway.deliver(callback);
    return callback;
  };

  return { service, gateway, http, logger, clock, flush, answer };
}

/** The log lines of a logger, without their scope (checked on its own). */
function logged(logger: MemoryLogger) {
  return logger.entries.map(({ level, message, context }) => ({ level, message, context }));
}

const STARTED = { level: 'info', message: 'Steam sign-in started', context: {} } as const;
const CONFIRMED = { level: 'info', message: 'Steam sign-in confirmed', context: {} } as const;

/**
 * The log line of a refusal: the name of the check, and the HTTP status of Steam's answer for a
 * refusal that comes from it (a refusal of the callback itself has none).
 */
function refusedLine(check: string, status?: number) {
  return {
    level: 'warn',
    message: 'Steam sign-in refused',
    context: status === undefined ? { check } : { check, status },
  } as const;
}

/** The log line of a sign-in cancelled by someone. */
function cancelledLine(by: 'user' | 'steam' | 'timeout') {
  return { level: 'info', message: 'Steam sign-in cancelled', context: { by } } as const;
}

/** A handler that answers every request with the same response. */
function answering(status: number, body: string, headers: Record<string, string> = {}) {
  return (): FixtureResponse => ({ status, headers, body });
}

/** A handler that fails every request the way a transport does. */
function failing(error: Error): FixtureHandler {
  return () => {
    throw error;
  };
}

/** Read the nonce out of a login URL, from the `nonce` of its `return_to`. */
function nonceOf(loginUrl: string): string | null {
  const returnTo = new URL(loginUrl).searchParams.get('openid.return_to');
  return returnTo === null ? null : new URL(returnTo).searchParams.get('nonce');
}

/**
 * Check that nothing private reached the logs of a test: not the SteamID64, the nonce, the message
 * of a plugin error, the address of the listener or any URL of Steam's.
 */
function expectNothingPrivateLogged(logger: MemoryLogger): void {
  const text = JSON.stringify(logger.entries);
  for (const secret of [
    FIXTURE_STEAM_ID64,
    NONCE,
    LEAK_MARKER,
    '127.0.0.1',
    'steamcommunity.com',
    'openid',
  ]) {
    expect(text).not.toContain(secret);
  }
  expect(logger.entries.every((entry) => entry.scope === 'steam')).toBe(true);
}

/** One way a sign-in can end, for the check that no ending logs anything private. */
interface PrivacyScenario {
  readonly options?: SetUpOptions;
  /** Disturbs the fixtures before the sign-in starts. */
  readonly prepare?: (context: ReturnType<typeof setUp>) => void;
  /** What happens once the browser is open; the scenario ends when the sign-in does. */
  readonly act: (context: ReturnType<typeof setUp>) => unknown;
}

/**
 * Every way a sign-in can end, including the failures whose messages quote the callback URL: the
 * message of such an error must never reach a log.
 */
const PRIVACY_SCENARIOS: readonly PrivacyScenario[] = [
  { act: ({ answer }) => answer() },
  { act: ({ answer }) => answer({ overrides: { nonce: 'f'.repeat(32) } }) },
  { act: ({ answer }) => answer({ overrides: { 'openid.mode': 'cancel' } }) },
  { options: { handler: answering(200, INVALID_ANSWER) }, act: ({ answer }) => answer() },
  { options: { handler: answering(503, '') }, act: ({ answer }) => answer() },
  { options: { handler: failing(leakyError()) }, act: ({ answer }) => answer() },
  {
    prepare: ({ gateway }) => {
      gateway.failNextOpen(leakyError());
    },
    act: () => undefined,
  },
  {
    prepare: ({ gateway }) => {
      gateway.failNextStart(leakyError());
    },
    act: () => undefined,
  },
  {
    act: ({ service }) => {
      service.cancel();
    },
  },
  { act: () => vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS) },
];

describe('SteamSignInService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    try {
      // Whatever the test did, the sign-in left no timer behind, and logged nothing private.
      expect(vi.getTimerCount()).toBe(0);
      for (const logger of loggers) {
        expectNothingPrivateLogged(logger);
      }
    } finally {
      // A failed assertion above must not leave fake timers or loggers to the next test.
      loggers.length = 0;
      vi.useRealTimers();
    }
  });

  describe('a genuine sign-in', () => {
    it('signs in with a callback that Steam confirms', async () => {
      const { service, gateway, http, logger, flush, answer } = setUp();

      const signIn = service.signIn();
      expect(service.isPending()).toBe(true);
      await flush();
      const callback = answer();

      await expect(signIn).resolves.toEqual({ kind: 'signed_in', accountId: FIXTURE_ACCOUNT_ID });
      expect(service.isPending()).toBe(false);
      expect(gateway.lastCallbackPage).toBe(CALLBACK_PAGE_HTML);
      // The listener ends by itself after a callback: it is neither stopped nor left subscribed.
      expect(gateway.cancelledPorts).toEqual([]);
      expect(gateway.unsubscribeCalls).toBe(1);
      expect(logged(logger)).toEqual([STARTED, CONFIRMED]);

      // Exactly one request, to Steam's endpoint as hard-coded, with the app's rules.
      expect(http.requests).toHaveLength(1);
      const [request] = http.requests;
      expect(request).toMatchObject({
        method: 'POST',
        url: STEAM_OPENID_ENDPOINT,
        headers: { 'User-Agent': userAgent(APP_VERSION) },
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBodyBytes: CHECK_AUTHENTICATION_MAX_BYTES,
      });
      // Every `openid.*` field received comes back as it was, with the mode changed: and nothing
      // else (the nonce is the app's, not Steam's).
      const received = [...new URL(callback).searchParams].filter(([key]) =>
        key.startsWith('openid.'),
      );
      expect(Object.fromEntries(new URLSearchParams(request?.form))).toEqual({
        ...Object.fromEntries(received),
        'openid.mode': 'check_authentication',
      });
    });

    it('draws a fresh nonce from the system by default', async () => {
      const gateway = new FixtureSignInGateway({ autoAnswer: false });
      const logger = new MemoryLogger();
      loggers.push(logger);
      const http = new FixtureHttpClient(createFixtureApi({ now: NOW, matchCount: 1 }));
      const service = new SteamSignInService({ gateway, http, logger, appVersion: APP_VERSION });

      const first = service.signIn();
      await vi.advanceTimersByTimeAsync(0);
      service.cancel();
      const second = service.signIn();
      await vi.advanceTimersByTimeAsync(0);
      service.cancel();
      await Promise.all([first, second]);

      const nonces = gateway.openedUrls.map(nonceOf);
      expect(nonces).toHaveLength(2);
      expect(nonces[0]).toMatch(/^[0-9a-f]{32}$/);
      expect(nonces[1]).toMatch(/^[0-9a-f]{32}$/);
      expect(nonces[0]).not.toBe(nonces[1]);
    });

    it('allows a new sign-in once the previous one ended', async () => {
      const { service, gateway, flush, answer } = setUp();
      const start = vi.spyOn(gateway, 'start');

      const first = service.signIn();
      await flush();
      service.cancel();
      await expect(first).resolves.toEqual({ kind: 'cancelled' });

      const second = service.signIn();
      await flush();
      answer();

      await expect(second).resolves.toEqual({ kind: 'signed_in', accountId: FIXTURE_ACCOUNT_ID });
      expect(start).toHaveBeenCalledTimes(2);
    });

    it('returns the pending sign-in to a second call', async () => {
      const { service, gateway, flush } = setUp();
      const start = vi.spyOn(gateway, 'start');

      const first = service.signIn();
      const second = service.signIn();
      await flush();
      const third = service.signIn();

      // Clicking "Link" again opens no second tab: the same promise, one listener, one browser.
      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(start).toHaveBeenCalledTimes(1);
      expect(gateway.openedUrls).toHaveLength(1);

      service.cancel();
      await expect(first).resolves.toEqual({ kind: 'cancelled' });
    });

    it('reads the clock when the callback arrives', async () => {
      const { service, clock, flush, answer, logger } = setUp();

      const signIn = service.signIn();
      await flush();
      // The assertion was made at NOW; by the time the callback arrives, the clock of the PC has
      // moved past the tolerance. A clock read at the start of the sign-in would still accept it.
      clock.now = NOW + 11 * MINUTE;
      answer();

      await expect(signIn).resolves.toEqual({ kind: 'refused' });
      expect(logged(logger)).toEqual([STARTED, refusedLine('response_nonce')]);
    });
  });

  describe('a callback that is not accepted', () => {
    /** How to forge a callback that fails each check, except the one that is not a failure. */
    const FORGERIES: Record<Exclude<CallbackRefusal, 'cancelled_on_steam'>, CallbackChanges> = {
      // Another port than the listener's.
      url: { rewrite: (url) => url.replace('127.0.0.1:49152', '127.0.0.1:49153') },
      nonce: { overrides: { nonce: 'f'.repeat(32) } },
      steam_error: { overrides: { 'openid.mode': 'error' } },
      mode: { overrides: { 'openid.mode': 'setup_needed' } },
      ns: { overrides: { 'openid.ns': 'http://specs.openid.net/auth/1.1' } },
      op_endpoint: { overrides: { 'openid.op_endpoint': 'https://example.com/openid/login' } },
      return_to: {
        overrides: {
          'openid.return_to': `http://127.0.0.1:49152/callback?nonce=${'cd'.repeat(16)}`,
        },
      },
      // Not the identity, and a different player's.
      claimed_id: {
        overrides: {
          'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561197961265730',
        },
      },
      signed: { overrides: { 'openid.signed': 'signed,op_endpoint,claimed_id' } },
      response_nonce: { overrides: { 'openid.response_nonce': '2020-01-01T00:00:00Zabc' } },
    };

    it.each(Object.entries(FORGERIES))(
      'refuses a callback that fails the %s check, without asking Steam',
      async (check, changes) => {
        const { service, gateway, http, logger, flush, answer } = setUp();

        const signIn = service.signIn();
        await flush();
        answer(changes);

        await expect(signIn).resolves.toEqual({ kind: 'refused' });
        expect(service.isPending()).toBe(false);
        // The log carries the name of the check and nothing of the callback.
        expect(logged(logger)).toEqual([STARTED, refusedLine(check)]);
        expect(http.requests).toEqual([]);
        // The listener ended by itself after the callback.
        expect(gateway.cancelledPorts).toEqual([]);
      },
    );

    it('says when the sign-in is cancelled on Steam', async () => {
      const { service, http, logger, flush, answer } = setUp();

      const signIn = service.signIn();
      await flush();
      answer({ overrides: { 'openid.mode': 'cancel' } });

      await expect(signIn).resolves.toEqual({ kind: 'cancelled_on_steam' });
      expect(logged(logger)).toEqual([STARTED, cancelledLine('steam')]);
      expect(http.requests).toEqual([]);
    });

    it.each([
      ['an empty text', ''],
      ['a text that is not a URL', 'not a url'],
    ])('refuses a callback whose URL cannot be read (%s)', async (_description, url) => {
      const { service, gateway, http, logger, flush } = setUp();

      const signIn = service.signIn();
      await flush();
      gateway.deliver(url);

      await expect(signIn).resolves.toEqual({ kind: 'refused' });
      expect(logged(logger)).toEqual([STARTED, refusedLine('url')]);
      expect(http.requests).toEqual([]);
    });

    it.each([
      ['removed at once', false],
      ['still heard', true],
    ])(
      'ends at the first callback: a later one is ignored (subscription %s)',
      async (_description, lingering) => {
        const { service, gateway, http, logger, flush, answer } = setUp();
        gateway.lingeringListeners = lingering;

        const signIn = service.signIn();
        await flush();
        // A wrong callback first (a local process), then the genuine one: the first one decides.
        answer({ overrides: { nonce: 'f'.repeat(32) } });
        answer();
        answer();

        await expect(signIn).resolves.toEqual({ kind: 'refused' });
        await flush();
        expect(logged(logger)).toEqual([STARTED, refusedLine('nonce')]);
        expect(http.requests).toEqual([]);
      },
    );

    it.each([
      ['removed at once', false],
      ['still heard', true],
    ])(
      'asks Steam once when the genuine callback comes twice (subscription %s)',
      async (_description, lingering) => {
        const { service, gateway, http, logger, flush, answer } = setUp();
        gateway.lingeringListeners = lingering;

        const signIn = service.signIn();
        await flush();
        // The second delivery happens while Steam is still being asked about the first.
        const callback = answer();
        gateway.deliver(callback);

        await expect(signIn).resolves.toEqual({
          kind: 'signed_in',
          accountId: FIXTURE_ACCOUNT_ID,
        });
        expect(http.requests).toHaveLength(1);
        expect(logged(logger)).toEqual([STARTED, CONFIRMED]);
      },
    );

    it('refuses a callback heard while the listener is starting, and stops that listener', async () => {
      let reportPort: () => void = () => undefined;
      const portReported = new Promise<void>((resolve) => {
        reportPort = resolve;
      });
      const { service, gateway, http, logger, flush } = setUp();
      // The listener is started, but its port is not reported yet: the window the test is about.
      const startListener = gateway.start.bind(gateway);
      vi.spyOn(gateway, 'start').mockImplementationOnce(async (page) => {
        const listener = await startListener(page);
        await portReported;
        return listener;
      });

      const signIn = service.signIn();
      await flush();
      expect(gateway.lastCallbackPage).toBe(CALLBACK_PAGE_HTML);
      // The sign-in knows no port, so no callback can be this sign-in's: it cannot have come from
      // this listener, which has heard nothing (a listener of an earlier sign-in, still stopping,
      // is the likely sender). The first callback decides all the same.
      gateway.deliver(`http://127.0.0.1:${String(FIXTURE_LOOPBACK_PORT)}/callback?nonce=${NONCE}`);

      await expect(signIn).resolves.toEqual({ kind: 'refused' });
      expect(service.isPending()).toBe(false);
      expect(gateway.cancelledPorts).toEqual([]);
      // Once the port is reported, the listener is stopped: it would stay open otherwise.
      reportPort();
      await flush();
      expect(gateway.cancelledPorts).toEqual([FIXTURE_LOOPBACK_PORT]);
      // The browser is never opened, and nothing is asked of Steam.
      expect(gateway.openedUrls).toEqual([]);
      expect(http.requests).toEqual([]);
      expect(gateway.unsubscribeCalls).toBe(1);
      expect(logged(logger)).toEqual([refusedLine('url')]);
    });

    it('refuses a callback heard before the subscription is confirmed, and starts no listener', async () => {
      const { service, gateway, http, logger, flush } = setUp();

      // The gateway delivers before its subscription promise resolves, which the port allows.
      // `ObservedGateway.onCallback` registers the listener at once and resolves later.
      const signIn = service.signIn();
      gateway.deliver(`http://127.0.0.1:${String(FIXTURE_LOOPBACK_PORT)}/callback?nonce=${NONCE}`);

      await expect(signIn).resolves.toEqual({ kind: 'refused' });
      await flush();
      expect(logged(logger)).toEqual([refusedLine('url')]);
      expect(http.requests).toEqual([]);
      // `start` is never called, so there is no listener to stop and no page to show.
      expect(gateway.lastCallbackPage).toBeNull();
      expect(gateway.cancelledPorts).toEqual([]);
      expect(gateway.openedUrls).toEqual([]);
      // The subscription that was confirmed late is removed at once.
      expect(gateway.unsubscribeCalls).toBe(1);
    });
  });

  describe('what Steam answers', () => {
    it('refuses an assertion Steam does not confirm', async () => {
      const { service, http, logger, flush, answer } = setUp({
        handler: answering(200, INVALID_ANSWER),
      });

      const signIn = service.signIn();
      await flush();
      answer();

      await expect(signIn).resolves.toEqual({ kind: 'refused' });
      expect(http.requests).toHaveLength(1);
      expect(logged(logger)).toEqual([STARTED, refusedLine('check_authentication', 200)]);
    });

    it('refuses a replayed assertion', async () => {
      const { service, http, logger, flush, answer, gateway } = setUp();

      const first = service.signIn();
      await flush();
      const callback = answer();
      await expect(first).resolves.toEqual({ kind: 'signed_in', accountId: FIXTURE_ACCOUNT_ID });

      // A local process captured the callback and brings it back to a later sign-in. The nonce and
      // the port are the same here, so the core accepts it: only Steam, which confirms an assertion
      // once, can tell it is a replay.
      const second = service.signIn();
      await flush();
      gateway.deliver(callback);

      await expect(second).resolves.toEqual({ kind: 'refused' });
      expect(http.requests).toHaveLength(2);
      expect(logged(logger).slice(-1)).toEqual([refusedLine('check_authentication', 200)]);
    });

    it('refuses a Steam id that is not an individual account', async () => {
      const { service, http, logger, flush, answer } = setUp();
      // 17 digits, so the core lets it through, but the account id it gives is 0.
      const notAnAccount = 'https://steamcommunity.com/openid/id/76561197960265728';

      const signIn = service.signIn();
      await flush();
      answer({ overrides: { 'openid.claimed_id': notAnAccount, 'openid.identity': notAnAccount } });

      await expect(signIn).resolves.toEqual({ kind: 'refused' });
      // Steam confirmed the assertion first: the id is read from the confirmed callback.
      expect(http.requests).toHaveLength(1);
      expect(logged(logger)).toEqual([STARTED, refusedLine('claimed_id')]);
    });

    it.each([503, 500, 403, 429])('says Steam is unavailable on %i', async (status) => {
      // A body that would confirm the assertion: the status alone decides.
      const { service, logger, flush, answer } = setUp({
        handler: answering(status, VALID_ANSWER),
      });

      const signIn = service.signIn();
      await flush();
      answer();

      await expect(signIn).resolves.toEqual({ kind: 'steam_unavailable' });
      expect(logged(logger)).toEqual([
        STARTED,
        { level: 'warn', message: 'Steam could not confirm the sign-in', context: { status } },
      ]);
    });

    it.each<AppErrorKind>(['network', 'timeout'])(
      'says Steam is unavailable on a %s error',
      async (kind) => {
        const { service, logger, flush, answer } = setUp({
          handler: failing(
            new AppError(kind, `${LEAK_MARKER} https://steamcommunity.com/openid/login`),
          ),
        });

        const signIn = service.signIn();
        await flush();
        answer();

        await expect(signIn).resolves.toEqual({ kind: 'steam_unavailable' });
        expect(logged(logger)).toEqual([
          STARTED,
          { level: 'warn', message: 'Steam could not confirm the sign-in', context: { kind } },
        ]);
      },
    );

    it('logs the kind of an unknown failure, never its message', async () => {
      const { service, logger, flush, answer } = setUp({ handler: failing(leakyError()) });

      const signIn = service.signIn();
      await flush();
      answer();

      await expect(signIn).resolves.toEqual({ kind: 'steam_unavailable' });
      expect(logged(logger)).toEqual([
        STARTED,
        {
          level: 'warn',
          message: 'Steam could not confirm the sign-in',
          context: { kind: 'unexpected' },
        },
      ]);
    });

    it.each<[string, FixtureResponse, number | undefined]>([
      // A redirect is not followed; and a valid-looking body on it is no confirmation.
      [
        'a redirect',
        { status: 302, headers: { Location: 'https://example.com/' }, body: VALID_ANSWER },
        302,
      ],
      ['a status Steam does not use', { status: 404, headers: {}, body: VALID_ANSWER }, 404],
      // 17 KiB: one more kilobyte than the cap. The client throws instead of answering, so there
      // is no status to log.
      [
        'an answer over 16 KiB',
        { status: 200, headers: {}, body: `${VALID_ANSWER}${'x'.repeat(17 * 1024)}` },
        undefined,
      ],
    ])('refuses %s', async (_description, response, loggedStatus) => {
      const { service, http, logger, flush, answer } = setUp({
        handler: () => response,
      });

      const signIn = service.signIn();
      await flush();
      answer();

      await expect(signIn).resolves.toEqual({ kind: 'refused' });
      expect(http.requests).toHaveLength(1);
      expect(logged(logger)).toEqual([STARTED, refusedLine('check_authentication', loggedStatus)]);
    });
  });

  describe('when the sign-in is abandoned', () => {
    it('times out after 5 minutes and stops the listener', async () => {
      const { service, gateway, http, logger, flush, answer } = setUp();

      const signIn = service.signIn();
      await flush();
      await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS - 1);
      expect(service.isPending()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);

      await expect(signIn).resolves.toEqual({ kind: 'timed_out' });
      expect(service.isPending()).toBe(false);
      expect(gateway.cancelledPorts).toEqual([FIXTURE_LOOPBACK_PORT]);
      expect(gateway.unsubscribeCalls).toBe(1);
      expect(logged(logger)).toEqual([STARTED, cancelledLine('timeout')]);

      // A callback that comes afterwards finds nobody listening.
      answer();
      await flush();
      expect(http.requests).toEqual([]);
    });

    it('does not time out while Steam is being asked', async () => {
      let answerSteam: (response: FixtureResponse) => void = () => undefined;
      const steamIsSlow = new Promise<FixtureResponse>((resolve) => {
        answerSteam = resolve;
      });
      const { service, flush, answer } = setUp({ handler: () => steamIsSlow });

      const signIn = service.signIn();
      await flush();
      answer();
      // The callback came: the five minutes were for waiting for it, and the request has its own
      // time limit.
      await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS + MINUTE);
      expect(service.isPending()).toBe(true);
      answerSteam({ status: 200, headers: {}, body: VALID_ANSWER });

      await expect(signIn).resolves.toEqual({ kind: 'signed_in', accountId: FIXTURE_ACCOUNT_ID });
    });

    it('cancels when asked and stops the listener', async () => {
      const { service, gateway, http, logger, flush, answer } = setUp();

      const signIn = service.signIn();
      await flush();
      service.cancel();

      await expect(signIn).resolves.toEqual({ kind: 'cancelled' });
      expect(service.isPending()).toBe(false);
      expect(gateway.cancelledPorts).toEqual([FIXTURE_LOOPBACK_PORT]);
      expect(gateway.unsubscribeCalls).toBe(1);
      expect(logged(logger)).toEqual([STARTED, cancelledLine('user')]);

      // The browser may still come back: nobody is listening, and nothing is asked of Steam.
      answer();
      await flush();
      expect(http.requests).toEqual([]);
    });

    it('does nothing when asked to cancel and no sign-in is pending', () => {
      const { service, gateway, logger } = setUp();

      service.cancel();

      expect(service.isPending()).toBe(false);
      expect(logger.entries).toEqual([]);
      expect(gateway.cancelledPorts).toEqual([]);
    });

    it('cancels before the callbacks are subscribed, and starts no listener', async () => {
      const { service, gateway, logger, flush } = setUp();

      const signIn = service.signIn();
      service.cancel();

      await expect(signIn).resolves.toEqual({ kind: 'cancelled' });
      expect(service.isPending()).toBe(false);
      await flush();
      // The subscription that came late is removed at once, and there is no listener to stop.
      expect(gateway.unsubscribeCalls).toBe(1);
      expect(gateway.lastCallbackPage).toBeNull();
      expect(gateway.cancelledPorts).toEqual([]);
      expect(gateway.openedUrls).toEqual([]);
      expect(logged(logger)).toEqual([cancelledLine('user')]);
    });

    it('cancels before the listener is up, and stops it once its port is known', async () => {
      let listenerIsUp: (listener: { readonly port: number }) => void = () => undefined;
      const { service, gateway, logger, flush } = setUp();
      vi.spyOn(gateway, 'start').mockReturnValueOnce(
        new Promise((resolve) => {
          listenerIsUp = resolve;
        }),
      );

      const signIn = service.signIn();
      await flush();
      service.cancel();

      // The player is not kept waiting for the listener: the sign-in is over, and its port unknown.
      await expect(signIn).resolves.toEqual({ kind: 'cancelled' });
      expect(service.isPending()).toBe(false);
      expect(gateway.cancelledPorts).toEqual([]);
      listenerIsUp({ port: FIXTURE_LOOPBACK_PORT });
      await flush();
      expect(gateway.cancelledPorts).toEqual([FIXTURE_LOOPBACK_PORT]);
      // The browser was never opened, and the subscription is gone.
      expect(gateway.openedUrls).toEqual([]);
      expect(gateway.unsubscribeCalls).toBe(1);
      expect(logged(logger)).toEqual([cancelledLine('user')]);
    });

    it('cancels while Steam is being asked, and drops the answer', async () => {
      let answerSteam: (response: FixtureResponse) => void = () => undefined;
      const steamIsSlow = new Promise<FixtureResponse>((resolve) => {
        answerSteam = resolve;
      });
      const { service, gateway, http, logger, flush, answer } = setUp({
        handler: () => steamIsSlow,
      });

      const signIn = service.signIn();
      await flush();
      answer();
      await flush();
      expect(http.requests).toHaveLength(1);
      expect(service.isPending()).toBe(true);
      service.cancel();

      await expect(signIn).resolves.toEqual({ kind: 'cancelled' });
      expect(service.isPending()).toBe(false);
      // Steam confirms, too late: the player already gave up.
      answerSteam({ status: 200, headers: {}, body: VALID_ANSWER });
      await flush();
      // The listener had ended by itself after the callback: there is nothing to stop.
      expect(gateway.cancelledPorts).toEqual([]);
      expect(logged(logger)).toEqual([STARTED, cancelledLine('user')]);
    });

    it('logs, and goes on, when the listener cannot be stopped', async () => {
      const { service, gateway, logger, flush } = setUp();
      gateway.failNextCancel(leakyError());

      const signIn = service.signIn();
      await flush();
      service.cancel();
      await flush();

      // The outcome is the player's, whatever the plugin says about a listener it already closed.
      await expect(signIn).resolves.toEqual({ kind: 'cancelled' });
      expect(gateway.cancelledPorts).toEqual([FIXTURE_LOOPBACK_PORT]);
      expect(logged(logger)).toEqual([
        STARTED,
        cancelledLine('user'),
        {
          level: 'debug',
          message: 'Steam sign-in listener could not be stopped',
          context: { kind: 'unexpected' },
        },
      ]);
    });

    it('logs, and goes on, when the subscription cannot be removed', async () => {
      const { service, gateway, logger, flush, answer } = setUp();
      gateway.unsubscribeError = leakyError();

      const signIn = service.signIn();
      await flush();
      answer();

      await expect(signIn).resolves.toEqual({ kind: 'signed_in', accountId: FIXTURE_ACCOUNT_ID });
      expect(logged(logger)).toEqual([
        STARTED,
        {
          level: 'debug',
          message: 'Steam sign-in callbacks could not be unsubscribed',
          context: { kind: 'unexpected' },
        },
        CONFIRMED,
      ]);
    });
  });

  describe('when the sign-in cannot start', () => {
    it.each([
      ['listener', false],
      ['browser', true],
    ])('cannot start when the %s fails', async (step, listenerWasUp) => {
      const { service, gateway, http, logger, flush } = setUp();
      if (step === 'listener') {
        gateway.failNextStart(leakyError());
      } else {
        gateway.failNextOpen(leakyError());
      }

      const signIn = service.signIn();
      await flush();

      await expect(signIn).resolves.toEqual({ kind: 'start_failed' });
      expect(service.isPending()).toBe(false);
      expect(gateway.unsubscribeCalls).toBe(1);
      // A listener that was up is stopped; one that never started has nothing to stop.
      expect(gateway.cancelledPorts).toEqual(listenerWasUp ? [FIXTURE_LOOPBACK_PORT] : []);
      expect(http.requests).toEqual([]);
      const expected = [
        ...(listenerWasUp ? [STARTED] : []),
        {
          level: 'warn',
          message: 'Steam sign-in could not start',
          context: { step, kind: 'unexpected' },
        },
      ];
      expect(logged(logger)).toEqual(expected);
    });

    it('cannot start when the callbacks cannot be subscribed to', async () => {
      const { service, gateway, logger, flush } = setUp();
      vi.spyOn(gateway, 'onCallback').mockRejectedValueOnce(leakyError());

      const signIn = service.signIn();
      await flush();

      await expect(signIn).resolves.toEqual({ kind: 'start_failed' });
      // The listener is never started without its subscription.
      expect(gateway.lastCallbackPage).toBeNull();
      expect(logged(logger)).toEqual([
        {
          level: 'warn',
          message: 'Steam sign-in could not start',
          context: { step: 'listener', kind: 'unexpected' },
        },
      ]);
    });

    it('cannot start when the random bytes are unusable', async () => {
      const { service, gateway, logger } = setUp({ randomBytes: () => new Uint8Array(3) });

      await expect(service.signIn()).resolves.toEqual({ kind: 'start_failed' });

      expect(service.isPending()).toBe(false);
      expect(gateway.lastCallbackPage).toBeNull();
      expect(logged(logger)).toEqual([
        {
          level: 'warn',
          message: 'Steam sign-in could not start',
          context: { step: 'nonce', kind: 'unexpected' },
        },
      ]);
    });
  });

  it('never logs the SteamID64, the nonce or a URL', async () => {
    for (const scenario of PRIVACY_SCENARIOS) {
      const context = setUp(scenario.options);
      scenario.prepare?.(context);
      const signIn = context.service.signIn();
      await context.flush();
      await scenario.act(context);
      await signIn;
      // A scenario that logged nothing would prove nothing.
      expect(context.logger.entries.length).toBeGreaterThan(0);
      expectNothingPrivateLogged(context.logger);
    }
  });
});
